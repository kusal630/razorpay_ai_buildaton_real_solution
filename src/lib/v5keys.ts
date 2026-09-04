import crypto from "node:crypto";

function appSecret(): string {
  return process.env.APP_SECRET || "sellable-app-secret-v1";
}

export type KeyPurpose = "identity" | "holdout" | "mandate" | "extref";

/**
 * M1 — key(purpose) = HKDF-SHA256(APP_SECRET, "sellable:" + purpose).
 * Uses Node's RFC5869 hkdfSync: salt = purpose label, info = label + ":v1".
 */
export function deriveKey(purpose: KeyPurpose): Buffer {
  const label = "sellable:" + purpose;
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(appSecret(), "utf8"), Buffer.from(label, "utf8"), Buffer.from(label + ":v1", "utf8"), 32));
}

export function hmacWith(purpose: KeyPurpose, data: string): string {
  return crypto.createHmac("sha256", deriveKey(purpose)).update(data, "utf8").digest("hex");
}

/** Legacy HMAC with raw APP_SECRET (transition dual-verify only). */
export function hmacLegacy(data: string): string {
  return crypto.createHmac("sha256", appSecret()).update(data, "utf8").digest("hex");
}

/** New identity hashes carry a "v2:" prefix; legacy rows have none. */
export function identityTokenV2(normalized: string): string {
  return "v2:" + hmacWith("identity", normalized);
}
export function identityTokenLegacy(normalized: string): string {
  return hmacLegacy(normalized);
}

/** Dual-verify: accept v2 or legacy (M1 transition). Returns matched form or null. */
export function matchIdentityHash(stored: string, normalized: string): "v2" | "legacy" | null {
  if (stored === identityTokenV2(normalized)) return "v2";
  if (stored === identityTokenLegacy(normalized)) return "legacy";
  return null;
}

/** Mandate signatures (mandate key, "v2:" prefix). Do NOT verify under extref key. */
export function signMandate(canonical: string): string {
  return "v2:" + hmacWith("mandate", canonical);
}
export function verifyMandate(canonical: string, sig: string): boolean {
  if (!sig.startsWith("v2:")) return false;
  const expected = signMandate(canonical);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Ext-refs (extref key, "v2:" prefix). generateExtRef keeps the 40-char opaque shape. */
export function signExtRef(seq: number): string {
  return "v2:" + hmacWith("extref", String(seq));
}

/** Opaque 40-char reference_id for Razorpay (derived from extref key, not raw secret). */
export function opaqueExtRef(seq: number): string {
  return crypto.createHmac("sha256", deriveKey("extref")).update(String(seq), "utf8").digest("base64url").slice(0, 40);
}

/** Holdout bucketing (holdout key — distinct from identity key by construction). */
export function holdoutBucket(identityHash: string, experimentId: string): number {
  const h = hmacWith("holdout", `${experimentId}:${identityHash}`);
  return parseInt(h.slice(0, 8), 16) / 0xffffffff;
}
