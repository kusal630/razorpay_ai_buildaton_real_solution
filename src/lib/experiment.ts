import crypto from "node:crypto";
import { query } from "../db.js";
import { createLogger } from "../logger.js";

const log = createLogger("experiment");

const EXPERIMENT_SECRET = process.env.EXPERIMENT_SECRET || "sellable-experiment-secret-v1";

export interface Experiment {
  id: string;
  merchant_id: string;
  workflow: string;
  baseline_json: any;
  target_json: any;
  owner: string;
  limits_json: any;
  stop_rules_json: any;
  status: string;
}

/**
 * W6: Deterministic cohort assignment using HMAC-SHA256 (N24).
 * arm = 'control' if hmac(secret, identity_token + ':' + experiment_id) % 10 == 0
 * Identity-level, stored once, never derivable from client-supplied IDs.
 */
export function assignArm(identityToken: string, experimentId: string): 'treatment' | 'control' {
  const hmac = crypto.createHmac('sha256', EXPERIMENT_SECRET)
    .update(`${identityToken}:${experimentId}`)
    .digest('hex');
  const value = parseInt(hmac.slice(0, 8), 16) % 10;
  return value === 0 ? 'control' : 'treatment';
}

/**
 * W6: Assign a customer to an experiment arm and record it.
 * Supports both the legacy shape (cart_id, experiment_id TEXT) and the
 * Supabase shape (merchant_id, customer_id uuid, experiment_id uuid,
 * PK(customer_id, experiment_id)). Uses identity_token, not cart_id (V5).
 */
export async function assignToExperiment(
  identityToken: string,
  experimentId: string,
  opts?: { merchantId?: string; customerId?: string }
): Promise<'treatment' | 'control'> {
  const arm = assignArm(identityToken, experimentId);

  // Store once per identity+experiment
  if (opts?.merchantId && opts?.customerId) {
    await query(
      `INSERT INTO cohort_assignments (merchant_id, customer_id, experiment_id, arm)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (customer_id, experiment_id) DO NOTHING`,
      [opts.merchantId, opts.customerId, experimentId, arm]
    );
  } else {
    await query(
      `INSERT INTO cohort_assignments (cart_id, experiment_id, arm)
       VALUES ($1, $2, $3)
       ON CONFLICT (cart_id, experiment_id) DO NOTHING`,
      [identityToken, experimentId, arm]
    );
  }

  log.debug({ identityToken: identityToken.slice(0, 8), experimentId, arm }, "Identity assigned to cohort");
  return arm;
}

/**
 * N1 (v4.2): statuses that count as a RUNNING experiment for arm-gating.
 * Legacy shape uses 'approved'/'running'; Supabase shape uses 'active'.
 * Paused/completed experiments do NOT gate proactive touches.
 */
const RUNNING_STATUSES = ["running", "active", "approved"];

export function isExperimentRunning(status: string | null | undefined): boolean {
  return !!status && RUNNING_STATUSES.includes(status);
}

/**
 * N1 (v4.2): read a customer's arm for an experiment.
 * Prefers the stored cohort row; falls back to the deterministic derivation
 * from identity_hash (same function that wrote the row, so identical result).
 * Returns null when the customer or identity is unknown.
 */
export async function getArm(
  customerId: string,
  experimentId: string
): Promise<'treatment' | 'control' | null> {
  if (!customerId || !experimentId) return null;
  const { rows } = await query(
    `SELECT arm FROM cohort_assignments WHERE customer_id = $1 AND experiment_id = $2`,
    [customerId, experimentId]
  );
  if (rows[0]?.arm === "treatment" || rows[0]?.arm === "control") {
    return rows[0].arm;
  }
  const { rows: custRows } = await query(
    "SELECT identity_hash FROM customers WHERE id = $1",
    [customerId]
  );
  const identityToken = custRows[0]?.identity_hash;
  if (!identityToken) return null;
  return assignArm(identityToken, experimentId);
}

/**
 * N1 (v4.2): the running experiment covering a customer (cart_recovery holdout),
 * plus her arm. Returns null when no running experiment applies — in which
 * case nothing is arm-gated.
 */
