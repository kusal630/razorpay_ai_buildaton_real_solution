/**
 * v5ops.ts — M5 fee audit, M6 store credit, M15 NDR, M16 COD-save machinery.
 * Pure decision logic; DB/HTTP wiring lives in routes/jobs.
 */

/** M5: fee finding classification. */
export interface FeeFinding { orderId: string; kind: "stale_modeled" | "zero_fee_non_upi" | "mismatch"; detail: string }
export function classifyFee(params: {
  orderId: string; feeBasis: string; feePaise: number; method: string;
  paidAtIso: string; nowIso: string; entityFeePaise: number | null;
}): FeeFinding | null {
  const ageH = (Date.parse(params.nowIso) - Date.parse(params.paidAtIso)) / 3600e3;
  if (params.feeBasis === "modeled" && ageH > 24 && params.entityFeePaise != null) {
    return { orderId: params.orderId, kind: "stale_modeled", detail: `modeled fee re-recorded from entity (${params.entityFeePaise})` };
  }
  if (params.feePaise === 0 && params.method !== "upi" && params.method !== "unknown") {
    return { orderId: params.orderId, kind: "zero_fee_non_upi", detail: `zero fee on ${params.method}` };
  }
  if (params.entityFeePaise != null && params.feePaise > 0) {
    const drift = Math.abs(params.entityFeePaise - params.feePaise) / params.feePaise;
    if (drift > 0.05) return { orderId: params.orderId, kind: "mismatch", detail: `fee drift ${(drift * 100).toFixed(1)}%` };
  }
  return null;
}

/** M6: store-credit bonus = 10% of refund capped at ₹150 (15000 paise). */
export function creditBonus(refundPaise: number, marketingConsent: boolean): { bonus: number; clamped: boolean } {
  if (!marketingConsent) return { bonus: 0, clamped: true };
  return { bonus: Math.min(Math.floor(refundPaise / 10), 15000), clamped: false };
}
export function applyCredit(linkAmountPaise: number, creditBalancePaise: number): { charged: number; applied: number } {
  const applied = Math.min(linkAmountPaise, creditBalancePaise);
  return { charged: linkAmountPaise - applied, applied };
}
export const CREDIT_EXPIRY_DAYS = 90;

/** M15: NDR case transitions. */
export type NdrState = "open" | "resolved" | "rto" | "converted";
export function ndrTransition(from: NdrState, to: NdrState): boolean {
  if (from !== "open") return false;
  return to === "resolved" || to === "rto" || to === "converted";
}

/**
 * M16: COD loss-EV. EV_cod = θsave × (avoided_loss − incentive) − ai_cost.
 * avoided_loss = reverse_shipping + restock_loss + cod_fee.
 */
export function codLossEv(params: {
  thetaSave: number; reverseShippingPaise: number; restockLossPaise: number;
  codFeePaise: number; incentivePaise: number; aiCostPaise?: number;
}): number {
  const avoided = params.reverseShippingPaise + params.restockLossPaise + params.codFeePaise;
  return params.thetaSave * (avoided - params.incentivePaise) - (params.aiCostPaise ?? 50);
}
export const COD_TOKEN_CONFIRM_PAISE = 1000; // ₹10 token-confirm
export const THETA_SAVE_PRIOR = 0.20;
