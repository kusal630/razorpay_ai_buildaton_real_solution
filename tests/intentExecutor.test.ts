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
  getPool: vi.fn().mockReturnValue({
    connect: vi.fn().mockReturnValue({
      query: vi.fn(),
      release: vi.fn(),
    }),
  }),
  withTransaction: vi.fn(async (fn: any) => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: 1 }] }),
    };
    return fn(mockClient);
  }),
}));

// Mock ledger (duplicate-skip path appends via appendLedger)
vi.mock("../src/lib/ledger.js", () => ({
  appendLedger: vi.fn().mockResolvedValue({ seq: 2, hash: "abc" }),
}));

import { createIntent, completeIntent, failIntent } from "../src/lib/intentExecutor.js";
import { query, withTransaction } from "../src/db.js";

const mockQuery = query as any;
const mockWithTransaction = withTransaction as any;

describe("P1: Write-ahead Intent Deduplication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a new intent on first call", async () => {
    // First call: ON CONFLICT DO NOTHING returns a row (uuid id on remote shape)
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: "11111111-1111-4111-8111-111111111111" }] }),
    };
    mockWithTransaction.mockImplementation(async (fn: any) => fn(mockClient));

    const result = await createIntent({
      merchantId: "merchant-1",
      customerId: "customer-1",
      actionType: "recovery_link",
      targetId: "cart-1",
    });

    expect(result.isNew).toBe(true);
    expect(result.intentId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("detects duplicate intent and skips", async () => {
    // Second call: ON CONFLICT DO NOTHING returns 0 rows
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };
    mockWithTransaction.mockImplementation(async (fn: any) => fn(mockClient));
    mockQuery.mockResolvedValue({ rows: [{ seq: 2 }] }); // For appendAudit

    const result = await createIntent({
      merchantId: "merchant-1",
      customerId: "customer-1",
      actionType: "recovery_link",
      targetId: "cart-1",
    });

    expect(result.isNew).toBe(false);
    expect(result.auditSeq).toBeDefined();
  });

  it("generates consistent dedupe key", async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: 1 }] }),
    };
    mockWithTransaction.mockImplementation(async (fn: any) => fn(mockClient));

    // Same customer + action + day = same dedupe key
    await createIntent({
      merchantId: "merchant-1",
      customerId: "customer-1",
      actionType: "recovery_link",
      targetId: "cart-1",
      windowDay: "2026-09-01",
    });

    const insertCall = mockClient.query.mock.calls[0];
    const dedupeKey = insertCall[1][7]; // 8th parameter is dedupe_key (remote shape)
    expect(dedupeKey).toBe("merchant-1:customer-1:cart-1:recovery_link:2026-09-01");
  });

  it("different days produce different dedupe keys", async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: 1 }] }),
    };
    mockWithTransaction.mockImplementation(async (fn: any) => fn(mockClient));

    await createIntent({
      merchantId: "merchant-1",
      customerId: "customer-1",
      actionType: "recovery_link",
      targetId: "cart-1",
      windowDay: "2026-09-01",
    });

    const key1 = mockClient.query.mock.calls[0][1][7];

    await createIntent({
      merchantId: "merchant-1",
      customerId: "customer-1",
      actionType: "recovery_link",
      targetId: "cart-1",
      windowDay: "2026-09-02",
    });

    const key2 = mockClient.query.mock.calls[1][1][7];
    expect(key1).not.toBe(key2);
  });

  it("completes intent (remote shape: no audit_seq column)", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await completeIntent("11111111-1111-4111-8111-111111111111");
    expect(mockQuery).toHaveBeenCalledWith(
      "UPDATE action_intents SET status = 'done', lease_expires_at = NULL WHERE id = $1",
      ["11111111-1111-4111-8111-111111111111"]
    );
  });

  it("fails intent as retryable", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await failIntent("11111111-1111-4111-8111-111111111111", 'pending');
    expect(mockQuery).toHaveBeenCalledWith(
      "UPDATE action_intents SET status = $1, lease_expires_at = NULL WHERE id = $2",
      ['pending', "11111111-1111-4111-8111-111111111111"]
    );
  });

  it("fails intent as skipped (policy blocked)", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await failIntent("11111111-1111-4111-8111-111111111111", 'skipped');
    expect(mockQuery).toHaveBeenCalledWith(
      "UPDATE action_intents SET status = $1, lease_expires_at = NULL WHERE id = $2",
      ['skipped', "11111111-1111-4111-8111-111111111111"]
    );
  });
});
