import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
  getConfig: vi.fn().mockReturnValue({ BASE_URL: "http://test.local", SESSION_SECRET: "test-secret" }),
}));

vi.mock("../src/db.js", () => ({
  query: vi.fn(),
  getPool: vi.fn(),
  withTransaction: vi.fn(),
}));

import { classifyLink } from "../src/lib/reconcile.js";
import {
  isFailedAttempt,
  isCapturedAttempt,
  extractFailedAttempts,
  recordLinkPaymentFailure,
  matchFailedToLink,
} from "../src/lib/linkFailures.js";

describe("reconcile simulated bucket (zero-critical target)", () => {
  it("simulated paid-vs-created is expected, never critical", () => {
    const v = classifyLink("paid", "created", false, true);
    expect(v.matched).toBe(true);
    expect(v.simulated).toBe(true);
    expect(v.severity).not.toBe("critical");
  });
  it("real paid-vs-created stays critical", () => {
    const v = classifyLink("paid", "created", false, false);
    expect(v.matched).toBe(false);
    expect(v.severity).toBe("critical");
  });
  it("simulated flag changes nothing when states agree", () => {
    expect(classifyLink("live", "created", false, true).matched).toBe(true);
  });
});

describe("link failure classification (pure)", () => {
  it("failed/rejected attempts detected, case-insensitive", () => {
    expect(isFailedAttempt({ id: "pay_1", status: "failed" })).toBe(true);
    expect(isFailedAttempt({ id: "pay_2", status: "Failed" })).toBe(true);
    expect(isFailedAttempt({ id: "pay_3", status: "rejected" })).toBe(true);
  });
  it("captured/authorized attempts are not failures", () => {
    expect(isFailedAttempt({ id: "pay_4", status: "captured" })).toBe(false);
    expect(isFailedAttempt({ id: "pay_5", status: "authorized" })).toBe(false);
    expect(isFailedAttempt({ id: "pay_6", status: "created" })).toBe(false);
    expect(isFailedAttempt(null)).toBe(false);
    expect(isFailedAttempt({})).toBe(false);
  });
  it("captured/authorized detected for the sweep resolver", () => {
    expect(isCapturedAttempt({ id: "pay_7", status: "captured" })).toBe(true);
    expect(isCapturedAttempt({ id: "pay_8", status: "authorized" })).toBe(true);
    expect(isCapturedAttempt({ id: "pay_9", status: "failed" })).toBe(false);
    expect(isCapturedAttempt(null)).toBe(false);
  });
  it("extracts only failures from a link payload, tolerates missing arrays", () => {
    const link = { payments: [{ id: "a", status: "failed" }, { id: "b", status: "captured" }] };
    expect(extractFailedAttempts(link).map((p: any) => p.id)).toEqual(["a"]);
    expect(extractFailedAttempts({})).toEqual([]);
    expect(extractFailedAttempts(null)).toEqual([]);
  });
});

describe("gateway payment → link matching (pure)", () => {
  const links: any[] = [
    { id: "l1", razorpay_link_id: "plink_AAA", merchant_id: "m", cart_id: "cart-1", customer_id: "c1", amount_paise: 189900, ext_ref: "ext-1", short_url: "https://rzp.io/l/aaa" },
    { id: "l2", razorpay_link_id: "plink_BBB", merchant_id: "m", cart_id: "cart-2", customer_id: "c2", amount_paise: 99900, ext_ref: "ext-2", short_url: "https://rzp.io/l/bbb" },
  ];
  it("matches on notes.ext_ref exactly", () => {
    const hit = matchFailedToLink({ id: "pay_1", status: "failed", notes: { ext_ref: "ext-2" } }, links);
    expect(hit?.id).toBe("l2");
  });
  it("falls back to notes.cart_id", () => {
    const hit = matchFailedToLink({ id: "pay_2", status: "failed", notes: { cart_id: "cart-1" } }, links);
    expect(hit?.id).toBe("l1");
  });
  it("falls back to the link fragment in description", () => {
    const hit = matchFailedToLink({ id: "pay_3", status: "failed", description: "#TYKWZ6FyGZiBVK" }, [
      { ...links[0], razorpay_link_id: "plink_TYKWZ6FyGZiBVK" },
    ]);
    expect(hit?.id).toBe("l1");
  });
  it("returns null when nothing matches (no false attribution)", () => {
    expect(matchFailedToLink({ id: "pay_4", status: "failed", notes: {} }, links)).toBe(null);
    expect(matchFailedToLink({ id: "pay_5", status: "failed" }, links)).toBe(null);
    expect(matchFailedToLink(null, links)).toBe(null);
  });
});

describe("link failure recording (dedupe by payment id)", () => {
  beforeEach(() => vi.clearAllMocks());

  async function mockDb(firstSeen: boolean) {
    const db = await import("../src/db.js");
    const q = db.query as any;
    q.mockImplementation(async (sql: string) => {
      if (sql.includes("link_payment_attempts") && sql.includes("ON CONFLICT")) {
        return { rows: firstSeen ? [{ razorpay_payment_id: "pay_9" }] : [] };
      }
      if (sql.includes("INSERT INTO orders")) return { rows: [{ id: "order-1" }] };
      return { rows: [] };
    });
    return q;
  }

  const link: any = {
    id: "link-1", merchant_id: "m1", razorpay_link_id: "plink_1",
    cart_id: "cart-1", customer_id: "cust-1", amount_paise: 189900,
    short_url: "https://rzp.io/l/abc",
  };

  it("first sighting records + creates the failed order", async () => {
    const q = await mockDb(true);
    const r = await recordLinkPaymentFailure(q, link, { id: "pay_9", status: "failed", method: "upi" });
    expect(r.isNew).toBe(true);
    expect(r.orderId).toBe("order-1");
    const orderCall = q.mock.calls.find((c: any[]) => c[0].includes("INSERT INTO orders"));
    expect(orderCall).toBeDefined();
    expect(orderCall[0]).toContain("'direct'"); // fresh-DB CHECK-safe source
    expect(orderCall[1][3]).toBe(189900); // amount falls back to the link total
  });

  it("re-sighting is a silent no-op (no order, no nudge trigger)", async () => {
    const q = await mockDb(false);
    const r = await recordLinkPaymentFailure(q, link, { id: "pay_9", status: "failed", method: "upi" });
    expect(r.isNew).toBe(false);
    expect(r.orderId).toBe(null);
    expect(q.mock.calls.some((c: any[]) => c[0].includes("INSERT INTO orders"))).toBe(false);
  });

  it("payment without id never records", async () => {
    const q = await mockDb(true);
    const r = await recordLinkPaymentFailure(q, link, { status: "failed" });
    expect(r.isNew).toBe(false);
  });
});
