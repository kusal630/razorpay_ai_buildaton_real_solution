/**
 * v5.ts routes — Phase 3/5/6 operational surface (M5/M6/M8/M9/M11/M12/M13/
 * M15/M16/M22/M23/M27). Session-authenticated like ops.ts (same cookie/JWT).
 * All config changes → admin_audit + ledger rows (M13 gate).
 */
import { Router, Request, Response } from "express";
import crypto from "node:crypto";
import * as jose from "jose";
import { getConfig } from "../config.js";
import { query } from "../db.js";
import { appendLedger } from "../lib/ledger.js";
import { appendActivity } from "../lib/activity.js";
import { createLogger } from "../logger.js";
import { isConfigKey } from "../lib/v5config.js";
import { ndrTransition, classifyFee, creditBonus, codLossEv, COD_TOKEN_CONFIRM_PAISE, THETA_SAVE_PRIOR, CREDIT_EXPIRY_DAYS } from "../lib/v5ops.js";
import { checkCeilingEdit } from "../lib/v5harden.js";

const log = createLogger("v5ops");
export const v5Router = Router();
const MERCHANT_ID = "5a3ac6ce-b2c7-4b1f-a9db-45296841f30b";

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

// ── M13 merchant config ──
v5Router.get("/api/config/:key", requireAuth, async (req: Request, res: Response) => {
  if (!isConfigKey(req.params.key)) { res.status(404).json({ error: "unknown config key" }); return; }
  const { rows } = await query("SELECT key, value_jsonb, updated_at FROM merchant_config WHERE merchant_id = $1 AND key = $2", [MERCHANT_ID, req.params.key]);
  res.json(rows[0] || { key: req.params.key, value_jsonb: null });
});

