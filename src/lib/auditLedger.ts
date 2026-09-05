import { query } from "../db.js";
import { computeHash } from "./ledger.js";

interface AuditRow {
  seq: number;
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
  hash: string;
}

type HashableAuditRow = Omit<AuditRow, "hash" | "seq">;

// Single canonicalization lives in ledger.js (recursive key sort,
// undefined/function/symbol dropped to match JSONB storage). This module
// delegates so every writer hashes identically and one verifyChain holds.
// NOTE: rows written by the pre-unification canonical CANNOT verify — none
// exist on any live chain (reset re-genesis covers this).

export async function appendAudit(params: {
  actor: string;
  action: string;
  params_json: Record<string, unknown>;
  decision: string;
  policy_checks_json: Record<string, unknown>;
  rationale_json: Record<string, unknown>;
  outcome?: string;
  outcome_detail_json?: Record<string, unknown>;
}): Promise<number> {
  const { rows: prevRows } = await query("SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1");
  const prevHash = prevRows[0]?.hash || "";

  const row = {
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
}

export async function updateAuditOutcome(
  seq: number,
  outcome: string,
  detail: Record<string, unknown>
): Promise<void> {
  const { rows: existing } = await query("SELECT * FROM audit_log WHERE seq = $1", [seq]);
  if (!existing[0]) throw new Error(`Audit seq ${seq} not found`);

  const prevRow = existing[0];
  const row = {
    ts: prevRow.ts,
    actor: prevRow.actor,
    action: prevRow.action,
    params_json: prevRow.params_json,
    decision: prevRow.decision,
    policy_checks_json: prevRow.policy_checks_json,
    rationale_json: prevRow.rationale_json,
    outcome,
    outcome_detail_json: detail,
    prev_hash: prevRow.prev_hash,
  };
  const hash = computeHash(prevRow.prev_hash, row);

  await query(
    "UPDATE audit_log SET outcome = $1, outcome_detail_json = $2, hash = $3 WHERE seq = $4",
    [outcome, JSON.stringify(detail), hash, seq]
  );
}

export async function verifyChain(): Promise<{ valid: boolean; brokenAt?: number }> {
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
      return { valid: false, brokenAt: r.seq };
    }
    const expectedHash = computeHash(prevHash, row);
    if (r.hash !== expectedHash) {
      return { valid: false, brokenAt: r.seq };
    }
    prevHash = r.hash;
  }
  return { valid: true };
}

export async function createCheckpoint(): Promise<string> {
  const { rows: headRows } = await query("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1");
  if (!headRows[0]) throw new Error("No audit rows to checkpoint");

  const { rows: prevCp } = await query(
    "SELECT head_hash FROM ledger_checkpoints ORDER BY at DESC LIMIT 1"
  );

  const { rows } = await query(
    `INSERT INTO ledger_checkpoints (head_seq, head_hash, prev_checkpoint_hash)
     VALUES ($1, $2, $3) RETURNING id`,
    [headRows[0].seq, headRows[0].hash, prevCp[0]?.head_hash || ""]
  );
  return rows[0].id;
}

export async function getAuditBySeq(seq: number): Promise<AuditRow | null> {
  const { rows } = await query("SELECT * FROM audit_log WHERE seq = $1", [seq]);
  return rows[0] || null;
}
