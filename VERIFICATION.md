# VERIFICATION.md — Sellable full-system verification pass (2026-09-04, Supabase + Razorpay TEST + bonsai-8b)

Method: every PASS below is an OBSERVED artifact (feed event, DB row, API response, counter).
Environment: Supabase Postgres (46 tables), Razorpay TEST keys, LM Studio `bonsai-8b` @ 127.0.0.1:1234, server :3000, RAZORPAY_MODE=test, SKIP_MIGRATIONS=true.

Naming note: the prompt's local seed (cart `C-88`, uuid-incompatible id) does not exist in this
Supabase dataset (carts.id is UUID). Equivalents were seeded: **Riya** (first_visit_high_intent,
marketing opt-in), **Arjun** (price_sensitive, marketing opt-out), **Maya/Dev** (treatment-arm
incentive paths), all with bound customer_id, identity_hash, contact_enc, consent rows, touches.

## STAGE 1 — CREDENTIAL GATE

| # | Check | Result | Evidence |
|---|-------|--------|----------|
| G1 | DB SELECT 1 | PASS | `{"ok":1}` |
| G1 | ≥31 public tables | PASS | 46 tables |
| G1 | schema_migrations present | PASS w/ deviation | rows `001_initial, 001_initial_schema, 002_action_intents, 002_track_keys` (prompt expects `0001_initial_schema`; different naming, same role) |
| G1 | seed present | PASS | 4 merchants / 15 products / 69 customers / 5+ carts |
| G1 | C-88 spot check | DEVIATION (documented) | `carts.id` is UUID — literal `C-88` impossible; Riya/Arjun equivalents seeded with customer_id NOT NULL, identity_hash ✓, contact_enc ✓ (AES-256-GCM, key rotated to valid 32-byte base64 — old key decoded to 21 bytes, `encrypt()` threw `Invalid key length`) |
| G1 | consent rows | PASS | Riya: marketing opt_in=true + transactional anchor; Arjun: marketing opt_in=false + transactional anchor (consent_events + customers JSON agree) |
| G2 | Razorpay payment_links list | PASS | `GET /v1/payment_links?count=1` → 200 (one 429 rate-limit observed mid-pass, retry → 200; auth never 401) |
| G2 | Razorpay orders list | PASS | `GET /v1/orders?count=1` → 200 |
| G2 | mode=test | PASS | `RAZORPAY_MODE=test` |
| G3 | LLM pong | PASS (after repair window) | LM Studio was DOWN at pass start (`ECONNREFUSED`; reported loudly, rules fallback observed). After user restart: `{"content":"Pong."}` model `bonsai-8b`. Kill-switch OFF (DB false + in-memory false) |
| G4 | secrets | PASS (after repair) | APP_SECRET present; APP_ENCRYPTION_KEY replaced with valid 32-byte base64 (old value invalid — see G1) |
| G4 | boot + doctor | PASS w/ 1 honest red | server :3000; doctor db/razorpay/llm/seed green; `migrations: red (4 applied)` — count gate calibrated to local history, remote schema is foreign-managed (see limitations) |

## STAGE 2 — FUNCTIONALITY AUDIT

### 2A Feed & scheduler
- A1 PASS — boot → scheduler tick ≤15s → TRIGGER_DETECTED rows (e.g. activity 66, Dev cart ₹1598).
- A2 PASS — events carry cart id, amount paise, abandoned_at.

### 2B Agent pipeline
- B1 PASS — TRIGGER_DETECTED observed for every test cart.
- B2 PASS — write-ahead intent rows (`action_intents`, uuid, dedupe_key `merchant:identity:cart:recovery_link:day`, status lifecycle pending→executing→awaiting_gateway→done).
- B3 PASS — re-trigger Dev cart → `DUPLICATE_SKIPPED` + `LEDGER_SKIPPED`, intent count stays 1.
- B4 PASS — no "skip anonymous" for bound customers (identity_hash + segment + consent in context). Unbound carts correctly skip (observed 3 pre-existing unanchored carts skip).
- B5 PASS — UPLIFT_DECISION shows menu, e.g. `Feasible: ₹0(EV:-50), ₹50(EV:3502), ₹100(EV:1835), ₹150(EV:168)`; first-touch → plain-only; no-marketing → plain-only.
- B6 PASS — θ/EV numbers in feed; priors seeded `{repeat:{0:10/100,50:20/100,100:34/100,150:36/100}, price_sensitive:{0:8/80,50:16/80}, first_visit:{0:12/50}}`.
- B7 PASS (after repair) — `AGENT_THOUGHT mode=llm` observed 4× (₹150/helpful, ₹50/warm ×2, plain/neutral). Repair: model never saw the evidence allow-list (`known_ids` was stripped from the prompt) → added `reference_ids` + copy-verbatim rule to prompt and retry; extended known_ids with item ids. Copy differs run-to-run (temperature live), never template text.
- B8 PASS — POLICY_EVAL lists every check by name (amount, incentive_cap, quiet_hours, consent, velocity, budget, incentive_30d, first_touch), verdict ALLOW observed.
- B9 PASS — audit_log rows per action; `verifyChain` PASS (head `b749e820`); /api/ledger/verify same result.
- B10 PASS — Dev link: `plink_TXqXsOybwbkede`, `https://rzp.io/rzp/3n1wm8x`, amount_paise=154800 (₹1548 = ₹1598−₹50 ✓). **Repair:** money bus charged full cart total ignoring incentive (two live links overcharged ₹100/₹150) — fixed `amount = cartTotal − incentive`, cancelled both bad links (DB cancelled; Razorpay returned 404 → already terminal, noted).

