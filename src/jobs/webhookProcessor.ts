import crypto from "node:crypto";
import { createWorker, webhookQueue } from "./queue.js";
import { query } from "../db.js";
import { updateAuditOutcome } from "../lib/auditLedger.js";
import { processAbandonedCart } from "../agents/recoveryBot.js";
import { processPaidOrder } from "../agents/upsellBot.js";
import { createLogger } from "../logger.js";
import { redactForPersist } from "../lib/redact.js";
import { handleOverpayment, registerLink } from "../lib/linkLifecycle.js";

const log = createLogger("webhookProcessor");

// Webhook signature verification
export function verifyWebhookSignature(
  body: string | Buffer,
  signature: string,
  secret: string
): boolean {
  const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(signature, "hex")
  );
}

export const webhookProcessorWorker = createWorker("webhook-processing", async (job) => {
  const { event_id, payload } = job.data;

  // Dedupe check
  const { rows: existing } = await query(
    "SELECT event_id FROM webhook_events WHERE event_id = $1",
    [event_id]
  );
  if (existing[0]) {
    log.debug({ event_id }, "Duplicate webhook, skipping");
    return;
  }

  // Insert event
  await query(
    "INSERT INTO webhook_events (event_id, status) VALUES ($1, 'pending') ON CONFLICT DO NOTHING",
    [event_id]
  );

  try {
    const event = JSON.parse(payload);
    const eventType = event.event;
    const payloadData = event.payload?.payment?.entity || event.payload?.payment_link?.entity || {};

    // H8: Record event ordering for out-of-order detection
    const eventTimestamp = event.created_at || Math.floor(Date.now() / 1000);
    await query(
      `INSERT INTO webhook_events (event_id, status, created_at_raw)
       VALUES ($1, 'processing', $2)
       ON CONFLICT (event_id) DO NOTHING`,
      [event_id, eventTimestamp]
    );

    switch (eventType) {
      case "payment.captured": {
        const orderId = payloadData.order_id;
        if (orderId) {
          // H1: Check for overpayment
          const { rows: orderRows } = await query(
            "SELECT amount_paise, cart_id FROM orders WHERE id = $1",
            [orderId]
          );

          if (orderRows[0]) {
            const expectedAmount = Number(orderRows[0].amount_paise);
            const capturedAmount = Number(payloadData.amount || 0);

            if (capturedAmount > expectedAmount) {
              // H1: Handle overpayment
              const overpaymentResult = await handleOverpayment({
                orderId,
                cartId: orderRows[0].cart_id,
                capturedAmountPaise: capturedAmount,
                expectedAmountPaise: expectedAmount,
              });

              if (overpaymentResult.action === "auto_refunded") {
                // Don't mark as paid - refund in progress
                log.info({ orderId, overpayment: capturedAmount - expectedAmount }, "Overpayment auto-refunded");
                break;
              }
            }
          }

          // Normal payment.captured processing
          await query(
            "UPDATE orders SET status = 'paid', paid_at = NOW() WHERE id = $1",
            [orderId]
          );

          // H2: Record fee from payment entity
          if (payloadData.fee) {
            await query(
              `UPDATE orders SET fee_paise = $1, fee_basis = 'entity' WHERE id = $2`,
              [Number(payloadData.fee), orderId]
            );
          }

          // Find related audit seq
          const { rows: auditRows } = await query(
            "SELECT seq FROM audit_log WHERE outcome_detail_json->>'result' LIKE $1 ORDER BY seq DESC LIMIT 1",
            [`%${orderId}%`]
          );
          if (auditRows[0]) {
            await updateAuditOutcome(auditRows[0].seq, "SUCCESS", { order_id: orderId, status: "paid" });
          }
          // Trigger upsell
          await processPaidOrder({ id: orderId, cart_id: null, customer_id: null, amount_paise: 0 });
        }
        break;
      }
      case "payment.failed": {
        const orderId = payloadData.order_id;
        if (orderId) {
          // G4 (v4.3): record method + failure time for the retry bot (columns ensured, best effort).
          try {
            await query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT");
            await query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ");
          } catch { /* already there */ }
          await query(
            "UPDATE orders SET status = 'failed', payment_method = COALESCE($2, payment_method), failed_at = NOW() WHERE id = $1",
            [orderId, payloadData.method || payloadData.payment_method || null]
          );
          const { rows: auditRows } = await query(
            "SELECT seq FROM audit_log WHERE outcome_detail_json->>'result' LIKE $1 ORDER BY seq DESC LIMIT 1",
            [`%${orderId}%`]
          );
          if (auditRows[0]) {
            await updateAuditOutcome(auditRows[0].seq, "FAILED", {
              reason_code: payloadData.error_code,
              error_description: payloadData.error_description,
            });
          }
        }
        break;
      }
      case "payment_link.created": {
        // H1: Register new active link
        const linkId = payloadData.id;
        const referenceId = payloadData.reference_id;
        const notes = payloadData.notes || {};

        if (linkId && notes.cart_id) {
          await registerLink({
            paymentLinkId: linkId,
            cartId: notes.cart_id,
            merchantId: "00000000-0000-0000-0000-000000000001", // Single merchant
            amountPaise: Number(payloadData.amount || 0),
            incentivePaise: Number(notes.incentive_paise || 0),
          });
        }
        break;
      }
      case "payment_link.paid": {
        const linkId = payloadData.id;
        const referenceId = payloadData.reference_id;
        if (referenceId) {
          const seq = parseInt(referenceId);
          if (!isNaN(seq)) {
            await updateAuditOutcome(seq, "SUCCESS", { payment_link_id: linkId, status: "paid" });
            // H1: Mark link as converted
            await query(
              `UPDATE open_links SET status = 'converted' WHERE payment_link_id = $1`,
              [linkId]
            );
          }
        }
        break;
      }
      case "payment_link.cancelled": {
        const referenceId = payloadData.reference_id;
        if (referenceId) {
          const seq = parseInt(referenceId);
          if (!isNaN(seq)) {
            await updateAuditOutcome(seq, "FAILED", { reason: "payment_link_cancelled" });
          }
        }
        break;
      }
    }

    await query(
      "UPDATE webhook_events SET status = 'processed' WHERE event_id = $1",
      [event_id]
    );
    log.info({ event_id, type: eventType }, "Webhook processed");
  } catch (err: any) {
    const { rows: eventRows } = await query(
      "SELECT attempts FROM webhook_events WHERE event_id = $1",
      [event_id]
    );
    const attempts = (eventRows[0]?.attempts || 0) + 1;

    if (attempts >= 5) {
      await query(
        "UPDATE webhook_events SET status = 'failed', last_error = $1 WHERE event_id = $2",
        [err.message, event_id]
      );
      await query(
        "INSERT INTO dead_letters (event_id, payload_json, error) VALUES ($1, $2, $3)",
        [event_id, JSON.stringify(redactForPersist(JSON.parse(payload))), err.message]
      );
      log.error({ event_id, error: err.message }, "Webhook moved to dead letter");
    } else {
      await query(
        "UPDATE webhook_events SET attempts = $1, last_error = $2 WHERE event_id = $3",
        [attempts, err.message, event_id]
      );
      // Re-queue with backoff
      throw err;
    }
  }
});
