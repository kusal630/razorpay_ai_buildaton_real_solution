import { query } from "../db.js";
import { callLLM, parseLLMJson } from "../lib/llm.js";
import { evaluateAction } from "../lib/policyEngine.js";
import * as moneyBus from "../lib/moneyBus.js";
import { ChatActionSchema, CHAT_SYSTEM_PROMPT } from "./sharedBrain.js";
import { createLogger } from "../logger.js";

const log = createLogger("ChatAgent");

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
  const params = auditRow.params_json;

  // Get context
  const { rows: cartRows } = await query(
    "SELECT * FROM carts WHERE id = $1",
    [params.cart_id || ""]
  );
  const cart = cartRows[0];

  // Build LLM context (pseudonymized, no PII)
  const context = `
Current offer:
- Amount: ${params.amount_paise || 0} paise
- Incentive: ${params.incentive_paise || 0} paise
- Cart total: ${cart?.total_paise || 0} paise
- Segment: ${cart?.status || "unknown"}

Customer message: ${message}

You may:
1. Explain the offer (explain)
2. Request a discount via request_discount tool (max 15000 paise)
3. Refuse if policy doesn't allow (refuse)

Respond with JSON: {"action": "explain|request_discount|refuse", "amount_paise": <number if request_discount>, "message": "<your response>"}
`;

  try {
    const llmResponse = await callLLM([
      { role: "system", content: CHAT_SYSTEM_PROMPT },
      { role: "user", content: context },
    ]);

    const parsed = parseLLMJson(llmResponse.content, ChatActionSchema);

    if (parsed.action === "request_discount" && parsed.amount_paise) {
      // Policy check for discount
      const marginPaise = cart ? Math.floor(Number(cart.total_paise) * 0.4) : 0;
      const policyResult = await evaluateAction("chat_discount_request", {
        amount_paise: parsed.amount_paise,
        incentive_paise: parsed.amount_paise,
        margin_paise: marginPaise,
        cart_total_paise: cart ? Number(cart.total_paise) : 0,
      });

      if (policyResult.decision === "BLOCK") {
        return { response: "I'm sorry, that discount isn't within our policy limits." };
      }

      if (policyResult.decision === "ESCALATE") {
        await query(
          `INSERT INTO approvals (merchant_id, audit_seq, context_json) VALUES ($1, $2, $3)`,
          ["00000000-0000-0000-0000-000000000001", parseInt(seq), JSON.stringify({ action: parsed })]
        );
        return { response: "A human will review your discount request shortly." };
      }

      // Create new discounted link
      const newAmount = Number(params.amount_paise) - parsed.amount_paise;
      const { seq: newSeq } = await moneyBus.execute(
        "ChatAgent",
        {
          type: "create_payment_link",
          params: { amount: newAmount, notes: { parent_seq: seq } },
        },
        policyResult,
        { trigger: "chat_discount", parent_seq: seq, discount_paise: parsed.amount_paise }
      );

      return { response: parsed.message, action: `discount_applied_${newSeq}` };
    }

    return { response: parsed.message };
  } catch (err: any) {
    log.error({ seq, error: err.message }, "ChatAgent LLM error");
    return { response: "I'm having trouble processing your request. Please try again." };
  }
}
