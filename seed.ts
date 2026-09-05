/**
 * Sample-data seed. Uses the production code paths (HKDF identity, AES
 * contacts, hash-chained ledger) so the demo dataset is shaped exactly like
 * real data. Idempotent — safe to re-run. Buyer key printed ONCE (only when
 * newly created, console output only, never persisted in cleartext).
 */
import crypto from "node:crypto";
import pg from "pg";
import argon2 from "argon2";
import { loadConfig } from "./src/config.js";

loadConfig();
const { normalizeContact } = await import("./src/lib/identity.js");
const { identityTokenV2 } = await import("./src/lib/v5keys.js");
const { encrypt } = await import("./src/lib/crypto.js");
const { hashField } = await import("./src/lib/v5privacy.js");
const { appendLedger } = await import("./src/lib/ledger.js");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const MERCHANT_ID = "5a3ac6ce-b2c7-4b1f-a9db-45296841f30b";
const SITE_KEY = "sellable-track-key-demo-2024";
const SERVER_KEY = "sellable-server-key-demo-2024";

const P = {
  earbuds: "a1000000-0000-4000-a000-000000000001",
  case: "a1000000-0000-4000-a000-000000000002",
  coffee: "a1000000-0000-4000-a000-000000000003",
  powerbank: "a1000000-0000-4000-a000-000000000004",
  mouse: "a1000000-0000-4000-a000-000000000005",
  giftCable: "a1000000-0000-4000-a000-000000000006",
  giftClean: "a1000000-0000-4000-a000-000000000007",
  giftStand: "a1000000-0000-4000-a000-000000000008",
};

function tokenFor(contact: { email?: string; phone?: string }): string {
  return identityTokenV2(normalizeContact(contact).normalized);
}

async function upsertCustomer(client: any, contact: { email?: string; phone?: string }, segment: string, marketingOptIn: boolean | null, transactionalAnchors: string[]): Promise<string> {
  const token = tokenFor(contact);
  const raw = contact.phone || contact.email || "";
  const tx = JSON.stringify({
    anchor_cart_ids: transactionalAnchors,
    latest_anchor_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
  });
  const mk = JSON.stringify({
    opt_in: marketingOptIn === true,
    source: "merchant_server",
    consented_at: new Date().toISOString(),
  });
  const { rows } = await client.query(
    `INSERT INTO customers (merchant_id, identity_hash, contact_enc, segment, consent_transactional, consent_marketing, key_version)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 1)
     ON CONFLICT (merchant_id, identity_hash) DO UPDATE SET segment = $4 RETURNING id`,
    [MERCHANT_ID, token, raw ? encrypt(raw) : null, segment, tx, mk]
  );
  return rows[0].id;
}

