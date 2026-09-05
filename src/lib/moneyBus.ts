import crypto from "node:crypto";
import { getConfig } from "../config.js";
import { query, withTransaction } from "../db.js";
import { getRazorpay, initMoneyBus } from "./razorpayService.js";
import { formatINR } from "./format.js";
// M26: moneyBus is the SOLE holder of the Razorpay mutation capability.
const BUS_CAP = initMoneyBus();
const rzp = (): any => getRazorpay(BUS_CAP);
import { appendLedger, resolveLedger } from "./ledger.js";
import { appendActivity } from "./activity.js";
import { generateExtRef, storeExtRef, generateToken } from "./extRef.js";
import { createPayToken } from "./payToken.js";
import { decrypt, encrypt } from "./crypto.js";
import { recordPiiAccess } from "./piiAccess.js";
import { createLogger } from "../logger.js";

const log = createLogger("moneyBus");

export interface MoneyBusAction {
  type: "create_payment_link" | "cancel_payment_link" | "create_order" | "create_refund" | "fetch_payment_link";
  params: Record<string, any>;
}

export interface MoneyBusResult {
  seq: number;
  status: string;
  data?: any;
}

/**
 * I4 money bus. Order is FIXED:
 *   (a) cancel live prior links for the cart — if any cancel FAILS, ABORT (fail closed)
 *   (b) append the ledger PROPOSED row BEFORE any external call
 *   (c) create order + payment link with reference_id = opaque base64url(HMAC(APP_SECRET, seq))
 *   (d) store the link with a 128-bit random public token
 *   (e) insert the notification outbox row
 */
export async function execute(
  actor: string,
  action: MoneyBusAction,
  policyResult: any,
  context: Record<string, any>,
  merchantId: string,
  simulated: boolean = false
): Promise<MoneyBusResult> {
  if (simulated) {
    const { seq, hash } = await appendLedger({
      merchantId, actor, action: action.type,
      params: action.params, decision: policyResult.decision,
      policy_checks: policyResult.checks || {}, rationale: { reasons: policyResult.reasons },
      outcome: "PROPOSED", outcome_detail: { simulated: true }, simulated: true,
    });
    await resolveLedger(seq, "SUCCESS", { simulated: true });
    await appendActivity({
      merchant_id: merchantId, actor, type: "LINK_CREATED",
      summary: `${actor} SIMULATED link`, amount_paise: action.params?.amount,
      data: { seq, simulated: true },
      simulated: true,
    });
    // Outbound stream: simulated sends are badged, never REAL revenue.
    try {
      const { emitMessageSent } = await import("./messageStream.js");
      await emitMessageSent({
        merchantId, actor, channel: "payment_link",
        messageCopy: String(context?.message_copy || "Your payment link is ready."),
        rawCopy: context?.raw_copy ? String(context.raw_copy) : undefined,
        messageStrategy: context?.message_strategy || "functional",
        messageTone: context?.brain_tone,
        brainMode: context?.brain_mode === "llm" ? "llm" : "rules",
        cartOrOrderRef: context?.cart_id || null,
        resolvedTokens: context?.claims_resolved || context?.resolved_tokens || [],
        incentivePaise: Number(context?.incentive_paise ?? action.params?.incentive_paise ?? 0),
        simulated: true, customerId: context?.customer_id || null,
        sourceTag: (context as any)?.source_tag,
        ledgerSeq: seq,
      });
    } catch { /* stream never blocks money */ }
    return { seq, status: "simulated" };
  }

  if (policyResult.decision === "BLOCK") {
    throw new Error(`Policy BLOCK: ${(policyResult.reasons || []).join(", ")}`);
  }

  if (policyResult.decision === "ESCALATE") {
    const { seq } = await appendLedger({
      merchantId, actor, action: action.type,
      params: action.params, decision: "ESCALATE",
      policy_checks: policyResult.checks || {}, rationale: { reasons: policyResult.reasons, ...context },
      outcome: "ESCALATED", outcome_detail: { reason: "policy_escalate" },
    });
    await query(
      `INSERT INTO approvals (merchant_id, audit_seq, context, status)
       VALUES ($1, $2, $3, 'pending')`,
      [merchantId, seq, JSON.stringify(context)]
    );
    await appendActivity({
      merchant_id: merchantId, actor, type: "ESCALATED",
      summary: `${actor} escalated to human approval`, data: { seq },
    });
    return { seq, status: "escalated" };
  }

  switch (action.type) {
    case "create_payment_link":
      return createPaymentLink(actor, merchantId, action.params, context);
    case "cancel_payment_link":
      return cancelPaymentLink(actor, merchantId, action.params, context);
    case "create_refund":
      return createRefund(actor, merchantId, action.params, context);
    case "fetch_payment_link":
      return fetchPaymentLinkStatus(action.params);
    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }
}

