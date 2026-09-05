import { query } from "../db.js";
import { evaluateAction } from "../lib/policyEngine.js";
import * as moneyBus from "../lib/moneyBus.js";
import { pseudonymize } from "../lib/pseudonymize.js";
import {
  createIntent,
  completeIntent,
  failIntent,
  markAwaitingGateway,
  deferIntent,
} from "../lib/intentExecutor.js";
import { assignToExperiment, getActiveExperiment } from "../lib/experiment.js";
import { getConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { checkTransactionalConsent, checkMarketingConsent } from "../lib/consent.js";
import { upliftEv, selectBucket, CONSTANTS, INCENTIVE_BUCKETS } from "../lib/economics.js";
import { reserveBudget, releaseBudget } from "../lib/budget.js";
import { formatINR } from "../lib/format.js";
import { anchorTransactional } from "../lib/consent.js";
import { appendActivity } from "../lib/activity.js";
import { checkQuietHours } from "../lib/policy2.js";
import { callBrain, buildRecoveryContext } from "../lib/sharedBrain.js";
import { finalizeCopy } from "../lib/claims.js";
import { appendLedger } from "../lib/ledger.js";
import { chooseMessageStrategy, recordStrategyAttempt } from "../lib/copyStrategy.js";

const log = createLogger("RecoveryBot");

const BUCKETS = INCENTIVE_BUCKETS;
const MERCHANT_ID = "5a3ac6ce-b2c7-4b1f-a9db-45296841f30b";

function sampleBeta(alpha: number, beta: number): number {
  return alpha / (alpha + beta);
}

/**
 * N6/R1 (v4.2) two-touch recovery stages.
 * - early: carts abandoned ≥1h and <24h, zero touches → plain ₹0 first touch.
 * - 24h: the classic path (incentivized when consented + EV-positive).
 * Stages ride separate intent action_types so each touch gets its own row.
 */
export type RecoveryStage = "early" | "24h";

export async function processAbandonedCart(
  cartId: string,
  opts?: { stage?: RecoveryStage }
): Promise<void> {
  const config = getConfig();
  const stage: RecoveryStage = opts?.stage || "24h";
  const actionType = stage === "early" ? "recovery_early" : "recovery_24h";
  const triggerLabel = stage === "early" ? "cart_abandoned_1h" : "cart_abandoned_24h";

  // ── STEP 1: LOAD CART ──
  const { rows: cartRows } = await query(
    "SELECT * FROM carts WHERE id = $1 AND status = 'abandoned'",
    [cartId]
  );
  if (!cartRows[0]) {
    log.debug({ cartId }, "Cart not found or not abandoned");
    return;
  }

  const cart = cartRows[0];
  const customerId = cart.customer_id;
  const cartTotal = Number(cart.total_paise);
  const cartMerchantId = cart.merchant_id;

  // Remote schema: line items live in cart_items (no items_json on carts)
  const { rows: lineRows } = await query(
    `SELECT ci.product_id AS id, p.name, p.price_paise, ci.qty,
            p.cost_paise
     FROM cart_items ci
     LEFT JOIN products p ON p.id = ci.product_id
     WHERE ci.cart_id = $1`,
    [cartId]
  );
  const itemsJson = lineRows.map((r: any) => ({
    id: r.id,
    name: r.name || "Product",
    price_paise: Number(r.price_paise ?? r.unit_price_paise ?? 0),
    price: Number(r.price_paise ?? 0),
    qty: Number(r.qty || 1),
    cost_paise: Number(r.cost_paise ?? 0),
  }));

  // ── STEP 2: TRIGGER DETECTED ──
  await appendActivity({
    merchant_id: MERCHANT_ID,
    actor: "RecoveryBot",
    type: "TRIGGER_DETECTED",
    summary: `Abandoned cart detected: ${cartId} (${formatINR(cartTotal)}, stage=${stage})`,
    amount_paise: cartTotal,
    data: { cart_id: cartId, abandoned_at: cart.abandoned_at, total_paise: cartTotal, stage },
  });

  // ── PAID-SKIP: never chase a cart that already converted ──
  const { rows: paidRows } = await query(
    `SELECT 1 FROM payment_links WHERE cart_id = $1 AND status = 'paid'
     UNION SELECT 1 FROM orders WHERE cart_id = $1::uuid AND status = 'paid' LIMIT 1`,
    [cartId]
  );
  if (paidRows.length > 0) {
    await appendActivity({
      merchant_id: MERCHANT_ID,
      actor: "RecoveryBot",
      type: "DUPLICATE_SKIPPED",
      summary: `Cart ${cartId} skipped — already paid`,
      data: { cart_id: cartId, reason: "already_paid", stage },
    });
    log.debug({ cartId, stage }, "Cart already paid, skipping");
    return;
  }

  // ── STEP 3: WRITE-AHEAD INTENT (crash guard) ──
  if (!customerId) {
    await appendActivity({
      merchant_id: MERCHANT_ID,
      actor: "RecoveryBot",
      type: "SKIP_ANONYMOUS",
      summary: `Cart ${cartId} skipped — no identity anchor`,
      data: { cart_id: cartId, reason: "anonymous_cart" },
    });
    log.debug({ cartId }, "Anonymous cart, skipping");
    return;
  }

  const hasTransactional = await checkTransactionalConsent(customerId);
  if (!hasTransactional) {
    await appendActivity({
      merchant_id: MERCHANT_ID,
      actor: "RecoveryBot",
      type: "DUPLICATE_SKIPPED",
      summary: `Cart ${cartId} skipped — no transactional consent`,
      data: { cart_id: cartId, reason: "no_transactional_consent" },
    });
    return;
  }

  const { rows: custRows } = await query(
    "SELECT id, segment, identity_hash, abandonment_cycles FROM customers WHERE id = $1",
    [customerId]
  );
  const segment = custRows[0]?.segment || "default";
  const identityToken = custRows[0]?.identity_hash || customerId;
  // T4: abandonment-cycle covariate (record now, graduate later — NO θ math).
  const abandonmentCycles = Number((custRows[0] as any)?.abandonment_cycles || 0);

  const today = new Date().toISOString().slice(0, 10);
  const { rows: touchRows } = await query(
    "SELECT count FROM touches WHERE customer_id = $1 AND day = $2",
    [customerId, today]
  );
  const touchesToday = Number(touchRows[0]?.count || 0);

  // Total touch history across all days
  const { rows: totalTouchRows } = await query(
    "SELECT COALESCE(SUM(count), 0) as total_touches FROM touches WHERE customer_id = $1",
    [customerId]
  );
  const touchHistory = Number(totalTouchRows[0]?.total_touches || 0);

  // ── R1 (v4.2) early-stage guards: velocity 2/day governs the extra touch ──
  if (stage === "early" && touchesToday >= 2) {
    await appendActivity({
      merchant_id: MERCHANT_ID,
      actor: "RecoveryBot",
      type: "ABSTAIN",
      summary: `Early touch skipped — velocity cap (touches_today=${touchesToday})`,
      data: { cart_id: cartId, reason: "velocity_early_cap", stage, touches_today: touchesToday },
    });
    log.debug({ cartId, touchesToday }, "Early touch velocity-capped");
    return;
  }

  // ── STEP 4: MARGIN CALCULATION (from joined line items) ──
  let marginPaise: number;
  if (itemsJson.length > 0) {
    marginPaise = itemsJson.reduce(
      (sum: number, i: any) =>
        sum + (Number(i.price_paise || 0) - Number(i.cost_paise || 0)) * Number(i.qty || 1),
      0
    );
  } else {
    marginPaise = Math.floor(cartTotal * CONSTANTS.MARGIN_PERCENT);
  }
  if (!marginPaise) marginPaise = Math.floor(cartTotal * CONSTANTS.MARGIN_PERCENT);

  // T3: funnel suspension — proactive persuasion into a broken funnel stays
  // out. Transactional paths (failure retry) never check this flag.
  const { isRecoverySuspended } = await import("../lib/v5funnel.js");
  if (await isRecoverySuspended(query, MERCHANT_ID)) {
    // One SUSPENDED note per cart per hour (no feed flood during incidents).
    const { rows: recent } = await query(
      `SELECT 1 FROM activity WHERE merchant_id = $1 AND type = 'SUSPENDED'
        AND data->>'cart_id' = $2 AND ts > NOW() - INTERVAL '1 hour' LIMIT 1`,
      [MERCHANT_ID, cartId]
    ).catch(() => ({ rows: [] as any[] }));
    if (recent.length === 0) {
      await appendActivity({
        merchant_id: MERCHANT_ID,
        actor: "RecoveryBot",
        type: "SUSPENDED",
        summary: `Recovery held — funnel anomaly suspension active (cart ${cartId})`,
        data: { cart_id: cartId, reason: "funnel_anomaly_suspended" },
        severity: "warn",
      });
    }
    return;
  }

  const intent = await createIntent({
    merchantId: MERCHANT_ID,
    customerId,
    identityToken,
    actionType,
    targetId: cartId,
    marginPaise,
  });

  if (!intent.isNew) {
    await appendActivity({
      merchant_id: MERCHANT_ID,
      actor: "RecoveryBot",
      type: "DUPLICATE_SKIPPED",
      summary: `Duplicate intent for cart ${cartId} — already processed`,
      data: { cart_id: cartId, reason: "duplicate_intent" },
    });
    return;
  }

  await appendActivity({
    merchant_id: MERCHANT_ID,
    actor: "RecoveryBot",
    type: "INTENT",
    summary: `Write-ahead intent created for cart ${cartId}`,
    data: { intent_id: intent.intentId, cart_id: cartId, segment, margin_paise: marginPaise },
  });

  // ── STEP 5: EXPERIMENT ASSIGNMENT ──
  let experimentId: string | null = null;
  let arm: "treatment" | "control" = "treatment";
  const experiment = await getActiveExperiment("cart_recovery");
  if (experiment) {
    experimentId = experiment.id;
    arm = await assignToExperiment(identityToken, experimentId, {
      merchantId: cartMerchantId,
      customerId,
    });
  }

  // Control arm: plain ₹0 link, no brain needed
  if (arm === "control") {
    const policyResult = await evaluateAction("recovery_incentive", {
      amount_paise: 0,
      incentive_paise: 0,
      margin_paise: marginPaise,
      cart_total_paise: cartTotal,
      customerId,
      isRecovery: true,
      actionClass: "proactive_marketing_touch",
      customer_touches_today: touchesToday,
    });

    await appendActivity({
      merchant_id: MERCHANT_ID,
      actor: "RecoveryBot",
      type: "AGENT_THOUGHT",
      summary: `Control arm: plain ₹0 link (experiment ${experimentId})`,
      data: {
        mode: "rules",
        strategy: "send_plain_link",
        tone: "neutral",
        reasoning: "Control arm — no incentive, no brain consultation",
        experiment_id: experimentId,
        arm: "control",
        cart_id: cartId,
      },
    });

    await appendActivity({
      merchant_id: MERCHANT_ID,
      actor: "RecoveryBot",
      type: "POLICY_EVAL",
      summary: `Policy: ${policyResult.decision}`,
      data: { checks: policyResult.checks, reasons: policyResult.reasons },
    });

    await markAwaitingGateway(intent.intentId);

    const { seq, data } = await moneyBus.execute(
      "RecoveryBot",
      {
        type: "create_payment_link",
        params: { amount: cartTotal, description: `Order recovery - ${cartId}` },
      },
      policyResult,
      {
        cart_id: cartId,
        customer_id: customerId,
        segment,
        trigger: triggerLabel,
        experiment_id: experimentId,
        arm: "control",
        incentive_paise: 0,
        policy_checks: policyResult.checks,
        intent_id: intent.intentId,
        brain_mode: "rules",
        brain_reasoning: "Control arm — no incentive",
        // N1 (v4.2): control copy is fixed-neutral; the brain is never consulted.
        copy_tone: "neutral",
        message_copy: "Hi! You left something in your cart. Complete your purchase here.",
      },
      MERCHANT_ID
    );

    if (data && data.link_id) {
      await completeIntent(intent.intentId);
    }
    return;
  }

  // ── STEP 6: FEASIBLE SET (policy determines the menu) ──
  const { rows: statsRows } = await query(
    "SELECT bucket, attempts, successes FROM segment_stats WHERE merchant_id = $1 AND segment = $2",
    [MERCHANT_ID, segment]
  );

  const statsMap = new Map<number, { attempts: number; successes: number }>();
  for (const s of statsRows) {
    statsMap.set(s.bucket, { attempts: Number(s.attempts), successes: Number(s.successes) });
  }

  const thetas: Record<number, number> = {};
  const thetaEstimates: Record<string, number> = {};

  for (const bucket of BUCKETS) {
    const stats = statsMap.get(bucket) || { attempts: 0, successes: 0 };
    const theta = sampleBeta(stats.successes + 1, stats.attempts - stats.successes + 1);
    thetas[bucket] = theta;
    thetaEstimates[String(bucket)] = Math.round(theta * 100) / 100;
  }

  const theta_0 = thetas[0] || CONSTANTS.THETA_0_PRIOR;

  // Build feasible options based on consent + touch history
  const hasMarketing = await checkMarketingConsent(customerId);
  const feasibleOptions: { action: string; bucket_paise: number; ev_paise: number; theta: number }[] = [];

  if (touchHistory === 0) {
    // FIRST TOUCH: plain only, incentive NOT on the menu
    feasibleOptions.push({ action: "send_plain_link", bucket_paise: 0, ev_paise: 0, theta: theta_0 });
  } else if (!hasMarketing) {
    // No marketing consent: plain only
    feasibleOptions.push({ action: "send_plain_link", bucket_paise: 0, ev_paise: 0, theta: theta_0 });
  } else {
    // REPEAT TOUCH + marketing consent: all buckets on the menu
    for (const bucket of BUCKETS) {
      const { incEv, decision } = upliftEv({
        theta_b: thetas[bucket],
        theta_0,
        marginPaise,
        incentivePaise: bucket,
      });
      if (decision === "ACTION" || bucket === 0) {
        feasibleOptions.push({
          action: bucket > 0 ? "send_link_with_incentive" : "send_plain_link",
          bucket_paise: bucket,
          ev_paise: Math.round(incEv),
          theta: thetas[bucket],
        });
      }
    }
  }

  // D3: explicit consent clamp — EV-positive buckets exist for this repeat-touch
  // customer, but marketing opt-out forces them off the menu (plain only).
  if (touchHistory > 0 && !hasMarketing) {
    const excluded = BUCKETS.filter((b) => b > 0 && (thetas[b] ?? 0) > theta_0);
    if (excluded.length > 0) {
      await appendActivity({
        merchant_id: MERCHANT_ID,
        actor: "RecoveryBot",
        type: "CLAMPED",
        summary: `Incentive CLAMPED to plain ₹0 — consent_marketing_missing (buckets ${excluded.map((b) => formatINR(b)).join(", ")} off-menu)`,
        data: {
          reason: "consent_marketing_missing",
          excluded_buckets_paise: excluded,
          incentive_paise: 0,
        },
        severity: "warning",
      });
    }
  }

  if (feasibleOptions.length === 0) {
    await appendActivity({
      merchant_id: MERCHANT_ID,
      actor: "RecoveryBot",
      type: "ABSTAIN",
      summary: "No feasible action for this customer",
      data: { reason: "empty_feasible_set" },
    });
    await failIntent(intent.intentId, "skipped");
    return;
  }

  // ── STEP 7: UPLIFT EV TABLE ──
  const { bucket: bestBucket, decision: evDecision } = selectBucket({
    thetas,
    theta_0,
    marginPaise,
  });

  await appendActivity({
    merchant_id: MERCHANT_ID,
    actor: "RecoveryBot",
    type: "UPLIFT_DECISION",
    summary: `Feasible: ${feasibleOptions.map(o => `${formatINR(o.bucket_paise)}(EV:${o.ev_paise})`).join(", ")}`,
    data: {
      feasible: feasibleOptions,
      best: feasibleOptions.find(o => o.bucket_paise === bestBucket),
      segment,
      margin_paise: marginPaise,
      theta_0,
    },
  });

  // ── STEP 8: THE LLM BRAIN (the intelligence layer) ──
  const consentState = hasMarketing ? "marketing_opted_in" : "marketing_opted_out";

  const brainContext = buildRecoveryContext({
    customerId,
    segment,
    touchHistory,
    consentState,
    experimentArm: arm,
    cartId,
    cartItems: Array.isArray(itemsJson) ? itemsJson.map((i: any) => ({
      id: i.id || "unknown",
      name: i.name || "Product",
      price_paise: i.price_paise || i.price || 0,
    })) : [],
    feasibleOptions,
    maxIncentivePaise: config.DAILY_INCENTIVE_BUDGET_PAISE,
    marginPaise,
    thetaEstimates,
    merchantId: MERCHANT_ID,
    abandonmentCycles,
  });

  // ── M18/M21 (v5): feature-aware extension — case_type, token whitelist,
  // copy constraints, secondary-CTA availability. All pseudonymized.
  const shippingCfg = await query(
    "SELECT key, value_jsonb FROM merchant_config WHERE merchant_id = $1 AND key IN ('shipping', 'returns_policy')", [MERCHANT_ID]
  ).catch(() => ({ rows: [] as any[] }));
  const cfgByKey: Record<string, any> = {};
  for (const r of shippingCfg.rows || []) cfgByKey[r.key] = r.value_jsonb;
  const ship = cfgByKey.shipping || null;
  const shippingPaise = ship ? Number(ship.flat_fee_paise || 0) : 0;
  const shippingEta = ship?.eta_days ?? null;
  const freeThreshold = ship?.free_threshold_paise ?? null;
  const gapPaise = freeThreshold != null && cartTotal < freeThreshold ? freeThreshold - cartTotal : null;
  // T1: returns policy (trust claim — stripped when unconfigured).
  const retSummary = String(cfgByKey.returns_policy?.summary || "").slice(0, 80) || null;
  (brainContext as any).case_type = "recovery";
  (brainContext as any).copy_constraints = { max_length: 320 };
  (brainContext as any).available_tokens = [
    `all_in_total:${cartId}`,
    ...(gapPaise != null ? [`threshold_gap:${cartId}`] : []),
    `expiry:${cartId}`,
    ...(retSummary ? ["returns_policy:merchant"] : []),
    ...(shippingEta != null ? [`delivery_estimate:${cartId}`] : []),
  ];
  // Reminder choice offered from the 2nd touch on; save-for-later on the 3rd.
  (brainContext as any).allow_reminder_choice = touchHistory >= 1;
  (brainContext as any).allow_save_for_later = touchHistory >= 2;

  const brain = await callBrain("recovery", brainContext);

  // ── STEP 8b: GROUND THE COPY (N28 v4.3 — pre-send claim resolution) ──
  // Link TTL: incentivized 24h touches expire in 48h (offer truly ends T+72h);
  // everything else keeps the 24h default. The exact ISO is threaded through
  // grounding AND moneyBus so the stated deadline equals the stored one.
  const linkTtlSeconds = stage === "24h" && (brain.incentive_bucket_paise || 0) > 0 ? 48 * 3600 : 24 * 3600;
  const linkExpiryIso = new Date(Date.now() + linkTtlSeconds * 1000).toISOString();
  const rulesTemplates: Record<number, string> = {
    0: "Hi! You left something in your cart. Complete your purchase here.",
    5000: "We noticed you didn't finish — here's ₹50 off to help you decide.",
    7500: "Still thinking it over? Here's ₹75 off to make it easier.",
    10000: "Your cart is waiting! We've added ₹100 off as a thank you for your interest.",
    15000: "Great taste! We'd love to see you complete this order — here's ₹150 off.",
  };
  const groundFacts = {
    incentive_paise: brain.incentive_bucket_paise || 0,
    cart_total_paise: cartTotal,
    items: itemsJson.map((i: any) => ({ id: i.id, name: i.name, price_paise: i.price_paise })),
    link_expiry_iso: linkExpiryIso,
    // M7/M13: live shipping arithmetic — pay page and copy share these facts.
    shipping_paise: shippingPaise,
    threshold_gap_paise: gapPaise,
    // T1: trust-claim facts (null → tokens strip per I-2).
    returns_policy: retSummary ? { summary: retSummary, days: null } : null,
    shipping_eta_days: shippingEta,
  };
  const finalized = brain.mode === "llm"
    ? await finalizeCopy({
      copy: brain.message_copy,
      facts: groundFacts,
      source: "llm",
      fallbackTemplate: rulesTemplates[brain.incentive_bucket_paise || 0] || rulesTemplates[0],
      ledger: { merchantId: MERCHANT_ID, actor: "RecoveryBot", action: "create_payment_link" },
    })
    : { copy: brain.message_copy, result: { copy: brain.message_copy, resolved: [], stripped: [], allowed_numbers: [], fallback: false, violations: [] } };
  let messageCopy = finalized.copy;

  // ── STEP 9: EMIT AGENT_THOUGHT prep — incentive first (endowment needs it) ──
  const incentivePaise = brain.incentive_bucket_paise || 0;
  // M21: new brain-decision surfaces (brain chooses; code enforces availability).
  const rawOut: any = (brain as any).raw || {};
  const allowReminder = (brainContext as any).allow_reminder_choice === true;
  const allowSave = (brainContext as any).allow_save_for_later === true;
  const secondaryCta: string =
    rawOut.secondary_cta === "reminder_choice" && allowReminder ? "reminder_choice"
    : rawOut.secondary_cta === "save_for_later" && allowSave ? "save_for_later" : "none";
  const incentiveToken = rawOut.incentive_token
    ?? (incentivePaise > 0 ? { type: "cash", ref: "" } : null);

  // ── G7 (v4.3): copy-strategy — LLM picks, ε-exploration keeps arms measured ──
  const { strategy: messageStrategy, explored: strategyExplored } = chooseMessageStrategy(
    (brain.raw as any)?.message_strategy
  );

  // ── R1/G2 (v4.3) endowment frame: the early touch rides a REAL hold
  // (the live link this run creates). Grounded on DB item names.
  if (stage === "early" && itemsJson.length > 0) {
    const names = itemsJson.map((i: any) => i.name).join(", ");
    const framed = await finalizeCopy({
      copy: `We've reserved your ${names}. ${messageCopy}`,
      facts: {
        incentive_paise: incentivePaise,
        cart_total_paise: cartTotal,
        items: itemsJson.map((i: any) => ({ id: i.id, name: i.name, price_paise: i.price_paise })),
        link_expiry_iso: linkExpiryIso,
      },
      source: "code",
      fallbackTemplate: messageCopy,
      ledger: null,
    });
    messageCopy = framed.copy;
  }

  // ── STEP 9: EMIT AGENT_THOUGHT (visible in feed — mode MUST appear) ──

  await appendActivity({
    merchant_id: MERCHANT_ID,
    actor: "RecoveryBot",
    type: "AGENT_THOUGHT",
    summary: brain.mode === "llm"
      ? `Brain: ${brain.strategy} (${formatINR(incentivePaise)} incentive, ${brain.message_tone}) — ${brain.rationale.reasoning.slice(0, 120)}`
      : `Rules: ${brain.strategy} (${formatINR(incentivePaise)} incentive) — LLM unavailable`,
    data: {
      mode: brain.mode,
      strategy: brain.strategy,
      tone: brain.message_tone,
      cart_id: cartId,
      incentive_bucket_paise: incentivePaise,
      reasoning: brain.rationale.reasoning,
      evidence_ids: brain.rationale.evidence_ids,
      message_copy: messageCopy,
      claims_resolved: finalized.result.resolved,
      claims_stripped: finalized.result.stripped,
      resolved_tokens: (finalized.result.resolved || []).map((r: any) => `${r.type}:${r.ref}`),
      stripped: (finalized.result.stripped || []).map((s: any) => `${s.type}:${s.ref}`),
      message_strategy: messageStrategy,
      strategy_explored: strategyExplored,
      // M21: brain-decision surfaces on the feed's expanded row.
      // F1: fallback cause travels here too (null on the green path).
      secondary_cta: secondaryCta,
      incentive_token: incentiveToken,
      case_type: "recovery",
      fallback_reason: (brain as any).fallback_reason || null,
      // §2.4: token-syntax normalizations ledgered on the expanded row.
      normalized_token_syntax: (brain as any).normalizations || undefined,
    },
  });

  // ── STEP 10: BUILD THE PROPOSAL (code injects ALL real numbers) ──
  const actionClass = "proactive_marketing_touch";

  // ── STEP 11: BUDGET CHECK ──
  if (incentivePaise > 0) {
    const budgetResult = await reserveBudget(MERCHANT_ID, incentivePaise);
    if (!budgetResult.reserved) {
      await appendActivity({
        merchant_id: MERCHANT_ID,
        actor: "RecoveryBot",
        type: "BLOCKED",
        summary: `Budget exhausted for ${formatINR(incentivePaise)} incentive`,
        data: { checks: { budget: "BLOCK" }, reasons: ["budget_exhausted"] },
      });
      await failIntent(intent.intentId, "skipped");
      return;
    }
  }

  // ── STEP 12: QUIET HOURS (early stage defers even plain — revalidated as built) ──
  const quietHours = checkQuietHours();
  if (quietHours.deferred && (incentivePaise > 0 || stage === "early")) {
    await appendActivity({
      merchant_id: MERCHANT_ID,
      actor: "RecoveryBot",
      type: "DEFERRED",
      summary: `Quiet hours active, resume at ${quietHours.resumeAt?.toISOString()}`,
      data: { checks: { quiet_hours: "DEFERRED" }, resume_at: quietHours.resumeAt },
    });
    await deferIntent(intent.intentId, quietHours.resumeAt!);
    if (incentivePaise > 0) await releaseBudget(MERCHANT_ID, incentivePaise);
    return;
  }

  // ── STEP 13: FULL POLICY EVALUATION (the gate — runs REGARDLESS of brain mode) ──
  const consentClass = incentivePaise > 0 ? "marketing" : "transactional";

  const policyResult = await evaluateAction("recovery_incentive", {
    amount_paise: incentivePaise,
    incentive_paise: incentivePaise,
    margin_paise: marginPaise,
    cart_total_paise: cartTotal,
    customer_touches_today: touchesToday,
    customerId,
    isRecovery: true,
    actionClass,
  });

  if (incentivePaise > 0 && !hasMarketing) {
    policyResult.decision = "BLOCK";
    policyResult.reasons.push("consent_marketing_missing");
    policyResult.checks.consent_marketing = "BLOCK";
  }

  await appendActivity({
    merchant_id: MERCHANT_ID,
    actor: "RecoveryBot",
    type: "POLICY_EVAL",
    summary: `Policy: ${policyResult.decision} — ${Object.entries(policyResult.checks).map(([k, v]) => `${k}=${v}`).join(", ")}`,
    data: { checks: policyResult.checks, reasons: policyResult.reasons },
  });

  if (policyResult.decision === "BLOCK") {
    if (incentivePaise > 0) await releaseBudget(MERCHANT_ID, incentivePaise);
    await failIntent(intent.intentId, "skipped");
    return;
  }

  if (policyResult.decision === "ESCALATE") {
    if (incentivePaise > 0) await releaseBudget(MERCHANT_ID, incentivePaise);
    await failIntent(intent.intentId, "skipped");
    return;
  }

  // ── STEP 14: MONEY BUS (the only Razorpay door) ──
  await markAwaitingGateway(intent.intentId);

  const { seq, data } = await moneyBus.execute(
    "RecoveryBot",
    {
      type: "create_payment_link",
      params: {
        // Customer is charged cart total MINUS the incentive (B10 invariant)
        amount: cartTotal - incentivePaise,
        incentive_paise: incentivePaise,
        cart_total_paise: cartTotal,
        cart_id: cartId,
        // G2 (v4.3): exact expiry threaded from grounding — stated == stored.
        ttl_seconds: linkTtlSeconds,
        expire_by_iso: linkExpiryIso,
        description: `Order recovery - ${cartId}`,
      },
    },
    policyResult,
    {
      cart_id: cartId,
      customer_id: customerId,
      segment,
      trigger: triggerLabel,
      experiment_id: experimentId,
      arm,
      incentive_paise: incentivePaise,
      evidence_ids: brain.rationale.evidence_ids,
      policy_checks: policyResult.checks,
      sampled_theta: thetaEstimates,
      ev_paise: feasibleOptions.find(o => o.bucket_paise === incentivePaise)?.ev_paise || 0,
      intent_id: intent.intentId,
      brain_mode: brain.mode,
      brain_reasoning: brain.rationale.reasoning,
      brain_tone: brain.message_tone,
      message_copy: messageCopy,
      claims_resolved: finalized.result.resolved,
      claims_stripped: finalized.result.stripped,
      resolved_tokens: (finalized.result.resolved || []).map((r: any) => `${r.type}:${r.ref}`),
      message_strategy: messageStrategy,
      strategy_explored: strategyExplored,
      // M21 + M33: decision surfaces + prompt provenance on the ledger row.
      // F1: fallback cause in the rationale (null on the green path).
      secondary_cta: secondaryCta,
      incentive_token: incentiveToken,
      case_type: "recovery",
      fallback_reason: (brain as any).fallback_reason || null,
      // T4: covariate in the rationale (no learning weight yet).
      abandonment_cycles: abandonmentCycles,
      // §2.4: token-syntax normalizations on the ledger row.
      normalized_token_syntax: (brain as any).normalizations || undefined,
      prompt_version: "v5.6",
      model: getConfig().LLM_MODEL || "rules",
    },
    MERCHANT_ID
  );

  if (data && (data as any).resolved) {
    // N2 (v4.2) cancel-race: prior link turned out paid and was resolved in-bus.
    // Intent already marked done; release this run's unspent reservation.
    if (incentivePaise > 0) await releaseBudget(MERCHANT_ID, incentivePaise);
    await completeIntent(intent.intentId);
    log.info({ cartId, orderId: (data as any).order_id }, "RecoveryBot cancel-race resolved, no new link");
    return;
  }

  if (data && data.link_id) {
    await completeIntent(intent.intentId);
  } else {
    await failIntent(intent.intentId, "pending");
    if (incentivePaise > 0) await releaseBudget(MERCHANT_ID, incentivePaise);
  }

  // ── STEP 15: POST-ACTION UPDATES ──
  await query(
    `INSERT INTO touches (merchant_id, customer_id, day, count) VALUES ($1, $2, $3, 1)
     ON CONFLICT (customer_id, day) DO UPDATE SET count = touches.count + 1`,
    [cartMerchantId, customerId, today]
  );

  await anchorTransactional(customerId, cartId);

  if (identityToken) {
    // R1 (v4.2): feed the ACTUAL incentive bucket used — early plain touches
    // land on bucket 0 even when selectBucket preferred a higher one.
    await query(
      `INSERT INTO segment_stats (merchant_id, segment, bucket, attempts, successes)
       VALUES ($1, $2, $3, 1, 0)
       ON CONFLICT (merchant_id, segment, bucket)
       DO UPDATE SET attempts = segment_stats.attempts + 1`,
      [MERCHANT_ID, segment, incentivePaise]
    );
    // G7 (v4.3): the send is also a strategy attempt.
    try {
      await recordStrategyAttempt(MERCHANT_ID, segment, messageStrategy);
    } catch (stratErr: any) {
      log.warn({ error: stratErr?.message }, "Strategy attempt recording skipped (non-critical)");
    }
  }

  log.info(
    { cartId, seq, incentivePaise, brainMode: brain.mode, decision: policyResult.decision },
    "RecoveryBot processed cart"
  );
}

/**
 * G2 (v4.3) T+72h FINAL CALL — the ladder completion.
 * Announces the REAL expiry of the 24h link (stated deadline === stored
 * expire_by, enforced by U-DEADLINE). Re-uses the SAME incentive: no new
 * budget reservation, 30-day cap unaffected. If the 24h link is still live
 * it is pointed to; otherwise re-issued at the same amount via moneyBus
 * (cancel-before-create governs). Plain carts get a plain final call.
 * Gating: counts as a touch; velocity/quiet/fatigue govern; once per cart
 * lifetime (recovery_final intent); control arm gets the plain variant.
 */
export async function processFinalCall(cartId: string): Promise<void> {
  const { rows: cartRows } = await query("SELECT * FROM carts WHERE id = $1", [cartId]);
  const cart = cartRows[0];
  if (!cart || cart.status === "paid" || cart.status === "converted") {
    log.debug({ cartId }, "Final call skipped — cart gone/converted");
    return;
  }
  const customerId = cart.customer_id;
  if (!customerId) return;
  const cartTotal = Number(cart.total_paise);
  const cartMerchantId = cart.merchant_id;
  const today = new Date().toISOString().slice(0, 10);

  await appendActivity({
    merchant_id: MERCHANT_ID, actor: "RecoveryBot", type: "TRIGGER_DETECTED",
    summary: `Final-call window for cart ${cartId}`,
    amount_paise: cartTotal,
    data: { cart_id: cartId, stage: "final" },
  });

  // Once per cart lifetime.
  const { rows: priorFinal } = await query(
    `SELECT 1 FROM action_intents WHERE target_id = $1 AND action_type = 'recovery_final' LIMIT 1`,
    [cartId]
  );
  if (priorFinal.length > 0) {
    await appendActivity({
      merchant_id: MERCHANT_ID, actor: "RecoveryBot", type: "DUPLICATE_SKIPPED",
      summary: `Final call already sent for cart ${cartId}`,
      data: { cart_id: cartId, reason: "final_once_per_lifetime" },
    });
    return;
  }

  // Paid-skip (same guard as the ladder touches).
  const { rows: paidRows } = await query(
    `SELECT 1 FROM payment_links WHERE cart_id = $1 AND status = 'paid'
     UNION SELECT 1 FROM orders WHERE cart_id = $1::uuid AND status = 'paid' LIMIT 1`,
    [cartId]
  );
  if (paidRows.length > 0) return;

  // The 24h link we are completing: latest recovery link for this cart.
  const { rows: linkRows } = await query(
    `SELECT * FROM payment_links WHERE cart_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [cartId]
  );
  const prior = linkRows[0];
  if (!prior) {
    await appendActivity({
      merchant_id: MERCHANT_ID, actor: "RecoveryBot", type: "ABSTAIN",
      summary: `Final call skipped — no prior link for cart ${cartId}`,
      data: { cart_id: cartId, reason: "no_prior_link" },
    });
    return;
  }
  const incentivePaise = Number(prior.incentive_paise || 0);
  const deadlineIso = new Date(prior.expire_by).toISOString();

  const hasTransactional = await checkTransactionalConsent(customerId);
  if (!hasTransactional) return;
  const hasMarketing = await checkMarketingConsent(customerId);

  const { rows: custRows } = await query("SELECT segment, identity_hash FROM customers WHERE id = $1", [customerId]);
  const segment = custRows[0]?.segment || "default";
  const identityToken = custRows[0]?.identity_hash || customerId;
  const { rows: touchRows } = await query("SELECT count FROM touches WHERE customer_id = $1 AND day = $2", [customerId, today]);
  const touchesToday = Number(touchRows[0]?.count || 0);

  // Control arm → plain final (N1); treatment reuses the prior incentive.
  let experimentId: string | null = null;
  let finalIncentive = incentivePaise;
  const experiment = await getActiveExperiment("cart_recovery");
  if (experiment) {
    experimentId = experiment.id;
    const arm = await assignToExperiment(identityToken, experimentId, { merchantId: cartMerchantId, customerId });
    if (arm === "control") finalIncentive = 0;
  }
  if (finalIncentive > 0 && !hasMarketing) {
    await appendActivity({
      merchant_id: MERCHANT_ID, actor: "RecoveryBot", type: "ABSTAIN",
      summary: `Final call skipped — consent revoked for cart ${cartId}`,
      data: { cart_id: cartId, reason: "consent_marketing_missing" },
    });
    return;
  }

  const intent = await createIntent({
    merchantId: MERCHANT_ID, customerId, identityToken,
    actionType: "recovery_final", targetId: cartId,
  });
  if (!intent.isNew) return;

  // Full policy gate (velocity 2/day, quiet hours, caps govern the final touch).
  const policyResult = await evaluateAction("recovery_incentive", {
    amount_paise: finalIncentive,
    incentive_paise: finalIncentive,
    margin_paise: Math.floor(cartTotal * CONSTANTS.MARGIN_PERCENT),
    cart_total_paise: cartTotal,
    customer_touches_today: touchesToday,
    customerId,
    isRecovery: true,
    actionClass: "proactive_marketing_touch",
  });
  await appendActivity({
    merchant_id: MERCHANT_ID, actor: "RecoveryBot", type: "POLICY_EVAL",
    summary: `Final-call policy: ${policyResult.decision}`,
    data: { checks: policyResult.checks, reasons: policyResult.reasons, stage: "final" },
  });
  if (policyResult.decision !== "ALLOW") {
    await failIntent(intent.intentId, "skipped");
    return;
  }
  const quietHours = checkQuietHours();
  if (quietHours.deferred) {
    await appendActivity({
      merchant_id: MERCHANT_ID, actor: "RecoveryBot", type: "DEFERRED",
      summary: `Final call deferred to ${quietHours.resumeAt?.toISOString()}`,
      data: { resume_at: quietHours.resumeAt, stage: "final" },
    });
    await deferIntent(intent.intentId, quietHours.resumeAt!);
    return;
  }

  // Live prior link → point to it. Else re-issue at the same amount,
  // preserving the ORIGINAL deadline (deadline truth over link utility).
  let shortUrl: string | null = null;
  let seq: number | null = null;
  if (prior.status === "live") {
    shortUrl = prior.short_url;
    const { seq: reuseSeq } = await appendLedger({
      merchantId: MERCHANT_ID, actor: "RecoveryBot", action: "recovery_final",
      params: { cart_id: cartId, reused_link_id: prior.razorpay_link_id, incentive_paise: finalIncentive },
      decision: "ALLOW", policy_checks: policyResult.checks,
      rationale: { reason: "final_call_reuse_live_link", expiry_iso: deadlineIso },
      outcome: "SUCCESS",
    });
    seq = reuseSeq;
  } else {
    await markAwaitingGateway(intent.intentId);
    try {
      const result = await moneyBus.execute(
        "RecoveryBot",
        {
          type: "create_payment_link",
          params: {
            amount: cartTotal - finalIncentive,
            incentive_paise: finalIncentive,
            cart_total_paise: cartTotal,
            cart_id: cartId,
            // Preserve the original deadline — the announced expiry never moves.
            expire_by_iso: deadlineIso,
            description: `Final call - ${cartId}`,
          },
        },
        policyResult,
        {
          cart_id: cartId, customer_id: customerId, segment, trigger: "cart_abandoned_72h_final",
          experiment_id: experimentId, incentive_paise: finalIncentive,
          policy_checks: policyResult.checks, intent_id: intent.intentId,
          brain_mode: "rules", brain_reasoning: "Final call — fixed play, deadline truth",
          final_reissue_of: prior.razorpay_link_id,
        },
        MERCHANT_ID
      );
      // NOTE: no budget reservation on the final touch — the incentive was
      // already accounted at the 24h touch; re-issue must not double-spend it.
      seq = result.seq;
      shortUrl = result.data?.short_url || null;
      if (result.data?.link_id) {
        await completeIntent(intent.intentId);
        await query(
          `INSERT INTO segment_stats (merchant_id, segment, bucket, attempts, successes)
           VALUES ($1, $2, $3, 1, 0)
           ON CONFLICT (merchant_id, segment, bucket)
           DO UPDATE SET attempts = segment_stats.attempts + 1`,
          [MERCHANT_ID, segment, finalIncentive]
        );
      } else {
        await failIntent(intent.intentId, "pending");
        return;
      }
    } catch (err: any) {
      await failIntent(intent.intentId, "pending");
      throw err;
    }
  }

  // Code-built final copy over the REAL deadline, verified by the resolver.
  const exp = renderExpiryParts(deadlineIso);
  const amountTxt = finalIncentive > 0 ? `Your ${formatINR(finalIncentive)} reservation releases ${exp.phrase}` : `Your cart is still reserved — it releases ${exp.phrase}`;
  const rawCopy = `${amountTxt}. This is the final call.${shortUrl ? ` ${shortUrl}` : ""}`;
  const grounded = await finalizeCopy({
    copy: rawCopy,
    facts: {
      incentive_paise: finalIncentive,
      cart_total_paise: cartTotal,
      link_expiry_iso: deadlineIso,
    },
    source: "code",
    fallbackTemplate: "This is the final call on your reserved cart.",
    ledger: { merchantId: MERCHANT_ID, actor: "RecoveryBot", action: "recovery_final" },
  });

  await appendActivity({
    merchant_id: MERCHANT_ID, actor: "RecoveryBot", type: "AGENT_THOUGHT",
    summary: `Final call (${shortUrl ? "reused link" : "re-issued"}) — deadline ${deadlineIso}`,
    data: {
      mode: "rules", strategy: "send_final_call", tone: "neutral",
      incentive_bucket_paise: finalIncentive,
      reasoning: "Fixed ladder play: announce the enforced expiry, reuse the same incentive",
      message_copy: grounded.copy,
      stated_deadline_iso: deadlineIso,
      claims_resolved: grounded.result.resolved,
      claims_stripped: grounded.result.stripped,
    },
  });

  await query(
    `INSERT INTO touches (merchant_id, customer_id, day, count) VALUES ($1, $2, $3, 1)
     ON CONFLICT (customer_id, day) DO UPDATE SET count = touches.count + 1`,
    [cartMerchantId, customerId, today]
  );
  await completeIntent(intent.intentId);
  log.info({ cartId, seq, finalIncentive }, "RecoveryBot final call sent");
}

/** IST clock parts for deadline phrasing ("tonight at 9 PM" / "12 Jun at 9 PM"). */
function renderExpiryParts(iso: string): { phrase: string; hour12: number; hour24: number; day: number } {
  const d = new Date(iso);
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const hour24 = ist.getUTCHours();
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const suffix = hour24 < 12 ? "AM" : "PM";
  const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const sameDay = ist.toISOString().slice(0, 10) === nowIst.toISOString().slice(0, 10);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const phrase = sameDay
    ? `tonight at ${hour12} ${suffix}`
    : `${ist.getUTCDate()} ${months[ist.getUTCMonth()]} at ${hour12} ${suffix}`;
  return { phrase, hour12, hour24, day: ist.getUTCDate() };
}
