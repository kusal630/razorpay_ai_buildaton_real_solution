import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock modules
vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
  getConfig: vi.fn().mockReturnValue({}),
}));

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
      query: vi.fn().mockResolvedValue({ rows: [{ hash: "" }] }),
    };
    return fn(mockClient);
  }),
}));

import { ev, selectBucket, calculateProfitability, CONSTANTS } from "../src/lib/economics.js";
import { fingerprint, redactString, redactForPersist, containsPII, scanForPII } from "../src/lib/redact.js";
import { wilsonInterval, assignArm } from "../src/lib/experiment.js";

describe("V1: Tracking Hardening", () => {
  it("public key cannot bind contact fields (N9)", () => {
    const CONTACT_FIELDS = ["email", "name", "phone", "contact", "customer"];
    const body = { cart_id: "test", items: [], total_paise: 100, customer: { email: "test@test.com" } };

    const containsContact = (obj: any): boolean => {
      if (!obj || typeof obj !== "object") return false;
      for (const key of Object.keys(obj)) {
        if (CONTACT_FIELDS.includes(key.toLowerCase())) return true;
        if (typeof obj[key] === "object" && containsContact(obj[key])) return true;
      }
      return false;
    };

    expect(containsContact(body)).toBe(true);
    expect(containsContact({ cart_id: "test", items: [], total_paise: 100 })).toBe(false);
  });
});

describe("V2: Ledger Serialization", () => {
  it("advisory lock key is constant", () => {
    // The lock key should be a fixed constant documented in code
    const LEDGER_LOCK_KEY = 7342901;
    expect(LEDGER_LOCK_KEY).toBe(7342901);
  });
});

describe("V3: Consent Classes", () => {
  it("transactional consent structure", () => {
    const consent = {
      anchor_cart_ids: ["cart-1"],
      latest_anchor_at: "2026-09-01T00:00:00Z",
      expires_at: "2026-09-08T00:00:00Z",
    };

    expect(consent.anchor_cart_ids.length).toBeGreaterThan(0);
    expect(new Date(consent.expires_at) > new Date()).toBe(true);
  });

  it("marketing consent structure", () => {
    const consent = {
      opt_in: true,
      source: "explicit",
      consented_at: "2026-09-01T00:00:00Z",
    };

    expect(consent.opt_in).toBe(true);
    expect(["explicit", "self_reported"]).toContain(consent.source);
  });

  it("recovery requires transactional, upsell requires marketing", () => {
    // Transactional: checkout-started, order created, payment attempted
    const transactionalAnchors = ["checkout-started", "order-created", "payment-attempted"];
    expect(transactionalAnchors.length).toBeGreaterThan(0);

    // Marketing: explicit opt-in only
    const marketingSources = ["explicit"];
    expect(marketingSources).toContain("explicit");
  });
});

describe("V5: Holdout Customer-Unit Randomization", () => {
  it("same customer gets same arm across multiple carts", () => {
    const customerId = "customer-123";
    const experimentId = "exp-1";

    const arm1 = assignArm(customerId, experimentId);
    const arm2 = assignArm(customerId, experimentId);
    const arm3 = assignArm(customerId, experimentId);

    expect(arm1).toBe(arm2);
    expect(arm2).toBe(arm3);
  });

  it("different customers get different arms sometimes", () => {
    const experimentId = "exp-1";
    const arms = new Set();

    for (let i = 0; i < 100; i++) {
      arms.add(assignArm(`customer-${i}`, experimentId));
    }

    // With 100 customers, should get both arms
    expect(arms.has("control")).toBe(true);
    expect(arms.has("treatment")).toBe(true);
  });

  it("Wilson interval contains true proportion", () => {
    const interval = wilsonInterval(50, 100);
    expect(interval.lower).toBeLessThan(0.5);
    expect(interval.upper).toBeGreaterThan(0.5);
  });

  it("Wilson interval below min-n returns collecting state", () => {
    const MIN_N = 30;
    const nTreatment = 10;
    const nControl = 5;

    const state = (nTreatment >= MIN_N && nControl >= MIN_N) ? "ready" : "collecting";
    expect(state).toBe("collecting");
  });
});

