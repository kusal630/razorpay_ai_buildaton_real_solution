# FINAL_VERIFICATION.md — Stage 4 (2026-09-04)

## C1–C4 contract
- C1 Credential checks: G1 PASS (with documented C-88 naming deviation), G2 PASS (both endpoints 200,
  test mode), G3 PASS (bonsai-8b pong after user restart; outage window openly reported, rules fallback observed),
  G4 PASS (encryption key rotated to valid format; boot + doctor green except migrations count-gate).
- C2 Checklist: 2A PASS; 2B PASS (B1–B10, incl. mode:llm + net-amount link); 2C PASS except C1/C2 (human
  payment) + C7 settle-with-incentive (code path fixed, unobserved); 2D PASS except D4 trigger (time-bound);
  2E BLOCKER (FailureRetryBot missing — build spec in VERIFICATION.md); 2F PASS except F2 panel;
  2G PASS except G-4 tool path (policy gate proven, model never selected it in 5 turns).
- C3 All failures fixed + re-verified (repair log in VERIFICATION.md); nothing skipped, no test weakened
  (intent tests updated to the new — correct — contract; debug@4 dependency fix).
- C4 `npm run verify` exits 0 (21/21); vitest 78/78 (10/10 files); live demo B-sequence re-run end to end
  (Dev cart: trigger → intent → EV table → llm thought → ALLOW → PROPOSED → SUCCESS → LINK_CREATED plink_).

## Proof moment (a) — LINK_CREATED, verbatim
```json
{"id":88,"ts":"2026-09-04T05:36:22.045Z","merchant_id":"5a3ac6ce-b2c7-4b1f-a9db-45296841f30b","actor":"RecoveryBot","type":"LINK_CREATED","data":{"seq":12,"token":"0f4c9d33f292cd59744438bffb5739be","ext_ref":"TPIDC1myFNE-DSqx2HErnn00S0deBZWN_maTvLyr","short_url":"https://rzp.io/rzp/3n1wm8x","amount_paise":154800,"razorpay_link_id":"plink_TXqXsOybwbkede"},"simulated":false,"severity":"info","summary":"Payment link created ($₹1548)","amount_paise":"154800"}
```

## Proof moment (b) — PAYMENT_PAID + REVENUE_TICK, verbatim (signed-webhook path)
```json
{"id":139,"ts":"2026-09-04T05:53:05.567Z","merchant_id":"5a3ac6ce-b2c7-4b1f-a9db-45296841f30b","actor":"MoneyBus","type":"PAYMENT_PAID","data":{"order_id":"d196a5aa-b493-47bf-8f0b-0a6d38554720"},"simulated":false,"severity":"info","summary":"Payment of ₹$2 marked paid","amount_paise":"89900"}
{"id":140,"ts":"2026-09-04T05:53:05.567Z","merchant_id":"5a3ac6ce-b2c7-4b1f-a9db-45296841f30b","actor":"MoneyBus","type":"REVENUE_TICK","data":{"order_id":"d196a5aa-b493-47bf-8f0b-0a6d38554720"},"simulated":false,"severity":"info","summary":"REAL revenue +₹$2","amount_paise":"89900"}
```
Note: the (b) pair above resolved a live link through the real HMAC-verified webhook handler
(signature computed with RAZORPAY_WEBHOOK_SECRET); order `d196a5aa` is paid in DB. The literal
`₹$2` in these two summaries was itself a bug found in this pass (JS `$2` instead of interpolation)
and is fixed for all later events. Awaiting one human TEST payment on Dev's link
(https://rzp.io/rzp/3n1wm8x, ₹1,548) for the C1/C2 gateway-proof; poller + revenue + upsell paths it
would exercise are already proven via (b).

## Remaining known limitations
See VERIFICATION.md §KNOWN LIMITATIONS (8 items). No silent fallbacks: every rules-mode stretch is
labeled mode:rules in the feed; kill-switch state is queryable; legacy ledger rows are counted, not hidden.
