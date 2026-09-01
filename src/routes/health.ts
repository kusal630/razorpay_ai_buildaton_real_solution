import { Router } from "express";
import { getPool } from "../db.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const healthRouter = Router();

healthRouter.get("/healthz", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

healthRouter.get("/readyz", async (_req, res) => {
  try {
    const pool = getPool();
    await pool.query("SELECT 1");
    const Redis = require("ioredis");
    const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
    await redis.ping();
    redis.disconnect();
    res.json({ status: "ready", db: "ok", redis: "ok" });
  } catch (err: any) {
    res.status(503).json({ status: "not ready", error: err.message });
  }
});
