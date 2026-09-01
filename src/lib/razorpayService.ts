import Razorpay from "razorpay";
import { getConfig } from "../config.js";

let instance: any = null;

export function getRazorpay(): any {
  if (!instance) {
    const config = getConfig();
    instance = new Razorpay({
      key_id: config.RAZORPAY_KEY_ID,
      key_secret: config.RAZORPAY_KEY_SECRET,
    });
  }
  return instance;
}

export async function createOrder(params: {
  amount: number;
  currency?: string;
  receipt?: string;
  notes?: Record<string, string>;
}): Promise<{ id: string; amount: number; currency: string; receipt?: string }> {
  const rp = getRazorpay();
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
}): Promise<{ id: string; short_url: string; amount: number }> {
  const rp = getRazorpay();
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
  return rp.payments.fetch(params);
}
