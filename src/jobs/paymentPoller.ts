import { createWorker } from "./queue.js";
import { query } from "../db.js";
import { resolvePayment, fetchPaymentLink } from "../lib/moneyBus.js";
import { appendActivity } from "../lib/activity.js";
import { createLogger } from "../logger.js";

const log = createLogger("paymentPoller");
const MERCHANT_ID = "5a3ac6ce-b2c7-4b1f-a9db-45296841f30b";

export const paymentPollerWorker = createWorker("payment-poll", async () => {
  const { rows: links } = await query(
    `SELECT id, razorpay_link_id, merchant_id, cart_id, customer_id,
            amount_paise, incentive_paise, audit_seq
     FROM payment_links
     WHERE status = 'live'
     AND razorpay_link_id IS NOT NULL
     AND created_at > NOW() - INTERVAL '25 hours'
     LIMIT 50`
  );

  for (const link of links) {
    try {
      const rpLink = await fetchPaymentLink(link.razorpay_link_id);
      const rpStatus = rpLink.status;

      if (rpStatus === "paid") {
        await resolvePayment({
          id: link.id,
          merchant_id: link.merchant_id || MERCHANT_ID,
          razorpay_link_id: link.razorpay_link_id,
          audit_seq: link.audit_seq,
          amount_paise: link.amount_paise,
          incentive_paise: link.incentive_paise,
          cart_id: link.cart_id,
          customer_id: link.customer_id,
        });
        log.info({ linkId: link.razorpay_link_id }, "Poller resolved as PAID");
      } else if (rpStatus === "expired" || rpStatus === "cancelled") {
        const newStatus = rpStatus === "expired" ? "expired" : "cancelled";
        await query(
          "UPDATE payment_links SET status = $1 WHERE id = $2",
          [newStatus, link.id]
        );
        log.debug({ linkId: link.razorpay_link_id, status: newStatus }, "Poller resolved link");
      }
    } catch (err: any) {
      log.error({ linkId: link.razorpay_link_id, error: err.message }, "Poller error");
    }
  }
});
