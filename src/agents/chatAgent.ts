import { query } from "../db.js";
import { evaluateAction } from "../lib/policyEngine.js";
import * as moneyBus from "../lib/moneyBus.js";
import { appendActivity } from "../lib/activity.js";
import { callBrain, buildChatContext, isCircuitOpen } from "../lib/sharedBrain.js";
import { evaluateChatGrant, recordChatAttempt, CHAT_MIN_CART_PAISE } from "../lib/chatEconomics.js";
import {
  loadSession, meterTurn, tokensToCostPaise, classifyFaq, answerFaq,
  CHAT_MAX_TURNS, CHAT_LLM_BUDGET_PAISE, CHAT_LOCKOUT_COPY,
} from "../lib/chatSession.js";
import { appendLedger } from "../lib/ledger.js";
import { finalizeCopy } from "../lib/claims.js";
import { createLogger } from "../logger.js";

const log = createLogger("ChatAgent");
const MERCHANT_ID = "5a3ac6ce-b2c7-4b1f-a9db-45296841f30b";

export async function handleChatMessage(
  seq: string,
  message: string,
  sessionToken: string
): Promise<{ response: string; action?: string }> {
  // Validate session token
  const { rows: auditRows } = await query(
    "SELECT * FROM audit_log WHERE seq = $1",
    [seq]
  );
  if (!auditRows[0]) {
    return { response: "Invalid offer reference." };
  }

  const auditRow = auditRows[0];
  // New-shape rows carry params_json; legacy short-column rows carry params
  const params = auditRow.params_json || auditRow.params || {};
  // Links written before cart_id entered ledger params: resolve via payment_links
  if (!params.cart_id) {
    try {
      const { rows: linkRows } = await query(
        "SELECT cart_id FROM payment_links WHERE audit_seq = $1 LIMIT 1",
        [parseInt(seq)]
      );
      if (linkRows[0]?.cart_id) params.cart_id = linkRows[0].cart_id;
    } catch { /* best effort */ }
  }

  // Get context (cart lookup is best-effort: ledger params may not carry cart_id)
  let cart: any = null;
  if (params.cart_id) {
    try {
      const { rows: cartRows } = await query("SELECT * FROM carts WHERE id = $1", [params.cart_id]);
      cart = cartRows[0] || null;
    } catch {
      cart = null;
    }
  }
  const marginPaise = cart ? Math.floor(Number(cart.total_paise) * 0.4) : 0;

  // ── THE LLM BRAIN ──
  // Load line items so the brain answers from DB facts (never invents the cart)
  let chatItems: { id: string; name: string; price_paise: number }[] = [];
  if (params.cart_id) {
    try {
      const { rows: lineRows } = await query(
        `SELECT ci.product_id AS id, p.name, COALESCE(p.price_paise, ci.unit_price_paise) AS price_paise
         FROM cart_items ci LEFT JOIN products p ON p.id = ci.product_id
         WHERE ci.cart_id = $1`,
        [params.cart_id]
      );
      chatItems = lineRows.map((r: any) => ({
        id: r.id, name: r.name || "Product", price_paise: Number(r.price_paise || 0),
      }));
    } catch { chatItems = []; }
  }
  // ── N5 (v4.2): session + cost gates BEFORE any LLM spend ──
  const session = await loadSession(sessionToken, MERCHANT_ID);
  if (session.turn_count >= CHAT_MAX_TURNS || session.llm_cost_paise >= CHAT_LLM_BUDGET_PAISE) {
    await meterTurn(MERCHANT_ID, sessionToken, "refused", 0, 0);
    await appendActivity({
      merchant_id: MERCHANT_ID, actor: "ChatAgent", type: "POLICY_EVAL",
      summary: `Chat locked out — ${session.turn_count >= CHAT_MAX_TURNS ? "turn cap" : "LLM budget"} reached`,
      data: { reason: "chat_session_limit", turns: session.turn_count, llm_cost_paise: session.llm_cost_paise },
    });
    return { response: CHAT_LOCKOUT_COPY };
  }

  // ── N5 FAQ path: DB facts, zero LLM call, intent-keyed cache ──
  const faqIntent = classifyFaq(message);
  if (faqIntent) {
    let faqItems = chatItems.map((i) => ({ ...i, stock: null as number | null }));
    if (faqIntent === "stock" && chatItems.length > 0) {
      try {
        const { rows: stockRows } = await query(
          `SELECT id, stock FROM products WHERE id = ANY($1::uuid[])`,
          [chatItems.map((i) => i.id)]
        );
        const stockMap = new Map(stockRows.map((r: any) => [r.id, r.stock]));
        faqItems = chatItems.map((i) => ({ ...i, stock: stockMap.has(i.id) ? Number(stockMap.get(i.id)) : null }));
      } catch { /* stock unknown → generic wording */ }
    }
    const { answer, cached } = answerFaq(sessionToken, faqIntent, {
      items: faqItems,
      amount_paise: Number(params.amount_paise || 0),
      incentive_paise: Number(params.incentive_paise || 0),
      expiryIso: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    await meterTurn(MERCHANT_ID, sessionToken, "faq", 0, 0);
    await appendActivity({
      merchant_id: MERCHANT_ID, actor: "ChatAgent", type: "CHAT_FAQ",
      summary: `FAQ answered from DB facts (${faqIntent}${cached ? ", cached" : ""}) — zero LLM tokens`,
      data: { mode: "faq", intent: faqIntent, cached },
    });
    return { response: answer };
  }

  const brainContext = buildChatContext({
    token: sessionToken,
    currentOffer: {
      amount_paise: params.amount_paise || 0,
      incentive_paise: params.incentive_paise || 0,
      expiry: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
    customerMessage: message,
    policyNumbers: {
      maxDiscountPaise: 15000,
      marginPaise: marginPaise,
    },
    cartItems: chatItems,
  });

  const brain = await callBrain("chat", brainContext);

  // ── N5 metering: every LLM (or rules) turn is billed to the session ──
  const billedTokens = brain.usage?.total_tokens ?? 0;
  await meterTurn(
    MERCHANT_ID, sessionToken,
    brain.mode === "llm" ? "llm" : "rules",
    billedTokens, tokensToCostPaise(billedTokens)
  );

  const tool = brain.raw?.tool || "explain_offer";
  const toolParams = brain.raw?.params || {};

  // ── EMIT AGENT_THOUGHT ──
  await appendActivity({
    merchant_id: MERCHANT_ID,
    actor: "ChatAgent",
    type: "AGENT_THOUGHT",
    summary: brain.mode === "llm"
      ? `Brain: tool=${tool} — ${brain.rationale.reasoning.slice(0, 100)}`
      : `Rules: tool=${tool} — LLM unavailable`,
    data: {
      mode: brain.mode,
      tool,
      params: toolParams,
      reasoning: brain.rationale.reasoning,
      message_copy: brain.message_copy,
    },
  });

  // ── N1 (v4.2): request_discount hard-refuses for control-arm sessions ──
  // Belt-and-suspenders behind the server-side widget gate in routes/chat.ts.
  if (tool === "request_discount" && toolParams.amount_paise) {
    try {
      let armCustomerId: string | null = null;
      if (cart?.customer_id) {
        armCustomerId = cart.customer_id;
      } else if (params.cart_id) {
        const { rows: cartRows } = await query("SELECT customer_id FROM carts WHERE id = $1", [params.cart_id]);
        armCustomerId = cartRows[0]?.customer_id || null;
      }
      if (armCustomerId) {
        const { getCustomerArm } = await import("../lib/experiment.js");
        const armInfo = await getCustomerArm(armCustomerId);
        if (armInfo && armInfo.arm === "control") {
          await appendActivity({
            merchant_id: MERCHANT_ID, actor: "ChatAgent", type: "POLICY_EVAL",
            summary: `Discount request refused — control arm (experiment ${armInfo.experimentId.slice(0, 8)})`,
            data: { reason: "control_arm", experiment_id: armInfo.experimentId, requested_paise: toolParams.amount_paise },
            severity: "warning",
          });
          return { response: "That offer isn't eligible for additional discounts. The price shown is the final price for this order." };
        }
      }
    } catch { /* fail open: fall through to normal policy evaluation */ }

    // ── N4 (v4.2): measured-economics grant gate BEFORE policy ──
    const cartTotalPaise = cart ? Number(cart.total_paise) : 0;
    const grantRefusal = async (reason: string, extra: Record<string, unknown> = {}) => {
      await appendLedger({
        merchantId: MERCHANT_ID,
        actor: "ChatAgent",
        action: "chat_discount_request",
        params: { requested_paise: toolParams.amount_paise, cart_total_paise: cartTotalPaise },
        decision: "BLOCK",
        policy_checks: { chat_grant: "REFUSED" },
        rationale: { reason, ...extra },
        outcome: "SKIPPED",
      });
      await appendActivity({
        merchant_id: MERCHANT_ID, actor: "ChatAgent", type: "POLICY_EVAL",
        summary: `Chat discount refused — ${reason}`,
        data: { reason, requested_paise: toolParams.amount_paise, ...extra },
      });
    };
    if (cartTotalPaise < CHAT_MIN_CART_PAISE) {
      await grantRefusal("chat_below_minimum", { cart_total_paise: cartTotalPaise });
      return { response: "Discounts apply to orders of ₹1,000 and above — your current cart doesn't qualify, but the link still holds your items." };
    }
    if (isCircuitOpen()) {
      await grantRefusal("chat_circuit_open", {});
      return { response: "I'm running in a limited mode right now, so I can't adjust prices — the current offer stands as shown." };
    }
    const grant = await evaluateChatGrant({
      merchantId: MERCHANT_ID,
      requestedPaise: Number(toolParams.amount_paise),
      cartTotalPaise,
      marginPaise,
    });
    if (!grant.granted) {
      await grantRefusal(grant.reason, {
        bucket_paise: grant.bucket, theta: grant.theta, theta_0: grant.theta0, ev_paise: grant.evPaise,
      });
      return { response: "I can't offer an additional discount on this order — but your current link is still live and holds your items." };
    }
    await recordChatAttempt(MERCHANT_ID, grant.bucket);

    // POLICY ENGINE — same as RecoveryBot, no chat bypass
    const policyResult = await evaluateAction("chat_discount_request", {
      amount_paise: toolParams.amount_paise,
      incentive_paise: toolParams.amount_paise,
      margin_paise: marginPaise,
      cart_total_paise: cart ? Number(cart.total_paise) : 0,
    });

    if (policyResult.decision === "BLOCK") {
      return { response: "I can't go below the current offer, but here's what I CAN do — would you like a longer payment window instead?" };
    }

      if (policyResult.decision === "ESCALATE") {
        await query(
          `INSERT INTO approvals (merchant_id, audit_seq, context, status) VALUES ($1, $2, $3, 'pending')`,
          [MERCHANT_ID, parseInt(seq), JSON.stringify({ action: "discount_request", params: toolParams })]
        );
        return { response: "Let me check with the store manager for you — I'll have an answer shortly." };
      }

    // ALLOW: create new discounted link
    const newAmount = Number(params.amount_paise) - toolParams.amount_paise;
    try {
      const grounded = brain.mode === "llm"
        ? await finalizeCopy({
          copy: brain.message_copy,
          facts: {
            incentive_paise: Number(toolParams.amount_paise),
            cart_total_paise: Number(params.amount_paise),
            items: chatItems,
          },
          source: "llm",
          fallbackTemplate: "Done — your new link reflects the discount.",
          ledger: { merchantId: MERCHANT_ID, actor: "ChatAgent", action: "create_payment_link" },
        })
        : { copy: brain.message_copy };
      const { seq: newSeq } = await moneyBus.execute(
        "ChatAgent",
        {
          type: "create_payment_link",
          params: { amount: newAmount, notes: { parent_seq: seq } },
        },
        policyResult,
        {
          trigger: "chat_discount",
          parent_seq: seq,
          discount_paise: toolParams.amount_paise,
          brain_mode: brain.mode,
          brain_reasoning: brain.rationale.reasoning,
          message_copy: grounded.copy,
        },
        MERCHANT_ID
      );
      return { response: grounded.copy, action: `discount_applied_${newSeq}` };
    } catch (err: any) {
      log.error({ seq, error: err.message }, "ChatAgent link creation failed");
      return { response: "I'm having trouble creating the link. Please try again." };
    }
  }

  // explain_offer / explain_policy — ground the brain's copy, then return it
  if (brain.mode === "llm") {
    const grounded = await finalizeCopy({
      copy: brain.message_copy,
      facts: {
        incentive_paise: Number(params.incentive_paise || 0),
        cart_total_paise: Number(params.amount_paise || 0),
        items: chatItems,
      },
      source: "llm",
      fallbackTemplate: "Thanks for asking — the price and terms shown on this page are current.",
      ledger: { merchantId: MERCHANT_ID, actor: "ChatAgent", action: "chat_explain" },
    });
    return { response: grounded.copy };
  }
  return { response: brain.message_copy };
}
