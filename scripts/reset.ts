import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const TABLES = [
  "carts", "consent_events", "touches", "segment_stats", "orders",
  "payment_links", "open_links", "audit_log", "activity", "action_intents",
  "approvals", "deferred_actions", "overpayments", "refunds", "ext_ref_map",
  "hold_tokens", "pay_tokens", "idempotency", "notification_outbox",
  "dead_letters", "policy_audit", "experiment_metrics", "cohort_assignments",
  "buyer_sessions", "buyer_key_caps", "buyer_api_keys", "admin_audit",
  "sibling_links", "incentive_reservations", "reconcile_runs", "ledger_checkpoints",
];

const MERCHANT_ID = "5a3ac6ce-b2c7-4b1f-a9db-45296841f30b";

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const t of TABLES) {
      await client.query(`TRUNCATE TABLE ${t} CASCADE`);
    }
    await client.query("DELETE FROM customers WHERE merchant_id = $1", [MERCHANT_ID]);
    await client.query("COMMIT");
    console.log("Reset done");
  } catch (e: any) {
    await client.query("ROLLBACK");
    console.error(e.message);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
