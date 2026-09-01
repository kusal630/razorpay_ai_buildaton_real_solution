import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const migrateDir = path.join(__dirname, "migrate");
  const files = fs.readdirSync(migrateDir).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const version = file.replace(".sql", "");
    const { rows } = await client.query(
      "SELECT version FROM schema_migrations WHERE version = $1",
      [version]
    );
    if (rows.length > 0) continue;

    const sql = fs.readFileSync(path.join(migrateDir, file), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      await client.query("COMMIT");
      console.log(`Migration ${version} applied`);
    } catch (e) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${version} failed: ${e}`);
    }
  }
}
