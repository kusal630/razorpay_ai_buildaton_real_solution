/**
 * liveTraffic.ts — LIVE-mode organic traffic simulator (console readability).
 *
 * One realistic shopper action per tick (≈45s ± 15s, env-configurable).
 * Writes go through the REAL ingestion endpoints (same path as production
 * merchant traffic) or the production money path — never ad-hoc SQL writes.
 * Documented exceptions: (1) read-only SELECT sampling (which link/cart/
 * product to touch — no endpoint lists those); (2) payment success resolves
 * via resolvePayment, the exact call the poller/webhook makes after gateway
 * confirmation (in test mode the recording is gateway-unconfirmed — the
 * simulator row says so); (3) payment failure self-calls the authed QA
 * injector endpoint with a server-minted session (same audited path).
 * Returning visitors come from the simulator's own in-memory phone pool
 * (phones it bound itself) — no PII decryption, no customer listing.
 */
import crypto from "node:crypto";
import { getConfig } from "../config.js";
import { query } from "../db.js";
import { createLogger } from "../logger.js";

const log = createLogger("liveTraffic");

const MERCHANT_ID = "5a3ac6ce-b2c7-4b1f-a9db-45296841f30b";

export interface TrafficStore {
  randomProduct(): Promise<{ id: string; price_paise: number } | null>;
  randomActiveCart(): Promise<{ id: string } | null>;
  randomLiveLink(): Promise<{
    id: string; merchant_id: string; razorpay_link_id: string; audit_seq: number;
    amount_paise: number; incentive_paise: number; cart_id: string | null; customer_id: string | null;
  } | null>;
}

export interface TrafficDeps {
  fetchFn?: typeof fetch;
  baseUrl?: string;
  siteKey?: string;
  serverKey?: string;
  rng?: () => number;
  activityAppend?: (row: any) => Promise<unknown>;
  store?: TrafficStore;
}

const dbStore: TrafficStore = {
  async randomProduct() {
    const { rows } = await query(
      "SELECT id, price_paise FROM products WHERE active = true AND is_gift = false ORDER BY RANDOM() LIMIT 1"
    );
    return rows[0] || null;
  },
  async randomActiveCart() {
    const { rows } = await query("SELECT id FROM carts WHERE status = 'active' ORDER BY RANDOM() LIMIT 1");
    return rows[0] || null;
  },
  async randomLiveLink() {
    const { rows } = await query(
      `SELECT id, merchant_id, razorpay_link_id, audit_seq, amount_paise, incentive_paise, cart_id, customer_id
       FROM payment_links WHERE status = 'live' ORDER BY RANDOM() LIMIT 1`
    );
    return rows[0] || null;
  },
};

function resolveDeps(deps: TrafficDeps = {}): Required<TrafficDeps> {
  let baseUrl = deps.baseUrl || process.env.BASE_URL || "";
  try { baseUrl = baseUrl || (getConfig() as any).BASE_URL || "http://localhost:3000"; } catch { baseUrl = baseUrl || "http://localhost:3000"; }
  return {
    fetchFn: deps.fetchFn || fetch,
    baseUrl,
    siteKey: deps.siteKey || process.env.SITE_KEY || "",
    serverKey: deps.serverKey || process.env.SERVER_KEY || "",
    rng: deps.rng || Math.random,
    activityAppend: deps.activityAppend || (async (row: any) => {
      const { appendActivity } = await import("./activity.js");
      return appendActivity(row);
    }),
    store: deps.store || dbStore,
  };
}

// In-memory pool of live shoppers this simulator bound (raw phones it sent).
const livePhones: Array<{ phone: string; name: string }> = [];

function randomLivePhone(rng: () => number): { phone: string; name: string } {
  const n = String(Math.floor(rng() * 9000000) + 1000000);
  return { phone: `+91955${n}`, name: "Live Shopper" };
}

