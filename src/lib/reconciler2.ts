import { query } from "../db.js";
import * as moneyBus from "./moneyBus.js";
import { appendAudit } from "./auditLedger.js";
import { createLogger } from "../logger.js";

const log = createLogger("reconciler2");

export interface ReconcileRun {
  id: string;
  at: Date;
  rowsChecked: number;
  matched: number;
  mismatches: number;
  pending: number;
  detail: any;
}

/**
 * Run reconciliation and persist results.
 */
export async function runReconciliation(): Promise<ReconcileRun> {
  const now = Math.floor(Date.now() / 1000);
  const from = now - 86400;

  let skip = 0;
  let hasMore = true;
  let matched = 0;
  let mismatches = 0;
  let pending = 0;
  const mismatchDetails: any[] = [];

  while (hasMore) {
    try {
      const payments = await moneyBus.fetchPaymentsList({ from, count: 100, skip });
      const items = payments.items || [];

      for (const payment of items) {
        const referenceId = payment.notes?.audit_seq || payment.order_id;
        if (!referenceId) continue;

        const { rows } = await query(
          "SELECT seq FROM audit_log WHERE seq = $1 OR outcome_detail_json->>'result' LIKE $2",
          [parseInt(referenceId), `%${payment.order_id}%`]
        );

        if (rows.length > 0) {
          matched++;
        } else {
          mismatches++;
          mismatchDetails.push({ paymentId: payment.id, referenceId });
          await appendAudit({
            actor: 'Reconciler',
            action: 'reconcile_backfill',
            params_json: { paymentId: payment.id, referenceId },
            decision: 'ALLOW',
            policy_checks_json: {},
            rationale_json: { backfilled: true },
            outcome: 'SUCCESS',
          });
        }
      }

      skip += items.length;
      hasMore = items.length === 100;
    } catch (err: any) {
      log.error({ error: err.message }, "Reconciliation error");
      hasMore = false;
    }
  }

  // Check for pending orders
  const { rows: pendingRows } = await query(
    "SELECT COUNT(*) as cnt FROM orders WHERE status = 'pending'"
  );
  pending = Number(pendingRows[0]?.cnt || 0);

  const rowsChecked = matched + mismatches;

  // Persist run
  const { rows } = await query(
    `INSERT INTO reconcile_runs (rows_checked, matched, mismatches, pending, detail_json)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [rowsChecked, matched, mismatches, pending, JSON.stringify({ mismatches: mismatchDetails })]
  );

  log.info({ rowsChecked, matched, mismatches, pending }, "Reconciliation complete");

  return {
    id: rows[0].id,
    at: rows[0].at,
    rowsChecked,
    matched,
    mismatches,
    pending,
    detail: { mismatches: mismatchDetails },
  };
}

/**
 * Get last N reconciliation runs.
 */
export async function getRecentRuns(limit: number = 10): Promise<ReconcileRun[]> {
  const { rows } = await query(
    "SELECT * FROM reconcile_runs ORDER BY at DESC LIMIT $1",
    [limit]
  );
  return rows.map((r: any) => ({
    id: r.id,
    at: r.at,
    rowsChecked: r.rows_checked,
    matched: r.matched,
    mismatches: r.mismatches,
    pending: r.pending,
    detail: r.detail_json,
  }));
}
