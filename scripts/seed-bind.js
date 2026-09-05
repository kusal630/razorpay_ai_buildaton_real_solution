#!/usr/bin/env node
/**
 * scripts/seed-bind.js — Demo/test data seeding via the REAL ingestion API.
 * Calls POST /api/track/bind-customer for each demo person so their
 * identity_hash and contact_enc are computed by the production crypto path
 * (HKDF identity token + AES contact, in src/lib/identity.ts via the
 * endpoint). Marketing consent goes through the REAL POST /api/track/consent
 * endpoint. This script MUST NEVER compute identity crypto itself.
 *
 * OBSERVED endpoint shapes (adapted — the endpoint is NOT changed):
 * - bind-customer request:  { cart_id (required), phone | email, name? }
 *   (flat contact fields; nested `contact` objects are rejected with 400)
 * - bind-customer response: { success, customerId, identityToken, isNew }
 *   (identityToken IS the identity_hash; no `identity_hash` field)
 * - bind-customer auth:     X-Server-Key must equal the merchant's
 *   `secret_server` track_keys row (seeded by seed.ts). NOT an env secret.
 * - carts.id is UUID-typed: legacy text cart ids (C-88, C-arj, ...) cannot be
 *   bound and people without carts have nothing to link. Those binds use a
 *   deterministic ghost UUID as the cart slot: the identity is still created
 *   through the real endpoint, zero cart rows are touched (the UPDATE matches
 *   nothing), and the run reports `cart: —`.
 *
 * MUST NEVER RUN IN LIVE MODE. This is a test/demo tool only.
 *
 * Env is loaded via `node --env-file=.env` (see the `seed-bind` npm script),
 * so no dotenv dependency is needed.
 */
import crypto from 'node:crypto';

// ── LIVE-MODE GUARD (structural safety) ─────────────────────────
if (process.env.RAZORPAY_MODE === 'live') {
  console.error('REFUSING TO RUN: seed-bind is a test/demo tool. ' +
    'It must never run in live mode against real merchant data.');
  process.exit(1);
}

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const SERVER_KEY = process.env.SERVER_KEY;

if (!SERVER_KEY) {
  console.error('SERVER_KEY missing from .env. It must equal the merchant\'s');
  console.error('`secret_server` track_keys row (seed.ts seeds the demo value).');
  process.exit(1);
}

// Real seeded carts (UUID-typed). Riya/Arjun rebind to their OWN carts
// (ownership unchanged, linkage re-asserted through the real endpoint).
const RIYA_CART = 'c0c0c0c0-0000-4000-a000-000000000088';
const ARJUN_CART = 'c0c0c0c0-0000-4000-a000-000000000089';

// ── THE DEMO PEOPLE (10 named + 10 background) ───────────────────
// phone (E.164), cart_id (real UUID or null = identity-only), segment
// (sent for documentation; the endpoint currently assigns 'default' to new
// rows and preserves the segment of existing ones), marketing consent
// (applied via the REAL consent endpoint, never inline).
const DEMO_PEOPLE = [
  // ── The 10 named demo people (each = one demo story) ──
  { name: 'riya',   phone: '+919876543210', cart_id: RIYA_CART,  segment: 'first_visit_high_intent', marketing: true  },
  { name: 'arjun',  phone: '+919876543211', cart_id: ARJUN_CART, segment: 'price_sensitive',         marketing: false },
  { name: 'priya',  phone: '+919000000001', cart_id: null,       segment: 'repeat_touch',            marketing: true  }, // control arm
  { name: 'vikram', phone: '+919876500004', cart_id: null,       segment: 'payment_failed',          marketing: false }, // failure-retry customer
  { name: 'neha',   phone: '+919876500005', cart_id: null,       segment: 'repeat_buyer',            marketing: true  },
  { name: 'karan',  phone: '+919876500006', cart_id: null,       segment: 'checkout_started',        marketing: false },
  { name: 'sneha',  phone: '+919876500007', cart_id: null,       segment: 'price_sensitive',         marketing: true  },
  { name: 'aditya', phone: '+919876500008', cart_id: null,       segment: 'repeat_buyer',            marketing: true  }, // paid-order customer
  { name: 'meera',  phone: '+919876500009', cart_id: null,       segment: 'default',                 marketing: true  }, // save-for-later
  { name: 'rohan',  phone: '+919876500010', cart_id: null,       segment: 'default',                 marketing: true  }, // refund/credit customer

  // ── 10 background customers (identity volume; no carts) ──
  ...Array.from({ length: 10 }, (_, i) => {
    const n = i + 1;
    const segments = ['first_visit_high_intent', 'price_sensitive', 'default', 'checkout_started'];
    return {
      name: `bg${n}`,
      phone: `+9198765010${String(n).padStart(2, '0')}`,
      cart_id: null,
      segment: segments[n % 4],
      marketing: n % 2 === 0,
    };
  }),
];

