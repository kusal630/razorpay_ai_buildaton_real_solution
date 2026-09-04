/**
 * backtest.ts — runs the simulated-day backtest via the dashboard route and
 * prints the result. Server must be running and you must be logged in: pass
 * session cookie via SELLABLE_SESSION_COOKIE and CSRF via SELLABLE_CSRF.
 * Read-only reporting: the SIMULATED counter moves, the real one never does.
 */
const BASE = process.env.BASE_URL || "http://localhost:3000";
const cookie = process.env.SELLABLE_SESSION_COOKIE || "";
const csrf = process.env.SELLABLE_CSRF || "";
if (!cookie || !csrf) {
  console.error("Set SELLABLE_SESSION_COOKIE and SELLABLE_CSRF (copy from the logged-in dashboard session).");
  process.exit(1);
}

async function main() {
  const res = await fetch(`${BASE}/api/backtest/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `session=${cookie}`, "x-csrf-token": csrf },
    body: JSON.stringify({ n_journeys: 50 }),
  });
  console.log("status:", res.status);
  console.log(JSON.stringify(await res.json(), null, 1).slice(0, 1200));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
