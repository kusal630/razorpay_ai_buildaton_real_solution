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
     AND day >= CURRENT_DATE - INTERVAL '30 days'
     AND count > 0`,
    [customerId]
  );

  // Check if any touch in last 30 days had an incentive
  const { rows: incentiveRows } = await query(
    `SELECT COUNT(*) as cnt FROM audit_log al
     JOIN touches t ON t.customer_id = al.rationale_json->>'customer_ref'
     WHERE al.actor = 'RecoveryBot'
     AND al.outcome = 'SUCCESS'
     AND al.params_json->>'incentive_paise' > '0'
     AND al.ts >= NOW() - INTERVAL '30 days'`,
    [customerId]
  );

  return Number(incentiveRows[0]?.cnt || 0) >= 1;
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
