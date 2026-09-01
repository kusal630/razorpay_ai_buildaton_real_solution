import crypto from "node:crypto";
import { query } from "../db.js";
import { createLogger } from "../logger.js";

const log = createLogger("payToken");

/**
 * H3: Generate a 128-bit unguessable pay token.
 */
export function generatePayToken(): string {
  return crypto.randomBytes(16).toString("hex"); // 32 hex chars = 128 bits
}

/**
 * H3: Create a pay token mapping to audit_seq.
 * TTL = link expiry (default 15 minutes).
 */
export async function createPayToken(params: {
  auditSeq: number;
  merchantId: string;
  customerId?: string;
  amountPaise: number;
  maskedPii: Record<string, unknown>;
  ttlMinutes?: number;
}): Promise<string> {
  const token = generatePayToken();
  const ttl = params.ttlMinutes || 15;
  const expiresAt = new Date(Date.now() + ttl * 60 * 1000);

  await query(
    `INSERT INTO pay_tokens (token, audit_seq, merchant_id, customer_id, amount_paise, masked_pii, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      token,
      params.auditSeq,
      params.merchantId,
      params.customerId,
      params.amountPaise,
      JSON.stringify(params.maskedPii),
      expiresAt,
    ]
  );

  log.debug({ token: token.slice(0, 8), auditSeq: params.auditSeq }, "Pay token created");
  return token;
}

/**
 * H3: Resolve a pay token to audit_seq.
 * Returns null if token is invalid or expired.
 */
export async function resolvePayToken(token: string): Promise<{
  auditSeq: number;
  merchantId: string;
  customerId?: string;
  amountPaise: number;
  maskedPii: Record<string, unknown>;
} | null> {
  const { rows } = await query(
    `SELECT audit_seq, merchant_id, customer_id, amount_paise, masked_pii
     FROM pay_tokens
     WHERE token = $1 AND expires_at > NOW()`,
    [token]
  );

  if (!rows[0]) return null;

  // Check rate limit
  const { rows: rateRows } = await query(
    "SELECT access_count FROM pay_token_rate_limits WHERE token = $1 AND day = CURRENT_DATE",
    [token]
  );

  if (rateRows[0] && rateRows[0].access_count >= 10) {
    log.warn({ token: token.slice(0, 8) }, "Pay token rate limit exceeded");
    return null;
  }

  // Increment rate limit
  await query(
    `INSERT INTO pay_token_rate_limits (token, day, access_count)
     VALUES ($1, CURRENT_DATE, 1)
     ON CONFLICT (token, day) DO UPDATE SET access_count = pay_token_rate_limits.access_count + 1`,
    [token]
  );

  return {
    auditSeq: rows[0].audit_seq,
    merchantId: rows[0].merchant_id,
    customerId: rows[0].customer_id,
    amountPaise: rows[0].amount_paise,
    maskedPii: rows[0].masked_pii,
  };
}

/**
 * H3: Check if a token is valid (not expired).
 */
export async function isPayTokenValid(token: string): Promise<boolean> {
  const { rows } = await query(
    "SELECT 1 FROM pay_tokens WHERE token = $1 AND expires_at > NOW()",
    [token]
  );
  return rows.length > 0;
}