### 2C Payment & revenue
- C1/C2 BLOCKED ON HUMAN — Dev's live link (above) awaits a real TEST payment (card 4111…/success@razorpay). Everything downstream proven via signed webhook (C3–C9 path identical code).
- C3 PASS — signed `payment_link.paid` webhook (200) → PAYMENT_PAID (id 139) + REVENUE_TICK REAL (id 140) ≤15s.
- C4 PASS — `/api/state` revenue.real 0 → 89900, orders 0 → 1.
- C5 PASS — orders row paid + paid_at + fee_basis=modeled; audit seq 15 SUCCESS (idempotent; second path no-op).
- C6 PASS — segment_stats returning/bucket-0: successes +1 (attempts +2 by design: +1 at send, +1 at pay).
- C7 PARTIAL — incentive was ₹0 so nothing to settle; reserve→release round-trip proven separately (10000 paise). Settle path code-fixed (removed illegal `LIMIT 1` in UPDATE) but unobserved with incentive>0.
- C8 PASS — UpsellBot fired on paid order → ranked shortlist → AGENT_THOUGHT mode:llm (Earbuds 15%, then Coffee 15% on re-run) → policy ESCALATE (₹180 > ₹150 auto) → ledger ESCALATED + approvals row pending. **Repairs:** catalog scoped to cart merchant (was hardcoded merchant → zero candidates, silent exit); policy exposure = discount paise (full-price semantics BLOCKED every upsell >₹500); ESCALATE now writes ledger+approval (was silent return).
- C9 PASS — resolvePayment on 2-link cart → statuses [paid, cancelled].

