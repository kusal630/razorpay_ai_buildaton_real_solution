import { query } from "../db.js";
import { appendLedger } from "./ledger.js";
import { checkDarkPatterns } from "./darkPatternFilter.js";
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

export const TOKEN_RE = /\[claim:(stock|expiry|social_proof|saved_amount):([^\]]*)\]/g;
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
    const { rows } = await query("SELECT stock FROM products WHERE id = $1", [ref]);
    const stock = rows[0] != null ? Number(rows[0].stock) : NaN;
    if (!Number.isFinite(stock) || stock <= 0) return { unresolvable: `stock unknown/exhausted for ${ref}` };
    return { rendered: String(stock), value: stock };
  }
  if (type === "expiry") {
    let iso: string | null = null;
    if (ref) {
      const { rows } = await query(
        "SELECT expire_by FROM payment_links WHERE id = $1 OR razorpay_link_id = $1 OR ext_ref = $1",
        [ref]
      );
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

  // Malformed/unknown token types fail fast (validation step 4.5 input).
  const loose = copy.match(/\[claim:([^\]:]*):?([^\]]*)\]/g) || [];
  for (const tok of loose) {
    if (!tok.match(TOKEN_RE)) violations.push(`malformed_claim_token: ${tok.slice(0, 40)}`);
  }
  TOKEN_RE.lastIndex = 0;

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
    if (typeof r.value === "number") allowed.push(r.value);
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
}

/**
 * Ground copy; on fallback, use the template and ledger the refusal with
 * claim_ungrounded / bare-number notes. Returns the sendable copy.
 */
export async function finalizeCopy(input: FinalizeCopyInput): Promise<{ copy: string; result: GroundResult }> {
  const result = await groundCopy(input.copy, input.facts, input.source);
  if (!result.fallback) return { copy: result.copy, result };
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
          reason: "claim_ungrounded",
          stripped: result.stripped,
          violations: result.violations,
        },
        outcome: "SKIPPED",
      });
    } catch (err: any) {
      log.warn({ error: err?.message }, "Fallback ledger write failed (non-critical)");
    }
  } else {
    log.info({ stripped: result.stripped.length, violations: result.violations }, "Copy fell back to template");
  }
  return { copy: input.fallbackTemplate, result };
}
