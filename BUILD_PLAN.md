# BUILD_PLAN.md — Sellable v3

## Invariants (restated)

- **I1**: All money is integer PAISE. No floats anywhere on any money path.
- **I2**: LLM only proposes strategy/incentive; code validates, clamps, and executes.
- **I3**: Single gated money bus — only `lib/moneyBus.ts` imports Razorpay SDK.
- **I4**: Payment links use `reference_id = String(audit_seq)` for 1:1 reconciliation.
- **I5**: Webhooks: HMAC-SHA256, constant-time compare, async BullMQ processing, dedupe, dead-letter after 5 failures.
- **I6**: Dual-path confirmation: webhooks AND poller, first wins, second is no-op.
- **I7**: Hash-chained append-only audit ledger with daily checkpoints.
- **I8**: All state in Postgres, all async in BullMQ. Crash = zero lost work, zero double-charge.
- **I9**: Stock holds are atomic via `SELECT FOR UPDATE`. No oversell.
- **I10**: PII encrypted at rest (AES-256-GCM), decrypted only in money bus. LLM sees pseudonymous IDs.
- **I11**: LLM failure → deterministic fallback. Circuit breaker: 3 failures → open 60s.
- **I12**: Idempotency-Key required on all mutating ops/protocol endpoints.
- **I13**: Auth: argon2 + JWT httpOnly cookies + CSRF. Per-key auth for buyer agents. Tracking key for `/api/track/*`.
- **I14**: No fake/synthetic webhook tools. E2E uses real Razorpay test checkout.

## Phase Order

1. **P0 Foundation** — TS project, config+guards, pg migrations, pino logging, health/readiness, Docker Compose, migrate-on-boot
2. **P1 Crypto & PII** — AES-256-GCM, pseudonymize, encrypt-on-ingest, decrypt-only-in-moneyBus
3. **P2 Ledger & Policy** — auditLedger (append, resolve, verifyChain, checkpoints), policyEngine (table-driven), approvals
4. **P3 Money bus + Razorpay** — razorpayService (SDK wrapper), moneyBus (gated executor), webhook pipeline, poller, reconciler
5. **P4 Tracking & Scheduler** — /api/track/*, snippet, cartScanner, holdSweeper
6. **P5 RecoveryBot + Learning** — sharedBrain, Thompson sampling, velocity, budget, circuit breaker, fallback
7. **P6 UpsellBot + Chat** — upsell trigger, ChatAgent, pay page, chat negotiation
8. **P7 Protocol + Buyer Client** — /agent/* endpoints, hold atomicity, idempotency, buyer-agent library+CLI
9. **P8 E2E Tests** — Playwright specs against real Razorpay test checkout
10. **P9 Ops Hardening** — Auth UI, dashboard, alerts, RUNBOOK, CI workflow, seed.ts

## Potential Spec vs. Razorpay Doc Conflicts

- Razorpay payment_links `expire_by` is in **Unix timestamp** (seconds), not minutes. Adapt: `expire_by = now + HOLD_TTL_MIN*60`.
- Webhook signature: Razorpay sends `X-Razorpay-Signature` header. Raw body must be captured before any parsing (use `express.raw()` or Fastify `bodyParser: false`).
- Razorpay test mode VPA `success@razorpay` / `failure@razorpay` — confirmed in docs.
- Rate limits on Razorpay API: 100 req/min per key. Not an issue at our scale.
- `reference_id` on payment_link is optional in Razorpay docs but we require it (matches audit_seq).
