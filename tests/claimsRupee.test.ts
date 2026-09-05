import { describe, it, expect } from "vitest";
import { groundCopy } from "../src/lib/claims.js";

// U-RUPEE: paise integers must never display under a ₹ symbol.
// Reported case: FailureRetryBot sent "saved amount of ₹189900"
// (the cart total in paise, mislabeled as rupees).
describe("U-RUPEE rupee-scale enforcement", () => {
  const facts = {
    incentive_paise: 0,
    cart_total_paise: 189900,
    items: [{ id: "p1", name: "Earbuds", price_paise: 189900 }],
  };

  it("rejects paise-under-₹ (₹189900 with a ₹1,899 cart)", async () => {
    const r = await groundCopy(
      "You have a saved amount of ₹189900. Complete your purchase.",
      facts,
      "llm"
    );
    expect(r.violations).toContain("rupee_amount_not_grounded: ₹189900");
    expect(r.fallback).toBe(true);
  });

  it("accepts the same value at rupee scale (₹1,899)", async () => {
    const r = await groundCopy(
      "Your total is ₹1,899. Complete your purchase today.",
      facts,
      "llm"
    );
    expect(r.violations).toEqual([]);
    expect(r.fallback).toBe(false);
  });

  it("accepts incentive-scale amounts (₹100 off on a ₹100 incentive)", async () => {
    const r = await groundCopy("Here is ₹100 off for you today.", {
      incentive_paise: 10000,
      cart_total_paise: 189900,
      items: [],
    }, "llm");
    expect(r.fallback).toBe(false);
  });

  it("offer text keeps its printed amount (merchant-configured truth)", async () => {
    const r = await groundCopy("Get {{offer:HDFC}} now", {
      live_offers: [{ bank: "HDFC", description: "₹100 off HDFC cards" }],
    }, "llm");
    expect(r.fallback).toBe(false);
    expect(r.copy).toContain("₹100 off HDFC cards");
  });

  it("resolved token totals keep their rendered scale (₹4,979)", async () => {
    const r = await groundCopy(
      "Your all-in total is {{all_in_total:cart1}}. Complete your purchase to secure your items today.",
      { cart_total_paise: 500000, incentive_paise: 10000, shipping_paise: 7900 },
      "llm"
    );
    expect(r.fallback).toBe(false);
    expect(r.copy).toContain("₹4,979");
  });

  it("code-built copy with paise-under-₹ is rejected too", async () => {
    const r = await groundCopy("Pay ₹189900 today.", facts, "code");
    expect(r.violations.some((v) => v.startsWith("code_rupee_not_in_facts"))).toBe(true);
    expect(r.fallback).toBe(true);
  });
});
