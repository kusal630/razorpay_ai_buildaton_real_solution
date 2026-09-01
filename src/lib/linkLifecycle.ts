import { query } from "../db.js";
import { createLogger } from "../logger.js";

const log = createLogger("linkLifecycle");

/**
 * C5: Cancel-before-create fails closed.
 * If cancel errors or link state is unknown, do NOT issue new link.
 * Ledger the failure; alert.
 */
export async function cancelExistingLinks(
  merchantId: string,
  cartId: string
): Promise<{ cancelled: number; failed: boolean; failedLinks: string[] }> {
  const { rows: activeLinks } = await query(
    `SELECT id, payment_link_id FROM open_links
     WHERE cart_id = $1 AND merchant_id = $2 AND status = 'active'`,
    [cartId, merchantId]
  );

  let cancelled = 0;
  const failedLinks: string[] = [];

  for (const link of activeLinks) {
    try {
      const response = await fetch(
        `https://api.razorpay.com/v1/payment_links/${link.payment_link_id}/cancel`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64")}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (response.ok || response.status === 400) {
        // 400 = already cancelled/expired
        await query(
          `UPDATE open_links SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1`,
          [link.id]
        );
        cancelled++;
        log.info({ linkId: link.id, cartId }, "Cancelled existing link");
      } else {
        // C5: Cancel failed - mark as unknown state
        await query(
          `UPDATE open_links SET status = 'cancel_failed', cancelled_at = NOW() WHERE id = $1`,
          [link.id]
        );
        failedLinks.push(link.payment_link_id);
        log.warn({ linkId: link.id, status: response.status }, "Cancel failed");
      }
    } catch (err: any) {
      log.error({ linkId: link.id, error: err.message }, "Failed to cancel link");
      // C5: Mark as cancel_failed, not cancelled
      await query(
        `UPDATE open_links SET status = 'cancel_failed', cancelled_at = NOW() WHERE id = $1`,
        [link.id]
      );
      failedLinks.push(link.payment_link_id);
    }
  }

  // C5: If any cancel failed, signal failure (do NOT issue new link)
  const failed = failedLinks.length > 0;

  if (failed) {
    log.error({ cartId, failedLinks }, "Cancel-before-create failed - new link will NOT be issued");
  }

  return { cancelled, failed, failedLinks };
}

/**
 * H1: Register a new active link.
 */
export async function registerLink(params: {
  paymentLinkId: string;
  cartId: string;
  customerId?: string;
  merchantId: string;
  amountPaise: number;
  incentivePaise: number;
}): Promise<void> {
  await query(
    `INSERT INTO open_links (payment_link_id, cart_id, customer_id, merchant_id, amount_paise, incentive_paise)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      params.paymentLinkId,
      params.cartId,
      params.customerId,
      params.merchantId,
      params.amountPaise,
      params.incentivePaise,
    ]
  );
}

/**
 * H1: Handle overpayment on capture.
 * Auto refund if amount <= Rs.10,000, else ESCALATE.
 */
export async function handleOverpayment(params: {
  orderId: string;
  cartId: string;
  capturedAmountPaise: number;
  expectedAmountPaise: number;
  paymentLinkId?: string;
}): Promise<{
  action: "auto_refunded" | "escalated" | "no_overpayment";
  refundId?: string;
}> {
  const overpayment = params.capturedAmountPaise - params.expectedAmountPaise;

  if (overpayment <= 0) {
    return { action: "no_overpayment" };
  }

  // Auto-refund if <= Rs.10,000
  const AUTO_ALLOW_BAND = 1000000; // Rs.10,000 in paise

  if (overpayment <= AUTO_ALLOW_BAND) {
    // Auto refund via Razorpay
    try {
      const response = await fetch(
        `https://api.razorpay.com/v1/payments/${params.orderId}/refund`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            amount: overpayment,
            notes: {
              reason: "overpayment_auto_refund",
              cart_id: params.cartId,
            },
          }),
        }
      );

      const result = await response.json() as any;

      // Record overpayment
      await query(
        `INSERT INTO overpayments (order_id, cart_id, original_amount_paise, overpayment_amount_paise, refund_id, refund_status)
         VALUES ($1, $2, $3, $4, $5, 'auto_refunded')`,
        [params.orderId, params.cartId, params.expectedAmountPaise, overpayment, result.id]
      );

      // Exclude from segment_stats
      await query(
        `UPDATE segment_stats SET successes = GREATEST(successes - 1, 0)
         WHERE merchant_id = (SELECT merchant_id FROM carts WHERE id = $1)`,
        [params.cartId]
      );

      log.info({ orderId: params.orderId, overpayment, refundId: result.id }, "Overpayment auto-refunded");
      return { action: "auto_refunded", refundId: result.id };
    } catch (err: any) {
      log.error({ orderId: params.orderId, error: err.message }, "Auto refund failed, escalating");
    }
  }

  // Escalate for large overpayments or failed auto-refund
  await query(
    `INSERT INTO overpayments (order_id, cart_id, original_amount_paise, overpayment_amount_paise, refund_status)
     VALUES ($1, $2, $3, $4, 'escalated')`,
    [params.orderId, params.cartId, params.expectedAmountPaise, overpayment]
  );

  log.warn({ orderId: params.orderId, overpayment }, "Overpayment escalated");
  return { action: "escalated" };
}

/**
 * H1: Sweep expired/stale links.
 */
export async function sweepExpiredLinks(): Promise<number> {
  const { rowCount } = await query(
    `UPDATE open_links SET status = 'expired'
     WHERE status = 'active'
     AND created_at < NOW() - INTERVAL '24 hours'`
  );
  return rowCount || 0;
}
