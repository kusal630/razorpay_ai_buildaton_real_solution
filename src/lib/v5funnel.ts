/**
 * v5funnel.ts — T3 conversion-collapse → recovery auto-suspension.
 * Pure detector (unit-tested) + injectable-query effects. Transactional
 * actions (failure retries, payment status) are NEVER suspended — only
 * proactive persuasion into a broken funnel.
 */
export type QueryFn = (sql: string, params?: any[]) => Promise<{ rows: any[] }>;

export interface FunnelWindow {
  starts2h: number;
  converts2h: number;
  /** Per-2h checkout-start counts over the trailing 24h (12 buckets). */
  baselineBuckets: number[];
}

export function baselineMedian(buckets: number[]): number {
  if (buckets.length === 0) return 0;
  const s = [...buckets].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * T3 detector: ≥20 checkout-starts in 2h AND zero converts AND volume ≥50%
 * of the 24h baseline median (MAD-style guard against quiet-hours false
 * positives).
 */
export function detectCollapse(w: FunnelWindow): { fired: boolean; reason?: string; baseline: number } {
  const baseline = baselineMedian(w.baselineBuckets);
  if (w.starts2h < 20) return { fired: false, baseline };
  if (w.converts2h !== 0) return { fired: false, baseline };
  if (baseline > 0 && w.starts2h < 0.5 * baseline) return { fired: false, baseline };
  if (baseline === 0 && w.starts2h < 20) return { fired: false, baseline };
  return { fired: true, baseline, reason: `20+ checkout-starts with 0 converts (baseline median ${baseline}/2h)` };
}

export async function isRecoverySuspended(q: QueryFn, merchantId: string): Promise<boolean> {
  try {
    const { rows } = await q(
      "SELECT value_jsonb FROM merchant_config WHERE merchant_id = $1 AND key = 'recovery_suspended'",
      [merchantId]
    );
    return (rows[0]?.value_jsonb as any)?.suspended === true;
  } catch {
    return false;
  }
}

export interface SuspendDeps {
  q: QueryFn;
  ledgerAppend: (e: any) => Promise<{ seq: number }>;
  activityAppend: (e: any) => Promise<unknown>;
}

export async function suspendRecovery(
  deps: SuspendDeps, merchantId: string, reason: string
): Promise<{ seq: number }> {
  await deps.q(
    `INSERT INTO merchant_config (merchant_id, key, value_jsonb, updated_by)
     VALUES ($1, 'recovery_suspended', $2, 'funnel_detector')
     ON CONFLICT (merchant_id, key) DO UPDATE SET value_jsonb = $2, updated_at = NOW()`,
    [merchantId, JSON.stringify({ suspended: true, reason, since: new Date().toISOString() })]
  );
  const { seq } = await deps.ledgerAppend({
    merchantId, actor: "FunnelGuard", action: "recovery_suspended",
    params: {}, decision: "ALLOW", policy_checks: { funnel: "ANOMALY" },
    rationale: { reason: "funnel_anomaly_suspended", detail: reason },
    outcome: "SUCCESS",
  });
  await deps.activityAppend({
    merchant_id: merchantId, actor: "FunnelGuard", type: "FUNNEL_SUSPENDED",
    summary: "checkout funnel anomaly — recovery suspended",
    data: { reason, seq }, severity: "warn",
  });
  return { seq };
}

export async function resumeRecovery(
  deps: SuspendDeps, merchantId: string, how: "manual" | "auto"
): Promise<{ seq: number }> {
  await deps.q(
    `INSERT INTO merchant_config (merchant_id, key, value_jsonb, updated_by)
     VALUES ($1, 'recovery_suspended', $2, $3)
     ON CONFLICT (merchant_id, key) DO UPDATE SET value_jsonb = $2, updated_at = NOW()`,
    [merchantId, JSON.stringify({ suspended: false, resumed: how, at: new Date().toISOString() }), how === "manual" ? "merchant" : "funnel_detector"]
  );
  const { seq } = await deps.ledgerAppend({
    merchantId, actor: how === "manual" ? "Merchant" : "FunnelGuard", action: "recovery_resumed",
    params: {}, decision: "ALLOW", policy_checks: {},
    rationale: { reason: how === "manual" ? "manual_resume" : "auto_rearm_converts_recovered" },
    outcome: "SUCCESS",
  });
  return { seq };
}

/** Build the 2h + baseline windows from carts/orders (job input). */
export async function readFunnelWindow(q: QueryFn, merchantId: string): Promise<FunnelWindow> {
  const s = await q(
    `SELECT COUNT(*) AS n FROM carts WHERE merchant_id = $1 AND checkout_started_at > NOW() - INTERVAL '2 hours'`,
    [merchantId]
  );
  const c = await q(
    `SELECT COUNT(*) AS n FROM orders WHERE merchant_id = $1 AND status = 'paid' AND paid_at > NOW() - INTERVAL '2 hours'`,
    [merchantId]
  );
  const b = await q(
    `SELECT COUNT(*) AS n, date_trunc('hour', checkout_started_at) AS h FROM carts
      WHERE merchant_id = $1 AND checkout_started_at > NOW() - INTERVAL '24 hours'
      GROUP BY h ORDER BY h`,
    [merchantId]
  );
  // Fold hourly counts into twelve 2h buckets (pad short histories with 0).
  const hours: number[] = (b.rows as any[]).map((r) => Number(r.n));
  while (hours.length < 24) hours.unshift(0);
  const buckets: number[] = [];
  for (let i = 0; i < 24; i += 2) buckets.push(hours[i] + hours[i + 1]);
  return {
    starts2h: Number((s.rows[0] as any)?.n || 0),
    converts2h: Number((c.rows[0] as any)?.n || 0),
    baselineBuckets: buckets,
  };
}
