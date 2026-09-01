import { describe, it, expect, beforeAll } from "vitest";

// Mock DB for unit tests
vi.mock("../src/db.js", () => ({
  query: vi.fn(),
  getPool: vi.fn(),
  withTransaction: vi.fn((fn) => fn({ query: vi.fn() })),
}));

import { appendAudit, verifyChain, updateAuditOutcome } from "../src/lib/auditLedger.js";
import { query } from "../src/db.js";

const mockQuery = query as any;

describe("Audit Ledger", () => {
  beforeAll(() => {
    // Setup mock responses
    mockQuery.mockImplementation(async (sql: string, params?: any[]) => {
      if (sql.includes("SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1")) {
        return { rows: [{ hash: "" }] };
      }
      if (sql.includes("INSERT INTO audit_log")) {
        return { rows: [{ seq: 1 }] };
      }
      if (sql.includes("UPDATE audit_log")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT * FROM audit_log ORDER BY seq ASC")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT * FROM audit_log WHERE seq")) {
        return { rows: [{ seq: 1, ts: new Date().toISOString(), actor: "Test", action: "test", params_json: {}, decision: "ALLOW", policy_checks_json: {}, rationale_json: {}, outcome: "PROPOSED", outcome_detail_json: {}, prev_hash: "", hash: "" }] };
      }
      return { rows: [] };
    });
  });

  it("appends audit row", async () => {
    const seq = await appendAudit({
      actor: "Test",
      action: "test_action",
      params_json: { key: "value" },
      decision: "ALLOW",
      policy_checks_json: {},
      rationale_json: {},
    });
    expect(seq).toBe(1);
  });

  it("updates audit outcome", async () => {
    await updateAuditOutcome(1, "SUCCESS", { result: "ok" });
    expect(mockQuery).toHaveBeenCalled();
  });
});

describe("Policy Engine", () => {
  it("loads and evaluates", async () => {
    vi.doMock("../src/db.js", () => ({
      query: vi.fn().mockResolvedValue({
        rows: [
          { id: "1", action: "payment_link", auto_limit_paise: 1000000, escalate_limit_paise: 5000000, hard_block_limit_paise: 10000000, active: true },
        ],
      }),
      getPool: vi.fn(),
      withTransaction: vi.fn((fn) => fn({ query: vi.fn() })),
    }));

    const { evaluateAction } = await import("../src/lib/policyEngine.js");
    const result = await evaluateAction("payment_link", { amount_paise: 500000 });
    expect(result.decision).toBe("ALLOW");
  });
});
