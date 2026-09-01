import { Router, Request, Response } from "express";
import crypto from "node:crypto";
import { getConfig } from "../config.js";
import { webhookQueue } from "../jobs/queue.js";
import { createLogger } from "../logger.js";

const log = createLogger("webhook");
export const webhookRouter = Router();

webhookRouter.post("/webhooks/razorpay", async (req: Request, res: Response) => {
  const config = getConfig();

  // Get raw body (express.raw middleware should have captured it)
  const body = req.body;
  const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));

  // Verify signature
  const signature = req.headers["x-razorpay-signature"] as string;
  if (!signature) {
    res.status(400).json({ error: "Missing signature" });
    return;
  }

  const expected = crypto
    .createHmac("sha256", config.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))) {
    log.warn("Invalid webhook signature");
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  // Parse and extract event
  const event = JSON.parse(rawBody.toString());
  const eventId = event.payload?.payment?.entity?.id || event.payload?.payment_link?.entity?.id || crypto.randomUUID();

  // Enqueue for async processing
  await webhookQueue.add("process", {
    event_id: eventId,
    payload: rawBody.toString(),
  });

  log.info({ eventId, type: event.event }, "Webhook received, enqueued");
  res.json({ status: "ok" });
});
