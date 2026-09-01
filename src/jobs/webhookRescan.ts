import { createWorker, webhookQueue } from "./queue.js";
import { query } from "../db.js";
import { createLogger } from "../logger.js";

const log = createLogger("webhookRescan");

// C4: Re-enqueue stale webhooks after REENQUEUE_AFTER (default 5 minutes)
const REENQUEUE_AFTER_MS = 5 * 60 * 1000;

/**
 * C4: Janitor duty - scan for stale webhooks and re-enqueue.
 * Runs periodically (every minute in production).
 */
export async function rescanStaleWebhooks(): Promise<number> {
  const cutoff = new Date(Date.now() - REENQUEUE_AFTER_MS);

  const { rows: staleEvents } = await query(
    `SELECT event_id, payload_json
     FROM webhook_events
     WHERE status IN ('pending', 'received')
       AND created_at < $1
     ORDER BY created_at
     LIMIT 100`,
    [cutoff]
  );

  let requeued = 0;

  for (const event of staleEvents) {
    try {
      // C4: Idempotent resolution prevents double effects
      const { rows: existing } = await query(
        "SELECT event_id FROM webhook_events WHERE event_id = $1 AND status = 'processing'",
        [event.event_id]
      );

      if (existing[0]) {
        log.debug({ eventId: event.event_id }, "Already processing, skipping");
        continue;
      }

      // Re-enqueue with original payload
      await webhookQueue.add(
        "webhook-processing",
        {
          event_id: event.event_id,
          payload: event.payload_json,
        },
        {
          jobId: `webhook-rescan-${event.event_id}`,
          removeOnComplete: true,
          removeOnFail: false,
        }
      );

      // Mark as re-enqueued
      await query(
        `UPDATE webhook_events SET status = 're-enqueued', last_error = 'rescan_reenqueue'
         WHERE event_id = $1 AND status IN ('pending', 'received')`,
        [event.event_id]
      );

      requeued++;
      log.debug({ eventId: event.event_id }, "Webhook re-enqueued");
    } catch (err: any) {
      log.error({ eventId: event.event_id, error: err.message }, "Failed to re-enqueue webhook");
    }
  }

  if (requeued > 0) {
    log.info({ requeued }, "Stale webhooks re-enqueued");
  }

  return requeued;
}

/**
 * C4: Start periodic rescan (for production use).
 */
export function startWebhookRescan(intervalMs: number = 60_000): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      await rescanStaleWebhooks();
    } catch (err: any) {
      log.error({ error: err.message }, "Webhook rescan failed");
    }
  }, intervalMs);
}
