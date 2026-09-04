import { query } from "../db.js";
import { createLogger } from "../logger.js";

const log = createLogger("policy2");

// Quiet hours: 21:00 - 09:00 IST
const QUIET_START_HOUR = 21;
const QUIET_END_HOUR = 9;

/**
 * Check if current time is within quiet hours (IST).
 * Returns { deferred: boolean, resumeAt: Date | null }
 */
export function checkQuietHours(): { deferred: boolean; resumeAt: Date | null } {
  if (process.env.RAZORPAY_MODE === 'test') return { deferred: false, resumeAt: null };
  const now = new Date();
  // Convert to IST (UTC+5:30)
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istTime = new Date(now.getTime() + istOffset);
  const hour = istTime.getUTCHours();

  if (hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR) {
    // Calculate next 09:01 IST
    const resume = new Date(istTime);
    resume.setUTCHours(QUIET_END_HOUR, 1, 0, 0);
    if (resume <= istTime) {
      resume.setUTCDate(resume.getUTCDate() + 1);
    }
    // Convert back to UTC
    const resumeUtc = new Date(resume.getTime() - istOffset);
    return { deferred: true, resumeAt: resumeUtc };
  }

  return { deferred: false, resumeAt: null };
}

/**
 * Check 30-day incentive cap: at most 1 incentivized touch per customer per 30 days.
 * Returns true if BLOCKED.
 */
export async function checkIncentiveCap30d(customerId: string): Promise<boolean> {
  if (!customerId) return false;

  const { rows } = await query(
    `SELECT COUNT(*) as cnt FROM touches
     WHERE customer_id = $1
     AND day >= TO_CHAR(CURRENT_DATE - INTERVAL '30 days', 'YYYY-MM-DD')
     AND count > 0`,
    [customerId]
  );

  // Check if any touch in last 30 days had an incentive
  const { rows: incentiveRows } = await query(
    `SELECT COUNT(*) as cnt FROM payment_links
     WHERE customer_id = $1
     AND incentive_paise > 0
     AND status = 'paid'
     AND paid_at >= NOW() - INTERVAL '30 days'`,
    [customerId]
  );

  return Number(incentiveRows[0]?.cnt || 0) >= 1;
}

/**
 * N3 (v4.2): lifetime incentive cap per identity.
 * incentive_per_identity_lifetime: {max_count: 3, max_total_paise: 30000}.
 * Counts SETTLED (paid) incentivized links across every customer row sharing
 * the identity_hash, so re-identifying as a "new" customer does not reset it.
 * Shipping-address velocity is ROADMAP (no fulfillment data held) — see residuals.
 */
export const LIFETIME_INCENTIVE_MAX_COUNT = 3;
export const LIFETIME_INCENTIVE_MAX_TOTAL_PAISE = 30000;

export async function checkIncentiveLifetime(
  customerId: string
): Promise<{ capped: boolean; count: number; totalPaise: number }> {
  const empty = { capped: false, count: 0, totalPaise: 0 };
  if (!customerId) return empty;

  const { rows } = await query(
    `SELECT COUNT(*) as cnt, COALESCE(SUM(pl.incentive_paise), 0) as total
     FROM payment_links pl
     JOIN customers c ON c.id = pl.customer_id
     WHERE c.identity_hash = (SELECT identity_hash FROM customers WHERE id = $1)
     AND pl.incentive_paise > 0
     AND pl.status = 'paid'`,
    [customerId]
  );

  const count = Number(rows[0]?.cnt || 0);
  const totalPaise = Number(rows[0]?.total || 0);
  return {
    capped: count >= LIFETIME_INCENTIVE_MAX_COUNT || totalPaise >= LIFETIME_INCENTIVE_MAX_TOTAL_PAISE,
    count,
    totalPaise,
  };
}

/**
 * Check first-touch rule: customer with zero prior touches gets Rs.0 bucket only.
 * Returns the max allowed incentive (0 for first touch, Infinity otherwise).
 */
export async function getMaxIncentiveForFirstTouch(customerId: string): Promise<number> {
  if (!customerId) return Infinity;

  const { rows } = await query(
    "SELECT COUNT(*) as cnt FROM touches WHERE customer_id = $1",
    [customerId]
  );

  const totalTouches = Number(rows[0]?.cnt || 0);
  // First touch = zero prior touches
  return totalTouches === 0 ? 0 : Infinity;
}

/**
 * Check consent: no customer touch without marketing opt_in.
 * Returns true if BLOCKED.
 */
export async function checkConsent(customerId: string): Promise<boolean> {
  if (!customerId) return false;

  const { rows } = await query(
    "SELECT consent_json FROM customers WHERE id = $1",
    [customerId]
  );

  if (!rows[0]) return false;
  const consent = rows[0].consent_json;
  return consent?.marketing_opt_in !== true;
}
