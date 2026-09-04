/**
 * v5decision.ts — Phase 1 (M2/M3/M4): typed incentive bandit + decision hygiene.
 * Pure logic (no DB) so gates are unit-testable. All money in integer paise.
 */

/** M2: cart segmentation. checkout_started is distinct from cart_only. */
export type CartSegment = "cart_only" | "checkout_started" | string;
export function segmentForCart(hasCheckoutStart: boolean, baseSegment = "cart_only"): CartSegment {
  return hasCheckoutStart ? "checkout_started" : baseSegment;
}

/** Seeded priors (labeled as such on dashboard). M2 + M3 seeds. */
export const SEEDED_PRIORS: Record<string, Record<string, number>> = {
  cart_only: { "cash:0": 0.10, "cash:10000": 0.34, "gwp:5900": 0.28 },
  checkout_started: { "cash:0": 0.15, "cash:10000": 0.40, "gwp:5900": 0.28 },
};

export function seededPrior(segment: string, optionKey: string): number {
  return SEEDED_PRIORS[segment]?.[optionKey] ?? SEEDED_PRIORS.cart_only[optionKey] ?? 0.10;
}

/** M3: typed incentive options. GWP value = COGS paise, never retail. */
export interface IncentiveOption {
  type: "cash" | "gwp" | "shipping";
  value_paise: number;
}
export const GWP_COGS_PAISE = 5900; // Cable Organizer cost ₹59
export const GWP_RETAIL_PAISE = 19900;

export function optionKey(o: IncentiveOption): string {
  return `${o.type}:${o.value_paise}`;
}

/**
 * M3 feasible-set rules: gwp requires gift stock > 0 AND gift not in cart.
 * Returns the feasible subset (order applied later by M17 arm reorder).
 */
export function feasibleOptions(params: {
  cartTotalPaise: number;
  cartProductIds: string[];
  giftProductId: string;
  giftStock: number;
  shippingFeePaise: number | null; // null = no shipping config (M13 absent)
}): IncentiveOption[] {
  const out: IncentiveOption[] = [
    { type: "cash", value_paise: 0 },
    { type: "cash", value_paise: 5000 },
    { type: "cash", value_paise: 10000 },
    { type: "cash", value_paise: 15000 },
  ];
  const giftInCart = params.cartProductIds.includes(params.giftProductId);
  if (params.giftStock > 0 && !giftInCart) {
    out.push({ type: "gwp", value_paise: GWP_COGS_PAISE });
  }
  if (params.shippingFeePaise != null && params.shippingFeePaise > 0) {
    out.push({ type: "shipping", value_paise: params.shippingFeePaise });
  }
  return out;
}

/** M17 arm reorder: shipping → gwp → cash (ascending within cash). */
export function reorderArms(options: IncentiveOption[]): IncentiveOption[] {
  const rank = (o: IncentiveOption) => (o.type === "shipping" ? 0 : o.type === "gwp" ? 1 : 2);
  return [...options].sort((a, b) => rank(a) - rank(b) || a.value_paise - b.value_paise);
}

/**
 * EV formula UNCHANGED (M3): inc_ev(b) = (θb−θ0)(margin−fee) − θb·b − ai_cost.
 * incentive cost = value_paise (COGS for gwp).
 */
export function incentiveEv(params: {
  theta_b: number; theta_0: number; marginPaise: number; feeBps?: number;
  incentivePaise: number; aiCostPaise?: number;
}): number {
  const fee = Math.round((params.marginPaise * (params.feeBps ?? 200)) / 10000);
  const ai = params.aiCostPaise ?? 50;
  return (params.theta_b - params.theta_0) * (params.marginPaise - fee)
    - params.theta_b * params.incentivePaise - ai;
}

/** Beta posterior mean with seeded prior (prior pseudo-counts n0=5: regularizes
 * tiny samples without distorting measured fixtures at n≥30). */
export function thetaPosterior(successes: number, attempts: number, priorMean: number, priorN = 5): number {
  return (successes + priorMean * priorN) / (attempts + priorN);
}

/**
 * M4a/H4a BUCKET WIN ELIGIBILITY: a bucket may win the incentivize rung only
 * if attempts ≥ 10 OR selected by this turn's exploration sampler; below
 * threshold θ reverts to the segment prior for rung comparison.
 */
export function eligibleTheta(params: {
  successes: number; attempts: number; priorMean: number;
  explorationPicked: boolean;
}): { theta: number; eligible: boolean } {
  if (params.attempts >= 10 || params.explorationPicked) {
    return { theta: thetaPosterior(params.successes, params.attempts, params.priorMean), eligible: true };
  }
  return { theta: params.priorMean, eligible: false };
}

