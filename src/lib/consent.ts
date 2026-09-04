import crypto from "node:crypto";
import { query } from "../db.js";
import { createLogger } from "../logger.js";

const log = createLogger("consent");

export interface TransactionalConsent {
  anchor_cart_ids: string[];
  latest_anchor_at: string | null;
  expires_at: string | null;
}

export interface MarketingConsent {
  opt_in: boolean;
  source: string | null;
  consented_at: string | null;
}

/**
 * Anchor transactional consent from server-side facts.
 * Called on checkout-start, order creation, payment attempted.
 * TTL: cart/order unresolved + 7 days.
 */
export async function anchorTransactional(
  customerId: string,
  cartId: string
): Promise<void> {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await query(
    `UPDATE customers SET
       consent_transactional = jsonb_build_object(
         'anchor_cart_ids', COALESCE(consent_transactional->'anchor_cart_ids', '[]'::jsonb) || $2::jsonb,
         'latest_anchor_at', NOW()::text,
         'expires_at', $3::text
       )
     WHERE id = $1`,
    [customerId, JSON.stringify([cartId]), expiresAt.toISOString()]
  );

  log.debug({ customerId, cartId }, "Transactional consent anchored");
}

/**
 * Check if transactional consent is valid (exists and not expired).
 * Required for: recovery, failure-retry, chat about pending offer.
 */
export async function checkTransactionalConsent(
  customerId: string
): Promise<boolean> {
  if (!customerId) return false;

  const { rows } = await query(
    "SELECT consent_transactional FROM customers WHERE id = $1",
    [customerId]
  );

  if (!rows[0]) return false;
  const ct = rows[0].consent_transactional;

  // Must have at least one anchor
  if (!ct.anchor_cart_ids || ct.anchor_cart_ids.length === 0) return false;

  // Must not be expired
  if (ct.expires_at) {
    const expiresAt = new Date(ct.expires_at);
    if (expiresAt < new Date()) return false;
  }

  return true;
}

/**
 * Check if marketing consent is valid.
 * Required for: upsell, cross-sell, any promotional touch.
 */
export async function checkMarketingConsent(
  customerId: string
): Promise<boolean> {
  if (!customerId) return false;

  const { rows } = await query(
    "SELECT consent_marketing FROM customers WHERE id = $1",
    [customerId]
  );

  if (!rows[0]) return false;
  const cm = rows[0].consent_marketing;

  return cm.opt_in === true;
}

/**
 * Record marketing consent (self-reported or explicit).
 */
export async function recordMarketingConsent(
  customerId: string,
  source: "self_reported" | "explicit",
  optedIn: boolean
): Promise<void> {
  await query(
    `UPDATE customers SET consent_marketing = jsonb_build_object(
       'opt_in', $2,
       'source', $3,
       'consented_at', NOW()::text
     ) WHERE id = $1`,
    [customerId, optedIn, source]
  );

  log.debug({ customerId, source, optedIn }, "Marketing consent recorded");
}

/**
 * Set public site key for a merchant.
 */
export async function setPublicSiteKey(
  merchantId: string,
  keyHash: string
): Promise<void> {
  await query(
    `INSERT INTO track_keys (merchant_id, key_type, key_hash)
     VALUES ($1, 'public_site', $2)
     ON CONFLICT (merchant_id, key_type) DO UPDATE SET key_hash = $2, rotated_at = NOW()`,
    [merchantId, keyHash]
  );
}

/**
 * Set secret server key for a merchant.
 */
export async function setSecretServerKey(
  merchantId: string,
  keyHash: string
): Promise<void> {
  await query(
    `INSERT INTO track_keys (merchant_id, key_type, key_hash)
     VALUES ($1, 'secret_server', $2)
     ON CONFLICT (merchant_id, key_type) DO UPDATE SET key_hash = $2, rotated_at = NOW()`,
    [merchantId, keyHash]
  );
}

/**
 * Verify a tracking key and return its type and merchant.
 */
export async function verifyTrackKey(key: string): Promise<{
  valid: boolean;
  keyType?: "public_site" | "secret_server";
  merchantId?: string;
  keyId?: string;
}> {
  // Simple hash for demo - in production use bcrypt
  const keyHash = key;

  const { rows } = await query(
    `SELECT tk.id, tk.key_type, tk.merchant_id
     FROM track_keys tk
     WHERE tk.key_hash = $1 AND tk.active = true`,
    [keyHash]
  );

  if (!rows[0]) return { valid: false };

  // Check daily rate limit for public keys
  if (rows[0].key_type === "public_site") {
    const { rows: rateRows } = await query(
      "SELECT event_count FROM track_rate_limits WHERE key_id = $1 AND day = TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD')",
      [rows[0].id]
    );

    if (rateRows[0] && rateRows[0].event_count >= 5000) {
      log.warn({ keyId: rows[0].id }, "Track key rate limit exceeded");
      return { valid: false };
    }

    // Increment counter (day stored as TEXT 'YYYY-MM-DD' on this schema)
    await query(
      `INSERT INTO track_rate_limits (key_id, day, event_count)
       VALUES ($1, TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD'), 1)
       ON CONFLICT (key_id, day) DO UPDATE SET event_count = track_rate_limits.event_count + 1`,
      [rows[0].id]
    );
  }

  return {
    valid: true,
    keyType: rows[0].key_type,
    merchantId: rows[0].merchant_id,
    keyId: rows[0].id,
  };
}
