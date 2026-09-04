# Sellable — A Governed AI Revenue Agent for Razorpay Merchants

## What This Is

Sellable is an AI sales-agent system for merchants on Razorpay TEST mode. AI
agents **propose** revenue actions — recovering abandoned carts, retrying
failed payments, post-purchase upsell, and AI-buyer purchases — while
deterministic code **approves** every action against consent, margin, budget,
and counterfactual-measured economics. Every rupee lands on a tamper-evident,
hash-chained ledger.

One-line thesis: **an AI that can propose, but cannot spend — and can prove
every rupee it moved.**

This is the production system running in a test environment: same code, test
keys, sample data. Moving to live mode is a documented go-live gate, not a
code change (see `docs/GO_LIVE.md`).

## The Five Ideas That Make It Work

**The AI never touches money.** It picks strategy and writes copy; every number
comes from the database; policy is code, checked after the AI, every time.

**It only pays for the increment.** The decision formula prices each offer
against what would have happened anyway. It refuses to discount when the
customer would return regardless, and does nothing when acting loses money —
a ledgered "abstain".

**Every claim in every message is provable.** Deadlines, stock, and savings
counts are database facts resolved at send time; a claim that cannot be
grounded is stripped before sending.

**Honesty is measured, not asserted.** A holdout control group receives no AI
touches; lift is reported with confidence intervals and refuses to print on
small samples.

**Everything can stop.** Kill switch, circuit breakers, budget hard caps, and
human approval for large orders — every stop ledgered.

## Features

Revenue agents: abandoned-cart recovery (two-touch ladder with real enforced
deadlines); failed-payment retry (payment-method switch, one bounded retry);
post-purchase upsell (15% cap); conversational pay page with policy-gated
discount requests; AI-buyer commerce (signed cart mandates, GST invoices,
escalation for large orders).

Economics: incremental uplift EV on every decision; success-contingent
incentives (cost nothing unless money lands); typed incentives (cash /
gift-with-purchase at cost / shipping); daily budget with two-phase
reservation; refunds convert to store credit.

Learning: per-segment per-incentive statistics update from every outcome;
conservative decision rules (no acting on small samples); send-time
optimization; copy-strategy statistics.

Trust: ledger-verified reviews (the badge proves the purchase); the all-in
total displayed first on the pay page; real review distributions including
negatives; save-for-later exit; customer-chosen reminder times.

Observability: live agent console (watch every decision, policy check, and
rupee in real time); ledger verify; reconciliation; approvals inbox; merchant
patterns panel; policy editor with ceilings.

## Security & Trust Model

| Threat | Defense |
|--------|---------|
| AI inventing amounts or discounts | Schema validation: the model selects options, code injects all numbers |
| Prompt injection in product text or chat | Six validation layers (token whitelist, one-claim rule, length, humor scope, decline safety, CTA availability, anti-pattern strings) plus corrective retry, then rules fallback |
| Customer PII exposure | AES-256-GCM at rest; decrypted only in the payment module; every access logged; public routes reject contact fields |
| Anonymous abuse (fake carts, key guessing) | Public/secret track-key split, unguessable 128-bit tokens, rate limits |
| Budget overspend under concurrency | Atomic conditional reservation; two-phase reserve/settle/release |
| Crash between decision and send | Write-ahead intents with dedupe keys; at-most-once contact per window under crash — reconciliation catches strays |
| Double charging one cart | Cancel-before-create (fail closed); one live link per cart; overpayment auto-refund |
| Ledger tampering | Hash-chained rows, DB-level append-only trigger, external checkpoints — tamper-evident with external anchoring |
| Merchant misconfiguration | Platform ceilings no merchant edit can exceed; raises need 1h cooldown + step-up |
| Replay / tampered AI-buyer orders | Signed cart mandates (HMAC, expiring, single-use ids); GST invoices only with a valid GSTIN |
| Dark patterns | Grounded claims only; one psychological claim per message; no confirm-shaming — CCPA-aligned |

Five-layer defense in depth: the model is constrained, the validators check,
the policy engine decides, the money bus enforces, and the ledger proves.
**The ledger is the proof: any claim on the dashboard can be verified against
Razorpay's own records from the console.**

## How to Test Everything

### Prerequisites

- Node 20+, npm; a Supabase project (free tier works).
- Razorpay TEST-mode API keys. Test card `4111 1111 1111 1111`; test UPI
  IDs `success@razorpay` (approves) and `failure@razorpay` (declines).
- Any OpenAI-compatible LLM key (optional — the system runs in fully
  functional RULES mode without it, visibly labeled).

### Setup (10 minutes)

```bash
git clone <repo> && cd sellable
npm install
cp .env.example .env   # then fill it in (see below)
npm run setup          # schema + sample merchant, products, 23 customers,
                       # Riya's cart abandoned 25h ago, a 30-min-old failed payment
npm run doctor         # all green: real DB + Razorpay + LLM checks
npm run dev            # http://localhost:3000 → login
```

`.env` values: `DATABASE_URL` (Supabase session-pooler URI +
`?sslmode=require`); `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` (TEST mode);
`ADMIN_EMAIL` / `ADMIN_PASSWORD` (your choice); `APP_SECRET` and
`APP_ENCRYPTION_KEY` (generate: `openssl rand -hex 32`, and for the
encryption key `openssl rand -base64 32`); `LLM_BASE_URL` / `LLM_API_KEY` /
`LLM_MODEL` if available.

