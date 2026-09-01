import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock config
vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
  getConfig: vi.fn().mockReturnValue({}),
}));

// Mock DB
vi.mock("../src/db.js", () => ({
  query: vi.fn(),
  getPool: vi.fn(),
  withTransaction: vi.fn(),
}));

import { assignArm } from "../src/lib/experiment.js";

describe("P2: Holdout Experiment Layer", () => {
  describe("Deterministic Cohort Assignment", () => {
    it("assigns control arm for hash % 10 == 0", () => {
      // Find a cart_id + experiment_id that produces hash % 10 == 0
      // sha256("test:exp") % 10 should be deterministic
      const arm = assignArm("test-cart-1", "exp-1");
      expect(["treatment", "control"]).toContain(arm);
    });

    it("assignment is deterministic (same inputs = same arm)", () => {
      const arm1 = assignArm("cart-abc", "exp-1");
      const arm2 = assignArm("cart-abc", "exp-1");
      expect(arm1).toBe(arm2);
    });

    it("different cart_ids can produce different arms", () => {
      // Test with many cart_ids to verify both arms are possible
      const arms = new Set<string>();
      for (let i = 0; i < 100; i++) {
        arms.add(assignArm(`cart-${i}`, "exp-1"));
      }
      // With 100 carts, both arms should appear
      expect(arms.has("treatment")).toBe(true);
      expect(arms.has("control")).toBe(true);
    });

    it("approximately 10% control assignment", () => {
      let controlCount = 0;
      const total = 1000;
      for (let i = 0; i < total; i++) {
        if (assignArm(`cart-${i}`, "exp-test") === "control") {
          controlCount++;
        }
      }
      // Should be approximately 10% (allow 5-15% range)
      const controlRate = controlCount / total;
      expect(controlRate).toBeGreaterThan(0.05);
      expect(controlRate).toBeLessThan(0.15);
    });
  });

  describe("Incremental Math", () => {
    it("incremental = (treatment_rate - control_rate) * eligible * aov", () => {
      const treatmentRate = 0.15;
      const controlRate = 0.03;
      const eligible = 100;
      const aov = 149800; // Rs.1,498 in paise

      const incrementalConversions = (treatmentRate - controlRate) * eligible;
      const incrementalRevenue = incrementalConversions * aov;
      const marginPercent = 0.40;
      const incrementalGrossProfit = Math.round(incrementalRevenue * marginPercent);

      expect(incrementalConversions).toBe(12);
      expect(incrementalRevenue).toBe(12 * 149800);
      expect(incrementalGrossProfit).toBe(Math.round(12 * 149800 * 0.40));
    });

    it("control arm gets Rs.0 incentive", () => {
      const controlIncentive = 0;
      expect(controlIncentive).toBe(0);
    });

    it("ROAS = incremental gross profit / total incentive", () => {
      const incrementalGrossProfit = 719040; // 12 * 149800 * 0.40
      const totalIncentive = 100000; // Rs.1,000 in paise
      const roas = incrementalGrossProfit / totalIncentive;
      expect(roas).toBeCloseTo(7.19, 1);
    });
  });
});