/**
 * Deterministic ghost UUID for the cart slot when a person has no real cart.
 * Cart linkage ONLY — never identity crypto (the endpoint owns that).
 * Stable across reruns so rebinds stay idempotent.
 */
function ghostCartUuid(phone) {
  const h = crypto.createHash('sha256').update(`seed-bind:ghost:${phone}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ── BIND ONE PERSON via the REAL endpoint ────────────────────────
async function bindPerson(person) {
  const bindCartId = person.cart_id || ghostCartUuid(person.phone);

  const res = await fetch(`${BASE_URL}/api/track/bind-customer`, {
    method: 'POST',
    headers: {
      'X-Server-Key': SERVER_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      cart_id: bindCartId,
      phone: person.phone,
      name: person.name,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '<no body>');
    throw new Error(`bind HTTP ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const customerId = data.customerId || data.customer_id || data.id;
  if (!customerId) {
    throw new Error(`bind response missing customer id: ${JSON.stringify(data).slice(0, 120)}`);
  }

  // Marketing consent via the REAL consent endpoint (bind-customer only
  // records transactional). Skipped for opt-outs: the DB default is already
  // opt_in=false and calling opt-out would fire the revocation path.
  let marketing = '—';
  if (person.marketing === true) {
    const cres = await fetch(`${BASE_URL}/api/track/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer_id: customerId,
        consent_type: 'marketing',
        opt_in: true,
        source: 'seed-bind',
        evidence_reference: 'demo_seed',
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!cres.ok) {
      const errText = await cres.text().catch(() => '<no body>');
      throw new Error(`consent HTTP ${cres.status}: ${errText}`);
    }
    marketing = 'yes';
  } else {
    marketing = 'no';
  }

  // The endpoint returns the REAL identity token (= identity_hash).
  const hashPrefix = data.identityToken
    ? String(data.identityToken).slice(0, 12)
    : '(read-back required)';

  return {
    name: person.name,
    phone: person.phone,
    customer_id: String(customerId),
    hash_prefix: hashPrefix,
    cart_bound: person.cart_id || '—',
    is_new: data.isNew === true ? 'new' : 'existing',
    marketing,
  };
}

// ── MAIN ─────────────────────────────────────────────────────────
async function main() {
  console.log('SELLABLE seed-bind — binding demo identities via the REAL API\n');
  console.log(`   Target: ${BASE_URL}/api/track/bind-customer`);
  console.log(`   Mode: ${process.env.RAZORPAY_MODE || 'test'} | People: ${DEMO_PEOPLE.length}\n`);

  const results = [];
  const failures = [];

  for (const person of DEMO_PEOPLE) {
    process.stdout.write(`   binding ${person.name.padEnd(8)} (${person.phone})... `);
    try {
      const result = await bindPerson(person);
      results.push(result);
      console.log('ok');
    } catch (err) {
      failures.push({ person: person.name, error: err.message });
      console.log(`FAIL (${err.message.slice(0, 80)})`);
    }
  }

  // ── SUMMARY TABLE ──
  console.log('\n+---------+-----------------+------------------+--------------+-----------+----------+-----------+');
  console.log('| Person  | Phone           | Customer ID      | Hash (12ch)  | Cart      | State    | Marketing |');
  console.log('+---------+-----------------+------------------+--------------+-----------+----------+-----------+');
  for (const r of results) {
    console.log(
      `| ${r.name.padEnd(7)} | ${r.phone.padEnd(15)} | ${r.customer_id.slice(0, 16).padEnd(16)} | ${r.hash_prefix.padEnd(12)} | ${r.cart_bound.slice(0, 9).padEnd(9)} | ${r.is_new.padEnd(8)} | ${r.marketing.padEnd(9)} |`
    );
  }
  console.log('+---------+-----------------+------------------+--------------+-----------+----------+-----------+');

  if (failures.length > 0) {
    console.log(`\n${failures.length} binding(s) FAILED:`);
    for (const f of failures) {
      console.log(`   ${f.person}: ${f.error}`);
    }
    process.exit(1);
  }

  // ── VERIFICATION GUIDANCE ──
  console.log('\nAll bindings complete. Verify with this SQL:');
  console.log("   SELECT count(*) FROM customers WHERE identity_hash LIKE 'hash_%' OR contact_enc LIKE 'enc_%';");
  console.log('   -- Expected: 0 (no placeholders remain)');
  console.log('\nRerunning seed-bind must be idempotent (existing customers update,');
  console.log('never duplicate — the endpoint upserts by phone-derived identity).');
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
