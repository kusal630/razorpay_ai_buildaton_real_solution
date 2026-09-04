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
const MERCHANT_ID = "5a3ac6ce-b2c7-4b1f-a9db-45296841f30b";

const CONTACT_FIELDS = ["email", "name", "phone", "contact", "customer"];
function containsContactFields(obj: any): boolean {
  if (!obj || typeof obj !== "object") return false;
  for (const key of Object.keys(obj)) {
    if (CONTACT_FIELDS.includes(key.toLowerCase())) return true;
    if (typeof obj[key] === "object" && containsContactFields(obj[key])) return true;
  }
  return false;
}
function containsAmountFields(obj: any): boolean {
  if (!obj || typeof obj !== "object") return false;
  const amountFields = ["total_paise", "amount", "amount_paise", "price", "price_paise", "total"];
  for (const key of Object.keys(obj)) {
    if (amountFields.includes(key.toLowerCase())) return true;
    if (typeof obj[key] === "object" && containsAmountFields(obj[key])) return true;
  }
  return false;
}
async function computeCartTotal(items: { id: string; qty: number }[]): Promise<number> {
  let total = 0;
  for (const item of items) {
    const { rows } = await query("SELECT price_paise FROM products WHERE id = $1 AND active = true", [item.id]);
    if (rows[0]) total += Number(rows[0].price_paise) * item.qty;
  }
  return total;
}

