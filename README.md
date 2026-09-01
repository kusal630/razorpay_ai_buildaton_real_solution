# Sellable — AI Revenue Layer for Razorpay

An AI-powered revenue optimization system that recovers abandoned carts and drives incremental profit through intelligent incentive allocation, all running on Razorpay test mode.

## Status

**v4.1** — Verification audit complete. 78/78 tests passing. All patches applied.

| Metric | Value |
|--------|-------|
| Patch stack | v3.1 → v3.2 → v3.3 → v3.4 → v4.0 → v4.1 |
| Tests | 78 passing / 0 failing |
| Invariants | N1–N24 enforced |
| Design locks | DL1–DL10 |
| Database tables | 44 |
| Verdict | COMPLETE-PENDING-VERIFICATION |

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
- **Cancel-before-create** — at most one live link per cart, fails closed on error
- **Overpayment handler** — auto-refund ≤Rs.10k, escalate >Rs.10k

### Payment Failure Recovery (Flagship Demo)
- **Rs.0 default** — plain retry assistance, no incentive by default
- **Transactional consent** — consent anchored on payment attempt
- **Instant resolution** — works with zero snippet, zero waiting

### Consent & Privacy
- **Two-class consent** — transactional (recovery) vs marketing (upsell)
- **Consent classes** — incentivized recovery requires marketing consent, clamped to plain if missing
- **Consent evidence** — merchant_server source, evidence_reference, audit trail
- **PII redaction** — central `redactForPersist()` before all persistence
- **Opaque references** — HMAC-based ext_ref, sequential audit_seq never external

### Security & Compliance
- **Ledger serialization** — `pg_advisory_xact_lock` on all money paths
- **Identity tokens** — HMAC-SHA256, phone-precedence normalization
- **Audit chain** — hash-chained, nightly verification, alert on break
- **AI kill switch** — per-tenant + global, deterministic fallback when off
- **Dark-pattern filter** — fabricated scarcity, false urgency blocked
- **Claims linter** — banned/required terms enforced in code

### Economics
- **Unified uplift EV**: `inc_ev(b) = (theta_b - theta_0) * (margin - fee) - theta_b * incentive - ai_cost`
- **Budget reservation** — atomic conditional UPDATE, no overshoot
- **Profit tracking** — payment fees, incentive costs, net profit per order
- **ROAS dashboard** — incremental profit vs control with Wilson intervals
- **Fee basis** — entity fees when available, modeled fallback

### Durability
- **Redis AOF** — `appendfsync everysec` for crash recovery
- **Write-ahead intents** — lease-based state machine with notification outbox
- **Dual-path confirmation** — webhooks + poller + reconciler
- **Webhook re-scan** — stale events (>5min) automatically re-enqueued

## Invariants (N1-N24)

| # | Invariant | Enforcement |
|---|-----------|-------------|
| N1 | Ledger append serialized | `pg_advisory_xact_lock` on all paths |
| N2 | Two consent classes | Transactional + marketing |
| N3 | Public routes reject contacts | 422, reject-not-strip |
| N4 | Unified EV formula | Single `economics.upliftEv()` |
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

78 tests across 10 files:

| File | Tests | Coverage |
|------|-------|----------|
| policy.test.ts | 13 | Policy engine matrix, Thompson sampling, EV formula |
| v3_2.test.ts | 21 | Tracking hardening, consent classes, PII redaction, uplift EV, budget, claims |
| patches.test.ts | 12 | Economics, quiet hours, replay, consent, reconciliation, claims |
| intentExecutor.test.ts | 7 | Write-ahead intents, dedup, lease lifecycle |
| experiment.test.ts | 7 | HMAC assignment, incremental math, Wilson intervals |
| razorpay.test.ts | 5 | Payment links, webhook signature, dedup, idempotency |
| llm.test.ts | 3 | Circuit breaker, fallback |
| crypto.test.ts | 3 | AES-256-GCM encrypt/decrypt |
| pii.test.ts | 4 | Pseudonymize, encrypt at rest |
| auditLedger.test.ts | 3 | Append, update, chain verify |

## Running

```bash
# Start dependencies
~/local/bin/redis-server --port 6379 &
/tmp/pg-install/bin/postgres -D ~/pgdata &

# Install and build
npm install
npx tsc
mkdir -p dist/migrate && cp src/migrate/*.sql dist/migrate/

# Run migrations
DATABASE_URL="postgres://sellable:sellable@localhost:5432/sellable" npx tsx src/migrate.ts

# Seed data
npm run seed

# Run tests
npx vitest run

# Start server
node dist/server.js
```

## Dashboard

Access at `http://localhost:3000/ops` with:
- Email: `admin@sellable.io`
- Password: `admin123`

## Demo Script

### Flagship: Payment Failure Recovery (Riya)
1. Riya adds items to cart, proceeds to checkout
2. Payment fails (test VPA: `failure@razorpay`)
3. **Transactional consent anchored** on payment attempt
4. **Rs.0 plain retry link** sent immediately (no incentive needed)
5. Riya pays with `success@razorpay` — order captured

### Consent Gate (No-Consent Customer)
1. Customer without marketing consent, positive EV incentive proposed
2. **Incentive clamped to plain link** (consent_marketing_missing)
3. Ledger records: reason = `consent_marketing_missing`
4. System had a profitable play and declined to run it for lack of consent

### Riya Repeat Touch
1. Riya has marketing consent (checkout notice, evidence reference)
2. Rs.100 repeat touch with `consent_checked: marketing PASS`
3. Payment captured → attribution recorded

## Known Residuals

1. Legal characterizations pending counsel
2. Razorpay connect mechanism to verify
3. DPDP rules pending finalization
4. Lift measured per-merchant over time (modeled)
5. Protocol alignment directional
6. Test mode sends no notifications
7. Exactly-once has crash caveat (at-most-once per window)
8. Payment links shareable (loss bounded by incentive cap)
9. Marketing consent self-reported in demo
10. Identity resolution single-key (phone-precedence)
11. Fees and margins modeled where imported
12. Consent-class interpretation pending counsel
13. Production consent service pending
14. v4.x modules exist but not wired into demo path
15. Clean boot unverified on venue hardware

## Scope Freeze

This is the terminal state (v4.1). All further ideas go to `PRODUCT_ROADMAP.md`, not the codebase.

---

Built for the Razorpay AI Buildathon.
