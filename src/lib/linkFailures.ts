/**
 * linkFailures.ts — failed-attempt detection on payment LINKS.
 *
 * A payment_link reports status 'created' even after attempts fail —
 * failures live on the payment entities (link.payments[]), not the link.
 * Neither the poller (paid/expired/cancelled only) nor the webhooks
 * (payment.failed unhandled) looked there, so failed link payments were
 * invisible: no detection, no console event, no retry.
 *
 * Convergence: the poller AND the payment.failed webhook both land here.
 * link_payment_attempts.razorpay_payment_id is UNIQUE — the first path to
 * see an attempt records it (and nudges); every later sighting is a
 * silent no-op. The failed ORDER row feeds the existing G4 failure scan
 * only when actionable (cart present, no live/paid link); the calm nudge
 * reuses the still-live link (never mints a replacement over a link the
 * customer may be paying on right now).
 */
import { query as defaultQuery } from "../db.js";
import { createLogger } from "../logger.js";

const log = createLogger("linkFailures");

export const LINK_ATTEMPTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS link_payment_attempts (
  razorpay_payment_id TEXT PRIMARY KEY,
  payment_link_id UUID REFERENCES payment_links(id),
  razorpay_link_id TEXT NOT NULL,
  merchant_id UUID,
  cart_id TEXT,
  customer_id UUID,
  amount_paise BIGINT,
  method TEXT,
  status TEXT NOT NULL DEFAULT 'failed',
  order_id UUID REFERENCES orders(id),
  nudged BOOLEAN NOT NULL DEFAULT false,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_link_attempts_link ON link_payment_attempts(razorpay_link_id);
`;

/** Idempotent boot ensure (covers SKIP_MIGRATIONS / out-of-band schemas). */
export async function ensureLinkAttemptsTable(
  q: (sql: string, params?: any[]) => Promise<{ rows: any[] }> = defaultQuery as any
): Promise<void> {
  await q(LINK_ATTEMPTS_SCHEMA_SQL);
}

/** Failed-attempt statuses on a Razorpay payment entity. */
const FAILED_PAYMENT_STATUSES = new Set(["failed", "rejected"]);

/** Settled statuses on a Razorpay payment entity. */
const CAPTURED_PAYMENT_STATUSES = new Set(["captured", "authorized"]);

/** Pure: is this link.payments[] entry a failed attempt? */
export function isFailedAttempt(payment: any): boolean {
  if (!payment || typeof payment !== "object") return false;
  return FAILED_PAYMENT_STATUSES.has(String(payment.status || "").toLowerCase());
}

/** Pure: is this a settled (captured/authorized) payment? */
export function isCapturedAttempt(payment: any): boolean {
  if (!payment || typeof payment !== "object") return false;
  return CAPTURED_PAYMENT_STATUSES.has(String(payment.status || "").toLowerCase());
}

/** Pure: pull failed attempts out of a fetched link payload. */
export function extractFailedAttempts(linkPayload: any): any[] {
  const payments = linkPayload?.payments;
  if (!Array.isArray(payments)) return [];
  return payments.filter(isFailedAttempt);
}

export interface LinkRef {
  id: string;
  razorpay_link_id: string;
  merchant_id: string;
  cart_id: string | null;
  customer_id: string | null;
  amount_paise: number;
  short_url?: string | null;
  ext_ref?: string | null;
  audit_seq?: number;
  incentive_paise?: number;
}

/**
 * Pure: match a gateway payment entity to one of our live links.
 * A failed link attempt carries OUR notes (cart_id/ext_ref/audit_seq —
 * verified live: the entity inherits them) plus the link id in
 * `description` (#<linkId…>). ext_ref is exact; cart falls back to a
 * live link for that cart.
 */
export function matchFailedToLink(
  payment: any,
  links: LinkRef[]
): LinkRef | null {
  if (!payment || typeof payment !== "object" || links.length === 0) return null;
  const notes = payment.notes || {};
  const extRef = notes.ext_ref || notes.extRef || null;
  if (extRef) {
    const hit = links.find((l) => l.ext_ref === extRef);
    if (hit) return hit;
  }
  const cartId = notes.cart_id || notes.cartId || null;
  if (cartId) {
    const hit = links.find((l) => l.cart_id === cartId);
    if (hit) return hit;
  }
  const desc = String(payment.description || "");
  const m = desc.match(/#([A-Za-z0-9]+)/);
  if (m) {
    const hit = links.find((l) =>
      l.razorpay_link_id.includes(m[1]) || (l.short_url || "").includes(m[1])
    );
    if (hit) return hit;
  }
  return null;
}

export interface LinkRow {
  id: string;
  merchant_id: string;
  razorpay_link_id: string;
  cart_id: string | null;
  customer_id: string | null;
  amount_paise: number;
  short_url?: string | null;
}

export interface RecordResult {
  isNew: boolean;
  orderId: string | null;
  paymentId: string;
}

/**
 * Record one failed attempt. First sighting creates the failed ORDER row
 * (source 'direct' — satisfies the 001 CHECK on fresh DBs) and returns
 * isNew=true so the caller nudges exactly once. Re-sightings return
 * isNew=false (no order, no nudge, no events).
 */
export async function recordLinkPaymentFailure(
  q: (sql: string, params?: any[]) => Promise<{ rows: any[] }> = defaultQuery as any,
  link: LinkRow,
  payment: any
): Promise<RecordResult> {
  const paymentId = String(payment?.id || "");
  if (!paymentId) return { isNew: false, orderId: null, paymentId: "" };
  const method =
    payment?.method || payment?.payment_method || payment?.card?.type || null;
  const amount = Number(payment?.amount || link.amount_paise || 0);
  const merchantId = link.merchant_id || "5a3ac6ce-b2c7-4b1f-a9db-45296841f30b";

  const seen = await q(
    `INSERT INTO link_payment_attempts
       (razorpay_payment_id, payment_link_id, razorpay_link_id, merchant_id,
        cart_id, customer_id, amount_paise, method, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (razorpay_payment_id) DO NOTHING
     RETURNING razorpay_payment_id`,
    [
      paymentId, link.id, link.razorpay_link_id, merchantId,
      link.cart_id, link.customer_id, amount, method,
      String(payment?.status || "failed"),
    ]
  );
  if (seen.rows.length === 0) return { isNew: false, orderId: null, paymentId };

  // First sighting: the failed ORDER row (same shape the G4 failure scan
  // selects — failed 5min–24h ago, actionable only with a cart and no
  // live/paid link; the nudge path below does not wait for the scan).
  let orderId: string | null = null;
  try {
    const { rows } = await q(
      `INSERT INTO orders (merchant_id, source, cart_id, customer_id, amount_paise, status, failed_at, payment_method, fee_basis)
       VALUES ($1, 'direct', $2, $3, $4, 'failed', NOW(), $5, 'modeled')
       RETURNING id`,
      [merchantId, link.cart_id, link.customer_id, amount, method]
    );
    orderId = rows[0]?.id || null;
    if (orderId) {
      await q("UPDATE link_payment_attempts SET order_id = $1 WHERE razorpay_payment_id = $2", [orderId, paymentId]);
    }
  } catch (err: any) {
    log.warn({ error: err?.message, paymentId }, "Failed-order row skipped (non-critical)");
  }
  return { isNew: true, orderId, paymentId };
}

/** Mark the nudge sent (exactly-once accounting). */
export async function markNudged(
  q: (sql: string, params?: any[]) => Promise<{ rows: any[] }> = defaultQuery as any,
  paymentId: string
): Promise<void> {
  await q("UPDATE link_payment_attempts SET nudged = true WHERE razorpay_payment_id = $1", [paymentId]).catch(() => {});
}
