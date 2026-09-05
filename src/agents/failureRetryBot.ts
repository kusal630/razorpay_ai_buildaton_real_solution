import { query } from "../db.js";
import { evaluateAction } from "../lib/policyEngine.js";
import * as moneyBus from "../lib/moneyBus.js";
import { createIntent, completeIntent, failIntent, markAwaitingGateway } from "../lib/intentExecutor.js";
import { callBrain, buildRecoveryContext } from "../lib/sharedBrain.js";
import { finalizeCopy } from "../lib/claims.js";
import { checkTransactionalConsent, anchorTransactional } from "../lib/consent.js";
import { appendActivity } from "../lib/activity.js";
import { formatINR } from "../lib/format.js";
import { createLogger } from "../logger.js";

const log = createLogger("FailureRetryBot");
const MERCHANT_ID = "5a3ac6ce-b2c7-4b1f-a9db-45296841f30b";

/** Failure-retry orders need method + recency columns (added if missing). */
export async function ensureFailureColumns(): Promise<void> {
  await query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT");
  await query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ");
}

/**
 * G4 (v4.3) recency rule: a fresh failure (<60min) is reactive (the customer
 * just tried to pay — send any hour); an older one is proactive (quiet
 * hours + full gates apply). Pure function, unit-covered by U-FAILCOPY.
 */
export function classifyFailureRecency(failedAt: Date | string | null): "reactive_buyer_action" | "proactive_marketing_touch" {
  if (!failedAt) return "proactive_marketing_touch";
  const ageMs = Date.now() - new Date(failedAt).getTime();
  return ageMs < 60 * 60 * 1000 ? "reactive_buyer_action" : "proactive_marketing_touch";
}

/**
 * Grounded method-switch sentence, built ONLY from the stored failed method.
 * Acknowledge + de-shame + suggest the alternative. No numbers, no promises.
 */
export function methodSwitchSentence(method: string | null): string {
  const m = (method || "").toLowerCase();
  if (m.includes("upi")) {
    return "Your UPI didn't go through — no worries, your order's still reserved. You can pay by card instead.";
  }
  if (m.includes("card")) {
    return "Your card didn't go through — no worries, your order's still reserved. You can try UPI instead.";
  }
  return "Your payment didn't go through — no worries, your order's still reserved. You can try another payment method.";
}

/**
 * G4 (v4.3) FailureRetryBot: one plain-₹0 retry link for a failed order.
 * Same-or-lower incentive rule: incentive is ALWAYS 0. Transactional class.
 * NOT arm-gated (N1): retrying an attempted transaction is transactional,
 * like resolution — only new proactive touches are suppressed.
 */
