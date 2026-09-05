/**
 * v5brain.ts — M18 context assembly, M20 validation additions, M22/M23 graduations.
 * No decrypt imports (PII-free by construction).
 */

export type CaseType = "recovery" | "failure_retry" | "ndr" | "cod" | "upsell" | "chat" | "reassurance" | "review_request" | "save_for_later";

export interface PersuasionContext {
  verified_reviews: { available: boolean; count: number; avg: number | null; has_negatives: boolean };
  social_proof: { units_7d: number; buyers_7d: number; fresh: boolean };
  threshold: { gap_paise: number | null; message: string | null };
  offers: { bank: string; description: string }[];
  emi: { available: boolean; months: number[] };
  hold: { has_reservation: boolean; expires_hours: number | null };
  all_in_total: { available: boolean };
  customer_signals: { engagement_hour: number | null; prior_saves: boolean; chosen_reminder: boolean; abandonment_cycles: number };
}

export function emptyPersuasionContext(): PersuasionContext {
  return {
    verified_reviews: { available: false, count: 0, avg: null, has_negatives: false },
    social_proof: { units_7d: 0, buyers_7d: 0, fresh: false },
    threshold: { gap_paise: null, message: null },
    offers: [],
    emi: { available: false, months: [] },
    hold: { has_reservation: false, expires_hours: null },
    all_in_total: { available: false },
    customer_signals: { engagement_hour: null, prior_saves: false, chosen_reminder: false, abandonment_cycles: 0 },
  };
}

export interface BrainExtension {
  case_type: CaseType;
  persuasion_context: PersuasionContext;
  strategy_stats?: Record<string, Record<string, { n: number; rate: number }>> | null;
  approval_advisory?: { top_approved: string[]; top_rejected: string[] } | null;
  copy_constraints: { max_length: number; one_claim_per_message: boolean; channel: string; decline_button_text: string };
  available_tokens: string[];
  allow_reminder_choice: boolean;
  allow_save_for_later: boolean;
}

export function defaultBrainExtension(caseType: CaseType): BrainExtension {
  return {
    case_type: caseType,
    persuasion_context: emptyPersuasionContext(),
    strategy_stats: null,
    approval_advisory: null,
    copy_constraints: { max_length: 320, one_claim_per_message: true, channel: "message", decline_button_text: "No thanks" },
    available_tokens: [],
    allow_reminder_choice: false,
    allow_save_for_later: false,
  };
}

/** {{token:ref}} inline emission form (M19/M20-V1). */
export const INLINE_TOKEN_RE = /\{\{([a-z_]+):([^}]*)\}\}/g;
export const PERSUASION_TOKENS = new Set(["expiry", "stock", "social_proof", "saved_amount", "offer", "price"]);

/**
 * Fold near-miss token brackets into canonical form BEFORE any whitelist or
 * resolution step: `<{type:ref}>` → `{{type:ref}}`. Small models emit the
 * angle-wrapped form; the intent is unambiguous markup, so resolve it
 * (I-2) instead of shipping it literally. Both callers (validation +
 * resolver) apply this first, so they always agree.
 */
export function foldTokenBrackets(copy: string): string {
  return copy.replace(/<\{\s*([a-z_]+:[^<>{}]*)\s*\}>/g, "{{$1}}");
}/**
 * T1 transparency set: TRUST claims (price transparency + policy facts),
 * never persuasion. They may coexist with ONE persuasion claim (I-3).
 */
export const TRUST_TOKENS = new Set(["all_in_total", "threshold_gap", "returns_policy", "delivery_estimate"]);

/** V1: every inline token must be in available claims. Returns unknown tokens. */
export function unknownTokens(copy: string, available: string[]): string[] {
  const out: string[] = [];
  INLINE_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_TOKEN_RE.exec(copy)) !== null) {
    const name = `${m[1]}:${m[2]}`;
    if (!available.includes(name) && !available.includes(m[1])) out.push(m[0]);
  }
  return out;
}

/** V2: distinct PERSUASION tokens only — trust tokens (I-3 transparency set)
 * never count toward the one-claim limit. >1 distinct persuasion → stacking. */
export function distinctPersuasionTokens(copy: string): string[] {
  const set = new Set<string>();
  INLINE_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_TOKEN_RE.exec(copy)) !== null) {
    if (PERSUASION_TOKENS.has(m[1]) && !TRUST_TOKENS.has(m[1])) set.add(m[1]);
  }
  return [...set];
}

/** V4: humor scope — playful banned for failure_retry/ndr. */
export function humorAllowed(caseType: CaseType, tone: string): boolean {
  if ((caseType === "failure_retry" || caseType === "ndr") && tone === "playful") return false;
  return true;
}

/** V5: decline-safety patterns (guilt / confirm-shaming). */
const DECLINE_SHAME_RE = /(are you sure\?|don't you (want|care|love)|you('ll| will) regret|only (a fool|an idiot) would|shame|selfish|cheapskate)/i;
export function declineSafe(copy: string): boolean {
  return !DECLINE_SHAME_RE.test(copy);
}

/** V6: secondary CTA availability. */
export type SecondaryCta = "reminder_choice" | "save_for_later" | "none";
export function secondaryCtaAllowed(cta: SecondaryCta, ext: BrainExtension): boolean {
  if (cta === "none") return true;
  if (cta === "reminder_choice") return ext.allow_reminder_choice;
  return ext.allow_save_for_later;
}

/** V7: ungrounded anti-pattern strings (allowed only with a grounding token). */
const ANTIPATTERN_RE = /(act now|last chance|everyone('s| is)? (buying|choosing)|missing out|don't miss|one-tap charge|guaranteed)/i;
export function hasUngroundedAntipattern(copy: string): boolean {
  if (INLINE_TOKEN_RE.test(copy)) { INLINE_TOKEN_RE.lastIndex = 0; return false; }
  INLINE_TOKEN_RE.lastIndex = 0;
  return ANTIPATTERN_RE.test(copy);
}

/** Full M20 validation — returns violation labels (empty = pass). */
export function validateV20(copy: string, tone: string, cta: SecondaryCta, ext: BrainExtension): string[] {
  const v: string[] = [];
  if (unknownTokens(copy, ext.available_tokens).length > 0) v.push("unknown_token");
  if (distinctPersuasionTokens(copy).length > 1) v.push("claim_stacking");
  if (copy.length > ext.copy_constraints.max_length) v.push("too_long");
  if (!humorAllowed(ext.case_type, tone)) v.push("humor_scope");
  if (!declineSafe(copy)) v.push("decline_shame");
  if (!secondaryCtaAllowed(cta, ext)) v.push("cta_unavailable");
  if (hasUngroundedAntipattern(copy)) v.push("antipattern_ungrounded");
  return v;
}

/** M22: per-identity send-time. ≥5 events → top engagement hour; else default. */
export function engagementHour(eventHours: number[], defaultHour: number): { hour: number; source: "engagement" | "default" } {
  if (eventHours.length < 5) return { hour: defaultHour, source: "default" };
  const counts = new Map<number, number>();
  for (const h of eventHours) counts.set(h, (counts.get(h) ?? 0) + 1);
  let best = defaultHour, bestN = -1;
  for (const [h, n] of counts) if (n > bestN) { bestN = n; best = h; }
  return { hour: best, source: "engagement" };
}

/** M23: copy-bandit graduation at ≥100 strategy-attributed outcomes per segment. */
export function strategyGraduated(outcomes: number): boolean {
  return outcomes >= 100;
}
