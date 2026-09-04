# PATCH_REPORT.md v4.3 — Persuasion Layer: grounded, gated, measured (final feature pass)

## Test Results

```
Test Files  10 passed (10)
      Tests  78 passed (78)
```

Live gates (`scripts/gates-v42.ts`, fresh re-run at close): U-ARM ✓, U-CANCEL-RACE ✓,
U-LIFETIME ✓, U-CHAT-SEG ✓, U-CHAT-COST ✓, E-TWO-TOUCH ✓, U-BUCKET75 ✓,
U-REFUND-ALARM ✓, U-CHECKPT-MAIL ✓, U-GROUND ✓, E-LADDER ✓, U-COUNTDOWN ✓,
U-FAILCOPY ✓, U-FASTADD ✓, U-REASSURE ✓, U-STRATEGY ✓, U-SOCIAL ✓, U-FATIGUE ✓.
`npm run verify`: 21/21. `npm run lint:claims`: GREEN (DEMO, README, PATCH_REPORT, dashboard).

## Patches Applied (G1–G10)

### G1 — Grounded-Claims Resolver (N28)
- New `claims.ts`: `[claim:type:ref]` tokens (stock/expiry/social_proof/saved_amount),
  live-DB resolution at send time, strip + template fallback + `claim_ungrounded` ledger note.
- Validation step 4.5 in `sharedBrain.ts`: LLM bare numbers must trace to feasible
  buckets/prices/policy numbers; token syntax documented via user-content rule.
- Wired pre-send in recovery/upsell/chat (code copy checked against facts; templates pre-grounded).
- **GATE U-GROUND**: unresolvable stock → stripped + template + ledgered; stock=3 → "Only 3 left" + recorded resolution.

### G2 — Ladder Completion
- 24h incentivized links expire +48h (`ttl_seconds`/`expire_by_iso` threaded verbatim through
  moneyBus); T+1h endowment frame on the real hold; T+72h `processFinalCall` (same incentive,
  no new budget, live-link reuse else re-issue preserving the deadline, once per lifetime,
  control gets plain); `sweepExpiredLinks` releases holds + budget; scheduler final scan.
- Drive-by fixes: Razorpay cancel now uses `POST /v1/payment_links/:id/cancel` (SDK `edit()` 404s
  live); create-path 429s back off and retry.
- **GATE E-LADDER**: 1h plain → 24h ₹100 (+48h) → final on the exact stored deadline (U-DEADLINE
  ISO equality) → sweeper releases; one incentive, three intents, all grounded.

### G3 — Pay Page
- `/pay/:token` renders `expires_in_seconds` (enforced deadline: min of gateway/offer expiry),
  live `stock`, trust strip (merchant name + Razorpay badge), fresh-only `social_proof`.
  Unknown/tampered sources omit the claim. **GATE U-COUNTDOWN** ✓ incl. tamper omission.

### G4 — Failure Method-Switch
- New `failureRetryBot.ts`: failed-order scan, ₹0-always retry, recency classes
  (reactive <60min / proactive after), code-appended method-switch sentence grounded on the
  stored failed method, transactional class, `recovery_retry` intents. No arm gate (transactional).
- **GATE U-FAILCOPY**: frame present, no incentive, recency units + live reactive path green.

### G5 — Fast Add-On
- Upsell links: single item, pre-filled customer contact (decrypted ONLY in moneyBus),
  10-min enforced offer window (30-min gateway floor documented), "ships in the same box" framing.
- Stored-instrument-implication and false-consensus wordings added to the copy filter
  (exact strings in darkPatternFilter.ts, deliberately not quoted here) and enforced at
  send time on redacted (grounded-numbers-blind) copy.
- **GATE U-FASTADD**: one link, 596s offer TTL, live prefill + framing observed on the TEST link.

### G6 — Reassurance
- `sendReassurance` in `resolvePayment`: `saved_amount` token renders only when incentive>0
  and paid, else stripped; help line; outbox row + feed event; no upsell inside.
- **GATE U-REASSURE**: ₹0 → no saved claim; ₹100 paid → "You saved ₹100".

### G7 — Copy Strategy
- `message_strategy` (5 values) LLM-chosen + ε=10% exploration (`copyStrategy.ts`);
  recorded on ledger PROPOSED + `strategy_stats` outcomes (attempt at send, success at resolve);
  `/api/strategy-stats` + dashboard table with min-n honesty (rate withheld while collecting).
- **GATE U-STRATEGY**: 50 fixtures → all five ≥5, forced-exploration unit, ledger field,
  table split + collecting state + dashboard wiring.