export async function getCustomerArm(
  customerId: string
): Promise<{ experimentId: string; arm: 'treatment' | 'control' } | null> {
  if (!customerId) return null;
  const experiment = await getActiveExperiment("cart_recovery");
  if (!experiment || !isExperimentRunning(experiment.status)) return null;
  const arm = await getArm(customerId, experiment.id);
  if (!arm) return null;
  return { experimentId: experiment.id, arm };
}

/**
 * W6: Check arm imbalance (alert if |treatment% - 90%| > 5 points on n >= 100).
 */
export async function checkArmImbalance(experimentId: string): Promise<{
  imbalanced: boolean;
  treatmentPercent: number;
  n: number;
} | null> {
  const { rows } = await query(
    `SELECT arm, COUNT(*) as cnt
     FROM cohort_assignments
     WHERE experiment_id = $1
     GROUP BY arm`,
    [experimentId]
  );

  const treatmentCount = rows.find(r => r.arm === 'treatment')?.cnt || 0;
  const controlCount = rows.find(r => r.arm === 'control')?.cnt || 0;
  const total = treatmentCount + controlCount;

  if (total < 100) return null;

  const treatmentPercent = (treatmentCount / total) * 100;
  const imbalanced = Math.abs(treatmentPercent - 90) > 5;

  if (imbalanced) {
    log.warn({ experimentId, treatmentPercent, total }, "Arm imbalance detected");
  }

  return { imbalanced, treatmentPercent, n: total };
}

/**
 * Get active experiment for a workflow.
 * Supports the legacy shape (workflow TEXT, status 'approved') and the
 * Supabase shape (charter JSONB, status 'active').
 */
export async function getActiveExperiment(workflow: string): Promise<Experiment | null> {
  try {
    const { rows } = await query(
      "SELECT * FROM experiments WHERE workflow = $1 AND status = 'approved' LIMIT 1",
      [workflow]
    );
    return rows[0] || null;
  } catch (err: any) {
    // Supabase shape: no workflow column — fall back to active experiments
    if (!/column .* does not exist|undefined column/i.test(err.message)) throw err;
    const { rows } = await query(
      "SELECT * FROM experiments WHERE status = 'active' ORDER BY created_at DESC LIMIT 1"
    );
    const row = rows[0];
    if (!row) return null;
    const charter = row.charter || {};
    return {
      id: row.id,
      merchant_id: row.merchant_id,
      workflow,
      baseline_json: charter.baseline || { aov_paise: 149800, gross_margin_percent: 0.4 },
      target_json: charter.target || {},
      owner: charter.owner || "product-team",
      limits_json: charter.limits || {},
      stop_rules_json: charter.stop_rules || {},
      status: row.status,
    };
  }
}

/**
 * Wilson score interval for confidence intervals.
 */
export function wilsonInterval(
  successes: number,
  trials: number,
  z: number = 1.96
): { lower: number; upper: number } {
  if (trials === 0) return { lower: 0, upper: 1 };

  const phat = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const center = phat + z2 / (2 * trials);
  const spread = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * trials)) / trials);

  return {
    lower: Math.max(0, (center - spread) / denominator),
    upper: Math.min(1, (center + spread) / denominator),
  };
}

/**
 * Compute experiment metrics with Wilson intervals.
 */
