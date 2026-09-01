import crypto from "node:crypto";
import { createWorker, webhookQueue } from "./queue.js";
import { query } from "../db.js";
import { updateAuditOutcome } from "../lib/auditLedger.js";
import { processAbandonedCart } from "../agents/recoveryBot.js";
import { processUpsell } from "../agents/upsellBot.js";
import { createLogger } from "../logger.js";
import { redactForPersist } from "../lib/redact.js";

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

    switch (eventType) {
      case "payment.captured": {
        const orderId = payloadData.order_id;
        if (orderId) {
          await query(
            "UPDATE orders SET status = 'paid', paid_at = NOW() WHERE id = $1",
            [orderId]
          );
          // Find related audit seq
          const { rows: auditRows } = await query(
            "SELECT seq FROM audit_log WHERE outcome_detail_json->>'result' LIKE $1 ORDER BY seq DESC LIMIT 1",
            [`%${orderId}%`]
          );
          if (auditRows[0]) {
            await updateAuditOutcome(auditRows[0].seq, "SUCCESS", { order_id: orderId, status: "paid" });
          }
          // Trigger upsell
          await processUpsell(orderId);
        }
        break;
      }
      case "payment.failed": {
        const orderId = payloadData.order_id;
        if (orderId) {
          await query(
            "UPDATE orders SET status = 'failed' WHERE id = $1",
            [orderId]
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
      case "payment_link.paid": {
        const linkId = payloadData.id;
        const referenceId = payloadData.reference_id;
        if (referenceId) {
          const seq = parseInt(referenceId);
          if (!isNaN(seq)) {
            await updateAuditOutcome(seq, "SUCCESS", { payment_link_id: linkId, status: "paid" });
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
