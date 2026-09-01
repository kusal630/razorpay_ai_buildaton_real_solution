import { query } from "../db.js";
import { CONSTANTS } from "./economics.js";
import { createLogger } from "../logger.js";

const log = createLogger("theta0Estimator");

// H6: Minimum control observations before using control arm as primary
const MIN_CONTROL_N = 5;

/**
 * H6: Get theta_0 (control arm conversion rate) per segment.
 * Uses control arm outcomes as primary estimator.
 * Falls back to prior (0.10) when control n < MIN_CONTROL_N.
 */
export async function getTheta0(
  merchantId: string,
  segment: string,
  experimentId?: string
): Promise<{
  theta0: number;
  source: "control_arm" | "prior";
  controlN: number;
  controlSuccesses: number;
}> {
  // Try to get control arm outcomes
  if (experimentId) {
    const { rows } = await query(
      `SELECT COUNT(*) as n, SUM(CASE WHEN outcome = 'SUCCESS' THEN 1 ELSE 0 END) as successes
       FROM audit_log al
       JOIN cohort_assignments ca ON ca.cart_id = (al.rationale_json->>'evidence_ids'->>0)
       WHERE ca.experiment_id = $1
         AND ca.arm = 'control'
         AND al.actor = 'RecoveryBot'
         AND al.action = 'create_payment_link'`,
      [experimentId]
    );

    const controlN = Number(rows[0]?.n || 0);
    const controlSuccesses = Number(rows[0]?.successes || 0);

    if (controlN >= MIN_CONTROL_N) {
      const theta0 = controlSuccesses / controlN;
      log.debug({ experimentId, segment, theta0, controlN }, "theta_0 from control arm");
      return { theta0, source: "control_arm", controlN, controlSuccesses };
    }
  }

  // Fallback to prior
  log.debug({ experimentId, segment, prior: CONSTANTS.THETA_0_PRIOR }, "theta_0 from prior");
  return {
    theta0: CONSTANTS.THETA_0_PRIOR,
    source: "prior",
    controlN: 0,
    controlSuccesses: 0,
  };
}
