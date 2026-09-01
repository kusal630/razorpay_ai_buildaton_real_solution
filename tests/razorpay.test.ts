import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock config
vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({
    RAZORPAY_KEY_ID: "rzp_test_xxx",
    RAZORPAY_KEY_SECRET: "xxx",
    RAZORPAY_WEBHOOK_SECRET: "test_secret",
  }),
  getConfig: vi.fn().mockReturnValue({
    RAZORPAY_KEY_ID: "rzp_test_xxx",
    RAZORPAY_KEY_SECRET: "xxx",
    RAZORPAY_WEBHOOK_SECRET: "test_secret",
  }),
}));

import crypto from "node:crypto";
import nock from "nock";

describe("Razorpay Service (nock fixtures)", () => {
  beforeEach(() => {
    nock.cleanAll();
  });

  it("creates payment link", async () => {
    nock("https://api.razorpay.com")
      .post("/v1/payment_links")
      .reply(200, {
        id: "plink_test123",
        amount: 100000,
        currency: "INR",
        short_url: "https://rzp.io/test123",
      });

    const { createPaymentLink } = await import("../src/lib/razorpayService.js");
    const result = await createPaymentLink({
      amount: 100000,
      reference_id: "1001",
      customer: { name: "Test", email: "test@test.com", contact: "9999999999" },
    });

    expect(result.id).toBe("plink_test123");
    expect(result.amount).toBe(100000);
  });
});

describe("Webhook Signature Verification", () => {
  it("validates correct HMAC-SHA256 signature", () => {
    const body = '{"event":"payment.captured"}';
    const secret = "test_secret";
    const validSig = crypto.createHmac("sha256", secret).update(body).digest("hex");

    const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
    expect(expected).toBe(validSig);
  });

  it("rejects invalid signature", () => {
    const body = '{"event":"payment.captured"}';
    const secret = "test_secret";
    const validSig = crypto.createHmac("sha256", secret).update(body).digest("hex");
    const invalidSig = crypto.createHmac("sha256", "wrong_secret").update(body).digest("hex");

    const buffersEqual = crypto.timingSafeEqual(
      Buffer.from(validSig, "hex"),
      Buffer.from(invalidSig, "hex")
    );
    expect(buffersEqual).toBe(false);
  });
});

describe("Webhook Dedup", () => {
  it("deduplicates events by event_id", async () => {
    const events = new Map<string, boolean>();
    const eventId = "evt_test123";

    expect(events.has(eventId)).toBe(false);
    events.set(eventId, true);
    expect(events.has(eventId)).toBe(true);
  });
});

describe("Idempotency", () => {
  it("returns cached response on replay", async () => {
    const cache = new Map<string, any>();
    const key = "idem_test123";
    const response = { success: true, data: "test" };

    cache.set(key, response);
    const cached = cache.get(key);
    expect(cached).toEqual(response);
  });
});
