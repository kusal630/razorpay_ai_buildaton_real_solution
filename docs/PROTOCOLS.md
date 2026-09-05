# PROTOCOLS.md — Agent-Payments Alignment (AP2 / x402)

Google's Agent Payments Protocol (AP2, announced September 2025, 60+
partners including PayPal, Mastercard, and Checkout.com) standardizes how AI
agents pay on behalf of users. Sellable implements AP2 core patterns
natively; formal certification is a compliance roadmap item.

## Pattern map

| AP2 concept | Sellable implementation |
|-------------|-------------------------|
| Checkout sessions | `POST /agent/sessions` → quoted session lifecycle |
| Cryptographically signed cart mandates | Quote response carries `{items, total_paise, expires_at, jti, signature}` (HMAC, expiring, single-use ids); `purchase-intent` verifies signature, rejects replays (409) and tampering (422) |
| Agent receipts with audit_reference | Every money movement appends a hash-chained ledger row; receipts and ledger rows carry the opaque external reference reconciling to the gateway |
| Human approval for large orders | Policy escalation → approvals inbox; deny path makes no gateway call |

## x402 (Coinbase stablecoin interoperability)

x402 is future-compatible with this architecture: the money bus already
isolates all gateway calls behind a single capability, so an additional
settlement rail would land in one module. No x402 rails are built or
promised here.

## Claims discipline

This codebase is AP2-aligned: it implements AP2 patterns. Formal
certification requires ecosystem participation and sits on the
compliance roadmap.
