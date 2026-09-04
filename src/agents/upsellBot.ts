import { query } from "../db.js";
import { evaluateAction } from "../lib/policyEngine.js";
import * as moneyBus from "../lib/moneyBus.js";
import { appendActivity } from "../lib/activity.js";
import { checkMarketingConsent } from "../lib/consent.js";
import { callBrain, buildUpsellContext } from "../lib/sharedBrain.js";
import { finalizeCopy } from "../lib/claims.js";
import { getCustomerArm } from "../lib/experiment.js";
import { createLogger } from "../logger.js";

const log = createLogger("UpsellBot");
const MERCHANT_ID = "5a3ac6ce-b2c7-4b1f-a9db-45296841f30b";
const MAX_DISCOUNT_PCT = 15;

export async function processPaidOrder(pl: {
  id: string;
  cart_id: string | null;
  customer_id: string | null;
  amount_paise: number;
}): Promise<void> {
  if (!pl.customer_id || !pl.cart_id) {
    log.debug("No customer or cart, skipping upsell");
    return;
  }

  const hasMarketing = await checkMarketingConsent(pl.customer_id);
  if (!hasMarketing) {
    await appendActivity({
      merchant_id: MERCHANT_ID,
      actor: "UpsellBot",
      type: "SKIP_UPSELL",
      summary: `Upsell skipped — no marketing consent (customer ${pl.customer_id.slice(0, 8)})`,
      data: { reason: "consent_marketing_missing", customer_id: pl.customer_id },
    });
    return;
  }

  // ── N1 (v4.2) EXPERIMENT INTEGRITY: control arm gets NO proactive proposal ──
  // Transactional resolution/stats below are untouched; only this NEW touch is suppressed.
  const armInfo = await getCustomerArm(pl.customer_id);
  if (armInfo && armInfo.arm === "control") {
    const { appendLedger } = await import("../lib/ledger.js");
    const { seq } = await appendLedger({
      merchantId: MERCHANT_ID,
      actor: "UpsellBot",
      action: "arm_suppressed",
      params: { order_id: pl.id, cart_id: pl.cart_id, customer_id: pl.customer_id },
      decision: "BLOCK",
      policy_checks: { experiment_arm: "CONTROL" },
      rationale: {
        reason: "control_arm_no_proactive_touch",
        arm: "control",
        experiment_id: armInfo.experimentId,
      },
      outcome: "SKIPPED",
    });
    await appendActivity({
      merchant_id: MERCHANT_ID,
      actor: "UpsellBot",
      type: "SKIP_UPSELL",
      summary: `Upsell suppressed — control arm (experiment ${armInfo.experimentId.slice(0, 8)})`,
      data: { reason: "control_arm", experiment_id: armInfo.experimentId, audit_seq: seq },
    });
    log.info({ orderId: pl.id, arm: "control" }, "UpsellBot suppressed for control arm");
    return;
  }

  // ── LOAD CANDIDATES (scoped to the cart's merchant — the catalog lives there) ──
  const { rows: cartRows } = await query("SELECT merchant_id FROM carts WHERE id = $1", [pl.cart_id]);
  const cartMerchantId = cartRows[0]?.merchant_id || MERCHANT_ID;

  const { rows: lineRows } = await query("SELECT product_id FROM cart_items WHERE cart_id = $1", [pl.cart_id]);
  const purchasedIds = new Set<string>();
  for (const row of lineRows) purchasedIds.add(row.product_id);

  const { rows: allProducts } = await query(
    `SELECT id, name, price_paise, cost_paise, stock FROM products
     WHERE merchant_id = $1 AND active = true AND stock > 0`,
    [cartMerchantId]
  );
  const candidates = allProducts.filter((p: any) => !purchasedIds.has(p.id));

  if (candidates.length === 0) {
    log.debug("No cross-sell candidates available");
    return;
  }

  // Rank by margin × attach rate, take top 3
  const shortlist = candidates
    .map((p: any) => ({
      id: p.id,
      name: p.name,
      price_paise: Number(p.price_paise),
      margin_paise: Number(p.price_paise) - Number(p.cost_paise),
      attach_rate: 0.15,
      score: (Number(p.price_paise) - Number(p.cost_paise)) * 0.15,
    }))
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, 3);

  // ── FEASIBLE OPTIONS (discounts the brain can choose) ──
  const feasibleDiscounts = [0, MAX_DISCOUNT_PCT]; // 0% or 15%

  await appendActivity({
    merchant_id: MERCHANT_ID,
    actor: "UpsellBot",
    type: "UPLIFT_DECISION",
    summary: `Shortlist: ${shortlist.map((s: any) => `${s.name}(₹${s.price_paise / 100})`).join(", ")}`,
    data: {
      candidates: shortlist.map((s: any) => ({ id: s.id, name: s.name, price_paise: s.price_paise, margin_paise: s.margin_paise })),
      feasible_discounts: feasibleDiscounts,
    },
  });

  // ── THE LLM BRAIN ──
  const brainContext = buildUpsellContext({
    customerId: pl.customer_id,
    orderId: pl.id,
    candidates: shortlist,
    feasibleDiscounts: feasibleDiscounts.map(d => d * 100), // convert to paise for schema
    maxDiscountPct: MAX_DISCOUNT_PCT,
  });

  const brain = await callBrain("upsell", brainContext);

  // Validate brain output: selected item must be in shortlist
  let selectedId = brain.raw?.selected_item_id || shortlist[0].id;
  let selectedProduct = shortlist.find((s: any) => s.id === selectedId) || shortlist[0];

  // Validate discount: must be 0 or 15
  let discountPct = brain.raw?.discount_pct ?? 0;
  if (![0, MAX_DISCOUNT_PCT].includes(discountPct)) {
    discountPct = 0; // clamp to nearest feasible
  }

  const discountPaise = Math.floor(selectedProduct.price_paise * discountPct / 100);
  const finalAmount = selectedProduct.price_paise - discountPaise;

  // ── N28 (v4.3): ground the copy pre-send; fast add-on link lives 10 min ──
  const upsellTtlSeconds = 10 * 60;
  const upsellExpiryIso = new Date(Date.now() + upsellTtlSeconds * 1000).toISOString();
  const finalizedUpsell = brain.mode === "llm"
    ? await finalizeCopy({
      copy: brain.message_copy,
      facts: {
        incentive_paise: discountPaise,
        cart_total_paise: finalAmount,
        items: [{ id: selectedProduct.id, name: selectedProduct.name, price_paise: selectedProduct.price_paise }],
        link_expiry_iso: upsellExpiryIso,
        extra_numbers: [discountPct],
      },
      source: "llm",
      fallbackTemplate: "Since you just purchased, we think you might like this add-on.",
      ledger: { merchantId: MERCHANT_ID, actor: "UpsellBot", action: "create_payment_link" },
    })
    : { copy: brain.message_copy, result: { copy: brain.message_copy, resolved: [], stripped: [], allowed_numbers: [], fallback: false, violations: [] } };
  const upsellCopy = finalizedUpsell.copy;

  // ── EMIT AGENT_THOUGHT ──
  await appendActivity({
    merchant_id: MERCHANT_ID,
    actor: "UpsellBot",
    type: "AGENT_THOUGHT",
    summary: brain.mode === "llm"
      ? `Brain: ${selectedProduct.name}, ${discountPct}% off — ${brain.rationale.reasoning.slice(0, 120)}`
      : `Rules: ${selectedProduct.name}, default suggestion — LLM unavailable`,
    data: {
      mode: brain.mode,
      selected_item_id: selectedProduct.id,
      discount_pct: discountPct,
      discount_paise: discountPaise,
      tone: brain.message_tone,
      reasoning: brain.rationale.reasoning,
      message_copy: upsellCopy,
      claims_resolved: finalizedUpsell.result.resolved,
      claims_stripped: finalizedUpsell.result.stripped,
    },
  });

  // ── POLICY ENGINE (always runs — LLM never bypasses) ──
  // amount_paise is the merchant's EXPOSURE (the discount), same convention as
  // recovery (amount = incentive); the customer-facing total rides in cart_total_paise.
  const policyResult = await evaluateAction("upsell_discount", {
    amount_paise: discountPaise,
    incentive_paise: discountPaise,
    cart_total_paise: finalAmount,
    margin_paise: selectedProduct.margin_paise,
    customerId: pl.customer_id,
    isUpsell: true,
    actionClass: "proactive_marketing_touch",
  });

  // Policy drill demo: if brain proposes >15%, block and clamp
  if (discountPct > MAX_DISCOUNT_PCT) {
    policyResult.decision = "BLOCK";
    policyResult.reasons.push(`discount_${discountPct}%_exceeds_cap_${MAX_DISCOUNT_PCT}%`);
    policyResult.checks.discount_cap = "BLOCK";
  }

  await appendActivity({
    merchant_id: MERCHANT_ID,
    actor: "UpsellBot",
    type: "POLICY_EVAL",
    summary: `Policy: ${policyResult.decision} — ${Object.entries(policyResult.checks).map(([k, v]) => `${k}=${v}`).join(", ")}`,
    data: { checks: policyResult.checks, reasons: policyResult.reasons },
  });

  if (policyResult.decision === "BLOCK") {
    log.info({ productId: selectedProduct.id }, "UpsellBot blocked by policy");
    return;
  }

  if (policyResult.decision === "ESCALATE") {
    // Same pattern as the money-bus ESCALATE path: ledger row first, then the
    // human approval (approvals.audit_seq is NOT NULL + FK to audit_log).
    const { appendLedger } = await import("../lib/ledger.js");
    const { seq } = await appendLedger({
      merchantId: MERCHANT_ID,
      actor: "UpsellBot",
      action: "upsell_discount",
      params: { product_id: selectedProduct.id, amount_paise: finalAmount, discount_paise: discountPaise },
      decision: "ESCALATE",
      policy_checks: policyResult.checks,
      rationale: { reasons: policyResult.reasons, brain_mode: brain.mode },
      outcome: "ESCALATED",
    });
    const { rows: approvalRows } = await query(
      `INSERT INTO approvals (merchant_id, audit_seq, context, status)
       VALUES ($1, $2, $3, 'pending') RETURNING id`,
      [MERCHANT_ID, seq, JSON.stringify({ product_id: selectedProduct.id, discount_paise: discountPaise, trigger: "post_payment_upsell" })]
    );
    await appendActivity({
      merchant_id: MERCHANT_ID,
      actor: "UpsellBot",
      type: "ESCALATED",
      summary: `ESCALATED: ${policyResult.reasons.join(", ")} (approval ${approvalRows[0].id})`,
      data: { checks: policyResult.checks, approval_id: approvalRows[0].id, audit_seq: seq },
    });
    return;
  }

  // ── MONEY BUS ──
  try {
    await moneyBus.execute(
      "UpsellBot",
      {
        type: "create_payment_link",
        params: {
          amount: finalAmount,
          incentive_paise: discountPaise,
          // G5 (v4.3) fast add-on: single item, pre-filled customer, 10-min TTL.
          ttl_seconds: upsellTtlSeconds,
          expire_by_iso: upsellExpiryIso,
          prefill_customer: true,
          description: `Add to your order — ships in the same box: ${selectedProduct.name}`,
        },
      },
      policyResult,
      {
        cart_id: pl.cart_id,
        customer_id: pl.customer_id,
        trigger: "post_payment_upsell",
        product_id: selectedProduct.id,
        discount_paise: discountPaise,
        policy_checks: policyResult.checks,
        brain_mode: brain.mode,
        brain_reasoning: brain.rationale.reasoning,
        message_copy: upsellCopy,
        claims_resolved: finalizedUpsell.result.resolved,
        claims_stripped: finalizedUpsell.result.stripped,
      },
      MERCHANT_ID
    );
    log.info({ productId: selectedProduct.id, brainMode: brain.mode }, "UpsellBot created link");
  } catch (err: any) {
    log.error({ error: err.message }, "UpsellBot link creation failed");
  }
}
