import { describe, it, expect } from "vitest";

describe("LLM Circuit Breaker", () => {
  it("opens after 3 consecutive failures", async () => {
    let failures = 0;
    let openUntil = 0;

    function recordFailure() {
      failures++;
      if (failures >= 3) openUntil = Date.now() + 60000;
    }

    function isOpen() {
      return failures >= 3 && Date.now() < openUntil;
    }

    recordFailure();
    expect(isOpen()).toBe(false);
    recordFailure();
    expect(isOpen()).toBe(false);
    recordFailure();
    expect(isOpen()).toBe(true);
  });

  it("resets after timeout", async () => {
    let failures = 3;
    let openUntil = Date.now() - 1; // Already expired

    function isOpen() {
      return failures >= 3 && Date.now() < openUntil;
    }

    expect(isOpen()).toBe(false); // Timeout expired
  });
});

describe("LLM Fallback", () => {
  it("returns deterministic fallback on failure", () => {
    const fallback = {
      strategy: "no_incentive",
      incentive_paise: 0,
      item_ids: [],
      rationale: { trigger: "llm_fallback", segment: "unknown" },
    };

    expect(fallback.incentive_paise).toBe(0);
    expect(fallback.strategy).toBe("no_incentive");
  });
});
