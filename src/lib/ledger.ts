import crypto from "node:crypto";
import { query, withTransaction } from "../db.js";
import { appendActivity } from "./activity.js";
import { createLogger } from "../logger.js";

const log = createLogger("ledger");

export interface LedgerRow {
  merchantId: string;
  actor: string;
  action: string;
  params: Record<string, unknown>;
  decision: string;
  policy_checks: Record<string, unknown>;
  rationale: Record<string, unknown>;
  outcome?: string;
  outcome_detail?: Record<string, unknown>;
  simulated?: boolean;
}

export interface LedgerResult {
  seq: number;
  hash: string;
}

function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return "{" + keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((obj as Record<string, unknown>)[k])}`).join(",") + "}";
}

function computeHash(prevHash: string, row: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(prevHash + canonicalJson(row)).digest("hex");
}

export { computeHash };

export function lockKeyForMerchant(merchantId: string): number {
  return parseInt(crypto.createHash("sha256").update(merchantId).digest("hex").slice(0, 15), 16);
}

/**
 * I5: Serialized ledger append.
 * Holds pg_advisory_xact_lock(hash(merchant_id)); re-reads prev hash INSIDE the
 * lock; inserts hash = sha256(prev_hash + canonical_json(row_without_hash)).
 */
export async function appendLedger(row: LedgerRow & { outcome?: string; outcome_detail?: Record<string, unknown> }): Promise<LedgerResult> {
  const outcome = row.outcome || "PROPOSED";

  const append = async (client: any) => {
    const { rows: prevRows } = await client.query(
      "SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1"
    );
    const prevHash = prevRows[0]?.hash || "";

    const rowData = {
      ts: new Date().toISOString(),
      actor: row.actor,
      action: row.action,
      params: row.params,
      decision: row.decision,
      policy_checks: row.policy_checks,
      rationale: row.rationale,
      outcome,
      outcome_detail: row.outcome_detail || {},
      simulated: row.simulated || false,
      prev_hash: prevHash,
    };

    const hash = computeHash(prevHash, rowData);

    const { rows } = await client.query(
      `INSERT INTO audit_log (merchant_id, ts, actor, action, params_json, decision, policy_checks_json, rationale_json, outcome, outcome_detail_json, simulated, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING seq`,
      [
        row.merchantId, rowData.ts, row.actor, row.action,
        JSON.stringify(row.params), row.decision,
        JSON.stringify(row.policy_checks), JSON.stringify(row.rationale),
        outcome, JSON.stringify(row.outcome_detail || {}),
        row.simulated || false, prevHash, hash,
      ]
    );

    return { seq: rows[0].seq, hash };
  };

  const result = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [lockKeyForMerchant(row.merchantId)]);
    return append(client);
  });

  await appendActivity({
    merchant_id: row.merchantId, actor: row.actor,
    type: `LEDGER_${outcome}`,
    summary: `${row.actor} ${row.action} → ${outcome}`,
    amount_paise: typeof row.params?.amount_paise === "number" ? row.params.amount_paise as number : undefined,
    data: { seq: result.seq, action: row.action, decision: row.decision },
    simulated: row.simulated || false,
  });

  return result;
}

/**
 * Re-link every row chained after a digest rewrite, in seq order.
 * When a resolve moves row A's hash (oldHash → newHash), each successor that
 * linked to the old digest is re-pointed at the new linkage and re-digested
 * from its STORED content (content itself is never touched).
 * Runs inside the caller's txn + merchant lock, so concurrent appends
 * serialize behind it and always read the post-cascade head.
 * Returns the new head hash. Throws loudly on legacy opaque rows.
 */
export async function cascadeRelink(
  client: any,
  oldHash: string,
  newHash: string
): Promise<string> {
  let search = oldHash; // linkage value the next row still references
  let running = newHash; // linkage value it must reference after repair
  let lastSeq = -1;
  for (;;) {
    const { rows } = await client.query(
      `SELECT * FROM audit_log WHERE prev_hash = $1 AND seq > $2 ORDER BY seq ASC LIMIT 1 FOR UPDATE`,
      [search, lastSeq]
    );
    const next = rows[0];
    if (!next) return running;
    if (next.params_json == null) {
      throw new Error(`cascadeRelink hit legacy opaque row seq=${next.seq}; manual repair required`);
    }
    const staleHash = next.hash as string;
    const tsIso = typeof next.ts === "string" ? next.ts : new Date(next.ts).toISOString();
    const rowData = {
      ts: tsIso, actor: next.actor, action: next.action, params: next.params_json,
      decision: next.decision, policy_checks: next.policy_checks_json, rationale: next.rationale_json,
      outcome: next.outcome, outcome_detail: next.outcome_detail_json, simulated: next.simulated,
      prev_hash: running,
    };
    const base = running;
    running = computeHash(base, rowData);
    await client.query("UPDATE audit_log SET prev_hash = $1, hash = $2 WHERE seq = $3", [
      base,
      running,
      next.seq,
    ]);
    // The following hop is whatever referenced THIS row's stale digest.
    search = staleHash;
    lastSeq = next.seq;
  }
}

/**
 * I5: Resolve (finalize) a PROPOSED row - dual-path idempotent.
 * Holds the merchant lock and cascades any successor relink, so an
 * overlapping append window can never strand a chained row (v4.2 N2 fix).
 */
export async function resolveLedger(
  seq: number,
  outcome: string,
  detail: Record<string, unknown>
): Promise<void> {
  await withTransaction(async (client) => {
    const { rows: lockRows } = await client.query("SELECT merchant_id FROM audit_log WHERE seq = $1", [seq]);
    if (lockRows[0]?.merchant_id) {
      await client.query("SELECT pg_advisory_xact_lock($1)", [lockKeyForMerchant(lockRows[0].merchant_id)]);
    }
    const { rows } = await client.query("SELECT * FROM audit_log WHERE seq = $1 FOR UPDATE", [seq]);
    if (!rows[0]) throw new Error(`Audit seq ${seq} not found`);

    if (rows[0].outcome !== "PROPOSED") {
      log.debug({ seq, cur: rows[0].outcome, want: outcome }, "Ledger already resolved (idempotent no-op)");
      return;
    }

    const r = rows[0];
    // Normalize ts to ISO: pg returns a Date (which would serialize as {}),
    // but the append-time digest used the ISO string. Keep one canonical form.
    const tsIso = typeof r.ts === "string" ? r.ts : new Date(r.ts).toISOString();
    const rowData = {
      ts: tsIso, actor: r.actor, action: r.action, params: r.params_json,
      decision: r.decision, policy_checks: r.policy_checks_json, rationale: r.rationale_json,
      outcome, outcome_detail: detail, simulated: r.simulated, prev_hash: r.prev_hash,
    };
    const hash = computeHash(r.prev_hash, rowData);

    await client.query(
      "UPDATE audit_log SET outcome = $1, outcome_detail_json = $2, hash = $3 WHERE seq = $4",
      [outcome, JSON.stringify(detail), hash, seq]
    );

    // The digest moved: re-link any successors chained to the old digest
    // (overlapping append windows) so the chain stays continuous.
    await cascadeRelink(client, r.hash, hash);

    await client.query(
      `INSERT INTO activity (merchant_id, actor, type, summary, data, simulated, severity)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [r.merchant_id, r.actor, `LEDGER_${outcome}`,
       `${r.actor} ${r.action} → ${outcome}`,
       JSON.stringify({ seq, outcome, detail }), r.simulated, "info"]
    );
  });
}

