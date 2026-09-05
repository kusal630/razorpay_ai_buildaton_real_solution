import { query } from "../db.js";
import { createLogger } from "../logger.js";
import { formatINR } from "./format.js";

const log = createLogger("chatSession");

/**
 * N5 (v4.2): chat cost limits.
 * - Per-session turn cap (10): polite lockout beyond it.
 * - Per-link LLM budget (₹5 = 500 paise): lockout when exhausted.
 * - FAQ cache: price/stock/expiry answered from DB facts with ZERO LLM call,
 *   cached by (session, intent) for 5 minutes.
 * - Every turn metered in ai_usage (kind llm|faq|rules|refused).
 */
export const CHAT_MAX_TURNS = 10;
export const CHAT_LLM_BUDGET_PAISE = 500; // ₹5 equivalent
export const CHAT_COST_PER_1K_TOKENS_PAISE = 10; // ₹0.10 / 1K tokens
const FAQ_CACHE_TTL_MS = 5 * 60 * 1000;

export interface ChatSession {
  session_key: string;
  turn_count: number;
  llm_cost_paise: number;
}

export async function ensureChatTables(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS chat_sessions (
    session_key TEXT PRIMARY KEY,
    merchant_id UUID,
    turn_count INTEGER NOT NULL DEFAULT 0,
    llm_cost_paise BIGINT NOT NULL DEFAULT 0,
    locked BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS ai_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID,
    session_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('llm','faq','rules','refused')),
    tokens INTEGER NOT NULL DEFAULT 0,
    cost_paise BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

export async function loadSession(sessionKey: string, merchantId: string): Promise<ChatSession> {
  await ensureChatTables();
  const { rows } = await query(
    `INSERT INTO chat_sessions (session_key, merchant_id) VALUES ($1, $2)
     ON CONFLICT (session_key) DO UPDATE SET updated_at = NOW()
     RETURNING session_key, turn_count, llm_cost_paise`,
    [sessionKey, merchantId]
  );
  return {
    session_key: rows[0].session_key,
    turn_count: Number(rows[0].turn_count),
    llm_cost_paise: Number(rows[0].llm_cost_paise),
  };
}

export async function meterTurn(
  merchantId: string,
  sessionKey: string,
  kind: "llm" | "faq" | "rules" | "refused",
  tokens: number,
  costPaise: number
): Promise<void> {
  await query(
    `INSERT INTO ai_usage (merchant_id, session_key, kind, tokens, cost_paise)
     VALUES ($1, $2, $3, $4, $5)`,
    [merchantId, sessionKey, kind, tokens, costPaise]
  );
  if (kind !== "refused") {
    await query(
      `UPDATE chat_sessions
       SET turn_count = turn_count + 1,
           llm_cost_paise = llm_cost_paise + $2,
           updated_at = NOW()
       WHERE session_key = $1`,
      [sessionKey, kind === "llm" ? costPaise : 0]
    );
  }
  log.debug({ sessionKey, kind, tokens, costPaise }, "Chat turn metered");
}

export function tokensToCostPaise(totalTokens: number): number {
  return Math.ceil((totalTokens * CHAT_COST_PER_1K_TOKENS_PAISE) / 1000);
}

export const CHAT_LOCKOUT_COPY =
  "I've reached my limit for this chat session — please continue with the current payment link, or contact support for help.";

// ── FAQ classifier (no LLM): price / stock / expiry are DB facts ──

export type FaqIntent = "price" | "stock" | "expiry" | null;

const DISCOUNT_SIGNALS = /(discount|off\b|less\b|reduc|cheaper|deal|coupon|promo|haggle|negotiat)/i;

export function classifyFaq(message: string): FaqIntent {
  // Anything haggling-flavored stays on the LLM path (it may choose request_discount).
  if (DISCOUNT_SIGNALS.test(message)) return null;
  if (/(expir|valid till|valid until|till when|until when|how long.*(link|offer|valid)|when.*(end|expire))/i.test(message)) return "expiry";
  if (/(stock|available|in stock|how many.*left|left in|inventory)/i.test(message)) return "stock";
  if (/(price|cost|how much|amount|total|pay.*\?|charge)/i.test(message)) return "price";
  return null;
}

export interface FaqFacts {
  items: { id: string; name: string; price_paise: number; stock?: number | null }[];
  amount_paise: number;
  incentive_paise: number;
  expiryIso: string;
}

const faqCache = new Map<string, { answer: string; at: number }>();

export function answerFaq(
  sessionKey: string,
  intent: Exclude<FaqIntent, null>,
  facts: FaqFacts
): { answer: string; cached: boolean } {
  const key = `${sessionKey}:${intent}`;
  const hit = faqCache.get(key);
  if (hit && Date.now() - hit.at < FAQ_CACHE_TTL_MS) {
    return { answer: hit.answer, cached: true };
  }
  const rs = (p: number) => formatINR(p);
  let answer: string;
  if (intent === "price") {
    const lines = facts.items.map((i) => `${i.name}: ${rs(i.price_paise)}`).join("; ");
    answer = facts.items.length > 0
      ? `Your cart holds ${lines}. The link total is ${rs(facts.amount_paise)}${facts.incentive_paise > 0 ? ` (includes a ${rs(facts.incentive_paise)} incentive)` : ""}.`
      : `The link total is ${rs(facts.amount_paise)}.`;
  } else if (intent === "stock") {
    const lines = facts.items.map((i) =>
      i.stock == null ? `${i.name}: in stock` : `${i.name}: ${i.stock > 0 ? `${i.stock} available` : "currently out of stock"}`
    ).join("; ");
    answer = facts.items.length > 0 ? lines + "." : "I don't see items on this offer to check stock for.";
  } else {
    answer = `This payment link stays live until ${facts.expiryIso}.`;
  }
  faqCache.set(key, { answer, at: Date.now() });
  return { answer, cached: false };
}
