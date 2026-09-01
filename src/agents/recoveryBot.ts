import { query } from "../db.js";
import { callLLM, parseLLMJson } from "../lib/llm.js";
import { evaluateAction } from "../lib/policyEngine.js";
import * as moneyBus from "../lib/moneyBus.js";
import { pseudonymize } from "../lib/pseudonymize.js";
import { createIntent, completeIntent, failIntent, markAwaitingGateway } from "../lib/intentExecutor.js";
import { assignToExperiment, getActiveExperiment } from "../lib/experiment.js";
import { RecoveryProposalSchema, RECOVERY_SYSTEM_PROMPT } from "./sharedBrain.js";
import { getConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { checkTransactionalConsent } from "../lib/consent.js";
import { upliftEv, selectBucket, CONSTANTS } from "../lib/economics.js";
import { reserveBudget, releaseBudget, realizeBudget } from "../lib/budget.js";
import { anchorTransactional } from "../lib/consent.js";

const log = createLogger("RecoveryBot");

// Thompson sampling buckets: 0, 50, 100, 150 rupees (in paise)
const BUCKETS = [0, 5000, 10000, 15000];

function sampleBeta(alpha: number, beta: number): number {
  const mean = alpha / (alpha + beta);
  return mean + (Math.random() - 0.5) * 0.1;
}

export async function processAbandonedCart(cartId: string): Promise<void> {
  const config = getConfig();

  // Fetch cart and customer data
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

  // V1: Anonymous carts are never touchable (no anchor, no contact => no action)
  if (!customerId) {
    log.debug({ cartId }, "Anonymous cart, skipping (V1)");
    await appendAuditSkip(cartId, "anonymous_cart");
    return;
  }

  // V3: Check transactional consent before any touch
  const hasTransactional = await checkTransactionalConsent(customerId);
  if (!hasTransactional) {
    log.debug({ cartId, customerId }, "No transactional consent, skipping");
    await appendAuditSkip(cartId, "no_transactional_consent");
    return;
  }

  // W5: Get identity token for assignment
  const { rows: custRows } = await query(
    "SELECT segment, identity_token FROM customers WHERE id = $1",
    [customerId]
  );
  const segment = custRows[0]?.segment || "default";
  const identityToken = custRows[0]?.identityToken || customerId;

  // Check touch frequency
  const today = new Date().toISOString().slice(0, 10);
  const { rows: touchRows } = await query(
    "SELECT count FROM touches WHERE customer_id = $1 AND day = $2",
    [customerId, today]
  );
  const touchesToday = touchRows[0]?.count || 0;

  // W5: Compute margin from catalog
  const { rows: marginRows } = await query(
    `SELECT SUM((p.price_paise - p.cost_paise) * ci.qty) as margin_paise
     FROM cart_items ci
     JOIN products p ON p.id = ci.product_id
     WHERE ci.cart_id = $1`,
    [cartId]
  );
  const marginPaise = Number(marginRows[0]?.margin_paise || Math.floor(cartTotal * CONSTANTS.MARGIN_PERCENT));

  // W2: Write-ahead intent with identity token and target_id
  const intent = await createIntent({
    merchantId: cart.merchant_id,
    customerId,
    identityToken,
    actionType: 'recovery_link',
    targetId: cartId,
    marginPaise,
  });

  if (!intent.isNew) {
    log.info({ cartId, intentId: intent.intentId }, "Duplicate intent, skipping");
    return;
  }

  // Experiment assignment (W6: HMAC-based)
  let experimentId: string | null = null;
  let arm: 'treatment' | 'control' = 'treatment';
  const experiment = await getActiveExperiment('cart_recovery');
  if (experiment) {
    experimentId = experiment.id;
    arm = await assignToExperiment(identityToken, experimentId);

    // Control arm: plain link, Rs.0 incentive, neutral copy
    if (arm === 'control') {
      const policyResult = await evaluateAction("recovery_incentive", {
        amount_paise: 0,
        incentive_paise: 0,
        margin_paise: 0,
        cart_total_paise: cartTotal,
        customerId,
        isRecovery: true,
        actionClass: "proactive_marketing_touch",
      });

      // W2: Mark as awaiting_gateway
      await markAwaitingGateway(intent.intentId);

      const { seq, result } = await moneyBus.execute(
        "RecoveryBot",
        {
          type: "create_payment_link",
          params: {
            amount: cartTotal,
            reference_id: "",
            notes: { cart_id: cartId, experiment_id: experimentId, arm: 'control' },
          },
        },
        policyResult,
        {
          trigger: "cart_abandoned_24h",
          segment,
          experiment_id: experimentId,
          arm: 'control',
          incentive_paise: 0,
          evidence_ids: [cartId],
        }
      );

      if (result && (result as any).id) {
        await completeIntent(intent.intentId, seq);
      }
      return;
    }
  }

  // Thompson sampling
  const { rows: statsRows } = await query(
    "SELECT bucket, attempts, successes FROM segment_stats WHERE merchant_id = $1 AND segment = $2",
    [cart.merchant_id, segment]
  );

  const statsMap = new Map<number, { attempts: number; successes: number }>();
  for (const s of statsRows) {
    statsMap.set(s.bucket, { attempts: s.attempts, successes: s.successes });
  }

  const sampledTheta: Record<string, number> = {};
  const thetas: Record<number, number> = {};

  for (const bucket of BUCKETS) {
    const stats = statsMap.get(bucket) || { attempts: 0, successes: 0 };
    const alpha = stats.successes + 1;
    const beta = stats.attempts - stats.successes + 1;
    const theta = sampleBeta(alpha, beta);
    sampledTheta[String(bucket / 100)] = Math.round(theta * 100) / 100;
    thetas[bucket] = theta;
  }

  // W1: Uplift-aware EV bucket selection
  const theta_0 = thetas[0] || CONSTANTS.THETA_0_PRIOR;
  const { bucket: bestBucket, decision } = selectBucket({
    thetas,
    theta_0,
    marginPaise,
  });

  // W1: Handle decisions
  if (decision === "ABSTAIN") {
    const seq = await appendAuditSkip(cartId, "ev_negative", {
      best_ev_paise: 0,
      reason: "all_options_ev_negative",
      sampled_theta: sampledTheta,
    });
    await failIntent(intent.intentId, 'skipped');
    log.info({ cartId }, "RecoveryBot abstained: EV negative");
    return;
  }

  const incentivePaise = decision === "PLAIN" ? 0 : bestBucket;
  const customerRef = pseudonymize(customerId);

  // V11: Reserve budget before executing
  const budgetResult = await reserveBudget(cart.merchant_id, incentivePaise);
  if (!budgetResult.reserved) {
    const seq = await appendAuditSkip(cartId, "budget_exhausted");
    await failIntent(intent.intentId, 'skipped');
    log.info({ cartId }, "RecoveryBot skipped: budget exhausted");
    return;
  }

  // Policy evaluation with W4 action class
  const policyResult = await evaluateAction("recovery_incentive", {
    amount_paise: incentivePaise,
    incentive_paise: incentivePaise,
    margin_paise: marginPaise,
    cart_total_paise: cartTotal,
    customer_touches_today: touchesToday,
    customerId,
    isRecovery: true,
    actionClass: "proactive_marketing_touch",
  });

  // If policy blocks, release budget
  if (policyResult.decision === "BLOCK") {
    await releaseBudget(cart.merchant_id, incentivePaise);
    await failIntent(intent.intentId, 'skipped');
    log.info({ cartId, checks: policyResult.checks }, "RecoveryBot blocked by policy");
    return;
  }

  const rationale = {
    trigger: "cart_abandoned_24h",
    segment,
    customer_ref: customerRef,
    recovery_score: sampledTheta[String(bestBucket / 100)],
    sampled_theta: sampledTheta,
    chosen_bucket_paise: bestBucket / 100,
    ev_paise: 0,
    evidence_ids: [cartId, customerRef],
    experiment_id: experimentId,
    arm: 'treatment',
    decision, // W1: ACTION or PLAIN
  };

  // W2: Mark as awaiting_gateway
  await markAwaitingGateway(intent.intentId);

  // Execute through money bus
  const { seq, result } = await moneyBus.execute(
    "RecoveryBot",
    {
      type: "create_payment_link",
      params: {
        amount: cartTotal,
        reference_id: "",
        customer: customerId
          ? { name: "placeholder", email: "placeholder", contact: "placeholder" }
          : undefined,
        notes: { cart_id: cartId },
      },
    },
    policyResult,
    rationale
  );

  // Update reference_id with audit seq
  if (result && (result as any).id) {
    await query(
      "UPDATE audit_log SET outcome_detail_json = outcome_detail_json || $1 WHERE seq = $2",
      [JSON.stringify({ reference_id: String(seq) }), seq]
    );
    await completeIntent(intent.intentId, seq);
    await realizeBudget(cart.merchant_id, incentivePaise); // V11: realize on success
  } else {
    await failIntent(intent.intentId, 'pending');
    await releaseBudget(cart.merchant_id, incentivePaise); // V11: release on failure
  }

  // Record touch
  await query(
    `INSERT INTO touches (customer_id, day, count) VALUES ($1, $2, 1)
     ON CONFLICT (customer_id, day) DO UPDATE SET count = touches.count + 1`,
    [customerId, today]
  );

  // V3: Anchor transactional consent
  await anchorTransactional(customerId, cartId);

  // Update segment stats (only for identity-bound customers)
  if (identityToken) {
    await query(
      `INSERT INTO segment_stats (merchant_id, segment, bucket, attempts, successes)
       VALUES ($1, $2, $3, 1, 0)
       ON CONFLICT (merchant_id, segment, bucket)
       DO UPDATE SET attempts = segment_stats.attempts + 1`,
      [cart.merchant_id, segment, bestBucket]
    );
  }

  log.info({ cartId, seq, incentivePaise, decision: policyResult.decision }, "RecoveryBot processed cart");
}

/**
 * Append a skip/abstain entry to the audit log.
 */
async function appendAuditSkip(
  cartId: string,
  reason: string,
  extra?: Record<string, unknown>
): Promise<number> {
  const { appendAudit } = await import("../lib/auditLedger.js");
  return appendAudit({
    actor: 'RecoveryBot',
    action: 'skip_cart',
    params_json: { cartId, reason, ...extra },
    decision: reason === 'ev_negative' ? 'ABSTAIN' : 'BLOCK',
    policy_checks_json: { skip_reason: reason },
    rationale_json: { cartId, reason, ...extra },
    outcome: reason === 'ev_negative' ? 'ABSTAIN' : 'SKIPPED',
  });
}
