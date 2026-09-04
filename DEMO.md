# Sellable — Live Demo Guide

## Prerequisites

1. Postgres running with `sellable` database
2. Redis running on port 6379
3. Razorpay TEST keys configured in `.env`
4. LLM endpoint (optional — falls back to rules mode)

## Step 1: Setup

```bash
npm install
npm run seed
npm run doctor    # Confirm: db=green, razorpay=green, llm=yellow/green
```

## Step 2: Start Server

```bash
npm run dev
# Server starts on port 3000
# 15s scheduler loop begins
```

## Step 3: Watch the Pipeline Fire

Within 15 seconds, the scheduler will:
1. Find Riya's abandoned cart (₹1,598 earbuds, abandoned 25h ago)
2. RecoveryBot processes it through the full pipeline

Monitor via terminal output or:
```bash
# Check activity feed
curl http://localhost:3000/api/feed -N

# Or check DB directly
psql $DATABASE_URL -c "SELECT actor, type, summary FROM activity ORDER BY id DESC LIMIT 10;"
```

## Step 4: Open Dashboard

Navigate to `http://localhost:3000/public/dashboard/`

Login: `admin@sellable.dev` / `admin123`

### Tab 1: Overview
- Doctor status (green/yellow/red)
- Revenue counter (ticks on successful payment)
- Budget gauge
- Kill switch toggle

### Tab 2: Live Console
- Real-time SSE activity stream
- Shows every RecoveryBot step: TRIGGER → INTENT → UPLIFT → POLICY → LEDGER → LINK

### Tab 3: Ledger
- Hash-chained audit log
- Verify chain integrity
- Create checkpoints

### Tab 4: Approvals
- Pending policy escalations
- Approve/reject actions

### Tab 5: Buyers & QA
- QA tools to inject test scenarios
- Reconcile button
- Backtest runner

## Step 5: QA Tools

### Inject Abandoned Cart
```bash
curl -X POST http://localhost:3000/api/qa/inject-abandoned \
  -H "Content-Type: application/json" \
  -b "sid=admin-session" \
  -d '{"total_paise": 250000}'
```

### Check Payment Link Status
```bash
psql $DATABASE_URL -c "SELECT razorpay_link_id, status, amount_paise FROM payment_links;"
```

### Simulate Payment
In Razorpay test dashboard, complete the payment via the generated link.

## What You Should See

### In Terminal
```
[INFO] RecoveryBot processed cart
  cartId: "c0c0c0c0-0000-4000-a000-000000000088"
  seq: "15"
  incentivePaise: 5000
  decision: "ALLOW"
[INFO] Payment link created
  seq: "15"
  linkId: "plink_TXEVUZS6gZB2mq"
```

### In Dashboard (Live Console)
```
RecoveryBot  TRIGGER_DETECTED    Abandoned cart detected: C-88 (₹1598)
RecoveryBot  INTENT              Write-ahead intent created for cart C-88
RecoveryBot  UPLIFT_DECISION     ACTION: bucket ₹50 (θ₀=0.25, θ_b=0.50)
RecoveryBot  POLICY_EVAL         Policy: ALLOW — consent=PASS, velocity=PASS
RecoveryBot  LEDGER_PROPOSED     RecoveryBot create_payment_link → PROPOSED
RecoveryBot  LEDGER_SUCCESS      RecoveryBot create_payment_link → SUCCESS
RecoveryBot  LINK_CREATED        Payment link created (₹1598)
```

### In Database
```sql
SELECT actor, type, summary FROM activity ORDER BY id DESC LIMIT 10;
-- Full pipeline trace from TRIGGER to LINK_CREATED

SELECT razorpay_link_id, status, amount_paise, token FROM payment_links;
-- Live Razorpay payment link with sellable token

SELECT seq, actor, action, outcome, hash FROM audit_log ORDER BY seq DESC LIMIT 10;
-- Hash-chained audit ledger
```

## Verify Everything

```bash
npm run verify    # 21/21 gates
npm run doctor    # All green
```

## Story Truth (v4.2 — what we claim on stage, exactly)

- The ledger is a tamper-evident notebook — and every night a fingerprint of it is locked in a vault outside the shop (and emailed to the owner), so any rewrite breaks the match. The log itself is append-only, access-controlled, tamper-evident, with at-most-once effects and reconciliation detecting anomalies.
- One-discount-per-month can't be gamed by pretending to be three people: shared identity hashes, ₹0 first touches, velocity alerts, and lifetime caps watch for the rest.
- The system doesn't guess — it learns, by measuring every rupee it asks to spend. Chat discounts draw from their own measured segment; haggling that loses money is refused with the numbers on record.
- To complete a test payment, pay with the test card 4111 1111 1111 1111 (UPI test VPA only where verified).
- On the pay page, customers can ask — the manager decides, and we measure whether asking was worth answering. Chat runs under a turn cap and a per-link LLM budget; everyday questions are answered from database facts without spending a token.
- The control group stays clean because the gate keeps every experiment honest: control customers get plain links, no upsells, no chat widget, no discounts — while their outcomes still teach the baseline.

Closing line: The AI provides the intelligence. The rules provide the safety. The notebook provides the proof. The control group provides the honesty — and it stays clean, because the gate keeps every experiment honest. The statistics provide the improvement. Together: a spending agent that can propose but never spend, act but never hide, and learn — by measuring every rupee it asks to spend.

## Honest versions (v4.3 — what each moment truthfully is)

- Deadline: the 72-hour final call states the exact expiry the sweeper enforces — the timer is not theater. Watch the hold release; the stated deadline and the stored `expire_by` are byte-identical.
- Scarcity: stock claims render live `products.stock` counts or the claim is stripped. No count, no claim.
- Decline: every add-on offer declines with a plain "No thanks" — no confirm-shaming anywhere, and declining produces no further touch.
- Attribution: stacked together, the treatment bundle models +55–75% lift (modeled). The dashboard reports only measured lift with Wilson intervals and min-n honesty.
- Framing: this system implements only the grounded, honest counterparts of persuasion — no false urgency, no confirm-shaming, no basket sneaking, no nagging, no drip pricing (India CCPA Guidelines for Prevention and Regulation of Dark Patterns, 2023). The pay page carries the test-mode footer; urgency you cannot ground, you cannot send.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `EADDRINUSE` | `fuser -k 3000/tcp` |
| LLM yellow | Expected in RULES mode — system uses fallback |
| No activity | Wait 15s for scheduler, check cart is abandoned |
| Razorpay 400 | Check TEST keys in `.env` |
