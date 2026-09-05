#!/usr/bin/env node
/**
 * scripts/seed-real.js — Production-path seeding for the 12 test cases.
 *
 * Split (honest): customer/cart/consent data enters through the REAL API
 * endpoints (same code path production traffic uses); historical state
 * (old orders, refunds, stats, control arm) is PRINTED as SQL below and
 * saved to scripts/seed-history.last.sql — because no API can create
 * "an order from 12 days ago."
 *
 * ADAPTED to observed shapes (the endpoints are NOT changed):
 * - POST /api/track/cart (X-Site-Key = public_site track key): body
 *   { cart_id (UUID), items: [{ id: <product UUID>, qty }] }. Totals are
 *   server-computed; unknown product ids yield ₹0 carts.
 * - POST /api/track/bind-customer (X-Server-Key = secret_server track key):
 *   body { cart_id (UUID, required), phone | email, name? } — flat contact
 *   fields; returns { customerId, identityToken (= identity_hash), isNew }.
 * - POST /api/track/consent (no auth): { customer_id, consent_type,
 *   opt_in, source, evidence_reference } — the marketing-consent path
 *   (bind-customer records transactional only).
 * - POST /api/track/checkout-start (no auth): { cart_id }.
 * - Identity hashes are HKDF-derived `v2:` tokens — NEVER sha256(phone).
 *   The history SQL below uses the customer_ids CAPTURED from the bind
 *   responses, never guessed hashes.
 * - Product ids are catalog UUIDs (see PRODUCTS). prod_hub/prod_charger
 *   have no exact catalog match and map to the closest stand-ins.
 *
 * MUST NEVER RUN IN LIVE MODE. Test/demo tool only.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── LIVE-MODE GUARD (structural safety) ─────────────────────────
if (process.env.RAZORPAY_MODE === 'live') {
  console.error('REFUSING TO RUN: seed-real is a test/demo tool. ' +
    'It must never run in live mode against real merchant data.');
  process.exit(1);
}

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const SERVER_KEY = process.env.SERVER_KEY;
const SITE_KEY = process.env.SITE_KEY || 'sellable-track-key-demo-2024';
const MERCHANT_ID = '5a3ac6ce-b2c7-4b1f-a9db-45296841f30b';

if (!SERVER_KEY) {
  console.error('SERVER_KEY missing from .env — must equal the merchant\'s');
  console.error('`secret_server` track_keys row (seed.ts seeds the demo value).');
  process.exit(1);
}

// Real catalog UUIDs (seed.ts). No hub/charger rows exist: prod_hub maps to
// the mouse (same price point), prod_charger to coffee (closest price).
const PRODUCTS = {
  prod_earbuds: 'a1000000-0000-4000-a000-000000000001',
  prod_case: 'a1000000-0000-4000-a000-000000000002',
  prod_hub: 'a1000000-0000-4000-a000-000000000005',
  prod_powerbank: 'a1000000-0000-4000-a000-000000000004',
  prod_charger: 'a1000000-0000-4000-a000-000000000003',
  prod_mouse: 'a1000000-0000-4000-a000-000000000005',
};

// ─── THE 12 PEOPLE (each = one test case) ───
const PEOPLE = [
  { key: 'riya',   name: 'Riya Sharma',  phone: '+919876543210', segment: 'first_visit_high_intent', marketing: true,  product: 'prod_earbuds',   qty: 1, abandonedHours: 25, checkoutStarted: true,  tc: 'TC1: flagship recovery, EV-positive incentive' },
  { key: 'arjun',  name: 'Arjun Mehta',  phone: '+9198765012345', segment: 'price_sensitive',         marketing: false, product: 'prod_case',      qty: 1, abandonedHours: 30, checkoutStarted: false, tc: 'TC2: consent clamp — no marketing consent' },
  { key: 'priya',  name: 'Priya Nair',   phone: '+9198209876543', segment: 'default',                 marketing: false, product: 'prod_hub',       qty: 1, abandonedHours: 26, checkoutStarted: false, control: true, tc: 'TC3: control-arm suppression' },
  { key: 'vikram', name: 'Vikram Singh', phone: '+9198112233445', segment: 'payment_failed',          marketing: false, product: 'prod_powerbank', qty: 1, abandonedHours: 0,  checkoutStarted: true,  tc: 'TC4: failed-payment retry, ₹0 incentive' },
  { key: 'neha',   name: 'Neha Gupta',   phone: '+9198730044556', segment: 'repeat_buyer',            marketing: true,  product: 'prod_charger',   qty: 1, abandonedHours: 28, checkoutStarted: true,  priorOrder: true, tc: 'TC5: 30-day incentive cap' },
  { key: 'karan',  name: 'Karan Patel',  phone: '+9199250066778', segment: 'checkout_started',        marketing: false, product: 'prod_earbuds',   qty: 1, abandonedHours: 6,  checkoutStarted: true,  tc: 'TC6: checkout-started segment split' },
  { key: 'sneha',  name: 'Sneha Reddy',  phone: '+9199630077889', segment: 'price_sensitive',         marketing: true,  product: 'prod_case',      qty: 1, abandonedHours: 22, checkoutStarted: false, cycles: 3, tc: 'TC7: serial abandoner covariate' },
  { key: 'aditya', name: 'Aditya Rao',   phone: '+9199490088990', segment: 'repeat_buyer',            marketing: true,  product: null,             qty: 0, abandonedHours: 0,  checkoutStarted: false, priorOrder: true, tc: 'TC8: UpsellBot on paid order' },
  { key: 'meera',  name: 'Meera Iyer',   phone: '+9199400099001', segment: 'default',                 marketing: true,  product: 'prod_earbuds',   qty: 1, abandonedHours: 0,  checkoutStarted: false, saveForLater: true, tc: 'TC9: save-for-later + price-watch' },
  { key: 'rohan',  name: 'Rohan Kumar',  phone: '+9199110011002', segment: 'default',                 marketing: true,  product: null,             qty: 0, abandonedHours: 0,  checkoutStarted: false, refund: true, tc: 'TC10: refund → store credit' },
  { key: 'deepak', name: 'Deepak Verma', phone: '+9198100011003', segment: 'first_visit_high_intent', marketing: true,  product: 'prod_powerbank', qty: 1, abandonedHours: 5,  checkoutStarted: true,  tc: 'TC11: fresh high-intent (5h)' },
  { key: 'ananya', name: 'Ananya Das',   phone: '+9198000011004', segment: 'default',                 marketing: false, product: 'prod_mouse',     qty: 1, abandonedHours: 4,  checkoutStarted: false, tc: 'TC12: recent abandoner (4h)' },
];

/** Deterministic cart UUID per person (stable across reruns). */
function cartUuid(key) {
  const h = crypto.createHash('sha256').update(`seed-real:cart:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function api(method, path, body, headers = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

const track = (path, body) => api('POST', `/api/track/${path}`, body, { 'X-Track-Key': SITE_KEY });
const bind = (path, body) => api('POST', `/api/track/${path}`, body, { 'X-Server-Key': SERVER_KEY });

async function main() {
  console.log('SELLABLE — Production-Path Seed (12 test cases)\n');

  const bound = {}; // key → { customerId, cartId, hashPrefix, isNew }

  // STEP 1: carts + contacts + consent — all through the REAL API.
  for (const p of PEOPLE) {
    const cartId = p.product ? cartUuid(p.key) : null;
    try {
      if (p.product) {
        const r = await track('cart', { cart_id: cartId, items: [{ id: PRODUCTS[p.product], qty: p.qty || 1 }] });
        console.log(`ok ${p.name}: cart ${cartId.slice(0, 8)} (server total ₹${((r.total_paise || 0) / 100).toFixed(0)})`);
      }
      // Ghost slot only when there is no cart: identity still enters via the
      // real endpoint; zero cart rows are touched (UPDATE matches nothing).
      const b = await bind('bind-customer', {
        cart_id: cartId || cartUuid(`ghost:${p.key}`),
        phone: p.phone,
        name: p.name,
      });
      const customerId = b.customerId || b.customer_id || b.id;
      if (!customerId) throw new Error(`bind response missing customer id: ${JSON.stringify(b).slice(0, 120)}`);
      console.log(`ok ${p.name}: bound ${String(customerId).slice(0, 8)} (${b.isNew ? 'new' : 'existing'}, hash ${(b.identityToken || '').slice(0, 12)})`);
      if (p.marketing === true) {
        await track('consent', {
          customer_id: customerId, consent_type: 'marketing', opt_in: true,
          source: 'seed-real', evidence_reference: `seed_${p.key}`,
        });
        console.log(`ok ${p.name}: marketing consent (REAL consent endpoint)`);
      }
      if (p.checkoutStarted && cartId) {
        await track('checkout-start', { cart_id: cartId });
        console.log(`ok ${p.name}: checkout-start (transactional anchor)`);
      }
      bound[p.key] = { customerId: String(customerId), cartId, hashPrefix: String(b.identityToken || '').slice(0, 12), isNew: !!b.isNew };
      console.log(`   → ${p.tc}\n`);
    } catch (e) {
      console.error(`FAIL ${p.name}: ${e.message}`);
      console.error(`   ADAPT: endpoints exist — expected bind body { cart_id (UUID), phone|email, name? } with X-Server-Key; cart body { cart_id (UUID), items: [{ id (product UUID), qty }] } with X-Site-Key.\n`);
    }
  }

  // STEP 2: historical-state SQL with CAPTURED ids (no hash guessing).
  const failures = PEOPLE.filter((p) => !bound[p.key]);
  if (failures.length > 0) {
    console.error(`${failures.length} people failed to bind — history SQL skipped (run again; binds are idempotent).`);
    process.exit(1);
  }
  const sql = generateHistoricalSQL(bound);
  const outPath = path.join(__dirname, 'seed-history.last.sql');
  fs.writeFileSync(outPath, sql);
  console.log('═══ HISTORICAL STATE SQL (also saved to scripts/seed-history.last.sql) ═══');
  console.log(sql);
  console.log('═══ END SQL ═══');
  console.log(`\n${Object.keys(bound).length} people seeded via API. Run the SQL above, then restart.`);
}

// Fixed UUIDs for history rows (idempotent reruns via ON CONFLICT / NOT EXISTS).
const H = {
  vikramOrder: 'c1000000-0000-4000-a000-000000000001',
  nehaOrder: 'c1000000-0000-4000-a000-000000000002',
  adityaOrder: 'c1000000-0000-4000-a000-000000000003',
  rohanOrder: 'c1000000-0000-4000-a000-000000000004',
  rohanCredit: 'c1000000-0000-4000-a000-000000000005',
  policy: 'c1000000-0000-4000-a000-000000000006',
};

/**
 * SQL for what APIs cannot create: history, stats, control arm, policy.
 * Idempotent: fixed row ids + ON CONFLICT DO NOTHING / WHERE NOT EXISTS;
 * cart/cycle updates SET absolute values. Buckets are paise-scale like
 * seed.ts (0/5000/10000/15000), topping up only segments seed.ts lacks.
 */
function generateHistoricalSQL(bound) {
  const c = (key) => bound[key].customerId;
  const cart = (key) => bound[key].cartId;
  const cartUpdate = (key, hours) => cart(key)
    ? `UPDATE carts SET status = 'abandoned', abandoned_at = now() - interval '${hours} hours' WHERE id = '${cart(key)}';`
    : `-- ${key}: no cart (nothing to abandon)`;

  return `-- ═══ SELLABLE — HISTORICAL STATE FOR ALL 12 TEST CASES ═══
-- Generated by scripts/seed-real.js with customer_ids CAPTURED from the
-- bind-customer responses. Idempotent — safe to rerun.
-- Run AFTER the API seed, in the Supabase SQL Editor (or psql).

BEGIN;

-- TC4: Vikram — failed payment 30 min ago (fires ₹0 retry)
INSERT INTO orders (id, merchant_id, source, customer_id, amount_paise, fee_paise, fee_basis, incentive_paise, margin_paise, status, simulated, created_at, failed_at)
VALUES ('${H.vikramOrder}', '${MERCHANT_ID}', 'direct', '${c('vikram')}', 149900, 0, 'modeled', 0, 55000, 'failed', false, now() - interval '30 minutes', now() - interval '30 minutes')
ON CONFLICT (id) DO NOTHING;

-- TC5: Neha — prior paid order WITH ₹100 incentive, 12 days ago (30-day cap sees it)
INSERT INTO orders (id, merchant_id, source, customer_id, amount_paise, fee_paise, fee_basis, incentive_paise, margin_paise, status, simulated, created_at, paid_at)
VALUES ('${H.nehaOrder}', '${MERCHANT_ID}', 'recovery', '${c('neha')}', 109900, 2198, 'entity', 10000, 48000, 'paid', false, now() - interval '12 days', now() - interval '12 days')
ON CONFLICT (id) DO NOTHING;

-- TC8: Aditya — paid order 2 days ago (UpsellBot trigger)
INSERT INTO orders (id, merchant_id, source, customer_id, amount_paise, fee_paise, fee_basis, incentive_paise, margin_paise, status, simulated, created_at, paid_at)
VALUES ('${H.adityaOrder}', '${MERCHANT_ID}', 'direct', '${c('aditya')}', 209700, 4194, 'entity', 0, 80000, 'paid', false, now() - interval '2 days', now() - interval '2 days')
ON CONFLICT (id) DO NOTHING;

-- TC10: Rohan — refunded order + refund row + store credit
INSERT INTO orders (id, merchant_id, source, customer_id, amount_paise, fee_paise, fee_basis, incentive_paise, margin_paise, status, simulated, created_at, paid_at, refunded_paise)
VALUES ('${H.rohanOrder}', '${MERCHANT_ID}', 'direct', '${c('rohan')}', 99900, 1998, 'entity', 0, 40000, 'refunded', false, now() - interval '8 days', now() - interval '8 days', 99900)
ON CONFLICT (id) DO NOTHING;

INSERT INTO refunds (merchant_id, order_id, razorpay_refund_id, amount_paise, status, created_at)
SELECT '${MERCHANT_ID}', '${H.rohanOrder}', 'rfnd_seed_rohan', 99900, 'processed', now() - interval '3 days'
WHERE NOT EXISTS (SELECT 1 FROM refunds WHERE order_id = '${H.rohanOrder}');

INSERT INTO credit_ledger (id, merchant_id, customer_id, order_id, amount_paise, bonus_paise, status, expires_at)
SELECT '${H.rohanCredit}', '${MERCHANT_ID}', '${c('rohan')}', '${H.rohanOrder}', 99900, 0, 'active', now() + interval '30 days'
WHERE NOT EXISTS (SELECT 1 FROM credit_ledger WHERE order_id = '${H.rohanOrder}');

-- Abandonment timestamps (absolute SET — reruns converge)
${cartUpdate('riya', 25)}
${cartUpdate('arjun', 30)}
${cartUpdate('priya', 26)}
-- vikram: cart stays active (trigger is the failed order, not abandonment)
${cartUpdate('neha', 28)}
${cartUpdate('karan', 6)}
${cartUpdate('sneha', 22)}
-- aditya: no cart (trigger is the paid order)
-- meera: cart stays active (save-for-later story)
-- rohan: no cart (trigger is the refund/credit)
${cartUpdate('deepak', 5)}
${cartUpdate('ananya', 4)}

-- TC7: Sneha's serial-abandonment covariate
UPDATE customers SET abandonment_cycles = 3 WHERE id = '${c('sneha')}';

-- TC9: Meera's price watch (earbuds, watches below current ₹1598)
INSERT INTO price_watches (merchant_id, customer_id, product_id, watched_price_paise)
SELECT '${MERCHANT_ID}', '${c('meera')}', '${PRODUCTS.prod_earbuds}', 149900
WHERE NOT EXISTS (SELECT 1 FROM price_watches WHERE customer_id = '${c('meera')}' AND product_id = '${PRODUCTS.prod_earbuds}');

-- Learning statistics top-up (paise buckets like seed.ts; only segments it lacks)
INSERT INTO segment_stats (merchant_id, segment, bucket, attempts, successes)
VALUES
  ('${MERCHANT_ID}', 'default', 0, 60, 6), ('${MERCHANT_ID}', 'default', 5000, 60, 11),
  ('${MERCHANT_ID}', 'default', 10000, 60, 16),
  ('${MERCHANT_ID}', 'payment_failed', 0, 50, 20),
  ('${MERCHANT_ID}', 'repeat_buyer', 0, 70, 25), ('${MERCHANT_ID}', 'repeat_buyer', 10000, 70, 38)
ON CONFLICT DO NOTHING;

-- Policy v1 record (enforcement reads policy_rules, seeded by seed.ts; this is the audit record)
INSERT INTO policies (id, merchant_id, version, matrix, active)
VALUES ('${H.policy}', '${MERCHANT_ID}', 1, '{"payment_link":{"auto_allow_paise":1000000,"escalate_paise":5000000},"recovery_incentive":{"auto_allow_paise":15000,"max_pct_of_margin":25,"escalate_paise":50000},"upsell_discount":{"auto_allow_pct":15,"escalate_pct":25},"touch_per_day":{"auto_allow":2,"escalate":3},"quiet_hours_ist":["21:00","09:00"],"first_touch_bucket":0,"incentive_per_30d":1,"daily_budget_paise":500000,"payment_failed_default_incentive":0,"ai_cost_per_action":200}'::jsonb, true)
ON CONFLICT (id) DO NOTHING;

-- Today's budget row (cap required)
INSERT INTO daily_budget (merchant_id, day, cap_paise, reserved_paise, settled_paise, released_paise)
VALUES ('${MERCHANT_ID}', TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD'), 5000000, 0, 0, 0)
ON CONFLICT DO NOTHING;

-- TC3: Priya forced to the control arm of the CURRENTLY active experiment
-- (targets the latest active row dynamically, so a newer experiment cannot
-- silently move her back to treatment).
INSERT INTO cohort_assignments (merchant_id, customer_id, experiment_id, arm)
SELECT '${MERCHANT_ID}', '${c('priya')}', e.id, 'control'
FROM experiments e WHERE e.status = 'active' ORDER BY e.created_at DESC LIMIT 1
ON CONFLICT (customer_id, experiment_id) DO UPDATE SET arm = 'control';

COMMIT;

-- ═══ VERIFY: every test case has its trigger (all rows must be ≥ 1) ═══
SELECT 'TC1_riya_abandoned' AS check, COUNT(*) FROM carts WHERE id = '${cart('riya')}' AND status = 'abandoned'
UNION ALL SELECT 'TC2_arjun_abandoned', COUNT(*) FROM carts WHERE id = '${cart('arjun')}' AND status = 'abandoned'
UNION ALL SELECT 'TC3_priya_control', COUNT(*) FROM cohort_assignments WHERE customer_id = '${c('priya')}' AND arm = 'control'
UNION ALL SELECT 'TC4_vikram_failed', COUNT(*) FROM orders WHERE id = '${H.vikramOrder}' AND status = 'failed'
UNION ALL SELECT 'TC5_neha_prior', COUNT(*) FROM orders WHERE id = '${H.nehaOrder}' AND status = 'paid'
UNION ALL SELECT 'TC7_sneha_cycles', COUNT(*) FROM customers WHERE id = '${c('sneha')}' AND abandonment_cycles = 3
UNION ALL SELECT 'TC8_aditya_paid', COUNT(*) FROM orders WHERE id = '${H.adityaOrder}' AND status = 'paid'
UNION ALL SELECT 'TC9_meera_watch', COUNT(*) FROM price_watches WHERE customer_id = '${c('meera')}'
UNION ALL SELECT 'TC10_rohan_credit', COUNT(*) FROM credit_ledger WHERE order_id = '${H.rohanOrder}'
UNION ALL SELECT 'policy_v1', COUNT(*) FROM policies WHERE id = '${H.policy}'
UNION ALL SELECT 'stats_default', COUNT(*) FROM segment_stats WHERE segment = 'default';
`;
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
