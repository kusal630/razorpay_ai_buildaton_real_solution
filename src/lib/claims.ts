import { query } from "../db.js";
import { appendLedger } from "./ledger.js";
import { checkDarkPatterns } from "./darkPatternFilter.js";
import { foldTokenBrackets } from "./v5brain.js";
import { createLogger } from "../logger.js";

const log = createLogger("claims");

/**
 * N28 (v4.3) GROUNDED CLAIMS ONLY.
 * Customer-facing copy may embed claim tokens: [claim:<type>:<ref>]
 *   stock        ref=product_id        → products.stock (must be > 0)
 *   expiry       ref=payment-link id   → payment_links.expire_by (else facts.link_expiry_iso)
 *   social_proof ref=product_id        → social_stats row fresher than 26h
 *   saved_amount ref=order id or ""    → facts.order_incentive_paise (must be > 0, paid context)
 * Every token resolves to a live DB fact at send time or the claim is
 * stripped; bare numbers that match no grounded value reject the copy.
 */

export const TOKEN_RE = /\[claim:(stock|expiry|social_proof|saved_amount|all_in_total|threshold_gap|offer|price|returns_policy|delivery_estimate):([^\]]*)\]/g;
/** M19/M20-V1: inline LLM emission form {{type:ref}} — same types, same grounding. */
export const INLINE_TOKEN_RE = /\{\{(stock|expiry|social_proof|saved_amount|all_in_total|threshold_gap|offer|price|returns_policy|delivery_estimate):([^}]*)\}\}/g;
export const SOCIAL_STATS_FRESH_HOURS = 26;

export interface ClaimFact {
  incentive_paise?: number;
  cart_total_paise?: number;
  items?: { id: string; name: string; price_paise: number }[];
  /** Precomputed link expiry (the exact value moneyBus will store). */
  link_expiry_iso?: string;
  /** Saved amount, only meaningful in a paid context (G6). */
  order_incentive_paise?: number;
  order_paid?: boolean;
  /** Extra grounded numbers (e.g. a discount percent the policy already fixed). */
  extra_numbers?: number[];
  /** M7/M13: components for the all-in total + threshold gap (server-computed). */
  shipping_paise?: number;
  threshold_gap_paise?: number | null;
  /** M14: live bank offers the copy may reference (resolver checks live=true). */
  live_offers?: { bank: string; description: string }[];
  /** T1: returns policy + ship ETA (null/absent → tokens strip per I-2). */
  returns_policy?: { summary: string; days: number | null } | null;
  shipping_eta_days?: number | null;
}

export interface ResolvedClaim {
  type: string;
  ref: string;
  value: number | string;
  rendered: string;
}

export interface GroundResult {
  copy: string;
  resolved: ResolvedClaim[];
  stripped: { type: string; ref: string; reason: string }[];
  /** Numeric values the copy is allowed to contain (facts + resolutions). */
  allowed_numbers: number[];
  fallback: boolean;
  violations: string[];
}

const MARK = "STRIPPED_CLAIM";

function rupees(paise: number): string {
  return `₹${(paise / 100).toFixed(0)}`;
}

/** IST hour rendering for deadlines, e.g. "9 PM". */
export function renderExpiryShort(iso: string): { text: string; hour12: number; hour24: number; day: number } {
  const d = new Date(iso);
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const hour24 = ist.getUTCHours();
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const suffix = hour24 < 12 ? "AM" : "PM";
  return { text: `${hour12} ${suffix}`, hour12, hour24, day: ist.getUTCDate() };
}

