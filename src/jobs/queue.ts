import { Worker, Queue } from "bullmq";
import { createLogger } from "../logger.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const log = createLogger("bullmq");

let connection: any = null;

export function getConnection(): any {
  if (!connection) {
    const Redis = require("ioredis");
    connection = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
      maxRetriesPerRequest: null,
    });
  }
  return connection;
}

export function createQueue(name: string): Queue {
  return new Queue(name, { connection: getConnection() });
}

export function createWorker(
  name: string,
  handler: (job: any) => Promise<void>
): Worker {
  const worker = new Worker(
    name,
    async (job) => {
      try {
        await handler(job);
      } catch (err: any) {
        log.error({ job: job.name, error: err.message }, "Worker error");
        throw err;
      }
    },
    { connection: getConnection(), concurrency: 5 }
  );

  worker.on("failed", (job, err) => {
    log.error({ job: job?.name, error: err.message, attempt: job?.attemptsMade }, "Job failed");
  });

  worker.on("completed", (job) => {
    log.debug({ job: job.name }, "Job completed");
  });

  return worker;
}

export const webhookQueue = createQueue("webhook-processing");
export const cartScanQueue = createQueue("cart-scan");
export const paymentPollQueue = createQueue("payment-poll");
export const reconcileQueue = createQueue("reconcile");
export const holdSweepQueue = createQueue("hold-sweep");
export const statsRollupQueue = createQueue("stats-rollup");
export const ledgerCheckpointQueue = createQueue("ledger-checkpoint");
export const retentionQueue = createQueue("retention");
export const intentJanitorQueue = createQueue("intent-janitor");
