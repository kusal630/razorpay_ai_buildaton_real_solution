import { query } from "../db.js";
import { createLogger } from "../logger.js";

const log = createLogger("fatigue");

/**
 * G9 (v4.3) engagement-fatigue rule.
 * Per identity: 2 consecutive proactive touches with no engagement (a pay
 * event — opens are not tracked, so payment is the engagement signal) double
 * the minimum spacing between subsequent touches (base 24h → 48h).
 * Reset on engagement. Computed fresh from touches + paid events (no extra
 * state table); logged in policy_checks as `fatigue`, enforced in the
 * scheduler scans. Direct agent calls (gates, QA) bypass enforcement but
 * still log — same split as quiet-hours observability.
 */
export const FATIGUE_MISS_THRESHOLD = 2;
export const FATIGUE_BASE_SPACING_HOURS = 24;

export interface FatigueState {
  consecutive_misses: number;
  multiplier: 1 | 2;
  last_touch_day: string | null;
}

function todayStr(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * 864e5).toISOString().slice(0, 10);
}

export async function getFatigueState(customerId: string): Promise<FatigueState> {
  const empty: FatigueState = { consecutive_misses: 0, multiplier: 1, last_touch_day: null };
  if (!customerId) return empty;

  const { rows: touchRows } = await query(
    `SELECT day, count FROM touches WHERE customer_id = $1 ORDER BY day DESC`,
    [customerId]
  );
  if (touchRows.length === 0) return empty;
  const lastTouchDay = String(touchRows[0].day).slice(0, 10);

  const { rows: payRows } = await query(
    `SELECT MAX(ts) as last_pay FROM (
       SELECT paid_at AS ts FROM orders WHERE customer_id = $1 AND status = 'paid'
       UNION ALL
       SELECT paid_at AS ts FROM payment_links WHERE customer_id = $1 AND status = 'paid'
     ) p`,
    [customerId]
  );
  const lastPay = payRows[0]?.last_pay ? new Date(payRows[0].last_pay) : null;

  // Misses = touches on days strictly after the last engagement day.
  // Day granularity: a touch shares its day with at most one pay event.
  let misses = 0;
  for (const t of touchRows) {
    const day = String(t.day).slice(0, 10);
    if (lastPay && day <= lastPay.toISOString().slice(0, 10)) break;
    misses += Number(t.count || 0);
  }

  return {
    consecutive_misses: misses,
    multiplier: misses >= FATIGUE_MISS_THRESHOLD ? 2 : 1,
    last_touch_day: lastTouchDay,
  };
}

/**
 * Scheduler enforcement: a fatigued identity (multiplier 2) may only be
 * touched again once 48h have passed since its last touch day.
 */
export async function isTouchAllowed(customerId: string): Promise<{ allowed: boolean; reason: string }> {
  const state = await getFatigueState(customerId);
  if (state.multiplier === 1 || !state.last_touch_day) {
    return { allowed: true, reason: "no_fatigue" };
  }
  // Day-granular: last touch yesterday or today is inside the doubled window.
  const cutoff = todayStr(-1);
  if (state.last_touch_day >= cutoff) {
    log.debug({ customerId: customerId.slice(0, 8), ...state }, "Touch suppressed by fatigue rule");
    return { allowed: false, reason: "fatigue_doubled_spacing" };
  }
  return { allowed: true, reason: "spacing_elapsed" };
}
