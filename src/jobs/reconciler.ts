import { createWorker } from "./queue.js";
import { query } from "../db.js";
import { fetchPaymentsList } from "../lib/moneyBus.js";
import { createLogger } from "../logger.js";

const log = createLogger("reconciler");

export const reconcilerWorker = createWorker("reconcile", async () => {
  const now = Math.floor(Date.now() / 1000);
  const from = now - 86400;

  let skip = 0;
  let hasMore = true;
  let matched = 0;
  let unmatched = 0;

  while (hasMore) {
    try {
      const payments = await fetchPaymentsList({ from, count: 100, skip });
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
          unmatched++;
          log.warn({ paymentId: payment.id, referenceId }, "Unmatched payment found");
          await query(
            `INSERT INTO audit_log (actor, action, decision, outcome, outcome_detail_json)
             VALUES ('Reconciler', 'reconcile_backfill', 'ALLOW', 'SUCCESS', $1)`,
            [JSON.stringify({ payment_id: payment.id, backfilled: true })]
          );
        }
      }

      skip += items.length;
      hasMore = items.length === 100;
    } catch (err: any) {
      log.error({ error: err.message }, "Reconciliation error");
      hasMore = false;
    }
  }

  const { rows: paidRows } = await query(
    `SELECT seq FROM audit_log WHERE outcome = 'SUCCESS' AND action = 'create_payment_link'
     AND ts > NOW() - INTERVAL '24 hours'`
  );

  for (const row of paidRows) {
    const { rows: matchRows } = await query(
      "SELECT 1 FROM audit_log WHERE seq = $1 AND outcome_detail_json->>'result' IS NOT NULL",
      [row.seq]
    );
    if (matchRows.length === 0) {
      log.warn({ seq: row.seq }, "Paid audit row without Razorpay record");
    }
  }

  log.info({ matched, unmatched }, "Reconciliation complete");
});