### G8 — Social Proof
- `computeSocialProof()`: trailing-7d gateway payments attributed via
  order→link→cart→items with distinct buyers; `social_stats` upsert; nightly + boot run.
  Resolver rejects rows >26h. Drive-by fix: list calls use `payments.all()` (`fetch` takes an ID).
- **GATE U-SOCIAL** (nock): 127 fixture payments → "127 bought", stale row suppressed.

### G9 — Fatigue
- `fatigue.ts`: consecutive unengaged touches (pay = engagement; opens untracked) → 2× spacing;
  logged as `fatigue` in policy checks (never hard-BLOCKs); enforced as scheduler skips.
- **GATE U-FATIGUE**: doubling observed + logged, engagement resets.

### G10 — Linter + Docs
- claimsLinter: four banned phrases; `/modeled/i` required; numbers enforced mechanically (U-GROUND).
- DEMO.md story-truth + honest-versions section (deadline/stock/decline/attribution/framing,
  modeled +55–75% figure, CCPA dark-patterns frame); roadmap R1–R6 folded; pay footer kept.
- **GATE U-LINTER2**: `npm run lint:claims` GREEN over narrative docs + dashboard UI strings.

### Ledger race repair (found mid-pass, fixed under N2 work)
- `resolveLedger` rewrote digests after successors chained → break at seq 29 under
  gate×scheduler concurrency. Fix: merchant lock + `cascadeRelink()` in both resolve paths,
  ts→ISO normalization going forward. One-time relink (content untouched). Interleaved
  append+resolve hammer stays green.

---

## Residuals Update (v4.3)

Prior 21 residuals stand, plus:
22. **Persuasion is grounded** — every customer-facing number traces to a DB fact or is stripped (U-GROUND).
23. **Ladder complete** — 1h/24h/72h with enforced deadlines; sweeper releases holds (E-LADDER).
24. **Chat/failure/upsell surfaces measured** — chat segment θ, retry tone arm, fast add-on TTL (U-CHAT-SEG/U-FAILCOPY/U-FASTADD).
25. **Copy psychology measured lite** — five strategy arms + ε-exploration; full strategy×bucket bandit is roadmap R6.
26. **Refund + checkpoint ops live** — anomaly alarm (alarm-only) and emailed fingerprints (U-REFUND-ALARM/U-CHECKPT-MAIL).
27. **`sibling_links` still written by nothing** (dead table, kept for schema compat).
28. **Opens untracked** — fatigue engagement = pay events only.
29. **Delivery ETA omitted** — no merchant config field held; reassurance ships without it.
30. **Hammer/race/fixture rows in audit_log** — labeled test actors, chained and valid; TEST-env noise.

---

## STOP RULE ENGAGED (v4.3 — feature-closed as well as design-frozen)

All v4.3 gates green + full suite green + linter green. Roadmap items stay in
PRODUCT_ROADMAP.md. Remaining hours: rehearsal, backup recording, venue-network payment check.

# PATCH_REPORT.md v4.2 FINAL — Experiment Integrity, Cancel Race, Revenue Lever, Story Truth

## Test Results

```
✓ tests/llm.test.ts (3 tests)
✓ tests/crypto.test.ts (3 tests)
✓ tests/pii.test.ts (4 tests)
✓ tests/auditLedger.test.ts (3 tests)
✓ tests/patches.test.ts (12 tests)
✓ tests/experiment.test.ts (7 tests)
✓ tests/v3_2.test.ts (21 tests)
✓ tests/intentExecutor.test.ts (7 tests)
✓ tests/policy.test.ts (13 tests)
✓ tests/razorpay.test.ts (5 tests)

Test Files  10 passed (10)
      Tests  78 passed (78)
```

Live gates (`scripts/gates-v42.ts`): U-ARM ✓ (10 checks), U-CANCEL-RACE ✓ (6),
U-LIFETIME ✓ (3), U-CHAT-SEG ✓ (4), U-CHAT-COST ✓ (5), E-TWO-TOUCH ✓ (7),
U-BUCKET75 ✓ (4), U-REFUND-ALARM ✓ (5), U-CHECKPT-MAIL ✓ (5).
`npm run verify`: 21/21. `npm run lint:claims`: GREEN (DEMO, README, PATCH_REPORT).

---

## Patches Applied (P1–P10)

### P1 (N1 — Experiment Integrity)
- `experiment.ts`: `isExperimentRunning()` (running/active/approved), `getArm()` (stored row,
  else deterministic derivation from identity_hash), `getCustomerArm()`.
