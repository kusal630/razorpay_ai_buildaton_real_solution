import crypto from "node:crypto";
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { getPool, closePool } from "./db.js";
import { runMigrations } from "./migrate.js";
import { createLogger } from "./logger.js";
import { healthRouter } from "./routes/health.js";
import { opsRouter } from "./routes/ops.js";
import { protocolRouter } from "./routes/protocol.js";
import { trackRouter } from "./routes/track.js";
import { webhookRouter } from "./routes/webhooks.js";
import { chatRouter } from "./routes/chat.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = createLogger("server");

async function main() {
  const config = loadConfig();
  log.info({ mode: config.RAZORPAY_MODE, role: config.PROCESS_ROLE }, "Starting Sellable v3");

  // Run migrations on boot
  const client = await getPool().connect();
  try {
    await runMigrations(client);
    log.info("Migrations complete");
  } finally {
    client.release();
  }

  const app = express();

  // Security headers
  app.use(helmet({ contentSecurityPolicy: false }));

  // Raw body for webhook signature verification
  app.use("/webhooks", express.raw({ type: "application/json" }));

  // JSON parsing for all other routes
  app.use(express.json());
  app.use(cookieParser(config.SESSION_SECRET));

  // Request ID middleware
  app.use((req, _res, next) => {
    (req as any).requestId = crypto.randomUUID();
    next();
  });

  // Routes
  app.use(healthRouter);
  app.use(protocolRouter);
  app.use(trackRouter);
  app.use(webhookRouter);
  app.use(chatRouter);
  app.use(opsRouter);

  // Static files
  app.use("/public", express.static(path.join(__dirname, "..", "src", "public")));

  // Start server
  const server = app.listen(config.PORT, () => {
    log.info({ port: config.PORT }, "Server listening");
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info({ signal }, "Shutting down gracefully");
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  log.error(err, "Fatal startup error");
  process.exit(1);
});
