import { query } from "../db.js";
import { fetchPaymentsList } from "./moneyBus.js";
import { appendActivity } from "./activity.js";
import { createLogger } from "../logger.js";

const log = createLogger("socialProof");

/**
 * G8 (v4.3): nightly social-proof job.
 * Reads the merchant's Razorpay payments (trailing 7d, paginated), attributes
 * each payment to catalog products via our own link→cart→items chain
 * (payment.order_id → payment_links.razorpay_order_id → cart_items), and
 * stores per-product units + DISTINCT buyers in social_stats.
 * Copy and the pay page may only claim through the social_proof token, which
 * rejects rows older than 26h (claims.ts).
 */
export const SOCIAL_STATS_FRESH_HOURS = 26;

export async function ensureSocialTables(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS social_stats (
    product_id UUID PRIMARY KEY,
    units_7d INTEGER NOT NULL DEFAULT 0,
    buyers_7d INTEGER NOT NULL DEFAULT 0,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

interface PaymentEntity {
  id: string;
  order_id?: string;
  email?: string;
  contact?: string;
  created_at?: number;
  captured?: boolean;
  status?: string;
}

export async function computeSocialProof(): Promise<{ products: number; payments: number }> {
  await ensureSocialTables();
  const since = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;

  // Paginate the gateway (incremental window = trailing 7d, recomputed fully).
  const payments: PaymentEntity[] = [];
  const pageSize = 100;
  for (let skip = 0; ; skip += pageSize) {
    const page = await fetchPaymentsList({ from: since, count: pageSize, skip });
    const items: PaymentEntity[] = page?.items || [];
    payments.push(...items.filter((p) => (p.created_at || 0) >= since));
    if (items.length < pageSize) break;
    if (skip > 5000) break; // sanity cap
  }

  // Attribute via our own chain (only captured/succeeded payments count).
  const units = new Map<string, number>();
  const buyers = new Map<string, Set<string>>();
  for (const p of payments) {
    if (p.captured === false || p.status === "failed") continue;
    if (!p.order_id) continue;
    const { rows: linkRows } = await query(
      `SELECT cart_id FROM payment_links WHERE razorpay_order_id = $1 LIMIT 1`,
      [p.order_id]
    );
    const cartId = linkRows[0]?.cart_id;
    if (!cartId) continue;
    const { rows: lineRows } = await query(
      `SELECT product_id, qty FROM cart_items WHERE cart_id::text = $1::text`,
      [cartId]
    );
    const buyer = p.email || p.contact || "unknown";
    for (const line of lineRows) {
      const pid = String(line.product_id);
      units.set(pid, (units.get(pid) || 0) + Number(line.qty || 1));
      if (!buyers.has(pid)) buyers.set(pid, new Set());
      buyers.get(pid)!.add(buyer);
    }
  }

  for (const [pid, n] of units) {
    await query(
      `INSERT INTO social_stats (product_id, units_7d, buyers_7d, computed_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (product_id) DO UPDATE SET units_7d = $2, buyers_7d = $3, computed_at = NOW()`,
      [pid, n, buyers.get(pid)!.size]
    );
  }

  await appendActivity({
    merchant_id: "5a3ac6ce-b2c7-4b1f-a9db-45296841f30b",
    actor: "SocialProof",
    type: "UPLIFT_DECISION",
    summary: `Social proof recomputed: ${units.size} products from ${payments.length} payments (7d)`,
    data: { products: units.size, payments: payments.length },
  });
  log.info({ products: units.size, payments: payments.length }, "Social proof computed");
  return { products: units.size, payments: payments.length };
}
