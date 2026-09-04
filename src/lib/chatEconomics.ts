import { query } from "../db.js";
import { upliftEv, nearestBucket, INCENTIVE_BUCKETS, CONSTANTS } from "./economics.js";
import { createLogger } from "../logger.js";

const log = createLogger("chatEconomics");

/**
 * N4 (v4.2): chat discounts are a MEASURED segment, not an assumed one.
 * Grants use the same uplift EV as recovery, with θ read from the
 * 'chat_requested' segment (its own learning loop, generic segment_stats rows).
 */
export const CHAT_SEGMENT = "chat_requested";
/** Minimum cart value for any chat grant (paise). */
export const CHAT_MIN_CART_PAISE = 100000; // ₹1,000

function laplaceTheta(successes: number, attempts: number): number {
  // Beta(s+1, n-s+1) posterior mean — same convention as recoveryBot sampleBeta.
  return (successes + 1) / (attempts + 2);
}

export interface ChatGrantInput {
  merchantId: string;
  requestedPaise: number;
  cartTotalPaise: number;
  marginPaise: number;
}

export interface ChatGrantResult {
  granted: boolean;
  bucket: number;
  theta: number;
  theta0: number;
  evPaise: number;
  reason: string;
}

/**
 * Decide a chat discount request on measured economics.
 * Buckets are the canonical incentive buckets; the request maps to nearest.
 */
export async function evaluateChatGrant(input: ChatGrantInput): Promise<ChatGrantResult> {
  const bucket = Math.min(nearestBucket(input.requestedPaise, INCENTIVE_BUCKETS), 15000);

  const { rows } = await query(
    `SELECT bucket, attempts, successes FROM segment_stats
     WHERE merchant_id = $1 AND segment = $2`,
    [input.merchantId, CHAT_SEGMENT]
  );
  const stats = new Map<number, { attempts: number; successes: number }>();
  for (const r of rows) {
    stats.set(Number(r.bucket), { attempts: Number(r.attempts), successes: Number(r.successes) });
  }
  const b = stats.get(bucket) || { attempts: 0, successes: 0 };
  const z = stats.get(0) || { attempts: 0, successes: 0 };
  const theta = laplaceTheta(b.successes, b.attempts);
  const theta0 = laplaceTheta(z.successes, z.attempts);

  const { incEv, decision } = upliftEv({
    theta_b: theta,
    theta_0: theta0,
    marginPaise: input.marginPaise,
    incentivePaise: bucket,
  });

  if (decision !== "ACTION") {
    return {
      granted: false, bucket, theta, theta0, evPaise: Math.round(incEv),
      reason: "chat_segment_ev_negative",
    };
  }
  return {
    granted: true, bucket, theta, theta0, evPaise: Math.round(incEv),
    reason: "chat_segment_ev_positive",
  };
}

/**
 * Record a chat ask (attempt) in the measured segment.
 */
export async function recordChatAttempt(merchantId: string, bucket: number): Promise<void> {
  await query(
    `INSERT INTO segment_stats (merchant_id, segment, bucket, attempts, successes)
     VALUES ($1, $2, $3, 1, 0)
     ON CONFLICT (merchant_id, segment, bucket)
     DO UPDATE SET attempts = segment_stats.attempts + 1`,
    [merchantId, CHAT_SEGMENT, bucket]
  );
  log.debug({ merchantId, bucket }, "Chat ask recorded");
}

/**
 * Record a chat success: called at payment resolution for links born from a
 * granted chat discount (identified via the audit rationale trigger).
 */
export async function recordChatSuccess(merchantId: string, bucket: number): Promise<void> {
  await query(
    `INSERT INTO segment_stats (merchant_id, segment, bucket, attempts, successes)
     VALUES ($1, $2, $3, 1, 1)
     ON CONFLICT (merchant_id, segment, bucket)
     DO UPDATE SET successes = segment_stats.successes + 1`,
    [merchantId, CHAT_SEGMENT, bucket]
  );
  log.debug({ merchantId, bucket }, "Chat success recorded");
}

export { CONSTANTS };
