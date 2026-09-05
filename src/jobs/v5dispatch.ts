/**
 * v5dispatch.ts — scheduler-cycle jobs for v5 machinery. All best-effort:
 * a single failure never breaks the 15s loop (each block try/catches).
 */
import { query } from "../db.js";
import { appendLedger } from "../lib/ledger.js";
import { appendActivity } from "../lib/activity.js";
import { createLogger } from "../logger.js";

const log = createLogger("v5dispatch");
const MERCHANT_ID = "5a3ac6ce-b2c7-4b1f-a9db-45296841f30b";

/** M29 backstop: crash between opt-out write and in-request cancel. */
export async function sweepRevocations(): Promise<{ cancelled: number }> {
  const r = await query(
    `UPDATE action_intents ai SET status = 'cancelled', lease_expires_at = NULL
      WHERE ai.status IN ('pending', 'deferred')
      AND EXISTS (
        SELECT 1 FROM consent_events ce
        WHERE ce.customer_id = ai.customer_id
        AND ce.opt_in = false AND ce.created_at > NOW() - INTERVAL '5 minutes'
      )`
  );
  return { cancelled: (r as any).rowCount ?? 0 };
}

/** M11: fire due reminders; cart-paid revalidation cancels. */
export async function dispatchReminders(): Promise<{ fired: number; cancelled: number }> {
  const { rows: due } = await query(
    "SELECT id, merchant_id, customer_id, cart_id FROM reminders WHERE status = 'scheduled' AND fire_at <= NOW() LIMIT 25"
  );
  let fired = 0, cancelled = 0;
  for (const rem of due) {
    const paid = await query(
      "SELECT 1 FROM payment_links WHERE cart_id = $1 AND status = 'paid' UNION SELECT 1 FROM orders WHERE cart_id = $1 AND status = 'paid' LIMIT 1",
      [rem.cart_id]
    );
    if (paid.rows.length > 0) {
      await query("UPDATE reminders SET status = 'cancelled' WHERE id = $1", [rem.id]);
      cancelled++;
      continue;
    }
    await query("UPDATE reminders SET status = 'fired' WHERE id = $1", [rem.id]);
    await appendActivity({
      merchant_id: rem.merchant_id || MERCHANT_ID, actor: "RecoveryBot", type: "REMINDER_FIRED",
      summary: "Customer-chosen reminder fired (web surface)",
      data: { reminder_id: rem.id, cart_id: rem.cart_id },
    });
    fired++;
  }
  return { fired, cancelled };
}

/** M12: price-watch fires only on a real catalog drop + marketing consent. */
export async function dispatchPriceWatches(): Promise<{ fired: number }> {
  const { rows: open } = await query(
    "SELECT w.id, w.merchant_id, w.customer_id, w.product_id, w.watched_price_paise FROM price_watches w WHERE w.status = 'open' LIMIT 25"
  );
  let fired = 0;
  for (const w of open) {
    const prod = await query("SELECT price_paise FROM products WHERE id = $1", [w.product_id]);
    const current = prod.rows[0] != null ? Number(prod.rows[0].price_paise) : null;
    if (current == null || current >= Number(w.watched_price_paise)) continue;
    const consent = await query(
      "SELECT consent_marketing FROM customers WHERE id = $1", [w.customer_id]
    );
    let opted = false;
    try { opted = (consent.rows[0]?.consent_marketing as any)?.opt_in === true; } catch { opted = false; }
    if (!opted) continue;
    await query("UPDATE price_watches SET status = 'fired' WHERE id = $1", [w.id]);
    await appendActivity({
      merchant_id: w.merchant_id || MERCHANT_ID, actor: "SaveBot", type: "PRICE_PING",
      summary: "Price-drop ping fired (marketing-gated, real catalog change)",
      data: { watch_id: w.id, product_id: w.product_id, from: Number(w.watched_price_paise), to: current },
    });
    fired++;
  }
  return { fired };
}