async function seed() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    console.log("Seeding...");

    await client.query(
      `INSERT INTO merchants (id, name, status) VALUES ($1, 'Electronics Hub', 'active')
       ON CONFLICT (id) DO UPDATE SET name = 'Electronics Hub'`, [MERCHANT_ID]);

    await client.query(
      `INSERT INTO track_keys (merchant_id, key_type, key_hash, active) VALUES ($1, 'public_site', $2, true)
       ON CONFLICT (merchant_id, key_type) DO UPDATE SET key_hash = $2, active = true`, [MERCHANT_ID, SITE_KEY]);
    await client.query(
      `INSERT INTO track_keys (merchant_id, key_type, key_hash, active) VALUES ($1, 'secret_server', $2, true)
       ON CONFLICT (merchant_id, key_type) DO UPDATE SET key_hash = $2, active = true`, [MERCHANT_ID, SERVER_KEY]);

    const products = [
      { id: P.earbuds, name: "Wireless Earbuds", price: 159800, cost: 95900, stock: 50, gift: false },
      { id: P.case, name: "Phone Case Premium", price: 49900, cost: 29900, stock: 100, gift: false },
      { id: P.coffee, name: "Coffee Beans 1kg", price: 120000, cost: 70000, stock: 30, gift: false },
      { id: P.powerbank, name: "Power Bank 20000mAh", price: 189900, cost: 119900, stock: 25, gift: false },
      { id: P.mouse, name: "Wireless Mouse", price: 89900, cost: 53900, stock: 40, gift: false },
      // Gift-with-purchase shelf — value counted at COGS, never retail.
      { id: P.giftCable, name: "Cable Organizer", price: 19900, cost: 5900, stock: 20, gift: true },
      { id: P.giftClean, name: "Screen Cleaning Kit", price: 14900, cost: 3900, stock: 30, gift: true },
      { id: P.giftStand, name: "Phone Stand", price: 29900, cost: 8900, stock: 15, gift: true },
    ];
    for (const p of products) {
      await client.query(
        `INSERT INTO products (id, merchant_id, name, price_paise, cost_paise, stock, active, price_version, is_gift)
         VALUES ($1, $2, $3, $4, $5, $6, true, 1, $7)
         ON CONFLICT (id) DO UPDATE SET name = $3, price_paise = $4, cost_paise = $5, stock = $6, is_gift = $7`,
        [p.id, MERCHANT_ID, p.name, p.price, p.cost, p.stock, p.gift]
      );
    }
    console.log(`  Products: ${products.length} (3 gifts)`);

    // Riya — consented, high intent. Arjun — price sensitive, NO marketing consent.
    const riyaCartId = "c0c0c0c0-0000-4000-a000-000000000088";
    const riyaId = await upsertCustomer(client, { email: "riya@example.com", phone: "+919876543210" }, "first_visit_high_intent", true, [riyaCartId]);
    const arjunCartId = "c0c0c0c0-0000-4000-a000-000000000089";
    const arjunId = await upsertCustomer(client, { email: "arjun@example.com", phone: "+919876543211" }, "price_sensitive", null, [arjunCartId]);
    const controlId = await upsertCustomer(client, { email: "control@test.com", phone: "+919000000001" }, "repeat_touch", true, []);
    console.log(`  Riya: ${riyaId} / Arjun: ${arjunId} (no marketing consent) / Control: ${controlId}`);

    // 20 background customers (marketing only on repeat_touch arms — keeps the
    // Arjun consent gate exact for every price_sensitive row).
    for (let i = 0; i < 20; i++) {
      const phone = `+9190000001${String(i).padStart(2, "0")}`;
      const seg = ["repeat_touch", "price_sensitive", "first_visit_high_intent"][i % 3];
      await upsertCustomer(client, { email: `user${i}@test.com`, phone }, seg, i % 3 === 0 ? true : null, []);
    }
    console.log("  Background customers: 20");

    // Consent evidence rows (v1 text, hashed network evidence).
    for (const [cid, klass, opt] of [[riyaId, "marketing", true], [riyaId, "transactional", true]] as const) {
      await client.query(
        `INSERT INTO consent_events (merchant_id, customer_id, class, opt_in, source, evidence_ref, text_version, channel, ip_hash, ua_hash)
         VALUES ($1, $2, $3, $4, 'merchant_server', $5, 'v1', 'server_api', $6, $7)
         ON CONFLICT DO NOTHING`,
        [MERCHANT_ID, cid, klass, opt, `evidence-seed-${klass}`, hashField("seed"), hashField("seed")]
      );
    }

    // Riya's cart: abandoned 25h, checkout STARTED (segment checkout_started).
    const abandonRiya = new Date(Date.now() - 25 * 3600e3);
    await client.query(
      `INSERT INTO carts (id, merchant_id, customer_id, total_paise, status, abandoned_at, updated_at, checkout_started_at)
       VALUES ($1, $2, $3, 159800, 'abandoned', $4, $4, $4)
       ON CONFLICT (id) DO UPDATE SET status = 'abandoned', abandoned_at = $4, customer_id = $3, checkout_started_at = $4`,
      [riyaCartId, MERCHANT_ID, riyaId, abandonRiya]
    );
    await client.query("DELETE FROM cart_items WHERE cart_id = $1", [riyaCartId]);
    await client.query("INSERT INTO cart_items (cart_id, product_id, qty, unit_price_paise) VALUES ($1, $2, 1, 159800)", [riyaCartId, P.earbuds]);

    // Arjun's cart: abandoned 26h, phone case (his trigger clamps to plain).
    const abandonArjun = new Date(Date.now() - 26 * 3600e3);
    await client.query(
      `INSERT INTO carts (id, merchant_id, customer_id, total_paise, status, abandoned_at, updated_at)
       VALUES ($1, $2, $3, 49900, 'abandoned', $4, $4)
       ON CONFLICT (id) DO UPDATE SET status = 'abandoned', abandoned_at = $4, customer_id = $3`,
      [arjunCartId, MERCHANT_ID, arjunId, abandonArjun]
    );
    await client.query("DELETE FROM cart_items WHERE cart_id = $1", [arjunCartId]);
    await client.query("INSERT INTO cart_items (cart_id, product_id, qty, unit_price_paise) VALUES ($1, $2, 1, 49900)", [arjunCartId, P.case]);
    console.log("  Carts: Riya (25h, checkout-started) + Arjun (26h, consent-clamped)");

    // Prior touches so both are past the first-touch rule.
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    for (const cid of [riyaId, arjunId]) {
      await client.query(
        `INSERT INTO touches (merchant_id, customer_id, day, count) VALUES ($1, $2, $3, 1)
         ON CONFLICT (customer_id, day) DO NOTHING`, [MERCHANT_ID, cid, yesterday]);
    }

    // Failed order, 30 min old (failure-retry moment).
    const failTime = new Date(Date.now() - 30 * 60e3);
    const failCartId = "c0c0c0c0-0000-4000-a000-0000000000f1";
    await client.query(
      `INSERT INTO carts (id, merchant_id, customer_id, total_paise, status, abandoned_at, updated_at)
       VALUES ($1, $2, $3, 120000, 'abandoned', $4, $4) ON CONFLICT (id) DO NOTHING`,
      [failCartId, MERCHANT_ID, riyaId, failTime]
    );
    await client.query("DELETE FROM cart_items WHERE cart_id = $1", [failCartId]);
    await client.query("INSERT INTO cart_items (cart_id, product_id, qty, unit_price_paise) VALUES ($1, $2, 1, 120000)", [failCartId, P.coffee]);
    const { rows: failRows } = await client.query(
      `INSERT INTO orders (merchant_id, source, cart_id, customer_id, amount_paise, incentive_paise, margin_paise, status, created_at, failed_at, fee_basis)
       SELECT $1, 'recovery', $2, $3, 120000, 0, 48000, 'failed', $4, $4, 'modeled'
       WHERE NOT EXISTS (SELECT 1 FROM orders WHERE cart_id = $2 AND status = 'failed')
       RETURNING id`,
      [MERCHANT_ID, failCartId, riyaId, failTime]
    );
    console.log(`  Failed order: ${failRows[0]?.id || "(already seeded)"}`);

    // A real paid order (10 days ago, its OWN historical cart — never the live
    // abandoned carts) with a genuine ledger row — anchors review badges.
    // Skipped entirely on re-seed (sample order already present).
    const paidAt = new Date(Date.now() - 10 * 86400e3);
    const paidCartId = "c0c0c0c0-0000-4000-a000-000000000090";
    const { rows: paidExists } = await client.query(
      "SELECT id FROM orders WHERE cart_id = $1 AND status = 'paid' LIMIT 1", [paidCartId]);
    let paidOrderId: string | undefined;
    if (paidExists.length === 0) {
    await client.query(
      `INSERT INTO carts (id, merchant_id, customer_id, total_paise, status, abandoned_at, updated_at)
       VALUES ($1, $2, $3, 159800, 'converted', $4, $4) ON CONFLICT (id) DO NOTHING`,
      [paidCartId, MERCHANT_ID, riyaId, paidAt]
    );
    await client.query("DELETE FROM cart_items WHERE cart_id = $1", [paidCartId]);
    await client.query("INSERT INTO cart_items (cart_id, product_id, qty, unit_price_paise) VALUES ($1, $2, 1, 159800)", [paidCartId, P.earbuds]);
    const { seq: seedSeq } = await appendLedger({
      merchantId: MERCHANT_ID, actor: "SeedBot", action: "seed_sale",
      params: { amount_paise: 159800 }, decision: "ALLOW",
      policy_checks: { seed: "SAMPLE" },
      rationale: { reason: "sample paid order anchoring review badges" },
      outcome: "SUCCESS",
    });
    const { rows: paidRows } = await client.query(
      `INSERT INTO orders (merchant_id, source, cart_id, customer_id, amount_paise, incentive_paise, margin_paise, fee_paise, fee_basis, status, audit_seq, paid_at)
       VALUES ($1, 'recovery', $2, $3, 159800, 0, 63920, 3196, 'entity', 'paid', $4, $5)
       RETURNING id`,
      [MERCHANT_ID, paidCartId, riyaId, seedSeq, paidAt]
    );
    const paidOrderId: string | undefined = paidRows[0]?.id;

    // Sample reviews, mixed ratings (negatives included — the distribution needs them).
    const reviews = [
      { product: P.earbuds, rating: 5, text: "Superb sound, battery lasts for days.", mask: "Riya, Mumbai" },
      { product: P.earbuds, rating: 5, text: "Good value for money, pairs fast.", mask: "Amit, Delhi" },
      { product: P.earbuds, rating: 4, text: "Nice buds but the case feels light.", mask: "Sara, Bengaluru" },
      { product: P.case, rating: 5, text: "Perfect fit, grip is excellent.", mask: "Vikram, Pune" },
      { product: P.powerbank, rating: 2, text: "Heavy and slow to charge.", mask: "Neha, Jaipur" },
    ];
    for (const rv of reviews) {
      await client.query(
        `INSERT INTO reviews (merchant_id, product_id, customer_id, order_id, audit_seq, rating, text, reviewer_mask, token, delivery_confirmed_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'approved')
         ON CONFLICT DO NOTHING`,
        [MERCHANT_ID, rv.product, riyaId, String(paidOrderId), seedSeq, rv.rating, rv.text, rv.mask,
          `seed-${rv.product.slice(0, 8)}-${rv.rating}`, new Date(Date.now() - 9 * 86400e3)]
      );
    }
    console.log(`  Paid order ${String(paidOrderId).slice(0, 8)} (seq ${seedSeq}) + 5 reviews (5,5,4,5,2)`);
    } else {
      console.log("  Paid order + reviews already seeded");
    }

    // Segment priors + checkout_started seeded priors (labeled in-console).
    const statsData = [
      { segment: "repeat_touch", bucket: 0, attempts: 100, successes: 10 },
      { segment: "repeat_touch", bucket: 5000, attempts: 100, successes: 20 },
      { segment: "repeat_touch", bucket: 7500, attempts: 100, successes: 28 },
      { segment: "repeat_touch", bucket: 10000, attempts: 100, successes: 34 },
      { segment: "repeat_touch", bucket: 15000, attempts: 100, successes: 36 },
      { segment: "price_sensitive", bucket: 0, attempts: 80, successes: 8 },
      { segment: "price_sensitive", bucket: 5000, attempts: 80, successes: 16 },
      { segment: "first_visit_high_intent", bucket: 0, attempts: 50, successes: 12 },
      { segment: "checkout_started", bucket: 0, attempts: 20, successes: 3 },
      { segment: "checkout_started", bucket: 10000, attempts: 20, successes: 8 },
    ];
    for (const s of statsData) {
      await client.query(
        `INSERT INTO segment_stats (merchant_id, segment, bucket, attempts, successes)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (merchant_id, segment, bucket) DO UPDATE SET attempts = $4, successes = $5`,
        [MERCHANT_ID, s.segment, s.bucket, s.attempts, s.successes]
      );
    }
    console.log("  Segment stats (incl. SEEDED checkout_started priors 0.15/0.40)");

    // Experiment id cast so the deterministic holdout lands correctly:
    // Riya + Arjun treatment (hero + clamp moments), Control user control.
    await client.query(
      `INSERT INTO experiments (id, merchant_id, charter, status)
       VALUES ('e0000000-0000-4000-a000-000000000022', $1, $2, 'active')
       ON CONFLICT (id) DO UPDATE SET status = 'active'`,
      [MERCHANT_ID, JSON.stringify({ name: "exp_001", description: "Initial uplift experiment" })]
    );

    const policyRules = [
      { action: "payment_link", auto: 1000000, esc: 5000000, block: 10000000 },
      { action: "recovery_incentive", auto: 15000, esc: 50000, block: 100000 },
      { action: "upsell_discount", auto: 15000, esc: 25000, block: 50000 },
      { action: "refund", auto: 100000, esc: 500000, block: 1000000 },
    ];
    for (const r of policyRules) {
      await client.query(
        `INSERT INTO policy_rules (action, auto_limit_paise, escalate_limit_paise, hard_block_limit_paise, active)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (action) DO UPDATE SET auto_limit_paise = $2, escalate_limit_paise = $3, hard_block_limit_paise = $4`,
        [r.action, r.auto, r.esc, r.block]
      );
    }

    await client.query(
      `INSERT INTO daily_budget (day, merchant_id, cap_paise, reserved_paise, settled_paise, released_paise)
       VALUES (CURRENT_DATE, $1, 5000000, 0, 0, 0)
       ON CONFLICT (merchant_id, day) DO NOTHING`, [MERCHANT_ID]);

    // Merchant config defaults (shipping flat ₹0 until the merchant sets it).
    await client.query(
      `INSERT INTO merchant_config (merchant_id, key, value_jsonb, updated_by)
       VALUES ($1, 'shipping', $2, 'seed'), ($1, 'review_request', $3, 'seed')
       ON CONFLICT (merchant_id, key) DO NOTHING`,
      [MERCHANT_ID,
        JSON.stringify({ free_threshold_paise: 200000, flat_fee_paise: 0, eta_days: 5 }),
        JSON.stringify({ enabled: false, delay_days: 7 })]
    );

    // Admin: explicit ADMIN_PASSWORD in .env is source of truth (upserted so
    // a changed password actually takes effect); otherwise keep existing.
    const adminEmail = process.env.ADMIN_EMAIL || "admin@sellable.dev";
    if (process.env.ADMIN_PASSWORD) {
      const adminHash = await argon2.hash(process.env.ADMIN_PASSWORD);
      await client.query(
        `INSERT INTO merchant_admins (id, email, password_hash) VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE SET password_hash = $3`,
        [crypto.randomUUID(), adminEmail, adminHash]
      );
    } else {
      const adminHash = await argon2.hash("admin123");
      await client.query(
        `INSERT INTO merchant_admins (id, email, password_hash) VALUES ($1, $2, $3)
         ON CONFLICT (email) DO NOTHING`,
        [crypto.randomUUID(), adminEmail, adminHash]
      );
    }

    // Buyer API key — created once, printed ONCE (console only).
    const existing = await client.query("SELECT id FROM buyer_api_keys WHERE merchant_id = $1 AND label = 'demo-buyer-key' AND revoked_at IS NULL", [MERCHANT_ID]);
    let buyerKeyLine = "  Buyer key: (existing key retained — see original seed output)";
    if (existing.rows.length === 0) {
      const buyerKey = `sk_${crypto.randomBytes(32).toString("hex")}`;
      await client.query(
        `INSERT INTO buyer_api_keys (merchant_id, label, key_hash, rate_limit_per_min)
         VALUES ($1, 'demo-buyer-key', $2, 60)`, [MERCHANT_ID, await argon2.hash(buyerKey)]
      );
      buyerKeyLine = `  Buyer API key (SAVE NOW — printed once): ${buyerKey}`;
    }
    console.log(buyerKeyLine);

    await client.query("COMMIT");
    console.log("\nSeed complete!");
    console.log("  Riya cart: abandoned 25h, checkout-started, earbuds ₹1,598");
    console.log(`  Arjun: ${arjunId} (no marketing consent → clamped to plain)`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Seed failed:", err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(() => process.exit(1));
