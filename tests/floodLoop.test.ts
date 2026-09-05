import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Flood regression: every scheduler-triggered path must leave a
// scan-blocking intent row on EVERY exit, so a cart that cannot proceed
// goes quiet instead of re-firing TRIGGER on every 15s pass.
describe("flood loop-proofing static contract", () => {
  const bot = fs.readFileSync(
    path.join(process.cwd(), "src", "agents", "recoveryBot.ts"), "utf8"
  );
  const srv = fs.readFileSync(path.join(process.cwd(), "src", "server.ts"), "utf8");
  const exec = fs.readFileSync(
    path.join(process.cwd(), "src", "lib", "intentExecutor.ts"), "utf8"
  );

  it("write-ahead intent precedes velocity/funnel guards in processAbandonedCart", () => {
    const intentAt = bot.indexOf("WRITE-AHEAD INTENT FIRST");
    const velocityAt = bot.indexOf("velocity_early_cap");
    const funnelAt = bot.indexOf("isRecoverySuspended(query");
    expect(intentAt).toBeGreaterThan(-1);
    expect(velocityAt).toBeGreaterThan(intentAt);
    expect(funnelAt).toBeGreaterThan(intentAt);
  });

  it("paid-skip leaves a blocking row (failIntent skipped)", () => {
    const section = bot.slice(bot.indexOf("PAID-SKIP: never chase"));
    expect(section).toContain('failIntent(intent.intentId, "skipped")');
  });

  it("final call creates its intent before any guard exit", () => {
    const createAt = bot.indexOf('actionType: "recovery_final"');
    const abstainAt = bot.indexOf("no_prior_link");
    expect(createAt).toBeGreaterThan(-1);
    expect(abstainAt).toBeGreaterThan(createAt);
  });

  it("abandon-marking handoff is guarded too (RETURNING carries customer_id)", () => {
    expect(srv).toContain("RETURNING id, customer_id");
    expect(srv).toContain("markedActionable");
  });

  it("scheduler tick is single-flight with a visible skip log", () => {
    expect(srv).toContain("tickInFlight");
    expect(srv).toMatch(/previous tick still running/);
  });

  it("intent janitor runs inside the scheduler tick (not only via workers)", () => {
    expect(srv).toContain("runJanitor");
  });

  it("janitor still expires past-window rows and resets stale gateway waits", () => {
    expect(exec).toContain("awaiting_gateway");
    expect(exec).toContain("SET status = 'expired'");
  });

  it("ingestion anchors transactional consent (bind + checkout-start)", () => {
    const track = fs.readFileSync(
      path.join(process.cwd(), "src", "routes", "track.ts"), "utf8"
    );
    expect(track.match(/anchorTransactional/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("gateway calls are time-bounded (a hung socket cannot wedge the tick)", () => {
    expect(srv).toContain("withTimeout");
    expect(srv).toContain("GATEWAY_TIMEOUT_MS");
    const money = fs.readFileSync(
      path.join(process.cwd(), "src", "lib", "moneyBus.ts"), "utf8"
    );
    expect(money).toContain("withTimeout");
  });

  it("poller stops the pass on 429 instead of burning the rate budget", () => {
    expect(srv).toMatch(/throttled.*429|429.*throttl/i);
  });

  it("failure scan requires a cart (cart-less failed orders cannot retry)", () => {
    expect(srv).toContain("o.cart_id IS NOT NULL");
  });
});
