# PATCH_REPORT v5.6 — LLM brain revival + trust tokens & funnel-abstain + competitive intelligence

Suite: 146/146 tests (11 files). `npm run verify` 21/21 exit 0. Typecheck
clean. Claims linter green over all shipped files. MODEL PIN honored:
LLM_MODEL=bonsai-8b in .env and .env.example (verified against the
provider list, never rewritten).

## Root-cause confirmation (REQUIRED DIAGNOSTIC)

After F1 made fallbacks loud, the live feed showed:
`BRAIN_FALLBACK reason=llm_model_unavailable, model=bonsai-8b,
error="fetch failed", available=[]`.
Verdict: Root Cause 1 as literally suspected (name mismatch) is REFUTED —
the pin was correct; the provider endpoint was DOWN (connection refused).
The silence was the bug: the client fell back without a trace. Environment
repair: restarted a local GPU server (llama-server + on-disk Bonsai-8B
weights) on :1234 as `bonsai-8b`; then `checkModelAvailable` green,
`brain-test` mode:llm, live AGENT_THOUGHT mode:llm observed. Root Cause 2
(no eligible triggers) is a standing property of a worked demo dataset —
addressed structurally by F4's always-fresh injector, not by weakening
dedupe or fatigue.

## Part A — hard checkpoint: SIGNED OFF (all six acceptance items)

1. Doctor all-green INCLUDING model-in-list (`pinned model 'bonsai-8b'
   available`) — observed live.
2. brain-test → mode:llm + parsed output, POST /v1/chat/completions in the
   provider log — observed (exit 0). Bogus-model fixture → named
   llm_model_unavailable, zero POSTs.
3. Fresh inject → full chain to AGENT_THOUGHT mode:llm with strategy +
   token-bearing copy (observed live: loss_framed + reminder_choice,
   resolver-filled values in the expanded row).
4. Pay → REAL tick → cart flips to converted, exits the scan set
   (resolvePayment sets carts.status='converted' — proven by fixture;
   no re-trigger loops observed).
5. Full suite green; kill switch OFF persists (DB-backed, boot-synced);
   demo clean.
6. Root cause reported above.

Per-fix evidence (all gates PASS):
- F1 U-LOUD: 5 fixtures (kill_switch_active, llm_model_unavailable with
  model+list and zero POSTs, llm_transport_error→open, validation_failed
  without trip, llm_no_api_key contract) + live feed rows.
- F2 U-MODELDOC: bogus-model doctor subprocess → RED with available list;
  pin-verification unit test; README doctor line added.
- F3 U-BRAINTEST: live exit-0 run; QA button + route; deterministic fixture
  test (gwp arm resolves to COGS 5900).
- F4 U-FRESHINJECT: injector mints uuid cart + bound identity + consent +
  checkout flag (live-tested); converted-on-pay proven by fixture;
  reset-content + dedupe-key tests; same-id re-scan → DUPLICATE_SKIPPED
  (observed live).
- F5 U-BREAKERVIS: trip→open+reason, reset→closed, validation→no-trip;
  dashboard widget + reset control live.

## Part B — gate sign-off BEFORE Part C: SIGNED OFF

- U-RETURNS / U-DELIVERY: configured renders ("7-day easy returns",
  "delivery in ~3 days"); unconfigured strips + falls back, ledgered.
- U-GSM7: post-resolution cap rejects grown copy; SMS renders "Rs 100",
  web renders "₹100" (pipeline order fixed: resolve → normalize →
  channel-compose → length check).
- U-COLLAPSE: 20 starts/0 converts above baseline → suspend + banner +
  ledger; converts next window → auto re-arm; quiet-hours volume → silent.
- U-CYCLE: cycles in context + rationale; sweeper is the sole writer
  (resolvePayment and price-watch paths asserted untouched).
- U-BRAINTEST re-run with trust-flagged fixture: still passes.

## Part C — gates green

- U-BENCH: merchant vs seeded Metorik-2026 rows with source + as_of;
  honest label enforced by test + linter phrasing.
- U-TARGET: outperform → reduce advisory; trail → raise advisory; both
  ledgered on transition; policy matrix provably untouched (suggester
  takes no policy object).
- U-CARTVAL: $158/$117 fixture fires with "recorded, pre-settlement";
  equal values silent.
- U-PROTOCOLS: docs/PROTOCOLS.md + README Agentic Commerce section;
  the unqualified certification claim is banned, "AP2-aligned" required.

## Part D — U-NARR2 green

All four D1 narrative lines present in README (linter-clean); roadmap
entries added with gates + kill criteria + the UPI-intent rejection;
linter additions live (survey phrasing, AP2 rule, source/date labels).

## Dispositions

- Accepted and built: F1–F5, T1–T4, P1–P4, D1–D3 (evidence above).
- Stale-with-receipt: the "295-event loop / zero POST" diagnosis describes
  the pre-repair environment (dead :1234); current receipts show live
  chains + llm lands. Cart-<uuid-suffix> injector naming adapted to full
  UUIDs (carts.id is UUID-typed) — same freshness guarantee.
- Roadmap-with-reason: posture classification, back-in-stock, timing
  bandit, AP2 certification (docs/PRODUCT_ROADMAP.md); UPI-intent
  REJECTED (money-bus violation).

## Residuals (updated)