- `upsellBot.ts`: control arm → SKIP + ledger `{action:'arm_suppressed', arm:'control'}`.
- `routes/chat.ts`: `/pay/:token` carries server-side `chat_enabled:false` for control.
- `chatAgent.ts`: `request_discount` hard-refuses for control sessions.
- `recoveryBot.ts`: control path tagged with fixed neutral copy (brain never consulted).
- Transactional paths (resolution, stats) untouched — control outcomes still feed θ₀.
- **GATE U-ARM**: control customer → plain ₹0 link, paid, revenue counted, bucket-0 stats ticked,
  zero upsell links/thoughts, one arm_suppressed row, chat widget off.

### P2 (N2 — Cancel-Race Branch)
- `moneyBus.ts`: cancel errors now check live link status. Paid → `resolvePayment` immediately,
  intent done, NO replacement link, ledger `cancel_failed_link_paid_resolved`. Open/pending →
  2 retries w/ backoff, then existing fail-closed abort.
- `recoveryBot.ts`: handles `cancel_race_paid` (release unspent reservation, complete intent).
- Drive-by fix the gate exposed: cancellations used SDK `edit()` (404s live); now use the real
  `POST /v1/payment_links/:id/cancel` endpoint at all three call sites.
- **GATE U-CANCEL-RACE** (nock): resolution fired, no new link, ledger row, intent done,
  upsell suppressed.

### P3 (N3 — Lifetime Incentive Cap)
- `policy2.ts`: `checkIncentiveLifetime()` — settled (paid) incentivized links per identity_hash,
  `{max_count: 3, max_total_paise: 30000}`. Enforced in `policyEngine.ts` beside the 30-day cap;
  plain links unaffected. Address-velocity deferred to roadmap (no fulfillment data).
- **GATE U-LIFETIME**: 3 priors → incentive BLOCKED with `lifetime_incentive_cap`; plain ALLOW.

### P4 (N4 — Chat as a Measured Segment)
- New `chatEconomics.ts`: `evaluateChatGrant()` (uplift EV on `chat_requested` θ),
  `recordChatAttempt()` / `recordChatSuccess()` (attempt at ask, success at resolution via
  audit rationale trigger). Eligibility cart ≥ ₹1,000; circuit breaker refuses; nearest-bucket
  mapping on the canonical list. Refusals ledgered (`chat_segment_ev_negative` etc.).
- **GATE U-CHAT-SEG**: 10 asks/1 success → θ≈0.167 → EV-negative refuse; hot bucket grants.

### P5 (N7 — Chat Cost Limits)
- `sharedBrain.ts`: token usage threaded through (`LLMUsage`, chars/4 estimate fallback, summed
  across retries; zeros in rules mode).
- New `chatSession.ts`: turn cap 10, per-link LLM budget ₹5 (500 paise), FAQ classifier
  (price/stock/expiry from DB facts, intent-keyed 5-min cache, zero LLM), `ai_usage` metering,
  polite lockout. `chatAgent.ts` enforces gates before any LLM spend.
- **GATE U-CHAT-COST**: 15 rapid turns → 10 answered, 5 refused; FAQ billed zero tokens.

### P6 (R1 — Two-Touch Recovery)
- `recoveryBot.ts`: `stage: early|24h`; intent action types `recovery_early`/`recovery_24h`;
  early = plain ₹0 on zero touches, velocity-capped at 2/day, quiet-defers like built;
  paid-skip for converted carts; stats feed the ACTUAL bucket used (early → bucket 0).
- `server.ts`: early-window scan (abandoned ≥1h <24h, zero touches, no early intent).
- **GATE E-TWO-TOUCH**: 90-min cart → early plain link + intent + touch+1; simulated 24h →
  second link + `recovery_24h` intent; paid cart skipped with `already_paid`.

### P7 (R4 — ₹75 Bucket)
- `economics.ts`: `INCENTIVE_BUCKETS = [0, 5000, 7500, 10000, 15000]` (single source; recovery
  imports it); rules-brain template added; `seed.ts` prior θ(7500)=0.28 + live row.
- **GATE U-BUCKET75**: margin-35000 fixture → EV picks 7500; policy PASS at 7500, margin-floor
  ESCALATE at 10000.

### P8 (S4 — Refund-Volume Anomaly Alarm)
- New `refundAlarm.ts`: hourly count+volume vs trailing-7d baseline per tenant + platform;
  >5x (or minimum smoke on zero baseline) → alert activity + `refund_anomaly` dashboard banner
  (24h TTL via `alert_flags`) + ledger row. Alarm only, never blocks.
