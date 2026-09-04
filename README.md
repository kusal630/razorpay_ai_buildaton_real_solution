# Sellable — AI Revenue Layer for Razorpay

A production-grade AI revenue optimization system that recovers abandoned carts through intelligent incentive allocation, running against real Postgres (41+ tables), real Razorpay TEST-mode API, and real LLM with rules fallback.

## Status

**v5.0** — Full pipeline verified. 21/21 gates passing. End-to-end production flow operational.

| Metric | Value |
|--------|-------|
| Gates | 21/21 passing |
| Database | 41+ tables, 10 migrations |
| Pipeline | Cart → Intent → Policy → Budget → Consent → Experiment → MoneyBus → Razorpay |
| Mode | Razorpay TEST, LLM RULES fallback |
| Boot → Fire | <15 seconds |

## Quick Start

```bash
# Prerequisites: Postgres, Redis, Razorpay TEST keys

# Install and configure
npm install
cp .env.example .env   # Configure DATABASE_URL, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, LLM_BASE_URL

# Seed and verify
npm run seed
npm run doctor        # All green checks
npm run verify        # 21/21 gates

# Start server (includes 15s scheduler loop)
npm run dev

# Open dashboard
open http://localhost:3000/public/dashboard/
```

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| DATABASE_URL | postgres://sellable:sellable@localhost:5432/sellable | Postgres connection |
| RAZORPAY_KEY_ID | rzp_test_TWdsP3b1yNwwSy | Razorpay test key |
| RAZORPAY_KEY_SECRET | 0TZJPnbWP6B5X5LgPpiO8jPC | Razorpay test secret |
| LLM_BASE_URL | http://localhost:20128/v1 | LLM endpoint (falls back to rules) |
| APP_SECRET | sellable-app-secret-key-2024 | HMAC secret for ext_refs |

## Architecture

```
                    ┌──────────────────────────┐
                    │   15s Scheduler (server)  │
                    │  • Find abandoned carts   │
                    │  • Scan unprocessed carts │
                    │  • Poll payment links     │
                    └─────────┬────────────────┘
                              │
                    ┌─────────▼────────────────┐
                    │     RecoveryBot           │
                    │  1. TRIGGER_DETECTED      │
                    │  2. Consent check          │
                    │  3. Margin calculation      │
                    │  4. Write-ahead INTENT      │
                    │  5. Experiment assignment   │
                    │  6. Thompson Sampling       │
                    │  7. Uplift EV decision      │
                    │  8. Policy evaluation       │
                    │  9. Budget reservation      │
                    └─────────┬────────────────┘
                              │
                    ┌─────────▼────────────────┐
                    │     MoneyBus (I4)         │
                    │  1. Cancel prior links    │
                    │  2. Ledger PROPOSED       │
                    │  3. Razorpay order+link   │
                    │  4. Store link + token    │
                    │  5. Ledger SUCCESS        │
                    │  6. Activity broadcast    │
                    └─────────┬────────────────┘
                              │
                    ┌─────────▼────────────────┐
                    │     Razorpay TEST         │
                    │  Payment links → Webhooks  │
                    └──────────────────────────┘
```

## Invariants

| # | Invariant | Enforcement |
|---|-----------|-------------|
| I1 | Integer paise only | All money fields BIGINT, zero floats |
| I2 | SDK in one file | `razorpayService.ts` only |
| I3 | LLM never sees amounts | Filtered in `sharedBrain.ts` |
| I4 | Money bus 5-step order | Cancel → PROPOSED → Create → Store → Notify |
| I5 | Serialized ledger | `pg_advisory_xact_lock`, hash chain |
| I6 | HMAC webhooks | `APP_SECRET` verification |
| I7 | Write-ahead intents | Lease-based state machine |
| I8 | Dual-path resolution | Webhook + Poller → `resolvePayment()` |
| I9 | AES PII at rest | AES-256-GCM, access logging |
| I10 | Idempotency keys | On all external operations |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/healthz` | GET | Health check |
| `/.well-known/agent-commerce.json` | GET | Protocol discovery |
| `/api/feed` | GET | SSE activity stream |
| `/api/state` | GET | Dashboard state (auth) |
| `/api/activity` | GET | Activity log (auth) |
| `/api/ledger` | GET | Audit ledger (auth) |
| `/api/ledger/verify` | POST | Verify hash chain |
| `/api/ledger/checkpoint` | POST | Create checkpoint |
| `/api/approvals` | GET | Pending approvals |
| `/api/kill-switch` | POST | Toggle kill switch |
| `/api/policy-preset` | POST | Set policy preset |
| `/api/reconcile` | POST | Run reconciler |
| `/api/backtest/run` | POST | Run backtest |
| `/api/qa/inject-abandoned` | POST | QA: inject abandoned cart |
| `/api/qa/inject-payment-failure` | POST | QA: inject payment failure |

## Dashboard

Access at `http://localhost:3000/public/dashboard/` with:
- Email: `admin@sellable.dev`
- Password: `admin123`

5 tabs: Overview, Live Console, Ledger, Approvals, Buyers & QA

## Key Files

| File | Purpose |
|------|---------|
| `src/server.ts` | Main server + 15s scheduler |
| `src/agents/recoveryBot.ts` | Full cart recovery pipeline |
| `src/agents/upsellBot.ts` | Post-purchase upsell |
| `src/lib/moneyBus.ts` | I4 money bus + resolvePayment |
| `src/lib/ledger.ts` | I5 serialized audit ledger |
| `src/lib/activity.ts` | SSE activity broadcast |
| `src/lib/policyEngine.ts` | Policy matrix (W4) |
| `src/lib/economics.ts` | Uplift EV formula |
| `src/lib/budget.ts` | Budget reserve/release |
| `src/lib/extRef.ts` | HMAC opaque references |
| `src/routes/track.ts` | 5 tracking endpoints |
| `src/routes/ops.ts` | Dashboard API |
| `seed.ts` | Test data seeder |
| `doctor.ts` | Health checks |
| `verify.ts` | Gate verification |

## Demo Script

### Riya's Abandoned Cart (Full Pipeline)
1. Server starts, scheduler runs every 15s
2. Scheduler finds Riya's cart (abandoned 25h ago, ₹1,598 earbuds)
3. RecoveryBot fires: consent check → margin calc → write-ahead intent
4. Thompson Sampling picks ₹50 incentive bucket
5. Policy evaluates: all checks PASS
6. MoneyBus: cancel prior → ledger PROPOSED → Razorpay creates order + payment link
7. Payment link stored, ledger resolved to SUCCESS
8. Dashboard shows live activity feed with full pipeline trace
9. Link appears in Ops panel — Riya can pay via the Razorpay link

### Payment Failure Recovery
1. Payment fails during checkout
2. Transactional consent anchored on attempt
3. Rs.0 plain retry link created immediately
4. Customer retries and succeeds

## License

Built for the Razorpay AI Buildathon.
