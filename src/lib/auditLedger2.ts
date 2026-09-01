import { query } from "../db.js";
import crypto from "node:crypto";
import { createLogger } from "../logger.js";

const log = createLogger("auditLedger2");

// Advisory lock key for ledger serialization (constant, documented)
const LEDGER_LOCK_KEY = 7342901; // Arbitrary but fixed

interface HashableAuditRow {
  ts: string;
  actor: string;
  action: string;
  params_json: Record<string, unknown>;
  decision: string;
  policy_checks_json: Record<string, unknown>;
  rationale_json: Record<string, unknown>;
  outcome: string;
  outcome_detail_json: Record<string, unknown>;
  prev_hash: string;
}

function canonicalJson(row: HashableAuditRow): string {
  return JSON.stringify(row, Object.keys(row).sort());
}

function computeHash(prevHash: string, row: HashableAuditRow): string {
  const canonical = canonicalJson(row);
  return crypto.createHash("sha256").update(prevHash + canonical).digest("hex");
}

/**
 * Serialized append with pg_advisory_xact_lock.
 * Every append runs inside a transaction holding the lock,
 * re-reads prev_hash inside the lock, inserts, commits.
 * Conflicts retry (max 3) then dead-letter + alert.
 */
export async function appendAuditSerialized(params: {
  actor: string;
  action: string;
  params_json: Record<string, unknown>;
  decision: string;
  policy_checks_json: Record<string, unknown>;
  rationale_json: Record<string, unknown>;
  outcome?: string;
  outcome_detail_json?: Record<string, unknown>;
}): Promise<number> {
  const maxRetries = 3;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await withLedgerLock(async () => {
        // Re-read prev_hash inside the lock
        const { rows: prevRows } = await query(
          "SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1"
        );
        const prevHash = prevRows[0]?.hash || "";

        const row: HashableAuditRow = {
          ts: new Date().toISOString(),
          actor: params.actor,
          action: params.action,
          params_json: params.params_json,
          decision: params.decision,
          policy_checks_json: params.policy_checks_json,
          rationale_json: params.rationale_json,
          outcome: params.outcome || "PROPOSED",
          outcome_detail_json: params.outcome_detail_json || {},
          prev_hash: prevHash,
        };

        const hash = computeHash(prevHash, row);

        const { rows } = await query(
          `INSERT INTO audit_log (ts, actor, action, params_json, decision, policy_checks_json, rationale_json, outcome, outcome_detail_json, prev_hash, hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING seq`,
          [row.ts, row.actor, row.action, JSON.stringify(row.params_json), row.decision,
           JSON.stringify(row.policy_checks_json), JSON.stringify(row.rationale_json),
           row.outcome, JSON.stringify(row.outcome_detail_json), row.prev_hash, hash]
        );

        return rows[0].seq;
      });

      return result;
    } catch (err: any) {
      log.warn({ attempt, error: err.message }, "Ledger append conflict, retrying");

      if (attempt === maxRetries - 1) {
        // Dead letter + alert
        await deadLetterAlert({
          actor: params.actor,
          action: params.action,
          error: err.message,
          attempt,
        });
        throw new Error(`Ledger append failed after ${maxRetries} retries: ${err.message}`);
      }

      // Exponential backoff
      await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt)));
    }
  }

  throw new Error("Ledger append failed: unreachable");
}

/**
 * Execute function within pg_advisory_xact_lock.
 */
async function withLedgerLock<T>(fn: () => Promise<T>): Promise<T> {
  const client = await (await import("../db.js")).getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [LEDGER_LOCK_KEY]);
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Dead letter alert for ledger append failures.
 */
async function deadLetterAlert(info: {
  actor: string;
  action: string;
  error: string;
  attempt: number;
}): Promise<void> {
  log.error({ ...info }, "LEDGER_APPEND_FAILED - dead letter alert");

  // Store in dead_letters for later inspection
  await query(
    `INSERT INTO dead_letters (event_id, payload_json, error)
     VALUES ($1, $2, $3)`,
    [
      `ledger-failure-${Date.now()}`,
      JSON.stringify(info),
      `Ledger append failed after ${info.attempt + 1} retries: ${info.error}`,
    ]
  );
}

/**
 * Nightly verify chain job.
 * Returns true if chain is valid, false if broken.
 * Alerts on failure.
 */
export async function nightlyVerifyChain(): Promise<boolean> {
  const { rows } = await query("SELECT * FROM audit_log ORDER BY seq ASC");
  let prevHash = "";

  for (const r of rows) {
    const row = {
      ts: r.ts,
      actor: r.actor,
      action: r.action,
      params_json: r.params_json,
      decision: r.decision,
      policy_checks_json: r.policy_checks_json,
      rationale_json: r.rationale_json,
      outcome: r.outcome,
      outcome_detail_json: r.outcome_detail_json,
      prev_hash: r.prev_hash,
    };

    if (r.prev_hash !== prevHash) {
      log.error({ seq: r.seq, expected: prevHash, got: r.prev_hash }, "Chain broken at prev_hash");
      await alertChainBroken(r.seq);
      return false;
    }

    const expectedHash = computeHash(prevHash, row);
    if (r.hash !== expectedHash) {
      log.error({ seq: r.seq }, "Chain broken at hash");
      await alertChainBroken(r.seq);
      return false;
    }

    prevHash = r.hash;
  }

  log.info({ rows: rows.length }, "Chain verification passed");
  return true;
}

/**
 * Alert on chain break.
 */
async function alertChainBroken(atSeq: number): Promise<void> {
  const alertWebhook = process.env.ALERT_WEBHOOK_URL;
  if (alertWebhook) {
    try {
      await fetch(alertWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `CRITICAL: Audit chain broken at seq ${atSeq}. Immediate investigation required.`,
        }),
      });
    } catch (err: any) {
      log.error({ error: err.message }, "Failed to send alert");
    }
  }
}