export async function processFailedOrder(orderId: string): Promise<void> {
  await ensureFailureColumns();
  const { rows: orderRows } = await query("SELECT * FROM orders WHERE id = $1", [orderId]);
  const order = orderRows[0];
  if (!order || order.status !== "failed") {
    log.debug({ orderId }, "Order not found or not failed");
    return;
  }
  const cartId = order.cart_id;
  const customerId = order.customer_id;
  const cartTotal = Number(order.amount_paise);
  if (!customerId || !cartId) {
    log.debug({ orderId }, "Failed order has no customer/cart anchor");
    return;
  }

  // Skip if already resolved/paid or a live retry link exists.
  const { rows: liveRows } = await query(
    `SELECT 1 FROM payment_links WHERE cart_id::text = $1::text AND status = 'live' LIMIT 1`,
    [cartId]
  );
  const { rows: paidRows } = await query(
    `SELECT 1 FROM payment_links WHERE cart_id::text = $1::text AND status = 'paid'
     UNION SELECT 1 FROM orders WHERE id = $2 AND status = 'paid' LIMIT 1`,
    [cartId, orderId]
  );
  if (liveRows.length > 0 || paidRows.length > 0) {
    log.debug({ orderId }, "Retry unnecessary — live or paid already");
    return;
  }

  await appendActivity({
    merchant_id: MERCHANT_ID, actor: "FailureRetryBot", type: "TRIGGER_DETECTED",
    summary: `Payment failed for order ${orderId} (${formatINR(cartTotal)})`,
    amount_paise: cartTotal,
    data: { order_id: orderId, cart_id: cartId, method: order.payment_method || null },
  });

  // The attempt itself anchors transactional consent.
  await anchorTransactional(customerId, cartId);
  const hasTransactional = await checkTransactionalConsent(customerId);
  if (!hasTransactional) {
    await appendActivity({
      merchant_id: MERCHANT_ID, actor: "FailureRetryBot", type: "DUPLICATE_SKIPPED",
      summary: `Retry skipped — no transactional consent (order ${orderId})`,
      data: { order_id: orderId, reason: "no_transactional_consent" },
    });
    return;
  }

  const failedAt = order.failed_at || order.created_at;
  const actionClass = classifyFailureRecency(failedAt);

  const intent = await createIntent({
    merchantId: MERCHANT_ID, customerId,
    actionType: "recovery_retry", targetId: orderId,
  });
  if (!intent.isNew) return;

  const { rows: custRows } = await query("SELECT segment FROM customers WHERE id = $1", [customerId]);
  const segment = custRows[0]?.segment || "default";
  const { rows: lineRows } = await query(
    `SELECT ci.product_id AS id, p.name, COALESCE(p.price_paise, ci.unit_price_paise) AS price_paise
     FROM cart_items ci LEFT JOIN products p ON p.id = ci.product_id
     WHERE ci.cart_id::text = $1::text`,
    [cartId]
  );
  const items = lineRows.map((r: any) => ({ id: r.id, name: r.name || "Product", price_paise: Number(r.price_paise || 0) }));

  // Feasible menu for retries: plain only, always. Same-or-lower (₹0) by construction.
  const brain = await callBrain("failure_retry", buildRecoveryContext({
    customerId, segment, touchHistory: 1, consentState: "transactional",
    experimentArm: "none", cartId,
    cartItems: items,
    feasibleOptions: [{ action: "send_plain_link", bucket_paise: 0, ev_paise: 0, theta: 0.1 }],
    maxIncentivePaise: 0, marginPaise: Math.floor(cartTotal * 0.4),
    thetaEstimates: { "0": 0.1 },
    merchantId: MERCHANT_ID,
    caseType: "failure_retry",
  }));

  const frame = methodSwitchSentence(order.payment_method);
  const finalized = brain.mode === "llm"
    ? await finalizeCopy({
      copy: `${frame} ${brain.message_copy}`,
      facts: {
        incentive_paise: 0, cart_total_paise: cartTotal,
        items: items.map((i) => ({ id: i.id, name: i.name, price_paise: i.price_paise })),
      },
      source: "llm",
      fallbackTemplate: `${frame} Complete your purchase here.`,
      ledger: { merchantId: MERCHANT_ID, actor: "FailureRetryBot", action: "create_payment_link" },
    })
    : { copy: `${frame} Complete your purchase here.`, result: { copy: "", resolved: [], stripped: [], allowed_numbers: [], fallback: false, violations: [] } };

  await appendActivity({
    merchant_id: MERCHANT_ID, actor: "FailureRetryBot", type: "AGENT_THOUGHT",
    summary: `Retry (₹0, ${actionClass === "reactive_buyer_action" ? "reactive" : "proactive"}) — ${brain.rationale.reasoning.slice(0, 100)}`,
    data: {
      mode: brain.mode, strategy: "send_plain_link", tone: brain.message_tone,
      incentive_bucket_paise: 0, order_id: orderId, recency_class: actionClass,
      case_type: "failure_retry",
      secondary_cta: (brain as any).raw?.secondary_cta || "none",
      fallback_reason: (brain as any).fallback_reason || null,
      reasoning: brain.rationale.reasoning, message_copy: finalized.copy,
      claims_resolved: finalized.result.resolved, claims_stripped: finalized.result.stripped,
    },
  });

  const policyResult = await evaluateAction("recovery_incentive", {
    amount_paise: 0, incentive_paise: 0,
    margin_paise: Math.floor(cartTotal * 0.4), cart_total_paise: cartTotal,
    customerId, isPaymentFailed: true, actionClass,
  });
  await appendActivity({
    merchant_id: MERCHANT_ID, actor: "FailureRetryBot", type: "POLICY_EVAL",
    summary: `Policy: ${policyResult.decision}`,
    data: { checks: policyResult.checks, reasons: policyResult.reasons },
  });
  if (policyResult.decision !== "ALLOW") {
    await failIntent(intent.intentId, "skipped");
    return;
  }

  await markAwaitingGateway(intent.intentId);
  try {
    const { seq, data } = await moneyBus.execute(
      "FailureRetryBot",
      {
        type: "create_payment_link",
        params: { amount: cartTotal, incentive_paise: 0, cart_total_paise: cartTotal, cart_id: cartId, description: `Retry payment - ${orderId}` },
      },
      policyResult,
      {
        cart_id: cartId, customer_id: customerId, segment, trigger: "payment_failed_retry",
        order_id: orderId, failed_method: order.payment_method || null,
        incentive_paise: 0, policy_checks: policyResult.checks, intent_id: intent.intentId,
        brain_mode: brain.mode, brain_reasoning: brain.rationale.reasoning,
        message_copy: finalized.copy,
        raw_copy: brain.message_copy,
        message_strategy: (brain as any).raw?.message_strategy || "functional",
        claims_resolved: finalized.result.resolved, claims_stripped: finalized.result.stripped,
      },
      MERCHANT_ID
    );
    if (data && data.link_id) {
      await completeIntent(intent.intentId);
      const today = new Date().toISOString().slice(0, 10);
      const { rows: cartRows } = await query("SELECT merchant_id FROM carts WHERE id::text = $1::text", [cartId]);
      await query(
        `INSERT INTO touches (merchant_id, customer_id, day, count) VALUES ($1, $2, $3, 1)
         ON CONFLICT (customer_id, day) DO UPDATE SET count = touches.count + 1`,
        [cartRows[0]?.merchant_id || MERCHANT_ID, customerId, today]
      );
      log.info({ orderId, seq }, "FailureRetryBot retry link created");
    } else {
      await failIntent(intent.intentId, "pending");
    }
  } catch (err: any) {
    await failIntent(intent.intentId, "pending");
    throw err;
  }
}

