import { describe, it, expect, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
  getConfig: vi.fn().mockReturnValue({}),
}));

vi.mock("../src/db.js", () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  getPool: vi.fn(),
  withTransaction: vi.fn(),
}));

const appended: any[] = [];
vi.mock("../src/lib/activity.js", () => ({
  appendActivity: vi.fn(async (row: any) => { appended.push(row); return appended.length; }),
}));

import {
  maskRecipient, stripContactsFromCopy, containsFullContact, emitMessageSent,
} from "../src/lib/messageStream.js";

describe("U-MSGSENT masking at emission (PII hard rule)", () => {
  it("phones mask to last-4 with country prefix", () => {
    expect(maskRecipient("+919876543210")).toBe("+91 ••••• 3210");
    expect(maskRecipient("+919876543210")).not.toContain("987654");
  });
  it("bare 10-digit and truncated 11-digit inputs still render +91", () => {
    expect(maskRecipient("9876543210")).toBe("+91 ••••• 3210");
    expect(maskRecipient("+91987654321")).toBe("+91 ••••• 4321");
  });
  it("emails hide the local part", () => {
    const m = maskRecipient("riya.sharma@example.com");
    expect(m).not.toContain("riya.sharma");
    expect(m).toContain("example.com");
  });
  it("empty contact → em dash", () => {
    expect(maskRecipient("")).toBe("—");
  });
  it("stripContactsFromCopy replaces emails + 10-digit runs, keeps short numbers", () => {
    const r = stripContactsFromCopy("Call +919876543210 or mail a@b.com; 3 left in stock, save 50 today");
    expect(r.stripped).toBe(true);
    expect(r.copy).not.toContain("+919876543210");
    expect(r.copy).not.toContain("a@b.com");
    expect(r.copy).toContain("3 left");
    expect(r.copy).toContain("50");
  });
  it("containsFullContact detects phones/emails, ignores short numbers", () => {
    expect(containsFullContact("Hi +919876543210")).toBe(true);
    expect(containsFullContact("mail me at a@b.com")).toBe(true);
    expect(containsFullContact("Only 3 left, save ₹50")).toBe(false);
  });
});

describe("U-MSGSENT emission shape", () => {
  it("emits MESSAGE_SENT with masked recipient, badges, and source tag", async () => {
    appended.length = 0;
    await emitMessageSent({
      merchantId: "m1", actor: "RecoveryBot", channel: "payment_link",
      messageCopy: "Your link expires Fri 6 PM.",
      rawCopy: "Your link {{expiry:hold1}}.",
      messageStrategy: "loss_framed", messageTone: "warm", brainMode: "llm",
      cartOrOrderRef: "cart-1",
      resolvedTokens: [{ token: "expiry:hold1", resolved_value: "Fri 6 PM" }],
      incentivePaise: 5000, simulated: false,
      maskedRecipient: "+91 ••••• 3210", sourceTag: "demo", ledgerSeq: 42,
    });
    expect(appended).toHaveLength(1);
    const row = appended[0];
    expect(row.type).toBe("MESSAGE_SENT");
    expect(row.source_tag).toBe("demo");
    expect(row.data.message_copy).toContain("Fri 6 PM");
    expect(row.data.raw_copy).toContain("{{expiry:hold1}}");
    expect(row.data.message_strategy).toBe("loss_framed");
    expect(row.data.brain_mode).toBe("llm");
    expect(row.data.masked_recipient).toBe("+91 ••••• 3210");
    expect(row.data.resolved_tokens[0]).toMatchObject({ token: "expiry:hold1", resolved_value: "Fri 6 PM" });
    expect(row.data.ledger_seq).toBe(42);
    expect(containsFullContact(JSON.stringify(row))).toBe(false);
  });

  it("strips a leaked contact from the copy (defense in depth)", async () => {
    appended.length = 0;
    await emitMessageSent({
      merchantId: "m1", actor: "ChatAgent", channel: "chat",
      messageCopy: "Hi, text +919876543210 for help",
      maskedRecipient: "+91 ••••• 3210",
    });
    expect(appended[0].data.message_copy).not.toContain("+919876543210");
    expect(appended[0].data.contact_stripped).toBe(true);
  });
});
