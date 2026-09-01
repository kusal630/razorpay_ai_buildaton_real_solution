import { Router, Request, Response } from "express";
import crypto from "node:crypto";
import argon2 from "argon2";
import * as jose from "jose";
import { getConfig } from "../config.js";
import { query, withTransaction } from "../db.js";
import { invalidatePolicyCache } from "../lib/policyEngine.js";
import { verifyChain, createCheckpoint } from "../lib/auditLedger.js";
import { createLogger } from "../logger.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = createLogger("ops");
export const opsRouter = Router();

// Rate limiting for auth endpoints
const authAttempts = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = authAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    authAttempts.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

// Auth middleware
async function requireAuth(req: Request, res: Response, next: Function): Promise<void> {
  const token = req.cookies?.session;
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const secret = new TextEncoder().encode(getConfig().SESSION_SECRET);
    const { payload } = await jose.jwtVerify(token, secret);
    (req as any).userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: "Invalid session" });
  }
}

// CSRF double-submit
function csrfCheck(req: Request, res: Response, next: Function): void {
  const cookie = req.cookies?.csrf;
  const header = req.headers["x-csrf-token"];
  if (!cookie || !header || cookie !== header) {
    res.status(403).json({ error: "CSRF token mismatch" });
    return;
  }
  next();
}

// Serve dashboard HTML (public - login form handles auth)
opsRouter.get("/", (_req: Request, res: Response) => {
  const dashboardPath = path.join(__dirname, "..", "..", "src", "public", "dashboard", "index.html");
  if (fs.existsSync(dashboardPath)) {
    res.sendFile(dashboardPath);
  } else {
    res.status(404).send("Dashboard not found");
  }
});

// Login
opsRouter.post("/ops/login", async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: "Email and password required" });
    return;
  }

  const ip = req.ip || "unknown";
  if (!checkRateLimit(ip, 5, 15 * 60 * 1000)) {
    res.status(429).json({ error: "Too many login attempts" });
    return;
  }

  try {
    const { rows } = await query("SELECT * FROM merchant_admins WHERE email = $1", [email]);
    if (!rows[0] || !(await argon2.verify(rows[0].password_hash, password))) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const secret = new TextEncoder().encode(getConfig().SESSION_SECRET);
    const jwt = await new jose.SignJWT({ sub: rows[0].id })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("24h")
      .sign(secret);

    res.cookie("session", jwt, { httpOnly: true, secure: false, sameSite: "lax" });
    const csrfToken = crypto.randomUUID();
    res.cookie("csrf", csrfToken, { httpOnly: false, secure: false, sameSite: "lax" });
    res.json({ success: true, csrfToken });
  } catch (err: any) {
    log.error({ error: err.message }, "Login error");
    res.status(500).json({ error: "Internal error" });
  }
});

// Dashboard API
opsRouter.get("/ops/dashboard", requireAuth, async (_req: Request, res: Response) => {
  try {
    const [revenue, auditStats, approvalStats] = await Promise.all([
      query(`SELECT source, COUNT(*) as count, COALESCE(SUM(amount_paise), 0) as total
             FROM orders WHERE status = 'paid' GROUP BY source`),
      query(`SELECT outcome, COUNT(*) as count FROM audit_log GROUP BY outcome`),
      query(`SELECT status, COUNT(*) as count FROM approvals GROUP BY status`),
    ]);

    res.json({
      revenue: revenue.rows,
      audit: auditStats.rows,
      approvals: approvalStats.rows,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Approvals
opsRouter.get("/ops/approvals", requireAuth, async (_req: Request, res: Response) => {
  const { rows } = await query(
    `SELECT a.*, al.action, al.params_json, al.rationale_json
     FROM approvals a JOIN audit_log al ON a.audit_seq = al.seq
     WHERE a.status = 'pending' ORDER BY a.created_at DESC`
  );
  res.json(rows);
});

opsRouter.post("/ops/approvals/:id/decide", requireAuth, csrfCheck, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { decision } = req.body as { decision: "approved" | "denied" };

  if (!["approved", "denied"].includes(decision)) {
    res.status(400).json({ error: "Invalid decision" });
    return;
  }

  await withTransaction(async (client) => {
    await client.query(
      "UPDATE approvals SET status = $1, decided_by = $2, decided_at = NOW() WHERE id = $3 AND status = 'pending'",
      [decision, (req as any).userId, id]
    );
  });

  res.json({ success: true });
});

// Policy editor
opsRouter.get("/ops/policies", requireAuth, async (_req: Request, res: Response) => {
  const { rows } = await query("SELECT * FROM policy_rules ORDER BY action");
  res.json(rows);
});

opsRouter.put("/ops/policies/:id", requireAuth, csrfCheck, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { auto_limit_paise, escalate_limit_paise, hard_block_limit_paise } = req.body;

  await withTransaction(async (client) => {
    const { rows: old } = await client.query("SELECT * FROM policy_rules WHERE id = $1", [id]);
    await client.query(
      "UPDATE policy_rules SET auto_limit_paise = $1, escalate_limit_paise = $2, hard_block_limit_paise = $3 WHERE id = $4",
      [auto_limit_paise, escalate_limit_paise, hard_block_limit_paise, id]
    );
    await client.query(
      "INSERT INTO policy_audit (rule_id, changed_by, old_values, new_values) VALUES ($1, $2, $3, $4)",
      [id, (req as any).userId, JSON.stringify(old[0]), JSON.stringify(req.body)]
    );
  });

  invalidatePolicyCache();
  res.json({ success: true });
});

// Buyer API keys
opsRouter.get("/ops/buyer-keys", requireAuth, async (_req: Request, res: Response) => {
  const { rows } = await query("SELECT id, label, rate_limit_per_min, created_at FROM buyer_api_keys");
  res.json(rows);
});

opsRouter.post("/ops/buyer-keys", requireAuth, csrfCheck, async (req: Request, res: Response) => {
  const { label, rate_limit_per_min } = req.body;
  const key = `sk_${crypto.randomBytes(32).toString("hex")}`;
  const keyHash = await argon2.hash(key);

  const { rows } = await query(
    "INSERT INTO buyer_api_keys (merchant_id, label, key_hash, rate_limit_per_min) VALUES ($1, $2, $3, $4) RETURNING id",
    ["00000000-0000-0000-0000-000000000001", label, keyHash, rate_limit_per_min || 60]
  );

  res.json({ id: rows[0].id, key, label });
});

// Verify chain
opsRouter.post("/ops/verify-chain", requireAuth, async (_req: Request, res: Response) => {
  const result = await verifyChain();
  res.json(result);
});

// Create checkpoint
opsRouter.post("/ops/checkpoint", requireAuth, async (_req: Request, res: Response) => {
  const id = await createCheckpoint();
  res.json({ id });
});

// Queue status
opsRouter.get("/ops/status", requireAuth, async (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});
