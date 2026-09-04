import Razorpay from "razorpay";
import { getConfig } from "../config.js";

/**
 * M26 — money-bus structural single-caller. The module holds a private
 * capability symbol; moneyBus alone receives it via initMoneyBus() and passes
 * it to getRazorpay(cap) for the full (mutating) client. Any other importer
 * gets a READ-ONLY facade: fetch paths work (doctor/reconcile), while
 * create/refund/cancel/invoices throw BUS_CAP_REQUIRED.
 */
const BUS_CAP = Symbol("moneyBus");
let busInitialized = false;

export function initMoneyBus(): symbol {
  busInitialized = true;
  return BUS_CAP;
}

function isBusCap(cap: unknown): boolean {
  return busInitialized && cap === BUS_CAP;
}

let instance: any = null;

function fullClient(): any {
  if (!instance) {
    const config = getConfig();
    instance = new Razorpay({
      key_id: config.RAZORPAY_KEY_ID,
      key_secret: config.RAZORPAY_KEY_SECRET,
    });
  }
  return instance;
}

const READ_METHODS = new Set(["fetch", "all", "fetchAll", "fetchMultiple"]);
function isReadMethod(prop: string): boolean {
  return READ_METHODS.has(prop) || prop.startsWith("fetch");
}

/**
 * Lazy capability proxy. No config/network touched until a read method is
 * actually invoked:
 * - rp.paymentLink.fetch(...) → real client instantiated on first call.
 * - rp.paymentLink.create(...) without the bus cap → BUS_CAP_REQUIRED.
 */
function lazyClient(): any {
  const at = (ns: string): any => new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "__busCapReadOnly") return true;
      if (prop === Symbol.toPrimitive || prop === "then") return undefined;
      if (typeof prop !== "string") return undefined;
      if (isReadMethod(prop)) {
        return (...args: any[]) => (fullClient() as any)[ns][prop](...args);
      }
      return () => { throw new Error("BUS_CAP_REQUIRED: mutating Razorpay access is moneyBus-only"); };
    },
    apply() {
      throw new Error("BUS_CAP_REQUIRED: call a namespaced Razorpay method");
    },
  });
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === "__busCapReadOnly") return true;
      if (typeof prop !== "string") return undefined;
      return at(prop);
    },
  });
}
export function getRazorpay(cap?: symbol): any {
  if (isBusCap(cap)) return fullClient();
  return lazyClient();
}

export const razorpay = getRazorpay;

/**
 * Named helpers. Mutating helpers (createOrder/createPaymentLink) require the
 * moneyBus capability — without it they throw BUS_CAP_REQUIRED. Read helpers
 * work for any importer (doctor/reconcile/poller paths).
 */
export async function createOrder(params: {
  amount: number;
  currency?: string;
  receipt?: string;
  notes?: Record<string, string>;
}, cap?: symbol): Promise<{ id: string; amount: number; currency: string; receipt?: string }> {
  const rp = getRazorpay(cap);
  const order = await rp.orders.create({
    amount: params.amount,
    currency: params.currency || "INR",
    receipt: params.receipt,
    notes: params.notes,
  });
  return { id: order.id, amount: Number(order.amount), currency: order.currency, receipt: order.receipt };
}

export async function createPaymentLink(params: {
  amount: number;
  currency?: string;
  reference_id: string;
  customer?: { name: string; email: string; contact: string };
  notify?: { sms?: boolean; email?: boolean };
  reminder_enable?: boolean;
  expire_by?: number;
  notes?: Record<string, string>;
}, cap?: symbol): Promise<{ id: string; short_url: string; amount: number }> {
  const rp = getRazorpay(cap);
  const link = await rp.paymentLink.create({
    amount: params.amount,
    currency: params.currency || "INR",
    reference_id: params.reference_id,
    customer: params.customer,
    notify: params.notify || { sms: true, email: true },
    reminder_enable: params.reminder_enable !== false,
    expire_by: params.expire_by,
    notes: params.notes,
  });
  return { id: link.id, short_url: (link as any).short_url || "", amount: Number(link.amount) };
}

export async function fetchOrder(orderId: string): Promise<any> {
  const rp = getRazorpay();
  return rp.orders.fetch(orderId);
}

export async function fetchPaymentLink(linkId: string): Promise<any> {
  const rp = getRazorpay();
  return rp.paymentLink.fetch(linkId);
}

export async function fetchPayments(params: {
  from?: number;
  to?: number;
  count?: number;
  skip?: number;
}): Promise<any> {
  const rp = getRazorpay();
  // NB: payments.fetch takes a payment ID; listing requires .all().
  return rp.payments.all(params);
}
