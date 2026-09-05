import crypto from "node:crypto";
import { query, withTransaction } from "../db.js";
import { appendLedger } from "./ledger.js";
import { redactForPersist } from "./redact.js";
import { createLogger } from "../logger.js";

const log = createLogger("intentExecutor");

export interface IntentParams {
  merchantId: string;
  customerId: string | null;
  identityToken?: string;
  actionType: string;
  targetId: string; // cart_id | order_id | trigger_event_id
  targetType?: string; // 'cart' | 'order' | 'trigger' — defaults to 'cart'
  marginPaise?: number;
  windowDay?: string; // YYYY-MM-DD, defaults to today (IST)
}

export interface IntentResult {
  intentId: string;
  isNew: boolean;
  auditSeq?: number;
}

/**
 * W2: Compute business window day in IST (YYYY-MM-DD).
 * Remote schema stores window_day as TEXT.
 */
function getBusinessDayIST(windowDay?: string): string {
  if (windowDay) return windowDay;
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  return new Date(now.getTime() + istOffset).toISOString().slice(0, 10);
}

/**
 * W2: Generate dedupe key with identity token and target_id.
 * Format: {merchant}:{identity_token}:{target_id}:{action_type}:{business_day_IST}
 */
export function generateDedupeKey(params: IntentParams, businessDay: string): string {
  return [
    params.merchantId,
    params.identityToken || params.customerId || "anon",
    params.targetId,
    params.actionType,
    businessDay,
  ].join(":");
}

const MAX_ATTEMPTS = 3;

/**
 * W2: Create a write-ahead intent with lease-based state machine.
 * Remote shape: (id uuid, merchant_id, customer_id, target_type, target_id,
 * action_type, window_day text, dedupe_key unique, status, attempt_count,
 * resume_at, lease_expires_at, created_at).
 * Returns { isNew: true } if the intent was created,
 * { isNew: false } if a duplicate was detected (action should be skipped).
 */
