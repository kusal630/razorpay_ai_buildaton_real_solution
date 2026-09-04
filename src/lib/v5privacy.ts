/**
 * v5privacy.ts — M29: consent evidence + revocation SLA + erasure lite.
 * Query functions are injectable so gates run as pure unit tests.
 */
import crypto from "node:crypto";

export type QueryFn = (sql: string, params?: any[]) => Promise<{ rows: any[] }>;

export const CONSENT_TEXT_VERSION = "v1";

/** One-way hash for ip/ua evidence (never raw PII in consent rows). */
export function hashField(raw: string): string {
  return crypto.createHash("sha256").update(String(raw || ""), "utf8").digest("hex");
}

export interface ConsentEvidenceInput {
  merchantId: string;
  customerId: string;
  klass: string; // 'transactional' | 'marketing'
  optIn: boolean;
  source: string;
  evidenceRef?: string | null;
  textVersion?: string;
  channel?: string;
  ip?: string;
  ua?: string;
}

/** M29: consent events carry text_version, channel, ip_hash, ua_hash. */
export async function recordConsentEvidence(
  q: QueryFn,
  input: ConsentEvidenceInput
): Promise<{ textVersion: string; channel: string; ipHash: string; uaHash: string }> {
  const ev = {
    textVersion: input.textVersion || CONSENT_TEXT_VERSION,
    channel: input.channel || "web",
    ipHash: hashField(input.ip || ""),
    uaHash: hashField(input.ua || ""),
  };
  await q(
    `INSERT INTO consent_events (merchant_id, customer_id, class, opt_in, source, evidence_ref,
      text_version, channel, ip_hash, ua_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [input.merchantId, input.customerId, input.klass, input.optIn, input.source,
      input.evidenceRef || null, ev.textVersion, ev.channel, ev.ipHash, ev.uaHash]
  );
  return ev;
}

/**
 * M29 REVOCATION SLA: revoke → all pending/deferred intents for the identity
 * are cancelled. Called synchronously in the consent route (SLA met in-request,
 * i.e. well within one dispatch cycle) AND swept every scheduler cycle as a
 * crash backstop. Docs state: ≤ scheduler interval (15s) + jitter.
 */
export async function revokeConsent(
  q: QueryFn,
  params: {
    merchantId: string; customerId: string; klass?: string; source?: string;
    evidenceRef?: string; channel?: string; ip?: string; ua?: string;
  }
): Promise<{ events: number; intentsCancelled: number }> {
  await recordConsentEvidence(q, {
    merchantId: params.merchantId,
    customerId: params.customerId,
    klass: params.klass || "marketing",
    optIn: false,
    source: params.source || "api",
    evidenceRef: params.evidenceRef || "revoke",
    channel: params.channel,
    ip: params.ip,
    ua: params.ua,
  });
  const r = await q(
    `UPDATE action_intents SET status = 'cancelled', lease_expires_at = NULL
      WHERE merchant_id = $1 AND customer_id = $2 AND status IN ('pending', 'deferred')`,
    [params.merchantId, params.customerId]
  );
  return { events: 1, intentsCancelled: (r as any).rowCount ?? 0 };
}

/**
 * M29 ERASURE LITE: contact_enc NULLed; pseudonymous tombstone ledger row;
 * chain verify still passes (tombstone links prev_hash); identity caps persist
 * via untouched identity_hash; consent rows retained (no DELETE ever issued).
 * Full crypto-shredding (per-identity DEKs) remains the production roadmap.
 */
export interface EraseDeps {
  q: QueryFn;
  ledgerAppend: (entry: {
    merchantId: string; actor: string; action: string; params: Record<string, any>;
    decision: string; policy_checks: Record<string, any>; rationale: Record<string, any>;
    outcome: string; outcome_detail?: Record<string, any>;
  }) => Promise<{ seq: number }>;
}

export async function eraseCustomer(
  deps: EraseDeps,
  params: { merchantId: string; customerId: string }
): Promise<{ seq: number; nulled: boolean }> {
  // (1) NULL the encrypted contact — identity_hash deliberately untouched.
  await deps.q(
    "UPDATE customers SET contact_enc = NULL WHERE id = $1 AND merchant_id = $2",
    [params.customerId, params.merchantId]
  );
  // (4) consent rows retained as pseudonymous records — read, never delete.
  const consent = await deps.q("SELECT id FROM consent_events WHERE customer_id = $1", [params.customerId]);
  // (2) tombstone ledger row: pseudonymous only (ids + hashes, never contact).
  const { seq } = await deps.ledgerAppend({
    merchantId: params.merchantId,
    actor: "PrivacyBot",
    action: "customer_erased",
    params: { customer_id: params.customerId },
    decision: "ALLOW",
    policy_checks: { erasure: "LITE" },
    rationale: {
      reason: "erasure-lite: contact NULLed, identity_hash retained for caps, consent records retained",
      consent_events_retained: consent.rows.length,
    },
    outcome: "SUCCESS",
    outcome_detail: { tombstone: true },
  });
  return { seq, nulled: true };
}