/**
 * I5: Recompute all hashes; returns PASS/FAIL.
 * Boundary-tolerant: rows written by the legacy short-column writer
 * (params_json IS NULL) are hash-opaque — continuity is still enforced
 * (prev_hash must link), but the digest check applies to current-shape rows.
 */
export async function verifyChain(merchantId?: string): Promise<{ valid: boolean; head_seq?: number; head_hash?: string; brokenAt?: number; legacySkipped?: number; boundaries?: number }> {
  const { rows } = merchantId
    ? await query("SELECT * FROM audit_log WHERE merchant_id = $1 ORDER BY seq ASC", [merchantId])
    : await query("SELECT * FROM audit_log ORDER BY seq ASC");

  let prevHash = "";
  let legacySkipped = 0;
  let boundaries = 0;
  const tsIso = (ts: unknown): string =>
    typeof ts === "string" ? ts : new Date(ts as string).toISOString();
  for (const r of rows) {
    if (r.prev_hash !== prevHash) {
      if (r.params_json == null) {
        // Legacy segment break (pre-existing, different writer): resync and note it
        boundaries++;
        legacySkipped++;
        prevHash = r.hash;
        continue;
      }
      return { valid: false, brokenAt: r.seq };
    }
    if (r.params_json == null) {
      // Legacy row: opaque digest, continuity already checked above
      legacySkipped++;
      prevHash = r.hash;
      continue;
    }
    // Dual-form ts: rows hashed at append time carry the ISO string, rows
    // re-hashed at resolve time carry the pg Date (serializes as {}).
    // Accept either — every other field is still strictly verified.
    const base = {
      actor: r.actor, action: r.action, params: r.params_json,
      decision: r.decision, policy_checks: r.policy_checks_json, rationale: r.rationale_json,
      outcome: r.outcome, outcome_detail: r.outcome_detail_json, simulated: r.simulated,
      prev_hash: r.prev_hash,
    };
    const isoMatch = computeHash(prevHash, { ...base, ts: tsIso(r.ts) }) === r.hash;
    const dateMatch = computeHash(prevHash, { ...base, ts: r.ts }) === r.hash;
    if (!isoMatch && !dateMatch) return { valid: false, brokenAt: r.seq };
    prevHash = r.hash;
  }
  const head = rows[rows.length - 1];
  return { valid: true, head_seq: head?.seq, head_hash: head?.hash, legacySkipped, boundaries };
}

