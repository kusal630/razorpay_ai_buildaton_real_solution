import { query } from "../db.js";
import { checkQuietHours, checkIncentiveCap30d, checkIncentiveLifetime, getMaxIncentiveForFirstTouch } from "./policy2.js";
import { checkTransactionalConsent, checkMarketingConsent } from "./consent.js";

interface PolicyRule {
  id: string;
  action: string;
  auto_limit_paise: number;
  escalate_limit_paise: number;
  hard_block_limit_paise: number;
}

let cachedRules: PolicyRule[] | null = null;

async function loadRules(): Promise<PolicyRule[]> {
  if (cachedRules) return cachedRules;
  const { rows } = await query("SELECT * FROM policy_rules WHERE active = true");
  cachedRules = rows;
  return cachedRules;
}

export function invalidatePolicyCache(): void {
  cachedRules = null;
}

// W4: Action classes
export type ActionClass = "proactive_marketing_touch" | "reactive_buyer_action" | "operational_job";

export interface PolicyContext {
  amount_paise: number;
  incentive_paise?: number;
  margin_paise?: number;
  cart_total_paise?: number;
  customer_touches_today?: number;
  daily_spend_paise?: number;
  daily_budget_paise?: number;
  customerId?: string;
  isRecovery?: boolean;
  isUpsell?: boolean;
  isPaymentFailed?: boolean;
  consentType?: "transactional" | "marketing";
  actionClass?: ActionClass;
}

export interface PolicyResult {
  decision: "ALLOW" | "ESCALATE" | "BLOCK" | "ABSTAIN";
  reasons: string[];
  checks: Record<string, string>;
}

