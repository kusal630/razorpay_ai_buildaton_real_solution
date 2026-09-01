# AUDIT.md — Preflight Red-Team Verification

**Baseline: 31 tests passing (6 files)**

## Preflight Checklist

### (a) Webhook HMAC — raw-body route, constant-time compare, event-id dedupe
**Status: EXISTS**
- `src/server.ts:40` — `app.use("/webhooks", express.raw({ type: "application/json" }))` mounted BEFORE `app.use(express.json())` at line 42
- `src/routes/webhooks.ts:29` — `crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))` — constant-time
- `src/jobs/webhookProcessor.ts:12-16` — `INSERT INTO webhook_events (event_id, status) ... ON CONFLICT DO NOTHING` — dedupe by event_id
- **Verdict: PASS**

### (b) Idempotency-Key middleware on mutating /agent/* and /ops/* endpoints
**Status: PARTIAL**
- `/agent/quote` (protocol.ts:118) — has `idempotencyMiddleware`
- `/agent/purchase-intent` (protocol.ts:221) — has `idempotencyMiddleware`
- `/ops/*` endpoints — **MISSING** idempotency middleware
- **Verdict: PARTIAL — /ops/* needs idempotency on POST/PUT/DELETE**

### (c) Dual-path: poller + webhook resolve through one idempotent function
**Status: EXISTS**
- `src/jobs/webhookProcessor.ts` — processes `payment.captured`, `payment.failed`, `payment_link.paid`, `payment_link.cancelled`
- `src/jobs/paymentPoller.ts` — polls pending orders, resolves via `fetchOrderStatus`
- Both write `resolved_by: "poller"` or webhook in audit outcome_detail
- Both use `updateAuditOutcome` from auditLedger (idempotent by seq)
- **Verdict: PASS** — but no single shared resolver function; two separate paths with same outcome

### (d) Contacts: AES-256-GCM at rest; decrypt calls ONLY in moneyBus
**Status: EXISTS**
- `src/lib/crypto.ts:14-22` — AES-256-GCM encrypt/decrypt
- `src/lib/moneyBus.ts:73-75` — decrypt called ONLY here for customer name/email/contact
- grep gate confirms: no decrypt calls outside moneyBus
- **Verdict: PASS**

### (e) grep gates: razorpay SDK only in moneyBus; no parseFloat on money
**Status: EXISTS**
- `grep -rn "from.*razorpay" src/ --include="*.ts" | grep -v razorpayService | grep -v moneyBus` → empty
- `grep -rn "parseFloat\|toFixed" src/ --include="*.ts" | grep -i "paise\|price\|amount"` → empty
- **Verdict: PASS**

### (f) Retry policy: failed-payment retry uses same-or-lower incentive
**Status: MISSING**
- No retry handling exists after `payment.failed`
- No `failure_receipt` or `retry_url` in payment status responses
- Config has `RETRY_TTL_MIN=10` but it's unused
- **Verdict: MISSING — needs retry logic with same-or-lower incentive**

### (g) Existing test suite baseline
**Status: PASS**
- 6 test files, 31 tests, all green
- Tests: crypto(3), pii(4), policy(13), auditLedger(3), razorpay(5), llm(3)

## Findings Summary

| Item | Status | Action Required |
|------|--------|-----------------|
| (a) Webhook HMAC | PASS | None |
| (b) Idempotency-Key | PARTIAL | Add to /ops/* POST/PUT/DELETE |
| (c) Dual-path | PASS | None |
| (d) Contacts decrypt | PASS | None |
| (e) grep gates | PASS | None |
| (f) Retry policy | MISSING | Add retry with same-or-lower incentive |
| (g) Test baseline | 31/31 PASS | None |

### (h) Tracking-surface auth audit
**Status: FAIL**
- `src/routes/track.ts:10-13` — `verifyTrackKey` only checks `key.length > 0` — no hash, no split between public site key and secret server key
- Contact fields (`customer.email`, `customer.name`, `customer.phone`) accepted and stored as plaintext in `_enc` columns (lines 34-47)
- No rate limiting on track endpoints
- **Verdict: FAIL — single key, no hash, contacts accepted on public route, no throttles**

### (i) Ledger concurrency audit
**Status: FAIL**
- `src/lib/auditLedger.ts:40-63` — `appendAudit` does SELECT prev_hash then INSERT with NO transaction, NO `pg_advisory_xact_lock`
- Concurrent writers: webhook processor, payment poller, RecoveryBot, UpsellBot, ChatAgent, janitor, replay tool — **7 concurrent sources**
- Fork risk: two transactions read same prev_hash, both insert, chain breaks
- **Verdict: FAIL — no serialization, chain can fork under concurrency**

### (j) PII-at-rest scan
**Status: FAIL**
- `src/routes/track.ts:34-47` — `customer.email`, `customer.name`, `customer.phone` stored as **plaintext** in `email_enc`, `name_enc`, `phone_enc` columns
- `src/jobs/webhookProcessor.ts:130` — full Razorpay payload (contains email/contact) stored in `dead_letters.payload_json` **without redaction**
- `src/lib/auditLedger.ts` — `params_json` and `rationale_json` can contain plaintext PII if callers pass it
- No `pii.ts` redaction module exists
- **Verdict: FAIL — plaintext PII in track routes, dead_letters, and audit log**

### (k) Razorpay capability check
**Status: DOCUMENTED**
- Razorpay `GET /v1/payment_links` does NOT support `reference_id` query filter — only `id`, `status`, `limit`, `skip`
- Janitor must work via creation-window + amount + notes matching (filter-agnostic approach)
- **Verdict: PASS — filter-agnostic design confirmed**

## Findings Summary (updated)

| Item | Status | Action Required |
|------|--------|-----------------|
| (a) Webhook HMAC | PASS | None |
| (b) Idempotency-Key | PARTIAL | Add to /ops/* POST/PUT/DELETE |
| (c) Dual-path | PASS | None |
| (d) Contacts decrypt | PASS | None |
| (e) grep gates | PASS | None |
| (f) Retry policy | MISSING | Add retry with same-or-lower incentive |
| (g) Test baseline | 31/31 PASS | None |
| (h) Tracking auth | FAIL | Split keys, reject contacts, add throttles |
| (i) Ledger concurrency | FAIL | Add pg_advisory_xact_lock serialization |
| (j) PII-at-rest | FAIL | Central redaction module, encrypt at rest |
| (k) Razorpay filter | PASS | Filter-agnostic janitor design |

## Gaps Folded Into Patches

- **Gap (b)** → Folded into **P1** (write-ahead intents provide dedupe at the action level)
- **Gap (f)** → Folded into **P3** (retry with profit-based economics) + **P4** (payment.failed trigger)
- **Gap (h)** → Folded into **V1** (tracking hardening with public/secret key split)
- **Gap (i)** → Folded into **V2** (ledger serialization with advisory lock)
- **Gap (j)** → Folded into **V8** (central redaction module for persisted payloads)
- **Gap (k)** → Folded into **V7** (janitor filter-agnostic design confirmed)

### (l) Identity & ingestion audit (v3.3)
**Status: FAIL**
- Cart totals accepted from client in `track.ts:45` (`total_paise` from `req.body`) — NOT computed server-side
- Customer identities created in `track.ts:34-47` via plaintext email — no `identity_token` HMAC
- `/agent/purchase-intent` has hardcoded `amount_paise: 10000` (protocol.ts:227,254) — does not use quote total
- No normalization for email (lowercase/trim) or phone (E.164) before identity creation
- **Verdict: FAIL — W5 needed: server-side totals, identity_token, normalization**

### (m) Round-6 FL dispositions (v4.1)
**Status: DOCUMENTED**

| FL | Finding | Disposition | Evidence |
|----|---------|-------------|----------|
| FL1 | Tenancy isolation | **LOCKED** | DL4: RLS at product build |
| FL4 | Delivery timing | **ROADMAP** | Product roadmap F7 |
| FL5 | Pay URL sequential ID | **FIXED** | H3 pay_tokens.ts; residue: reference_id opaque via C3 |
| FL6 | Velocity limits | **ROADMAP** | Product roadmap F6 |
| FL7 | Risk engine | **ROADMAP** | Product roadmap F11 |
| FL8 | Fee basis | **FIXED** | H2 orders.fee_paise |
| FL9 | Ledger lock | **LOCKED** | DL2: per-merchant chains = Option A |
| FL10 | Intents path | **PARTIAL** | Outbox-shaped; residue: webhook re-scan (C4) |

### (o) Product-frame audit dispositions (Round 5, P1-P47)
**Status: DOCUMENTED**

| ID | Finding | Disposition | Evidence |
|----|---------|-------------|----------|
| P1 | Funds flow | **PARTIAL** | DL1 locked; Razorpay connect mechanism to verify |
| P2 | Cancel-before-create | **FIXED** | H1 linkLifecycle.ts cancelExistingLinks() |
| P3 | Fee basis | **FIXED** | H2 orders.fee_paise, fee_basis column |
| P7 | Out-of-order webhooks | **FIXED** | H8 webhookProcessor.ts handles refund.pending before payment.captured |
| P10 | Region | **LOCKED** | DL3 ap-south-1 |
| P14 | Dark-pattern filter | **FIXED** | H4 darkPatternFilter.ts |
| P15 | SSO/MFA/RBAC | **ROADMAP** | F1 in PRODUCT_ROADMAP.md |
| P16 | Legal dependencies | **ROADMAP** | L1 in PRODUCT_ROADMAP.md; counsel sign-off required |
| P17 | Isolation | **PARTIAL** | DL4 locked; RLS at product build |
| P18 | Per-tenant chains | **PARTIAL** | DL2 locked; per-merchant advisory keys |
| P19 | KMS/Secrets | **ROADMAP** | F2 in PRODUCT_ROADMAP.md |
| P20 | Rollout | **LOCKED** | DL6 shadow→canary→GA |
| P21 | API versioning | **ROADMAP** | F12 in PRODUCT_ROADMAP.md |
| P22 | Blue-green deploy | **ROADMAP** | F7 in PRODUCT_ROADMAP.md |
| P23 | Keys stored raw | **STALE** | Buyer keys hashed at rest (spec §6, I13). Real residue: mandate jti+caps (H9) |
| P24 | Provider abstraction | **ROADMAP** | F9 in PRODUCT_ROADMAP.md |
| P25 | Eval harness | **ROADMAP** | F11 in PRODUCT_ROADMAP.md |
| P26 | Public surfaces | **FIXED** | H3 pay_tokens.ts 128-bit unguessable |
| P27 | Buyer callbacks | **ROADMAP** | F13 in PRODUCT_ROADMAP.md |
| P28 | Partitioning/retention | **ROADMAP** | F4 in PRODUCT_ROADMAP.md |
| P29 | SLOs + runbooks | **ROADMAP** | F5+F6 in PRODUCT_ROADMAP.md |
| P30 | Checkpoints | **PARTIAL** | Per-day segmented locked (DL2); external destination at product build |
| P31 | AI kill switch | **FIXED** | H5 killSwitch.ts |
| P32 | Merchant trust | **ROADMAP** | F16 in PRODUCT_ROADMAP.md |
| P34 | theta_0 primary | **FIXED** | H6 theta0Estimator.ts control arm primary |
| P37 | Time handling | **FIXED** | H7 IST boundary tests |
| P38 | Durability | **FIXED** | H7 Redis AOF everysec |
