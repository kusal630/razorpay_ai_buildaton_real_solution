# Demo Script — 4 minutes, exact click-path

Assume a fresh `npm run reset:sample && npm run seed`, server on
`http://localhost:3000`, logged in as the seed admin. TEST ENVIRONMENT —
links are the delivery path; ledger entries are recorded, pre-settlement.

## 0:00 — The console (15s)

Open the Live Agent Console tab. Riya's cart fires by itself: TRIGGER →
INTENT → uplift decision (θ, EV math) → AGENT_THOUGHT mode:"llm" (strategy +
reasoning) → policy PASS rows → LINK CREATED with a real `plink_…` URL.
Expand the row: the deadline in the copy equals the stored hold expiry.

## 0:45 — Real money (60s)

Click the link → pay with `4111 1111 1111 1111` → within 15s the REAL revenue
counter ticks, the ledger shows PAID, UpsellBot fires. Say: "the counter only
moves on real payments; simulated money is badged and never lands here."

## 1:45 — The stops (75s)

Buyers & QA → Policy Drill: 20% BLOCKED in red, 15% issues. Terminal:
`SELLABLE_BUYER_KEY=<seed key> npm run demo:buyer` → ₹45,000 ESCALATES;
Approvals tab → Deny → feed confirms no Razorpay call. Buyers & QA → Inject
Payment Failure → calm ₹0 retry (we never pay to fix a failure).

## 3:00 — The refusals (45s)

Feed → Arjun's trigger: profitable offer, no marketing consent → clamped to
plain, reason ledgered. QA → run simulated day: SIMULATED moves, REAL does
not. Kill switch → RULES MODE badge, pipeline keeps earning → toggle back.

## 3:45 — Trust close (15s)

Ledger tab → Verify Chain (PASS + head hash). Feed → verified purchase badge
→ resolves to a ledger sequence. Settings → set ₹79 shipping → pay page
all-in total updates. Close: "an AI that can propose, but cannot spend — and
can prove every rupee it moved."