/**
 * Link-attempt failure nudge (first sighting only — the caller gates on
 * linkFailures.recordLinkPaymentFailure isNew). The link stays LIVE (the
 * customer may be retrying on it right now), so — unlike the failed-order
 * retry — this NEVER mints a replacement link: it re-points at the existing
 * short_url in a calm, rules-mode message. Transactional class (their own
 * attempted purchase), ₹0, ledgered + MESSAGE_SENT like every send.
 */
export async function sendLinkFailureNudge(
  link: {
    id: string; merchant_id: string; razorpay_link_id: string;
    cart_id: string | null; customer_id: string | null;
    amount_paise: number; short_url?: string | null;
  },
  payment: any,
  orderId: string | null
): Promise<void> {
  const customerId = link.customer_id;
  if (!customerId) return;
  const method = payment?.method || payment?.payment_method || null;

  // Never tell a customer who already paid that their payment failed
  // (a later attempt can fail after an earlier one succeeded).
  if (link.cart_id) {
    const { rows: paidRows } = await query(
      `SELECT 1 FROM payment_links WHERE cart_id = $1 AND status = 'paid'
       UNION SELECT 1 FROM orders WHERE cart_id = $1::uuid AND status = 'paid' LIMIT 1`,
      [link.cart_id]
    ).catch(() => ({ rows: [] as any[] }));
    if (paidRows.length > 0) {
      await appendActivity({
        merchant_id: MERCHANT_ID, actor: "FailureRetryBot", type: "DUPLICATE_SKIPPED",
        summary: `Link-failure nudge skipped — cart already paid (link ${link.razorpay_link_id})`,
        data: { razorpay_link_id: link.razorpay_link_id, reason: "already_paid" },
      });
      return;
    }
  }

  // The attempt itself anchors transactional consent (same as the retry path).
  await anchorTransactional(customerId, link.cart_id || `link:${link.id}`);
  const hasTransactional = await checkTransactionalConsent(customerId);
  if (!hasTransactional) {
    await appendActivity({
      merchant_id: MERCHANT_ID, actor: "FailureRetryBot", type: "DUPLICATE_SKIPPED",
      summary: `Link-failure nudge skipped — no transactional consent (link ${link.razorpay_link_id})`,
      data: { razorpay_link_id: link.razorpay_link_id, reason: "no_transactional_consent" },
    });
    return;
  }

  // Velocity accounting: a nudge is a customer contact.
  const today = new Date().toISOString().slice(0, 10);
  const { rows: linkRows } = await query("SELECT merchant_id FROM payment_links WHERE id = $1", [link.id]);
  await query(
    `INSERT INTO touches (merchant_id, customer_id, day, count) VALUES ($1, $2, $3, 1)
     ON CONFLICT (customer_id, day) DO UPDATE SET count = touches.count + 1`,
    [linkRows[0]?.merchant_id || MERCHANT_ID, customerId, today]
  );

  const frame = methodSwitchSentence(method);
  const liveLine = link.short_url
    ? ` Your payment link is still active — you can try again here: ${link.short_url}`
    : ` Your payment link is still active — please try again.`;
  const rawCopy = `${frame}${liveLine}`;
  const finalized = await finalizeCopy({
    copy: rawCopy,
    facts: { incentive_paise: 0, cart_total_paise: Number(link.amount_paise || 0), items: [] },
    source: "code",
    fallbackTemplate: "Your payment didn't go through — your link is still active, please try again.",
    ledger: { merchantId: MERCHANT_ID, actor: "FailureRetryBot", action: "link_payment_failed_nudge" },
  });

  const { appendLedger } = await import("../lib/ledger.js");
  const { seq } = await appendLedger({
    merchantId: MERCHANT_ID, actor: "FailureRetryBot", action: "link_payment_failed_nudge",
    params: {
      razorpay_link_id: link.razorpay_link_id, cart_id: link.cart_id,
      order_id: orderId, failed_method: method, short_url: link.short_url || null,
    },
    decision: "ALLOW",
    policy_checks: { consent_class: "transactional", link_reuse: "no_new_link_minted" },
    rationale: {
      reason: "failed attempt on a live link; nudge re-points at the existing link",
      brain_mode: "rules",
    },
    outcome: "SUCCESS",
  } as any);

  const { emitMessageSent } = await import("../lib/messageStream.js");
  await emitMessageSent({
    merchantId: MERCHANT_ID, actor: "FailureRetryBot", channel: "retry",
    messageCopy: finalized.copy, rawCopy,
    messageStrategy: "functional", messageTone: "helpful",
    brainMode: "rules", cartOrOrderRef: link.cart_id,
    resolvedTokens: (finalized as any).result?.resolved || [],
    incentivePaise: 0, customerId, ledgerSeq: seq,
  });
  const { markNudged } = await import("../lib/linkFailures.js");
  await markNudged(undefined, String(payment?.id || ""));
  log.info({ linkId: link.razorpay_link_id, seq }, "Link-failure nudge sent (existing link reused)");
}