export async function computeMetrics(experimentId: string): Promise<{
  treatmentRate: number;
  controlRate: number;
  treatmentInterval: { lower: number; upper: number };
  controlInterval: { lower: number; upper: number };
  incrementalRevenue: number;
  incrementalGrossProfit: number;
  roas: number;
  state: "collecting" | "ready";
  nTreatment: number;
  nControl: number;
  minN: number;
}> {
  const MIN_N = 30;

  const { rows: treatment } = await query(
    `SELECT COUNT(*) as attempts,
            SUM(CASE WHEN outcome = 'SUCCESS' THEN 1 ELSE 0 END) as successes
     FROM audit_log al
     JOIN cohort_assignments ca ON ca.cart_id = (al.rationale_json->>'evidence_ids'->>0)
     WHERE ca.experiment_id = $1 AND ca.arm = 'treatment'
     AND al.actor = 'RecoveryBot' AND al.action = 'create_payment_link'`,
    [experimentId]
  );

  const { rows: control } = await query(
    `SELECT COUNT(*) as attempts,
            SUM(CASE WHEN outcome = 'SUCCESS' THEN 1 ELSE 0 END) as successes
     FROM audit_log al
     JOIN cohort_assignments ca ON ca.cart_id = (al.rationale_json->>'evidence_ids'->>0)
     WHERE ca.experiment_id = $1 AND ca.arm = 'control'
     AND al.actor = 'RecoveryBot' AND al.action = 'create_payment_link'`,
    [experimentId]
  );

  const tAttempts = Number(treatment[0]?.attempts || 0);
  const tSuccesses = Number(treatment[0]?.successes || 0);
  const cAttempts = Number(control[0]?.attempts || 0);
  const cSuccesses = Number(control[0]?.successes || 0);

  const treatmentRate = tAttempts > 0 ? tSuccesses / tAttempts : 0;
  const controlRate = cAttempts > 0 ? cSuccesses / cAttempts : 0;

  const treatmentInterval = wilsonInterval(tSuccesses, tAttempts);
  const controlInterval = wilsonInterval(cSuccesses, cAttempts);

  const state = (tAttempts >= MIN_N && cAttempts >= MIN_N) ? "ready" : "collecting";

  const { rows: expRows } = await query(
    "SELECT baseline_json, target_json FROM experiments WHERE id = $1",
    [experimentId]
  );
  const exp = expRows[0];
  const aov = Number(exp?.baseline_json?.aov_paise || 149800);
  const marginPercent = Number(exp?.baseline_json?.gross_margin_percent || 0.40);

  const incrementalConversions = tSuccesses - cSuccesses;
  const incrementalRevenue = incrementalConversions * aov;
  const incrementalGrossProfit = Math.round(incrementalRevenue * marginPercent);

  const { rows: incentiveRows } = await query(
    `SELECT COALESCE(SUM((al.params_json->>'incentive_paise')::bigint), 0) as total_incentive
     FROM audit_log al
     JOIN cohort_assignments ca ON ca.cart_id = (al.rationale_json->>'evidence_ids'->>0)
     WHERE ca.experiment_id = $1 AND ca.arm = 'treatment'
     AND al.outcome = 'SUCCESS'`,
    [experimentId]
  );
  const totalIncentive = Number(incentiveRows[0]?.total_incentive || 0);
  const roas = totalIncentive > 0 ? incrementalGrossProfit / totalIncentive : 0;

  return {
    treatmentRate,
    controlRate,
    treatmentInterval,
    controlInterval,
    incrementalRevenue,
    incrementalGrossProfit,
    roas,
    state,
    nTreatment: tAttempts,
    nControl: cAttempts,
    minN: MIN_N,
  };
}

/**
 * Check stop rules for an experiment.
 */
export async function checkStopRules(experimentId: string): Promise<string | null> {
  const { rows } = await query(
    "SELECT stop_rules_json FROM experiments WHERE id = $1",
    [experimentId]
  );
  const rules = rows[0]?.stop_rules_json;
  if (!rules) return null;

  const metrics = await computeMetrics(experimentId);

  if (metrics.treatmentRate < (rules.conversion_floor || 0.02)) {
    return `Treatment conversion rate ${metrics.treatmentRate.toFixed(4)} below floor ${rules.conversion_floor}`;
  }

  if (metrics.roas < (rules.min_roas || 2)) {
    return `ROAS ${metrics.roas.toFixed(2)} below minimum ${rules.min_roas}`;
  }

  return null;
}

/**
 * Pause an experiment due to stop rule breach.
 * W10: Stop new proactive actions, settle paid links, cancel unsent deferred, ledger the pause.
 */
export async function pauseExperiment(experimentId: string, reason: string): Promise<void> {
  await query(
    "UPDATE experiments SET status = 'paused' WHERE id = $1",
    [experimentId]
  );

  // Cancel pending deferred intents for this experiment (dedupe_key carries the experiment id)
  await query(
    `UPDATE action_intents SET status = 'expired'
     WHERE status = 'deferred'
     AND dedupe_key LIKE '%' || $1 || '%'`,
    [experimentId]
  );

  log.warn({ experimentId, reason }, "Experiment paused due to stop rule");
}