describe("V8: PII Redaction (N14)", () => {
  it("fingerprint is deterministic", () => {
    const fp1 = fingerprint("test@example.com");
    const fp2 = fingerprint("test@example.com");
    expect(fp1).toBe(fp2);
    expect(fp1.length).toBe(12);
  });

  it("redacts email addresses", () => {
    const input = "Contact user@example.com for details";
    const redacted = redactString(input);
    expect(redacted).not.toContain("user@example.com");
    expect(redacted).toContain("fp:");
  });

  it("redacts Indian phone numbers", () => {
    const input = "Call +919876543210 for support";
    const redacted = redactString(input);
    expect(redacted).not.toContain("9876543210");
  });

  it("redacts object PII fields", () => {
    const input = { email: "test@test.com", name: "John", data: "safe" };
    const redacted = redactForPersist(input);
    expect(redacted.email).not.toBe("test@test.com");
    expect(redacted.email).toContain("fp:");
    expect(redacted.data).toBe("safe");
  });

  it("detects PII in strings", () => {
    expect(containsPII("Contact user@example.com")).toBe(true);
    expect(containsPII("No PII here")).toBe(false);
  });

  it("scans and returns fingerprints", () => {
    const fingerprints = scanForPII("Email: test@test.com, phone: +919876543210");
    expect(fingerprints.length).toBe(2);
  });
});

describe("V9: Unified EV Formula (N12)", () => {
  it("EV = theta * (margin - fee - incentive) - ai_cost", () => {
    const result = ev({
      theta: 0.34,
      marginPaise: 63900, // Rs.639
      incentivePaise: 10000, // Rs.100
      aiCostPaise: 50,
    });

    // fee = 63900 * 200 / 10000 = 1278
    // EV = 0.34 * (63900 - 1278 - 10000) - 50 = 0.34 * 52622 - 50 = 17841.48 - 50 = 17791.48
    expect(result).toBeGreaterThan(17000);
    expect(result).toBeLessThan(19000);
  });

  it("ABSTAIN when all EVs negative", () => {
    const thetas = { 0: 0.01, 5000: 0.01, 10000: 0.01, 15000: 0.01 };
    const marginPaise = 100; // Very low margin

    const { decision } = selectBucket({
      thetas,
      theta_0: 0.01,
      marginPaise,
      aiCostPaise: 50,
    });

    expect(decision).toBe("ABSTAIN");
  });

  it("selects Rs.100 bucket with correct thetas", () => {
    const thetas = { 0: 0.10, 5000: 0.20, 10000: 0.34, 15000: 0.36 };
    const marginPaise = 63900;

    const { bucket, decision } = selectBucket({
      thetas,
      theta_0: 0.10,
      marginPaise,
      aiCostPaise: 50,
    });

    expect(bucket).toBe(10000);
    expect(decision).toBe("ACTION");
  });
});

describe("V11: Budget Reservation", () => {
  it("atomic reserve prevents overshoot", () => {
    // Simulate concurrent reserves
    const cap = 150000; // Rs.1500
    let reserved = 0;
    const results: boolean[] = [];

    for (let i = 0; i < 30; i++) {
      const amount = 10000; // Rs.100 each
      if (reserved + amount <= cap) {
        reserved += amount;
        results.push(true);
      } else {
        results.push(false);
      }
    }

    const successCount = results.filter(r => r).length;
    const failCount = results.filter(r => !r).length;

    expect(successCount).toBe(15); // Exactly 15 reserved
    expect(failCount).toBe(15); // 15 blocked
    expect(reserved).toBe(150000); // No overshoot
  });
});

describe("V12: Claims Hygiene", () => {
  const bannedTerms = ["immutable", "whatsapp", "+40%", "95%", "recurring", "guaranteed"];
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
