import * as razorpayService from "./razorpayService.js";
import { appendAuditSerialized } from "./auditLedger2.js";
import { updateAuditOutcome } from "./auditLedger.js";
import * as crypto from "./crypto.js";
import { getConfig } from "../config.js";
import { query } from "../db.js";

// Export fetch functions so poller/reconciler don't import razorpayService directly
export async function fetchOrderStatus(orderId: string): Promise<any> {
  return razorpayService.fetchOrder(orderId);
}

export async function fetchPaymentsList(params: { from?: number; to?: number; count?: number; skip?: number }): Promise<any> {
  return razorpayService.fetchPayments(params);
}

interface MoneyAction {
  type: "create_order" | "create_payment_link" | "fetch_order" | "fetch_payment";
  params: Record<string, unknown>;
}

interface PolicyResult {
  decision: "ALLOW" | "ESCALATE" | "BLOCK" | "ABSTAIN";
  reasons: string[];
  checks: Record<string, unknown>;
}

export async function execute(
  actor: string,
  action: MoneyAction,
  policyResult: PolicyResult,
  rationale: Record<string, unknown>
): Promise<{ seq: number; result?: unknown }> {
  const config = getConfig();

  // V2: Append PROPOSED audit row with serialized lock (N1)
  const seq = await appendAuditSerialized({
    actor,
    action: action.type,
    params_json: action.params,
    decision: policyResult.decision,
    policy_checks_json: policyResult.checks as Record<string, unknown>,
    rationale_json: rationale,
    outcome: "PROPOSED",
  });

  // BLOCK -> never execute
  if (policyResult.decision === "BLOCK") {
    await updateAuditOutcome(seq, "BLOCKED", { reason: "policy_block" });
    return { seq };
  }

  // ABSTAIN -> EV negative, nothing sent (N12)
  if (policyResult.decision === "ABSTAIN") {
    await updateAuditOutcome(seq, "ABSTAINED", { reason: "ev_negative" });
    return { seq };
  }

  // ESCALATE -> create approval, don't execute yet
  if (policyResult.decision === "ESCALATE") {
    await updateAuditOutcome(seq, "ESCALATED", { reason: "policy_escalate" });
    await query(
      `INSERT INTO approvals (merchant_id, audit_seq, context_json) VALUES ($1, $2, $3)`,
      [config.RAZORPAY_MODE === "test" ? "00000000-0000-0000-0000-000000000001" : "", seq, JSON.stringify(rationale)]
    );
    return { seq };
  }

  // ALLOW -> execute via Razorpay
  try {
    let result: unknown;
    switch (action.type) {
      case "create_order":
        result = await razorpayService.createOrder(action.params as any);
        break;
      case "create_payment_link": {
        // Decrypt contacts only here in the money bus
        const p = action.params as any;
        if (p.customer && p.customer.name && p.customer.name.includes(":")) {
          p.customer.name = crypto.decrypt(p.customer.name);
          p.customer.email = crypto.decrypt(p.customer.email);
          p.customer.contact = crypto.decrypt(p.customer.contact);
        }
        result = await razorpayService.createPaymentLink(p);
        break;
      }
      case "fetch_order":
        result = await razorpayService.fetchOrder(action.params.orderId as string);
        break;
      case "fetch_payment":
        result = await razorpayService.fetchPayments(action.params as any);
        break;
      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }

    await updateAuditOutcome(seq, "SUCCESS", { result });
    return { seq, result };
  } catch (err: any) {
    await updateAuditOutcome(seq, "FAILED", { error: err.message });
    throw err;
  }
}
