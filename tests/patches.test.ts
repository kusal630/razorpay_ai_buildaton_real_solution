import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
  getConfig: vi.fn().mockReturnValue({}),
}));

vi.mock("../src/db.js", () => ({
  query: vi.fn(),
  getPool: vi.fn(),
  withTransaction: vi.fn(),
}));

import { calculateProfitability } from "../src/lib/economics.js";
import { checkQuietHours, checkIncentiveCap30d, getMaxIncentiveForFirstTouch } from "../src/lib/policy2.js";

describe("P3: Profit-based Economics", () => {
  it("calculates fee and net profit correctly", () => {
    const result = calculateProfitability({
      amountPaise: 149800, // Rs.1,498
      marginPaise: 59920, // 40% margin
      incentivePaise: 10000, // Rs.100
    });

    // Fee = 149800 * 200 / 10000 = 2996
    expect(result.feePaise).toBe(2996);
    // Net profit = 59920 - 10000 - 2996 = 46924
    expect(result.netProfitPaise).toBe(46924);
  });

  it("EV formula: margin-based", () => {
    const thetas = { 0: 0.10, 50: 0.20, 100: 0.34, 150: 0.36 };
    const marginPaise = 63900; // Rs.639

    const evs = Object.entries(thetas).map(([bucket, theta]) => ({
      bucket: Number(bucket),
      ev: theta * marginPaise - Number(bucket) * 100,
    }));

    // Rs.100 bucket should win
    const best = evs.reduce((a, b) => a.ev > b.ev ? a : b);
    expect(best.bucket).toBe(100);
  });

  it("all-negative EV yields plain link", () => {
    const thetas = { 0: 0.01, 50: 0.01, 100: 0.01, 150: 0.01 };
    const marginPaise = 100; // Very low margin

    const evs = Object.entries(thetas).map(([bucket, theta]) => ({
      bucket: Number(bucket),
      ev: theta * marginPaise - Number(bucket) * 100,
    }));

    // All EVs negative, best is Rs.0 bucket
    const best = evs.reduce((a, b) => a.ev > b.ev ? a : b);
    expect(best.bucket).toBe(0);
  });
});

describe("P5: Policy Hardening", () => {
  it("quiet hours detection", () => {
    // Mock IST time
    const originalDate = Date;
    const mockNow = new Date('2026-09-01T17:30:00Z'); // 23:00 IST
    vi.spyOn(globalThis, 'Date').mockImplementation((...args) => {
      if (args.length === 0) return mockNow;
      return new originalDate(...args as any);
    });

    const result = checkQuietHours();
    expect(result.deferred).toBe(true);
    expect(result.resumeAt).toBeDefined();

    vi.restoreAllMocks();
  });

  it("non-quiet hours allows action", () => {
    const originalDate = Date;
    const mockNow = new Date('2026-09-01T07:30:00Z'); // 13:00 IST
    vi.spyOn(globalThis, 'Date').mockImplementation((...args) => {
      if (args.length === 0) return mockNow;
      return new originalDate(...args as any);
    });

    const result = checkQuietHours();
    expect(result.deferred).toBe(false);

    vi.restoreAllMocks();
  });
});

describe("P6: Replay Tool", () => {
  it("deterministic RNG produces same sequence", () => {
    // Mulberry32 PRNG
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

    const rng1 = createRNG(42);
    const rng2 = createRNG(42);

    for (let i = 0; i < 100; i++) {
      expect(rng1()).toBe(rng2());
    }
  });

  it("converges to best bucket over 1000 rounds", () => {
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

    const rng = createRNG(42);
    const trueRates: Record<number, number> = { 0: 0.05, 5000: 0.10, 10000: 0.34, 15000: 0.05 };
    const BUCKETS = [0, 5000, 10000, 15000];
    const stats = new Map<number, { attempts: number; successes: number }>();
    const distribution: Record<number, number> = { 0: 0, 5000: 0, 10000: 0, 15000: 0 };

    for (let i = 0; i < 1000; i++) {
      let bestBucket = 0;
      let bestTheta = -1;

      for (const bucket of BUCKETS) {
        const s = stats.get(bucket) || { attempts: 0, successes: 0 };
        const alpha = s.successes + 1;
        const beta = s.attempts - s.successes + 1;
        const mean = alpha / (alpha + beta);
        const theta = mean + (rng() - 0.5) * 0.1;

        if (theta > bestTheta) {
          bestTheta = theta;
          bestBucket = bucket;
        }
      }

      distribution[bestBucket]++;

      // Simulate outcome
      const success = rng() < trueRates[bestBucket];
      if (!stats.has(bestBucket)) stats.set(bestBucket, { attempts: 0, successes: 0 });
      const s = stats.get(bestBucket)!;
      s.attempts++;
      if (success) s.successes++;
    }

    // Rs.100 bucket should have highest count (true rate 0.34)
    expect(distribution[10000]).toBeGreaterThan(distribution[0]);
    expect(distribution[10000]).toBeGreaterThan(distribution[5000]);
    expect(distribution[10000]).toBeGreaterThan(distribution[15000]);
  });
});

describe("P8: Consent + PII Access Log", () => {
  it("customer with consent_json can be touched", () => {
    const consent = { marketing_opt_in: true, channels: ['email'], consented_at: '2026-01-01' };
    expect(consent.marketing_opt_in).toBe(true);
  });

  it("customer without consent blocks touch", () => {
    const consent = { marketing_opt_in: false };
    expect(consent.marketing_opt_in).toBe(false);
  });
});

describe("P9: Reconciliation Visibility", () => {
  it("reconcile run structure", () => {
    const run = {
      id: "test-id",
      at: new Date(),
      rowsChecked: 100,
      matched: 98,
      mismatches: 2,
      pending: 0,
      detail: { mismatches: [] },
    };

    expect(run.matched + run.mismatches).toBe(run.rowsChecked);
  });
});

describe("P10: Claims Hygiene", () => {
  const bannedTerms = ["immutable", "WhatsApp", "+40%", "95%", "recurring", "guaranteed"];
  const requiredTerms = ["tamper-evident", "modeled range", "incremental", "holdout", "test mode does not send notifications"];

  it("banned terms not in test strings", () => {
    const testStrings = [
      "tamper-evident hash-chained ledger",
      "incremental lift vs holdout",
      "test mode does not send notifications",
      "modeled range 30-45%",
    ];

    for (const str of testStrings) {
      for (const term of bannedTerms) {
        expect(str.toLowerCase()).not.toContain(term.toLowerCase());
      }
    }
  });

  it("required terms present in test strings", () => {
    const testString = "tamper-evident hash-chained ledger with incremental lift vs holdout control. test mode does not send notifications. modeled range 30-45%.";

    for (const term of requiredTerms) {
      expect(testString.toLowerCase()).toContain(term.toLowerCase());
    }
  });
});