async function resolveToken(
  type: string,
  ref: string,
  facts: ClaimFact
): Promise<{ rendered: string; value: number | string } | { unresolvable: string }> {
  if (type === "stock") {
    const { rows } = await query("SELECT stock FROM products WHERE id = $1", [ref])
      .catch(() => ({ rows: [] as any[] }));
    const stock = rows[0] != null ? Number(rows[0].stock) : NaN;
    if (!Number.isFinite(stock) || stock <= 0) return { unresolvable: `stock unknown/exhausted for ${ref}` };
    return { rendered: String(stock), value: stock };
  }
  if (type === "expiry") {
    let iso: string | null = null;
    if (ref) {
      // A DB hiccup must not nuke the claim when the caller supplied the
      // exact ISO — fall through to facts on query error.
      const { rows } = await query(
        "SELECT expire_by FROM payment_links WHERE id::text = $1 OR razorpay_link_id = $1 OR ext_ref = $1",
        [ref]
      ).catch(() => ({ rows: [] as any[] }));
      if (rows[0]?.expire_by) iso = new Date(rows[0].expire_by).toISOString();
    }
    iso = iso || facts.link_expiry_iso || null;
    if (!iso) return { unresolvable: "no expiry source" };
    const r = renderExpiryShort(iso);
    return { rendered: r.text, value: iso };
  }
  if (type === "social_proof") {
    const { rows } = await query(
      `SELECT units_7d, computed_at FROM social_stats WHERE product_id = $1`,
      [ref]
    ).catch(() => ({ rows: [] as any[] }));
    const row = rows[0];
    if (!row) return { unresolvable: `no social_stats for ${ref}` };
    const ageH = (Date.now() - new Date(row.computed_at).getTime()) / 3600e3;
    if (!(ageH < SOCIAL_STATS_FRESH_HOURS)) return { unresolvable: `stale social_stats (${ageH.toFixed(1)}h)` };
    const units = Number(row.units_7d);
    if (!Number.isFinite(units) || units <= 0) return { unresolvable: "no measured buyers" };
    return { rendered: String(units), value: units };
  }
  if (type === "saved_amount") {
    const v = Number(facts.order_incentive_paise || 0);
    if (!facts.order_paid || v <= 0) return { unresolvable: "no paid incentive to report" };
    return { rendered: rupees(v), value: v };
  }
  // M7: all-in total — server-computed items − incentive + shipping.
  if (type === "all_in_total") {
    const base = Number(facts.cart_total_paise || 0);
    if (!(base > 0)) return { unresolvable: "no cart total source" };
    const total = base - Number(facts.incentive_paise || 0) + Number(facts.shipping_paise || 0);
    return { rendered: rupees(total), value: total };
  }
  // M13: threshold gap — grounded free-shipping distance, suppressed at/above threshold.
  if (type === "threshold_gap") {
    const gap = Number(facts.threshold_gap_paise ?? NaN);
    if (!Number.isFinite(gap) || gap <= 0) return { unresolvable: "no threshold gap (at/above free shipping)" };
    return { rendered: rupees(gap), value: gap };
  }
  // M14: bank offer — only when the merchant config lists it live.
  if (type === "offer") {
    const hit = (facts.live_offers || []).find((o) => o.bank.toLowerCase() === String(ref).toLowerCase());
    if (!hit) return { unresolvable: `offer not live for ${ref}` };
    return { rendered: hit.description, value: hit.description };
  }
  // Price token — only for items already in facts (anchoring, real numbers).
  if (type === "price") {
    const item = (facts.items || []).find((i) => i.id === ref);
    if (!item) return { unresolvable: `no price source for ${ref}` };
    return { rendered: rupees(Number(item.price_paise)), value: Number(item.price_paise) };
  }
  // T1: returns policy — merchant-configured summary only; else stripped.
  if (type === "returns_policy") {
    const summary = String(facts.returns_policy?.summary || "").slice(0, 80);
    if (!summary) return { unresolvable: "returns policy unconfigured" };
    return { rendered: summary, value: summary };
  }
  // T1: delivery estimate — derived from shipping.eta_days; null strips.
  if (type === "delivery_estimate") {
    const eta = Number(facts.shipping_eta_days ?? NaN);
    if (!Number.isFinite(eta) || eta <= 0) return { unresolvable: "no delivery eta configured" };
    const text = `delivery in ~${Math.round(eta)} days`;
    return { rendered: text, value: text };
  }
  return { unresolvable: `unknown claim type ${type}` };
}

/** Currency / percent / bare-count patterns that count as numeric claims. */
const NUMBER_RE = /₹\s?[\d,]+|\d+\s?%|only\s+\d+|\d+\s+(left|remaining|bought|orders|customers|spots|items)/gi;

export function findBareNumbers(copy: string, allowed: number[]): number[] {
  return numbersIn(copy).filter((n) => !allowed.includes(n));
}

