import { createLogger } from "../logger.js";

const log = createLogger("economics");

/**
 * Constants - single source of truth for all EV calculations (N12).
 */
export const CONSTANTS = {
  PAYMENT_FEE_BPS: parseInt(process.env.PAYMENT_FEE_BPS || "200"), // 2%
  AI_COST_PER_ACTION_PAISE: parseInt(process.env.AI_COST_PER_ACTION_PAISE || "50"), // 50 paise
  MARGIN_PERCENT: 0.40, // 40% default margin
  THETA_0_PRIOR: 0.10, // Prior mean for Rs.0 bucket when n < 5
};

/**
 * Canonical incentive buckets (paise). Single source of truth — recovery,
 * chat-grant mapping, and stats all index this list. (v4.2 P7: 7500 added.)
 */
export const INCENTIVE_BUCKETS = [0, 5000, 7500, 10000, 15000];

/**
 * Map an arbitrary requested amount to the nearest bucket (ties go lower).
 */
export function nearestBucket(amountPaise: number, buckets: number[] = INCENTIVE_BUCKETS): number {
  let best = buckets[0];
  for (const b of buckets) {
    if (Math.abs(b - amountPaise) < Math.abs(best - amountPaise)) best = b;
    // ties keep the earlier (lower) bucket since list is ascending
  }
  return best;
}

/**
 * W1: Uplift-aware EV (N17):
 * inc_ev(b) = (theta_b - theta_0) * (margin_paise - fee_paise)
 *             - theta_b * incentive_b - delta_ai_cost
 *
 * Chooses argmax over buckets only if > 0;
 * else Rs.0 plain link if theta_0 * (margin - fee) - ai_cost > 0;
 * else ABSTAIN.
 */
export function upliftEv(params: {
  theta_b: number;
  theta_0: number;
  marginPaise: number;
  incentivePaise: number;
  aiCostPaise?: number;
}): { incEv: number; decision: "ACTION" | "PLAIN" | "ABSTAIN" } {
  const feePaise = Math.round(params.marginPaise * CONSTANTS.PAYMENT_FEE_BPS / 10000);
  const aiCost = params.aiCostPaise ?? CONSTANTS.AI_COST_PER_ACTION_PAISE;

  // Uplift EV: incremental profit vs Rs.0 action
  const incEv = (params.theta_b - params.theta_0) * (params.marginPaise - feePaise)
    - params.theta_b * params.incentivePaise
    - aiCost;

  if (incEv > 0) {
    return { incEv, decision: "ACTION" };
  }

  // Check if Rs.0 plain link is profitable
  const plainEv = params.theta_0 * (params.marginPaise - feePaise) - aiCost;
  if (plainEv > 0) {
    return { incEv, decision: "PLAIN" };
  }

  return { incEv, decision: "ABSTAIN" };
}

/**
 * Original EV formula (kept for backward compatibility).
 * EV = theta * (margin_paise - fee_paise - incentive_paise) - ai_cost_paise
 */
export function ev(params: {
  theta: number;
  marginPaise: number;
  incentivePaise: number;
  aiCostPaise?: number;
}): number {
  const feePaise = Math.round(params.marginPaise * CONSTANTS.PAYMENT_FEE_BPS / 10000);
  const aiCost = params.aiCostPaise ?? CONSTANTS.AI_COST_PER_ACTION_PAISE;

  return params.theta * (params.marginPaise - feePaise - params.incentivePaise) - aiCost;
}

/**
 * Calculate payment fee and net profit for an order.
 */
export function calculateProfitability(params: {
  amountPaise: number;
  marginPaise: number;
  incentivePaise: number;
}): { feePaise: number; netProfitPaise: number } {
  const feePaise = Math.round(params.amountPaise * CONSTANTS.PAYMENT_FEE_BPS / 10000);
  const netProfitPaise = params.marginPaise - params.incentivePaise - feePaise;
  return { feePaise, netProfitPaise };
}

/**
 * W1: Select best bucket using uplift-aware EV.
 * Returns { bucket, decision } where decision is "ACTION" (incentivize), "PLAIN" (Rs.0), or "ABSTAIN".
 */
export function selectBucket(params: {
  thetas: Record<number, number>;
  theta_0: number;
  marginPaise: number;
  aiCostPaise?: number;
}): { bucket: number; decision: "ACTION" | "PLAIN" | "ABSTAIN" } {
  let bestBucket = 0;
  let bestIncEv = -Infinity;

  for (const [bucketStr, theta_b] of Object.entries(params.thetas)) {
    const bucket = Number(bucketStr);
    const { incEv, decision } = upliftEv({
      theta_b,
      theta_0: params.theta_0,
      marginPaise: params.marginPaise,
      incentivePaise: bucket,
      aiCostPaise: params.aiCostPaise,
    });

    if (decision === "ACTION" && incEv > bestIncEv) {
      bestIncEv = incEv;
      bestBucket = bucket;
    }
  }

  // Check if best bucket is actionable
  const { decision: bestDecision } = upliftEv({
    theta_b: params.thetas[bestBucket] || 0,
    theta_0: params.theta_0,
    marginPaise: params.marginPaise,
    incentivePaise: bestBucket,
    aiCostPaise: params.aiCostPaise,
  });

  return { bucket: bestBucket, decision: bestDecision };
}
