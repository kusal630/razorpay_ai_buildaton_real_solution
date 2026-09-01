import { Router, Request, Response } from "express";
import crypto from "node:crypto";
import { getConfig } from "../config.js";
import { query } from "../db.js";
import { createLogger } from "../logger.js";
import { verifyTrackKey } from "../lib/consent.js";
import { redactForPersist } from "../lib/redact.js";
import { findOrCreateCustomer } from "../lib/identity.js";

const log = createLogger("track");
export const trackRouter = Router();

// W5: Contact field rejection for ALL routes
const CONTACT_FIELDS = ["email", "name", "phone", "contact", "customer"];

function containsContactFields(obj: any): boolean {
  if (!obj || typeof obj !== "object") return false;
  for (const key of Object.keys(obj)) {
    if (CONTACT_FIELDS.includes(key.toLowerCase())) return true;
    if (typeof obj[key] === "object" && containsContactFields(obj[key])) return true;
  }
  return false;
}

// W5: Reject client-supplied totals/amounts (N21)
function containsAmountFields(obj: any): boolean {
  if (!obj || typeof obj !== "object") return false;
  const amountFields = ["total_paise", "amount", "amount_paise", "price", "price_paise", "total"];
  for (const key of Object.keys(obj)) {
    if (amountFields.includes(key.toLowerCase())) return true;
    if (typeof obj[key] === "object" && containsAmountFields(obj[key])) return true;
  }
  return false;
}

// W5: Compute cart total from catalog server-side
async function computeCartTotal(items: { id: string; qty: number }[]): Promise<number> {
  let total = 0;
  for (const item of items) {
    const { rows } = await query(
      "SELECT price_paise FROM products WHERE id = $1 AND active = true",
      [item.id]
    );
    if (rows[0]) {
      total += Number(rows[0].price_paise) * item.qty;
    }
  }
  return total;
}

// Cart tracking - PUBLIC SITE KEY only (anonymous events)
trackRouter.post("/api/track/cart", async (req: Request, res: Response) => {
  const trackKey = req.headers["x-track-key"] as string;
  if (!trackKey) {
    res.status(401).json({ error: "Missing track key" });
    return;
  }

  // V1: Verify key and check type
  const keyInfo = await verifyTrackKey(trackKey);
  if (!keyInfo.valid || keyInfo.keyType !== "public_site") {
    res.status(401).json({ error: "Invalid track key" });
    return;
  }

  // W5: Reject contact fields on ALL routes (N9)
  if (containsContactFields(req.body)) {
    res.status(422).json({ error: "Contact fields rejected on public route" });
    return;
  }

  // W5: Reject client-supplied totals/amounts (N21)
  if (containsAmountFields(req.body)) {
    res.status(422).json({ error: "Amount fields rejected; server computes totals from catalog" });
    return;
  }

  const { cart_id, items } = req.body;
  if (!cart_id || !items) {
    res.status(400).json({ error: "cart_id and items required" });
    return;
  }

  try {
    // W5: Compute total server-side from catalog
    const totalPaise = await computeCartTotal(items);

    // Anonymous cart - no customer binding (V1: no anchor, no contact => no action)
    const customerId = null;

    // Redact before persist (N14)
    const redactedItems = redactForPersist(items);

    // Upsert cart with server-computed total
    await query(
      `INSERT INTO carts (id, merchant_id, customer_id, items_json, total_paise, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'active', NOW())
       ON CONFLICT (id) DO UPDATE SET
         items_json = $4, total_paise = $5, updated_at = NOW(),
         status = CASE WHEN carts.status = 'abandoned' THEN 'active' ELSE carts.status END`,
      [cart_id, keyInfo.merchantId, customerId, JSON.stringify(redactedItems), totalPaise]
    );

    log.debug({ cart_id, totalPaise }, "Cart tracked (anonymous, server-computed total)");
    res.json({ success: true, total_paise: totalPaise });
  } catch (err: any) {
    log.error({ error: err.message }, "Track cart error");
    res.status(500).json({ error: "Internal error" });
  }
});

// V1: Server-to-server contact binding (SECRET SERVER KEY)
trackRouter.post("/api/track/customer", async (req: Request, res: Response) => {
  const serverKey = req.headers["x-server-key"] as string;
  if (!serverKey) {
    res.status(401).json({ error: "Missing server key" });
    return;
  }

  // V1: Verify key and check type
  const keyInfo = await verifyTrackKey(serverKey);
  if (!keyInfo.valid || keyInfo.keyType !== "secret_server") {
    res.status(401).json({ error: "Invalid server key" });
    return;
  }

  const { cart_id, email, name, phone } = req.body;
  if (!cart_id || (!email && !phone)) {
    res.status(400).json({ error: "cart_id and email or phone required" });
    return;
  }

  try {
    // W5: Find or create customer with identity token
    const merchantId = keyInfo.merchantId || "00000000-0000-0000-0000-000000000001";
    const { customerId, identityToken, isNew } = await findOrCreateCustomer(
      merchantId,
      { email, name, phone }
    );

    // Bind customer to cart
    await query(
      "UPDATE carts SET customer_id = $1 WHERE id = $2",
      [customerId, cart_id]
    );

    log.debug({ cart_id, customerId, isNew }, "Customer bound to cart (server-side)");
    res.json({ success: true, customerId, identityToken, isNew });
  } catch (err: any) {
    log.error({ error: err.message }, "Track customer error");
    res.status(500).json({ error: "Internal error" });
  }
});

// Order confirmed (suppresses recovery)
trackRouter.post("/api/track/order-confirmed", async (req: Request, res: Response) => {
  const trackKey = req.headers["x-track-key"] as string;
  if (!trackKey) {
    res.status(401).json({ error: "Missing track key" });
    return;
  }

  const keyInfo = await verifyTrackKey(trackKey);
  if (!keyInfo.valid) {
    res.status(401).json({ error: "Invalid track key" });
    return;
  }

  const { cart_id } = req.body;
  if (!cart_id) {
    res.status(400).json({ error: "cart_id required" });
    return;
  }

  await query(
    "UPDATE carts SET status = 'recovered' WHERE id = $1",
    [cart_id]
  );

  res.json({ success: true });
});
