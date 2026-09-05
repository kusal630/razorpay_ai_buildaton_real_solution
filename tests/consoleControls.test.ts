import { describe, it, expect } from "vitest";
import fs from "node:fs";

const dash = fs.readFileSync("src/public/dashboard/index.html", "utf8");
const ops = fs.readFileSync("src/routes/ops.ts", "utf8");
const server = fs.readFileSync("src/server.ts", "utf8");

// Structural tests over the SHIPPED artifact (repo style: U-UIFIX/U-BANNER
// assert on dashboard source the same way).

describe("U-PAUSE console pause (view-only)", () => {
  it("pause/resume button, 500-cap drop-oldest buffer, last-50 + count notice", () => {
    expect(dash).toMatch(/id="pause-btn"/);
    expect(dash).toMatch(/localStorage\.getItem\('feedPaused'\)/);
    expect(dash).toMatch(/pausedBuffer\.length >= 500/);
    expect(dash).toMatch(/pausedBuffer\.shift\(\); pausedDropped\+\+/);
    expect(dash).toMatch(/pausedBuffer\.slice\(-50\)/);
    expect(dash).toMatch(/events occurred while paused — showing last/);
    expect(dash).toMatch(/ledger still recording/);
  });
  it("pause never touches the pipeline (no SSE close, no ledger write in pause path)", () => {
    const pauseBlock = dash.slice(dash.indexOf("function togglePause"), dash.indexOf("function syncPauseBtn"));
    expect(pauseBlock).not.toMatch(/eventSource\.close|DELETE|TRUNCATE/);
  });
});

describe("U-FILTER chips", () => {
  it("actor/type/special chip sets incl MESSAGES only + clear-all + persistence", () => {
    for (const chip of ["RecoveryBot", "UpsellBot", "Poller", "Buyer", "System", "Admin"]) {
      expect(dash).toContain(`'${chip}'`);
    }
    for (const chip of ["TRIGGER", "DECISION", "POLICY", "LINK", "PAYMENT", "ERROR"]) {
      expect(dash).toContain(`'${chip}'`);
    }
    for (const chip of ["BLOCKED only", "ESCALATED only", 'mode:"llm" only', "SIMULATED only", "REAL only", "source: live", "source: demo", "MESSAGES only"]) {
      expect(dash).toContain(chip);
    }
    expect(dash).toMatch(/clear all|clearFilters/);
    expect(dash).toMatch(/localStorage\.getItem\('feedFilters'\)/);
  });
  it("BLOCKED matches severity warning; MESSAGES matches MESSAGE_SENT; AND documented", () => {
    expect(dash).toMatch(/case 'BLOCKED only': return r\.severity === 'warning'/);
    expect(dash).toMatch(/MESSAGES only/);
    expect(dash).toMatch(/OR within a chip group, AND across groups/);
  });
});

describe("U-SCROLL auto-scroll intelligence", () => {
  it("follows at bottom, suspends scrolled-up, jump pill counts + re-engages", () => {
    expect(dash).toMatch(/id="jump-pill"/);
    expect(dash).toMatch(/scrollHeight - el\.scrollTop - el\.clientHeight < 120/);
    expect(dash).toMatch(/jumpToLatest/);
    expect(dash).toMatch(/awayCount/);
  });
});

describe("event inspection overlay (flood-proof)", () => {
  it("fixed overlay, independent scroll, pin keeps selection", () => {
    expect(dash).toMatch(/#event-overlay[^}]*position: fixed/);
    expect(dash).toMatch(/id="pin-btn"/);
    expect(dash).toMatch(/if \(overlayPinned\) return/);
  });
  it("MESSAGE_SENT overlay shows channel, mask, ledger seq, token diff", () => {
    expect(dash).toMatch(/token-diff-raw/);
    expect(dash).toMatch(/token-diff-resolved/);
    expect(dash).toMatch(/masked_recipient/);
    expect(dash).toMatch(/Ledger seq/);
  });
});

describe("U-CLEAR view-only clear", () => {
  it("button + tooltip, marker text, buffer discard counted, no SSE reconnect", () => {
    expect(dash).toMatch(/id="clear-btn"/);
    expect(dash).toMatch(/Clears the view only — the ledger keeps everything/);
    expect(dash).toMatch(/Console cleared · full history in Ledger/);
    expect(dash).toMatch(/buffered events discarded/);
    const clearBlock = dash.slice(dash.indexOf("function clearConsole"), dash.indexOf("function toggleShortcuts"));
    expect(clearBlock).not.toMatch(/eventSource\.close|new EventSource|DELETE|TRUNCATE/);
  });
  it("keyboard: C clears, Space pauses, F filters — ignored while typing", () => {
    expect(dash).toMatch(/e\.key === 'c'/);
    expect(dash).toMatch(/e\.code === 'Space'/);
    expect(dash).toMatch(/e\.key === 'f'/);
    expect(dash).toMatch(/INPUT.*TEXTAREA.*SELECT/);
  });
});

describe("U-MODE toggle + badge (shipped wiring)", () => {
  it("dashboard: badge, confirm-on-live, bg sub-toggle, audited endpoints", () => {
    expect(dash).toMatch(/id="data-mode-badge"/);
    expect(dash).toMatch(/Live mode adds continuous traffic — console will stay busy\. Switch\?/);
    expect(dash).toMatch(/id="bg-toggle"/);
    expect(dash).toMatch(/\/api\/data-mode/);
    expect(dash).toMatch(/\/api\/demo-bg/);
  });
  it("server: mode routes audited, simulator start/stop on toggle", () => {
    expect(ops).toMatch(/\/api\/data-mode/);
    expect(ops).toMatch(/\/api\/demo-bg/);
    expect(ops).toMatch(/data_mode:/);
    expect(ops).toMatch(/demo_bg:/);
    expect(ops).toMatch(/startLiveTraffic/);
    expect(ops).toMatch(/stopLiveTraffic/);
  });
  it("server boot: schema ensure, empty-DB seed guard, live autostart, bg gating", () => {
    expect(server).toMatch(/ensureDataModeSchema/);
    expect(server).toMatch(/getDataMode/);
    expect(server).toMatch(/startLiveTraffic/);
    expect(server).toMatch(/demo-bg/);
    expect(server).toMatch(/demo_bg_enabled/);
  });
});

describe("MESSAGE_SENT row rendering", () => {
  it("bubble, strategy/tone/brain badges, masked recipient, no full contact", () => {
    expect(dash).toMatch(/msg-bubble/);
    expect(dash).toMatch(/message_strategy/);
    expect(dash).toMatch(/brain_mode/);
    expect(dash).toMatch(/masked_recipient/);
    expect(dash).toMatch(/✉/);
  });
});