### 2D Governance
- D1 PASS — real validator: 20% proposal → invalid (`schema_mismatch`, `infeasible_discount`) → BLOCKED red event; 15% → valid → ALLOW event. (Prompt's QA drill endpoint only emitted static text; now driven by real evaluation.)
- D2 PASS — buyer session → quote ₹47,940 (30× Earbuds) → purchase-intent → 202 ESCALATED (approval + audit seq 14) → Approvals tab pending → DENY → status denied, 0 orders, ledger ESCALATED, feed ESCALATED + deny events. **Repairs:** approvals `context_json`→`context`; /api/approvals `a.created_at`→`al.seq`; decided_by→NULL (FK points at admin_users, logins live in merchant_admins); buyer_sessions columns added (buyer_key_id, mandate_json, quote_snapshot_json, price_version). Note: prompt says "ledger row DENIED" — actual: approval row denied + ledger ESCALATED (precise).
- D3 PASS — Arjun cart2 → CLAMPED event (`consent_marketing_missing`, ₹50/₹100/₹150 off-menu) → brain (llm) plain/neutral with correct reasoning → velocity ESCALATE (3rd+ touch); plain-link send proven on Arjun cart1 (₹1598, LINK_CREATED). **Repair:** clamp was implicit; added explicit CLAMPED event.
- D4 PARTIAL — deferIntent → deferred+resume_at → QA fast-forward → pending (observed). The 23:00 quiet-hours trigger itself is time-bound and bypassed by design in TEST mode → DEFERRED-by-quiet-hours unobservable in this pass.
- D5 PASS — kill ON → callBrain returns rules, zero LLM traffic; kill OFF → circuit closed, next brain call llm. **Repair:** ops toggle only flipped the DB flag the brain never read — now also flips in-memory switch; boot syncs from DB.
- D6 PASS — live chain PASS; tampered COPY fails exactly at tampered seq (12). **Repair:** ts Date-vs-string digest inconsistency (append=ISO, resolve=Date→`{}`) — verifiers accept both forms explicitly; resolve path now normalizes to ISO going forward.

### 2E Failure path
- E1/E2 BLOCKER — no FailureRetryBot exists: QA inject creates a row nothing consumes; webhook `payment.failed` only marks orders (in the unscheduled BullMQ worker); no retry-link sender, no retry-policy ledger semantics anywhere. Building it is a new subsystem, not wiring repair. Spec for the build: webhook/poller trigger → transactional consent → ₹0 feasible menu → single retry link (same-or-lower incentive) → FAILED→retry→PAID chain rows.

### 2F Learning & experiment
- F1 PASS — `/api/backtest/run` (was a hardcoded stub `n×1200`) now drives the real `replay.ts` engine: 200 journeys, Thompson sampling converged (180/200 chose ₹100 @ true 0.34), sim revenue ₹98,568 from real math, `production_untouched: true`, prod stats byte-identical (1265/374 before+after), SIMULATED feed event, `/api/state` sim counter moves, `backtest_runs` row persisted.
- F2 PARTIAL — HMAC cohort assignment unit-proven (7/7 experiment tests); lift UI panel absent; `computeMetrics` targets legacy columns (unwired on this schema). No bare point estimates shown anywhere (nothing shown at all — panel missing, documented).
- F3 PASS (engine + override loop) — direct replay on dead segment: 173 trips, production untouched; pauseExperiment → `paused`; new resume endpoint → `active`. No dashboard PAUSED panel (documented).

### 2G Surfaces & security
- G-1 PASS — admin login works, wrong password 401-rejected, /api/* 401 without session (all observed via curl).
- G-2 PASS — /pay/`<token>` returns amount/incentive/pay_url/link id; /pay/1,2,… → 404.
- G-3 PASS — public track rejects contact fields and amount fields (422), accepts clean cart with server-computed total. **Repair:** track rate-limit queries compared TEXT day to CURRENT_DATE (every authed track call 500'd) — fixed with TO_CHAR.
- G-4 PARTIAL — chat answers from DB facts with mode:llm (item + price observed); discount tool never selected by model in 5 observed turns → request_discount→ESCALATE/ALLOW gate proven at policy layer (50000→ESCALATE, 5000→ALLOW) but not end-to-end. **Repairs:** cart lookup tolerant of missing cart_id (+fallback via payment_links); chat context now carries line items (model previously hallucinated "empty cart"); prompt now documents required `rationale`.
- G-5 PASS — banned strings absent (grep); SIMULATED + test-mode footer + `recorded, pre-settlement` labels present (footer phrase added — was missing).

## STAGE 3 — REPAIR LOG (all re-verified above)
Supabase adapters (code→remote schema, all additive DDL): activity summary/amount, audit_log *\_json cols,
payment_links cart/customer/incentive/ext_ref/short_url/paid_at, daily_budget cap/realized/settled,
outbox payload_hash, orders ext_ref, pay_tokens(+rate limits), ext_ref_map, sibling_links,
kill_switch_state, open_links, buyer_sessions cols, products price_version, policy_rules unique+4 rows,
merchant row, kill-switch row, segment priors. Rewrote intentExecutor (uuid intents, window_day text, no
lease_owner/max_attempts/next_retry_at/audit_seq). Dual-schema experiment + identity layers. SKIP_MIGRATIONS
flag + SSL pools. Net-amount invariant. Upsell merchant scoping + exposure semantics + escalate approvals.
Backtest wiring + runs table + state sim. Kill-switch wiring. Clamp event. Chat context. Track rate-limit +
cart_items writes. Approvals/decided_by + context + ordering fixes. Buyer-key rate column. Express
unhandled-rejection safety net (two route crashes observed pre-net). Tests updated to new intent contract;
debug@4 fix (nock). Banned-claim filter gap noted: "valid for a limited time" passes (no money impact).

## KNOWN LIMITATIONS
1. C1/C2 need a human TEST payment (Dev link above). 2. E1/E2 need FailureRetryBot (BLOCKER, spec above).
3. Doctor `migrations: red` (count gate vs foreign-managed schema). 4. F2 lift panel absent.
5. `sibling_links` table written by nothing (dead). 6. Webhook BullMQ workers unscheduled (route handles
webhooks synchronously; worker file references legacy cols). 7. Upsell amount-gate semantics changed caller-side
(documented above). 8. Old timestamp-digest rows verify under legacy Date-form (dual-form verifier, documented).
