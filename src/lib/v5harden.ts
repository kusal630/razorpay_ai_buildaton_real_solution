/**
 * v5harden.ts — Phase 6 (M25–M34) seam hardening. Pure logic + SQL text.
 * DB side effects live in migration 010; this module holds the testable rules.
 */

/** M25: append-only trigger SQL (also in migration). Permits exactly the
 * PROPOSED→terminal resolution UPDATE (dual-path invariant); all else raises. */
export const LEDGER_IMMUTABLE_SQL = `CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'audit_log is append-only (seq=%)', OLD.seq;
  END IF;
  IF OLD.outcome = 'PROPOSED' AND NEW.outcome IN ('SUCCESS','FAILED','SKIPPED')
     AND OLD.seq = NEW.seq AND OLD.prev_hash = NEW.prev_hash THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only (seq=%)', OLD.seq;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_log_immutable ON audit_log;
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();`;

/**
 * M27: platform ceilings (no merchant edit path). Returns rejection or
 * pending-with-cooldown for raises.
 */
export const PLATFORM_CEILINGS = {
  incentive_paise: 15000,
  link_auto_allow_paise: 1000000,
  daily_budget_paise: 500000,
  upsell_discount_pct: 15,
} as const;
export function checkCeilingEdit(field: keyof typeof PLATFORM_CEILINGS, from: number, to: number): { ok: boolean; status?: "pending"; cooldownMin?: number; reason?: string } {
  if (to > PLATFORM_CEILINGS[field]) return { ok: false, reason: `exceeds platform ceiling ${PLATFORM_CEILINGS[field]}` };
  if (to > from) return { ok: true, status: "pending", cooldownMin: 60, reason: "raise requires 1h cooldown + step-up" };
  return { ok: true };
}

/** M27 margin auditor: bounds [−10%,90%]; WoW drift >15pts → flag. */
export function marginAudit(marginPct: number, prevWeekPct: number | null): { ok: boolean; flag: boolean; reason?: string } {
  if (marginPct < -10 || marginPct > 90) return { ok: false, flag: true, reason: "margin out of bounds [-10,90]" };
  if (prevWeekPct != null && Math.abs(marginPct - prevWeekPct) > 15) {
    return { ok: true, flag: true, reason: "week-over-week drift >15pts" };
  }
  return { ok: true, flag: false };
}

/** M28: canonical identity = min(id) over connected set. */
export function canonicalIdentity(ids: string[]): string {
  return [...ids].sort()[0];
}

/** M30: gateway grace 15 min; capture after release → soft_breach. */
export const GATEWAY_GRACE_MIN = 15;
export function sweepDue(expireByMs: number, nowMs: number): boolean {
  return nowMs >= expireByMs + GATEWAY_GRACE_MIN * 60_000;
}
export function captureAfterRelease(capturedMs: number, releasedMs: number): boolean {
  return capturedMs > releasedMs;
}

/** M31: NFKC + strip zero-width/invisible chars before all filters. */
export function normalizeForFilters(s: string): string {
  return s.normalize("NFKC").replace(/[​‌‍﻿⁠]/g, "");
}
const BANNED_CLAIMS_RE = /(on1y\s+\d+\s+l[e3]ft|only\s+\d+\s+left|guaranteed|act now|last chance)/i;
export function bannedClaimHit(raw: string): boolean {
  return BANNED_CLAIMS_RE.test(normalizeForFilters(raw));
}

/**
 * M32: breaker discipline — only transport errors trip; validation
 * rejections route to fallback without tripping.
 */
export type LlmFailure = "timeout" | "http_5xx" | "network" | "validation" | "schema";
export function tripsBreaker(f: LlmFailure): boolean {
  return f === "timeout" || f === "http_5xx" || f === "network";
}
export function breakerAlarmOpensPerHour(opens: number): boolean {
  return opens >= 3;
}

/** M33: claims-language table (docs linter). */
export const CLAIMS_REQUIRED = ["go-live gate", "externally anchored", "at-most-once", "zero unresolved critical exceptions"];
export const CLAIMS_BANNED = ["env change only", "physically cannot", "tamper-proof", "0 mismatches"];

/** M34 hygiene bundle. */
export function thetaDriftAlarm(prev30d: number, curr30d: number): boolean {
  return Math.abs(curr30d - prev30d) > 0.1;
}
export function madBaseline(values: number[]): { median: number; mad: number } {
  const s = [...values].sort((a, b) => a - b);
  const median = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  const devs = s.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = devs.length % 2 ? devs[(devs.length - 1) / 2] : (devs[devs.length / 2 - 1] + devs[devs.length / 2]) / 2;
  return { median, mad };
}
export function refundAnomaly(amount: number, history: number[], k = 3): boolean {
  if (history.length < 5) return false;
  const { median, mad } = madBaseline(history);
  const scale = mad === 0 ? 1 : mad * 1.4826;
  return Math.abs(amount - median) > k * scale;
}
export function socialProofFloor(buyers7d: number): boolean {
  return buyers7d >= 5; // suppress token below 5
}
export function midnightCapApplies(istHour: number, istMinute: number): boolean {
  return istHour === 0; // 00:00–01:00 IST window
}
export function midnightAllowance(dailyBudgetPaise: number): number {
  return Math.floor(dailyBudgetPaise / 4); // 25%
}
export function incentivesBlockedForIdentity(mismatches: number): boolean {
  return mismatches >= 2;
}
/** System holdout: deterministic HMAC bucket, default 2% never-touch. */
export async function systemHoldout(identityHash: string, pct = 2): Promise<boolean> {
  const { hmacWith } = await import("./v5keys.js");
  const h = hmacWith("holdout", `sys:${identityHash}`);
  const v = parseInt(h.slice(0, 8), 16) / 0xffffffff;
  return v < pct / 100;
}
export function upsellSpikeAlert(today: number, trailingAvg: number): boolean {
  return trailingAvg > 0 && today > 3 * trailingAvg && today >= 5;
}
