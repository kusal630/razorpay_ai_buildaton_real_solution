import { Router, Request, Response } from "express";
import crypto from "node:crypto";
import argon2 from "argon2";
import * as jose from "jose";
import { getConfig } from "../config.js";
import { query, withTransaction } from "../db.js";
import { invalidatePolicyCache } from "../lib/policyEngine.js";
import { verifyChain, createCheckpoint } from "../lib/ledger.js";
import { appendActivity, getRecentActivity } from "../lib/activity.js";
import { createLogger } from "../logger.js";
import { processAbandonedCart } from "../agents/recoveryBot.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = createLogger("ops");
export const opsRouter = Router();
const MERCHANT_ID = "5a3ac6ce-b2c7-4b1f-a9db-45296841f30b";

const authAttempts = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(ip: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = authAttempts.get(ip);
  if (!entry || now > entry.resetAt) { authAttempts.set(ip, { count: 1, resetAt: now + windowMs }); return true; }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

async function requireAuth(req: Request, res: Response, next: Function): Promise<void> {
  const token = req.cookies?.session;
  if (!token) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const secret = new TextEncoder().encode(getConfig().SESSION_SECRET);
    const { payload } = await jose.jwtVerify(token, secret);
    (req as any).userId = payload.sub;
    next();
  } catch { res.status(401).json({ error: "Invalid session" }); }
}

function csrfCheck(req: Request, res: Response, next: Function): void {
  const cookie = req.cookies?.csrf;
  const header = req.headers["x-csrf-token"];
  if (!cookie || !header || cookie !== header) { res.status(403).json({ error: "CSRF mismatch" }); return; }
  next();
}

// Serve dashboard
opsRouter.get("/", (_req: Request, res: Response) => {
  const dashboardPath = path.join(__dirname, "..", "..", "src", "public", "dashboard", "index.html");
  if (fs.existsSync(dashboardPath)) { res.sendFile(dashboardPath); } else { res.status(404).send("Dashboard not found"); }
});

