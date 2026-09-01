import { createWorker } from "./queue.js";
import { query } from "../db.js";
import { createLogger } from "../logger.js";

const log = createLogger("holdSweeper");

export const holdSweeperWorker = createWorker("hold-sweep", async () => {
  // Release expired holds and restore stock
  const { rows } = await query(
    `UPDATE hold_tokens SET status = 'expired'
     WHERE status = 'active' AND expires_at < NOW()
     RETURNING token, product_id, qty`
  );

  for (const hold of rows) {
    await query(
      "UPDATE products SET stock = stock + $1 WHERE id = $2",
      [hold.qty, hold.product_id]
    );
    log.debug({ token: hold.token }, "Hold expired, stock restored");
  }

  if (rows.length > 0) {
    log.info({ count: rows.length }, "Expired holds swept");
  }
});