export async function evaluateAction(
  action: string,
  context: PolicyContext
): Promise<PolicyResult> {
  const rules = await loadRules();
  const rule = rules.find((r) => r.action === action);

  if (!rule) {
    // Default: allow small, escalate medium, block large
    if (context.amount_paise <= 10000) {
      return { decision: "ALLOW", reasons: ["default_rule"], checks: { default: "PASS" } };
    }
    if (context.amount_paise <= 50000) {
      return { decision: "ESCALATE", reasons: ["default_rule_escalate"], checks: { default: "ESCALATE" } };
    }
    return { decision: "BLOCK", reasons: ["default_rule_block"], checks: { default: "BLOCK" } };
  }

  const checks: Record<string, string> = {};
  const reasons: string[] = [];

  // Amount check
  if (context.amount_paise >= rule.hard_block_limit_paise) {
    checks.amount = "BLOCK";
    reasons.push(`amount ${context.amount_paise} >= hard block ${rule.hard_block_limit_paise}`);
  } else if (context.amount_paise > rule.auto_limit_paise) {
    checks.amount = "ESCALATE";
    reasons.push(`amount ${context.amount_paise} exceeds auto limit ${rule.auto_limit_paise}`);
  } else {
    checks.amount = "PASS";
  }

  // Incentive specific checks
  if (action === "recovery_incentive" && context.incentive_paise !== undefined) {
    const incentiveCap = Math.min(15000, Math.floor((context.margin_paise || 0) * 0.25));
    if (context.incentive_paise > 50000) {
      checks.incentive_cap = "BLOCK";
      reasons.push(`incentive ${context.incentive_paise} exceeds Rs.500 cap`);
    } else if (context.incentive_paise > incentiveCap) {
      checks.incentive_cap = "ESCALATE";
      reasons.push(`incentive ${context.incentive_paise} exceeds margin floor ${incentiveCap}`);
    } else {
      checks.incentive_cap = "PASS";
    }
  }

  // W4: Action class checks
  const actionClass = context.actionClass || "proactive_marketing_touch";

  // W4: Quiet hours - ONLY for proactive touches
  if (actionClass === "proactive_marketing_touch") {
    if (context.isRecovery || context.isPaymentFailed) {
      const quietCheck = checkQuietHours();
      if (quietCheck.deferred) {
        checks.quiet_hours = "BLOCK";
        reasons.push(`quiet hours active, resume at ${quietCheck.resumeAt?.toISOString()}`);
      } else {
        checks.quiet_hours = "PASS";
      }
    }
  } else {
    // Reactive/operational: NO quiet hours check
    checks.quiet_hours = "PASS";
  }

  // W4: Consent - ONLY for proactive touches
  if (actionClass === "proactive_marketing_touch" && context.customerId) {
    if (context.isRecovery || context.isPaymentFailed) {
      const hasTransactional = await checkTransactionalConsent(context.customerId);
      if (!hasTransactional) {
        checks.consent = "BLOCK";
        reasons.push(`no transactional consent for recovery`);
      } else {
        checks.consent = "PASS";
      }
    } else if (context.isUpsell) {
      const hasMarketing = await checkMarketingConsent(context.customerId);
      if (!hasMarketing) {
        checks.consent = "BLOCK";
        reasons.push(`no marketing consent for upsell`);
      } else {
        checks.consent = "PASS";
      }
    }
  } else {
    // Reactive/operational: NO consent check (buyer already initiated)
    checks.consent = "PASS";
  }

  // W4: Velocity - ONLY for proactive touches
  if (actionClass === "proactive_marketing_touch" && context.customer_touches_today !== undefined) {
    if (context.customer_touches_today >= 3) {
      checks.velocity = "BLOCK";
      reasons.push(`customer touched ${context.customer_touches_today} times today, max 3`);
    } else if (context.customer_touches_today === 2) {
      checks.velocity = "ESCALATE";
      reasons.push(`customer touched ${context.customer_touches_today} times, 3rd requires approval`);
    } else {
      checks.velocity = "PASS";
    }
  } else {
    checks.velocity = "PASS";
  }

  // W4: Budget - ONLY for proactive touches
  if (actionClass === "proactive_marketing_touch" && context.daily_spend_paise !== undefined && context.daily_budget_paise !== undefined) {
    if (context.daily_spend_paise >= context.daily_budget_paise) {
      checks.budget = "BLOCK";
      reasons.push(`daily spend ${context.daily_spend_paise} reached budget ${context.daily_budget_paise}`);
    } else {
      checks.budget = "PASS";
    }
  } else {
    checks.budget = "PASS";
  }

  // P5: 30-day incentive cap - ALWAYS (even for reactive)
  if (context.customerId && context.incentive_paise && context.incentive_paise > 0) {
    const capped = await checkIncentiveCap30d(context.customerId);
    if (capped) {
      checks.incentive_30d = "BLOCK";
      reasons.push(`customer already received incentive in last 30 days`);
    } else {
      checks.incentive_30d = "PASS";
    }

    // N3 (v4.2): lifetime incentive cap per identity — same suite, same trigger.
    // Plain (₹0) proposals skip both caps.
    const lifetime = await checkIncentiveLifetime(context.customerId);
    if (lifetime.capped) {
      checks.lifetime_incentive_cap = "BLOCK";
      reasons.push(`lifetime_incentive_cap: identity used ${lifetime.count} incentives totaling ₹${(lifetime.totalPaise / 100).toFixed(0)} (max 3 / ₹300)`);
    } else {
      checks.lifetime_incentive_cap = "PASS";
    }
  }

  // G9 (v4.3): engagement-fatigue — logged in policy_checks, enforced at the
  // scheduler (spacing), never a hard BLOCK here (the ladder's designed
  // sequence must still evaluate; the scan skips only doubled-window cases).
  if (actionClass === "proactive_marketing_touch" && context.customerId) {
    try {
      const { getFatigueState } = await import("./fatigue.js");
      const fatigue = await getFatigueState(context.customerId);
      checks.fatigue = fatigue.multiplier === 2 ? "DOUBLE_SPACING" : "PASS";
      if (fatigue.multiplier === 2) {
        reasons.push(`fatigue: ${fatigue.consecutive_misses} unengaged touches, spacing doubled`);
      }
    } catch {
      checks.fatigue = "PASS";
    }
  }

  // P5: First-touch rule - ALWAYS per-customer (V12)
  if (context.customerId && context.incentive_paise !== undefined) {
    const maxIncentive = await getMaxIncentiveForFirstTouch(context.customerId);
    if (context.incentive_paise > maxIncentive) {
      checks.first_touch = "BLOCK";
      reasons.push(`first touch requires Rs.0 incentive, got ${context.incentive_paise}`);
    } else {
      checks.first_touch = "PASS";
    }
  }

  // Determine final decision
  const decisionValues = { BLOCK: 4, ABSTAIN: 3, ESCALATE: 2, ALLOW: 1 };
  let finalDecision: "ALLOW" | "ESCALATE" | "BLOCK" | "ABSTAIN" = "ALLOW";
  for (const v of Object.values(checks)) {
    const d = v as keyof typeof decisionValues;
    if (decisionValues[d] > decisionValues[finalDecision]) {
      finalDecision = d as "ALLOW" | "ESCALATE" | "BLOCK" | "ABSTAIN";
    }
  }

  return { decision: finalDecision, reasons, checks };
}
