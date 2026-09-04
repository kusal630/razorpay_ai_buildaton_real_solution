import { Router, Request, Response } from "express";
import crypto from "node:crypto";
import argon2 from "argon2";
import { getConfig } from "../config.js";
import { query, withTransaction } from "../db.js";
import { evaluateAction } from "../lib/policyEngine.js";
import * as moneyBus from "../lib/moneyBus.js";
import { appendLedger } from "../lib/ledger.js";
import { appendActivity } from "../lib/activity.js";
import { createLogger } from "../logger.js";

const log = createLogger("protocol");
export const protocolRouter = Router();
const MERCHANT_ID = "5a3ac6ce-b2c7-4b1f-a9db-45296841f30b";

const idempotencyCache = new Map<string, any>();
async function idempotencyMiddleware(req: Request, res: Response, next: Function): Promise<void> {
  const key = req.headers["idempotency-key"] as string;
  if (!key) { res.status(400).json({ type: "about:blank", title: "Bad Request", status: 400, detail: "Idempotency-Key header required" }); return; }
  const { rows } = await query("SELECT response_json FROM idempotency WHERE key = $1", [key]);
  if (rows[0]) { res.json(rows[0].response_json); return; }
  const originalJson = res.json.bind(res);
  res.json = (body: any) => {
    query("INSERT INTO idempotency (key, request_hash, response_json) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [key, "", JSON.stringify(body)]).catch(() => {});
    return originalJson(body);
  };
  next();
}

async function requireBuyerKey(req: Request, res: Response, next: Function): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) { res.status(401).json({ type: "about:blank", title: "Unauthorized", status: 401, detail: "Bearer token required" }); return; }
  const token = auth.slice(7);
  const { rows } = await query("SELECT * FROM buyer_api_keys");
  let matched = false;
  for (const row of rows) {
    try { if (await argon2.verify(row.key_hash, token)) { (req as any).buyerKey = row; matched = true; break; } } catch {}
  }
  if (!matched) { res.status(401).json({ type: "about:blank", title: "Unauthorized", status: 401, detail: "Invalid API key" }); return; }
  next();
}

protocolRouter.get("/.well-known/agent-commerce.json", (_req: Request, res: Response) => {
  const config = getConfig();
  res.json({
    merchant_name: "Electronics Hub", catalog_url: "/agent/catalog",
    quote_url: "/agent/sessions/:id/quote", purchase_intent_url: "/agent/sessions/:id/purchase-intent",
    payment_status_url: "/agent/payment-status", payment_methods: ["upi", "card"], currency: "INR",
    policies: { max_auto_amount_paise: 1000000, escalation_threshold_paise: 5000000, hold_ttl_minutes: config.HOLD_TTL_MIN, max_retries: 1 },
  });
});

protocolRouter.post("/agent/sessions", requireBuyerKey, idempotencyMiddleware, async (req: Request, res: Response) => {
  const { mandate } = req.body;
  if (!mandate || !mandate.max_amount_paise || !mandate.purpose) {
    res.status(400).json({ type: "about:blank", status: 400, detail: "mandate with max_amount_paise and purpose required" });
    return;
  }
  const sessionId = crypto.randomUUID();
  await query(
    `INSERT INTO buyer_sessions (id, merchant_id, buyer_key_id, mandate_json, status)
     VALUES ($1, $2, $3, $4, 'open')`,
    [sessionId, MERCHANT_ID, (req as any).buyerKey?.id || "", JSON.stringify(mandate)]
  );
  res.json({ session_id: sessionId, status: "open", mandate });
});

protocolRouter.get("/agent/sessions", requireBuyerKey, async (_req: Request, res: Response) => {
  const { rows } = await query("SELECT id, status, mandate_json, created_at FROM buyer_sessions WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 50", [MERCHANT_ID]);
  res.json(rows);
});

