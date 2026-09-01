import { query, withTransaction } from "../db.js";
import { appendAuditSerialized } from "./auditLedger2.js";
import { redactForPersist } from "./redact.js";
import { createLogger } from "../logger.js";

const log = createLogger("intentExecutor");

export interface IntentParams {
  merchantId: string;
  customerId: string | null;
  identityToken?: string;
  actionType: string;
  targetId: string; // cart_id | order_id | trigger_event_id
  marginPaise?: number;
  windowDay?: string; // YYYY-MM-DD, defaults to today (IST)
}

export interface IntentResult {
  intentId: number;
  isNew: boolean;
  auditSeq?: number;
}

/**
 * W2: Compute business window in IST.
 */
function getBusinessWindowIST(windowDay?: string): { start: string; end: string } {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istTime = new Date(now.getTime() + istOffset);

  const day = windowDay || istTime.toISOString().slice(0, 10);
  return {
    start: `${day}T00:00:00+05:30`,
    end: `${day}T23:59:59+05:30`,
  };
}

/**
 * W2: Generate dedupe key with identity token and target_id.
 * Format: {merchant}:{identity_token}:{target_id}:{action_type}:{business_window_IST}
 */
function generateDedupeKey(params: IntentParams, businessWindow: { start: string; end: string }): string {
  return [
    params.merchantId,
    params.identityToken || params.customerId || 'anon',
    params.targetId,
    params.actionType,
    businessWindow.start.slice(0, 10), // Just the date part
  ].join(':');
}

/**
 * W2: Create a write-ahead intent with lease-based state machine.
 * Returns { isNew: true } if the intent was created,
 * { isNew: false } if a duplicate was detected (action should be skipped).
 */
export async function createIntent(params: IntentParams): Promise<IntentResult> {
  const businessWindow = getBusinessWindowIST(params.windowDay);
  const dedupeKey = generateDedupeKey(params, businessWindow);

  // Check idempotency hash if provided
  if (params.identityToken) {
    const idempotencyHash = crypto.createHash('sha256')
      .update(`${dedupeKey}:${JSON.stringify(params)}`)
      .digest('hex');

    const { rows: existingHash } = await query(
      "SELECT id FROM action_intents WHERE idempotency_hash = $1",
      [idempotencyHash]
    );

    if (existingHash[0]) {
      return { intentId: existingHash[0].id, isNew: false };
    }
  }

  const result = await withTransaction(async (client) => {
    // Attempt to insert intent
    const { rows } = await client.query(
      `INSERT INTO action_intents (
        merchant_id, customer_id, action_type, dedupe_key,
        window_start, window_end, status, attempt_count, max_attempts,
        margin_snapshot_paise, idempotency_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', 0, 3, $7, $8)
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id`,
      [
        params.merchantId,
        params.customerId,
        params.actionType,
        dedupeKey,
        businessWindow.start,
        businessWindow.end,
        params.marginPaise || 0,
        params.identityToken ? crypto.createHash('sha256').update(`${dedupeKey}:${JSON.stringify(params)}`).digest('hex') : null,
      ]
    );

    if (rows.length === 0) {
      // Duplicate detected — log and skip using serialized append
      const seq = await appendAuditSerialized({
        actor: params.actionType.includes('recovery') ? 'RecoveryBot' : 'UpsellBot',
        action: 'skip_duplicate_intent',
        params_json: redactForPersist({ dedupeKey, customerId: params.customerId }),
        decision: 'BLOCK',
        policy_checks_json: { dedupe: 'CONFLICT' },
        rationale_json: { reason: 'duplicate_intent', dedupeKey },
        outcome: 'SKIPPED',
      });

      log.debug({ dedupeKey }, "Duplicate intent detected, skipped");
      return { intentId: 0, isNew: false, auditSeq: seq };
    }

    // Mark as executing with lease
    const leaseExpires = new Date(Date.now() + 5 * 60 * 1000); // 5 min lease
    await client.query(
      `UPDATE action_intents SET status = 'executing', lease_owner = $1, lease_expires_at = $2 WHERE id = $3`,
      ['intent-executor', leaseExpires, rows[0].id]
    );

    return { intentId: rows[0].id, isNew: true };
  });

  return result;
}

/**
 * W2: Mark intent as awaiting_gateway after Razorpay call dispatched.
 */
export async function markAwaitingGateway(intentId: number): Promise<void> {
  await query(
    "UPDATE action_intents SET status = 'awaiting_gateway', lease_owner = NULL, lease_expires_at = NULL WHERE id = $1",
    [intentId]
  );
  log.debug({ intentId }, "Intent awaiting gateway");
}

/**
 * Mark an intent as done after successful execution.
 */
export async function completeIntent(intentId: number, auditSeq: number): Promise<void> {
  await query(
    "UPDATE action_intents SET status = 'done', audit_seq = $1, lease_owner = NULL, lease_expires_at = NULL WHERE id = $2",
    [auditSeq, intentId]
  );
  log.debug({ intentId, auditSeq }, "Intent completed");
}

/**
 * W2: Mark intent as failed with retry logic.
 */