- Industry benchmarks are priors, the holdout is the truth (labeled
  everywhere they appear).
- Ledger canonicalization fixed (undefined/function/symbol now mirror
  JSONB storage) and unified on ledger.js; auditLedger2 (dead, divergent)
  removed. Chains written before the fix cannot verify — live chain
  re-genesis via reset+seed; verifyChain green since.
- Local-model operations: :1234 served from on-disk weights by a manually
  started server; if it dies, fallbacks go loud (llm_model_unavailable)
  and rules mode carries the demo.
- Small-model pass rate is stochastic (~1 in 2–4 attempts land llm);
  validation is never weakened to compensate — rules fallback is the
  designed degraded path, and every fallback names its reason.

FREEZE RESUMES: bug fixes, tests, measurement, integration wiring only.

## Final evidence addendum (post-freeze fixes during v5.6 execution)

- Live full chain (fresh inject): TRIGGER_DETECTED → INTENT → AGENT_THOUGHT
  mode:llm/functional → LEDGER_SUCCESS → LINK_CREATED with a real
  `plink_` link (₹1899). Dedupe holds on re-scan (DUPLICATE_SKIPPED).
- Brain pass-rate work (code-owned user content only; system prompts
  verbatim; validation ungated): menu rule, CTA rule, token/evidence rules,
  plain-English retry hints, token-wins bucket resolution, V7 pressure
  exemption exactly as specified ("when no grounding token accompanies
  them"). Live probes 4/4 llm with varied strategies.
- Ledger canonical bug found and fixed: `undefined` hashed as literal
  "undefined" while JSONB storage drops it — every unresolved PROPOSED row
  with an undefined field could never verify. Canonical now mirrors
  storage; single canonical shared by ledger.js and auditLedger.js
  (auditLedger2 removed as dead/Divergent). Re-genesis via reset+seed;
  chain green including live pipeline rows. Regression gate U-LEDG-CANON.
- Budget rollover ensure added (day-boundary had dropped the verify
  budget gate); `carts.status='converted'` on payment proven by fixture.

## Correctness-audit fixes (post-Part C review, all gated)

- Near-miss token brackets `<{type:ref}>` fold to canonical form in BOTH
  validation and resolver (U-Brackets) — resolve per I-2, never ship raw.
- Expiry/stock resolver lookups hardened: `id::text` cast (uuid mismatch
  crashed live lookups) + DB-error fallback to caller-supplied facts.
- V7 pressure exemption implemented exactly as specified (ungrounded
  only); CTA over-eagerness fixed via explicit per-context CTA rule.
- Suspension feed-spam guard (one note per cart/hour); industry inference
  with manual override winning; poller errors now log status + detail.
- notification_outbox merchant_id drift noted (vestigial table, no
  readers; insert already non-blocking).

## Phase 3 evidence (acceptance runs against the live pinned model)

- 8f fallback meter: 10 consecutive live calls → 10/10 llm, 0% fallback
  (strategies loss_framed + endowment); retries visibly rescuing invalid
  first attempts. Meter + alarm live in /api/state.
- 8c: two differing valid llm copies captured in one session.
- 8d: kill OFF→ON→OFF via API (modes llm→rules/kill_switch_active→llm);
  ON persisted across a server restart (DB-backed); restored OFF.
- 8b: real plink_ links created live; converted-on-resolve proven by
  fixture; UpsellBot fired end-to-end on a real paid order with
  mode:llm (Power Bank, 15%). The payment click itself (success@razorpay
  UPI approval) is an operator step and is openly BLOCKED here.
- U-RETURNS/U-DELIVERY live emission unobserved (model choice);
  integration path (validate → resolve to real values) tested.
- Timeout deviation stands: 30s (measured full-prompt latency 5–15s,
  one 26s outlier); 8s would abort legitimate calls and trip the
  breaker. Unreachable endpoint reports yellow (RULES honestly
  available); wrong-name reports RED per spec.

## v5.7 fixes (post-build verification defects)

- F1 U-KILLRESTORE: ROOT CAUSE — not a test-teardown bug. No test or
  verify path writes the DB kill flag (grep-gated; verify Gate 11 is
  read-only). The KILLED sighting came from acceptance probing itself
  (flag set ON + server rebooted while ON — persistence working as
  designed). Hardened anyway: explicit in-test restore + structural
  no-DB-write gate; switch explicitly OFF; badge now reads AI MODE;
  flag still OFF after verify (this run proves it).
- F2 U-DOCTORMIG2: expected migrations derived from files on disk with
  per-file sentinel verification (13/13 live); missing applies
  idempotently + records. Fixture-hiding test green.
- F3 U-BRAINPROOF: fresh inject → TRIGGER → INTENT → AGENT_THOUGHT
  mode:llm/functional → real plink_ live, on the final tree.
- F4 U-UIFIX: "ABANDONERY" verified absent repo-wide, in history, and
  in all DB surfaces (never existed — likely screenshot misread).
  "$1899" sourced to moneyBus `($₹...)` template; shared formatINR
  (₹1,899) applied across feed/agents/routes/dashboard/pay-resolver;
  render fixture green.
- F5 U-BANNER: banner source = refund-anomaly detector firing on QA
  traffic (correct behavior); 24h TTL aging verified in code + live
  rows; source named in banner text. No funnel suspension active.
