import crypto from "node:crypto";
import { getConfig } from "../config.js";
import { query } from "../db.js";

/**
 * C3: Generate an opaque external reference for a ledger seq.
 * ext_ref = base64url(HMAC(APP_SECRET, seq)). Never the raw seq.
 * Is one-way, salted, and stable per seq.
 */
export function generateExtRef(seq: number): string {
  const mac = crypto.createHmac("sha256", getConfig().APP_SECRET)
    .update(String(seq))
    .digest("base64url");
  return mac.slice(0, 40); // Razorpay reference_id max 40 chars
}

export function generateToken(bytes = 16): string {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * Persist the mapping so the reconciler can match ledger <-> Razorpay by ext_ref.
 */
export async function storeExtRef(extRef: string, auditSeq: number, context: Record<string, unknown>): Promise<void> {
  await query(
    `INSERT INTO ext_ref_map (ext_ref, audit_seq, context, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (ext_ref) DO UPDATE SET audit_seq = EXCLUDED.audit_seq, context = EXCLUDED.context`,
    [extRef, auditSeq, JSON.stringify(context)]
  );
}

export async function lookupExtRef(extRef: string): Promise<any | null> {
  const { rows } = await query("SELECT * FROM ext_ref_map WHERE ext_ref = $1", [extRef]);
  return rows[0] || null;
}