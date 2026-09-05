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

  // Razorpay auth — list endpoint authenticates first (fetch 404s even on
  // bad keys, so it cannot prove auth). Success = green; anything else = red.
  try {
    const rp = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID || "", key_secret: process.env.RAZORPAY_KEY_SECRET || "" });
    await rp.orders.all({ count: 1 });
    results.razorpay = { status: "green", detail: "API auth OK" };
  } catch (err: any) {
    const detail = err.statusCode === 401 || err.statusCode === 403
      ? "auth failed — check TEST keys"
      : (err.message || `unreachable (HTTP ${err.statusCode || "?"})`);
    results.razorpay = { status: "red", detail };
  }

  // LLM: endpoint reachable AND the pinned model listed (F2 — the pin is
  // verified, never rewritten).
  try {
    const url = process.env.LLM_BASE_URL;
    const pinned = process.env.LLM_MODEL || "bonsai-8b";
    if (!url) { results.llm = { status: "yellow", detail: "RULES mode (no LLM)" }; }
    else {
      const resp = await fetch(`${url}/models`, { headers: { Authorization: `Bearer ${process.env.LLM_API_KEY}` }, signal: AbortSignal.timeout(5000) }).catch(() => null);
      if (!resp) { results.llm = { status: "yellow", detail: "RULES mode (LLM unreachable)" }; }
      else if (!resp.ok) { results.llm = { status: "yellow", detail: `RULES mode (HTTP ${resp.status})` }; }
      else {
        const data = await resp.json().catch(() => ({})) as any;
        const models: string[] = Array.isArray(data?.data)
          ? data.data.map((m: any) => String(m.id))
          : Array.isArray(data?.models)
            ? data.models.map((m: any) => String(m.model || m.name || m.id))
            : [];
        console.log(`  provider models: [${models.join(", ")}]`);
        results.llm = models.includes(pinned)
          ? { status: "green", detail: `LLM OK (pinned model '${pinned}' available)` }
          : { status: "red", detail: `model '${pinned}' not available — provider offers: [${models.join(", ")}]` };
      }
    }
  } catch (err: any) {
    results.llm = { status: "yellow", detail: "RULES mode (LLM unreachable)" };
  }

  // Schema (F2): expected migrations DERIVED from files on disk, each
  // verified by effect (sentinel object). Missing + APPLY_MISSING=1 →
  // apply that file idempotently and record; otherwise RED naming it.
  // Never red-for-working, never green-for-genuinely-missing.
  try {
    const path = await import("node:path");
    const { migrationFiles, checkMigrations, applyMigrationFile } = await import("./src/lib/migrateCheck.js");
    const migrateDir = path.join(process.cwd(), "src", "migrate");
    const files = migrationFiles(migrateDir);
    let status = await checkMigrations(
      (sql: string, params?: unknown[]) => pool.query(sql, params as any[]) as any,
      files
    );
    if (!status.ok && process.env.APPLY_MISSING === "1") {
      for (const m of status.missing) {
        const file = m.split(" ")[0];
        if (!file.endsWith(".sql")) continue;
        try {
          await applyMigrationFile(
            (sql: string, params?: unknown[]) => pool.query(sql, params as any[]) as any,
            migrateDir, file
          );
        } catch (err: any) {
          status.missing = [...status.missing, `apply-failed:${file}`];
        }
      }
      status = await checkMigrations(
        (sql: string, params?: unknown[]) => pool.query(sql, params as any[]) as any,
        files
      );
    }
    results.migrations = status.ok
      ? { status: "green", detail: `${status.applied.length}/${status.expected.length} migrations applied (verified by effect)` }
      : { status: "red", detail: `missing: ${status.missing.join(", ")}` };
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
