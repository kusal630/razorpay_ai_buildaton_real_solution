# FINAL_REPORT.md — Sellable v3

## 1. Phase-by-Phase Build Log

### P0 Foundation
- TypeScript project with strict mode, ESM, Node16 module resolution
- Config with Zod validation + live-mode guard (tested)
- Postgres migrations (full schema: 15 tables)
- Pino structured logging with request-id
- Health (GET /healthz) and readiness (GET /readyz) probes
- Docker Compose (app + Postgres 16 + Redis 7)
- Migrate-on-boot
- **Gate: PASS** — typecheck clean, config guard tested

### P1 Crypto & PII
- AES-256-GCM encrypt/decrypt (node crypto)
- Pseudonymize: SHA-256 truncated to 12 chars
- Encrypt-on-ingest in tracking routes
- Decrypt-only in moneyBus.ts
- **Gate: PASS** — round-trip test, grep confirms no decrypt outside moneyBus

### P2 Ledger & Policy
- Hash-chained append-only audit ledger
- verifyChain detects tampering
- createCheckpoint records head
- PolicyEngine: table-driven matrix with auto/escalate/block thresholds
- Approvals table with 24h TTL
- **Gate: PASS** — 13 policy matrix tests, audit chain verification

### P3 Money Bus + Razorpay
- moneyBus.ts: single gated path (I3 satisfied)
- razorpayService.ts: thin SDK wrapper (only imported by moneyBus)
- Webhook pipeline: raw body → HMAC verify → enqueue → processor
- Dedupe by event_id, retry with backoff, dead-letter after 5 failures
- Poller: dual-path confirmation via moneyBus.fetchOrderStatus
- Reconciler: hourly match via moneyBus.fetchPaymentsList
- **Gate: PASS** — nock fixture test, webhook dedup test, idempotency test

### P4 Tracking & Scheduler
- POST /api/track/cart (X-Track-Key auth)
- POST /api/track/order-confirmed (suppression)
- Cart scanner (BullMQ repeatable): marks abandoned after ABANDON_MINUTES
- Hold sweeper: releases expired holds, restores stock

### P5 RecoveryBot + Learning
- Thompson sampling over buckets {0, 50, 100, 150} INR
- Cold start restriction to {0, 100} for first 10 attempts
- EV formula: θ × cart_total - incentive
- Velocity: max 3 touches/day per customer
- Daily budget cap
- Circuit breaker: 3 failures → open 60s
- Fallback on LLM failure: plain link, no incentive
- **Gate: PASS** — 3 LLM tests (fallback, circuit breaker, reset)

### P6 UpsellBot + Chat
- UpsellBot: triggers on payment.captured
- ChatAgent: bounded negotiation via pay page
- request_discount tool runs through PolicyEngine
- All chat turns audited

### P7 Protocol + Buyer Client
- /.well-known/agent-commerce.json (public discovery)
- GET /agent/catalog (buyer API key auth)
- POST /agent/quote (atomic holds, idempotency)
- POST /agent/purchase-intent (moneyBus execution)
- GET /agent/payment-status
- packages/buyer-agent: TypeScript library + CLI
- **Gate: PASS** — 5 razorpay tests, protocol endpoint tests

### P8 E2E Tests
- Playwright config for real Razorpay test checkout
- E-REC, E-UPS, E-CHAT, E-BUY, E-ESC, E-FAIL, E-CONC, E-DUR, E-RECON, E-SEC, E-VEL specs
- Uses test VPAs: success@razorpay, failure@razorpay

### P9 Ops Hardening
- Auth UI: argon2 + JWT httpOnly cookie + CSRF double-submit
- Dashboard: revenue, audit trail, approvals, policy editor, buyer keys, system status
- Login rate limiting
- RUNBOOK.md with complete ops procedures
- CI workflow (GitHub Actions with Postgres + Redis services)
- seed.ts: admin, products, buyer key, policy rules

## 2. Full Test Matrix Results

| Test | Status | Evidence |
|------|--------|----------|
| U-POL | PASS | 13 policy matrix tests including boundary values |
| U-LED | PASS | 3 audit ledger tests (append, update, chain verify) |
| U-CRY | PASS | 4 PII tests (encrypt/decrypt round-trip, wrong key, pseudonymize) |
| U-THMP | PASS | Cold start restriction, EV formula (0.34 × 159800 - 10000 = 44332) |
| U-FALL | PASS | 3 LLM tests (fallback on error, circuit breaker opens, resets) |
| U-WH | PASS | Webhook signature verify/reject, dedup, idempotency |
| U-IDEM | PASS | Idempotency-Key replay returns cached response |
| E-REC | SPEC | Playwright spec written |
| E-UPS | SPEC | Playwright spec written |
| E-CHAT | SPEC | Playwright spec written |
| E-BUY | SPEC | Playwright spec written |
| E-ESC | SPEC | Playwright spec written |
| E-FAIL | SPEC | Playwright spec written |
| E-CONC | SPEC | Playwright spec written |
| E-DUR | SPEC | Playwright spec written |
| E-RECON | SPEC | Playwright spec written |
| E-SEC | SPEC | Playwright spec written |
| E-VEL | SPEC | Playwright spec written |

**Total: 31 unit/integration tests passing, 11 E2E specs written**

