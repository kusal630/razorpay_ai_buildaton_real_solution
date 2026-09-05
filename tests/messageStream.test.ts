import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
  getConfig: vi.fn().mockReturnValue({}),
}));

vi.mock("../src/db.js", () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  getPool: vi.fn(),
  withTransaction: vi.fn(),
}));

import {
  maskRecipient,
  stripContactsFromCopy,
  containsFullContact,
  emitMessageSent,
} from "../src/lib/messageStream.js";

describe("U-MSGSENT masking (emission-time, last-4 only)", () => {
  it("masks phones to last-4 with no full contact leaking", () => {
    const m = maskRecipient("+919876543210");
    expect(m).toContain("3210");
    expect(m).not.toContain("9876543210");
    expect(containsFullContact(m)).toBe(false);
  });
  it("masks emails without leaking the local part", () => {
    const m = maskRecipient("riya.sharma@example.com");
    expect(m).toContain("example.com");
    expect(m).not.toContain("riya.sharma");
    expect(containsFullContact(m)).toBe(false);
  });
  it("message_copy is scrubbed of contacts at emission", () => {
    const { copy, stripped } = stripContactsFromCopy(
      "Hi! Call +919876543210 or mail riya@example.com to pay."
    );
    expect(stripped).toBe(true);
    expect(containsFullContact(copy)).toBe(false);
  });
  it("plain copy passes through untouched", () => {
    const { copy, stripped } = stripContactsFromCopy(
      "Your cart is reserved. Complete your purchase today."
    );
    expect(stripped).toBe(false);
    expect(copy).toContain("reserved");
  });
});

describe("U-MSGSENT emission shape", () => {
  beforeEach(() => vi.clearAllMocks());
  it("emits MESSAGE_SENT with resolved copy, badges, masked recipient, no PII", async () => {
    const { appendActivity } = await import("../src/lib/activity.js");
    const spy = vi.spyOn({ appendActivity }, "appendActivity");
    void spy;
    const db = await import("../src/db.js");
    const qSpy = db.query as any;
    qSpy.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO activity")) return { rows: [{ id: 999 }] };
      return { rows: [] };
    });
    const id = await emitMessageSent({
      merchantId: "m1",
      actor: "RecoveryBot",
      channel: "payment_link",
      messageCopy: "Your reserved items release tonight at 9 PM. Complete your purchase.",
      rawCopy: "Your reserved items release {{expiry:hold-1}}. Complete your purchase.",
      messageStrategy: "loss_framed",
      messageTone: "warm",
      brainMode: "llm",
      cartOrOrderRef: "cart-1",
      resolvedTokens: [{ token: "expiry:hold-1", resolved_value: "9 PM" }],
      incentivePaise: 10000,
      maskedRecipient: maskRecipient("+919876543210"),
    });
    expect(id).toBe(999);
    const row = qSpy.mock.calls.find((c: any[]) => String(c[0]).includes("INSERT INTO activity"));
    expect(row).toBeDefined();
    const payload = JSON.parse(row[1][5]);
    expect(payload.message_copy).toContain("9 PM");
    expect(payload.masked_recipient).toContain("3210");
    expect(payload.masked_recipient).not.toContain("9876543210");
    expect(payload.brain_mode).toBe("llm");
    expect(payload.message_strategy).toBe("loss_framed");
    expect(containsFullContact(JSON.stringify(payload))).toBe(false);
  });
});

describe("console controls static contract (U-CLEAR / U-FILTER / U-SCROLL)", () => {
  const html = fs.readFileSync(
    path.join(process.cwd(), "src", "public", "dashboard", "index.html"),
    "utf8"
  );
  it("Clear is view-only: no SSE reconnect on clear", () => {
    expect(html).toContain("clearConsole()");
    // clearConsole must not close/reopen the EventSource (no reconnect artifacts).
    const fn = html.slice(html.indexOf("function clearConsole()"), html.indexOf("function clearConsole()") + 1200);
    expect(fn).not.toMatch(/EventSource|startSSE/);
    expect(fn).toMatch(/pausedBuffer/); // paused clear discards the buffer
  });
  it("keyboard: C clears, Space pauses, F filters; ignored while typing", () => {
    expect(html).toMatch(/e\.key === 'c'/);
    expect(html).toMatch(/e\.code === 'Space'/);
    expect(html).toMatch(/INPUT.*TEXTAREA.*SELECT/);
  });
  it("spec chips present (actors, types, MESSAGES only)", () => {
    for (const chip of ["RecoveryBot", "UpsellBot", "Poller", "Buyer", "System", "Admin"]) {
      expect(html).toContain(`'${chip}'`);
    }
    expect(html).toContain("MESSAGES only");
    expect(html).toContain("source: live");
    expect(html).toContain("source: demo");
  });
  it("MESSAGE_SENT bubble + token-diff overlay render masked recipient only", () => {
    expect(html).toContain("msg-bubble");
    expect(html).toContain("token-diff-raw");
    expect(html).toContain("token-diff-resolved");
    expect(html).toContain("masked_recipient");
    expect(html).not.toMatch(/contact_enc|decrypt/);
  });
  it("jump pill + bottom-proximity auto-scroll guard exist", () => {
    expect(html).toContain("jump-pill");
    expect(html).toMatch(/scrollHeight - el\.scrollTop - el\.clientHeight/);
  });
});
