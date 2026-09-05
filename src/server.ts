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
import { v5Router } from "./routes/v5.js";
import { subscribeActivityFeed } from "./lib/activity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = createLogger("server");

async function main() {
  const config = loadConfig();
  log.info({ mode: config.RAZORPAY_MODE, role: config.PROCESS_ROLE }, "Starting Sellable v3");

  // Sync kill-switch state from DB (fail-open: brain live if table missing)
  try {
    const { syncKillSwitchFromDb } = await import("./lib/sharedBrain.js");
    const ks = await syncKillSwitchFromDb(async (sql: string) => getPool().query(sql));
    log.info({ killSwitch: ks }, "Kill switch state synced");
  } catch (err: any) {
    log.warn({ error: err.message }, "Kill switch sync failed (brain live)");
  }

  // G4 (v4.3): failure-retry columns (out-of-band schema helper).
  try {
    const { ensureFailureColumns } = await import("./agents/failureRetryBot.js");
    await ensureFailureColumns();
  } catch (err: any) {
    log.warn({ error: err.message }, "Failure columns ensure failed (non-critical)");
  }

  if (process.env.SKIP_MIGRATIONS === "true") {
    log.info("SKIP_MIGRATIONS=true — schema managed out-of-band, skipping runMigrations");
  } else {
    const client = await getPool().connect();
    try {
      await runMigrations(client);
      log.info("Migrations complete");
    } finally {
      client.release();
    }
  }

  // Data-mode schema (LIVE/DEMO toggle + source tags). Idempotent;
  // covers SKIP_MIGRATIONS / out-of-band schemas.
  try {
    const { ensureDataModeSchema } = await import("./lib/dataMode.js");
    await ensureDataModeSchema();
  } catch (err: any) {
    log.warn({ error: err.message }, "Data-mode schema ensure failed (toggle may be unavailable)");
  }

  // First-boot auto-seed: empty merchants table + test mode only.
  // DB-direct seed.ts first (history/catalog, no HTTP needed), then the
  // API-path identity bind once listening (same code as npm run seed-bind,
  // idempotent — reruns are no-ops). NEVER in live mode.
  let autoSeeded = false;
  if (config.RAZORPAY_MODE !== "live") {
    try {
      const { query } = await import("./db.js");
      const { rows } = await query("SELECT count(*)::int AS n FROM merchants");
      if (Number(rows[0]?.n || 0) === 0) {
        log.info("Empty database detected — running first-boot seed (seed.ts)");
        const { execFileSync } = await import("node:child_process");
        execFileSync("npx", ["tsx", "--env-file=.env", "seed.ts"], { stdio: "inherit" });
        autoSeeded = true;
      }
    } catch (err: any) {
      log.warn({ error: err.message }, "Auto-seed check failed (boot continues unseeded)");
    }
  }

  const app = express();
  app.use(helmet({ contentSecurityPolicy: false }));

  app.use("/webhooks", express.raw({ type: "application/json" }));
  app.use(express.json());
  app.use(cookieParser(config.SESSION_SECRET));

  app.use((req, _res, next) => {
    (req as any).requestId = crypto.randomUUID();
    next();
  });

  // SSE Activity Feed endpoint (public for dashboard)
  app.get("/api/feed", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("data: {\"type\":\"connected\"}\n\n");
    const unsub = subscribeActivityFeed(res);
    req.on("close", () => unsub());
  });

  app.use(healthRouter);
  app.use(protocolRouter);
  app.use(trackRouter);
  app.use(webhookRouter);
  app.use(chatRouter);
  app.use(opsRouter);
  app.use(v5Router);

  app.use("/public", express.static(path.join(__dirname, "..", "src", "public")));

  // Safety net: a single bad route must never take down the scheduler loop
  process.on("unhandledRejection", (reason: any) => {
    log.error({ error: reason?.message || String(reason) }, "Unhandled rejection (server kept alive)");
  });

  const server = app.listen(config.PORT, () => {
    log.info({ port: config.PORT }, "Server listening");
    if (autoSeeded && config.RAZORPAY_MODE !== "live") {
      // Identity bind through the REAL ingestion endpoint (detached —
      // never blocks boot; failures only log, the DB seed stands alone).
      void (async () => {
        try {
          const { execFileSync } = await import("node:child_process");
          execFileSync(process.execPath, ["--env-file=.env", "scripts/seed-bind.js"], { stdio: "inherit" });
          log.info("First-boot API identity bind complete");
        } catch (err: any) {
          log.warn({ error: err?.message }, "First-boot API bind failed (run npm run seed-bind manually)");
        }
      })();
    }
  });

  // Start scheduler loop (15s interval)
  if (config.PROCESS_ROLE === "all" || config.PROCESS_ROLE === "worker") {
    startScheduler();

    // LIVE data mode: resume the organic traffic simulator across restarts.
    try {
      const { getDataMode } = await import("./lib/dataMode.js");
      if ((await getDataMode()).mode === "live") {
        const { startLiveTraffic } = await import("./lib/liveTraffic.js");
        await startLiveTraffic();
      }
    } catch (err: any) {
      log.warn({ error: err.message }, "Live traffic autostart failed (toggle it manually)");
    }

    // S4 (v4.2): hourly refund-anomaly alarm (alarm only, never blocks)
    const runRefundAlarm = async () => {
      try {
        const { checkRefundAnomaly } = await import("./lib/refundAlarm.js");
        const { fired } = await checkRefundAnomaly();
        if (fired.length > 0) log.warn({ fired: fired.length }, "Refund anomaly alarm fired");
      } catch (err: any) {
        log.error({ error: err.message }, "Refund alarm check failed");
      }
    };
    void runRefundAlarm();
    setInterval(runRefundAlarm, 3600 * 1000);

    // G8 (v4.3): nightly social-proof recompute (read-only gateway scan).
    const runSocialProof = async () => {
      try {
        const { computeSocialProof } = await import("./lib/socialProof.js");
        await computeSocialProof();
      } catch (err: any) {
        log.error({ error: err.message }, "Social proof job failed");
      }
    };
    void runSocialProof();
    setInterval(runSocialProof, 24 * 3600 * 1000);
  }

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

