import { query } from "../db.js";
import { appendLedger } from "./ledger.js";
import { appendActivity } from "./activity.js";
import { createLogger } from "../logger.js";

const log = createLogger("refundAlarm");

/**
 * N8/S4 (v4.2): refund-volume anomaly alarm.
 * Compares last-hour refund count + paise volume, per tenant and platform-wide,
 * against the trailing 7-day hourly baseline. Ratio > 5x fires:
 * alert activity + dashboard banner flag + ledger row.
 * Alarm ONLY — never auto-blocks (refunds may be merchant-driven).
 */
export const REFUND_ALARM_RATIO = 5;
export const REFUND_ALARM_BANNER_TTL_HOURS = 24;
/** Zero-baseline guard: still needs minimum smoke before alarming. */
const ZERO_BASELINE_MIN_COUNT = 2;
const ZERO_BASELINE_MIN_PAISE = 10000;

export interface RefundAlarmScope {
  scope: "tenant" | "platform";
  merchant_id: string | null;
  hour_count: number;
  hour_paise: number;
  base_count: number;
  base_paise: number;
  ratio: number;
}

export async function ensureRefundAlarmTables(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS alert_flags (
    key TEXT PRIMARY KEY,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

async function hourlyStats(where: string, params: unknown[]): Promise<{ count: number; paise: number }> {
  const { rows } = await query(
    `SELECT COUNT(*) as cnt, COALESCE(SUM(amount_paise), 0) as vol
     FROM refunds WHERE ${where} AND created_at >= NOW() - INTERVAL '1 hour'`,
    params
  );
  return { count: Number(rows[0]?.cnt || 0), paise: Number(rows[0]?.vol || 0) };
}

async function baselineStats(where: string, params: unknown[]): Promise<{ count: number; paise: number }> {
  const { rows } = await query(
    `SELECT COUNT(*) as cnt, COALESCE(SUM(amount_paise), 0) as vol
     FROM refunds WHERE ${where} AND created_at >= NOW() - INTERVAL '7 days'`,
    params
  );
  // Trailing 7-day HOURLY baseline
  return { count: Number(rows[0]?.cnt || 0) / (7 * 24), paise: Number(rows[0]?.vol || 0) / (7 * 24) };
}

function isAnomalous(hour: { count: number; paise: number }, base: { count: number; paise: number }): boolean {
  if (base.count <= 0 && base.paise <= 0) {
    return hour.count >= ZERO_BASELINE_MIN_COUNT || hour.paise >= ZERO_BASELINE_MIN_PAISE;
  }
  const countRatio = base.count > 0 ? hour.count / base.count : 0;
  const paiseRatio = base.paise > 0 ? hour.paise / base.paise : 0;
  return Math.max(countRatio, paiseRatio) > REFUND_ALARM_RATIO;
}

/**
 * Run one anomaly check across all merchants + platform. Returns fired scopes.
 */
export async function checkRefundAnomaly(): Promise<{ fired: RefundAlarmScope[] }> {
  await ensureRefundAlarmTables();
  const fired: RefundAlarmScope[] = [];

  const { rows: merchants } = await query(`SELECT DISTINCT merchant_id FROM refunds`);
  const scopes: { scope: "tenant" | "platform"; merchant_id: string | null; where: string; params: unknown[] }[] =
    merchants.map((m: any) => ({
      scope: "tenant" as const,
      merchant_id: m.merchant_id as string,
      where: "merchant_id = $1",
      params: [m.merchant_id],
    }));
  scopes.push({ scope: "platform", merchant_id: null, where: "1 = 1", params: [] });

  for (const s of scopes) {
    const hour = await hourlyStats(s.where, s.params);
    if (hour.count === 0 && hour.paise === 0) continue;
    const base = await baselineStats(s.where, s.params);
    if (!isAnomalous(hour, base)) continue;

    const ratio = Math.max(
      base.count > 0 ? hour.count / base.count : Infinity,
      base.paise > 0 ? hour.paise / base.paise : Infinity
    );
    const scope: RefundAlarmScope = {
      scope: s.scope, merchant_id: s.merchant_id,
      hour_count: hour.count, hour_paise: hour.paise,
      base_count: Math.round(base.count * 100) / 100, base_paise: Math.round(base.paise),
      ratio: Number.isFinite(ratio) ? Math.round(ratio * 10) / 10 : ratio,
    };
    fired.push(scope);

    const label = s.scope === "platform" ? "platform" : `merchant ${String(s.merchant_id).slice(0, 8)}`;
    await appendLedger({
      merchantId: (s.merchant_id as string) || "5a3ac6ce-b2c7-4b1f-a9db-45296841f30b",
      actor: "RefundAlarm",
      action: "refund_anomaly",
      params: { scope: s.scope, merchant_id: s.merchant_id },
      decision: "ALLOW",
      policy_checks: { anomaly: "ALARM" },
      rationale: { reason: "refund_volume_gt_5x_baseline", ...scope },
      outcome: "SUCCESS",
    });
    await appendActivity({
      merchant_id: (s.merchant_id as string) || "5a3ac6ce-b2c7-4b1f-a9db-45296841f30b",
      actor: "RefundAlarm",
      type: "ALERT",
      summary: `Refund anomaly on ${label}: ${hour.count} refunds / ₹${(hour.paise / 100).toFixed(0)} in the last hour vs 7-day baseline`,
      data: { banner: "refund_anomaly", ...scope },
      severity: "warning",
    });
    await query(
      `INSERT INTO alert_flags (key, payload) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET payload = $2, created_at = NOW()`,
      [
        s.scope === "platform" ? "refund_anomaly:platform" : `refund_anomaly:${s.merchant_id}`,
        JSON.stringify({ banner: "refund_anomaly", ...scope, at: new Date().toISOString() }),
      ]
    );
    log.warn({ scope: s.scope, ratio: scope.ratio }, "Refund anomaly alarm fired");
  }

  return { fired };
}

/**
 * Active dashboard banners (TTL-gated).
 */
export async function getActiveBanners(): Promise<{ banner: string; payload: Record<string, unknown> }[]> {
  try {
    await ensureRefundAlarmTables();
    const { rows } = await query(
      `SELECT REPLACE(key, 'refund_anomaly:', '') as scope, payload FROM alert_flags
       WHERE key LIKE 'refund_anomaly:%'
       AND created_at > NOW() - INTERVAL '${REFUND_ALARM_BANNER_TTL_HOURS} hours'`
    );
    return rows.map((r: any) => ({ banner: "refund_anomaly", payload: { scope: r.scope, ...(r.payload || {}) } }));
  } catch {
    return [];
  }
}
