import crypto from "node:crypto";
import { query } from "../db.js";
import { getConfig } from "../config.js";
import { createLogger } from "../logger.js";

const log = createLogger("replay");

export interface ReplayConfig {
  nCarts: number;
  trueRates: Record<string, Record<number, number>>; // segment -> bucket -> rate
  seed: number;
}

export interface ReplayResult {
  chosenDistribution: Record<number, number>;
  thetaEvolution: Record<string, number>[];
  circuitBreakerTrips: number;
  productionStatsUntouched: boolean;
}

/**
 * Deterministic PRNG using seed (Mulberry32).
 */
function createRNG(seed: number) {
  let state = seed;
  return () => {
    state |= 0;
    state = state + 0x6D2B79F5 | 0;
    let t = Math.imul(state ^ state >>> 15, 1 | state);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * Run a replay simulation in a SANDBOXED namespace (replay_* tables).
 * Never touches production segment_stats.
 */
export async function runReplay(config: ReplayConfig): Promise<ReplayResult> {
  const rng = createRNG(config.seed);
  const BUCKETS = [0, 5000, 10000, 15000];

  // Sandbox: create replay tables if not exist
  await query(`
    CREATE TABLE IF NOT EXISTS replay_segment_stats (
      merchant_id UUID NOT NULL,
      segment TEXT NOT NULL,
      bucket INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      successes INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (merchant_id, segment, bucket)
    )
  `);

  // Clear sandbox stats
  await query("DELETE FROM replay_segment_stats");

  const statsMap = new Map<string, Map<number, { attempts: number; successes: number }>>();
  const chosenDistribution: Record<number, number> = { 0: 0, 5000: 0, 10000: 0, 15000: 0 };
  const thetaEvolution: Record<string, number>[] = [];
  let circuitBreakerTrips = 0;

  for (let i = 0; i < config.nCarts; i++) {
    const segment = "default";
    const key = `replay-merchant:${segment}`;

    if (!statsMap.has(key)) {
      statsMap.set(key, new Map());
    }
    const segStats = statsMap.get(key)!;

    // Sample theta per bucket
    let bestBucket = 0;
    let bestTheta = -1;
    const sampledTheta: Record<string, number> = {};

    for (const bucket of BUCKETS) {
      const stats = segStats.get(bucket) || { attempts: 0, successes: 0 };
      const alpha = stats.successes + 1;
      const beta = stats.attempts - stats.successes + 1;

      // Beta sampling using mean + noise from RNG
      const mean = alpha / (alpha + beta);
      const theta = mean + (rng() - 0.5) * 0.1;
      sampledTheta[String(bucket / 100)] = Math.round(theta * 100) / 100;

      if (theta > bestTheta) {
        bestTheta = theta;
        bestBucket = bucket;
      }
    }

    chosenDistribution[bestBucket]++;

    // Record theta evolution periodically
    if (i % 100 === 0) {
      thetaEvolution.push({ round: i, ...sampledTheta });
    }

    // Simulate outcome based on true rates
    const trueRate = config.trueRates[segment]?.[bestBucket] || 0.1;
    const success = rng() < trueRate;

    // Update sandbox stats
    if (!segStats.has(bestBucket)) {
      segStats.set(bestBucket, { attempts: 0, successes: 0 });
    }
    const bucketStats = segStats.get(bestBucket)!;
    bucketStats.attempts++;
    if (success) bucketStats.successes++;

    // Write to sandbox table
    await query(
      `INSERT INTO replay_segment_stats (merchant_id, segment, bucket, attempts, successes)
       VALUES ('00000000-0000-0000-0000-000000000001', $1, $2, 1, $3)
       ON CONFLICT (merchant_id, segment, bucket)
       DO UPDATE SET attempts = replay_segment_stats.attempts + 1,
                     successes = replay_segment_stats.successes + $3`,
      [segment, bestBucket, success ? 1 : 0]
    );

    // Circuit breaker check: conversion < 2% over last 100
    if (i >= 100) {
      const recentAttempts = Array.from(segStats.values()).reduce((sum, s) => sum + s.attempts, 0);
      const recentSuccesses = Array.from(segStats.values()).reduce((sum, s) => sum + s.successes, 0);
      const recentRate = recentAttempts > 0 ? recentSuccesses / recentAttempts : 0;

      if (recentRate < 0.02) {
        circuitBreakerTrips++;
        // Reset stats for next segment
        for (const s of segStats.values()) {
          s.attempts = 0;
          s.successes = 0;
        }
      }
    }
  }

  // Verify production stats untouched
  const { rows: prodStats } = await query(
    "SELECT COUNT(*) as cnt FROM segment_stats WHERE merchant_id = '00000000-0000-0000-0000-000000000001'"
  );
  const productionStatsUntouched = Number(prodStats[0]?.cnt || 0) === 0;

  return {
    chosenDistribution,
    thetaEvolution,
    circuitBreakerTrips,
    productionStatsUntouched,
  };
}
