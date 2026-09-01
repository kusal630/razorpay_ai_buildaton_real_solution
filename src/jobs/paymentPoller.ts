import { createWorker } from "./queue.js";
import { query } from "../db.js";
import { fetchOrderStatus } from "../lib/moneyBus.js";
import { updateAuditOutcome } from "../lib/auditLedger.js";
import { createLogger } from "../logger.js";

const log = createLogger("paymentPoller");

export const paymentPollerWorker = createWorker("payment-poll", async () => {
  const { rows } = await query(
    `SELECT o.*, al.seq as audit_seq
     FROM orders o
     LEFT JOIN audit_log al ON al.outcome_detail_json->>'result' LIKE '%' || o.id || '%'
     WHERE o.status = 'pending'
     AND o.created_at < NOW() - INTERVAL '30 seconds'
     LIMIT 50`
  );

  for (const order of rows) {
    try {
      const rpOrder = await fetchOrderStatus(order.id);
      const rpStatus = rpOrder.status;

      if (rpStatus === "paid" && order.status !== "paid") {
        await query("UPDATE orders SET status = 'paid', paid_at = NOW() WHERE id = $1", [order.id]);
        if (order.audit_seq) {
          await updateAuditOutcome(order.audit_seq, "SUCCESS", { order_id: order.id, status: "paid", resolved_by: "poller" });
        }
        log.info({ orderId: order.id }, "Poller resolved as PAID");
      } else if (rpStatus === "failed" && order.status !== "failed") {
        await query("UPDATE orders SET status = 'failed' WHERE id = $1", [order.id]);
        if (order.audit_seq) {
          await updateAuditOutcome(order.audit_seq, "FAILED", { order_id: order.id, status: "failed", resolved_by: "poller" });
        }
        log.info({ orderId: order.id }, "Poller resolved as FAILED");
      }
    } catch (err: any) {
      log.error({ orderId: order.id, error: err.message }, "Poller error");
    }
  }
});