protocolRouter.post("/agent/sessions/:id/quote", requireBuyerKey, idempotencyMiddleware, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { items } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) { res.status(422).json({ detail: "items array required" }); return; }
  try {
    let totalPaise = 0;
    const quotedItems: any[] = [];
    await withTransaction(async (client) => {
      for (const item of items) {
        const { rows } = await client.query("SELECT id, name, price_paise, price_version, stock FROM products WHERE id = $1 FOR UPDATE", [item.id]);
        if (!rows[0]) { throw { status: 404, detail: `Product ${item.id} not found` }; }
        if (rows[0].stock < (item.qty || 1)) { throw { status: 409, detail: `Out of stock: ${item.id}` }; }
        await client.query("UPDATE products SET stock = stock - $1 WHERE id = $2", [item.qty || 1, item.id]);
        const holdToken = crypto.randomBytes(16).toString("hex");
        await client.query("INSERT INTO hold_tokens (token, merchant_id, quote_id, product_id, qty, expires_at) VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '15 minutes')", [holdToken, MERCHANT_ID, id, item.id, item.qty || 1]);
        totalPaise += Number(rows[0].price_paise) * (item.qty || 1);
        quotedItems.push({ product_id: item.id, name: rows[0].name, price_paise: Number(rows[0].price_paise), qty: item.qty || 1, hold_token: holdToken, price_version: rows[0].price_version });
      }
    });
    const priceVersion = quotedItems[0]?.price_version || 1;
    await query("UPDATE buyer_sessions SET status = 'quoted', quote_snapshot_json = $1, price_version = $2 WHERE id = $3", [JSON.stringify({ items: quotedItems, total_paise: totalPaise }), priceVersion, id]);
    res.json({ session_id: id, items: quotedItems, total_paise: totalPaise, price_version: priceVersion, valid_until: new Date(Date.now() + 15 * 60000).toISOString() });
  } catch (err: any) { if (err.status) res.status(err.status).json(err); else { log.error({ error: err.message }); res.status(500).json({ detail: err.message }); } }
});

protocolRouter.post("/agent/sessions/:id/purchase-intent", requireBuyerKey, idempotencyMiddleware, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows: sessionRows } = await query("SELECT * FROM buyer_sessions WHERE id = $1", [id]);
  if (!sessionRows[0]) { res.status(404).json({ detail: "Session not found" }); return; }
  if (sessionRows[0].status !== "quoted") { res.status(409).json({ detail: "Session not in quoted state" }); return; }
  const snapshot = sessionRows[0].quote_snapshot_json;
  const totalPaise = snapshot?.total_paise || 0;
  const policyResult = await evaluateAction("payment_link", { amount_paise: totalPaise });
  if (policyResult.decision === "BLOCK") { res.status(403).json({ detail: "Amount exceeds limit" }); return; }
  if (policyResult.decision === "ESCALATE") {
    await query("UPDATE buyer_sessions SET status = 'intent' WHERE id = $1", [id]);
    const { seq } = await appendLedger({ merchantId: MERCHANT_ID, actor: "BuyerAgent", action: "purchase_intent", params: { session_id: id, total_paise: totalPaise }, decision: "ESCALATE", policy_checks: policyResult.checks, rationale: { session_id: id }, outcome: "ESCALATED" });
    const { rows: approvalRows } = await query("INSERT INTO approvals (merchant_id, audit_seq, context, status) VALUES ($1, $2, $3, 'pending') RETURNING id", [MERCHANT_ID, seq, JSON.stringify({ session_id: id, total_paise: totalPaise })]);
    await appendActivity({ merchant_id: MERCHANT_ID, actor: "BuyerAgent", type: "ESCALATED", summary: `Buyer session ${id} escalated (₹${(totalPaise/100).toFixed(0)})`, data: { session_id: id, approval_id: approvalRows[0].id } });
    res.status(202).json({ status: "escalated", approval_id: approvalRows[0].id, audit_seq: seq });
    return;
  }
  await query("UPDATE buyer_sessions SET status = 'intent' WHERE id = $1", [id]);
  const { seq, data } = await moneyBus.execute("BuyerAgent", { type: "create_payment_link", params: { amount: totalPaise, description: `Agent purchase - session ${id}` } }, policyResult, { session_id: id, customer_id: null, trigger: "ai_buyer_purchase" }, MERCHANT_ID);
  res.json({ order_id: data?.order_id || "", payment_url: data?.short_url || "", amount_paise: totalPaise, audit_seq: seq });
});

protocolRouter.get("/agent/payment-status", requireBuyerKey, async (req: Request, res: Response) => {
  const { order_id } = req.query;
  if (!order_id) { res.status(400).json({ detail: "order_id required" }); return; }
  const { rows } = await query("SELECT * FROM orders WHERE id = $1", [order_id]);
  if (!rows[0]) { res.status(404).json({ detail: "Order not found" }); return; }
  res.json({ status: rows[0].status, order_id: rows[0].id, amount_paise: rows[0].amount_paise, items: [], audit_reference: rows[0].audit_seq || 0 });
});
