import pg from "pg";
import { getConfig } from "./config.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = getConfig().DATABASE_URL;
    // Supabase (and other managed Postgres) requires SSL; the pooler cert
    // chain fails Node's default verification, so skip chain validation.
    const needsSSL =
      connectionString.includes("supabase.co") ||
      connectionString.includes("sslmode=require");
    pool = new Pool({
      connectionString,
      ...(needsSSL ? { ssl: { rejectUnauthorized: false } } : {}),
      // Pool budget: managed session poolers (Supabase pool_size: 15) count
      // EVERY session, including zombies from crashed/clients that vanished
      // without pool.end(). A 20-client app pool can wedge the whole
      // database (EMAXCONNSESSION — logins included). Cap well below the
      // pooler limit; this workload (one scheduler + request handlers)
      // is idle 99% of the time and never needs more.
      max: 6,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 15000,
    });
    pool.on("error", (err) => {
      console.error("Unexpected pool error:", err);
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function query(text: string, params?: unknown[]): Promise<pg.QueryResult> {
  return getPool().query(text, params);
}
