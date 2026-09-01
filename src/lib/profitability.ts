import { query } from "../db.js";
import { createLogger } from "../logger.js";
import { CONSTANTS } from "./economics.js";

const log = createLogger("profitability");

/**
 * Update order with profitability data on resolution.
 */
export async function updateOrderProfitability(
  orderId: string,
  incentivePaise: number,
  marginPaise: number
): Promise<void> {
  const { rows } = await query("SELECT amount_paise FROM orders WHERE id = $1", [orderId]);
  if (!rows[0]) return;

  const amountPaise = Number(rows[0].amount_paise);
  const feePaise = Math.round(amountPaise * CONSTANTS.PAYMENT_FEE_BPS / 10000);
  const netProfitPaise = marginPaise - incentivePaise - feePaise;

  await query(
    "UPDATE orders SET payment_fee_paise = $1, incentive_paise = $2, net_profit_paise = $3 WHERE id = $4",
    [feePaise, incentivePaise, netProfitPaise, orderId]
  );

  log.debug({ orderId, feePaise, netProfitPaise }, "Order profitability updated");
}

/**
 * Get ROI dashboard data: incremental revenue, net contribution, ROAS.
 */
export async function getROIDashboard(experimentId?: string): Promise<{
  attributed: { revenue: number; incentive: number; fee: number; netProfit: number };
  incremental: { revenue: number; grossProfit: number; incentive: number; fee: number; aiCost: number; netContribution: number; roas: number };
}> {
  // Attributed totals (all sources)
  const { rows: attributed } = await query(
    `SELECT COALESCE(SUM(amount_paise), 0) as revenue,
            COALESCE(SUM(incentive_paise), 0) as incentive,
            COALESCE(SUM(payment_fee_paise), 0) as fee,
            COALESCE(SUM(net_profit_paise), 0) as net_profit
     FROM orders WHERE status = 'paid'`
  );

  // Incremental (vs control) if experiment exists
  let incremental = {
    revenue: 0,
    grossProfit: 0,
    incentive: 0,
    fee: 0,
    aiCost: 0,
    netContribution: 0,
    roas: 0,
  };

  if (experimentId) {
    const { rows: metrics } = await query(
      "SELECT * FROM experiment_metrics WHERE experiment_id = $1 ORDER BY at DESC LIMIT 1",
      [experimentId]
    );
    if (metrics[0]) {
      const m = metrics[0];
      incremental.revenue = Number(m.incremental_revenue_paise || 0);
      incremental.grossProfit = Number(m.incremental_gross_profit_paise || 0);
      incremental.incentive = Number(attributed[0]?.incentive || 0);
      incremental.fee = Number(attributed[0]?.fee || 0);

      // Count AI actions
      const { rows: actionCount } = await query(
        "SELECT COUNT(*) as cnt FROM audit_log WHERE actor IN ('RecoveryBot', 'UpsellBot', 'ChatAgent') AND outcome = 'SUCCESS'"
      );
      incremental.aiCost = Number(actionCount[0]?.cnt || 0) * CONSTANTS.AI_COST_PER_ACTION_PAISE;

      incremental.netContribution = incremental.grossProfit - incremental.incentive - incremental.fee - incremental.aiCost;
      incremental.roas = incremental.incentive > 0 ? incremental.grossProfit / incremental.incentive : 0;
    }
  }

  return {
    attributed: {
      revenue: Number(attributed[0]?.revenue || 0),
      incentive: Number(attributed[0]?.incentive || 0),
      fee: Number(attributed[0]?.fee || 0),
      netProfit: Number(attributed[0]?.net_profit || 0),
    },
    incremental,
  };
}
