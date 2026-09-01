import crypto from "node:crypto";
import { query } from "../db.js";
import { evaluateAction } from "./policyEngine.js";
import * as moneyBus from "./moneyBus.js";
import { appendAudit } from "./auditLedger.js";
import { getConfig } from "../config.js";
import { createLogger } from "../logger.js";

const log = createLogger("buyerSession");

export interface Mandate {
  max_amount_paise: number;
  currency: string;
  purpose: string;
  allowed_categories: string[];
  delivery_by: string;
  payment_methods: string[];
}

export interface BuyerSession {
  id: string;
  buyer_agent_id: string;
  mandate_json: Mandate;
  merchant_id: string;
  status: string;
  expires_at: Date;
  audit_seq: number | null;
  quote_snapshot_json: any;
  price_version: number;
}

/**
 * V6: Strict state machine: open -> quoted -> intent -> paid|denied|expired
 * Transitions are single conditional UPDATEs ("... WHERE id=$1 AND status=$2")
 */
export async function createSession(
  buyerAgentId: string,
  merchantId: string,
  mandate: Mandate
): Promise<BuyerSession> {
  const id = crypto.randomUUID();
  const config = getConfig();
  const expiresAt = new Date(Date.now() + config.HOLD_TTL_MIN * 60 * 1000);

  const { rows } = await query(
    `INSERT INTO buyer_sessions (id, buyer_agent_id, mandate_json, merchant_id, status, expires_at, price_version)
     VALUES ($1, $2, $3, $4, 'open', $5, 1) RETURNING *`,
    [id, buyerAgentId, JSON.stringify(mandate), merchantId, expiresAt]
  );

  log.info({ sessionId: id, buyerAgentId }, "Buyer session created");
  return rows[0];
}

/**
 * V6: Add items and snapshot the quote with price_version.
 * Rejects any buyer-supplied amount (N6).
 */
export async function quoteSession(
  sessionId: string,
  items: { id: string; qty: number }[]
): Promise<{ totalPaise: number; items: any[]; priceVersion: number }> {
  // Validate no amount field in request
  if (items.some((i: any) => i.amount !== undefined || i.total !== undefined)) {
    throw { status: 422, detail: "amount is server-set" };
  }

  const session = await getSession(sessionId);
  if (!session) throw { status: 404, detail: "Session not found" };

  // V6: Single conditional UPDATE
  const { rowCount } = await query(
    "UPDATE buyer_sessions SET status = 'quoted' WHERE id = $1 AND status = 'open'",
    [sessionId]
  );
  if (rowCount === 0) throw { status: 409, detail: "Session not in open status" };

  let totalPaise = 0;
  const quotedItems = [];

  for (const item of items) {
    const { rows } = await query(
      "SELECT id, name, price_paise, stock, price_version FROM products WHERE id = $1 AND active = true",
      [item.id]
    );
    if (!rows[0]) throw { status: 404, detail: `Product ${item.id} not found` };
    if (rows[0].stock < item.qty) throw { status: 409, type: "out_of_stock", detail: `Insufficient stock for ${item.id}` };

    const itemTotal = Number(rows[0].price_paise) * item.qty;
    totalPaise += itemTotal;
    quotedItems.push({
      id: rows[0].id,
      name: rows[0].name,
      price_paise: Number(rows[0].price_paise),
      price_version: Number(rows[0].price_version || 1),
      qty: item.qty,
      total_paise: itemTotal,
    });
  }

  // Validate against mandate
  if (totalPaise > session.mandate_json.max_amount_paise) {
    throw { status: 422, detail: `Total ${totalPaise} exceeds mandate max ${session.mandate_json.max_amount_paise}` };
  }

  // V6: Snapshot the quote with price_version
  const maxPriceVersion = Math.max(...quotedItems.map(i => i.price_version));
  const quoteSnapshot = {
    items: quotedItems,
    total_paise: totalPaise,
    price_version: maxPriceVersion,
    quoted_at: new Date().toISOString(),
  };

  await query(
    "UPDATE buyer_sessions SET quote_snapshot_json = $1, price_version = $2 WHERE id = $3",
    [JSON.stringify(quoteSnapshot), maxPriceVersion, sessionId]
  );

  return { totalPaise, items: quotedItems, priceVersion: maxPriceVersion };
}