function startScheduler() {
  log.info("Starting 15s scheduler loop");
  let tickSeq = 0;
  let tickInFlight = 0;
  setInterval(async () => {
    const tickId = ++tickSeq;
    // Single-flight: a tick that overruns its 15s window must NOT overlap
    // the next one. Overlapping ticks process the same carts concurrently,
    // interleave ledger appends/resolves (non-tip resolutions abort on the
    // append-only trigger), and re-fire the same triggers seconds apart —
    // the second sustaining mechanism of the DEMO console flood. The skip
    // is logged so a chronically-overrunning loop stays visible.
    if (tickInFlight > 0) {
      log.warn({ tickId, inFlight: tickInFlight }, "Scheduler tick skipped — previous tick still running");
      return;
    }
    tickInFlight++;
    const tickStart = Date.now();
    try {
      const { query } = await import("./db.js");
      const config = (await import("./config.js")).getConfig();

      // Demo-bg sub-toggle: silenced background carts are invisible to all
      // scans (in-flight intents drain; no NEW chains start for them).
      // Demo quarantine: in DEMO mode the scheduler additionally ignores
      // 'live'-tagged carts — simulator output belongs to live mode, and
      // demo must go quiet after its 12 stories fire (U-DEMOQUIET).
      let bgClause = "";
      let liveClause = "";
      let liveClauseC = "";
      try {
        const { getDataMode } = await import("./lib/dataMode.js");
        const dm = await getDataMode();
        if (!dm.demo_bg_enabled) bgClause = "AND COALESCE(source_tag,'demo') <> 'demo-bg' ";
        if (dm.mode === "demo") {
          liveClause = "AND COALESCE(source_tag,'demo') <> 'live' ";
          liveClauseC = "AND COALESCE(c.source_tag,'demo') <> 'live' ";
        }
      } catch { /* fail open: scans run unfiltered */ }
      const bgClauseC = bgClause ? "AND COALESCE(c.source_tag,'demo') <> 'demo-bg' " : "";
      const demoClause = liveClause;
      const demoClauseC = liveClauseC;

      // H4 guard: scans only hand ACTIONABLE carts to the agents — identity
      // present + a valid transactional anchor, the exact predicate
      // processAbandonedCart enforces. Consent-less/anonymous carts used to
      // be re-selected on every pass, emitting TRIGGER_DETECTED +
      // DUPLICATE_SKIPPED forever with zero progress (the DEMO-mode
      // console flood: ~36 events/15s). Filtering here stops generation at
      // the source; the in-agent skip paths stay as a one-off safety net.
      // Consent is dynamic: a cart becomes selectable as soon as its
      // customer gains an anchor (bind/checkout-start anchor it now).
      const { checkTransactionalConsent } = await import("./lib/consent.js");
      const actionableCartIds = async (
        rows: Array<{ id: string; customer_id: string | null }>
      ): Promise<Set<string>> => {
        const ok = new Set<string>();
        for (const r of rows) {
          if (!r.customer_id) continue;
          try {
            if (await checkTransactionalConsent(r.customer_id)) ok.add(r.id);
          } catch { /* one bad row never breaks the scan */ }
        }
        return ok;
      };

      // Find abandoned carts
      const abandonMinutes = config.ABANDON_MINUTES;
      const { rows: carts } = await query(
         `UPDATE carts SET status = 'abandoned', abandoned_at = COALESCE(abandoned_at, NOW())
          WHERE status = 'active'
          AND updated_at < NOW() - INTERVAL '${abandonMinutes} minutes'
          ${bgClause}
          ${demoClause}
          RETURNING id, customer_id`
      );

      if (carts.length > 0) {
        log.info({ count: carts.length }, "Carts marked as abandoned");
        const markedActionable = await actionableCartIds(carts);
        const { processAbandonedCart } = await import("./agents/recoveryBot.js");
        for (const cart of carts) {
          if (!markedActionable.has(cart.id)) continue;
          try {
            await processAbandonedCart(cart.id, { stage: "24h" });
          } catch (err: any) {
            log.error({ cartId: cart.id, error: err.message }, "Failed to process cart");
          }
        }
      }

      // R1 (v4.2) early window: abandoned ≥1h and <24h, ZERO touches ever.
      // Plain ₹0 first touch on the checkout anchor; the 24h pass later
      // evaluates incentives normally (separate intent via stage suffix).
      const { rows: earlyCarts } = await query(
        `SELECT c.id, c.customer_id FROM carts c
         WHERE c.status = 'abandoned'
         AND c.abandoned_at <= NOW() - INTERVAL '1 hour'
         AND c.abandoned_at > NOW() - INTERVAL '24 hours'
         AND c.customer_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM touches t WHERE t.customer_id = c.customer_id)
          AND NOT EXISTS (
            SELECT 1 FROM action_intents ai
            WHERE ai.dedupe_key LIKE '%:recovery_early:%'
            AND ai.dedupe_key LIKE '%' || c.id::text || '%'
          )
          ${bgClauseC}
          ${demoClauseC}
          LIMIT 10`
      );
      if (earlyCarts.length > 0) {
        log.info({ count: earlyCarts.length }, "Early-window carts found");
        const earlyActionable = await actionableCartIds(earlyCarts);
        const { processAbandonedCart } = await import("./agents/recoveryBot.js");
        const { isTouchAllowed } = await import("./lib/fatigue.js");
        for (const cart of earlyCarts) {
          if (!earlyActionable.has(cart.id)) continue;
          try {
            // G9: early requires zero touches ever, so fatigue cannot trigger
            // here yet — check anyway for uniformity (cheap, future-proof).
            const gate = await isTouchAllowed(cart.customer_id);
            if (!gate.allowed) {
              log.info({ cartId: cart.id, reason: gate.reason }, "Scheduler skipped fatigued cart");
              continue;
            }
            await processAbandonedCart(cart.id, { stage: "early" });
          } catch (err: any) {
            log.error({ cartId: cart.id, error: err.message }, "Failed to process early cart");
          }
        }
      }

      // Also scan existing abandoned carts that haven't been processed
      const { rows: unprocessed } = await query(
        `SELECT c.id, c.customer_id FROM carts c
         WHERE c.status = 'abandoned' AND c.abandoned_at < NOW() - INTERVAL '1 minute'
          AND NOT EXISTS (
            SELECT 1 FROM action_intents ai
            WHERE ai.dedupe_key LIKE '%' || c.id::text || '%'
          )
          ${bgClauseC}
          ${demoClauseC}
          LIMIT 10`
      );
      if (unprocessed.length > 0) {
        const unprocessedActionable = await actionableCartIds(unprocessed);
        const { processAbandonedCart } = await import("./agents/recoveryBot.js");
        const { isTouchAllowed } = await import("./lib/fatigue.js");
        for (const cart of unprocessed) {
          if (!unprocessedActionable.has(cart.id)) continue;
          try {
            // G9 (v4.3): fatigued identities sit out until spacing elapses.
            if (cart.customer_id) {
              const gate = await isTouchAllowed(cart.customer_id);
              if (!gate.allowed) {
                log.info({ cartId: cart.id, reason: gate.reason }, "Scheduler skipped fatigued cart");
                continue;
              }
            }
            await processAbandonedCart(cart.id, { stage: "24h" });
          } catch (err: any) {
            log.error({ cartId: cart.id, error: err.message, stack: err.stack?.split("\n").slice(0, 5).join("\n") }, "Failed to process unprocessed cart");
          }
        }
      }

      // G2 (v4.3) final-call scan: 24h link near/past its enforced expiry,
      // no final touch ever sent for this cart, cart still unpaid.
      const { rows: finalCarts } = await query(
        `SELECT c.id, c.customer_id FROM carts c
         WHERE c.status = 'abandoned'
         AND EXISTS (
           SELECT 1 FROM payment_links pl
           WHERE pl.cart_id::text = c.id::text
           AND pl.expire_by IS NOT NULL
           AND pl.expire_by <= NOW() + INTERVAL '12 hours'
         )
         AND NOT EXISTS (
           SELECT 1 FROM action_intents ai
           WHERE ai.target_id = c.id::text AND ai.action_type = 'recovery_final'
         )
         AND NOT EXISTS (
           SELECT 1 FROM payment_links pl2
           WHERE pl2.cart_id::text = c.id::text AND pl2.status = 'paid'
         )
          AND NOT EXISTS (
            SELECT 1 FROM orders o
            WHERE o.cart_id = c.id AND o.status = 'paid'
          )
          ${bgClauseC}
          ${demoClauseC}
          LIMIT 10`
      );
      if (finalCarts.length > 0) {
        log.info({ count: finalCarts.length }, "Final-call carts found");
        const finalActionable = await actionableCartIds(finalCarts);
        const { processFinalCall } = await import("./agents/recoveryBot.js");
        const { isTouchAllowed } = await import("./lib/fatigue.js");
        for (const cart of finalCarts) {
          if (!finalActionable.has(cart.id)) continue;
          try {
            // G9: the final call obeys the doubled window like any touch.
            if (cart.customer_id) {
              const gate = await isTouchAllowed(cart.customer_id);
              if (!gate.allowed) {
                log.info({ cartId: cart.id, reason: gate.reason }, "Scheduler skipped fatigued cart");
                continue;
              }
            }
            await processFinalCall(cart.id);
          } catch (err: any) {
            log.error({ cartId: cart.id, error: err.message }, "Failed final call");
          }
        }
      }

      // G4 (v4.3) failure-retry scan: failed >5min ago, never retried, still unpaid.
      const { rows: failedOrders } = await query(
        `SELECT o.id FROM orders o
         WHERE o.status = 'failed'
         AND COALESCE(o.failed_at, o.created_at) < NOW() - INTERVAL '5 minutes'
         AND COALESCE(o.failed_at, o.created_at) > NOW() - INTERVAL '24 hours'
         AND NOT EXISTS (
           SELECT 1 FROM action_intents ai
           WHERE ai.target_id = o.id::text AND ai.action_type = 'recovery_retry'
         )
         AND NOT EXISTS (
           SELECT 1 FROM payment_links pl
           WHERE pl.cart_id::text = o.cart_id::text AND pl.status IN ('live', 'paid')
         )
         LIMIT 10`
      );
      if (failedOrders.length > 0) {
        log.info({ count: failedOrders.length }, "Failed orders found");
        const { processFailedOrder } = await import("./agents/failureRetryBot.js");
        for (const o of failedOrders) {
          try {
            await processFailedOrder(o.id);
          } catch (err: any) {
            log.error({ orderId: o.id, error: err.message }, "Failed retry");
          }
        }
      }

      // G2 (v4.3) sweeper: release expired holds every pass (cheap when idle).
      try {
        const { sweepExpiredLinks } = await import("./lib/moneyBus.js");
        await sweepExpiredLinks();
      } catch (err: any) {
        log.error({ error: err.message }, "Sweeper error");
      }

      // Intent janitor: resume due deferred intents (quiet-hours chains
      // otherwise never wake), reset stale gateway waits, expire
      // past-window rows. The worker module is not loaded in this
      // process and Redis is down in this env, so the tick owns it —
      // previously it never ran anywhere (stale awaiting_gateway rows
      // dating back hours proved it).
      try {
        const { runJanitor } = await import("./lib/intentExecutor.js");
        await runJanitor();
      } catch (err: any) {
        log.error({ error: err.message }, "Janitor error");
      }

      // v5.0 dispatch: revocation backstop, reminders, price watches, reviews.
      try {
        const { runV5Dispatch } = await import("./jobs/v5dispatch.js");
        await runV5Dispatch();
      } catch (err: any) {
        log.error({ error: err.message }, "v5 dispatch error");
      }

      // Budget rollover: ensure today's row exists for every merchant.
      try {
        const { ensureTodayBudget } = await import("./lib/budget.js");
        await ensureTodayBudget();
      } catch (err: any) {
        log.error({ error: err.message }, "Budget rollover error");
      }

      // Poll payment links
      const { rows: liveLinks } = await query(
        `SELECT id, razorpay_link_id, merchant_id, cart_id, customer_id,
                amount_paise, incentive_paise, audit_seq
         FROM payment_links
         WHERE status = 'live' AND razorpay_link_id IS NOT NULL
         AND created_at > NOW() - INTERVAL '25 hours'
         LIMIT 50`
      );
      if (liveLinks.length > 0) {
        const { fetchPaymentLink, resolvePayment } = await import("./lib/moneyBus.js");
        for (const link of liveLinks) {
          try {
            const rpLink = await fetchPaymentLink(link.razorpay_link_id);
            if (rpLink.status === "paid") {
              await resolvePayment({
                id: link.id, merchant_id: link.merchant_id || "5a3ac6ce-b2c7-4b1f-a9db-45296841f30b",
                razorpay_link_id: link.razorpay_link_id, audit_seq: link.audit_seq,
                amount_paise: link.amount_paise, incentive_paise: link.incentive_paise,
                cart_id: link.cart_id, customer_id: link.customer_id,
              });
              log.info({ linkId: link.razorpay_link_id }, "Poller resolved as PAID");
            } else if (rpLink.status === "expired" || rpLink.status === "cancelled") {
              await query("UPDATE payment_links SET status = $1 WHERE id = $2", [rpLink.status, link.id]);
            }
          } catch (err: any) {
            log.error({ linkId: link.razorpay_link_id, error: err.message, status: err.statusCode, detail: err.error }, "Poller error");
          }
        }
      }
    } catch (err: any) {
      log.error({ error: err.message }, "Scheduler error");
    } finally {
      tickInFlight--;
      if (Date.now() - tickStart > 15000) {
        log.warn({ tickId, elapsedMs: Date.now() - tickStart }, "Scheduler tick overran its 15s window");
      }
    }
  }, 15000);
}

main().catch((err) => {
  log.error(err, "Fatal startup error");
  process.exit(1);
});