- `server.ts`: hourly job + boot run. `ops.ts` `/api/state` carries `alerts`; dashboard renders banner.
- **GATE U-REFUND-ALARM**: 6-refund burst → tenant+platform fired, banner, alert, ledger row.

### P9 (S5 — Merchant-Emailed Checkpoint)
- `ledger.ts`: `sendCheckpointEmail()` ({date, head_seq, head_hash}; flagged by
  `CHECKPOINT_EMAIL_ENABLED`; webhook `CHECKPOINT_EMAIL_WEBHOOK`/`ALERT_WEBHOOK_URL` provider,
  else mock transport that logs; failure warns, file unaffected) + activity trail.
  `createCheckpoint()` returns `{id, file, email}`.
- **GATE U-CHECKPT-MAIL**: checkpoint → mock-sent with head hash, file verified, event logged.

### P10 (Story Truth)
- `DEMO.md`: "Story truth" section with the six corrected claims + corrected closing line.
- `PATCH_REPORT.md`: de-quoted banned-term mentions (points at `BANNED_PATTERNS` instead).
- New `scripts/lint-claims.ts` + `npm run lint:claims`.
- **GATE**: linter GREEN over DEMO.md, README.md, PATCH_REPORT.md.

### Ledger race repair (found by E-TWO-TOUCH, fixed under N2 work)
- Root cause: `resolveLedger` rewrote a row's digest after successors had chained to it
  (overlapping append windows across processes) → continuity break at seq 29.
- Fix: merchant advisory lock + `cascadeRelink()` successor re-pointing in `resolveLedger`
  and `moneyBus.resolvePayment`; resolve path normalizes ts to ISO going forward.
- One-time relink of seq 29→head (content untouched); interleaved append+resolve hammer
  (12 ops × 2 lanes) leaves the chain green. Full detail in git history.

---

## Residuals Update (v4.2)

Prior 15 residuals stand, plus:
16. **Holdout integrity enforced (U-ARM)** — control arm fully suppressed on proactive surfaces.
17. **Lifetime incentive cap in force** — 3 incentives / ₹300 per identity, forever.
18. **Address-velocity fraud check deferred** — needs fulfillment data we do not hold (roadmap).
19. **Chat-discount economics measured** — `chat_requested` θ loop live; haggling that loses money is refused on record.
20. **Checkpoint hash emailed** — nightly/route-triggered, feature-flagged, mock transport in test.
21. **Hammer/race test rows in audit_log** — labeled `hammer_test`/`race_test`, outcome SKIPPED, chained and valid; test-env noise, not customer data.

---

## STOP RULE ENGAGED

All v4.2 gates green, full suite green, linter green. Design frozen and audit-closed per the
v4.2 patch prompt. Remaining hours: rehearsal, backup recording, venue-network payment check.

# PATCH_REPORT.md v4.1 — Consent-Class Correction + Four Residues

## Test Results

```
✓ tests/llm.test.ts (3 tests)
✓ tests/crypto.test.ts (3 tests)
✓ tests/pii.test.ts (4 tests)
✓ tests/auditLedger.test.ts (3 tests)
✓ tests/patches.test.ts (12 tests)
✓ tests/experiment.test.ts (7 tests)
✓ tests/v3_2.test.ts (21 tests)
✓ tests/intentExecutor.test.ts (7 tests)
✓ tests/policy.test.ts (13 tests)
✓ tests/razorpay.test.ts (5 tests)

Test Files  10 passed (10)
     Tests  78 passed (78)
```

---

## Patches Applied (C1-C6)

### C1 — Consent Classes for Money Content
**Status: FIXED**
- `consentPolicy.ts`: action→class map (transactional/marketing/reactive)
- An incentivized proposal without verified marketing consent is CLAMPED to plain action (not blocked)
- Clamp visible in policy_audit with reason `consent_marketing_missing`
- **Gate E-CONS3**: (a) transactional-only + positive-EV incentive → plain link, clamp ledgered; (b) marketing consent event → incentive proceeds; (c) payment.failed retry proceeds on transactional consent at 23:00

### C2 — Consent Evidence
**Status: FIXED**
- `consentEvidence.ts`: source (merchant_server | self_reported | checkout_notice), evidence_reference
- `consent_events` table with evidence fields
- Merchant-server route only for marketing consent (public routes rejected)
- Demo seed: Riya checkout-notice consent event
- **Gate U-CONSENT-EV**: consent evidence recorded, queryable, audit-trail

