import { Router, Request, Response } from "express";
import argon2 from "argon2";
import { getConfig } from "../config.js";
import { query } from "../db.js";
import { evaluateAction } from "../lib/policyEngine.js";
import * as moneyBus from "../lib/moneyBus.js";
import { appendAudit } from "../lib/auditLedger.js";
import { withTransaction } from "../db.js";
import { createLogger } from "../logger.js";

const log = createLogger("protocol");
export const protocolRouter = Router();

// Idempotency middleware
const idempotencyCache = new Map<string, any>();

async function idempotencyMiddleware(req: Request, res: Response, next: Function): Promise<void> {
  const key = req.headers["idempotency-key"] as string;
  if (!key) {
    res.status(400).json({
      type: "about:blank",
      title: "Bad Request",
      status: 400,
      detail: "Idempotency-Key header required",
    });
    return;
  }

  const { rows } = await query("SELECT response_json FROM idempotency WHERE key = $1", [key]);
  if (rows[0]) {
    res.json(rows[0].response_json);
    return;
  }

  // Store original json method
  const originalJson = res.json.bind(res);
  res.json = (body: any) => {
    query(
      "INSERT INTO idempotency (key, request_hash, response_json) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [key, "", JSON.stringify(body)]
    ).catch(() => {});
    return originalJson(body);
  };

  next();
}

// Buyer API key auth
async function requireBuyerKey(req: Request, res: Response, next: Function): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    res.status(401).json({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      detail: "Bearer token required",
    });
    return;
  }

  const token = auth.slice(7);
  const { rows } = await query("SELECT * FROM buyer_api_keys");
  let matched = false;

  for (const row of rows) {
    if (await argon2.verify(row.key_hash, token)) {
      (req as any).buyerKey = row;
      matched = true;
      break;
    }
  }

  if (!matched) {
    res.status(401).json({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      detail: "Invalid API key",
    });
    return;
  }

  next();
}

// Discovery
protocolRouter.get("/.well-known/agent-commerce.json", (_req: Request, res: Response) => {
  const config = getConfig();
  res.json({
    merchant_name: "Sellable Demo Store",
    catalog_url: "/agent/catalog",
    quote_url: "/agent/quote",
    purchase_intent_url: "/agent/purchase-intent",
    payment_status_url: "/agent/payment-status",
    payment_methods: ["upi", "card"],
    currency: "INR",
    policies: {
      max_auto_amount_paise: 1000000,
      escalation_threshold_paise: 5000000,
      hold_ttl_minutes: config.HOLD_TTL_MIN,
      max_retries: 1,
    },
  });
});

// Catalog
protocolRouter.get("/agent/catalog", requireBuyerKey, async (_req: Request, res: Response) => {
  const { rows } = await query(
    "SELECT id, name, price_paise, stock FROM products WHERE active = true"
  );
  res.json(rows);
});

// Quote
protocolRouter.post(
  "/agent/quote",
  requireBuyerKey,
  idempotencyMiddleware,
  async (req: Request, res: Response) => {
    const { items, budget_paise } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      res.status(422).json({
        type: "about:blank",
        title: "Unprocessable Entity",
        status: 422,
        detail: "items array required",
      });
      return;
    }

    try {
      const holds: any[] = [];
      let totalPaise = 0n;

      await withTransaction(async (client) => {
        for (const item of items) {
          const { rows } = await client.query(
            "SELECT id, price_paise, stock FROM products WHERE id = $1 FOR UPDATE",
            [item.id]
          );

          if (!rows[0]) {
            throw { status: 404, detail: `Product ${item.id} not found` };
          }

          if (rows[0].stock < item.qty) {
            throw {
              status: 409,
              type: "out_of_stock",
              detail: `Product ${item.id} has only ${rows[0].stock} in stock`,
            };
          }

          await client.query(
            "UPDATE products SET stock = stock - $1 WHERE id = $2",
            [item.qty, item.id]
          );

          const holdToken = crypto.randomUUID();
          const quoteId = crypto.randomUUID();
          const expiresAt = new Date(Date.now() + getConfig().HOLD_TTL_MIN * 60 * 1000);

          await client.query(
            `INSERT INTO hold_tokens (token, merchant_id, quote_id, product_id, qty, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [holdToken, "00000000-0000-0000-0000-000000000001", quoteId, item.id, item.qty, expiresAt]
          );

          totalPaise += BigInt(rows[0].price_paise) * BigInt(item.qty);
          holds.push({
            product_id: item.id,
            qty: item.qty,
            price_paise: Number(rows[0].price_paise),
            hold_token: holdToken,
          });
        }
      });

      const seq = await appendAudit({
        actor: "BuyerAgent",
        action: "create_quote",
        params_json: { items, budget_paise },
        decision: "ALLOW",
        policy_checks_json: {},
        rationale_json: {},
      });

      res.json({
        quote_id: crypto.randomUUID(),
        items: holds,
        total_paise: Number(totalPaise),
        valid_until: new Date(Date.now() + getConfig().HOLD_TTL_MIN * 60 * 1000).toISOString(),
        hold_token: holds[0]?.hold_token,
        audit_seq: seq,
      });
    } catch (err: any) {
      if (err.status) {
        res.status(err.status).json({
          type: "about:blank",
          title: err.type || "Error",
          status: err.status,
          detail: err.detail,
        });
      } else {
        log.error({ error: err.message }, "Quote error");
        res.status(500).json({
          type: "about:blank",
          title: "Internal Server Error",
          status: 500,
        });
      }
    }
  }
);

// Purchase intent
protocolRouter.post(
  "/agent/purchase-intent",
  requireBuyerKey,
  idempotencyMiddleware,
  async (req: Request, res: Response) => {
    const { quote_id, hold_token, payment_method_hint } = req.body;

    const config = getConfig();
    const policyResult = await evaluateAction("payment_link", {
      amount_paise: 10000, // Would come from quote
    });

    if (policyResult.decision === "BLOCK") {
      res.status(403).json({
        type: "about:blank",
        title: "Forbidden",
        status: 403,
        detail: "Amount exceeds auto-allow limit",
      });
      return;
    }

    if (policyResult.decision === "ESCALATE") {
      res.status(202).json({
        status: "escalated",
        approval_id: crypto.randomUUID(),
        audit_seq: 0,
      });
      return;
    }

    const seq = await moneyBus.execute(
      "BuyerAgent",
      {
        type: "create_payment_link",
        params: {
          amount: 10000,
          notes: { quote_id, hold_token },
        },
      },
      policyResult,
      { trigger: "ai_buyer_purchase", quote_id, hold_token, payment_method_hint }
    );

    res.json({
      order_id: crypto.randomUUID(),
      payment_url: "",
      amount_paise: 10000,
      ttl_seconds: config.HOLD_TTL_MIN * 60,
      audit_seq: seq.seq,
    });
  }
);

// Payment status
protocolRouter.get(
  "/agent/payment-status",
  requireBuyerKey,
  async (req: Request, res: Response) => {
    const { order_id } = req.query;
    if (!order_id) {
      res.status(400).json({
        type: "about:blank",
        title: "Bad Request",
        status: 400,
        detail: "order_id query parameter required",
      });
      return;
    }

    const { rows } = await query("SELECT * FROM orders WHERE id = $1", [order_id]);
    if (!rows[0]) {
      res.status(404).json({
        type: "about:blank",
        title: "Not Found",
        status: 404,
        detail: "Order not found",
      });
      return;
    }

    res.json({
      status: rows[0].status,
      audit_seq: 0,
    });
  }
);
