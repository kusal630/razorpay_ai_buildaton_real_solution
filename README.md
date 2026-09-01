# Sellable — AI Revenue Layer for Razorpay

An AI-powered revenue optimization system that recovers abandoned carts and drives incremental profit through intelligent incentive allocation, all running on Razorpay test mode.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Public Site (Snippet)                     │
│  Cart tracking (anonymous) → Server-computed totals              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Server-to-Server (Secret Key)                  │
│  Contact binding → Identity token (HMAC) → Customer creation     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Core Pipeline                            │
│  Intent → Policy → Budget → Consent → Experiment → MoneyBus      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Razorpay (Test Mode)                           │
│  Payment links → Webhooks → Order resolution                     │
└─────────────────────────────────────────────────────────────────┘
```

## Key Features

### Cart Recovery
- **Thompson Sampling** for incentive optimization (Rs.0, 50, 100, 150 buckets)
- **Uplift-aware EV** — incentivizes only when spending is incremental vs control
- **Holdout experiments** — Wilson intervals, min-n=30, automatic pause on stop rules
- **Quiet hours** — IST 21:00-09:00 enforced, deferred queue with re-validation

### Payment Failure Recovery (Flagship Demo)
- **Rs.0 default** — plain retry assistance, no incentive by default
- **Transactional consent** — consent anchored on payment attempt
- **Instant resolution** — works with zero snippet, zero waiting

### Security & Compliance
- **Two-class consent** — transactional (recovery) vs marketing (upsell)
- **PII redaction** — central `redactForPersist()` before all persistence
- **Ledger serialization** — `pg_advisory_xact_lock` with retry
- **Identity tokens** — HMAC-SHA256, phone-precedence normalization
- **Audit chain** — hash-chained, nightly verification, alert on break

### Economics
- **Unified EV formula**: `EV = theta * (margin - fee - incentive) - ai_cost`
- **Budget reservation** — atomic conditional UPDATE, no overshoot
- **Profit tracking** — payment fees, incentive costs, net profit per order
- **ROAS dashboard** — incremental profit vs control with Wilson intervals

## Invariants (N1-N24)

| # | Invariant | Enforcement |
|---|-----------|-------------|
| N1 | Ledger append serialized | `pg_advisory_xact_lock` |
| N2 | Two consent classes | Transactional + marketing |
| N3 | Public routes reject contacts | 422, reject-not-strip |
| N4 | Unified EV formula | Single `economics.ev()` |
| N5 | Customer-unit randomization | HMAC assignment |
| N6 | Amounts server-set | Client totals rejected |
| N7 | Replay sandboxed | `replay_segment_stats` only |
| N8 | Claims hygiene | Banned/required terms enforced |
| N9 | Contact rejection | Public routes: 422 |
| N10 | Advisory lock | Ledger serialization |
| N11 | Consent classes | Transactional + marketing |
| N12 | Unified EV | Single formula |
| N13 | Session state machine | Strict transitions |
| N14 | PII redaction | Central `redactForPersist()` |
| N15 | Deferred re-validation | Full policy pipeline |
| N16 | Reference reuse | Same gateway reference |
| N17 | Uplift-aware EV | Incremental vs control |
| N18 | payment_failed Rs.0 | Default, governance exception |
| N19 | Action classes | Proactive/reactive/operational |
| N20 | Prompt hardening | Untrusted text framing |
| N21 | Server-side totals | Client amounts rejected |
| N22 | No bypass | All ops through intent/policy |
| N23 | Intent lifecycle | Lease-based with outbox |
| N24 | HMAC assignment | Server secret |

## Test Suite

78 tests across 10 files, covering:
- Policy engine (13 tests)
- Intent executor (7 tests)
- Experiment holdout (7 tests)
- v3.2 patches (21 tests)
- v3.1 patches (12 tests)
- Razorpay integration (5 tests)
- Crypto, PII, LLM (10 tests)
- Audit ledger (3 tests)

## Running

```bash
# Start dependencies
~/local/bin/redis-server --port 6379 &
/tmp/pg-install/bin/postgres -D ~/pgdata &

# Install and build
npm install
npx tsc
mkdir -p dist/migrate && cp src/migrate/*.sql dist/migrate/

# Run tests
npx vitest run

# Start server
node dist/server.js
```

## Dashboard

Access at `http://localhost:3000/ops` with:
- Email: `admin@sellable.io`
- Password: `admin123`

## Scope Freeze

This is the terminal state (v3.3). All further ideas go to `ROADMAP.md`, not the codebase.

---

Built for the Razorpay AI Buildathon.