function numbersIn(text: string): number[] {
  const out: number[] = [];
  const re = new RegExp(NUMBER_RE.source, NUMBER_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[0].replace(/[^0-9]/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Drop a stripped sentence only if it no longer reads.
 * Strict rules apply ONLY to sentences that lost a claim (marker present);
 * untouched sentences already passed brain-time validation / code facts. */
function cleanStrippedCopy(copy: string): string {
  const sentences = copy.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((s) => {
    const stripped = s.includes(MARK);
    const t = s.replace(new RegExp(MARK, "g"), "").replace(/\s+/g, " ").trim();
    if (!t) return false;
    if (t.length < 4) return false;
    if (!stripped) return true;
    if (/only\s+(left|remaining|available)\s*[.!?]?\s*$/i.test(t)) return false;
    if (/^(expires?|ends?|save|saved|bought)\s*[.!?]?\s*$/i.test(t)) return false;
    if (/\bsaved?\s*[.!?]?\s*$/i.test(t)) return false;
    // A sentence whose count-dependent verb lost its number reads as
    // ungrounded puffery ("bought in the last 7 days" with no who/how many).
    // Timeframe numbers ("7 days") don't count as the claim's number.
    const timeless = t
      .replace(/\b(in the last|last|per)\s+\d+\s+days?\b/gi, "")
      .replace(/\b\d+\s+days?\b/gi, "");
    if (/\b(bought|orders?|customers?|spots|items?|left|remaining|saved?|expires?)\b/i.test(timeless) && !/\d/.test(timeless)) return false;
    return true;
  });
  return kept.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Resolve claim tokens in copy against live DB facts.
 * source 'llm' enforces the bare-number rule; 'code' only accepts numbers
 * present in facts (code-built copy is grounded by construction).
 */
export async function groundCopy(
  copy: string,
  facts: ClaimFact,
  source: "llm" | "code" = "llm"
): Promise<GroundResult> {
  const resolved: ResolvedClaim[] = [];
  const stripped: { type: string; ref: string; reason: string }[] = [];
  const violations: string[] = [];

  // M19: accept the inline {{type:ref}} emission form by normalizing it to
  // the canonical [claim:type:ref] form — identical grounding either way.
  // Near-miss <{...}> brackets fold first (same helper as validation).
  copy = foldTokenBrackets(copy);
  copy = copy.replace(INLINE_TOKEN_RE, (_m, t, r) => `[claim:${t}:${r}]`);
  INLINE_TOKEN_RE.lastIndex = 0;

  // Malformed/unknown token types fail fast (validation step 4.5 input).
  const loose = copy.match(/\[claim:([^\]:]*):?([^\]]*)\]/g) || [];
  for (const tok of loose) {
    if (!tok.match(TOKEN_RE)) violations.push(`malformed_claim_token: ${tok.slice(0, 40)}`);
  }
  const looseInline = copy.match(/\{\{[^}]*\}\}/g) || [];
  for (const tok of looseInline) {
    if (!tok.match(INLINE_TOKEN_RE)) violations.push(`malformed_claim_token: ${tok.slice(0, 40)}`);
  }
  TOKEN_RE.lastIndex = 0;
  INLINE_TOKEN_RE.lastIndex = 0;

  let working = copy;
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(copy)) !== null) {
    const [, type, ref] = m;
    try {
      const r = await resolveToken(type, ref, facts);
      if ("unresolvable" in r) {
        stripped.push({ type, ref, reason: r.unresolvable });
        working = working.replace(m[0], MARK);
      } else {
        resolved.push({ type, ref, value: r.value, rendered: r.rendered });
        working = working.replace(m[0], r.rendered);
      }
    } catch (err: any) {
      stripped.push({ type, ref, reason: `resolver_error: ${err?.message || err}` });
      working = working.replace(m[0], MARK);
    }
  }

  if (stripped.length > 0) {
    working = cleanStrippedCopy(working);
  } else {
    working = working.replace(/\s+/g, " ").trim();
  }

  // Allowed numbers: explicit facts + every resolved value (+expiry clock parts).
  const allowed: number[] = [];
  if (facts.incentive_paise) allowed.push(facts.incentive_paise, facts.incentive_paise / 100);
  if (facts.cart_total_paise) allowed.push(facts.cart_total_paise, facts.cart_total_paise / 100);
  for (const i of facts.items || []) {
    allowed.push(Number(i.price_paise), Number(i.price_paise) / 100);
    if ((i as any).stock != null) allowed.push(Number((i as any).stock));
  }
  if (facts.order_incentive_paise) allowed.push(facts.order_incentive_paise, facts.order_incentive_paise / 100);
  for (const n of facts.extra_numbers || []) allowed.push(Number(n));
  for (const r of resolved) {
    if (typeof r.value === "number") {
      allowed.push(r.value);
      // Convention (mirrors facts): both paise and whole-rupee forms are allowed.
      if (r.value >= 100 && r.value % 100 === 0) allowed.push(r.value / 100);
    }
    if (typeof r.value === "string" && !isNaN(Date.parse(r.value))) {
      const e = renderExpiryShort(r.value);
      allowed.push(e.hour12, e.hour24, e.day);
    } else if (typeof r.value === "string") {
      const n = Number(String(r.value).replace(/[^0-9]/g, ""));
      if (Number.isFinite(n) && String(r.value).trim() !== "") allowed.push(n);
    }
  }

  // Step 4.5: bare numbers must trace to a grounded value.
  // (Rules templates are pre-grounded code copy — checked by the caller, not here.)
  // Product names ride along verbatim (e.g. "20000mAh") — strip them before
  // scanning so model numbers in code-built copy never trip the check.
  const scannable = source === "code" && facts.items
    ? facts.items.reduce((t, i) => t.split(i.name).join(""), working)
    : working;
  if (source === "llm") {
    for (const n of numbersIn(scannable)) {
      if (!allowed.includes(n)) violations.push(`bare_number_without_token: ${n}`);
    }
  } else {
    for (const n of numbersIn(scannable)) {
      if (!allowed.includes(n)) violations.push(`code_number_not_in_facts: ${n}`);
    }
  }

  // Wording rules (dark patterns incl. G5 stored-instrument implications) run on
  // the resolved copy with grounded numbers redacted — a resolved "Only 3
  // left" must NOT trip the ungrounded-scarcity pattern; anything that still
  // matches is ungrounded by construction.
  let redacted = working;
  for (const r of resolved) {
    if (r.rendered) redacted = redacted.split(String(r.rendered)).join("#");
  }
  for (const v of checkDarkPatterns(redacted).violations) {
    violations.push(`dark_pattern: ${v.slice(0, 80)}`);
  }

  const fallback = working.replace(new RegExp(MARK, "g"), "").trim().length < 20 || violations.length > 0;
  return { copy: working, resolved, stripped, allowed_numbers: allowed, fallback, violations };
}

