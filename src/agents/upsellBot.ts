import { query } from "../db.js";
import { evaluateAction } from "../lib/policyEngine.js";
import * as moneyBus from "../lib/moneyBus.js";
import { createLogger } from "../logger.js";

const log = createLogger("UpsellBot");

export async function processUpsell(orderId: string): Promise<void> {
  // Fetch completed order
  const { rows: orderRows } = await query(
    "SELECT * FROM orders WHERE id = $1 AND status = 'paid'",
    [orderId]
  );
  if (!orderRows[0]) {
    log.debug({ orderId }, "Order not found or not paid");
    return;
  }

  const order = orderRows[0];

  // Get catalog for cross-sell suggestions
  const { rows: products } = await query(
    "SELECT id, name, price_paise, cost_paise FROM products WHERE merchant_id = $1 AND active = true AND stock > 0",
    [order.merchant_id]
  );

  if (products.length === 0) return;

  // Simple upsell: suggest a product with discount
  // In production, this would use LLM for better recommendations
  const suggestedProduct = products[0];
  const discountPercent = 15; // Conservative default
  const discountPaise = Math.floor(Number(suggestedProduct.price_paise) * discountPercent / 100);

  const policyResult = await evaluateAction("upsell_discount", {
    amount_paise: discountPaise,
    margin_paise: Number(suggestedProduct.price_paise) - Number(suggestedProduct.cost_paise),
  });

  if (policyResult.decision === "BLOCK") {
    log.info({ orderId, productId: suggestedProduct.id }, "Upsell BLOCKED by policy");
    return;
  }

  if (policyResult.decision === "ESCALATE") {
    log.info({ orderId, productId: suggestedProduct.id }, "Upsell ESCALATED for approval");
    return;
  }

  // Execute upsell link creation
  const rationale = {
    trigger: "post_payment_upsell",
    product_ref: suggestedProduct.id,
    attach_rate: 0.15,
    evidence_ids: [orderId, suggestedProduct.id],
  };

  const { seq } = await moneyBus.execute(
    "UpsellBot",
    {
      type: "create_payment_link",
      params: {
        amount: Number(suggestedProduct.price_paise) - discountPaise,
        notes: { order_id: orderId, upsell: "true" },
      },
    },
    policyResult,
    rationale
  );

  log.info({ orderId, seq, discount: discountPaise }, "UpsellBot created link");
}