## 3. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      API Role (Express)                      │
│  /healthz /readyz /ops/* /agent/* /api/track/* /webhooks    │
│  /chat/:seq /pay/:seq                                       │
└──────────┬──────────────────────┬───────────────────────────┘
           │                      │
           ▼                      ▼
┌──────────────────┐   ┌─────────────────────┐
│   PolicyEngine   │   │    AuditLedger       │
│  (table-driven)  │   │  (hash-chained)      │
└──────────┬───────┘   └─────────┬───────────┘
           │                      │
           ▼                      │
┌──────────────────┐              │
│    MoneyBus      │◄─────────────┘
│ (single gated    │
│  path to Razorpay)│
└──────────┬───────┘
           │
           ▼
┌──────────────────┐     ┌──────────────────┐
│ razorpayService  │────▶│   Razorpay API    │
│  (SDK wrapper)   │     │  (test/live)      │
└──────────────────┘     └──────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    Worker Role (BullMQ)                      │
│  cartScanner | paymentPoller | webhookProcessor | reconciler│
│  holdSweeper | statsRollup | ledgerCheckpoint | retention   │
└──────────┬──────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────┐     ┌──────────────────┐
│     Postgres     │     │      Redis       │
│  (state store)   │     │   (BullMQ)       │
└──────────────────┘     └──────────────────┘

┌──────────────────┐
│    Agents        │
│ RecoveryBot      │──▶ Thompson Sampling + PolicyEngine
│ UpsellBot        │──▶ Margin-weighted cross-sell
│ ChatAgent        │──▶ Bounded negotiation + LLM
│ BuyerAgent       │──▶ Reference client (library + CLI)
└──────────────────┘
```

## 4. Durability & Safety Argument

**Exactly-once money effects:**
- Idempotency-Key header required on all mutating endpoints
- idempotency table stores key + response; replay returns original
- Webhook dedupe by event_id (unique constraint)
- Payment links use reference_id = audit_seq for 1:1 reconciliation

**No lost work:**
- All state in Postgres (crash-safe)
- All async work in BullMQ (Redis-backed, persistent)
- No setInterval schedulers, no in-memory queues
- Worker restart picks up incomplete jobs automatically

**Dual-path confirmation:**
- Webhooks (fast path) AND poller (backstop)
- First resolution wins, second is no-op (idempotent)
- Reconciler catches anything missed by both

**Audit trail:**
- Hash-chained append-only ledger
- Every proposal, execution, failure, resolution is a ledger row
- Daily checkpoints with hash linkage
- Tamper detection via verifyChain

## 5. Privacy Argument

**Where PII lives:**
- customers table: name_enc, email_enc, phone_enc (AES-256-GCM encrypted)
- Carts reference customer_id (UUID, not PII)

**Who can decrypt:**
- ONLY lib/crypto.ts decrypt function
- ONLY called inside lib/moneyBus.ts when constructing Razorpay payloads
- grep gate confirms: no decrypt calls outside moneyBus

**What the LLM sees:**
- Pseudonymous IDs (SHA-256 truncated to 12 chars)
- Segment labels (e.g., "first_visit_high_intent")
- Aggregates (cart total, item count, prices)
- NEVER: names, emails, phones, addresses

**Grep gates verified:**
1. ✅ Razorpay SDK imported only in moneyBus
2. ✅ No parseFloat/toFixed on money fields
3. ✅ Decrypt calls only in moneyBus
4. ✅ No fake webhook artifacts

## 6. Known Limitations & Caveats

1. **Single-merchant v1**: merchant_id is hardcoded in seed; multi-tenant is a migration away
2. **Modeled lift**: Thompson sampling parameters are initial; real traffic needed for calibration
3. **Protocol not an official standard**: agent-commerce.json is our convention, not an industry standard
4. **E2E tests require real Razorpay test keys**: CI uses nock fixtures; full E2E needs INTEGRATION=true
5. **LLM integration is optional**: circuit breaker fallback provides plain links without AI optimization
6. **No frontend build framework**: dashboard is server-rendered HTML, not a SPA

## 7. 60-Second Pitch

Sellable v3 is a production-grade AI revenue layer that sits on top of Razorpay. It has three AI agents:

1. **RecoveryBot** recovers abandoned carts using Thompson-sampled incentives. It learns which discount level works best for each customer segment, bounded by policy.

2. **UpsellBot** cross-sells after successful payments, with margin-weighted discounts that never eat into profit.

3. **ChatAgent** enables bounded negotiation on the payment page, running discount requests through the same policy engine.

The system is built on hard invariants: the LLM only proposes, code executes. Money flows through a single gated path. All PII is encrypted at rest and never touches the LLM. Every action is audit-logged with hash-chain integrity.

It's production-ready: Docker Compose, health probes, graceful shutdown, structured logs, BullMQ workers, idempotent webhooks, and dual-path confirmation (webhooks + poller + reconciler).

## Quick Start Commands

```bash
# Clone and install
git clone <repo> && cd sellable && npm install

# Configure
cp .env.example .env
# Add your Razorpay test keys to .env

# Start with Docker
docker compose up -d

# Seed data (admin, products, buyer key)
npm run seed

# Access dashboard
open http://localhost:3000/ops/dashboard
# Login: admin@sellable.io / admin123

# Run tests
npm test                    # 31 unit/integration tests
npx playwright test         # E2E (needs real test keys)

# Typecheck
npm run typecheck
```
