import { describe, it, expect } from "vitest";
import { fastForwardDeferred, type FastForwardDeps } from "../src/lib/fastForward.js";

function makeDeps(scenario: { intents: any[]; carts: Record<string, string | null> }): {
  deps: FastForwardDeps; ledger: any[]; activity: any[]; dispatched: string[]; queries: string[];
} {
  const ledger: any[] = [];
  const activity: any[] = [];
  const dispatched: string[] = [];
  const queries: string[] = [];
  const deps: FastForwardDeps = {
    merchantId: "m1",
    ledgerAppend: async (e: any) => { ledger.push(e); return { seq: ledger.length }; },
    activityAppend: async (e: any) => { activity.push(e); return 1; },
    dispatchRecovery: async (cartId: string) => { dispatched.push(cartId); },
    q: async (sql: string, params?: any[]) => {
      queries.push(sql);
      if (sql.includes("FROM action_intents")) return { rows: scenario.intents };
      if (sql.includes("FROM carts")) {
        const cartId = params?.[0];
        const status = scenario.carts[cartId];
        return { rows: status ? [{ status, customer_id: "c1" }] : [] };
      }
      return { rows: [] };
    },
  };
  return { deps, ledger, activity, dispatched, queries };
}

describe("U-FFWD fast-forward deferred (DB-free gate)", () => {
  it("(a) deferred recovery intent dispatches with ledger row reason fast_forwarded", async () => {
    const { deps, ledger, activity, dispatched } = makeDeps({
      intents: [{ id: "i1", merchant_id: "m1", customer_id: "c1", target_id: "cart1", action_type: "recovery_24h" }],
      carts: { cart1: "abandoned" },
    });
    const r = await fastForwardDeferred(deps);
    expect(r.dispatched).toBe(1);
    expect(r.cancelled).toBe(0);
    expect(dispatched).toEqual(["cart1"]);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].rationale.reason).toBe("fast_forwarded");
    expect(activity.at(-1)?.summary).toMatch(/dispatched 1/);
  });

  it("(a) cart-paid intent cancels itself with reason fast_forward_cart_paid (no dispatch)", async () => {
    const { deps, ledger, dispatched } = makeDeps({
      intents: [{ id: "i2", merchant_id: "m1", customer_id: "c1", target_id: "cart2", action_type: "recovery_24h" }],
      carts: { cart2: "paid" },
    });
    const r = await fastForwardDeferred(deps);
    expect(r.dispatched).toBe(0);
    expect(r.cancelled).toBe(1);
    expect(dispatched).toEqual([]);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].rationale.reason).toBe("fast_forward_cart_paid");
  });

  it("(b) zero deferred emits a visible nothing-deferred event (never silent)", async () => {
    const { deps, activity, ledger } = makeDeps({ intents: [], carts: {} });
    const r = await fastForwardDeferred(deps);
    expect(r.nothingDeferred).toBe(true);
    expect(activity).toHaveLength(1);
    expect(activity[0].summary).toBe("FAST_FORWARD: nothing deferred");
    expect(ledger).toHaveLength(0);
  });

  it("(c) one ledger row per fast-forwarded intent", async () => {
    const { deps, ledger } = makeDeps({
      intents: [
        { id: "i1", merchant_id: "m1", customer_id: "c1", target_id: "cart1", action_type: "recovery_24h" },
        { id: "i3", merchant_id: "m1", customer_id: "c1", target_id: "cart3", action_type: "upsell_nudge" },
      ],
      carts: { cart1: "abandoned", cart3: "abandoned" },
    });
    const r = await fastForwardDeferred(deps);
    expect(r.dispatched).toBe(2);
    expect(ledger).toHaveLength(2);
    expect(ledger.every((e) => e.rationale.reason === "fast_forwarded")).toBe(true);
  });
});