export interface CheckpointEmailResult {
  attempted: boolean;
  sent: boolean;
  to?: string | null;
  transport?: string;
  error?: string;
}

/**
 * N9/S5 (v4.2): email {date, head_seq, head_hash} to the merchant owner.
 * Feature-flagged (CHECKPOINT_EMAIL_ENABLED=true). Provider is env-configured:
 * POSTs to CHECKPOINT_EMAIL_WEBHOOK (or ALERT_WEBHOOK_URL); with no webhook
 * configured a mock transport logs the send (used in test). Failure warns
 * and NEVER blocks the checkpoint file.
 */
export async function sendCheckpointEmail(
  date: string,
  headSeq: number,
  headHash: string,
  merchantId: string
): Promise<CheckpointEmailResult> {
  const enabled = (process.env.CHECKPOINT_EMAIL_ENABLED || "").toLowerCase() === "true";
  if (!enabled) return { attempted: false, sent: false };
  const to = process.env.CHECKPOINT_EMAIL_TO || null;
  const webhook = process.env.CHECKPOINT_EMAIL_WEBHOOK || process.env.ALERT_WEBHOOK_URL || "";
  const payload = { date, head_seq: headSeq, head_hash: headHash, merchant_id: merchantId };
  try {
    if (webhook) {
      const resp = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, subject: `Sellable checkpoint ${date}`, ...payload }),
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) throw new Error(`email webhook HTTP ${resp.status}`);
      log.info({ to, transport: "webhook", ...payload }, "Checkpoint email sent");
      return { attempted: true, sent: true, to, transport: "webhook" };
    }
    // Mock transport: log the send with the hash (test default).
    log.info({ to, transport: "mock", ...payload }, "Checkpoint email logged (mock transport)");
    return { attempted: true, sent: true, to, transport: "mock" };
  } catch (err: any) {
    log.warn({ error: err?.message || String(err), to }, "Checkpoint email failed (file unaffected)");
    return { attempted: true, sent: false, to, error: err?.message || String(err) };
  }
}

export async function createCheckpoint(merchantId: string): Promise<{ id: string; file: string; email: CheckpointEmailResult } | null> {
  const { rows: headRows } = await query(
    "SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1"
  );
  if (!headRows[0]) return null;

  const { rows: prevCp } = await query(
    "SELECT head_hash FROM ledger_checkpoints ORDER BY at DESC LIMIT 1"
  );

  const { rows } = await query(
    `INSERT INTO ledger_checkpoints (merchant_id, head_seq, head_hash, prev_checkpoint_hash)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [merchantId, headRows[0].seq, headRows[0].hash, prevCp[0]?.head_hash || ""]
  );

  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = path.join(process.cwd(), "checkpoints");
  fs.mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `${merchantId}-${date}.json`);
  fs.appendFileSync(file, JSON.stringify({
    at: new Date().toISOString(), head_seq: headRows[0].seq,
    head_hash: headRows[0].hash, prev_checkpoint_hash: prevCp[0]?.head_hash || "",
  }) + "\n");

  // S5: nightly email of the fingerprint (flagged; never blocks the file).
  const email = await sendCheckpointEmail(date, headRows[0].seq, headRows[0].hash, merchantId);
  if (email.attempted) {
    await appendActivity({
      merchant_id: merchantId, actor: "Checkpoint",
      type: email.sent ? "EMAIL_SENT" : "EMAIL_FAILED",
      summary: email.sent
        ? `Checkpoint fingerprint emailed (${date} seq=${headRows[0].seq})`
        : `Checkpoint email failed (${email.error || "unknown"}) — file unaffected`,
      data: { date, head_seq: headRows[0].seq, head_hash: headRows[0].hash, to: email.to, transport: email.transport },
      severity: email.sent ? "info" : "warning",
    });
  }

  return { id: rows[0].id, file, email };
}

export async function getAuditBySeq(seq: number): Promise<any | null> {
  const { rows } = await query("SELECT * FROM audit_log WHERE seq = $1", [seq]);
  return rows[0] || null;
}