/**
 * M4b/H4b CONSERVATIVE DIFFERENCE TEST: P(θb − θ0 > 0) ≥ 0.7 via normal
 * approximation over Beta posteriors (prior pseudo-counts n0=5).
 */
export function probBucketBeatsBaseline(params: {
  succ_b: number; n_b: number; succ_0: number; n_0: number;
  prior_b?: number; prior_0?: number; priorN?: number;
}): number {
  const n0 = params.priorN ?? 5;
  const pb = params.prior_b ?? 0.28, p0 = params.prior_0 ?? 0.10;
  const ab = params.succ_b + pb * n0, bb = params.n_b - params.succ_b + (1 - pb) * n0;
  const a0 = params.succ_0 + p0 * n0, b0 = params.n_0 - params.succ_0 + (1 - p0) * n0;
  const nb = ab + bb, n00 = a0 + b0;
  const mb = ab / nb, m0 = a0 / n00;
  const vb = (ab * bb) / (nb * nb * (nb + 1));
  const v0 = (a0 * b0) / (n00 * n00 * (n00 + 1));
  const se = Math.sqrt(vb + v0);
  if (se <= 0) return mb > m0 ? 1 : 0;
  const z = (mb - m0) / se;
  return normalCdf(z);
}

function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-(z * z) / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z > 0) p = 1 - p;
  return p;
}

/** Full rung decision: ACTION (with winning option) | PLAIN | ABSTAIN. */
export function decideRung(params: {
  segment: string;
  options: IncentiveOption[];
  stats: Record<string, { successes: number; attempts: number }>;
  baseline: { successes: number; attempts: number };
  explorationPicked?: string | null;
  marginPaise: number;
}): { decision: "ACTION" | "PLAIN" | "ABSTAIN"; winner: IncentiveOption | null; incEv: number; detail: Record<string, any> } {
  const theta0 = thetaPosterior(params.baseline.successes, params.baseline.attempts, seededPrior(params.segment, "cash:0"));
  const plainEv = theta0 * params.marginPaise - 50;
  let best: IncentiveOption | null = null;
  let bestEv = -Infinity;
  const detail: Record<string, any> = { theta_0: theta0, perOption: {} };
  for (const o of params.options) {
    const key = optionKey(o);
    if (o.type === "cash" && o.value_paise === 0) { detail.perOption[key] = { rung: "baseline" }; continue; }
    const s = params.stats[key] ?? { successes: 0, attempts: 0 };
    const { theta, eligible } = eligibleTheta({
      successes: s.successes, attempts: s.attempts,
      priorMean: seededPrior(params.segment, key),
      explorationPicked: params.explorationPicked === key,
    });
    const p = probBucketBeatsBaseline({
      succ_b: s.successes, n_b: s.attempts, succ_0: params.baseline.successes, n_0: params.baseline.attempts,
      prior_b: seededPrior(params.segment, key), prior_0: seededPrior(params.segment, "cash:0"),
    });
    const ev = incentiveEv({ theta_b: theta, theta_0: theta0, marginPaise: params.marginPaise, incentivePaise: o.value_paise });
    detail.perOption[key] = { theta, eligible, p_diff: p, inc_ev: ev };
    if (!eligible) continue;
    if (p < 0.7) continue;
    if (ev > 0 && ev > bestEv) { bestEv = ev; best = o; }
  }
  if (best) return { decision: "ACTION", winner: best, incEv: bestEv, detail };
  if (plainEv > 0) return { decision: "PLAIN", winner: null, incEv: 0, detail };
  return { decision: "ABSTAIN", winner: null, incEv: 0, detail };
}

/**
 * M4c/H4c HORIZON INVARIANT: θ0 and θb must be computed over the identical
 * outcome window config; a window-config change resets both.
 */
export interface WindowConfig { windowDays: number; version: number }
export function horizonAligned(a: WindowConfig, b: WindowConfig): boolean {
  return a.windowDays === b.windowDays && a.version === b.version;
}
export function needsHorizonReset(prev: WindowConfig | null, next: WindowConfig): boolean {
  if (!prev) return false;
  return prev.windowDays !== next.windowDays || prev.version !== next.version;
}

/**
 * M4d/H4d PEEKING POLICY: conversion-based auto-pause requires ≥100 attempts
 * AND severity; feature kill/keep only at pre-registered checkpoints (min-n
 * 30/arm). Severe guardrails (refund/fraud/budget breach) always allowed.
 */
export type PauseKind = "conversion" | "refund_rate" | "fraud_flag" | "budget_breach";
export function autoPauseAllowed(kind: PauseKind, attempts: number, severe: boolean): boolean {
  if (kind !== "conversion") return severe; // guardrails: only on severity
  return attempts >= 100 && severe;
}
export function featureKillAllowed(nPerArm: number): boolean {
  return nPerArm >= 30;
}
