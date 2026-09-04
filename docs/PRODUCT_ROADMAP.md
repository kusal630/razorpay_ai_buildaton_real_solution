# PRODUCT_ROADMAP.md — Phased, Gated Plan (v4.1 Consolidated)

Every item has a gate. No item starts now. This is the plan for the
product build after hackathon scope freeze.

---

## Named Planes

### Communication Plane
Providers, receipts, suppression, quiet hours (customer-local)

### Risk Plane
Fraud scoring, review queue, payer-mismatch workflow, card-testing signals

### Support/Legal/Finance Plane
DSR workflows, tax, accounting export, support tooling

---

## Phase 1: LAUNCH BLOCKERS (Pre-Launch)

These must be complete before any customer touch. Also serves as GA gate checklist.

| ID | P# | Fix Summary | Gate | Owner |
|----|-----|-------------|------|-------|
| L1 | P16 | Legal checklist: ToS, Privacy Policy, DPA, consent-notice copy, offer-disclosure copy, grievance officer, DPIA, ROPA | Counsel sign-off | Legal |
| L2 | P1 | Funds flow: Verify Razorpay connect mechanism (Partner/Route/OAuth) | Funds never transit platform accounts | Eng + Legal |
| L3 | P17 | RLS enforcement: Postgres RLS with session tenant context | IDOR suite passes in CI | Eng |
| L4 | P18 | Per-tenant chains: advisory-lock keys hash(merchant_id), per-merchant sequences | Multi-merchant isolation test | Eng |
| L5 | P10 | Region pin: ap-south-1, CERT-In compliance (90d events, 180d logs) | Data residency audit | Eng + Compliance |
| L6 | P26 | Public surfaces: all money surfaces use unguessable tokens | Sequential ID scan returns 404 | Eng |
| L7 | P20 | Rollout plan: shadow → canary → GA | Kill criteria documented | Product |
| L8 | — | Production consent service: double opt-in, provider suppression sync | Consent service deployed | Eng |
| L9 | — | Opaque-ID audit: ext_ref external, audit_seq internal only | Audit passes | Eng |
| L10 | — | Pentest: external security review | Pentest clean | Security |

---

## Phase 2: PRE-GA (Before General Availability)

These complete the product for merchant onboarding.

| ID | P# | Fix Summary | Gate | Owner |
|----|-----|-------------|------|-------|
| G1 | P2 | Cancel-before-create: at most one live link per cart | E-OVERPAY + U-CBC tests pass | Eng |
| G2 | P2 | Overpayment handler: auto-refund ≤Rs.10k, escalate >Rs.10k | Overpayment fixture test | Eng |
| G3 | P3 | Fee basis: entity fees when available, modeled fallback | U-FEE test | Eng |
| G4 | P26 | Pay tokens: 128-bit unguessable, masked PII, rate limit | U-UNGUESS test | Eng |
| G5 | P14 | Dark-pattern filter: no fabricated scarcity, required disclosures | U-DARK test | Eng |
| G6 | P31 | AI kill switch: per-tenant + global flag, deterministic fallback | U-KILL test | Eng |
| G7 | P34 | theta_0 primary: control arm outcomes, prior fallback | U-THETA0 test | Eng |
| G8 | P7 | Out-of-order webhooks: resolution order-insensitive | E-ORDER test | Eng |
| G9 | P23 | Mandate hardening: jti + expiry, per-key caps, velocity | U-JTI test | Eng |
| G10 | P7 | Durability: Redis AOF everysec, restart test | In-flight intents survive | Eng |
| G11 | P7 | IST boundary: intents in correct business windows | Boundary test passes | Eng |
| G12 | P18 | Per-tenant checkpoints: file-based hackathon, S3 prod | Checkpoint persistence test | Eng |
| G13 | P7 | Un-tested out-of-order arrival: fixture test | E-ORDER test | Eng |
| G14 | P18 | Per-day segmented chains: O(days) verification | Segmentation test | Eng |
| G15 | — | Consent-class: incentivized recovery requires marketing consent | E-CONS3 test | Eng |
| G16 | — | Consent evidence: merchant_server source, evidence_reference | U-CONSENT-EV test | Eng |
| G17 | — | Opaque ext_ref: HMAC-based, sequential never external | U-EXTREF test | Eng |
| G18 | — | Webhook re-scan: pending >5min re-enqueued | U-WHRESCAN test | Eng |
| G19 | — | Cancel-before-create fails closed: error → no new link | U-CBC2 test | Eng |
| G20 | — | Claims-linter v2: banned terms, required phrases | Linter passes in CI | Eng |

