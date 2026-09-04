import { query } from "../db.js";
import { createLogger } from "../logger.js";

const log = createLogger("copyStrategy");

/**
 * G7 (v4.3): copy-strategy dimension (lite).
 * message_strategy ∈ {functional, loss_framed, social_proof, endowment, autonomy}
 * is recorded on ledger PROPOSED rows and on strategy outcomes. The LLM picks
 * within the feasible set; ε=10% uniform exploration keeps all arms measured.
 * NO full Thompson over strategy×bucket yet (cold-start explosion — roadmap).
 */
export const COPY_STRATEGIES = [
  "functional",
  "loss_framed",
  "social_proof",
  "endowment",
  "autonomy",
] as const;

export type CopyStrategy = (typeof COPY_STRATEGIES)[number];

export const STRATEGY_EPSILON = 0.1;
export const STRATEGY_MIN_N = 30; // same honesty rule as the lift panel

export async function ensureStrategyTables(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS strategy_stats (
    merchant_id UUID NOT NULL,
    segment TEXT NOT NULL,
    strategy TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    successes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (merchant_id, segment, strategy)
  )`);
}

export function isCopyStrategy(s: unknown): s is CopyStrategy {
  return typeof s === "string" && (COPY_STRATEGIES as readonly string[]).includes(s);
}

/**
 * LLM choice + ε-greedy exploration. Returns the recorded strategy and
 * whether this decision was an exploration draw.
 */
export function chooseMessageStrategy(
  llmChoice: unknown,
  rand: () => number = Math.random
): { strategy: CopyStrategy; explored: boolean } {
  if (rand() < STRATEGY_EPSILON) {
    const pick = COPY_STRATEGIES[Math.floor(rand() * COPY_STRATEGIES.length)];
    return { strategy: pick, explored: true };
  }
  if (isCopyStrategy(llmChoice)) return { strategy: llmChoice, explored: false };
  return { strategy: "functional", explored: false };
}

export async function recordStrategyAttempt(
  merchantId: string,
  segment: string,
  strategy: string
): Promise<void> {
  await ensureStrategyTables();
  await query(
    `INSERT INTO strategy_stats (merchant_id, segment, strategy, attempts, successes)
     VALUES ($1, $2, $3, 1, 0)
     ON CONFLICT (merchant_id, segment, strategy)
     DO UPDATE SET attempts = strategy_stats.attempts + 1`,
    [merchantId, segment, strategy]
  );
}

export async function recordStrategySuccess(
  merchantId: string,
  segment: string,
  strategy: string
): Promise<void> {
  await ensureStrategyTables();
  await query(
    `INSERT INTO strategy_stats (merchant_id, segment, strategy, attempts, successes)
     VALUES ($1, $2, $3, 1, 1)
     ON CONFLICT (merchant_id, segment, strategy)
     DO UPDATE SET successes = strategy_stats.successes + 1`,
    [merchantId, segment, strategy]
  );
}

export interface StrategyRow {
  strategy: string;
  attempts: number;
  successes: number;
  rate: number | null;
  state: "collecting" | "ready";
}

/**
 * Per-strategy conversion table with min-n honesty: below MIN_N attempts the
 * rate is withheld ("collecting"), never a bare point estimate.
 */
export async function getStrategyTable(merchantId: string): Promise<StrategyRow[]> {
  await ensureStrategyTables();
  const { rows } = await query(
    `SELECT strategy, COALESCE(SUM(attempts),0) as attempts, COALESCE(SUM(successes),0) as successes
     FROM strategy_stats WHERE merchant_id = $1 GROUP BY strategy ORDER BY strategy`,
    [merchantId]
  );
  return rows.map((r: any) => {
    const attempts = Number(r.attempts);
    const successes = Number(r.successes);
    const ready = attempts >= STRATEGY_MIN_N;
    return {
      strategy: r.strategy,
      attempts,
      successes,
      rate: ready ? successes / attempts : null,
      state: ready ? "ready" : "collecting",
    };
  });
}