// POST /api/track/cart (X-Site-Key): anonymous cart
trackRouter.post("/api/track/cart", async (req: Request, res: Response) => {
  const trackKey = req.headers["x-track-key"] as string;
  if (!trackKey) { res.status(401).json({ error: "Missing track key" }); return; }
  const keyInfo = await verifyTrackKey(trackKey);
  if (!keyInfo.valid || keyInfo.keyType !== "public_site") { res.status(401).json({ error: "Invalid track key" }); return; }
  if (containsContactFields(req.body)) { res.status(422).json({ error: "Contact fields rejected on public route" }); return; }
  if (containsAmountFields(req.body)) { res.status(422).json({ error: "Amount fields rejected; server computes totals" }); return; }
  const { cart_id, items } = req.body;
  if (!cart_id || !items) { res.status(400).json({ error: "cart_id and items required" }); return; }
  try {
    const totalPaise = await computeCartTotal(items);
    await query(
      `INSERT INTO carts (id, merchant_id, customer_id, total_paise, status, updated_at)
       VALUES ($1, $2, NULL, $3, 'active', NOW())
       ON CONFLICT (id) DO UPDATE SET total_paise = $3, updated_at = NOW(),
       status = CASE WHEN carts.status = 'abandoned' THEN 'active' ELSE carts.status END`,
      [cart_id, keyInfo.merchantId || MERCHANT_ID, totalPaise]
    );
    // Remote schema: line items live in cart_items (no items_json on carts)
    await query("DELETE FROM cart_items WHERE cart_id = $1", [cart_id]);
    for (const item of items) {
      const { rows: prod } = await query("SELECT price_paise FROM products WHERE id = $1", [item.id]);
      if (!prod[0]) continue;
      await query(
        `INSERT INTO cart_items (cart_id, product_id, qty, unit_price_paise)
         VALUES ($1, $2, $3, $4)`,
        [cart_id, item.id, item.qty || 1, Number(prod[0].price_paise)]
      );
    }
    res.json({ success: true, total_paise: totalPaise });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /api/track/bind-customer (X-Server-Key, secret)
trackRouter.post("/api/track/bind-customer", async (req: Request, res: Response) => {
  const serverKey = req.headers["x-server-key"] as string;
  if (!serverKey) { res.status(401).json({ error: "Missing server key" }); return; }
  const keyInfo = await verifyTrackKey(serverKey);
  if (!keyInfo.valid || keyInfo.keyType !== "secret_server") { res.status(401).json({ error: "Invalid server key" }); return; }
  const { cart_id, email, name, phone } = req.body;
  if (!cart_id || (!email && !phone)) { res.status(400).json({ error: "cart_id and email or phone required" }); return; }
  try {
    const merchantId = keyInfo.merchantId || MERCHANT_ID;
    const { customerId, identityToken, isNew } = await findOrCreateCustomer(merchantId, { email, name, phone });
    await query("UPDATE carts SET customer_id = $1 WHERE id = $2", [customerId, cart_id]);
    // Record consent event (remote shape: class / evidence_ref)
    // M29: carries text_version, channel, ip_hash, ua_hash.
    if (email || phone) {
      const { recordConsentEvidence } = await import("../lib/v5privacy.js");
      await recordConsentEvidence(query, {
        merchantId, customerId, klass: "transactional", optIn: true,
        source: "merchant_server", evidenceRef: `bind:${cart_id}`,
        channel: "server_api", ip: req.ip || "", ua: String(req.headers["user-agent"] || ""),
      });
    }
    log.debug({ cart_id, customerId, isNew }, "Customer bound to cart");
    res.json({ success: true, customerId, identityToken, isNew });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /api/track/consent
trackRouter.post("/api/track/consent", async (req: Request, res: Response) => {
  const { customer_id, consent_type, opt_in, source, evidence_reference } = req.body;
  if (!customer_id || !consent_type) { res.status(400).json({ error: "customer_id and consent_type required" }); return; }
  try {
    // M29: evidence fields on every consent event.
    const { recordConsentEvidence, revokeConsent } = await import("../lib/v5privacy.js");
    const optIn = opt_in !== false;
    const evidence = {
      merchantId: MERCHANT_ID, customerId: customer_id, klass: consent_type,
      source: source || "api", evidenceRef: evidence_reference || null,
      channel: "web", ip: req.ip || "", ua: String(req.headers["user-agent"] || ""),
    };
    if (!optIn) {
      // M29 REVOCATION SLA: opt-out records + cancels pending/deferred intents
      // synchronously (within one dispatch cycle); scheduler sweep is the backstop.
      const { intentsCancelled } = await revokeConsent(query, evidence);
      log.info({ customer_id, intentsCancelled }, "Revocation applied (SLA: in-request)");
    } else {
      await recordConsentEvidence(query, { ...evidence, optIn });
    }
    // Update customer consent flags
    if (consent_type === "marketing") {
      await query(
        `UPDATE customers SET consent_marketing = jsonb_build_object('opt_in', $2, 'source', $3, 'consented_at', NOW()::text) WHERE id = $1`,
        [customer_id, opt_in !== false, source || "api"]
      );
    } else if (consent_type === "transactional") {
      await query(
        `UPDATE customers SET consent_transactional = jsonb_build_object('anchor_cart_ids', '[]'::jsonb, 'latest_anchor_at', NOW()::text, 'expires_at', (NOW() + INTERVAL '7 days')::text) WHERE id = $1`,
        [customer_id]
      );
    }
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /api/track/checkout-start
trackRouter.post("/api/track/checkout-start", async (req: Request, res: Response) => {
  const { cart_id } = req.body;
  if (!cart_id) { res.status(400).json({ error: "cart_id required" }); return; }
  try {
    await query(
      `INSERT INTO carts (id, merchant_id, total_paise, status, updated_at)
       VALUES ($1, $2, 0, 'active', NOW())
       ON CONFLICT (id) DO UPDATE SET updated_at = NOW(),
         checkout_started_at = COALESCE(carts.checkout_started_at, NOW())`,
      [cart_id, MERCHANT_ID]
    );
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /api/track/convert (suppresses recovery)
trackRouter.post("/api/track/convert", async (req: Request, res: Response) => {
  const { cart_id } = req.body;
  if (!cart_id) { res.status(400).json({ error: "cart_id required" }); return; }
  try {
    await query("UPDATE carts SET status = 'converted' WHERE id = $1", [cart_id]);
    // Cancel any live payment links for this cart
    await query("UPDATE payment_links SET status = 'cancelled' WHERE cart_id = $1 AND status = 'live'", [cart_id]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});
