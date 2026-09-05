import { Router, Request, Response } from "express";
import crypto from "node:crypto";
import { getConfig } from "../config.js";
import { query } from "../db.js";
import { resolvePayment, fetchPaymentLink } from "../lib/moneyBus.js";
import { appendActivity } from "../lib/activity.js";
import { createLogger } from "../logger.js";

const log = createLogger("webhook");
export const webhookRouter = Router();
const MERCHANT_ID = "5a3ac6ce-b2c7-4b1f-a9db-45296841f30b";

// I6: express.raw mounted BEFORE JSON parsers (in server.ts), HMAC-SHA256 over raw body, constant-time compare
webhookRouter.post("/webhooks/razorpay", async (req: Request, res: Response) => {
  const config = getConfig();
  const body = req.body;
  const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));

  const signature = req.headers["x-razorpay-signature"] as string;
  if (!signature) { res.status(400).json({ error: "Missing signature" }); return; }

  const expected = crypto.createHmac("sha256", config.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))) {
    log.warn("Invalid webhook signature");
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const event = JSON.parse(rawBody.toString());
  const eventType = event.event;

  // I6: event-id dedupe table
  const eventId = event.payload?.payment_link?.entity?.id || event.payload?.payment?.entity?.id || crypto.randomUUID();
  const { rows: existing } = await query("SELECT 1 FROM idempotency WHERE key = $1", [`webhook:${eventId}`]);
  if (existing[0]) { log.debug({ eventId }, "Duplicate webhook, skipping"); res.json({ status: "ok" }); return; }
  await query("INSERT INTO idempotency (key, request_hash, response_json) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [`webhook:${eventId}`, "", JSON.stringify({ received: true })]);

  log.info({ eventId, type: eventType }, "Webhook received");

  // Process payment_link events
  if (eventType === "payment_link.paid") {
    const linkId = event.payload?.payment_link?.entity?.id;
    if (linkId) {
      const { rows: links } = await query(
        "SELECT id, razorpay_link_id, merchant_id, cart_id, customer_id, amount_paise, incentive_paise, audit_seq FROM payment_links WHERE razorpay_link_id = $1 AND status = 'live'",
        [linkId]
      );
      if (links[0]) {
        await resolvePayment({
          id: links[0].id, merchant_id: links[0].merchant_id || MERCHANT_ID,
          razorpay_link_id: linkId, audit_seq: links[0].audit_seq,
          amount_paise: links[0].amount_paise, incentive_paise: links[0].incentive_paise,
          cart_id: links[0].cart_id, customer_id: links[0].customer_id,
        });
      }
    }
  } else if (eventType === "payment_link.cancelled" || eventType === "payment_link.expired") {
    const linkId = event.payload?.payment_link?.entity?.id;
    if (linkId) {
      const newStatus = eventType === "payment_link.expired" ? "expired" : "cancelled";
      await query("UPDATE payment_links SET status = $1 WHERE razorpay_link_id = $2", [newStatus, linkId]);
    }
  } else if (eventType === "payment.failed") {
    // Failed attempt on a link: the link itself stays 'created' (failures
    // live on payment entities), so without this branch failures were
    // invisible. Converges with the poller on link_payment_attempts —
    // first sighting records + nudges, re-sightings stay silent.
    try {
      const entity = event.payload?.payment?.entity || {};
      const linkId =
        event.payload?.payment_link?.entity?.id ||
        entity.notes?.link_id ||
        entity.notes?.razorpay_link_id ||
        null;
      const rpOrderId = entity.order_id || null;
      let links: any[] = [];
      if (linkId) {
        ({ rows: links } = await query(
          `SELECT id, razorpay_link_id, merchant_id, cart_id, customer_id, amount_paise, short_url, ext_ref
           FROM payment_links WHERE razorpay_link_id = $1 AND status = 'live'`,
          [linkId]
        ));
      }
      if (links.length === 0 && rpOrderId) {
        ({ rows: links } = await query(
          `SELECT id, razorpay_link_id, merchant_id, cart_id, customer_id, amount_paise, short_url, ext_ref
           FROM payment_links WHERE razorpay_order_id = $1 AND status = 'live'`,
          [rpOrderId]
        ));
      }
      if (links.length === 0) {
        // Notes-based match: failed link attempts inherit our notes
        // (cart_id/ext_ref) on the payment entity — verified live.
        const { rows: live } = await query(
          `SELECT id, razorpay_link_id, merchant_id, cart_id, customer_id, amount_paise, short_url, ext_ref
           FROM payment_links WHERE status = 'live' AND razorpay_link_id IS NOT NULL
           AND created_at > NOW() - INTERVAL '25 hours' LIMIT 50`
        );
        const { matchFailedToLink } = await import("../lib/linkFailures.js");
        const hit = matchFailedToLink(entity, live);
        if (hit) links = [hit];
      }
      if (links[0]) {
        const { ensureLinkAttemptsTable, recordLinkPaymentFailure } = await import("../lib/linkFailures.js");
        await ensureLinkAttemptsTable();
        const rec = await recordLinkPaymentFailure(undefined, links[0], { ...entity, status: "failed" });
        if (rec.isNew) {
          const { sendLinkFailureNudge } = await import("../agents/failureRetryBot.js");
          await appendActivity({
            merchant_id: links[0].merchant_id || MERCHANT_ID, actor: "Webhook", type: "PAYMENT_FAILED",
            summary: `Webhook: payment failed on link ${links[0].razorpay_link_id} — retry nudge armed`,
            data: { razorpay_link_id: links[0].razorpay_link_id, razorpay_payment_id: rec.paymentId, order_id: rec.orderId },
            severity: "warning",
          });
          await sendLinkFailureNudge(links[0], { ...entity, status: "failed" }, rec.orderId);
        }
      }
    } catch (failErr: any) {
      log.warn({ error: failErr?.message }, "payment.failed handling skipped (non-critical)");
    }
  }

  await appendActivity({
    merchant_id: MERCHANT_ID, actor: "Webhook", type: "INTENT",
    summary: `Webhook: ${eventType} for ${eventId}`,
    data: { event_type: eventType, event_id: eventId },
  });

  res.json({ status: "ok" });
});
