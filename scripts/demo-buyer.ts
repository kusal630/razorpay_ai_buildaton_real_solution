/**
 * demo-buyer.ts — AI-buyer commerce drill (governance moment, not a product
 * surface). Creates a session, quotes ~₹45,000 of earbuds, and submits
 * purchase-intent: policy MUST escalate (over auto-allow) to the approvals
 * inbox. `npm run demo:buyer` (server must be running).
 *
 * Auth: buyer API key via SELLABLE_BUYER_KEY env (printed once by npm run seed).
 */
const BASE = process.env.BASE_URL || "http://localhost:3000";
const KEY = process.env.SELLABLE_BUYER_KEY || "";
if (!KEY) {
  console.error("Set SELLABLE_BUYER_KEY to the buyer key printed by npm run seed.");
  process.exit(1);
}
const headers = { "Content-Type": "application/json", Authorization: `Bearer ${KEY}`, "Idempotency-Key": `demo-${Date.now()}` };

async function main() {
  const s = await (await fetch(`${BASE}/agent/sessions`, {
    method: "POST", headers,
    body: JSON.stringify({ mandate: { max_amount_paise: 5000000, purpose: "demo-buyer-drill" } }),
  })).json();
  console.log("session:", s.session_id, s.status);

  const qr = await fetch(`${BASE}/agent/sessions/${s.session_id}/quote`, {
    method: "POST", headers: { ...headers, "Idempotency-Key": `demo-q-${Date.now()}` },
    body: JSON.stringify({ items: [{ id: "a1000000-0000-4000-a000-000000000001", qty: 28 }] }),
  });
  const q = await qr.json();
  if (qr.status === 409) {
    console.log("Quote held out of stock (each drill reserves 28 units) — re-run npm run seed to restore stock, then retry.");
    process.exit(1);
  }
  console.log("quote total paise:", q.total_paise, "| mandate:", q.mandate?.signature?.slice(0, 12) + "...");

  const pi = await fetch(`${BASE}/agent/sessions/${s.session_id}/purchase-intent`, {
    method: "POST", headers: { ...headers, "Idempotency-Key": `demo-p-${Date.now()}` },
    body: JSON.stringify({ mandate: q.mandate }),
  });
  const pij = await pi.json();
  console.log("purchase-intent:", pi.status, JSON.stringify(pij).slice(0, 200));
  if (pi.status === 202 && pij.approval_id) {
    console.log("ESCALATED as required — deny it from the dashboard approvals inbox.");
  } else {
    console.log("NOTE: expected 202 escalated for a ₹45,000 order.");
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