export async function createIntent(params: IntentParams): Promise<IntentResult> {
  const businessDay = getBusinessDayIST(params.windowDay);
  const dedupeKey = generateDedupeKey(params, businessDay);
  const intentId = crypto.randomUUID();

  const result = await withTransaction(async (client) => {
    // Attempt to insert intent (dedupe_key UNIQUE handles idempotency)
    const { rows } = await client.query(
      `INSERT INTO action_intents (
         id, merchant_id, customer_id, target_type, target_id,
         action_type, window_day, dedupe_key, status, attempt_count
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 0)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [
        intentId,
        params.merchantId,
        params.customerId,
        params.targetType || "cart",
        params.targetId,
        params.actionType,
        businessDay,
        dedupeKey,
      ]
    );

    if (rows.length === 0) {
      // Duplicate detected — ledger it (serialized append) and skip
      const { seq } = await appendLedger({
        merchantId: params.merchantId,
        actor: params.actionType.includes("recovery") ? "RecoveryBot" : "UpsellBot",
        action: "skip_duplicate_intent",
        params: redactForPersist({ dedupeKey, customerId: params.customerId }) as Record<string, unknown>,
        decision: "BLOCK",
        policy_checks: { dedupe: "CONFLICT" },
        rationale: { reason: "duplicate_intent", dedupeKey },
        outcome: "SKIPPED",
      });

      log.debug({ dedupeKey }, "Duplicate intent detected, skipped");
      return { intentId: "", isNew: false, auditSeq: seq };
    }

    // Mark as executing with lease
    const leaseExpires = new Date(Date.now() + 5 * 60 * 1000); // 5 min lease
    await client.query(
      `UPDATE action_intents SET status = 'executing', lease_expires_at = $1 WHERE id = $2`,
      [leaseExpires, rows[0].id]
    );

    return { intentId: rows[0].id, isNew: true };
  });

  return result;
}

/**
 * W2: Mark intent as awaiting_gateway after Razorpay call dispatched.
 */
export async function markAwaitingGateway(intentId: string): Promise<void> {
  await query(
    "UPDATE action_intents SET status = 'awaiting_gateway', lease_expires_at = NULL WHERE id = $1",
    [intentId]
  );
  log.debug({ intentId }, "Intent awaiting gateway");
}

/**
 * Mark an intent as done after successful execution.
 */
export async function completeIntent(intentId: string): Promise<void> {
  await query("UPDATE action_intents SET status = 'done', lease_expires_at = NULL WHERE id = $1", [
    intentId,
  ]);
  log.debug({ intentId }, "Intent completed");
}

/**
 * W2: Mark intent as failed with retry logic (max attempts = 3, constant).
 */
export async function failIntent(
  intentId: string,
  status: "pending" | "skipped" | "failed" = "pending"
): Promise<void> {
  if (!intentId) return;
  if (status === "failed") {
    // Increment attempt count; dead-letter at MAX_ATTEMPTS
    const { rows } = await query(
      "UPDATE action_intents SET attempt_count = attempt_count + 1, lease_expires_at = NULL WHERE id = $1 RETURNING attempt_count",
      [intentId]
    );

    if (rows[0] && Number(rows[0].attempt_count) >= MAX_ATTEMPTS) {
      await query("UPDATE action_intents SET status = 'failed' WHERE id = $1", [intentId]);
      log.warn({ intentId }, "Intent failed: max attempts exceeded");
      return;
    }

    await query("UPDATE action_intents SET status = 'pending' WHERE id = $1", [intentId]);
  } else {
    await query("UPDATE action_intents SET status = $1, lease_expires_at = NULL WHERE id = $2", [
      status,
      intentId,
    ]);
  }

  log.debug({ intentId, status }, "Intent failed");
}

/**
 * W2: Defer an intent (e.g., quiet hours).
 */
export async function deferIntent(intentId: string, resumeAt: Date): Promise<void> {
  await query(
    "UPDATE action_intents SET status = 'deferred', resume_at = $1, lease_expires_at = NULL WHERE id = $2",
    [resumeAt, intentId]
  );
  log.debug({ intentId, resumeAt }, "Intent deferred");
}

/**
 * W2: Expire an intent.
 */
export async function expireIntent(intentId: string): Promise<void> {
  await query("UPDATE action_intents SET status = 'expired' WHERE id = $1", [intentId]);
  log.debug({ intentId }, "Intent expired");
}

/**
 * W2: Janitor - handle intent lifecycle states on the remote shape.
 * - Deferred with resume_at due → pending
 * - Stale awaiting_gateway (>90s) → pending (dedupe_key guard prevents double-links)
 * - Old pending/deferred past their window_day → expired
 */
export async function runJanitor(): Promise<number> {
  let resolved = 0;

  // 1. Dispatch deferred intents with resume_at due. T3: suspended
  // merchants' intents stay deferred (held with reason, not cancelled).
  let deferred: any[];
  try {
    ({ rows: deferred } = await query(
      `UPDATE action_intents SET status = 'pending'
       WHERE status = 'deferred' AND resume_at <= NOW()
       AND merchant_id NOT IN (
         SELECT merchant_id FROM merchant_config
         WHERE key = 'recovery_suspended'
         AND (value_jsonb->>'suspended')::boolean IS TRUE
       )
       RETURNING id`
    ));
  } catch {
    // Pre-T3 schema without merchant_config: resume as before.
    ({ rows: deferred } = await query(
      `UPDATE action_intents SET status = 'pending'
       WHERE status = 'deferred' AND resume_at <= NOW()
       RETURNING id`
    ));
  }
  resolved += deferred.length;

  // 2. Reset stale awaiting_gateway intents (>90s, lease presumably lost)
  const { rows: staleGateway } = await query(
    `UPDATE action_intents SET status = 'pending', lease_expires_at = NULL
     WHERE status = 'awaiting_gateway' AND created_at < NOW() - INTERVAL '90 seconds'
     RETURNING id`
  );
  resolved += staleGateway.length;

  // 3. Expire intents past their business window
  const { rows: expired } = await query(
    `UPDATE action_intents SET status = 'expired'
     WHERE status IN ('pending', 'deferred')
     AND window_day < TO_CHAR(NOW() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')
     RETURNING id`
  );
  resolved += expired.length;

  if (resolved > 0) log.info({ resolved }, "Janitor run complete");
  return resolved;
}
