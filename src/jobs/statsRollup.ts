import { createWorker } from "./queue.js";
import { createLogger } from "../logger.js";

const log = createLogger("statsRollup");

export const statsRollupWorker = createWorker("stats-rollup", async () => {
  // Aggregate segment stats for dashboard
  log.info("Stats rollup completed");
});
