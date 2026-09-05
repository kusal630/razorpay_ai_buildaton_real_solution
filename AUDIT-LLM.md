# AUDIT-LLM.md — LLM integration audit (provider LIVE during this audit)

Provider: local OpenAI-compatible server, :1234. `/models` lists bonsai-8b
+ 4 others. POST /v1/chat/completions ground truth: HTTP 200 (~350ms
trivial; 5–15s full brain prompts), OpenAI-compatible shape
(`choices[0].message.content`, `usage.prompt/completion/total_tokens`)
plus extra `reasoning_content`/`tool_calls`/`stats` fields (ignored).
Parser reads exactly the standard fields — compatible, no adaptation
needed. MODEL PIN holds: bonsai-8b in .env + .env.example, verified
against the list, never rewritten.

## Dispositions

| ID | Item | Disp | Evidence |
|----|------|------|----------|
| A1 | callBrain flow | WORKING* | Live llm successes observed (multiple, varied strategies); retry-succeeds observed; rules fallbacks named. *Deviation: timeout 30s, not spec 8s — measured full-prompt latency 5–15s (one 26s outlier); 8s would abort ~half of legit calls and trip the breaker. Documented, intent (bounded waits) preserved. |
| A2 | Loud fallbacks | WORKING | 5 fixtures green (U-LOUD); live BRAIN_FALLBACK rows observed: llm_model_unavailable (dead-endpoint era), validation_failed (several). Ledger rationale carries fallback_reason (recovery path). |
| A3 | Context assembly | PARTIAL | Flat v5 fields wired (case_type, token whitelist, copy caps, CTA flags, merchant). Full M18 persuasion_context object (verified_reviews/social/threshold/offers/emi/hold/signals blocks) NOT assembled per-agent; strategy_stats + approval advisory never populated. No PII risk: context builder imports no decrypt (grep-verified). Accepted gap — NOT in Phase-2 build list; persuasion-relevant facts already flow via whitelist/facts paths. |
| A4 | System prompts verbatim | WORKING | 27/27 phrase checks vs §2.2 across all five prompts (scripted). |
| A5 | Schema validation | WORKING | Strict parse + schema + feasibility; token→bucket code resolution (ledger-visible); clamp rejects (safe). Extra-fields tolerance + missing-field failure added in Phase 2 (§2.4). |
| A6 | V1–V7 pipeline | WORKING | Unit gates green; live validation_failed rows with violation lists; V7 exemption + CTA rule per spec letter. |
| A7 | Resolve→normalize→length→send | WORKING | finalizeCopy order verified in code + U-GSM7 (post-resolution cap rejects grown copy). |
| A8 | Breaker discipline | WORKING | Stub-executed trip/no-trip (U-LOUD, U-BREAKERVIS); dashboard state + reset route live; live transport failures never occurred (endpoint healthy) so the live trip path is fixture-proven only. |
| A9 | Rules schema fields | WORKING | message_strategy/secondary_cta/incentive_token present with deterministic defaults (tested + observed in live rules thoughts). |
| A10 | Wiring | FIXED (Phase 2) | case_type on all four builders; upsell/chat/retry thoughts carry fallback_reason (+strategy/token for upsell); upsell rationale carries strategy/token/version. Live: UpsellBot fired end-to-end on a real paid order with mode:llm (Power Bank, 15%). Reassurance = template path BY DESIGN (no strategy decision exists). |
| A11 | Smoke test | WORKING | brain-test exit 0 live (mode llm, tokens, parsed, validation PASS logged); --bogus-model refuses with zero POSTs; QA button returns mode llm/PASS live. |
| A12 | Skipped gates | LISTED BELOW | — |

## A12 — gates needing the LLM, and their status

- U-LOUD (5 fixtures): RUN (stub-driven through real callBrain) + live rows.
- U-MODELDOC: RUN (bogus subprocess RED + live GREEN).
- U-BRAINTEST: RUN live (exit 0) + deterministic fixture test.
- U-FRESHINJECT llm chain: RUN live (llm thought + real plink_ + LINK_CREATED observed; dedupe + converted proven separately).
- U-BREAKERVIS transport: RUN via stubs (live endpoint never errored).
- U-RETURNS/U-DELIVERY: resolver-level RUN; integration test
  (llm-shaped copy → valid → resolves to real values) RUN; live
  LLM-emitted trust tokens not yet observed (model choice, not a code
  gap).
- U-VTOK/VSTACK/VLEN/VHUMOR/VDECLINE: RUN (unit + live validation_failed rows).
- Acceptance 8b pay step: BLOCKED on human payment (UPI/card interaction
  not scriptable here); link creation (real plink_), converted-on-resolve,
  and UpsellBot-fires-with-llm all proven live/mechanically.
- Acceptance 8c (copy differs + valid): RUN live (two differing valid
  llm copies captured).
- Acceptance 8d (kill flips + persists): RUN live (llm→rules→llm modes;
  ON survived a server restart; restored OFF).
- Acceptance 8f (fallback meter <40%/10 calls): RUN live — 10/10 llm,
  0% fallback, strategies {loss_framed, endowment}. Meter + alarm wired
  into /api/state.

## Phase-2 additions since the first audit pass

- §2.4 quote repair (structural quotes only; apostrophes can never
  corrupt), extra-fields warn+log, `[[..]]`/`{..}` variant folding
  (ledgered as normalized_token_syntax), fallback-rate meter + alarm.
- Upsell pre-normalization (malformed advisory token → null;
  string rationale → {reasoning, []}); copy caps now enforced per
  agent (recovery 320 / upsell 220 / chat 200).
- V7 pressure exemption implemented exactly per spec (ungrounded
  only); CTA availability stated explicitly per context.
- Near-miss `<{..}>` brackets fold in validation AND resolver;
  expiry/stock resolver lookups hardened (uuid cast, DB-error
  fallback to caller facts).