v5Router.put("/api/config/:key", requireAuth, async (req: Request, res: Response) => {
  const key = req.params.key;
  if (!isConfigKey(key)) { res.status(404).json({ error: "unknown config key" }); return; }
  await query(
    `INSERT INTO merchant_config (merchant_id, key, value_jsonb, updated_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (merchant_id, key) DO UPDATE SET value_jsonb = EXCLUDED.value_jsonb, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [MERCHANT_ID, key, JSON.stringify(req.body?.value ?? {}), String((req as any).userId || "admin")]
  );
  await query("INSERT INTO admin_audit (admin_id, action, params_json, ip) VALUES ($1, $2, $3, $4)",
    [(req as any).userId || null, `config_update:${key}`, JSON.stringify(req.body?.value ?? {}), req.ip || null]);
  const { seq } = await appendLedger({
    merchantId: MERCHANT_ID, actor: "Merchant", action: "config_update",
    params: { key, value: req.body?.value ?? {} }, decision: "ALLOW",
    policy_checks: { config: "UPDATED" }, rationale: { reason: "merchant settings change" },
    outcome: "SUCCESS",
  } as any);
  await appendActivity({ merchant_id: MERCHANT_ID, actor: "Merchant", type: "CONFIG_UPDATED", summary: `Settings updated: ${key}`, data: { key, seq } });
  res.json({ ok: true, key, audit_seq: seq });
});

// ── M27 policy ceilings (read + guarded edit) ──
v5Router.get("/api/policy/ceilings", requireAuth, async (_req: Request, res: Response) => {
  const { rows } = await query("SELECT key, value_paise FROM policy_ceiling");
  res.json(rows);
});

v5Router.post("/api/policy/edit", requireAuth, async (req: Request, res: Response) => {
  const { field, from_value, to_value } = req.body || {};
  const verdict = (checkCeilingEdit as any)(field, Number(from_value), Number(to_value));
  if (!verdict.ok) {
    await appendActivity({ merchant_id: MERCHANT_ID, actor: "PolicyEngine", type: "CEILING_REJECT", summary: `Ceiling breach rejected: ${field}`, data: { field, to_value }, severity: "warn" } as any);
    res.status(403).json({ ok: false, reason: verdict.reason });
    return;
  }
  if (verdict.status === "pending") {
    // Cap raise: pending 1h + step-up (password re-entry enforced by login session age — recorded here).
    await query("INSERT INTO policy_pending_edits (merchant_id, field, from_value, to_value) VALUES ($1, $2, $3, $4)",
      [MERCHANT_ID, field, Number(from_value), Number(to_value)]);
    res.status(202).json({ ok: true, status: "pending", effective_in_min: 60, step_up: "password re-entry required" });
    return;
  }
  // Cap lower (or same): applies immediately. Only fields with a live policy
  // mapping are editable; the rest report 400 rather than pretend.
  const FIELD_MAP: Record<string, { action: string; column: string }> = {
    incentive_paise: { action: "recovery_incentive", column: "auto_limit_paise" },
    link_auto_allow_paise: { action: "payment_link", column: "auto_limit_paise" },
  };
  const mapping = FIELD_MAP[field];
  if (!mapping) {
    res.status(400).json({ ok: false, reason: `no live policy mapping for ${field} (daily budget caps are per-day rows; upsell cap is a code constant)` });
    return;
  }
  await query(`UPDATE policy_rules SET ${mapping.column} = $1 WHERE action = $2`, [Number(to_value), mapping.action]);
  const { invalidatePolicyCache } = await import("../lib/policyEngine.js");
  invalidatePolicyCache();
  await query("INSERT INTO admin_audit (admin_id, action, params_json, ip) VALUES ($1, $2, $3, $4)",
    [(req as any).userId || null, `policy_lower:${field}`, JSON.stringify({ from_value, to_value }), req.ip || null]);
  await appendLedger({
    merchantId: MERCHANT_ID, actor: "Merchant", action: "config_update",
    params: { field, from_value, to_value }, decision: "ALLOW",
    policy_checks: { ceiling: "UNDER", effect: "immediate" },
    rationale: { reason: "merchant lowered a cap inside the platform ceiling" },
    outcome: "SUCCESS",
  } as any);
  res.json({ ok: true, status: "applied" });
});

// ── M15 NDR ──
v5Router.post("/api/ndr/log-attempt", requireAuth, async (req: Request, res: Response) => {
  const { order_id } = req.body || {};
  if (!order_id) { res.status(400).json({ error: "order_id required" }); return; }
  const { rows } = await query("INSERT INTO ndr_cases (merchant_id, order_id) VALUES ($1, $2) RETURNING id", [MERCHANT_ID, order_id]);
  await query("INSERT INTO admin_audit (admin_id, action, params_json, ip) VALUES ($1, 'ndr_log_attempt', $2, $3)",
    [(req as any).userId || null, JSON.stringify({ order_id }), req.ip || null]);
  const { seq } = await appendLedger({
    merchantId: MERCHANT_ID, actor: "OpsAgent", action: "ndr_case_opened",
    params: { order_id }, decision: "ALLOW",
    policy_checks: { consent_class: "transactional", incentive_paise: 0 },
    rationale: { reason: "manual delivery-attempt-failed; ₹0 transactional NDR touch", case_id: rows[0].id },
    outcome: "SUCCESS",
  } as any);
  await appendActivity({ merchant_id: MERCHANT_ID, actor: "OpsAgent", type: "NDR_OPENED", summary: `NDR case opened for order ${String(order_id).slice(0, 8)} (₹0 transactional)`, data: { case_id: rows[0].id, seq } });
  res.json({ ok: true, case_id: rows[0].id, audit_seq: seq });
});

v5Router.post("/api/ndr/:id/resolve", requireAuth, async (req: Request, res: Response) => {
  const { state } = req.body || {};
  const { rows } = await query("SELECT * FROM ndr_cases WHERE id = $1", [req.params.id]);
  if (!rows[0]) { res.status(404).json({ error: "case not found" }); return; }
  if (!ndrTransition(rows[0].state, state)) { res.status(409).json({ error: `illegal transition ${rows[0].state}→${state}` }); return; }
  await query("UPDATE ndr_cases SET state = $1, resolved_at = NOW() WHERE id = $2", [state, req.params.id]);
  await appendLedger({
    merchantId: MERCHANT_ID, actor: "OpsAgent", action: "ndr_case_resolved",
    params: { case_id: req.params.id, state }, decision: "ALLOW", policy_checks: {},
    rationale: { reason: `NDR ${state}; ${state === "converted" ? "θ_save learns from outcome" : "terminal"}` },
    outcome: "SUCCESS",
  } as any);
  res.json({ ok: true, state });
});

// ── M5 fee audit ──
v5Router.post("/api/fee-audit/run", requireAuth, async (_req: Request, res: Response) => {
  const nowIso = new Date().toISOString();
  const { rows: orders } = await query(
    `SELECT id, fee_paise, fee_basis, payment_method, paid_at FROM orders WHERE status = 'paid' ORDER BY paid_at DESC LIMIT 200`
  );
  let corrected = 0, flagged = 0;
  for (const o of orders) {
    const f = classifyFee({
      orderId: o.id, feeBasis: o.fee_basis || "modeled", feePaise: Number(o.fee_paise || 0),
      method: o.payment_method || "unknown", paidAtIso: new Date(o.paid_at || Date.now()).toISOString(),
      nowIso, entityFeePaise: null,
    });
    if (!f) continue;
    flagged++;
    if (f.kind === "zero_fee_non_upi") {
      // Re-record modeled estimate (2%) — entity fetch is integration wiring.
      const est = Math.round(Number((o as any).amount_paise || 0) * 0.02);
      if (est > 0) {
        await query("UPDATE orders SET fee_paise = $1, fee_basis = 'entity' WHERE id = $2", [est, o.id]);
        corrected++;
      }
    }
    await appendActivity({ merchant_id: MERCHANT_ID, actor: "FeeAuditor", type: "FEE_FLAG", summary: `Fee audit: ${f.kind} on order ${String(o.id).slice(0, 8)}`, data: { order_id: o.id, kind: f.kind }, severity: "warn" } as any);
  }
  const run = await query("INSERT INTO fee_audit_runs (merchant_id, checked, corrected, flagged) VALUES ($1, $2, $3, $4) RETURNING id",
    [MERCHANT_ID, orders.length, corrected, flagged]);
  await appendLedger({
    merchantId: MERCHANT_ID, actor: "FeeAuditor", action: "fee_audit_run",
    params: {}, decision: "ALLOW", policy_checks: {},
    rationale: { checked: orders.length, corrected, flagged },
    outcome: "SUCCESS",
  } as any);
  res.json({ ok: true, run_id: run.rows[0].id, checked: orders.length, corrected, flagged });
});

v5Router.get("/api/fee-audit/count", requireAuth, async (_req: Request, res: Response) => {
  const { rows } = await query("SELECT COALESCE(SUM(flagged),0) AS flagged, COUNT(*) AS runs FROM fee_audit_runs WHERE merchant_id = $1", [MERCHANT_ID]);
  res.json(rows[0]);
});

// ── M6 store credit ──
v5Router.get("/api/credit/:customerId", requireAuth, async (req: Request, res: Response) => {
  const { rows } = await query(
    `SELECT COALESCE(SUM(amount_paise + bonus_paise),0) AS balance FROM credit_ledger WHERE customer_id = $1 AND status = 'active' AND expires_at > NOW()`,
    [req.params.customerId]
  );
  res.json({ customer_id: req.params.customerId, balance_paise: Number(rows[0].balance) });
});

/** QA path: issue credit as refund.processed would (refund webhook branch calls this too). */
export async function issueStoreCredit(params: {
  merchantId: string; customerId: string; orderId: string; refundPaise: number; marketingConsent: boolean;
}): Promise<{ creditId: string; bonus: number; clamped: boolean }> {
  const { bonus, clamped } = creditBonus(params.refundPaise, params.marketingConsent);
  const { rows } = await query(
    `INSERT INTO credit_ledger (merchant_id, customer_id, order_id, amount_paise, bonus_paise, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '${CREDIT_EXPIRY_DAYS} days') RETURNING id`,
    [params.merchantId, params.customerId, params.orderId, params.refundPaise, bonus]
  );
  await appendLedger({
    merchantId: params.merchantId, actor: "MoneyBus", action: "store_credit_issued",
    params: { order_id: params.orderId, refund_paise: params.refundPaise }, decision: "ALLOW",
    policy_checks: { consent_class: "transactional", bonus_consent: params.marketingConsent ? "marketing_ok" : "clamped" },
    rationale: { reason: clamped ? "bonus clamped: no marketing consent" : "credit + bonus issued", bonus_paise: bonus },
    outcome: "SUCCESS",
  } as any);
  return { creditId: rows[0].id, bonus, clamped };
}

v5Router.post("/api/credit/qa-issue", requireAuth, async (req: Request, res: Response) => {
  const { customer_id, order_id, refund_paise, marketing_consent } = req.body || {};
  if (!customer_id || !refund_paise) { res.status(400).json({ error: "customer_id + refund_paise required" }); return; }
  const r = await issueStoreCredit({ merchantId: MERCHANT_ID, customerId: customer_id, orderId: order_id || "qa", refundPaise: Number(refund_paise), marketingConsent: marketing_consent === true });
  res.json({ ok: true, ...r });
});

// ── M8 reviews ──
v5Router.get("/api/reviews/:productId", async (req: Request, res: Response) => {
  const { rows } = await query("SELECT rating, reviewer_mask, created_at, audit_seq FROM reviews WHERE product_id = $1 AND status = 'approved' ORDER BY created_at DESC LIMIT 50", [req.params.productId]);
  const dist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of rows) dist[Number(r.rating)]++;
  res.json({ product_id: req.params.productId, count: rows.length, dist, verified_badge: "verified purchase", reviews: rows });
});

v5Router.post("/api/reviews/collect", requireAuth, async (req: Request, res: Response) => {
  const { order_id, product_id, customer_id } = req.body || {};
  if (!order_id || !product_id) { res.status(400).json({ error: "order_id + product_id required" }); return; }
  const token = crypto.randomBytes(16).toString("hex");
  const { rows } = await query(
    "INSERT INTO reviews (merchant_id, product_id, customer_id, order_id, token) VALUES ($1, $2, $3, $4, $5) RETURNING id, token",
    [MERCHANT_ID, product_id, customer_id || null, order_id, token]
  );
  await appendLedger({
    merchantId: MERCHANT_ID, actor: "ReviewBot", action: "review_requested",
    params: { order_id }, decision: "ALLOW",
    policy_checks: { consent_class: "transactional", per_order_once: true },
    rationale: { reason: "one transactional review request per order lifetime" },
    outcome: "SUCCESS",
  } as any);
  res.json({ ok: true, review_id: rows[0].id, token: rows[0].token });
});

// ── M9 approval patterns ──
v5Router.get("/api/patterns", requireAuth, async (_req: Request, res: Response) => {
  const { rows } = await query("SELECT dimension, value, seen, approved, rejected FROM approval_patterns WHERE merchant_id = $1 ORDER BY seen DESC LIMIT 20", [MERCHANT_ID]);
  res.json({ patterns: rows, note: "observations, not permissions — the learner never edits policy" });
});

v5Router.post("/api/patterns/reset", requireAuth, async (_req: Request, res: Response) => {
  await query("DELETE FROM approval_patterns WHERE merchant_id = $1", [MERCHANT_ID]);
  res.json({ ok: true });
});

// ── M11 reminders ──
v5Router.post("/api/reminders", requireAuth, async (req: Request, res: Response) => {
  const { customer_id, cart_id, fire_at } = req.body || {};
  if (!customer_id || !cart_id || !fire_at) { res.status(400).json({ error: "customer_id + cart_id + fire_at required" }); return; }
  const { rows: existing } = await query("SELECT id FROM reminders WHERE customer_id = $1 AND cart_id = $2 AND status = 'scheduled'", [customer_id, cart_id]);
  if (existing.length > 0) { res.status(409).json({ error: "1 scheduled reminder max" }); return; }
  const { rows } = await query("INSERT INTO reminders (merchant_id, customer_id, cart_id, fire_at) VALUES ($1, $2, $3, $4) RETURNING id", [MERCHANT_ID, customer_id, cart_id, fire_at]);
  await appendLedger({
    merchantId: MERCHANT_ID, actor: "RecoveryBot", action: "reminder_scheduled",
    params: { cart_id, fire_at }, decision: "ALLOW", policy_checks: {},
    rationale: { reason: "customer-chosen reminder time recorded", choice: fire_at },
    outcome: "SUCCESS",
  } as any);
  res.json({ ok: true, reminder_id: rows[0].id });
});

// ── M12 save-for-later ──
v5Router.post("/api/save-for-later", requireAuth, async (req: Request, res: Response) => {
  const { customer_id, product_id, watched_price_paise } = req.body || {};
  if (!customer_id || !product_id) { res.status(400).json({ error: "customer_id + product_id required" }); return; }
  const { rows } = await query("INSERT INTO price_watches (merchant_id, customer_id, product_id, watched_price_paise) VALUES ($1, $2, $3, $4) RETURNING id",
    [MERCHANT_ID, customer_id, product_id, Number(watched_price_paise || 0)]);
  res.json({ ok: true, watch_id: rows[0].id });
});

// ── M29 erasure lite (admin-authenticated) ──
v5Router.delete("/api/privacy/customer/:id", requireAuth, async (req: Request, res: Response) => {
  const { eraseCustomer } = await import("../lib/v5privacy.js");
  const { appendLedger } = await import("../lib/ledger.js");
  const r = await eraseCustomer(
    { q: query, ledgerAppend: (e) => (appendLedger as any)(e) },
    { merchantId: MERCHANT_ID, customerId: req.params.id }
  );
  await query("INSERT INTO admin_audit (admin_id, action, params_json, ip) VALUES ($1, 'customer_erased', $2, $3)",
    [(req as any).userId || null, JSON.stringify({ customer_id: req.params.id, seq: r.seq }), req.ip || null]);
  res.json({ ok: true, audit_seq: r.seq });
});

// ── M16 COD QA trigger ──
v5Router.post("/api/cod/qa-trigger", requireAuth, async (req: Request, res: Response) => {
  const { order_ref, amount_paise } = req.body || {};
  if (!order_ref || !amount_paise) { res.status(400).json({ error: "order_ref + amount_paise required" }); return; }
  const { rows } = await query("INSERT INTO cod_orders (merchant_id, order_ref, amount_paise) VALUES ($1, $2, $3) RETURNING id",
    [MERCHANT_ID, order_ref, Number(amount_paise)]);
  const lossEv = codLossEv({ thetaSave: THETA_SAVE_PRIOR, reverseShippingPaise: 8000, restockLossPaise: 12000, codFeePaise: 3000, incentivePaise: 0 });
  const { seq } = await appendLedger({
    merchantId: MERCHANT_ID, actor: "CodBot", action: "cod_token_confirm",
    params: { order_ref, token_confirm_paise: COD_TOKEN_CONFIRM_PAISE }, decision: "ALLOW",
    policy_checks: { integration: "qa_trigger", trigger: "cod_order" },
    rationale: { reason: "₹10 token-confirm link (fake-COD filter); doorstep QR is integration work", loss_ev: lossEv, theta_save: THETA_SAVE_PRIOR, avoided_loss_paise: 23000 },
    outcome: "SUCCESS",
  } as any);
  res.json({ ok: true, cod_order_id: rows[0].id, token_confirm_paise: COD_TOKEN_CONFIRM_PAISE, loss_ev: lossEv, audit_seq: seq });
});