### C3 — Opaque External References
**Status: FIXED**
- `extRef.ts`: ext_ref = HMAC(EXT_REF_SECRET, audit_seq) truncated to 64-bit
- `ext_ref_map` table: ext_ref ↔ audit_seq internal mapping
- Sequential audit_seq never leaves internal surfaces
- Receipts, public APIs use ext_ref
- **Gate U-EXTREF**: receipt/reference probing yields nothing enumerable; reconciliation 1:1

### C4 — Webhook Re-scan
**Status: FIXED**
- `webhookRescan.ts`: janitor scans pending/received >5min, re-enqueues
- Idempotent resolution prevents double effects
- **Gate U-WHRESCAN**: simulated enqueue failure → re-scan processes exactly once

### C5 — Cancel-Before-Create Fails Closed
**Status: FIXED**
- `linkLifecycle.ts`: cancelExistingLinks returns { cancelled, failed, failedLinks }
- Cancel error → status 'cancel_failed', new link NOT issued
- Ledger failure, alert via log
- **Gate U-CBC2**: cancel API error → no new link exists for cart

### C6 — Claims-Linter v2
**Status: FIXED**
- `claimsLinter.ts`: banned terms, required phrases, allowlist support
- BANNED: six absolute-claim patterns (unconditional-assurance and absolute-safety
  phrasing — exact strings live in claimsLinter.ts BANNED_PATTERNS, deliberately not
  quoted here so this report passes its own linter)
- REQUIRED: "at-most-once ... with reconciliation", "append-only, access-controlled, tamper-evident", "transactional consent covers payment-status...", "incentivized recovery requires marketing consent", "estimated until reconciliation"
- `.claims-allowlist`: unchanged from prior review

---

## Migration Summary

| Version | Tables Added | Purpose |
|---------|-------------|---------|
| 001_initial_schema | 20 | Base tables |
| 002_action_intents | 1 | Write-ahead intent dedup |
| 003_experiments | 3 | Holdout experiments |
| 004_patches | 3 | Reconcile runs, buyer sessions, PII access log |
| 005_v3_2 | 5 | Track keys, rate limits, daily budget, deferred actions |
| 006_v3_3 | 4 | Open links, refunds, notification_outbox, policy_versions |
| 007_v4_0 | 5 | Pay tokens, overpayments, fee basis, mandate hardening |
| 008_v4_1 | 3 | Consent events, ext_ref mapping, policy_audit extensions |

**Total: 44 tables**

---

## Design Locks (DL1-DL10) — No Changes

All prior locks remain in force.

---

## Roadmap Consolidation

Round-6 sections A-R folded into PRODUCT_ROADMAP.md:
- Named planes added: communication, risk, support/legal/finance
- Section 6 (deployment DoD) → GA gate checklist
- Section 7 (launch phases) noted as matching DL6
- GA-gate additions: production consent service, opaque-ID audit, pentest

---

## Honest Residual List (Updated)

1. **Legal characterizations pending counsel** — ToS, Privacy Policy, DPA, etc.
2. **Razorpay connect mechanism to verify** — Partner/Route/OAuth-equivalent
3. **DPDP rules pending finalization** — Indian data protection
4. **Lift measured per-merchant over time** — modeled in shadow phase
5. **Protocol alignment directional** — buyer agent protocol is example-based
6. **Test mode sends no notifications** — Razorpay test mode
7. **Exactly-once per N16 caveat** — "exactly-once happy path; at-most-once per window"
8. **Payment links shareable** — loss bounded by incentive cap, attribution-matched
9. **Marketing consent self-reported** — source:'self_reported' flagged
10. **Identity resolution single-key** — phone-precedence when present
11. **Fees and margins modeled** — where imported, not computed from live data
12. **Consent-class interpretation pending counsel** — transactional vs marketing classification
13. **Production consent service pending** — double opt-in, provider suppression sync
14. **v4.x modules not wired into demo path** — architectural completeness, not demo-critical
15. **Clean boot unverified on venue hardware** — PENDING-HUMAN

---

## Verification Audit (v4.1 Final)

**VERDICT: COMPLETE-PENDING-VERIFICATION**

- 78/78 tests pass (10 files)
- Typecheck clean
- All grep gates pass
- BG1 fixed: moneyBus.ts now uses appendAuditSerialized (N1 enforced)
- BG3 fixed: RUNBOOK.md has kill-shot Q&A table
- BG2 documented: v4.x modules exist as complete implementations, not wired into demo path
- All 13 residuals documented in PATCH_REPORT.md
- Human-only items: clean boot, venue network, demo rehearsal, backup video, counsel review
