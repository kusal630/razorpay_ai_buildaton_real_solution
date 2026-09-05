/**
 * messageStream.ts — outbound MESSAGE_SENT console stream (observability).
 *
 * Every customer-facing send emits ONE activity row of type MESSAGE_SENT
 * carrying the FINAL resolved copy (post token-grounding — what the
 * customer actually sees), the strategy/tone badges, brain_mode, and a
 * masked recipient (LAST 4 VISIBLE ONLY). Masking happens AT EMISSION so
 * even a raw DB read of the activity table shows no full contact.
 *
 * PII rules (hard):
 * - masked_recipient only; full phone/email NEVER enters the activity row.
 * - message_copy itself must be contact-free (LLM never sees contacts);
 *   emission asserts this and strips on violation (defense in depth).
 */
import { query as defaultQuery } from "../db.js";
import { appendActivity } from "./activity.js";
import { decrypt } from "./crypto.js";

export type MessageChannel = "payment_link" | "chat" | "email" | "sms" | "reassurance" | "review" | "upsell" | "retry";

export interface EmitMessageInput {
  merchantId: string;
  actor: string;
  channel: MessageChannel;
  /** FINAL resolved copy (post-grounding). */
  messageCopy: string;
  /** Pre-resolution token-bearing copy (raw {{token}} version) for the diff view. */
  rawCopy?: string;
  messageStrategy?: string;
  messageTone?: string;
  brainMode?: "llm" | "rules";
  cartOrOrderRef?: string | null;
  resolvedTokens?: Array<{ token?: string; type?: string; ref?: string; resolved_value?: unknown; rendered?: unknown } | string>;
  incentivePaise?: number | null;
  simulated?: boolean;
  customerId?: string | null;
  /** Pre-masked recipient (tests / paths without a customer row). */
  maskedRecipient?: string;
  sourceTag?: string;
  ledgerSeq?: number;
}

const PHONE_RE = /\+?\d[\d\s\-()]{7,}\d/g;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** Mask to last-4 only. Phones → "+91 ••••• 3210" shape; emails → "•••@domain (••••1234)". */
export function maskRecipient(contact: string): string {
  const c = String(contact || "").trim();
  if (!c) return "—";
  if (c.includes("@")) {
    const [u, d] = c.split("@");
    const tail = String(u || "").replace(/[^a-zA-Z0-9]/g, "").slice(-4) || "••••";
    return `•••@${d || ""} (••••${tail.slice(-4)})`;
  }
  const digits = c.replace(/\D/g, "");
  const last4 = digits.slice(-4) || "••••";
  const cc = digits.length > 10 ? `+${digits.slice(0, digits.length - 10)} ` : "+91 ";
  return `${cc}••••• ${last4}`;
}

/** Contact-free assertion for message_copy (defense in depth). */
export function stripContactsFromCopy(copy: string): { copy: string; stripped: boolean } {
  let out = String(copy || "");
  let stripped = false;
  if (EMAIL_RE.test(out)) { stripped = true; out = out.replace(EMAIL_RE, "[contact]"); }
  EMAIL_RE.lastIndex = 0;
  // Phone-like runs of 10+ digits (short clock times / counts untouched).
  const m = out.match(PHONE_RE) || [];
  for (const hit of m) {
    if (hit.replace(/\D/g, "").length >= 10) { stripped = true; out = out.split(hit).join("[contact]"); }
  }
  return { copy: out, stripped };
}

async function maskedForCustomer(customerId: string | null | undefined): Promise<string> {
  if (!customerId) return "—";
  try {
    const { rows } = await (defaultQuery as any)("SELECT contact_enc FROM customers WHERE id = $1", [customerId]);
    const enc = rows[0]?.contact_enc;
    if (!enc) return "—";
    return maskRecipient(decrypt(enc));
  } catch {
    return "—";
  }
}

export async function emitMessageSent(input: EmitMessageInput): Promise<number | null> {
  const safe = stripContactsFromCopy(input.messageCopy);
  const masked = input.maskedRecipient || (await maskedForCustomer(input.customerId));
  const resolved = (input.resolvedTokens || []).map((r: any) =>
    typeof r === "string"
      ? { token: r, resolved_value: r }
      : { token: r.token || `${r.type || ""}:${r.ref || ""}`, resolved_value: r.resolved_value ?? r.rendered ?? r.value ?? null }
  );
  try {
    return await appendActivity({
      merchant_id: input.merchantId,
      actor: input.actor,
      type: "MESSAGE_SENT",
      summary: safe.copy.slice(0, 140),
      amount_paise: input.incentivePaise ?? undefined,
      data: {
        channel: input.channel,
        message_copy: safe.copy,
        raw_copy: input.rawCopy || undefined,
        message_strategy: input.messageStrategy || "functional",
        message_tone: input.messageTone || undefined,
        brain_mode: input.brainMode || "rules",
        masked_recipient: masked,
        cart_or_order_ref: input.cartOrOrderRef || null,
        resolved_tokens: resolved,
        incentive_paise: input.incentivePaise ?? 0,
        contact_stripped: safe.stripped || undefined,
        ledger_seq: input.ledgerSeq ?? undefined,
      },
      simulated: input.simulated || false,
      source_tag: input.sourceTag,
    } as any);
  } catch {
    return null;
  }
}

/** PII audit helper: true when a string contains a full contact. */
export function containsFullContact(text: string): boolean {
  EMAIL_RE.lastIndex = 0;
  if (EMAIL_RE.test(String(text || ""))) { EMAIL_RE.lastIndex = 0; return true; }
  EMAIL_RE.lastIndex = 0;
  const hits = String(text || "").match(PHONE_RE) || [];
  return hits.some((h) => h.replace(/\D/g, "").length >= 10);
}
