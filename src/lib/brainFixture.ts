/**
 * brainFixture.ts — F3 smoke-test fixture shared by `npm run brain-test`
 * and the QA "Test LLM Brain" button. T1: trust-claim flags carry grounded
 * values so the smoke covers the new tokens.
 */
import { defaultBrainExtension } from "./v5brain.js";

export function buildSmokeFixture(): any {
  const ext = defaultBrainExtension("recovery");
  return {
    agent: "recovery",
    customer: {
      pseudonym: "cust_smoke01",
      segment: "first_visit_high_intent",
      touch_history: 1,
      consent_state: "marketing_opted_in",
      experiment_arm: "treatment",
    },
    cart: [{ id: "smoke-earbuds", name: "Wireless Earbuds", price_paise: 159800 }],
    feasible_options: [
      { action: "send_link_with_incentive", bucket_paise: 10000, ev_paise: 5200, theta: 0.34 },
      { action: "send_link_with_incentive", bucket_paise: 5900, ev_paise: 3100, theta: 0.28 },
      { action: "send_plain_link", bucket_paise: 0, ev_paise: 900, theta: 0.1 },
    ],
    policy_numbers: { max_incentive_paise: 15000, margin_paise: 63920, max_discount_pct: 15 },
    theta_estimates: { "0": 0.1, "10000": 0.34 },
    known_ids: ["smoke-cart-1", "cust_smoke01", "smoke-earbuds"],
    merchant_id: "smoke-merchant",
    case_type: ext.case_type,
    persuasion_context: {
      threshold: { gap_paise: null, message: null },
      offers: [],
      emi: { available: false, months: [] },
      hold: { has_reservation: false, expires_hours: null },
      all_in_total: { available: true },
      // T1: trust claims live with grounded values in the smoke fixture.
      returns_policy: { available: true, summary: "7-day easy returns" },
      delivery_estimate: { available: true, text: "delivery in ~3 days" },
    },
    copy_constraints: ext.copy_constraints,
    available_tokens: ["all_in_total:smoke-cart-1", "expiry:smoke-cart-1", "returns_policy:merchant", "delivery_estimate:smoke-cart-1"],
    allow_reminder_choice: true,
    allow_save_for_later: false,
  };
}
