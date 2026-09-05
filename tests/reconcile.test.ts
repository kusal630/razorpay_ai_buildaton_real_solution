import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { canonicalLinkStatus, classifyLink } from "../src/lib/reconcile.js";

describe("reconcile vocabulary (the 32-critical false alarm)", () => {
  it("local live == remote created (same awaiting-payment state)", () => {
    expect(canonicalLinkStatus("live")).toBe(canonicalLinkStatus("created"));
    expect(classifyLink("live", "created", false).matched).toBe(true);
  });
  it("local live == remote partially_paid", () => {
    expect(classifyLink("live", "partially_paid", false).matched).toBe(true);
  });
  it("real divergence stays critical (we say paid, gateway says created)", () => {
    const v = classifyLink("paid", "created", false);
    expect(v.matched).toBe(false);
    expect(v.severity).toBe("critical");
  });
  it("paid == paid still matches", () => {
    expect(classifyLink("paid", "paid", false).matched).toBe(true);
  });
  it("unreachable gateway is warn, never critical", () => {
    const v = classifyLink("live", null, true);
    expect(v.matched).toBe(false);
    expect(v.severity).toBe("warn");
    expect(v.status_remote).toBe("unreachable");
  });
});

describe("console fixes static contract", () => {
  const html = fs.readFileSync(
    path.join(process.cwd(), "src", "public", "dashboard", "index.html"),
    "utf8"
  );
  it("chips use data-attributes + delegation (no inline onclick quote breakage)", () => {
    expect(html).toContain("data-group");
    expect(html).toContain("closest('.chip[data-group]')");
    expect(html).not.toContain(`onclick="toggleChip(`);
  });
  it("feed badge counts the visible viewport, not the raw buffer", () => {
    expect(html).toContain("lastVisible.length");
  });
  it("ledger/approvals reload on tab visit (never stale)", () => {
    expect(html).toMatch(/tab\.dataset\.tab === 'ledger'/);
    expect(html).toMatch(/tab\.dataset\.tab === 'approvals'/);
  });
  it("mode switch disables buttons mid-flight", () => {
    expect(html).toContain("b.disabled = true");
  });
});

describe("demo quarantine static contract", () => {
  const srv = fs.readFileSync(path.join(process.cwd(), "src", "server.ts"), "utf8");
  it("scheduler skips live-tagged carts while in demo mode", () => {
    expect(srv).toContain(`<> 'live'`);
    expect(srv).toMatch(/mode === "demo"/);
  });
});

describe("payment broadcast static contract", () => {
  const money = fs.readFileSync(path.join(process.cwd(), "src", "lib", "moneyBus.ts"), "utf8");
  const ledger = fs.readFileSync(path.join(process.cwd(), "src", "lib", "ledger.ts"), "utf8");
  it("resolvePayment captures feed rows and broadcasts post-commit", () => {
    expect(money).toContain("RETURNING id, ts");
    expect(money).toContain("broadcastActivity");
  });
  it("resolveLedger broadcasts its LEDGER_* row post-commit", () => {
    expect(ledger).toContain("broadcastActivity");
    expect(ledger).toContain("pendingBroadcast");
  });
});
