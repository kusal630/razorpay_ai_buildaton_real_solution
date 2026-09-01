import { createWorker } from "./queue.js";
import { query } from "../db.js";
import { createLogger } from "../logger.js";

const log = createLogger("retention");

export const retentionWorker = createWorker("retention", async () => {
  // Clean up old data
  await query("DELETE FROM dead_letters WHERE created_at < NOW() - INTERVAL '30 days'");
  await query("DELETE FROM webhook_events WHERE received_at < NOW() - INTERVAL '30 days'");
  await query("DELETE FROM idempotency WHERE created_at < NOW() - INTERVAL '7 days'");
  log.info("Retention cleanup complete");
});
