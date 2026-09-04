/**
 * v5trust.ts — Phase 2 (M7–M12): trust & subtraction features. Pure logic.
 * All money integer paise.
 */

/** M7: all-in total = items − incentive + shipping + fees. Server-computed. */
export function allInTotal(params: {
  itemTotalPaise: number; incentivePaise?: number; shippingPaise?: number; feePaise?: number;
}): number {
  return params.itemTotalPaise - (params.incentivePaise ?? 0)
    + (params.shippingPaise ?? 0) + (params.feePaise ?? 0);
}

/** M7 linter anchors. */
export const ALLIN_BANNED = ["total at checkout", "fees may apply"];
export const ALLIN_REQUIRED_PAY_PAGE = "all-in total";

/** M13/M7: threshold gap messaging (goal-gradient, grounded). */
export function thresholdGap(cartTotalPaise: number, freeThresholdPaise: number | null): number | null {
  if (freeThresholdPaise == null || cartTotalPaise >= freeThresholdPaise) return null;
  return freeThresholdPaise - cartTotalPaise;
}

/** M8: review validation. Injection → suppressed; rating 1–5. */
const INJECTION_RE = /(ignore (previous|all|your) (instructions|rules)|system prompt|reveal (your|the) (prompt|instructions)|jailbreak|do anything now)/i;
export type ReviewStatus = "pending" | "approved" | "suppressed";
export function classifyReview(text: string, rating: number): ReviewStatus {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return "suppressed";
  if (INJECTION_RE.test(text)) return "suppressed";
  return "pending";
}
export interface ReviewRow { rating: number; status: ReviewStatus }
export function ratingDistribution(reviews: ReviewRow[]): { dist: Record<number, number>; count: number; avg: number | null } {
  const dist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const ok = reviews.filter((r) => r.status === "approved");
  for (const r of ok) dist[r.rating]++;
  const count = ok.length;
  const avg = count === 0 ? null : ok.reduce((n, r) => n + r.rating, 0) / count;
  return { dist, count, avg };
}
/** Collection suppression: <5% submission after 200 requests → suppress touch. */
export function reviewTouchSuppressed(requests: number, submissions: number): boolean {
  return requests >= 200 && submissions / requests < 0.05;
}

/**
 * M9: approval learner. Laplace-smoothed acceptance per dimension-value.
 * NEVER modifies policy (N29) — returns advisory clamp/suppress only.
 */
export interface ApprovalPattern { seen: number; approved: number; rejected: number }
export function acceptanceRate(p: ApprovalPattern): number {
  return (p.approved + 1) / (p.seen + 2); // Laplace
}
export function rejectionProb(p: ApprovalPattern): number {
  return 1 - acceptanceRate(p);
}
export function learnerAdvise(params: {
  history: ApprovalPattern | null;
  proposed: number;
  approvedValuesAsc: number[];
}): { action: "allow" | "clamp" | "suppress"; clampedTo?: number; reason?: string } {
  if (!params.history || params.history.seen < 3) return { action: "allow" };
  if (rejectionProb(params.history) <= 0.7) return { action: "allow" };
  const lower = [...params.approvedValuesAsc].filter((v) => v < params.proposed).sort((a, b) => b - a);
  if (lower.length > 0) return { action: "clamp", clampedTo: lower[0], reason: "learner_clamped" };
  return { action: "suppress", reason: "learner_predicted_reject" };
}

/** M10: mandate canonical form + buyer GSTIN validation. */
export interface CartMandate {
  items: { id: string; price_paise: number; qty: number }[];
  total_paise: number;
  expires_at: string;
  jti: string;
}
export function canonicalMandate(m: CartMandate, buyerGstin?: string): string {
  const items = [...m.items].sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({ items, total_paise: m.total_paise, expires_at: m.expires_at, jti: m.jti, buyer_gstin: buyerGstin ?? null });
}
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export function validGstin(g: string): boolean { return GSTIN_RE.test(g.trim().toUpperCase()); }
export function verifyMandateShape(m: CartMandate, quotedTotalPaise: number, nowIso: string, seenJtis: Set<string>): { ok: boolean; code?: number; reason?: string } {
  if (seenJtis.has(m.jti)) return { ok: false, code: 409, reason: "replay" };
  if (Date.parse(m.expires_at) <= Date.parse(nowIso)) return { ok: false, code: 409, reason: "expired" };
  if (m.total_paise !== quotedTotalPaise) return { ok: false, code: 422, reason: "tamper" };
  return { ok: true };
}

/**
 * M11: reminder-time choice. Constrained to allowed windows; 1 max;
 * revalidate at dispatch (cart paid → cancel).
 */
export function reminderAllowed(requestedIso: string, nowIso: string, quietStartHour: number, quietEndHour: number): boolean {
  const t = new Date(requestedIso);
  if (!(t.getTime() > new Date(nowIso).getTime())) return false;
  const istH = (t.getUTCHours() + 5.5 + 24) % 24;
  // Quiet window [quietStart, quietEnd) in IST — default 21:00→09:00
  if (quietStartHour <= quietEndHour) {
    if (istH >= quietStartHour && istH < quietEndHour) return false;
  } else if (istH >= quietStartHour || istH < quietEndHour) return false;
  return true;
}

/** M12: save-for-later / price-watch. */
export function shouldFirePricePing(params: {
  optedIn: boolean; marketingConsent: boolean; oldPricePaise: number; newPricePaise: number;
}): boolean {
  return params.optedIn && params.marketingConsent && params.newPricePaise < params.oldPricePaise;
}
export function saveArmSuppressed(optIns: number, offers: number): boolean {
  return offers >= 50 && optIns / offers < 0.08; // <8% opt-in → silence is a valid arm
}
