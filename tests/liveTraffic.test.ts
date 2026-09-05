import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
  getConfig: vi.fn().mockReturnValue({ BASE_URL: "http://test.local", SESSION_SECRET: "test-secret" }),
}));

vi.mock("../src/db.js", () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  getPool: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock("../src/lib/moneyBus.js", () => ({
  resolvePayment: vi.fn().mockResolvedValue(undefined),
}));

import { getDataMode, setDataMode, setDemoBg, ensureDataModeSchema } from "../src/lib/dataMode.js";
import { extractCartId, resolveSourceTag } from "../src/lib/activity.js";
import { trafficTick, startLiveTraffic, stopLiveTraffic, isLiveTrafficRunning } from "../src/lib/liveTraffic.js";

function memQ() {
  const state: any = { mode: "demo", demo_bg_enabled: true };
  const calls: string[] = [];
  const q = async (sql: string, params?: any[]) => {
    calls.push(sql);
    if (sql.includes("UPDATE data_mode SET mode")) state.mode = params?.[0];
    if (sql.includes("UPDATE data_mode SET demo_bg_enabled")) state.demo_bg_enabled = params?.[0];
    if (sql.includes("SELECT mode")) return { rows: [state] };
    return { rows: [] };
  };
  return { q, state, calls };
}

describe("U-MODE data_mode state", () => {
  it("defaults to demo, persists live across reads (restart-safe DB row)", async () => {
    const { q } = memQ();
    expect((await getDataMode(q)).mode).toBe("demo");
    await setDataMode(q, "live", "admin");
    expect((await getDataMode(q)).mode).toBe("live");
    await setDataMode(q, "demo", "admin");
    expect((await getDataMode(q)).mode).toBe("demo");
  });
  it("rejects invalid modes", async () => {
    const { q } = memQ();
    await expect(setDataMode(q, "prod", "admin")).rejects.toThrow();
  });
  it("demo_bg toggles independently of mode", async () => {
    const { q } = memQ();
    await setDemoBg(q, false, "admin");
    const st = await getDataMode(q);
    expect(st.demo_bg_enabled).toBe(false);
    expect(st.mode).toBe("demo");
  });
  it("ensure runs the idempotent schema SQL", async () => {
    const { q, calls } = memQ();
    await ensureDataModeSchema(q);
    expect(calls.join("\n")).toMatch(/CREATE TABLE IF NOT EXISTS data_mode/);
  });
});

describe("source_tag inference (pure)", () => {
  it("extractCartId finds cart_id/cartId/cart_or_order_ref", () => {
    expect(extractCartId({ cart_id: "c1" })).toBe("c1");
    expect(extractCartId({ cartId: "c2" })).toBe("c2");
    expect(extractCartId({ cart_or_order_ref: "c3" })).toBe("c3");
    expect(extractCartId({})).toBe(null);
    expect(extractCartId(null)).toBe(null);
  });
  it("resolveSourceTag: explicit wins, then cart, else system; garbage → system", () => {
    expect(resolveSourceTag("live", "demo")).toBe("live");
    expect(resolveSourceTag(null, "demo-bg")).toBe("demo-bg");
    expect(resolveSourceTag(null, null)).toBe("system");
    expect(resolveSourceTag("evil", "demo")).toBe("demo");
    expect(resolveSourceTag("evil", "junk")).toBe("system");
  });
});

function mockDeps(rngVal: number, overrides: any = {}) {
  const posts: Array<{ path: string; body: any; headers: any }> = [];
  const notes: any[] = [];
  const fetchFn: any = async (url: string, opts: any) => {
    posts.push({ path: String(url).replace("http://test.local", ""), body: JSON.parse(opts.body || "{}"), headers: opts.headers || {} });
    return { ok: true, json: async () => ({ total_paise: 1000, success: true }) };
  };
  const store = {
    randomProduct: async () => ({ id: "prod-1", price_paise: 1000 }),
    randomActiveCart: async () => ({ id: "cart-1" }),
    randomLiveLink: async () => ({
      id: "link-1", merchant_id: "m1", razorpay_link_id: "plink_1", audit_seq: 1,
      amount_paise: 1000, incentive_paise: 0, cart_id: "cart-1", customer_id: "c1",
    }),
    ...overrides.store,
  };
  return {
    deps: {
      fetchFn, rng: () => rngVal, store,
      activityAppend: async (row: any) => { notes.push(row); return 1; },
      baseUrl: "http://test.local", siteKey: "site", serverKey: "server",
      ...overrides.deps,
    },
    posts, notes,
  };
}

describe("U-LIVETRAFFIC simulator ticks (endpoint-path only)", () => {
  beforeEach(() => { stopLiveTraffic(); });

  it("new_cart posts to /api/track/cart with source_tag live (public key only)", async () => {
    const { deps, posts, notes } = mockDeps(0.05);
    expect(await trafficTick(deps)).toBe("new_cart");
    const cart = posts.find((p) => p.path === "/api/track/cart");
    expect(cart?.body.source_tag).toBe("live");
    expect(cart?.headers["X-Track-Key"]).toBe("site");
    expect(notes[0]?.source_tag).toBe("live");
  });

  it("returning binds through the secret endpoint with the live tag", async () => {
    const { deps, posts } = mockDeps(0.45);
    expect(await trafficTick(deps)).toBe("returning");
    const bind = posts.find((p) => p.path === "/api/track/bind-customer");
    expect(bind?.body.source_tag).toBe("live");
    expect(bind?.headers["X-Server-Key"]).toBe("server");
  });

  it("checkout uses the no-auth checkout-start endpoint", async () => {
    const { deps, posts } = mockDeps(0.6);
    expect(await trafficTick(deps)).toBe("checkout");
    expect(posts.some((p) => p.path === "/api/track/checkout-start")).toBe(true);
  });

  it("went_quiet touches nothing (no posts) but stays observable", async () => {
    const { deps, posts, notes } = mockDeps(0.75);
    expect(await trafficTick(deps)).toBe("went_quiet");
    expect(posts).toHaveLength(0);
    expect(notes).toHaveLength(1);
  });

  it("pay_success resolves through the production money path", async () => {
    const { resolvePayment } = await import("../src/lib/moneyBus.js");
    const { deps } = mockDeps(0.85);
    expect(await trafficTick(deps)).toBe("pay_success");
    expect(resolvePayment).toHaveBeenCalled();
  });

  it("pay_fail self-calls the audited QA injector (minted session + csrf pair)", async () => {
    const { deps, posts } = mockDeps(0.92);
    expect(await trafficTick(deps)).toBe("pay_fail");
    const inj = posts.find((p) => p.path === "/api/qa/inject-payment-failure");
    expect(inj).toBeDefined();
    expect(inj?.headers["X-CSRF-Token"]).toBeDefined();
    expect(String(inj?.headers.Cookie || "")).toMatch(/session=.+; csrf=.+/);
  });

  it("convert marks via the convert endpoint", async () => {
    const { deps, posts } = mockDeps(0.98);
    expect(await trafficTick(deps)).toBe("convert");
    expect(posts.some((p) => p.path === "/api/track/convert")).toBe(true);
  });

  it("falls back to new_cart when no active cart/link exists", async () => {
    const { deps } = mockDeps(0.6, { store: { randomActiveCart: async () => null } });
    expect(await trafficTick(deps)).toBe("new_cart");
  });

  it("never throws on endpoint errors (returns idle)", async () => {
    const { deps } = mockDeps(0.05);
    deps.fetchFn = async () => { throw new Error("down"); };
    expect(await trafficTick(deps)).toBe("idle");
  });

  it("start/stop is idempotent", async () => {
    const { deps } = mockDeps(0.05);
    expect(isLiveTrafficRunning()).toBe(false);
    await startLiveTraffic(deps);
    expect(isLiveTrafficRunning()).toBe(true);
    await startLiveTraffic(deps);
    expect(isLiveTrafficRunning()).toBe(true);
    stopLiveTraffic();
    expect(isLiveTrafficRunning()).toBe(false);
  });
});
