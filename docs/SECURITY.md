# SECURITY.md — Threat → Defense (with proving tests)

| Threat | Defense | Proved by |
|--------|---------|-----------|
| AI money-hallucination | Schema: model selects, code injects all numbers | `I3` verify gate; `llm.test.ts` |
| Prompt injection | Six validation layers + corrective retry + rules fallback | `v5.test.ts` M20 gates; injection fixtures |
| PII exposure | AES-256-GCM at rest; decrypt only in payment module; access-logged | `pii.test.ts`; grep gate (no decrypt outside moneyBus) |
| Anonymous abuse | Track-key split; contact rejected on public routes; unguessable tokens | `v3_2.test.ts` tracking gates |
| Budget races | Atomic conditional reservation; two-phase lifecycle | `intentExecutor.test.ts`; race fixtures |
| Crash mid-decision | Write-ahead intents + dedupe; at-most-once contact per window under crash | `auditLedger.test.ts`; crash-injection gate |
| Double charging | Cancel-before-create (fail closed); overpayment auto-refund | Dedupe + overpayment verify gates |
| Ledger tampering | Hash chain + DB append-only trigger + external checkpoints | Chain + `U-LEDG-TRIG` gates |
| Ceiling breach | Platform ceilings; raises pending 1h + step-up | `U-CEILING` gate |
| Replay / tamper (AI buyer) | Signed expiring single-use mandates; GSTIN-gated invoices | `U-MANDATE` + `U-GST` gates |
| Dark patterns | Grounded claims; one claim per message; no confirm-shaming | `U-GROUND`; `U-VSTACK`/`U-VDECLINE` |
| Availability attacks via crafted input | Validation rejections never trip the breaker (transport-only) | `U-BREAKER` gate |
| Quiet revocation gaps | Opt-out cancels intents in-request; 15s scheduler backstop | `U-CONSENT-EV2` gate |
| Silent data loss on erase | Tombstone ledger row; chain re-verifies; caps + consent retained | `U-ERASE` gate |

Residual risks (honest): a superuser can drop the DB trigger (external
checkpoints remain the anchor); per-identity crypto-shredding is roadmap
(current: erasure-lite); multi-merchant isolation is designed, not proven
here. Full claims language: tamper-evident with external anchoring (never the bare
unqualified variant); reconciliation target is zero unresolved critical
exceptions.