---

## Phase 3: FAST-FOLLOW (Post-GA, First 90 Days)

These complete the product for scale and compliance.

| ID | P# | Fix Summary | Gate | Owner |
|----|-----|-------------|------|-------|
| F1 | P15 | SSO/MFA/RBAC/step-up auth | Auth audit passes | Eng |
| F2 | P19 | KMS/Secrets Manager for key rotation | Key rotation test | Eng |
| F3 | P30 | WORM checkpoints (S3 Object Lock) | Checkpoint immutability test | Eng |
| F4 | P28 | Partitioning: ledger forever (PII-free), raw events 90d, logs 180d | Retention test | Eng |
| F5 | P29 | SLOs: p99 latency, error budget, burn rate alerts | SLO dashboard live | Eng + SRE |
| F6 | P29 | Runbooks + on-call incl. 6-hour CERT-In procedure | Runbook review | SRE |
| F7 | P22 | Blue-green deploy + expand-contract migrations | Zero-downtime deploy test | Eng |
| F8 | P22 | Prod-config test: env vars validated at startup | Config validation test | Eng |
| F9 | P24 | Provider abstraction: Razorpay interface for swap | Provider interface test | Eng |
| F10 | P24 | Token metering: API call tracking per provider | Metering dashboard | Eng |
| F11 | P25 | Eval harness: synthetic merchants, scripted behavior | Eval metrics pass | Eng |
| F12 | P21 | API versioning: v1 stable, v2 beta | Version negotiation test | Eng |
| F13 | P27 | Buyer callbacks: async completion notification | Callback delivery test | Eng |
| F14 | P27 | Dispute flows: chargeback handling, evidence submission | Dispute fixture test | Eng |
| F15 | P20 | Pricing model: subscription + optional success fee on MEASURED incremental gross profit | Holdout makes this honestly billable | Product |
| F16 | P32 | Merchant trust surface: audit export, transparency page, policy presets, dry-run simulator | Trust dashboard live | Product |

### Communication Plane (Folded from Round-6 A-R)

| ID | Fix Summary | Gate | Owner |
|----|-------------|------|-------|
| CP1 | SMS/email/WhatsApp provider abstraction | Provider interface test | Eng |
| CP2 | Receipt templates per provider | Receipt delivery test | Eng |
| CP3 | Suppression list sync (DND, TCPA) | Suppression check test | Eng |
| CP4 | Quiet hours customer-local (IST-aware) | Quiet hours test | Eng |

### Risk Plane (Folded from Round-6 A-R)

| ID | Fix Summary | Gate | Owner |
|----|-------------|------|-------|
| RP1 | Fraud scoring (velocity, amount, device) | Fraud detection test | Eng |
| RP2 | Review queue for high-risk actions | Queue workflow test | Eng |
| RP3 | Payer-mismatch workflow | Mismatch handling test | Eng |
| RP4 | Card-testing signal detection | Card-testing alert test | Eng |

### Support/Legal/Finance Plane (Folded from Round-6 A-R)

| ID | Fix Summary | Gate | Owner |
|----|-------------|------|-------|
| SLF1 | DSR workflows (data subject requests) | DSR handling test | Eng |
| SLF2 | Tax computation (GST, TDS) | Tax calculation test | Eng |
| SLF3 | Accounting export (Tally, Zoho) | Export format test | Eng |
| SLF4 | Support ticketing integration | Support workflow test | Eng |

---

## Phase 4: SCALE (Post-GA, 90+ Days)

These optimize for growth and reliability.

