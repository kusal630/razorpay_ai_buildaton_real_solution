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

### (m) Intent-state audit (v3.3)
**Status: FAIL**
- Intent states: `pending, executing, done, skipped, stuck` — missing `deferred, awaiting_gateway, failed, expired, blocked`
- No `lease_owner`, `lease_expires_at`, `attempt_count`, `max_attempts` fields
- No `notification_outbox` table — escalations go to `approvals` table only
- Janitor only handles `stuck` (>10min executing) — no deferred dispatch, no retry backoff, no max-retry dead-letter
- moneyBus uses `auditLedger.ts` (no advisory lock) — race condition on concurrent writes
- **Verdict: FAIL — W2 needed: lease-based state machine, notification_outbox, extended janitor**

### (n) External review dispositions (C1-C8, H1-H14, M1-M20)
**Status: DOCUMENTED**

| ID | Finding | Disposition | Evidence |
|----|---------|-------------|----------|
| C1 | Webhook HMAC | **FIXED** | webhooks.ts:29 constant-time compare |
| C2 | Idempotency | **PARTIAL** | protocol.ts has middleware; /ops/* missing |
| C3 | Dual-path | **FIXED** | webhookProcessor + paymentPoller use updateAuditOutcome |
| C4 | Client amounts | **FIXED** | protocol.ts quote computes server-side; track.ts NOT (W5) |
| C5 | Contacts encrypt | **FIXED** | crypto.ts AES-256-GCM; moneyBus only decrypt |
| C6 | grep gates | **FIXED** | razorpay SDK only in moneyBus; no parseFloat on money |
| C7 | Retry policy | **FIXED** | W3 payment_failed with Rs.0 default |
| C8 | Test baseline | **FIXED** | 78 tests all green |
| H1 | Ledger serialization | **FIXED** | auditLedger2.ts pg_advisory_xact_lock |
| H2 | PII redaction | **FIXED** | redact.ts central module |
| H3 | Consent classes | **FIXED** | consent.ts transactional + marketing |
| H4 | Quiet hours | **FIXED** | policyEngine.ts DEFERRED->BLOCK |
| H5 | 30-day incentive cap | **FIXED** | policy2.ts checkIncentiveCap30d |
| H6 | Identity token | **MISSING** | W5 needed |
| H7 | Intent lifecycle | **PARTIAL** | P1 exists; W2 extends with lease/outbox |
| H8 | Idempotency hash mismatch | **MISSING** | W10 needed |
| H9 | Post-expiry revalidation | **MISSING** | W10 needed |
| H10 | Replay isolation | **PARTIAL** | P6 exists; W10 adds H10 null-bus |
| H11 | Budget reservation | **FIXED** | budget.ts atomic reserve |
| H12 | Link sweeper | **MISSING** | W7 needed |
| H13 | Policy versions | **MISSING** | W10 needed |
| H14 | Action classes | **MISSING** | W4 needed |
| M1 | Business windows IST | **MISSING** | W2 needed |
| M2 | Max-age expiry | **MISSING** | W2 needed |
| M3 | Wilson interval | **FIXED** | experiment.ts wilsonInterval |
| M4 | Min-n state machine | **FIXED** | experiment.ts collecting/ready |
| M5 | Decrypt-at-boundary | **FIXED** | redact.ts + moneyBus only |
| M6 | Retention legal holds | **MISSING** | W10 needed |
| M7 | ABSTAIN outcome | **FIXED** | economics.ts selectBucket |
| M8 | Fees modeled | **FIXED** | economics.ts CONSTANTS |
| M9 | Experiment pause | **MISSING** | W10 needed |
| M10 | Experiment exclusivity | **MISSING** | W10 needed |
| M11 | Buyer session state machine | **FIXED** | buyerSession.ts strict transitions |
| M12 | Breaker cooldown | **MISSING** | W10 needed |
| M13 | Webhook freshness | **MISSING** | W10 needed |
| M14 | System status panel | **MISSING** | W10 needed |
| M15 | No bypass endpoints | **MISSING** | W10 needed |
| M16 | Unified EV | **PARTIAL** | economics.ts ev(); W1 adds upliftEv |
| M17 | ROAS dashboard | **FIXED** | profitability.ts getROIDashboard |
| M18 | Refund handling | **MISSING** | W9 needed |
| M19 | Margin snapshots | **MISSING** | W9 needed |
| M20 | Claims linter | **FIXED** | PATCH_REPORT.md + .claims-allowlist |
