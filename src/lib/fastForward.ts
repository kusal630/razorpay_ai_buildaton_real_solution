/**
 * fastForward.ts — QA fast-forward of deferred intents (U-FFWD).
 * Query + dispatch fns are injectable so the gate runs DB-free.
 */
export type QueryFn = (sql: string, params?: any[]) => Promise<{ rows: any[] }>;

export interface FastForwardDeps {
  q: QueryFn;
  ledgerAppend: (e: any) => Promise<{ seq: number }>;
  activityAppend: (e: any) => Promise<unknown>;
  dispatchRecovery: (cartId: string) => Promise<void>;
  merchantId: string;
}

export interface FastForwardResult {
  dispatched: number;
  cancelled: number;
  nothingDeferred: boolean;
}

export async function fastForwardDeferred(
  deps: FastForwardDeps,
  opts: { intentId?: string } = {}
): Promise<FastForwardResult> {
  const { rows: deferred } = await deps.q(
    `SELECT id, merchant_id, customer_id, target_id, action_type FROM action_intents
      WHERE status = 'deferred' ${opts.intentId ? "AND id = $1" : ""}
      ORDER BY resume_at NULLS FIRST LIMIT 25`,
    opts.intentId ? [opts.intentId] : []
  );
  if (deferred.length === 0) {
    await deps.activityAppend({
      merchant_id: deps.merchantId, actor: "Admin", type: "FAST_FORWARD",
      summary: "FAST_FORWARD: nothing deferred",
      data: { dispatched: 0, cancelled: 0 },
    });
    return { dispatched: 0, cancelled: 0, nothingDeferred: true };
  }
  let dispatched = 0, cancelled = 0;
  for (const intent of deferred) {
    const cartId = intent.target_id;
    const mid = intent.merchant_id || deps.merchantId;
    const { rows: cartRows } = await deps.q(
      "SELECT status, customer_id FROM carts WHERE id::text = $1::text", [cartId]
    );
    // Re-validation: paid/converted/gone cart cancels itself.
    if (!cartRows[0] || ["paid", "converted"].includes(cartRows[0].status)) {
      await deps.q("UPDATE action_intents SET status = 'cancelled', lease_expires_at = NULL WHERE id = $1", [intent.id]);
      await deps.ledgerAppend({
        merchantId: mid, actor: "RecoveryBot", action: "intent_fast_forward",
        params: { intent_id: intent.id, cart_id: cartId }, decision: "ALLOW", policy_checks: {},
        rationale: { reason: "fast_forward_cart_paid", prior_status: "deferred" },
        outcome: "SKIPPED",
      });
      cancelled++;
      continue;
    }
    if (String(intent.action_type || "").startsWith("recovery")) {
      // Consume the stale queue row (frees dedupe) + ledger, then execute.
      // Consent + policy re-run inside the dispatched flow itself.
      await deps.q("DELETE FROM action_intents WHERE id = $1", [intent.id]);
      await deps.ledgerAppend({
        merchantId: mid, actor: "RecoveryBot", action: "intent_fast_forward",
        params: { intent_id: intent.id, cart_id: cartId }, decision: "ALLOW", policy_checks: {},
        rationale: { reason: "fast_forwarded", prior_status: "deferred" },
        outcome: "SUCCESS",
      });
      await deps.dispatchRecovery(cartId);
      dispatched++;
    } else {
      await deps.q("UPDATE action_intents SET status = 'pending', resume_at = NOW(), lease_expires_at = NULL WHERE id = $1", [intent.id]);
      await deps.ledgerAppend({
        merchantId: mid, actor: "RecoveryBot", action: "intent_fast_forward",
        params: { intent_id: intent.id, cart_id: cartId }, decision: "ALLOW", policy_checks: {},
        rationale: { reason: "fast_forwarded", prior_status: "deferred" },
        outcome: "SUCCESS",
      });
      dispatched++;
    }
  }
  await deps.activityAppend({
    merchant_id: deps.merchantId, actor: "Admin", type: "FAST_FORWARD",
    summary: `FAST_FORWARD: dispatched ${dispatched}, cancelled ${cancelled}`,
    data: { dispatched, cancelled },
  });
  return { dispatched, cancelled, nothingDeferred: false };
}
