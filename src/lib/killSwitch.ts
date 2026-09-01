import { createLogger } from "../logger.js";

const log = createLogger("killSwitch");

// H5: Feature flags (per-tenant + global)
let globalAiEnabled = true;
const tenantAiEnabled = new Map<string, boolean>();

/**
 * H5: Check if AI is enabled for a merchant.
 * When off: agents run deterministic policy-only mode.
 */
export function isAiEnabled(merchantId?: string): boolean {
  if (merchantId && tenantAiEnabled.has(merchantId)) {
    return tenantAiEnabled.get(merchantId)!;
  }
  return globalAiEnabled;
}

/**
 * H5: Toggle global AI enabled/disabled.
 */
export function setGlobalAiEnabled(enabled: boolean): void {
  globalAiEnabled = enabled;
  log.warn({ enabled }, "Global AI state changed");
}

/**
 * H5: Toggle per-merchant AI enabled/disabled.
 */
export function setTenantAiEnabled(merchantId: string, enabled: boolean): void {
  tenantAiEnabled.set(merchantId, enabled);
  log.warn({ merchantId, enabled }, "Tenant AI state changed");
}

/**
 * H5: Get AI status for dashboard display.
 */
export function getAiStatus(merchantId?: string): {
  enabled: boolean;
  mode: "ai" | "rules";
  label: string;
} {
  const enabled = isAiEnabled(merchantId);
  return {
    enabled,
    mode: enabled ? "ai" : "rules",
    label: enabled ? "AI enabled" : "AI OFF - rules mode",
  };
}

/**
 * H5: Deterministic policy-only mode.
 * When AI is off, use feasible set -> means-based EV on known posteriors -> policy -> bus.
 */
export function deterministicPolicyMode(params: {
  thetas: Record<number, number>;
  marginPaise: number;
  incentivePaise: number;
  aiCostPaise?: number;
}): {
  decision: "ACTION" | "PLAIN" | "ABSTAIN";
  bucket: number;
  ev: number;
} {
  const feePaise = Math.round(params.marginPaise * 200 / 10000); // 2% fee
  const aiCost = params.aiCostPaise ?? 50;

  // Use posterior means directly (no sampling)
  let bestBucket = 0;
  let bestEv = -Infinity;

  for (const [bucketStr, theta] of Object.entries(params.thetas)) {
    const bucket = Number(bucketStr);
    const ev = theta * (params.marginPaise - feePaise - bucket) - aiCost;

    if (ev > bestEv) {
      bestEv = ev;
      bestBucket = bucket;
    }
  }

  const decision = bestEv > 0
    ? (bestBucket > 0 ? "ACTION" : "PLAIN")
    : "ABSTAIN";

  return { decision, bucket: bestBucket, ev: bestEv };
}