export interface FinalizeCopyInput {
  copy: string;
  facts: ClaimFact;
  source: "llm" | "code";
  fallbackTemplate: string;
  ledger?: { merchantId: string; actor: string; action: string } | null;
  /** T2: post-resolution cap (resolved text can grow past the brain-time cap). */
  maxLength?: number;
  /** T2: output channel — sms folds ₹ to Rs (UCS-2 halves segments). */
  channel?: "sms" | "web";
}

/**
 * T2: SMS-bound composition — "Rs" over "₹" (the glyph forces UCS-2),
 * plus common non-GSM-7 folding. Web surfaces keep ₹.
 */
export function toSmsSafe(copy: string): string {
  return copy
    .replace(/₹/g, "Rs ")
    .replace(/[–—]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    .replace(/ /g, " ")
    .replace(/Rs\s{2,}/g, "Rs ")
    .trim();
}

/**
 * Ground copy; on fallback, use the template and ledger the refusal with
 * claim_ungrounded / bare-number notes. Returns the sendable copy.
 * T2 pipeline order: resolve → normalize → channel-compose → length check.
 */
export async function finalizeCopy(input: FinalizeCopyInput): Promise<{ copy: string; result: GroundResult }> {
  const result = await groundCopy(input.copy, input.facts, input.source);
  const { normalizeForFilters } = await import("./v5harden.js");
  let sendable = normalizeForFilters(result.copy);
  if (input.channel === "sms") sendable = toSmsSafe(sendable);
  // T2: post-resolution length check (substitution can grow past the cap).
  const maxLength = input.maxLength ?? 320;
  const tooLong = sendable.length > maxLength;
  if (!result.fallback && !tooLong) {
    if (sendable !== result.copy) {
      return { copy: sendable, result: { ...result, copy: sendable } };
    }
    return { copy: result.copy, result };
  }
  if (input.ledger) {
    try {
      await appendLedger({
        merchantId: input.ledger.merchantId,
        actor: input.ledger.actor,
        action: "copy_fallback",
        params: { original_preview: input.copy.slice(0, 200) },
        decision: "BLOCK",
        policy_checks: { grounded_claims: "FALLBACK" },
        rationale: {
          reason: tooLong ? "length_exceeded_post_resolution" : "claim_ungrounded",
          stripped: result.stripped,
          violations: result.violations,
          ...(tooLong ? { resolved_length: sendable.length, max_length: maxLength } : {}),
        },
        outcome: "SKIPPED",
      });
    } catch (err: any) {
      log.warn({ error: err?.message }, "Fallback ledger write failed (non-critical)");
    }
  } else {
    log.info({ stripped: result.stripped.length, violations: result.violations, tooLong }, "Copy fell back to template");
  }
  return { copy: input.fallbackTemplate, result };
}