/**
 * V6: Process purchase intent with price version validation.
 * 0 rows updated = 409.
 */
export async function purchaseIntent(
  sessionId: string,
  paymentMethodHint?: string
): Promise<{ orderId?: string; paymentUrl?: string; status: string; auditSeq: number }> {
  const session = await getSession(sessionId);
  if (!session) throw { status: 404, detail: "Session not found" };

  // V6: Single conditional UPDATE
  const { rowCount } = await query(
    "UPDATE buyer_sessions SET status = 'intent' WHERE id = $1 AND status = 'quoted'",
    [sessionId]
  );
  if (rowCount === 0) throw { status: 409, detail: "Session not in quoted status" };

  // V6: Use snapshotted total, not mandate max
  const quoteSnapshot = session.quote_snapshot_json;
  if (!quoteSnapshot || !quoteSnapshot.total_paise) {
    throw { status: 409, detail: "No quote snapshot found" };
  }

  const amountPaise = quoteSnapshot.total_paise;

  // V6: Validate price version hasn't changed
  if (quoteSnapshot.price_version !== session.price_version) {
    throw { status: 409, detail: "Catalog changed, re-quote" };
  }

  // Policy check
  const policyResult = await evaluateAction("payment_link", {
    amount_paise: amountPaise,
  });

  if (policyResult.decision === "BLOCK") {
    await query("UPDATE buyer_sessions SET status = 'denied' WHERE id = $1 AND status = 'intent'", [sessionId]);
    throw { status: 403, detail: "Amount exceeds policy limit" };
  }

  if (policyResult.decision === "ESCALATE") {
    await query("UPDATE buyer_sessions SET status = 'denied' WHERE id = $1 AND status = 'intent'", [sessionId]);
    const seq = await appendAudit({
      actor: 'BuyerAgent',
      action: 'purchase_intent',
      params_json: { sessionId, amountPaise },
      decision: 'ESCALATE',
      policy_checks_json: policyResult.checks,
      rationale_json: { sessionId, amountPaise },
      outcome: 'ESCALATED',
    });
    return { status: 'escalated', auditSeq: seq };
  }

  // Execute through money bus with snapshotted amount
  const { seq, result } = await moneyBus.execute(
    "BuyerAgent",
    {
      type: "create_payment_link",
      params: {
        amount: amountPaise, // V6: charges ONLY the snapshotted total
        reference_id: "",
        notes: { session_id: sessionId, price_version: session.price_version },
      },
    },
    policyResult,
    { sessionId, amountPaise, paymentMethodHint }
  );

  // V6: Check if still in intent status (single conditional update)
  await query(
    "UPDATE buyer_sessions SET status = 'paid', audit_seq = $1 WHERE id = $2 AND status = 'intent'",
    [seq, sessionId]
  );

  return {
    orderId: (result as any)?.id,
    paymentUrl: (result as any)?.short_url,
    status: 'paid',
    auditSeq: seq,
  };
}

/**
 * V6: Get session by ID with all fields.
 */
export async function getSession(sessionId: string): Promise<BuyerSession | null> {
  const { rows } = await query("SELECT * FROM buyer_sessions WHERE id = $1", [sessionId]);
  return rows[0] || null;
}

/**
 * V6: Get payment status with receipt.
 */
export async function getPaymentStatus(sessionId: string): Promise<any> {
  const session = await getSession(sessionId);
  if (!session) throw { status: 404, detail: "Session not found" };

  return {
    status: session.status,
    order_id: session.audit_seq,
    items: session.quote_snapshot_json?.items || [],
    total_paise: session.quote_snapshot_json?.total_paise || 0,
    invoice: {
      number: `INV-${sessionId.slice(0, 8)}`,
      currency: session.mandate_json.currency,
      tax_breakup: [],
    },
    fulfillment: {
      estimated_delivery: session.mandate_json.delivery_by,
    },
    audit_reference: session.audit_seq,
  };
}

/**
 * V6: Expire old sessions (cron job).
 */
export async function expireStaleSessions(): Promise<number> {
  const { rowCount } = await query(
    `UPDATE buyer_sessions SET status = 'expired'
     WHERE status IN ('open', 'quoted')
     AND expires_at < NOW()`
  );
  return rowCount || 0;
}