Scripts, one line each: `setup` (migrate + seed a fresh DB); `doctor`
(environment health: DB, Razorpay, LLM, migrations, seed); `dev` (server +
15s scheduler); `verify` (21 acceptance gates); `reset:sample` (wipe sample
data); `seed` (reload sample data); `demo:buyer` (AI-buyer escalation drill);
`backtest` (simulated-day replay via the dashboard route; needs a logged-in
session — see `scripts/backtest.ts` header).

### The 15-Minute Guided Tour

1. Watch the Live Agent Console for 15 seconds — Riya's cart fires
   automatically: trigger → intent → uplift decision (θ values, EV math
   visible) → AGENT_THOUGHT (the AI's strategy + reasoning, mode:"llm") →
   policy checks (each PASS visible) → LINK CREATED with a real Razorpay
   link. Expand the row: the message copy's deadline was filled from the
   actual hold expiry — every number provable.
2. Click the payment link URL → pay with the test card → within 15 seconds
   the REAL revenue counter ticks up, the ledger records PAID, and UpsellBot
   fires.
3. Governance montage: (a) trigger the policy drill — watch a 20% upsell get
   BLOCKED in red, 15% fallback issue; (b) run the buyer CLI
   (`SELLABLE_BUYER_KEY=<key from seed output> npm run demo:buyer`) — a
   ₹45,000 order ESCALATES to the approvals inbox; deny it — the feed
   confirms no Razorpay call was made; (c) inject a payment failure — watch
   the calm, ₹0-incentive retry (the system never pays to fix a failure).
4. The refusals (the differentiators): find Arjun's trigger — a profitable
   offer is available but there is no marketing consent → clamped to plain,
   reason ledgered. In the QA panel, run a simulated day — the SIMULATED
   counter moves, the real one doesn't. Watch a low-margin cart → ABSTAIN
   ("acting loses money").
5. Trust surface: click Verify Chain (PASS + head hash); run Reconcile
   (categories: matched / pending / exceptions); see the verified purchase
   badge resolve to a ledger sequence; set a shipping fee in Settings and
   watch the pay page's all-in total update.
6. Toggle the AI kill switch — the badge flips to RULES MODE, the pipeline
   keeps earning; toggle back.

### The Test Suite

`npm run verify` → 21 gates (exit 0). What each gate proves:

1. Doctor DB — the database answers. 2. Ledger chain — every hash links,
   tamper would show. 3. Dedupe — one live link per cart, duplicates
   impossible. 4–5. Policy matrix — incentive caps and escalation thresholds
   hold at the boundaries. 6. Consent — no marketing consent means no
   incentive, enforced. 7–8. Uplift fixtures — discount when incremental,
   plain when the customer returns anyway. 9. Failure order — the retry
   pipeline has its fixture. 10. Quiet hours — the time gate exists.
11. Budget — reservations cannot exceed the cap. 12. Pay tokens —
   unguessable link tokens resolve. 13. Kill switch — the stop path works.
14. Backtest route — simulated replay exists and is fenced off real money.
15. Overpayment — double pays converge idempotently. 16. Reconcile —
   exceptions surface by category. 17. Activity — the console feed persists.
18. No float money — integer paise everywhere. 19. SDK confinement —
   Razorpay access only through the money bus capability. 20. LLM honesty —
   amounts never originate in model output. 21. UI labels — simulated money
   is badged everywhere; ledger entries are recorded, pre-settlement.

`npm test` → 122 unit tests covering every decision rule, validator, and
hardening seam.

### What to Look For

Every payment link is a real Razorpay test object (`plink_…` — open it,
Razorpay serves it). Every ledger row's reference reconciles against
Razorpay's dashboard. The revenue counter only moves on real payments;
simulated activity is badged everywhere and never touches the real counter.

## Scope & Honest Limitations

- Single-merchant test deployment; multi-merchant isolation is designed, not
  proven here.
- Lift figures are modeled until live traffic — the dashboard labels which
  numbers are measured and which are priors.
- Test mode does not send notifications (links are the delivery path —
  stated in the UI footer).
- Legal characterizations (consent classes, telecom rules) are designed-for
  and require counsel review before production.
- Production go-live is a gated checklist, not an env flip — see
  `docs/GO_LIVE.md`.
- Integration-gated (machinery ready, external signal needed): COD-save live
  operation, NDR automation via courier webhooks, full settlement
  reconciliation wiring.

## Repository Structure

- `src/agents/` — recovery, failure-retry, upsell, chat, and shared brain
  (one brain, five voices).
- `src/lib/` — money bus, ledger, policy, economics, claims resolver,
  consent, identity, and hardening modules (one line each: money moves,
  proof accumulates, rules decide, numbers are measured, words are checked,
  permission is tracked, people are pseudonymous, seams are sealed).
- `src/routes/` — buyer protocol, tracking, webhooks, chat, ops, and v5
  operations.
- `src/jobs/` — scheduler workers (poller, sweeper, reconciler, v5 dispatch).
- `src/migrate/` — ordered SQL migrations (fresh-DB verified).
- `src/public/` — console (live feed, ledger, approvals, QA, settings) and
  pay page.
- `docs/` — DEMO.md (4-minute demo script), GO_LIVE.md (gated checklist),
  ARCHITECTURE.md (diagram + trust boundaries), SECURITY.md (threat/defense
  table with proving tests), PRODUCT_ROADMAP.md (terminal roadmap).
- `scripts/` — setup, seed, reset, doctor gates, buyer drill, backtest,
  claims linter. `verify.ts` — the 21 acceptance gates.

---

TEST ENVIRONMENT — Razorpay test mode; notifications are not delivered; links
are the delivery path. Ledger entries are recorded, pre-settlement.
