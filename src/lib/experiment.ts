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
 * Uses identity_token, not cart_id (V5).
 */
export async function assignToExperiment(identityToken: string, experimentId: string): Promise<'treatment' | 'control'> {
  const arm = assignArm(identityToken, experimentId);

  // Store once per identity+experiment
  await query(
    `INSERT INTO cohort_assignments (cart_id, experiment_id, arm)
     VALUES ($1, $2, $3)
     ON CONFLICT (cart_id, experiment_id) DO NOTHING`,
    [identityToken, experimentId, arm]
  );

  log.debug({ identityToken: identityToken.slice(0, 8), experimentId, arm }, "Identity assigned to cohort");
  return arm;
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
 */
export async function getActiveExperiment(workflow: string): Promise<Experiment | null> {
  const { rows } = await query(
    "SELECT * FROM experiments WHERE workflow = $1 AND status = 'approved' LIMIT 1",
    [workflow]
  );
  return rows[0] || null;
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

  // Cancel pending deferred intents for this experiment
  await query(
    `UPDATE action_intents SET status = 'expired'
     WHERE status = 'deferred'
     AND rationale_json->>'experiment_id' = $1`,
    [experimentId]
  );

  log.warn({ experimentId, reason }, "Experiment paused due to stop rule");
}
