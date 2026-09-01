import { query } from "../db.js";
import { checkTransactionalConsent, checkMarketingConsent } from "./consent.js";
import { createLogger } from "../logger.js";

const log = createLogger("consentPolicy");

/**
 * Consent class for each action type.
 * Derived from Round 6 audit: C1 consent classification.
 */
export type ConsentClass =
  | "transactional"    // payment_status, failure recovery, plain retry
  | "marketing"        // incentivized recovery, upsell, discounts
  | "reactive";        // buyer-initiated purchase

/**
 * Action → consent class mapping.
 * Transactional covers payment-status and failure recovery without incentives.
 * Marketing covers incentivized recovery, upsell, cross-sell.
 * Reactive covers buyer-initiated purchase.
 */
export const ACTION_CONSENT_CLASS: Record<string, ConsentClass> = {
  // Transactional: payment-status, failure recovery, plain retry (no incentive)
  payment_failed_retry_plain: "transactional",
  recovery_plain_first_touch: "transactional", // caveat: merchant-configurable to marketing
  payment_status_check: "transactional",
  failure_notification: "transactional",

  // Marketing: incentivized actions
  recovery_incentivized: "marketing",
  upsell: "marketing",
  chat_discount_request: "marketing",
  cross_sell: "marketing",
  promotional_touch: "marketing",

  // Reactive: buyer-initiated
  buyer_session_purchase: "reactive",
  buyer_initiated_payment: "reactive",
};

/**
 * Check if consent class is satisfied for a customer.
 * Returns { allowed: boolean, reason: string, consentClass: ConsentClass }.
 */
export async function checkConsentClass(
  customerId: string,
  action: string
): Promise<{
  allowed: boolean;
  reason: string;
  consentClass: ConsentClass;
  clampToPlain: boolean;
}> {
  const consentClass = ACTION_CONSENT_CLASS[action] || "marketing";

  switch (consentClass) {
    case "transactional": {
      // Transactional: check transactional consent (existing anchor)
      const hasTransactional = await checkTransactionalConsent(customerId);
      if (hasTransactional) {
        return {
          allowed: true,
          reason: "transactional_consent_valid",
          consentClass,
          clampToPlain: false,
        };
      }
      return {
        allowed: false,
        reason: "transactional_consent_missing",
        consentClass,
        clampToPlain: false,
      };
    }

    case "marketing": {
      // Marketing: check marketing consent
      const hasMarketing = await checkMarketingConsent(customerId);
      if (hasMarketing) {
        return {
          allowed: true,
          reason: "marketing_consent_valid",
          consentClass,
          clampToPlain: false,
        };
      }

      // C1: Clamp to plain action instead of blocking
      const hasTransactional = await checkTransactionalConsent(customerId);
      if (hasTransactional) {
        log.info({ customerId, action }, "Marketing consent missing, clamping to plain action");
        return {
          allowed: true, // allowed to proceed as plain
          reason: "consent_marketing_missing_clamped_to_plain",
          consentClass,
          clampToPlain: true,
        };
      }

      return {
        allowed: false,
        reason: "consent_marketing_missing",
        consentClass,
        clampToPlain: false,
      };
    }

    case "reactive": {
      // Reactive: buyer-initiated, consent anchored at checkout
      const hasTransactional = await checkTransactionalConsent(customerId);
      if (hasTransactional) {
        return {
          allowed: true,
          reason: "reactive_anchored_at_checkout",
          consentClass,
          clampToPlain: false,
        };
      }
      return {
        allowed: false,
        reason: "reactive_no_checkout_anchor",
        consentClass,
        clampToPlain: false,
      };
    }

    default: {
      return {
        allowed: false,
        reason: "unknown_consent_class",
        consentClass: "marketing",
        clampToPlain: false,
      };
    }
  }
}

/**
 * Get the plain action variant for a clamped action.
 * Returns the transactional fallback (Rs.0 bucket, no incentive).
 */
export function getPlainAction(action: string): string {
  if (action === "recovery_incentivized") {
    return "recovery_plain_first_touch";
  }
  if (action === "upsell") {
    return "payment_status_check";
  }
  return action;
}
