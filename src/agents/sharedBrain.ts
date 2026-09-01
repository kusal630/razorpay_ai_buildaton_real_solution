import { z } from "zod";

export const RecoveryProposalSchema = z.object({
  strategy: z.enum(["no_incentive", "small_incentive", "medium_incentive", "large_incentive"]),
  incentive_paise: z.number().min(0).max(50000),
  item_ids: z.array(z.string()),
  rationale: z.object({
    trigger: z.string(),
    segment: z.string(),
    customer_ref: z.string(),
    recovery_score: z.number().min(0).max(1),
    sampled_theta: z.record(z.string(), z.number()),
    chosen_bucket_paise: z.number(),
    ev_paise: z.number(),
    evidence_ids: z.array(z.string()),
  }),
});

export const UpsellProposalSchema = z.object({
  strategy: z.enum(["no_upsell", "cross_sell", "bundle_discount"]),
  discount_paise: z.number().min(0),
  item_ids: z.array(z.string()),
  rationale: z.object({
    trigger: z.string(),
    product_ref: z.string(),
    attach_rate: z.number().min(0).max(1),
    evidence_ids: z.array(z.string()),
  }),
});

export const ChatActionSchema = z.object({
  action: z.enum(["explain", "request_discount", "refuse"]),
  amount_paise: z.number().optional(),
  message: z.string(),
});

export const RECOVERY_SYSTEM_PROMPT = `You are RecoveryBot, an AI agent that helps recover abandoned shopping carts.

RULES:
1. You can only choose incentive amounts from the provided buckets
2. You must provide a structured JSON response
3. Never generate prices or amounts outside the given buckets
4. Base your decision on the cart total, segment, and recovery score
5. Always include evidence_ids for audit trail

Response format: JSON matching the RecoveryProposal schema`;

export const UPSELL_SYSTEM_PROMPT = `You are UpsellBot, an AI agent that suggests cross-sells after payment.

RULES:
1. Discounts must be within policy limits
2. Only suggest products from the catalog
3. Never generate prices yourself
4. Include product references and attach rate rationale

Response format: JSON matching the UpsellProposal schema`;

export const CHAT_SYSTEM_PROMPT = `You are ChatAgent, a conversational shopping assistant.

You help customers understand offers, policies, and products.
You can request a discount via the request_discount tool.
Never generate prices - use the provided amounts only.
Be helpful but bounded by policy.`;
