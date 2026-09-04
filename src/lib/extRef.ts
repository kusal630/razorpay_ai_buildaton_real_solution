import crypto from "node:crypto";
import { query } from "../db.js";
import { opaqueExtRef } from "./v5keys.js";

/**
 * C3: Generate an opaque external reference for a ledger seq.
 * ext_ref = base64url(HMAC(extref-key, seq)) — M1: derived key, never raw APP_SECRET.
 * Is one-way, salted, and stable per seq.
 */
export function generateExtRef(seq: number): string {
  return opaqueExtRef(seq);
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