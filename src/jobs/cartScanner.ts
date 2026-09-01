import { createWorker } from "./queue.js";
import { query } from "../db.js";
import { createLogger } from "../logger.js";

const log = createLogger("cartScanner");

export const cartScannerWorker = createWorker("cart-scan", async () => {
  const config = (await import("../config.js")).getConfig();
  const abandonMinutes = config.ABANDON_MINUTES;

  // Mark carts as abandoned
  const { rows } = await query(
    `UPDATE carts SET status = 'abandoned', abandoned_at = NOW()
     WHERE status = 'active'
     AND updated_at < NOW() - INTERVAL '${abandonMinutes} minutes'
     RETURNING id`
  );

  if (rows.length > 0) {
    log.info({ count: rows.length }, "Carts marked as abandoned");
  }

  // Process each abandoned cart through RecoveryBot
  const { processAbandonedCart } = await import("../agents/recoveryBot.js");
  for (const row of rows) {
    try {
      await processAbandonedCart(row.id);
    } catch (err: any) {
      log.error({ cartId: row.id, error: err.message }, "Failed to process abandoned cart");
    }
  }
});
