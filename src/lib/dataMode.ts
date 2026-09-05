/**
 * dataMode.ts — LIVE/DEMO data-source modes (console readability).
 * Single row in data_mode (id=true). Query fns injectable for tests.
 */
import { query as defaultQuery } from "../db.js";

export type QueryFn = (sql: string, params?: any[]) => Promise<{ rows: any[] }>;
export type DataMode = "demo" | "live";

export interface DataModeState {
  mode: DataMode;
  demo_bg_enabled: boolean;
}

export const DATA_MODE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS data_mode (
  id BOOLEAN PRIMARY KEY DEFAULT true,
  mode TEXT NOT NULL DEFAULT 'demo' CHECK (mode IN ('demo', 'live')),
  demo_bg_enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);
INSERT INTO data_mode (id, mode, demo_bg_enabled)
VALUES (true, 'demo', true)
ON CONFLICT (id) DO NOTHING;
ALTER TABLE activity ADD COLUMN IF NOT EXISTS source_tag TEXT NOT NULL DEFAULT 'system';
ALTER TABLE carts ADD COLUMN IF NOT EXISTS source_tag TEXT NOT NULL DEFAULT 'demo';
`;

/** Idempotent boot ensure (covers SKIP_MIGRATIONS / out-of-band schemas). */
export async function ensureDataModeSchema(q: QueryFn = defaultQuery as QueryFn): Promise<void> {
  await q(DATA_MODE_SCHEMA_SQL);
}

export async function getDataMode(q: QueryFn = defaultQuery as QueryFn): Promise<DataModeState> {
  const { rows } = await q("SELECT mode, demo_bg_enabled FROM data_mode WHERE id = true");
  const mode = rows[0]?.mode === "live" ? "live" : "demo";
  return { mode, demo_bg_enabled: rows[0]?.demo_bg_enabled !== false };
}

export async function setDataMode(
  q: QueryFn,
  mode: string,
  updatedBy: string
): Promise<DataModeState> {
  if (mode !== "demo" && mode !== "live") throw new Error("mode must be 'demo' or 'live'");
  await q("UPDATE data_mode SET mode = $1, updated_at = NOW(), updated_by = $2 WHERE id = true", [mode, updatedBy]);
  return getDataMode(q);
}

export async function setDemoBg(
  q: QueryFn,
  enabled: boolean,
  updatedBy: string
): Promise<DataModeState> {
  await q("UPDATE data_mode SET demo_bg_enabled = $1, updated_at = NOW(), updated_by = $2 WHERE id = true", [enabled === true, updatedBy]);
  return getDataMode(q);
}
