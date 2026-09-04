# ARCHITECTURE.md — The Sandwich

```
  ┌─────────────┐   proposes strategy + copy (never numbers)
  │  AI agents  │──▶ Brain: recovery / retry / upsell / chat / buyer
  └──────┬──────┘
         │ feasible options (EV-ranked) + claim tokens
  ┌──────▼──────┐   disposes: ALLOW / CLAMP / BLOCK / ESCALATE / ABSTAIN
  │   Policy    │──▶ consent → margin → budget → experiment → ceilings
  └──────┬──────┘
         │ approved intent only
  ┌──────▼──────┐   owns every Razorpay call (capability-confined)
  │  Money bus  │──▶ cancel-before-create → PROPOSED → gateway → resolve
  └──────┬──────┘
         │ every transition appended
  ┌──────▼──────┐   hash-chained, append-only, externally checkpointed
  │   Ledger    │──▶ the proof everything else points to
  └─────────────┘
```

Module map: `agents/` propose; `lib/sharedBrain.js` + `lib/v5brain.js`
validate; `lib/policyEngine.js` + `lib/v5decision.js` dispose;
`lib/moneyBus.js` + `lib/razorpayService.js` move money;
`lib/ledger.js` proves; `lib/claims.js` grounds words; `lib/consent*.js` +
`lib/v5privacy.js` gate permission; `lib/identity.js` + `lib/v5keys.js`
pseudonymize; `jobs/v5dispatch.js` sweeps; `routes/` expose;
`public/` shows.

Trust boundaries: (1) model output is untrusted until validated;
(2) customer input is untrusted until policy-checked; (3) gateway state is
untrusted until reconciled; (4) operator input is untrusted until ceiling-
checked and audited. Contact semantics: exactly-once happy path;
at-most-once contact per window under crash.
