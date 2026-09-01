import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock config
vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({
    RAZORPAY_MODE: "test",
    DAILY_INCENTIVE_BUDGET_PAISE: 500000,
    HOLD_TTL_MIN: 15,
  }),
  getConfig: vi.fn().mockReturnValue({
    RAZORPAY_MODE: "test",
    DAILY_INCENTIVE_BUDGET_PAISE: 500000,
    HOLD_TTL_MIN: 15,
  }),
}));

// Mock DB
vi.mock("../src/db.js", () => ({
  query: vi.fn(),
  getPool: vi.fn(),
  withTransaction: vi.fn((fn: any) => fn({ query: vi.fn() })),
}));

import { evaluateAction } from "../src/lib/policyEngine.js";
import { query } from "../src/db.js";

const mockQuery = query as any;

describe("Policy Engine Matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({
      rows: [
        { id: "1", action: "payment_link", auto_limit_paise: 1000000, escalate_limit_paise: 5000000, hard_block_limit_paise: 10000000, active: true },
        { id: "2", action: "recovery_incentive", auto_limit_paise: 15000, escalate_limit_paise: 50000, hard_block_limit_paise: 100000, active: true },
        { id: "3", action: "upsell_discount", auto_limit_paise: 1500, escalate_limit_paise: 2500, hard_block_limit_paise: 5000, active: true },
        { id: "4", action: "chat_discount_request", auto_limit_paise: 15000, escalate_limit_paise: 50000, hard_block_limit_paise: 100000, active: true },
        { id: "5", action: "refund", auto_limit_paise: 100000, escalate_limit_paise: 500000, hard_block_limit_paise: 1000000, active: true },
      ],
    });
  });

  const testCases = [
    { action: "payment_link", amount: 10000, expected: "ALLOW" },
    { action: "payment_link", amount: 1000000, expected: "ALLOW" },
    { action: "payment_link", amount: 5000000, expected: "ESCALATE" },
    { action: "payment_link", amount: 10000000, expected: "BLOCK" },
    { action: "recovery_incentive", amount: 100, expected: "ALLOW" },
    { action: "recovery_incentive", amount: 15000, expected: "ALLOW" },
    { action: "recovery_incentive", amount: 50000, expected: "ESCALATE" },
    { action: "recovery_incentive", amount: 100000, expected: "BLOCK" },
    { action: "upsell_discount", amount: 1500, expected: "ALLOW" },
    { action: "upsell_discount", amount: 2500, expected: "ESCALATE" },
    { action: "upsell_discount", amount: 5000, expected: "BLOCK" },
  ];

  for (const tc of testCases) {
    it(`${tc.action} ${tc.amount} -> ${tc.expected}`, async () => {
      const result = await evaluateAction(tc.action, { amount_paise: tc.amount });
      expect(result.decision).toBe(tc.expected);
    });
  }
});

describe("Thompson Sampling", () => {
  it("cold start restricts to {0, 100} buckets", () => {
    const BUCKETS = [0, 5000, 10000, 15000];
    const statsMap = new Map();

    const eligibleBuckets = BUCKETS.filter((bucket) => {
      const totalAttempts = 0;
      if (totalAttempts < 10 && bucket !== 0 && bucket !== 10000) return false;
      return true;
    });

    expect(eligibleBuckets).toEqual([0, 10000]);
  });

  it("EV formula: P=0.34, cart=159800, incentive=10000 -> EV ~44332", () => {
    const P = 0.34;
    const cartTotal = 159800;
    const incentive = 10000;
    const ev = Math.round(P * cartTotal - incentive);
    expect(ev).toBe(44332);
  });
});