| ID | P# | Fix Summary | Gate | Owner |
|----|-----|-------------|------|-------|
| S1 | — | Multi-merchant: per-tenant everything | Isolation test | Eng |
| S2 | — | Real traffic lift measurement | Lift dashboard with real data | Data |
| S3 | — | Internationalization: currency, locale, regulations | i18n test | Eng |
| S4 | — | Webhook reliability: retry queues, dead-letter processing | DL processing test | Eng |
| S5 | — | Performance: connection pooling, query optimization, caching | p99 latency <100ms | Eng |
| S6 | — | Observability: distributed tracing, structured logging, metrics | Trace correlation test | Eng |

---

## v4.3 Persuasion-Layer Roadmap (NOT building — folded per patch prompt)

| ID | Item | Why later |
|----|------|-----------|
| R1 | Shipping-threshold engine | Needs fulfillment/shipping data not held |
| R2 | Payday scheduling | Needs salary-cycle data not held |
| R3 | Referral engine | New product surface, new trust boundary |
| R4 | Festival calendar | Calendar-driven copy needs a content-ops owner first |
| R5 | Vernacular copy | Translator review pipeline required before customer-facing text |
| R6 | Full copy×bucket Thompson bandit | Cold-start explosion; runs after G7 strategy arms collect data |

---

## TOTAL: 64 items across 4 phases + 6 v4.3 persuasion-layer roadmap items above

**Phase 1 (Launch Blockers):** 10 items
**Phase 2 (Pre-GA):** 20 items
**Phase 3 (Fast-Follow):** 24 items (incl. Communication, Risk, Support/Legal/Finance planes)
**Phase 4 (Scale):** 6 items

**All items have gates. No item starts now.**

---

# v5.0 TERMINAL ROADMAP (M24 — the feature roadmap is CLOSED at this point)

Every item: {status, gate, prerequisite}. Production flip requires a go-live gate.
Ledger claims are tamper-evident with external anchoring (checkpoints + merchant
email), never the bare unqualified variant. Contact semantics: exactly-once happy path;
at-most-once contact per window under crash. Reconciliation target: zero
unresolved critical exceptions (dashboard: matched / pending(age) /
exceptions(critical|warn)). All lift figures are expected incremental EV —
modeled until real traffic; industry numbers are priors, the holdout is the truth.
The LLM cannot directly set amounts, but guards are still required against bad
upstream data (validation runs after every brain call; policy gates always last).

## INTEGRATION-GATED (machinery live, needs external signal)

| Item | Status | Gate | Prerequisite |
|------|--------|------|--------------|
| COD-Save live | machinery shipped (M16), QA-triggerable | U-COD | Merchant order webhook w/ COD flag + delivery-day trigger + dynamic QR API verification |
| NDR auto-trigger | manual-first shipped (M15) | U-NDR | Courier status webhook (replaces manual button) |
| Full settlement reconciliation | lite fee auditor shipped (M5) | U-FEEAUDIT | Settlements API wiring |

## COMPLIANCE-GATED

| Item | Status | Gate | Prerequisite |
|------|--------|------|--------------|
| Subscriptions / UPI Autopay | documented | RBI e-mandate ≤₹15k compliance | Counsel + RBI e-mandate flow approval |
| WhatsApp channel | documented | BSP + DLT registration | Buy BSP, DLT template registration |

## POST-GA (breadth, on measured demand only)

Referral, gifting calendar, tracking page (buy courier aggregation), price-drop
alerts beyond save-for-later, replenishment (when catalog gains consumables).

## CLOSED (one-line reasons — they stay dead)

| Item | Reason |
|------|--------|
| Endowed progress | No true progress exists — dark pattern |
| x402 | Wrong rails for this merchant |
| Loyalty program | Rewards counterfactual purchases |
| Dynamic pricing | Trust-destroying |
| Fabricated scarcity | CCPA exposure |
| Urgency stacking | Cognitive load, pressure stacking banned |
| Consent defaults | DPDP violation |

**FREEZE:** after v5.0, this codebase accepts ONLY bug fixes, test additions,
measurement improvements, and integration wiring for the integration-gated
items. Any new feature idea → ROADMAP.md with the MIT-filter question: "which
lever, what evidence tier, what falsification plan, what gate?"
