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
- BANNED: "guaranteed", "no side door exists", "unkillable", "we process payments", "cannot fail/double-spend"
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