async function post(d: Required<TrafficDeps>, path: string, body: unknown, headers: Record<string, string> = {}): Promise<any> {
  const res = await d.fetchFn(`${d.baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json().catch(() => ({}));
}

async function note(d: Required<TrafficDeps>, action: string, summary: string, data: Record<string, unknown> = {}): Promise<void> {
  await d.activityAppend({
    merchant_id: MERCHANT_ID, actor: "TrafficSim", type: "TRAFFIC",
    summary: `[live] ${action}: ${summary}`, data: { traffic_action: action, ...data },
    source_tag: "live",
  });
}

async function doNewCart(d: Required<TrafficDeps>, bindTo?: { phone: string; name: string }): Promise<string> {
  const product = await d.store.randomProduct();
  if (!product) return "idle";
  const cartId = crypto.randomUUID();
  const qty = d.rng() < 0.7 ? 1 : 2;
  await post(d, "/api/track/cart",
    { cart_id: cartId, items: [{ id: product.id, qty }], source_tag: "live" },
    { "X-Track-Key": d.siteKey });
  if (bindTo) {
    await post(d, "/api/track/bind-customer",
      { cart_id: cartId, phone: bindTo.phone, name: bindTo.name, source_tag: "live" },
      { "X-Server-Key": d.serverKey });
  }
  return cartId;
}

/** One tick: weighted action. Returns the action name. Never throws. */
export async function trafficTick(deps: TrafficDeps = {}): Promise<string> {
  const d = resolveDeps(deps);
  const r = d.rng();
  try {
    if (r < 0.40) {
      // New anonymous browser.
      const cartId = await doNewCart(d);
      if (cartId === "idle") return "idle";
      await note(d, "new_cart", `anonymous cart ${cartId.slice(0, 8)}`, { cart_id: cartId });
      return "new_cart";
    }
    if (r < 0.55) {
      // Returning visitor (from our own pool; empty pool → behave as new).
      const visitor = livePhones.length > 0
        ? livePhones[Math.floor(d.rng() * livePhones.length)]
        : randomLivePhone(d.rng);
      const cartId = await doNewCart(d, visitor);
      if (cartId === "idle") return "idle";
      if (!livePhones.some((p) => p.phone === visitor.phone)) {
        livePhones.push(visitor);
        if (livePhones.length > 50) livePhones.shift();
      }
      await note(d, "returning", `${visitor.phone.slice(-4)} back with cart ${cartId.slice(0, 8)}`, { cart_id: cartId });
      return "returning";
    }
    if (r < 0.70) {
      const cart = await d.store.randomActiveCart();
      if (!cart) return trafficTick({ ...deps, rng: () => 0 });
      await post(d, "/api/track/checkout-start", { cart_id: cart.id });
      await note(d, "checkout", `checkout started on ${String(cart.id).slice(0, 8)}`, { cart_id: cart.id });
      return "checkout";
    }
    if (r < 0.80) {
      // Natural abandon: touch nothing — the scheduler notices on its own.
      const cart = await d.store.randomActiveCart();
      await note(d, "went_quiet", cart ? `shopper left ${String(cart.id).slice(0, 8)} alone` : "no active carts to leave", cart ? { cart_id: cart.id } : {});
      return "went_quiet";
    }
    if (r < 0.90) {
      const link = await d.store.randomLiveLink();
      if (!link) return trafficTick({ ...deps, rng: () => 0 });
      const { resolvePayment } = await import("./moneyBus.js");
      await resolvePayment({ ...link, merchant_id: link.merchant_id || MERCHANT_ID });
      const real = process.env.LIVE_PAYMENTS_REAL === "true";
      await note(d, "pay_success", `link ${String(link.razorpay_link_id).slice(0, 12)} settled (gateway-unconfirmed test recording, real=${real})`, { razorpay_link_id: link.razorpay_link_id, real });
      return "pay_success";
    }
    if (r < 0.95) {
      // Same audited QA injector path, server-minted session (no new surface).
      const secret = (getConfig() as any).SESSION_SECRET || process.env.SESSION_SECRET || "";
      const jose = await import("jose");
      const csrf = crypto.randomUUID();
      const jwt = await new jose.SignJWT({ sub: "traffic-sim" }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("5m").sign(new TextEncoder().encode(secret));
      const res = await d.fetchFn(`${d.baseUrl}/api/qa/inject-payment-failure`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf, Cookie: `session=${jwt}; csrf=${csrf}` },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`inject-payment-failure → ${res.status}`);
      await note(d, "pay_fail", "payment failed (retry pipeline armed)");
      return "pay_fail";
    }
    const cart = await d.store.randomActiveCart();
    if (!cart) return trafficTick({ ...deps, rng: () => 0 });
    await post(d, "/api/track/convert", { cart_id: cart.id });
    await note(d, "convert", `cart ${String(cart.id).slice(0, 8)} converted`, { cart_id: cart.id });
    return "convert";
  } catch (err: any) {
    log.warn({ error: err?.message }, "Live traffic tick failed (next tick continues)");
    return "idle";
  }
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function isLiveTrafficRunning(): boolean {
  return running;
}

function jitteredDelay(rng: () => number): number {
  const base = Number(process.env.LIVE_TRAFFIC_INTERVAL_MS || 45000);
  const jitter = 15000;
  return Math.max(5000, base + Math.floor((rng() * 2 - 1) * jitter));
}

/** Start the simulator (idempotent). First action lands within seconds. */
export async function startLiveTraffic(deps: TrafficDeps = {}): Promise<void> {
  if (running) return;
  running = true;
  const d = resolveDeps(deps);
  log.info("Live traffic simulator started");
  const loop = async () => {
    if (!running) return;
    await trafficTick(deps);
    if (!running) return;
    timer = setTimeout(loop, jitteredDelay(d.rng));
  };
  timer = setTimeout(loop, 3000 + Math.floor(d.rng() * 5000));
}

/** Stop the simulator (idempotent). In-flight tick finishes; no new actions. */
export function stopLiveTraffic(): void {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
  log.info("Live traffic simulator stopped");
}