async function createPaymentLink(
  actor: string,
  merchantId: string,
  params: Record<string, any>,
  context: Record<string, any>
): Promise<MoneyBusResult> {
  const config = getConfig();

  // (a) FAIL CLOSED: cancel live prior links for the cart
  if (context.cart_id) {
    const { rows: liveLinks } = await query(
      `SELECT id, merchant_id, razorpay_link_id, audit_seq, amount_paise,
              incentive_paise, cart_id, customer_id
       FROM payment_links WHERE cart_id = $1 AND status = 'live'`,
      [context.cart_id]
    );
    for (const link of liveLinks) {
      if (!link.razorpay_link_id) {
        await query("UPDATE payment_links SET status = 'cancelled' WHERE id = $1", [link.id]);
        continue;
      }
      try {
        await cancelLinkWithRetry(link.razorpay_link_id, 2);
        await query("UPDATE payment_links SET status = 'cancelled' WHERE id = $1", [link.id]);
      } catch (err: any) {
        // N2 (v4.2) cancel-race: the cancel may have failed BECAUSE the customer
        // just paid. Check live status before failing closed.
        const race = await handleCancelRace(actor, merchantId, link, context, err);
        if (race.resolved) {
          // Revenue already landed — a fresh discounted link would be pure loss.
          return {
            seq: race.seq ?? 0,
            status: "cancel_race_paid",
            data: { resolved: true, order_id: race.orderId, prior_link_id: link.razorpay_link_id },
          };
        }
        // FAIL CLOSED: abort
        log.error({ linkId: link.razorpay_link_id, error: err.message }, "Cancel failed, aborting");
        throw new Error(`FAIL CLOSED: could not cancel prior link ${link.razorpay_link_id}: ${err.message}`);
      }
    }
  }

  // (b) append the ledger PROPOSED row BEFORE any external call
  const { seq, hash } = await appendLedger({
    merchantId, actor, action: "create_payment_link",
    params: { ...params, reference_id: undefined },
    decision: "ALLOW",
    policy_checks: context?.policy_checks || {},
    rationale: { reasons: [], ...context },
    outcome: "PROPOSED",
  });

  await appendActivity({
    merchant_id: merchantId, actor, type: "LEDGER_PROPOSED",
    summary: `${actor} ledger PROPOSED row seq=${seq}`,
    data: { seq, hash },
  });

  const amount = Math.round(Number(params.amount));
  const extRef = generateExtRef(seq);
  await storeExtRef(extRef, seq, { actor, action: "create_payment_link", cart_id: context.cart_id });

  // (c) create order + payment link with opaque reference_id
  // G2/G5 (v4.3): caller-controlled TTL (default 24h). expire_by_iso, when
  // given, is used verbatim so grounded deadlines equal stored deadlines.
  // Razorpay rejects link expiries under ~20 minutes: shorter offer windows
  // (e.g. the 10-min fast add-on) are stored in offer_expires_by and enforced
  // by our sweeper, while the gateway holds a safe 30-minute floor.
  if (!(globalThis as any).__offerExpiryColEnsured) {
    await query("ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS offer_expires_by TIMESTAMPTZ").catch(() => {});
    (globalThis as any).__offerExpiryColEnsured = true;
  }
  const ttlSeconds = Number(params.ttl_seconds || 24 * 60 * 60);
  const offerExpiryIso = params.expire_by_iso || new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const gatewayUnix = Math.max(
    Math.floor(new Date(offerExpiryIso).getTime() / 1000),
    Math.floor(Date.now() / 1000) + 30 * 60
  );
  const expireByUnix = gatewayUnix;
  const expireByIso = new Date(expireByUnix * 1000).toISOString();
  let link: any;
  let order: any;
  // TEST-API 429s back off and retry with identical idempotent params.
  let rateAttempts = 0;
  const rateRetry = async <T>(fn: () => Promise<T>, label: string): Promise<T> => {
    for (;;) {
      try {
        return await fn();
      } catch (err: any) {
        const status = err?.statusCode ?? err?.status;
        if (status === 429 && rateAttempts < 2) {
          rateAttempts++;
          const wait = rateAttempts === 1 ? 2000 : 5000;
          log.warn({ label, attempt: rateAttempts, wait }, "Razorpay rate-limited, backing off");
          await sleep(wait);
          continue;
        }
        throw err;
      }
    }
  };
  try {
    const rp = rzp();
    order = await rateRetry(() => rp.orders.create({
      amount, // paise
      currency: "INR",
      receipt: extRef.slice(0, 30),
      notes: { ext_ref: extRef, audit_seq: String(seq) },
    }), "orders.create");

    // G5 (v4.3): pre-fill customer contact on the hosted page. Decrypt happens
    // ONLY here in the money bus, never in agents or prompts.
    let rpCustomer: { email?: string; contact?: string } | undefined;
    if (params.prefill_customer && context.customer_id) {
      try {
        const { rows: preRows } = await query("SELECT contact_enc FROM customers WHERE id = $1", [context.customer_id]);
        if (preRows[0]?.contact_enc) {
          const contact = decrypt(preRows[0].contact_enc);
          rpCustomer = contact.includes("@") ? { email: contact } : { contact };
        }
      } catch (preErr: any) {
        log.warn({ error: preErr?.message }, "Customer prefill skipped (non-critical)");
      }
    }
    link = await rateRetry(() => rp.paymentLink.create({
      amount,
      currency: "INR",
      accept_partial: false,
      expire_by: expireByUnix,
      reference_id: extRef,
      description: params.description || "Sellable payment",
      ...(rpCustomer ? { customer: rpCustomer } : {}),
      notify: { sms: false, email: false },
      notes: { ext_ref: extRef, audit_seq: String(seq), cart_id: context.cart_id || "" },
    }), "paymentLink.create");
  } catch (err: any) {
    const errMsg = err?.message || err?.error?.description || (typeof err === 'string' ? err : JSON.stringify(err));
    const errorDetail = { error: errMsg, status: err?.statusCode, code: err?.error?.code };
    log.error({ ...errorDetail, seq }, "Razorpay API call failed");
    await resolveLedger(seq, "FAILED", errorDetail);
    throw new Error(`Razorpay API failed: ${errMsg}`);
  }

  // (d) store the link with a 128-bit random public token
  const token = generateToken(16);
  const customerId = context.customer_id;
  let maskedPii: Record<string, unknown> = {};
  if (customerId && params.customer) {
    try {
      const { rows } = await query("SELECT contact_enc FROM customers WHERE id = $1", [customerId]);
      if (rows[0]?.contact_enc) {
        const contact = decrypt(rows[0].contact_enc);
        maskedPii = { contact: mask(contact) };
      }
      await recordPiiAccess({ actor, customer_id: customerId, purpose: "create_payment_link" });
    } catch (piiErr: any) {
      log.warn({ error: piiErr.message }, "PII masking skipped (non-critical)");
    }
  }

  await createPayToken({
    auditSeq: seq, merchantId, customerId, amountPaise: amount, maskedPii,
  });

  await query(
    `INSERT INTO payment_links (merchant_id, razorpay_link_id, razorpay_order_id, ext_ref, audit_seq, token, cart_id, customer_id, amount_paise, incentive_paise, short_url, status, expire_by, offer_expires_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'live', $12, $13)`,
    [merchantId, link.id, order.id, extRef, seq, token, context.cart_id || null, customerId || null, amount, Number(params.incentive_paise || 0), link.short_url || null, expireByIso, offerExpiryIso]
  );

  if (context.cart_id) {
    await query(
      `INSERT INTO sibling_links (cart_id, payment_link_id, status) VALUES ($1, $2, 'active')`,
      [context.cart_id, link.id]
    );
  }

  // (e) notification outbox row
  if (context.notification_outbox !== false) {
    try {
      await query(
        `INSERT INTO notification_outbox (merchant_id, intent_id, channel, status, payload_hash, message_version)
         VALUES ($1, $2, 'payment_link', 'pending', $3, '1')`,
        [merchantId, context.intent_id, crypto.createHash("sha256").update(link.short_url || "").digest("hex")]
      );
    } catch (outboxErr: any) {
      log.warn({ error: outboxErr.message }, "Notification outbox insert failed (non-critical)");
    }
  }

  await resolveLedger(seq, "SUCCESS", {
    razorpay_link_id: link.id, razorpay_order_id: order.id,
    short_url: link.short_url, token, ext_ref: extRef,
  });

  await appendActivity({
    merchant_id: merchantId, actor, type: "LINK_CREATED",
    summary: `Payment link created (${formatINR(amount)})`,
    amount_paise: amount,
    data: { seq, razorpay_link_id: link.id, short_url: link.short_url, token, ext_ref: extRef, amount_paise: amount },
  });

  // Outbound stream: the notification_outbox row above is the hook point —
  // emit MESSAGE_SENT with the FINAL resolved copy in the same code path.
  try {
    const { emitMessageSent } = await import("./messageStream.js");
    await emitMessageSent({
      merchantId, actor, channel: "payment_link",
      messageCopy: String(context?.message_copy || "Your payment link is ready."),
      rawCopy: context?.raw_copy ? String(context.raw_copy) : undefined,
      messageStrategy: context?.message_strategy || "functional",
      messageTone: context?.brain_tone,
      brainMode: context?.brain_mode === "llm" ? "llm" : "rules",
      cartOrOrderRef: context?.cart_id || context?.order_id || null,
      resolvedTokens: context?.claims_resolved || context?.resolved_tokens || [],
      incentivePaise: Number(context?.incentive_paise ?? params.incentive_paise ?? 0),
      simulated: false, customerId: context?.customer_id || customerId || null,
      sourceTag: (context as any)?.source_tag,
      ledgerSeq: seq,
    });
  } catch { /* stream never blocks money */ }

  log.info({ seq, linkId: link.id }, "Payment link created");
  return { seq, status: "created", data: { link_id: link.id, short_url: link.short_url, token, order_id: order.id, seq } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Cancel a link via the real Razorpay cancel endpoint
 * (POST /v1/payment_links/:id/cancel). The generic edit() call 404s.
 */
async function cancelRazorpayLink(razorpayLinkId: string): Promise<void> {
  const rp = rzp();
  if (typeof rp.paymentLink?.cancel === "function") {
    await rp.paymentLink.cancel(razorpayLinkId);
    return;
  }
  await rp.paymentLink.edit({ id: razorpayLinkId, status: "cancelled" });
}

/**
 * Cancel a Razorpay link with retries (initial try + up to `retries` more,
 * 500ms then 1500ms backoff). Throws the last error if still failing.
 */
async function cancelLinkWithRetry(razorpayLinkId: string, retries = 2): Promise<void> {
  const delays = [500, 1500];
  let attempt = 0;
  for (;;) {
    try {
      await cancelRazorpayLink(razorpayLinkId);
      return;
    } catch (err: any) {
      if (attempt >= retries) throw err;
      const wait = delays[Math.min(attempt, delays.length - 1)];
      log.warn({ linkId: razorpayLinkId, attempt: attempt + 1, wait }, "Cancel retrying with backoff");
      await sleep(wait);
      attempt++;
    }
  }
}

/**
 * N2 (v4.2) cancel-race branch. Called when cancelling a prior live link failed.
 * - Link now 'paid' → resolve it immediately, mark the current intent done,
 *   ledger {action:'cancel_failed_link_paid_resolved'}, caller must NOT mint a new link.
 * - Link 'open'/'pending' ('created'/'partially_paid' on Razorpay) → retry handled
 *   by the caller path (cancelLinkWithRetry already exhausted) → not resolved.
 * - Anything else (or status fetch itself failing) → not resolved → fail closed.
 */
async function handleCancelRace(
  actor: string,
  merchantId: string,
  link: { id: string; merchant_id: string; razorpay_link_id: string; audit_seq: number; amount_paise: number; incentive_paise: number; cart_id: string | null; customer_id: string | null },
  context: Record<string, any>,
  cancelErr: any
): Promise<{ resolved: boolean; seq?: number; orderId?: string }> {
  let status: string | null = null;
  try {
    const rp = rzp();
    const live = await rp.paymentLink.fetch(link.razorpay_link_id);
    status = live?.status || null;
  } catch (fetchErr: any) {
    log.warn({ linkId: link.razorpay_link_id, error: fetchErr?.message }, "Cancel-race status fetch failed");
    return { resolved: false };
  }

  if (status !== "paid") {
    log.info({ linkId: link.razorpay_link_id, status }, "Cancel-race: link not paid, staying fail-closed");
    return { resolved: false };
  }

  // The payment landed mid-cancel: resolve now, never mint a discounted replacement.
  await resolvePayment({
    id: link.id,
    merchant_id: link.merchant_id || merchantId,
    razorpay_link_id: link.razorpay_link_id,
    audit_seq: link.audit_seq,
    amount_paise: Number(link.amount_paise),
    incentive_paise: Number(link.incentive_paise),
    cart_id: link.cart_id,
    customer_id: link.customer_id,
  });

  const { rows: orderRows } = await query(
    `SELECT id FROM orders WHERE cart_id = $1 AND status = 'paid' ORDER BY paid_at DESC LIMIT 1`,
    [link.cart_id]
  );

  const { seq } = await appendLedger({
    merchantId,
    actor,
    action: "cancel_failed_link_paid_resolved",
    params: { cart_id: link.cart_id, prior_link_id: link.razorpay_link_id, order_id: orderRows[0]?.id || null },
    decision: "ALLOW",
    policy_checks: { cancel_race: "PAID_RESOLVED" },
    rationale: {
      reason: "cancel failed because link was already paid; resolved instead of minting replacement",
      cancel_error: cancelErr?.message || String(cancelErr),
    },
    outcome: "SUCCESS",
  });

  if (context?.intent_id) {
    const { completeIntent } = await import("./intentExecutor.js");
    await completeIntent(context.intent_id);
  }

  await appendActivity({
    merchant_id: merchantId, actor, type: "LINK_CREATED",
    summary: `Cancel-race: prior link paid mid-cancel — resolved, no replacement minted`,
    data: { prior_link_id: link.razorpay_link_id, order_id: orderRows[0]?.id || null, seq },
  });

  return { resolved: true, seq, orderId: orderRows[0]?.id };
}

function mask(value: string, kind?: string): string {
  if (!value) return "";
  if (kind === "email") {
    const [u, d] = value.split("@");
    return `${u.slice(0, 2)}***@${d || ""}`;
  }
  if (kind === "phone") {
    return `${value.slice(0, 4)}****${value.slice(-2)}`;
  }
  return value.length > 4 ? `${value.slice(0, 2)}***${value.slice(-1)}` : "***";
}

async function cancelPaymentLink(
  actor: string,
  merchantId: string,
  params: Record<string, any>,
  context: Record<string, any>
): Promise<MoneyBusResult> {
  const { seq } = await appendLedger({
    merchantId, actor, action: "cancel_payment_link",
    params, decision: "ALLOW", policy_checks: {}, rationale: context,
    outcome: "PROPOSED",
  });

  try {
    await cancelRazorpayLink(params.link_id);
    await resolveLedger(seq, "SUCCESS", { link_id: params.link_id, cancelled: true });
    await query("UPDATE payment_links SET status = 'cancelled' WHERE razorpay_link_id = $1", [params.link_id]);
    return { seq, status: "cancelled" };
  } catch (err: any) {
    await resolveLedger(seq, "FAILED", { error: err.message });
    throw err;
  }
}

async function createRefund(
  actor: string,
  merchantId: string,
  params: Record<string, any>,
  context: Record<string, any>
): Promise<MoneyBusResult> {
  const { seq } = await appendLedger({
    merchantId, actor, action: "create_refund",
    params, decision: "ALLOW", policy_checks: {}, rationale: context,
    outcome: "PROPOSED",
  });

  try {
    const rp = rzp();
    const refund = await rp.payments.refund(params.payment_id, {
      amount: params.amount_paise,
      notes: { reason: params.reason || "auto_refund", order_id: params.order_id || "" },
    });
    await query(
      `INSERT INTO refunds (order_id, refund_id, amount_paise, reason, status)
       VALUES ($1, $2, $3, $4, 'processed')`,
      [params.order_id, refund.id, params.amount_paise, params.reason || "auto_refund"]
    );
    await resolveLedger(seq, "SUCCESS", { refund_id: refund.id, amount_paise: params.amount_paise });
    return { seq, status: "refund_created", data: { refund_id: refund.id } };
  } catch (err: any) {
    await resolveLedger(seq, "FAILED", { error: err.message });
    throw err;
  }
}

async function fetchPaymentLinkStatus(params: Record<string, any>): Promise<MoneyBusResult> {
  const rp = rzp();
  const link = await rp.paymentLink.fetch(params.link_id);
  return { seq: 0, status: "fetched", data: link };
}

/**
 * Fetch a payment link by Razorpay link id (for the poller / reconcile).
 */
export async function fetchPaymentLink(linkId: string): Promise<any> {
  const rp = rzp();
  return rp.paymentLink.fetch(linkId);
}

export async function fetchPaymentsList(options?: { from?: number; to?: number; count?: number; skip?: number }): Promise<any> {
  const rp = rzp();
  // NB: payments.fetch takes a payment ID; listing requires .all().
  return rp.payments.all(options || { count: 50 });
}

/**
 * I8: Dual-path idempotent resolution. Both the 15s poller and the webhook
 * converge here. First path wins, second is a no-op.
 */
export async function resolvePayment(pl: {
  id: string;
  merchant_id: string;
  razorpay_link_id: string;
  audit_seq: number;
  amount_paise: number;
  incentive_paise: number;
  cart_id: string | null;
  customer_id: string | null;
}): Promise<void> {
  await withTransaction(async (client) => {
    // Serialize with ledger appends: the inline rehash + cascade below must
    // not interleave with a concurrent append (v4.2 N2 race fix).
    const { lockKeyForMerchant } = await import("./ledger.js");
    await client.query("SELECT pg_advisory_xact_lock($1)", [lockKeyForMerchant(pl.merchant_id)]);
    // Idempotency guard
    const { rows: existing } = await client.query(
      "SELECT status FROM payment_links WHERE id = $1 FOR UPDATE",
      [pl.id]
    );
    if (!existing[0] || existing[0].status !== "live") {
      log.debug({ id: pl.id }, "Payment already resolved (no-op)");
      return;
    }

    await client.query("UPDATE payment_links SET status = 'paid', paid_at = NOW() WHERE id = $1", [pl.id]);

    // F4 (v5.1 fix): a paid cart exits the scan set — the scheduler's
    // due-cart query filters status='abandoned', so flip it here in-txn.
    if (pl.cart_id) {
      await client.query("UPDATE carts SET status = 'converted', updated_at = NOW() WHERE id::text = $1::text", [pl.cart_id]);
    }

    // Order upsert (once)
    const { rows: existingOrders } = await client.query(
      "SELECT id FROM orders WHERE ext_ref = (SELECT ext_ref FROM payment_links WHERE id = $1)",
      [pl.id]
    );

    let orderId: string;
    if (existingOrders[0]) {
      orderId = existingOrders[0].id;
      await client.query("UPDATE orders SET status = 'paid', paid_at = NOW() WHERE id = $1", [orderId]);
    } else {
      const { rows } = await client.query(
        `INSERT INTO orders (merchant_id, source, cart_id, customer_id, amount_paise, incentive_paise, status, audit_seq, simulated, paid_at, fee_basis)
         VALUES ($1, 'recovery', $2, $3, $4, $5, 'paid', $6, false, NOW(), 'modeled')
         RETURNING id`,
        [pl.merchant_id, pl.cart_id, pl.customer_id, pl.amount_paise, pl.incentive_paise, pl.audit_seq]
      );
      orderId = rows[0].id;

      // Persist ext_ref onto order for reconciler
      const { rows: extRows } = await client.query("SELECT ext_ref FROM payment_links WHERE id = $1", [pl.id]);
      if (extRows[0]?.ext_ref) {
        await client.query("UPDATE orders SET ext_ref = $1 WHERE id = $2", [extRows[0].ext_ref, orderId]);
      }
    }

    // Resolve ledger (idempotent: only PROPOSED -> SUCCESS)
    const { rows: auditRows } = await client.query(
      "SELECT * FROM audit_log WHERE seq = $1", [pl.audit_seq]
    );
    if (auditRows[0] && auditRows[0].outcome === "PROPOSED") {
      const { computeHash } = await import("./ledger.js");
      const r = auditRows[0];
      const detail = { order_id: orderId, resolved_by: "resolvePayment", paid_at: new Date().toISOString() };
      const tsIso = typeof r.ts === "string" ? r.ts : new Date(r.ts).toISOString();
      const rowData = {
        ts: tsIso, actor: r.actor, action: r.action, params: r.params_json,
        decision: r.decision, policy_checks: r.policy_checks_json, rationale: r.rationale_json,
        outcome: "SUCCESS", outcome_detail: detail, simulated: r.simulated, prev_hash: r.prev_hash,
      };
      const newHash = computeHash(r.prev_hash, rowData);
      await client.query(
        "UPDATE audit_log SET outcome = 'SUCCESS', outcome_detail_json = $1, hash = $2 WHERE seq = $3",
        [JSON.stringify(detail), newHash, pl.audit_seq]
      );
      const { cascadeRelink } = await import("./ledger.js");
      await cascadeRelink(client, r.hash, newHash);
    }

    // Activity rows (broadcast post-commit — raw SQL bypasses appendActivity).
    const rupees = formatINR(pl.amount_paise);
    const pendingFeed: Record<string, unknown>[] = [];
    const { rows: paidAct } = await client.query(
      `INSERT INTO activity (merchant_id, actor, type, summary, amount_paise, data, simulated, severity)
       VALUES ($1, 'MoneyBus', 'PAYMENT_PAID', $2, $3, $4, false, 'info') RETURNING id, ts`,
      [pl.merchant_id, `Payment of ${rupees} marked paid (REAL)`, pl.amount_paise, JSON.stringify({ order_id: orderId })]
    );
    if (paidAct[0]) {
      pendingFeed.push({
        id: paidAct[0].id, ts: paidAct[0].ts, merchant_id: pl.merchant_id,
        actor: "MoneyBus", type: "PAYMENT_PAID",
        summary: `Payment of ${rupees} marked paid (REAL)`,
        amount_paise: pl.amount_paise, data: { order_id: orderId },
        simulated: false, severity: "info",
      });
    }
    const { rows: tickAct } = await client.query(
      `INSERT INTO activity (merchant_id, actor, type, summary, amount_paise, data, simulated, severity)
       VALUES ($1, 'MoneyBus', 'REVENUE_TICK', $2, $3, $4, false, 'info') RETURNING id, ts`,
      [pl.merchant_id, `REAL revenue +${rupees}`, pl.amount_paise, JSON.stringify({ order_id: orderId, simulated: false })]
    );
    if (tickAct[0]) {
      pendingFeed.push({
        id: tickAct[0].id, ts: tickAct[0].ts, merchant_id: pl.merchant_id,
        actor: "MoneyBus", type: "REVENUE_TICK",
        summary: `REAL revenue +${rupees}`,
        amount_paise: pl.amount_paise, data: { order_id: orderId, simulated: false },
        simulated: false, severity: "info",
      });
    }
    (pl as any).__pendingFeed = pendingFeed;

    // Segment stats update
    if (pl.customer_id) {
      const { rows: cust } = await client.query("SELECT segment FROM customers WHERE id = $1", [pl.customer_id]);
      const segment = cust[0]?.segment || "default";
      const bucket = pl.incentive_paise;
      await client.query(
        `INSERT INTO segment_stats (merchant_id, segment, bucket, attempts, successes)
         VALUES ($1, $2, $3, 1, 1)
         ON CONFLICT (merchant_id, segment, bucket)
         DO UPDATE SET attempts = segment_stats.attempts + 1, successes = segment_stats.successes + 1`,
        [pl.merchant_id, segment, bucket]
      );
    }

    // N4 (v4.2): chat-segment learning — a paid chat-discount link is a success
    // for the granted bucket (attempt was recorded at ask time).
    try {
      const { rows: chatTrig } = await client.query(
        `SELECT rationale_json->>'trigger' AS trig,
                (rationale_json->>'discount_paise')::bigint AS disc
         FROM audit_log WHERE seq = $1`,
        [pl.audit_seq]
      );
      const disc = Number(chatTrig[0]?.disc || 0);
      if (chatTrig[0]?.trig === "chat_discount" && disc > 0) {
        const { nearestBucket } = await import("./economics.js");
        const { recordChatSuccess } = await import("./chatEconomics.js");
        await recordChatSuccess(pl.merchant_id, nearestBucket(disc));
      }
    } catch (chatErr: any) {
      log.warn({ error: chatErr?.message }, "Chat success recording skipped (non-critical)");
    }

    // G7 (v4.3): a paid link is a strategy success for the recorded angle.
    try {
      const { rows: stratRows } = await client.query(
        `SELECT rationale_json->>'message_strategy' AS strat FROM audit_log WHERE seq = $1`,
        [pl.audit_seq]
      );
      const strat = stratRows[0]?.strat;
      if (strat) {
        const { rows: segRows } = await client.query("SELECT segment FROM customers WHERE id = $1", [pl.customer_id]);
        const { recordStrategySuccess } = await import("./copyStrategy.js");
        await recordStrategySuccess(pl.merchant_id, segRows[0]?.segment || "default", strat);
      }
    } catch (stratErr: any) {
      log.warn({ error: stratErr?.message }, "Strategy success recording skipped (non-critical)");
    }

    // Budget settle
    if (pl.incentive_paise > 0) {
      const today = new Date().toISOString().slice(0, 10);
      await client.query(
        `INSERT INTO daily_budget (merchant_id, day, cap_paise, reserved_paise, settled_paise, released_paise)
         VALUES ($1, $2, 500000, 0, $3, 0)
         ON CONFLICT (merchant_id, day)
         DO UPDATE SET
           reserved_paise = GREATEST(daily_budget.reserved_paise - $3, 0),
           settled_paise = daily_budget.settled_paise + $3`,
        [pl.merchant_id, today, pl.incentive_paise]
      );
      await client.query(
        `UPDATE incentive_reservations SET status = 'settled'
         WHERE merchant_id = $1 AND amount_paise = $2 AND status = 'reserved'`,
        [pl.merchant_id, pl.incentive_paise]
      );
    }

    // Touches update
    if (pl.customer_id) {
      const today = new Date().toISOString().slice(0, 10);
      await client.query(
        `INSERT INTO touches (merchant_id, customer_id, day, count) VALUES ($1, $2, $3, 1)
         ON CONFLICT (customer_id, day) DO UPDATE SET count = touches.count + 1`,
        [pl.merchant_id, pl.customer_id, today]
      );
      // M22: engagement event (pay = strongest signal) for per-identity send-time.
      try {
        const { rows: ih } = await client.query("SELECT identity_hash FROM customers WHERE id = $1", [pl.customer_id]);
        if (ih[0]?.identity_hash) {
          const istH = Math.floor(((Date.now() + 5.5 * 3600e3) / 3600e3) % 24);
          await client.query(
            "INSERT INTO engagement_events (merchant_id, identity_hash, hour_ist) VALUES ($1, $2, $3)",
            [pl.merchant_id, ih[0].identity_hash, istH]
          );
        }
      } catch { /* measurement only — never blocks resolution */ }
    }

    // Sibling link cancellation (all other live links for the cart)
    if (pl.cart_id) {
      const { rows: siblings } = await client.query(
        "SELECT id, razorpay_link_id FROM payment_links WHERE cart_id = $1 AND status = 'live' AND id <> $2",
        [pl.cart_id, pl.id]
      );
      for (const sib of siblings) {
        if (sib.razorpay_link_id) {
          try {
            await cancelRazorpayLink(sib.razorpay_link_id);
          } catch { /* best effort */ }
        }
        await client.query("UPDATE payment_links SET status = 'cancelled' WHERE id = $1", [sib.id]);
      }
      await client.query(
        "UPDATE sibling_links SET status = 'superseded' WHERE cart_id = $1 AND payment_link_id <> $2 AND status = 'active'",
        [pl.cart_id, pl.razorpay_link_id]
      );
    }
  });

  // Post-commit: the PAYMENT_PAID / REVENUE_TICK rows above must reach the
  // live feed (raw SQL writes bypass appendActivity's broadcast — that gap
  // hid every payment resolution from the console until refresh).
  try {
    const pending = (pl as any).__pendingFeed as Record<string, unknown>[] | undefined;
    delete (pl as any).__pendingFeed;
    if (pending && pending.length > 0) {
      const { broadcastActivity } = await import("./activity.js");
      for (const row of pending) broadcastActivity(row);
    }
  } catch { /* feed fan-out never fails resolution */ }

  // Post-commit: trigger UpsellBot (outside the transaction)
  try {
    const { processPaidOrder } = await import("../agents/upsellBot.js");
    await processPaidOrder(pl);
  } catch (err: any) {
    log.error({ error: err.message }, "UpsellBot trigger failed");
  }

  // G6 (v4.3): post-purchase reassurance (transactional class, separate
  // from UpsellBot — never a pitch). Best-effort, never fails resolution.
  try {
    await sendReassurance(pl);
  } catch (err: any) {
    log.warn({ error: err?.message }, "Reassurance send skipped (non-critical)");
  }
}

/**
 * G6 (v4.3): confirmation message on paid. Saved amount appears ONLY when
 * incentive_paise > 0 on a paid link (saved_amount token, stripped otherwise).
 * Delivery ETA renders only from real merchant config (none held → omitted).
 */
async function sendReassurance(pl: {
  merchant_id: string;
  amount_paise: number;
  incentive_paise: number;
  cart_id: string | null;
  customer_id: string | null;
}): Promise<void> {
  const { finalizeCopy } = await import("./claims.js");
  const incentive = Number(pl.incentive_paise || 0);
  const rawCopy = incentive > 0
    ? `Payment confirmed. You saved [claim:saved_amount:]. Questions about your order? We're here to help.`
    : `Payment confirmed. Questions about your order? We're here to help.`;
  const { copy } = await finalizeCopy({
    copy: rawCopy,
    facts: { order_incentive_paise: incentive, order_paid: true },
    source: "code",
    fallbackTemplate: "Payment confirmed. Questions about your order? We're here to help.",
    ledger: null,
  });
  try {
    await query(
      `INSERT INTO notification_outbox (merchant_id, intent_id, channel, status, payload_hash, message_version)
       VALUES ($1, NULL, 'reassurance', 'pending', $2, '1')`,
      [pl.merchant_id, crypto.createHash("sha256").update(copy).digest("hex")]
    );
  } catch (outboxErr: any) {
    log.warn({ error: outboxErr?.message }, "Reassurance outbox insert failed (non-critical)");
  }
  await appendActivity({
    merchant_id: pl.merchant_id, actor: "MoneyBus", type: "REASSURANCE",
    summary: copy.slice(0, 140),
    amount_paise: Number(pl.amount_paise),
    data: { message_copy: copy, incentive_paise: incentive, customer_id: pl.customer_id, cart_id: pl.cart_id },
  });
  try {
    const { emitMessageSent } = await import("./messageStream.js");
    await emitMessageSent({
      merchantId: pl.merchant_id, actor: "Reassurance", channel: "reassurance",
      messageCopy: copy, messageStrategy: "functional", messageTone: "warm",
      brainMode: "rules", cartOrOrderRef: pl.cart_id,
      resolvedTokens: [], incentivePaise: incentive,
      simulated: false, customerId: pl.customer_id || null,
    });
  } catch { /* stream never blocks resolution */ }
}

/**
 * G2 (v4.3) sweeper: release expired holds. Links past expire_by flip to
 * expired (Razorpay cancel best-effort), their incentive reservation is
 * released back to budget, and the release is activity-logged. The final
 * call's stated deadline equals these expire_by values (U-DEADLINE).
 */
export async function sweepExpiredLinks(): Promise<{ expired: number }> {
  // Enforced deadline = the offer window when shorter than the gateway floor.
  const { rows: due } = await query(
    `SELECT id, merchant_id, razorpay_link_id, incentive_paise, customer_id FROM payment_links
     WHERE status = 'live'
     AND LEAST(expire_by, COALESCE(offer_expires_by, expire_by)) <= NOW()
     AND expire_by IS NOT NULL
     LIMIT 100`
  );
  let expired = 0;
  for (const link of due) {
    try {
      if (link.razorpay_link_id) {
        try { await cancelRazorpayLink(link.razorpay_link_id); } catch { /* best effort */ }
      }
      await query("UPDATE payment_links SET status = 'expired' WHERE id = $1", [link.id]);
      // T4: cart lapsed unresolved to expiry → abandonment cycle. Payments
      // (resolvePayment) and save-for-later paths never touch this counter.
      if (link.customer_id) {
        await query(
          "UPDATE customers SET abandonment_cycles = abandonment_cycles + 1 WHERE id = $1",
          [link.customer_id]
        ).catch(() => {});
      }
      const incentive = Number(link.incentive_paise || 0);
      if (incentive > 0) {
        const { releaseBudget } = await import("./budget.js");
        await releaseBudget(link.merchant_id, incentive);
      }
      await appendActivity({
        merchant_id: link.merchant_id, actor: "MoneyBus", type: "HOLD_RELEASED",
        summary: `Hold released — link expired${incentive > 0 ? `, ${formatINR(incentive)} incentive returned to budget` : ""}`,
        data: { link_id: link.id, razorpay_link_id: link.razorpay_link_id, incentive_paise: incentive },
      });
      expired++;
    } catch (err: any) {
      log.warn({ linkId: link.id, error: err?.message }, "Sweeper failed on link (will retry next pass)");
    }
  }
  if (expired > 0) log.info({ expired }, "Sweeper released expired holds");
  return { expired };
}

export { rzp, encrypt, decrypt };