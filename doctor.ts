import pg from "pg";
import Razorpay from "razorpay";

const dbUrl = process.env.DATABASE_URL || "";
const pool = new pg.Pool({
  connectionString: dbUrl,
  ...(dbUrl.includes("supabase.co") ? { ssl: { rejectUnauthorized: false } } : {}),
});

async function doctor() {
  const results: Record<string, { status: string; detail: string }> = {};

  // DB check
  try {
    const { rows } = await pool.query("SELECT 1 as ok");
    results.db = { status: "green", detail: "SELECT 1 OK" };
  } catch (err: any) {
    results.db = { status: "red", detail: err.message };
  }

  // Razorpay auth
  try {
    const rp = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID || "", key_secret: process.env.RAZORPAY_KEY_SECRET || "" });
    await rp.paymentLink.fetch("nonexistent_test_id");
    results.razorpay = { status: "green", detail: "API auth OK" };
  } catch (err: any) {
    // 400/404 means auth worked
    results.razorpay = { status: err.statusCode === 400 || err.statusCode === 404 ? "green" : "red", detail: err.statusCode === 400 ? "API auth OK (400 expected)" : err.message };
  }

  // LLM
  try {
    const url = process.env.LLM_BASE_URL;
    if (!url) { results.llm = { status: "yellow", detail: "RULES mode (no LLM)" }; }
    else {
      const resp = await fetch(`${url}/models`, { headers: { Authorization: `Bearer ${process.env.LLM_API_KEY}` }, signal: AbortSignal.timeout(3000) }).catch(() => null);
      if (!resp) { results.llm = { status: "yellow", detail: "RULES mode (LLM unreachable)" }; }
      else { results.llm = { status: resp.ok ? "green" : "yellow", detail: resp.ok ? "LLM OK" : `RULES mode (HTTP ${resp.status})` }; }
    }
  } catch (err: any) {
    results.llm = { status: "yellow", detail: "RULES mode (LLM unreachable)" };
  }

  // Schema: required tables exist (what setup actually guarantees — the
  // version table is vestigial across migration runners).
  try {
    const required = ["audit_log", "customers", "orders", "payment_links", "merchant_config",
      "reviews", "credit_ledger", "action_intents", "policy_rules", "segment_stats"];
    const { rows } = await pool.query(
      "SELECT COUNT(*) as cnt FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)",
      [required]
    );
    const cnt = Number(rows[0]?.cnt || 0);
    results.migrations = { status: cnt >= required.length ? "green" : "red", detail: `${cnt}/${required.length} required tables present` };
  } catch (err: any) {
    results.migrations = { status: "red", detail: err.message };
  }

  // Seed present
  try {
    const { rows } = await pool.query("SELECT COUNT(*) as cnt FROM products WHERE active = true");
    results.seed = { status: Number(rows[0]?.cnt || 0) > 0 ? "green" : "red", detail: `${rows[0]?.cnt || 0} active products` };
  } catch (err: any) {
    results.seed = { status: "red", detail: err.message };
  }

  // Print results
  console.log("\nDoctor Checks:");
  console.log("─".repeat(50));
  let allGreen = true;
  for (const [name, r] of Object.entries(results)) {
    const icon = r.status === "green" ? "✓" : r.status === "red" ? "✗" : "⚠";
    console.log(`  ${icon} ${name}: ${r.status} — ${r.detail}`);
    if (r.status === "red") allGreen = false;
  }
  console.log("─".repeat(50));
  console.log(allGreen ? "\n  All checks passed!" : "\n  Some checks failed!");

  await pool.end();
  process.exit(allGreen ? 0 : 1);
}

doctor().catch(() => process.exit(1));
