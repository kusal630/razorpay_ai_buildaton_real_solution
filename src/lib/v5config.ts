/**
 * v5config.ts — Phase 3 (M13/M14/M17): merchant config, offers/EMI, arm order.
 */

export interface ShippingConfig { free_threshold_paise: number | null; flat_fee_paise: number; eta_days: number }
export interface BankOffer { bank: string; description: string; discount_paise: number; live: boolean }
export interface PaymentMethodsConfig { emi_enabled: boolean; emi_tenure_months: number[]; offers: BankOffer[] }
export interface CodConfig { enabled: boolean; token_confirm_paise: number; delivery_trigger: "manual" }
export interface ReviewRequestConfig { enabled: boolean; delay_days: number }

export const CONFIG_KEYS = ["shipping", "payment_methods", "cod", "review_request"] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];
export function isConfigKey(k: string): k is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(k);
}

export const EMI_FLOOR_PAISE = 150000; // ₹1,500 Razorpay EMI floor
export const EMI_QUALIFIER = "(interest as per your bank)";

/** M14: live offers only; each render must be resolver-grounded (live=true). */
export function liveOffers(cfg: PaymentMethodsConfig): BankOffer[] {
  return cfg.offers.filter((o) => o.live);
}
/** M14: EMI display math — server-side per-month amounts. */
export function emiPerMonth(cartTotalPaise: number, months: number): number {
  return Math.ceil(cartTotalPaise / months);
}
export function emiAvailable(cfg: PaymentMethodsConfig, cartTotalPaise: number): boolean {
  return cfg.emi_enabled && cartTotalPaise >= EMI_FLOOR_PAISE && cfg.emi_tenure_months.length > 0;
}

/** M13: shipping fee for a cart (0 below threshold logic handled by caller). */
export function shippingForCart(cartTotalPaise: number, cfg: ShippingConfig): number {
  if (cfg.free_threshold_paise != null && cartTotalPaise >= cfg.free_threshold_paise) return 0;
  return cfg.flat_fee_paise;
}

/** M17: landmark scheduling arms (month-start + merchant festival dates). */
export function landmarkDates(festivalDatesIso: string[], nowIso: string, count = 3): string[] {
  const now = new Date(nowIso);
  const out: string[] = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i + 1, 1, 3, 30, 0));
    if (d.getTime() > now.getTime()) out.push(d.toISOString());
  }
  for (const f of festivalDatesIso) {
    if (Date.parse(f) > now.getTime()) out.push(f);
  }
  return out.sort().slice(0, count);
}
