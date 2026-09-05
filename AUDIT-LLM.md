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
| A10 | Wiring | PARTIAL→FIXED (Phase 2) | RecoveryBot fully wired. Gaps found: upsell/chat/failureRetry contexts lack case_type; upsell+chat+retry thoughts lack fallback_reason/secondary surfaces; upsell rationale lacks strategy/token fields. Reassurance = template path BY DESIGN (no strategy decision exists to make). Fixed in Phase 2 except reassurance (intentional). |
| A11 | Smoke test | WORKING | brain-test exit 0 live (mode llm, tokens, parsed, validation PASS logged); --bogus-model refuses with zero POSTs; QA button returns mode llm/PASS live. |
| A12 | Skipped gates | LISTED BELOW | — |

## A12 — gates needing the LLM, and their status

- U-LOUD (5 fixtures): RUN (stub-driven through real callBrain) + live rows.
- U-MODELDOC: RUN (bogus subprocess RED + live GREEN).
- U-BRAINTEST: RUN live (exit 0) + deterministic fixture test.
- U-FRESHINJECT llm chain: RUN live (llm thought + real plink_ + LINK_CREATED observed; dedupe + converted proven separately).
- U-BREAKERVIS transport: RUN via stubs (live endpoint never errored).
- U-RETURNS/U-DELIVERY: resolver-level RUN; live LLM-emitted trust tokens NOT yet observed → Phase 3 probe closes this.
- U-VTOK/VSTACK/VLEN/VHUMOR/VDECLINE: RUN (unit + live validation_failed rows).
- Acceptance 8b pay step: BLOCKED on human payment (UPI/card interaction not scriptable here); all pre/post-conditions proven mechanically.
- Acceptance 8c (copy differs + valid): PARTIAL — varied strategies observed across probes; formal two-trigger capture runs in Phase 3.
- Acceptance 8d (kill flips + persists): NOT YET RUN → Phase 3.
- Acceptance 8f (fallback meter <40%/10 calls): meter did not exist → built in Phase 2, measured in Phase 3.
