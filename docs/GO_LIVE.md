# GO_LIVE.md — Production Go-Live Checklist (gated, not an env flip)

Each item is a gate: closed only with named evidence. Production flip
requires a go-live gate review, not a code change.

1. Scoped live keys in a secrets manager (test keys revoked; least-privilege
   IAM on the vault).
2. Live webhook verification (HMAC + freshness against production endpoint).
3. Refund/chargeback testing (full loop on live gateway in shadow mode first).
4. Consent service (double opt-in receipts; provider suppression sync).
5. MFA on all operator accounts (admin + deploy).
6. External ledger anchoring enabled (WORM checkpoints + merchant email —
   tamper-evident with external anchoring).
7. Reconciliation monitoring (alert on any unresolved critical exception;
   target: zero unresolved critical exceptions).
8. Incident runbook (kill switch, breaker, budget freeze — one page each).
9. Legal sign-off (ToS, privacy notice, consent wording, DLT templates).
10. Load + chaos rehearsal (budget races, crash injection, replay — all
    green on the staging clone).
