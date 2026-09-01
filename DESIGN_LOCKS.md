# DESIGN_LOCKS.md — Architectural Decisions (Zero Code)

These decisions are LOCKED. They shape every subsequent build decision.
No code implements them here; they are constraints for the product build.

---

## DL1 FUNDS FLOW (P1)

**Decision:** Merchants connect THEIR OWN Razorpay accounts.

**Mechanism:** Verify with Razorpay which connect mechanism is appropriate
(Partner program / Route / OAuth-equivalent). Do NOT assume an API shape
— the invariant is the lock, the mechanism is verified at integration.

**Invariant I8:** Shopper funds never transit platform-held accounts.
Platform revenue = SaaS billing to the merchant entity.

**Route documented as the scale alternative** with its trade-offs:
- Partner program: better onboarding UX, but may change characterization
- Route: simpler funds isolation, but more onboarding friction

**Counsel must sign the characterization before launch.**

**Composition note:** With BYO-account, per-tenant reference_id uniqueness
is exactly the scope Razorpay matching requires.

---

## DL2 PER-TENANT CHAINS (P18)

**Decision:** Ledger chains, advisory-lock keys, checkpoints, and sequences
are per-merchant.

**Implementation:**
- Advisory lock key: `hash(merchant_id)` (not fixed constant)
- Sequences: per-merchant audit_log seq
- Checkpoints: per-merchant, per-day segmented
- Platform events: separate ops-chain

**Verification:** Per-day segmented (O(days)).

**Note:** This is the correct composition with BYO-account (DL1).

---

## DL3 REGION (P10)

**Decision:** Entire platform pinned to `ap-south-1`.

**Hard constraint:** Payment-system data never leaves the region.

**Deployment docs carry this as a hard constraint.**

**CERT-In compliance:** Raw events 90d, logs 180d, all in-region.

---

## DL4 ISOLATION (P17)

**Decision:** Postgres RLS with session tenant context is the enforcement
layer AT PRODUCT BUILD.

**Current state:** merchant_id on every row (already true).

**Enforcement:** Row-Level Security (RLS) at database level, not just
application-level filtering.

**Proof:** IDOR suite in CI proves isolation is a property, not a
code-review promise.

---

## DL5 PUBLIC SURFACES (P26)

**Decision:** All public money surfaces use unguessable tokens, never
sequential IDs.

**Implementation:** pay_tokens with 128-bit random tokens.

**Scope:** Payment pages, invoice links, receipt URLs.

---

## DL6 ROLLOUT (P20)

**Decision:** Shadow mode → canary → GA.

**Shadow mode (observe-only):**
- Would-have-done reports
- No actual customer contact
- Merchant reviews before live

**Canary (recovery only):**
- Rs.0 bucket only
- ≤50 links/day/tenant
- Merchant opt-in required

**GA (incentives per merchant):**
- After shadow review
- Kill criteria per phase

**This is the charter pattern applied to the launch itself.**

---

## DL7 LEGAL DEPENDENCIES (P16)

**Decision:** Pre-launch checklist owned by counsel.

**Engineers provide artifacts; counsel certifies.**

**Claims linter enforces LABELS; it cannot certify COMPLIANCE.**

**Checklist:**
- ToS
- Privacy Policy
- DPA
- Consent-notice copy
- Offer-disclosure copy
- Grievance officer
- DPIA
- ROPA

---

## DL8 RAZORPAY CONNECT (P1)

**Decision:** Verify the Razorpay connect mechanism before implementation.

**Invariant:** Merchant-of-record + funds isolation.

**The Razorpay connect mechanism (Partner / Route / equivalent) is an
integration detail to VERIFY, not assume.**

---

## DL9 IDENTITY RESOLUTION (P5)

**Decision:** Single-key identity resolution with phone-precedence.

**When phone is present:** phone = identity key (E.164 normalized).
When only email: email = identity key (lowercase + trim).

**HMAC-SHA256** with server secret for assignment and dedup.

---

## DL10 FEE/MARGIN MODELING (M8)

**Decision:** Fees and margins are "modeled" where imported.

**Dashboard labels:** "recorded, pre-settlement" for realized numbers;
"modeled" for estimated numbers.

**Claims linter enforces these labels.**
