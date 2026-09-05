/**
 * v5intel.ts — Part C competitive + revenue intelligence. Pure math (tested);
 * routes supply the DB rows. Benchmarks are survey priors — never presented
 * as merchant measurements (U-BENCH). Suggestions are advisory only and never
 * modify policy (N29 pattern).
 */
import { wilsonInterval } from "./experiment.js";

/** P2: target suggestion from measured incremental rate vs target. */
export interface TargetInput {
  targetPct: number; // default 10
  measuredPct: number | null; // null = below minimum-n
  attempts: number;
  daysObserved: number;
}
export function suggestTarget(input: TargetInput):
  | { suggestion: "reduce_caps" | "raise_caps"; reason: string }
  | { suggestion: null; reason: string } {
  if (input.measuredPct == null) return { suggestion: null, reason: "collecting — below minimum-n" };
  if (input.measuredPct > input.targetPct + 5 && input.daysObserved >= 30) {
    return {
      suggestion: "reduce_caps",
      reason: `measured ${input.measuredPct.toFixed(1)}% exceeds target ${input.targetPct}% by 5+ points over ${input.daysObserved}d — the system is outperforming, caps could be lowered (within ceilings, merchant decision)`,
    };
  }
  if (input.measuredPct < input.targetPct - 2 && input.attempts >= 100) {
    return {
      suggestion: "raise_caps",
      reason: `measured ${input.measuredPct.toFixed(1)}% trails target ${input.targetPct}% after ${input.attempts} attempts — caps could be raised within platform ceilings (merchant decision)`,
    };
  }
  return { suggestion: null, reason: "within band — no change suggested" };
}

/** P2 progress line with Wilson interval (collecting state below min-n). */
export function recoveryProgress(recovered: number, abandoned: number, targetPct: number): {
  state: "collecting" | "ready"; ratePct: number | null; lo: number | null; hi: number | null; targetPct: number;
} {
  if (abandoned < 30) return { state: "collecting", ratePct: null, lo: null, hi: null, targetPct };
  const { lower, upper } = wilsonInterval(recovered, abandoned);
  return {
    state: "ready",
    ratePct: (100 * recovered) / abandoned,
    lo: lower * 100, hi: upper * 100,
    targetPct,
  };
}

/** P3: cart-value comparison + high-value-hesitation alert. */
export function cartValueAlert(params: { avgAbandoned: number | null; avgCompleted: number | null }): {
  fires: boolean; message?: string;
} {
  const { avgAbandoned, avgCompleted } = params;
  if (avgAbandoned == null || avgCompleted == null || avgCompleted <= 0) {
    return { fires: false };
  }
  if (avgAbandoned > avgCompleted * 1.15) {
    return {
      fires: true,
      message: `high-value carts hesitating — abandoned avg exceeds completed avg by ${(((avgAbandoned / avgCompleted) - 1) * 100).toFixed(0)}% (recorded, pre-settlement): check shipping costs / payment friction`,
    };
  }
  return { fires: false };
}

/** P1: honest industry-vs-merchant label builder (linter-required phrasing). */
export function industryLabel(industry: string, source: string, asOf: string): string {
  return `measured on your traffic vs Industry survey research reports ≈ (${industry}, ${source}, as of ${asOf})`;
}
