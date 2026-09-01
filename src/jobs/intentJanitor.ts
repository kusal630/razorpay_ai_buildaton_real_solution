import { createWorker } from "./queue.js";
import { runJanitor } from "../lib/intentExecutor.js";
import { createLogger } from "../logger.js";

const log = createLogger("intentJanitor");

export const intentJanitorWorker = createWorker("intent-janitor", async () => {
  const resolved = await runJanitor();
  if (resolved > 0) {
    log.info({ resolved }, "Intent janitor resolved stuck intents");
  }
});