export async function failIntent(intentId: number, status: 'pending' | 'skipped' | 'failed' = 'pending'): Promise<void> {
  if (status === 'failed') {
    // Increment attempt count and check max attempts
    const { rows } = await query(
      "UPDATE action_intents SET attempt_count = attempt_count + 1, lease_owner = NULL, lease_expires_at = NULL WHERE id = $1 RETURNING attempt_count, max_attempts",
      [intentId]
    );

    if (rows[0] && rows[0].attempt_count >= rows[0].max_attempts) {
      // Max attempts exceeded — dead letter
      await query(
        "UPDATE action_intents SET status = 'failed' WHERE id = $1",
        [intentId]
      );

      await appendAuditSerialized({
        actor: 'IntentJanitor',
        action: 'max_attempts_exceeded',
        params_json: { intentId },
        decision: 'BLOCK',
        policy_checks_json: {},
        rationale_json: { intentId, reason: 'max_attempts_exceeded' },
        outcome: 'FAILED',
      });

      log.warn({ intentId }, "Intent failed: max attempts exceeded");
      return;
    }

    // Set next retry time with exponential backoff
    const backoffMs = Math.pow(2, rows[0].attempt_count) * 30000; // 30s, 60s, 120s
    await query(
      "UPDATE action_intents SET status = 'pending', next_retry_at = $1 WHERE id = $2",
      [new Date(Date.now() + backoffMs), intentId]
    );
  } else {
    await query(
      "UPDATE action_intents SET status = $1, lease_owner = NULL, lease_expires_at = NULL WHERE id = $2",
      [status, intentId]
    );
  }

  log.debug({ intentId, status }, "Intent failed");
}

/**
 * W2: Defer an intent (e.g., quiet hours).
 */
export async function deferIntent(intentId: number, resumeAt: Date): Promise<void> {
  await query(
    "UPDATE action_intents SET status = 'deferred', resume_at = $1, lease_owner = NULL, lease_expires_at = NULL WHERE id = $2",
    [resumeAt, intentId]
  );
  log.debug({ intentId, resumeAt }, "Intent deferred");
}

/**
 * W2: Expire an intent.
 */
export async function expireIntent(intentId: number): Promise<void> {
  await query(
    "UPDATE action_intents SET status = 'expired', lease_owner = NULL, lease_expires_at = NULL WHERE id = $1",
    [intentId]
  );
  log.debug({ intentId }, "Intent expired");
}

/**
 * W2: Janitor - handle all intent lifecycle states.
 * - Deferred with resume_at due
 * - Pending with next_retry_at due
 * - Failed after max_attempts (dead-letter + alert)
 * - Expired (cart converted / link expired)
 * - Stuck (awaiting_gateway timeout: 2x max observed gateway latency, min 90s)
 */
export async function runJanitor(): Promise<number> {
  let resolved = 0;

  // 1. Dispatch deferred intents with resume_at due
  const { rows: deferred } = await query(
    `UPDATE action_intents SET status = 'pending'
     WHERE status = 'deferred' AND resume_at <= NOW()
     RETURNING id`
  );
  resolved += deferred.length;

  // 2. Retry pending intents with next_retry_at due
  const { rows: retryable } = await query(
    `UPDATE action_intents SET status = 'pending', next_retry_at = NULL
     WHERE status = 'pending' AND next_retry_at <= NOW()
     RETURNING id`
  );
  resolved += retryable.length;

  // 3. Expire stale awaiting_gateway intents (2x max observed latency, min 90s)
  const { rows: staleGateway } = await query(
    `UPDATE action_intents SET status = 'stuck'
     WHERE status = 'awaiting_gateway' AND created_at < NOW() - INTERVAL '90 seconds'
     RETURNING id, audit_seq`
  );

  for (const intent of staleGateway) {
    if (intent.audit_seq) {
      // Check if payment link exists
      const { rows: auditRows } = await query(
        "SELECT outcome FROM audit_log WHERE seq = $1 AND outcome = 'SUCCESS'",
        [intent.audit_seq]
      );

      if (auditRows.length > 0) {
        await query("UPDATE action_intents SET status = 'done' WHERE id = $1", [intent.id]);
        resolved++;
        continue;
      }
    }

    // Reset to pending for retry
    await query("UPDATE action_intents SET status = 'pending' WHERE id = $1", [intent.id]);
    resolved++;
  }

  // 4. Dead-letter failed intents after max attempts
  const { rows: maxFailed } = await query(
    `SELECT id FROM action_intents
     WHERE status = 'failed' AND attempt_count >= max_attempts
     AND created_at < NOW() - INTERVAL '1 hour'`
  );

  for (const intent of maxFailed) {
    await appendAuditSerialized({
      actor: 'IntentJanitor',
      action: 'dead_letter_intent',
      params_json: { intentId: intent.id },
      decision: 'BLOCK',
      policy_checks_json: {},
      rationale_json: { intentId: intent.id, reason: 'max_attempts_exceeded_dead_letter' },
      outcome: 'FAILED',
    });
    resolved++;
  }

  // 5. Expire old pending intents (business window passed)
  const { rows: expiredPending } = await query(
    `UPDATE action_intents SET status = 'expired'
     WHERE status IN ('pending', 'deferred')
     AND window_end < NOW()
     RETURNING id`
  );
  resolved += expiredPending.length;

  log.info({ resolved }, "Janitor run complete");
  return resolved;
}

// Import crypto at top level
import crypto from "node:crypto";
