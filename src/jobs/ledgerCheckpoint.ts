import { createWorker } from "./queue.js";
import { createCheckpoint } from "../lib/auditLedger.js";
import { createLogger } from "../logger.js";

const log = createLogger("ledgerCheckpoint");

export const ledgerCheckpointWorker = createWorker("ledger-checkpoint", async () => {
  const checkpointId = await createCheckpoint();
  log.info({ checkpointId }, "Ledger checkpoint created");
});