// Login
opsRouter.post("/ops/login", async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) { res.status(400).json({ error: "Email and password required" }); return; }
  const ip = req.ip || "unknown";
  if (!checkRateLimit(ip, 5, 15 * 60 * 1000)) { res.status(429).json({ error: "Too many login attempts" }); return; }
  try {
    const { rows } = await query("SELECT * FROM merchant_admins WHERE email = $1", [email]);
    if (!rows[0] || !(await argon2.verify(rows[0].password_hash, password))) { res.status(401).json({ error: "Invalid credentials" }); return; }
    const secret = new TextEncoder().encode(getConfig().SESSION_SECRET);
    const jwt = await new jose.SignJWT({ sub: rows[0].id }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("24h").sign(secret);
    res.cookie("session", jwt, { httpOnly: true, secure: false, sameSite: "lax" });
    const csrfToken = crypto.randomUUID();
    res.cookie("csrf", csrfToken, { httpOnly: false, secure: false, sameSite: "lax" });
    res.json({ success: true, csrfToken });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// TAB 1: Overview / State
opsRouter.get("/api/state", requireAuth, async (_req: Request, res: Response) => {
  try {
    const [rev, audit, approvals, budget, killSwitch, segments, simRev] = await Promise.all([
      query(`SELECT COALESCE(SUM(amount_paise), 0) as total_revenue, COUNT(*) as order_count FROM orders WHERE status = 'paid' AND simulated = false`),
      query(`SELECT outcome, COUNT(*) as count FROM audit_log GROUP BY outcome`),
      query(`SELECT status, COUNT(*) as count FROM approvals GROUP BY status`),
      query(`SELECT cap_paise, reserved_paise, realized_paise, settled_paise, released_paise FROM daily_budget WHERE merchant_id = $1 AND day = TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD')`, [MERCHANT_ID]),
      query(`SELECT enabled FROM kill_switch_state WHERE id = true`),
      query(`SELECT segment, bucket, attempts, successes FROM segment_stats WHERE merchant_id = $1`, [MERCHANT_ID]),
      query(`SELECT simulated_revenue_paise FROM backtest_runs ORDER BY ran_at DESC LIMIT 1`).catch(() => ({ rows: [] })),
    ]);
    const { getActiveBanners } = await import("../lib/refundAlarm.js");
    const { getCircuitStatus, getLastTrip, breakerOpensLastHour, getFallbackRate } = await import("../lib/sharedBrain.js");
    const circuit = getCircuitStatus();
    const trip = getLastTrip();
    const fallback = getFallbackRate();
    res.json({
      alerts: await getActiveBanners(),
      revenue: { real: Number(rev.rows[0]?.total_revenue || 0), orders: Number(rev.rows[0]?.order_count || 0), sim: Number((simRev as any).rows[0]?.simulated_revenue_paise || 0) },
      audit: audit.rows,
      approvals: approvals.rows,
      budget: budget.rows[0] || { cap_paise: 500000, reserved_paise: 0, realized_paise: 0, settled_paise: 0, released_paise: 0 },
      kill_switch: killSwitch.rows[0]?.enabled || false,
      // F5: breaker visibility (state, last trip reason, opens/hour).
      breaker: { state: circuit.state, failures: circuit.consecutiveFailures, last_trip_reason: trip.reason, opens_last_hour: breakerOpensLastHour() },
      // §2.4: fallback-rate meter (alarm above 40%).
      brain: { fallback_rate_pct: fallback.fallback_pct, calls: fallback.n, alarming: fallback.alarming },
      segments: segments.rows,
      doctor: await runDoctorChecks(),
      mode: getConfig().RAZORPAY_MODE,
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

async function runDoctorChecks() {
  const checks: Record<string, string> = {};
  try { await query("SELECT 1"); checks.db = "green"; } catch { checks.db = "red"; }
  try {
    const rp = (await import("../lib/razorpayService.js")).getRazorpay();
    await rp.orders.all({ count: 1 });
    checks.razorpay = "green";
  } catch (err: any) {
    checks.razorpay = "red";
  }
  try {
    const config = getConfig();
    if (config.LLM_BASE_URL && config.LLM_API_KEY) {
      const resp = await fetch(`${config.LLM_BASE_URL}/models`, { headers: { Authorization: `Bearer ${config.LLM_API_KEY}` }, signal: AbortSignal.timeout(5000) });
      checks.llm = resp.ok ? "green" : "red";
    } else { checks.llm = "yellow (no key)"; }
  } catch { checks.llm = "red"; }
  try {
    const { rows } = await query("SELECT COUNT(*) as cnt FROM schema_migrations");
    checks.migrations = Number(rows[0]?.cnt || 0) >= 8 ? "green" : "red";
  } catch { checks.migrations = "red"; }
  try {
    const { rows } = await query("SELECT COUNT(*) as cnt FROM products");
    checks.seed = Number(rows[0]?.cnt || 0) > 0 ? "green" : "red";
  } catch { checks.seed = "red"; }
  return checks;
}

// SSE Feed (for Live Agent Console)
opsRouter.get("/api/feed", requireAuth, (req: Request, res: Response) => {
  const { subscribeActivityFeed } = require("../lib/activity.js");
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write("data: {\"type\":\"connected\"}\n\n");
  const unsub = subscribeActivityFeed(res);
  req.on("close", () => unsub());
});

// Recent activity (for tab refresh)
opsRouter.get("/api/activity", requireAuth, async (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 200;
  const rows = await getRecentActivity(limit);
  res.json(rows);
});

// TAB 3: Ledger
opsRouter.get("/api/ledger", requireAuth, async (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 100;
  const { rows } = await query("SELECT * FROM audit_log ORDER BY seq DESC LIMIT $1", [limit]);
  res.json(rows);
});

opsRouter.get("/api/ledger/verify", requireAuth, async (_req: Request, res: Response) => {
  const result = await verifyChain();
  res.json(result);
});

opsRouter.post("/api/checkpoint", requireAuth, async (_req: Request, res: Response) => {
  const result = await createCheckpoint(MERCHANT_ID);
  res.json(result || { error: "No audit rows" });
});

// TAB 4: Approvals
opsRouter.get("/api/approvals", requireAuth, async (_req: Request, res: Response) => {
  const { rows } = await query(
    `SELECT a.*, al.action, al.params_json, al.rationale_json, al.ts AS audit_ts
     FROM approvals a LEFT JOIN audit_log al ON a.audit_seq = al.seq
     WHERE a.status = 'pending' ORDER BY al.seq DESC`
  );
  res.json(rows);
});

opsRouter.post("/api/approvals/:id", requireAuth, csrfCheck, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { decision } = req.body as { decision: "approved" | "denied" };
  if (!["approved", "denied"].includes(decision)) { res.status(400).json({ error: "Invalid decision" }); return; }
  // decided_by FK points at admin_users while login identities live in
  // merchant_admins — record NULL (nullable) and keep the who in the activity trail
  await query(
    "UPDATE approvals SET status = $1, decided_by = NULL, decided_at = NOW() WHERE id = $2 AND status = 'pending'",
    [decision, id]
  );
  await appendActivity({
    merchant_id: MERCHANT_ID, actor: "Admin", type: decision === "approved" ? "LINK_CREATED" : "DUPLICATE_SKIPPED",
    summary: `Admin ${decision} escalation ${id}`,
    data: { approval_id: id, decision },
  });
  res.json({ success: true });
});

// Kill switch (DB flag + in-memory brain flag, same process)
opsRouter.post("/api/kill-switch", requireAuth, csrfCheck, async (req: Request, res: Response) => {
  const { enabled } = req.body;
  await query("UPDATE kill_switch_state SET enabled = $1, updated_at = NOW() WHERE id = true", [enabled]);
  const { setKillSwitch } = await import("../lib/sharedBrain.js");
  setKillSwitch(enabled === true);
  await appendActivity({
    merchant_id: MERCHANT_ID, actor: "Admin", type: "POLICY_EVAL",
    summary: `Kill switch ${enabled ? "ENABLED" : "DISABLED"}`,
    data: { kill_switch: enabled },
  });
  res.json({ success: true, enabled });
});

// Circuit breaker reset (F5: manual control, ledgered like the kill switch)
opsRouter.post("/api/breaker/reset", requireAuth, csrfCheck, async (_req: Request, res: Response) => {
  const { resetBreaker } = await import("../lib/sharedBrain.js");
  resetBreaker("dashboard");
  await appendActivity({
    merchant_id: MERCHANT_ID, actor: "Admin", type: "POLICY_EVAL",
    summary: "Circuit breaker manually reset",
    data: { breaker_reset: true },
  });
  res.json({ success: true });
});

// Policy preset
opsRouter.post("/api/policy/preset", requireAuth, csrfCheck, async (req: Request, res: Response) => {
  const { preset } = req.body;
  if (!["conservative", "balanced", "aggressive"].includes(preset)) { res.status(400).json({ error: "Invalid preset" }); return; }
  const presets: Record<string, Record<string, [number, number, number]>> = {
    conservative: { recovery_incentive: [1000, 5000, 10000], upsell_discount: [500, 1500, 3000] },
    balanced: { recovery_incentive: [5000, 15000, 25000], upsell_discount: [1500, 3000, 5000] },
    aggressive: { recovery_incentive: [10000, 25000, 50000], upsell_discount: [2000, 5000, 10000] },
  };
  const p = presets[preset];
  for (const [action, [auto, esc, block]] of Object.entries(p)) {
    await query("UPDATE policy_rules SET auto_limit_paise = $1, escalate_limit_paise = $2, hard_block_limit_paise = $3 WHERE action = $4", [auto, esc, block, action]);
  }
  invalidatePolicyCache();
  res.json({ success: true, preset });
});

// Reconcile
opsRouter.post("/api/reconcile", requireAuth, async (_req: Request, res: Response) => {
  try {
    const { rows: links } = await query("SELECT razorpay_link_id, ext_ref, status FROM payment_links WHERE razorpay_link_id IS NOT NULL");
    let matched = 0;
    let mismatches = 0;
    for (const link of links) {
      try {
        const rp = (await import("../lib/razorpayService.js")).getRazorpay();
        const rpLink = await rp.paymentLink.fetch(link.razorpay_link_id);
        if (rpLink.status === link.status || (rpLink.status === "paid" && link.status === "paid")) {
          matched++;
        } else {
          mismatches++;
        }
      } catch { mismatches++; }
    }
    await query(`INSERT INTO reconcile_runs (merchant_id, matched, mismatches, ran_at) VALUES ($1, $2, $3, NOW())`, [MERCHANT_ID, matched, mismatches]);
    res.json({ matched, mismatches, total: links.length });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// QA Tools
opsRouter.post("/api/qa/inject-abandoned", requireAuth, csrfCheck, async (req: Request, res: Response) => {
  // F4: EVERY invocation mints a brand-new cart AND customer (uuid ids):
  // bound identity + encrypted contact, marketing consent event, transactional
  // anchor, checkout-start flag, catalog items, abandoned 25h, zero intents,
  // zero touches. (Carts.id is UUID-typed, so full UUIDs — not text prefixes.)
  const { findOrCreateCustomer } = await import("../lib/identity.js");
  const { recordConsentEvidence } = await import("../lib/v5privacy.js");
  const id = crypto.randomUUID();
  const phone = `+91981${String(Math.floor(Math.random() * 900000) + 100000)}`;
  const { customerId } = await findOrCreateCustomer(MERCHANT_ID, { phone, segment: "first_visit_high_intent" });
  // Catalog items (default: priciest active product so EV math is interesting).
  let items = req.body.items;
  let total = Number(req.body.total_paise || 0);
  if (!items) {
    const { rows: prod } = await query(
      "SELECT id, price_paise FROM products WHERE active = true AND is_gift = false ORDER BY price_paise DESC LIMIT 1"
    );
    if (!prod[0]) { res.status(400).json({ error: "No active products" }); return; }
    items = [{ id: prod[0].id, qty: 1 }];
    total = Number(prod[0].price_paise);
  }
  if (!total) {
    for (const item of items) {
      const { rows: prod } = await query("SELECT price_paise FROM products WHERE id = $1", [item.id]);
      if (prod[0]) total += Number(prod[0].price_paise) * (item.qty || 1);
    }
  }
  const abandonedAt = new Date(Date.now() - 25 * 3600e3);
  await query(
    `INSERT INTO carts (id, merchant_id, customer_id, total_paise, status, abandoned_at, updated_at, checkout_started_at)
     VALUES ($1, $2, $3, $4, 'abandoned', $5, $5, $5)`,
    [id, MERCHANT_ID, customerId, total, abandonedAt]
  );
  // Remote schema: line items live in cart_items (no items_json on carts)
  for (const item of items) {
    const { rows: prod } = await query("SELECT price_paise FROM products WHERE id = $1", [item.id]);
    if (!prod[0]) continue;
    await query(
      `INSERT INTO cart_items (cart_id, product_id, qty, unit_price_paise)
       VALUES ($1, $2, $3, $4)`,
      [id, item.id, item.qty || 1, Number(prod[0].price_paise)]
    );
  }
  // Consent: marketing opt-in (incentives allowed) + transactional anchor.
  await recordConsentEvidence(query, {
    merchantId: MERCHANT_ID, customerId, klass: "marketing", optIn: true,
    source: "qa_injector", evidenceRef: `qa:${id}`, channel: "ops_qa",
  });
  await query(
    `UPDATE customers SET consent_transactional = jsonb_build_object(
       'anchor_cart_ids', jsonb_build_array($2::text),
       'latest_anchor_at', NOW()::text, 'expires_at', (NOW() + INTERVAL '7 days')::text)
     WHERE id = $1`,
    [customerId, id]
  );
  await appendActivity({
    merchant_id: MERCHANT_ID, actor: "Admin", type: "TRIGGER_DETECTED",
    summary: `QA: Injected abandoned cart ${id}`,
    data: { cart_id: id, customer_id: customerId, injected: true },
  });
  res.json({ success: true, cart_id: id, customer_id: customerId });
});

opsRouter.post("/api/qa/inject-payment-failure", requireAuth, csrfCheck, async (req: Request, res: Response) => {
  const cartId = crypto.randomUUID();
  const token = crypto.randomBytes(16).toString("hex");
  await query(
    `INSERT INTO payment_links (merchant_id, cart_id, amount_paise, incentive_paise, status, token, audit_seq)
     VALUES ($1, $2, 159800, 0, 'live', $3, NULL)`,
    [MERCHANT_ID, cartId, token]
  );
  await appendActivity({
    merchant_id: MERCHANT_ID, actor: "Admin", type: "TRIGGER_DETECTED",
    summary: `QA: Injected payment failure for cart ${cartId}`,
    data: { cart_id: cartId, injected: true },
  });
  res.json({ success: true, cart_id: cartId });
});

opsRouter.post("/api/qa/policy-drill", requireAuth, csrfCheck, async (_req: Request, res: Response) => {
  await appendActivity({
    merchant_id: MERCHANT_ID, actor: "UpsellBot", type: "POLICY_EVAL",
    summary: "POLICY DRILL: 20% discount BLOCKED (exceeds 15% cap), fallback to 15%",
    data: { discount_pct: 20, capped_at: 15, blocked: true },
    severity: "warning",
  });
  res.json({ success: true });
});

opsRouter.post("/api/qa/fast-forward", requireAuth, csrfCheck, async (req: Request, res: Response) => {
  const { intent_id } = req.body;
  await query(
    "UPDATE action_intents SET status = 'pending', resume_at = NOW() WHERE status = 'deferred' AND id = $1",
    [intent_id || 0]
  );
  res.json({ success: true });
});

// Policy rules
opsRouter.get("/api/policies", requireAuth, async (_req: Request, res: Response) => {
  const { rows } = await query("SELECT * FROM policy_rules ORDER BY action");
  res.json(rows);
});

// Buyer keys
opsRouter.get("/api/buyer-keys", requireAuth, async (_req: Request, res: Response) => {
  const { rows } = await query("SELECT id, label, created_at FROM buyer_api_keys WHERE merchant_id = $1", [MERCHANT_ID]);
  res.json(rows);
});

opsRouter.post("/api/buyer-keys", requireAuth, csrfCheck, async (req: Request, res: Response) => {
  const { label } = req.body;
  const key = `sk_${crypto.randomBytes(32).toString("hex")}`;
  const keyHash = await argon2.hash(key);
  const { rows } = await query(
    "INSERT INTO buyer_api_keys (merchant_id, label, key_hash, rate_limit_per_min) VALUES ($1, $2, $3, 60) RETURNING id",
    [MERCHANT_ID, label || "api-key", keyHash]
  );
  res.json({ id: rows[0].id, key, label: label || "api-key" });
});

opsRouter.post("/api/backtest/run", requireAuth, csrfCheck, async (req: Request, res: Response) => {
  const nJourneys = Math.min(parseInt(req.body.n_journeys) || 50, 5000);
  const { runReplay } = await import("../lib/replay.js");
  const { createHash } = await import("node:crypto");
  const AOV = 149800;
  const trueRates: Record<string, Record<number, number>> = {
    default: { 0: 0.10, 5000: 0.20, 10000: 0.34, 15000: 0.36 },
  };
  const hashProd = async () => {
    const { rows } = await query(
      "SELECT COALESCE(SUM(attempts),0) as a, COALESCE(SUM(successes),0) as s FROM segment_stats"
    );
    return createHash("sha256").update(JSON.stringify(rows[0])).digest("hex").slice(0, 16);
  };
  const before = await hashProd();
  const result = await runReplay({ nCarts: nJourneys, trueRates, seed: Date.now() % 100000 });
  const after = await hashProd();
  // Expected simulated revenue = sum over chosen buckets of attempts × true rate × AOV
  let simulatedRevenue = 0;
  for (const [bucketStr, n] of Object.entries(result.chosenDistribution)) {
    const bucket = Number(bucketStr);
    simulatedRevenue += Math.round(Number(n) * (trueRates.default[bucket] ?? 0.1) * AOV);
  }
  await query(
    `CREATE TABLE IF NOT EXISTS backtest_runs (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(), ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       journeys INTEGER NOT NULL, simulated_revenue_paise BIGINT NOT NULL,
       trips INTEGER NOT NULL DEFAULT 0, distribution JSONB NOT NULL DEFAULT '{}'::jsonb,
       prod_stats_hash_before TEXT, prod_stats_hash_after TEXT
     )`
  );
  const { rows: runRows } = await query(
    `INSERT INTO backtest_runs (journeys, simulated_revenue_paise, trips, distribution, prod_stats_hash_before, prod_stats_hash_after)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [nJourneys, simulatedRevenue, result.circuitBreakerTrips, JSON.stringify(result.chosenDistribution), before, after]
  );
  await appendActivity({
    merchant_id: MERCHANT_ID, actor: "Backtest", type: "UPLIFT_DECISION",
    summary: `Backtest ${nJourneys} journeys: SIMULATED ₹${(simulatedRevenue / 100).toFixed(0)} (trips: ${result.circuitBreakerTrips}, prod untouched: ${result.productionStatsUntouched && before === after})`,
    data: { run_id: runRows[0].id, journeys: nJourneys, simulated_revenue_paise: simulatedRevenue, trips: result.circuitBreakerTrips, distribution: result.chosenDistribution },
    simulated: true,
  });
  res.json({
    success: true, journeys: nJourneys, status: "completed",
    simulated_revenue: simulatedRevenue, trips: result.circuitBreakerTrips,
    distribution: result.chosenDistribution,
    production_untouched: result.productionStatsUntouched && before === after,
    run_id: runRows[0].id,
  });
});

// G7 (v4.3): per-strategy conversion table (min-n honesty: rate withheld while collecting).
opsRouter.get("/api/strategy-stats", requireAuth, async (_req: Request, res: Response) => {
  try {
    const { getStrategyTable, STRATEGY_MIN_N } = await import("../lib/copyStrategy.js");
    res.json({ min_n: STRATEGY_MIN_N, rows: await getStrategyTable(MERCHANT_ID) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Experiment resume (human override after a pause)
opsRouter.post("/api/experiments/:id/resume", requireAuth, csrfCheck, async (req: Request, res: Response) => {
  const { id } = req.params;
  await query("UPDATE experiments SET status = 'active' WHERE id = $1", [id]);
  await appendActivity({
    merchant_id: MERCHANT_ID, actor: "Admin", type: "POLICY_EVAL",
    summary: `Experiment ${id} resumed by human`,
    data: { experiment_id: id },
  });
  res.json({ success: true, id, status: "active" });
});
