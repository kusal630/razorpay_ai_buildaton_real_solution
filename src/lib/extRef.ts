import crypto from "node:crypto";
import { query } from "../db.js";
import { createLogger } from "../logger.js";

const log = createLogger("extRef");

// C3: External reference secret (loaded from env)
const EXT_REF_SECRET = process.env.EXT_REF_SECRET || crypto.randomBytes(32).toString("hex");

/**
 * C3: Generate opaque external reference from audit_seq.
 * Uses HMAC-SHA256 for one-way mapping.
 * Sequential audit_seq never leaves internal surfaces.
 */
export function generateExtRef(auditSeq: number): string {
  const hmac = crypto.createHmac("sha256", EXT_REF_SECRET);
  hmac.update(String(auditSeq));
  return hmac.digest("hex").slice(0, 16); // 64-bit truncated
}

/**
 * C3: Map external reference back to audit_seq.
 * Used for reconciliation matching.
 */
export async function resolveExtRef(extRef: string): Promise<number | null> {
  const { rows } = await query(
    "SELECT audit_seq FROM ext_ref_map WHERE ext_ref = $1",
    [extRef]
  );
  return rows[0]?.audit_seq ?? null;
}

/**
 * C3: Register external reference mapping.
 * Called when creating payment links, receipts, etc.
 */
export async function registerExtRef(
  auditSeq: number,
  context: string
): Promise<string> {
  const extRef = generateExtRef(auditSeq);

  await query(
    `INSERT INTO ext_ref_map (ext_ref, audit_seq, context)
     VALUES ($1, $2, $3)
     ON CONFLICT (audit_seq) DO UPDATE SET ext_ref = $1`,
    [extRef, auditSeq, context]
  );

  log.debug({ extRef: extRef.slice(0, 8), auditSeq, context }, "External reference registered");
  return extRef;
}

/**
 * C3: Check if an external reference is valid.
 */
export async function isValidExtRef(extRef: string): Promise<boolean> {
  const { rows } = await query(
    "SELECT 1 FROM ext_ref_map WHERE ext_ref = $1",
    [extRef]
  );
  return rows.length > 0;
}
