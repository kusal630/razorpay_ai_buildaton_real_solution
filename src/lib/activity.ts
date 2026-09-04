import { query } from "../db.js";
import { createLogger } from "../logger.js";

const log = createLogger("activity");

export interface ActivityRow {
  merchant_id: string;
  actor: string;
  type: string;
  summary: string;
  amount_paise?: number;
  data: Record<string, unknown>;
  simulated?: boolean;
  severity?: string;
}

const sseListeners = new Set<any>();

export async function appendActivity(row: ActivityRow): Promise<number> {
  const { rows } = await query(
    `INSERT INTO activity (merchant_id, actor, type, summary, amount_paise, data, simulated, severity)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      row.merchant_id, row.actor, row.type, row.summary,
      row.amount_paise != null ? row.amount_paise : null,
      JSON.stringify(row.data), row.simulated || false, row.severity || "info",
    ]
  );

  const full: Record<string, unknown> = {
    id: rows[0].id,
    ts: new Date().toISOString(),
    ...row,
  };

  broadcast(full);
  return rows[0].id;
}

function broadcast(payload: Record<string, unknown>): void {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseListeners) {
    try { res.write(data); } catch { sseListeners.delete(res); }
  }
}

export function subscribeActivityFeed(res: any): () => void {
  sseListeners.add(res);

  query("SELECT * FROM activity ORDER BY id DESC LIMIT 200")
    .then(({ rows }) => {
      for (const r of rows.reverse()) {
        try { res.write(`data: ${JSON.stringify(r)}\n\n`); } catch { break; }
      }
    })
    .catch(() => {});

  return () => { sseListeners.delete(res); };
}

export async function getRecentActivity(limit = 200, simulated?: boolean): Promise<any[]> {
  const { rows } = simulated == null
    ? await query("SELECT * FROM activity ORDER BY id DESC LIMIT $1", [limit])
    : await query("SELECT * FROM activity WHERE simulated = $1 ORDER BY id DESC LIMIT $2", [simulated, limit]);
  return rows;
}