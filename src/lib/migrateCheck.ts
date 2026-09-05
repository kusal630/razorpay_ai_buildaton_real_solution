/**
 * migrateCheck.ts — F2: expected migrations DERIVED from files on disk
 * (never a hardcoded list); each file verified by EFFECT (sentinel
 * table/column), robust to tracker divergence (schema_migrations vs
 * pgmigrations vs out-of-band application).
 */
import fs from "node:fs";
import path from "node:path";

export type QueryFn = (sql: string, params?: any[]) => Promise<{ rows: any[] }>;

export interface MigrationSentinel {
  file: string;
  table: string;
  column?: string;
}

export const MIGRATION_SENTINELS: MigrationSentinel[] = [
  { file: "001_initial_schema.sql", table: "merchants" },
  { file: "002_action_intents.sql", table: "action_intents" },
  { file: "003_experiments.sql", table: "cohort_assignments" },
  { file: "004_patches_p3_p7_p8_p9.sql", table: "pii_access_log" },
  { file: "005_v3_2_v3_v1_v11.sql", table: "track_keys" },
  { file: "006_v3_3.sql", table: "notification_outbox" },
  { file: "007_v4_0.sql", table: "open_links" },
  { file: "008_v4_1.sql", table: "consent_events" },
  { file: "009_v5_sellable.sql", table: "payment_links" },
  { file: "010_v5_build.sql", table: "credit_ledger" },
  { file: "011_v5_checkout_flag.sql", table: "carts", column: "checkout_started_at" },
  { file: "012_v5_abandonment_cycles.sql", table: "customers", column: "abandonment_cycles" },
  { file: "013_v5_benchmarks.sql", table: "industry_benchmarks" },
  { file: "014_v5_datamode.sql", table: "data_mode" },
  { file: "015_link_payment_attempts.sql", table: "link_payment_attempts" },
];

export function migrationFiles(migrateDir: string): string[] {
  return fs
    .readdirSync(migrateDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

export interface MigrationStatus {
  ok: boolean;
  expected: string[];
  applied: string[];
  missing: string[];
}

export async function checkMigrations(
  q: QueryFn,
  files?: string[]
): Promise<MigrationStatus> {
  const expected = files || [];
  const applied: string[] = [];
  const missing: string[] = [];
  const sentinelByFile = new Map(MIGRATION_SENTINELS.map((s) => [s.file, s]));
  for (const f of expected) {
    const sentinel = sentinelByFile.get(f);
    if (!sentinel) {
      missing.push(`${f} (no sentinel defined)`);
      continue;
    }
    try {
      if (sentinel.column) {
        const { rows } = await q(
          "SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2",
          [sentinel.table, sentinel.column]
        );
        (rows.length > 0 ? applied : missing).push(f);
      } else {
        const { rows } = await q(
          "SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = $1",
          [sentinel.table]
        );
        (rows.length > 0 ? applied : missing).push(f);
      }
    } catch {
      missing.push(`${f} (check failed)`);
    }
  }
  return { ok: missing.length === 0, expected, applied, missing };
}

/**
 * Apply one missing file via raw SQL (every file is idempotent-guarded),
 * then record it in schema_migrations under its file name.
 */
export async function applyMigrationFile(
  q: QueryFn,
  migrateDir: string,
  file: string
): Promise<void> {
  const sql = fs.readFileSync(path.join(migrateDir, file), "utf8");
  await q(sql);
  await q(
    `CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`
  );
  await q(`INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING`, [
    file.replace(/\.sql$/, ""),
  ]);
}