/** M8: review requests due (delay_days after paid, one per order lifetime). */
export async function dispatchReviewRequests(): Promise<{ requested: number }> {
  const cfg = await query(
    "SELECT value_jsonb FROM merchant_config WHERE merchant_id = $1 AND key = 'review_request'", [MERCHANT_ID]
  ).catch(() => ({ rows: [] as any[] }));
  const conf = cfg.rows[0]?.value_jsonb;
  if (!conf?.enabled) return { requested: 0 };
  const delay = Number(conf.delay_days ?? 7);
  const { rows: due } = await query(
    `SELECT o.id AS order_id, o.customer_id FROM orders o
      WHERE o.status = 'paid' AND o.paid_at <= NOW() - ($1 || ' days')::interval
      AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.order_id = o.id::text)
      LIMIT 10`,
    [String(delay)]
  );
  let requested = 0;
  for (const o of due) {
    const token = (await import("node:crypto")).randomBytes(16).toString("hex");
    await query(
      "INSERT INTO reviews (merchant_id, product_id, customer_id, order_id, token) VALUES ($1, '', $2, $3, $4)",
      [MERCHANT_ID, o.customer_id, String(o.order_id), token]
    );
    await appendLedger({
      merchantId: MERCHANT_ID, actor: "ReviewBot", action: "review_requested",
      params: { order_id: String(o.order_id) }, decision: "ALLOW",
      policy_checks: { consent_class: "transactional", per_order_once: true },
      rationale: { reason: "post-delivery window elapsed; one transactional request" },
      outcome: "SUCCESS",
    } as any);
    try {
      const { emitMessageSent } = await import("../lib/messageStream.js");
      await emitMessageSent({
        merchantId: MERCHANT_ID, actor: "ReviewBot", channel: "review",
        messageCopy: "How was your order? A quick rating helps other shoppers like you.",
        messageStrategy: "social_proof", brainMode: "rules",
        cartOrOrderRef: String(o.order_id), resolvedTokens: [],
        customerId: o.customer_id || null,
      });
    } catch { /* stream never blocks dispatch */ }
    requested++;
  }
  return { requested };
}

/** T3: hourly conversion-collapse watch (throttled; idempotent while suspended). */
let lastFunnelRun = 0;
export async function runFunnelWatch(): Promise<{ fired: boolean }> {
  if (Date.now() - lastFunnelRun < 3600_000) return { fired: false };
  lastFunnelRun = Date.now();
  const { detectCollapse, readFunnelWindow, suspendRecovery, resumeRecovery, isRecoverySuspended } =
    await import("../lib/v5funnel.js");
  const { rows: merchants } = await query("SELECT id FROM merchants");
  let fired = false;
  for (const m of merchants) {
    const mid = m.id;
    try {
      const window = await readFunnelWindow(query, mid);
      const suspended = await isRecoverySuspended(query, mid);
      if (!suspended) {
        const verdict = detectCollapse(window);
        if (verdict.fired) {
          const { appendLedger } = await import("../lib/ledger.js");
          const { appendActivity } = await import("../lib/activity.js");
          await suspendRecovery(
            { q: query, ledgerAppend: (e) => (appendLedger as any)(e), activityAppend: appendActivity },
            mid, verdict.reason || "funnel anomaly"
          );
          fired = true;
        }
      } else if (window.converts2h > 0) {
        const { appendLedger } = await import("../lib/ledger.js");
        const { appendActivity } = await import("../lib/activity.js");
        await resumeRecovery(
          { q: query, ledgerAppend: (e) => (appendLedger as any)(e), activityAppend: appendActivity },
          mid, "auto"
        );
      }
    } catch (err: any) {
      log.warn({ merchant: mid, error: err?.message }, "Funnel watch failed for merchant");
    }
  }
  return { fired };
}

/** Single entry: runs every scheduler pass, never throws. */
export async function runV5Dispatch(): Promise<void> {
  for (const [name, fn] of [
    ["revocations", sweepRevocations],
    ["reminders", dispatchReminders],
    ["priceWatches", dispatchPriceWatches],
    ["reviews", dispatchReviewRequests],
    ["funnelWatch", runFunnelWatch],
  ] as const) {
    try {
      const r = await (fn as () => Promise<unknown>)();
      void r;
    } catch (err: any) {
      log.warn({ job: name, error: err?.message }, "v5 dispatch job failed (next pass retries)");
    }
  }
}
