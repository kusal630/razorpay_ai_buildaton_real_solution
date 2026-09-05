import pg from "pg";
import { execFileSync } from "node:child_process";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const TABLES = [
  "carts", "consent_events", "touches", "segment_stats", "orders",
  "payment_links", "open_links", "audit_log", "activity", "action_intents",
  "approvals", "deferred_actions", "overpayments", "refunds", "ext_ref_map",
  "hold_tokens", "pay_tokens", "idempotency", "notification_outbox",
  "dead_letters", "policy_audit", "experiment_metrics", "cohort_assignments",
  "buyer_sessions", "buyer_key_caps", "buyer_api_keys", "admin_audit",
  "sibling_links", "incentive_reservations", "reconcile_runs", "ledger_checkpoints",
  // v5.0 tables (010)
  "credit_ledger", "reviews", "approval_patterns", "mandate_jtis", "reminders",
  "price_watches", "merchant_config", "ndr_cases", "cod_orders",
  "engagement_events", "policy_pending_edits", "identity_edges",
  "fee_audit_runs", "upsell_blocked_daily", "backtest_runs",
];

const MERCHANT_ID = "5a3ac6ce-b2c7-4b1f-a9db-45296841f30b";

async function main() {
  const client = await pool.connect();
  let wipeOk = false;
  try {
    await client.query("BEGIN");
    // Truncate only tables that exist (schema evolves; reset must not fail).
    const { rows: existing } = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
    );
    const have = new Set(existing.map((r: any) => r.tablename));
    for (const t of TABLES) {
      if (!have.has(t)) { console.log(`  skip ${t} (absent)`); continue; }
      await client.query(`TRUNCATE TABLE ${t} CASCADE`);
    }
    await client.query("DELETE FROM customers WHERE merchant_id = $1", [MERCHANT_ID]);
    await client.query("COMMIT");
    console.log("Reset done");
    wipeOk = true;
  } catch (e: any) {
    await client.query("ROLLBACK");
    console.error(e.message);
  } finally {
    client.release();
  }

  if (!wipeOk) { await pool.end(); process.exit(1); }

  // ── Full demo rebuild: SQL seed → placeholder verify → seed-bind ──
  // (seed-bind needs the HTTP server up; it binds identities through the
  // REAL ingestion endpoint. If the server is down we stop after the seed
  // and tell the operator the one follow-up command.)
  try {
    console.log("Seeding...");
    execFileSync("npx", ["tsx", "--env-file=.env", "seed.ts"], { stdio: "inherit" });

    const verifyClient = await pool.connect();
    try {
      const { rows } = await verifyClient.query(
        "SELECT count(*) AS n FROM customers WHERE identity_hash LIKE 'hash_%' OR contact_enc LIKE 'enc_%'"
      );
      console.log(`  Placeholder identities remaining: ${rows[0].n} (expected 0)`);
      if (Number(rows[0].n) !== 0) throw new Error("placeholders remain after seed");
    } finally {
      verifyClient.release();
    }

    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    let serverUp = false;
    try {
      const res = await fetch(`${baseUrl}/api/state`, { signal: AbortSignal.timeout(5000) });
      serverUp = res.status < 500;
    } catch { serverUp = false; }
    if (serverUp) {
      console.log("Binding demo identities via the real API...");
      execFileSync(process.execPath, ["--env-file=.env", "scripts/seed-bind.js"], { stdio: "inherit" });
    } else {
      console.log(`  Server not reachable at ${baseUrl} — run after start: npm run seed-bind`);
    }
    console.log("Reset complete. Restart the server; Riya fires in 15s.");
  } catch (e: any) {
    console.error(`Post-wipe sequence failed: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
