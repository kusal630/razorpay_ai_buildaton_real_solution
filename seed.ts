import crypto from "node:crypto";
import pg from "pg";
import argon2 from "argon2";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const MERCHANT_ID = "5a3ac6ce-b2c7-4b1f-a9db-45296841f30b";
const SITE_KEY = "sellable-track-key-demo-2024";
const SERVER_KEY = "sellable-server-key-demo-2024";

function enc(s: string): string { return s; }
function hmac(val: string): string { return crypto.createHmac("sha256", "sellable-identity-secret-v1").update(val).digest("hex"); }

async function seed() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    console.log("Seeding...");

    // Merchant
    await client.query(`INSERT INTO merchants (id, name, track_key_hash) VALUES ($1, 'Electronics Hub', $2) ON CONFLICT (id) DO UPDATE SET name = 'Electronics Hub'`, [MERCHANT_ID, SITE_KEY]);

    // Track keys
    await client.query(`INSERT INTO track_keys (merchant_id, key_type, key_hash, active) VALUES ($1, 'public_site', $2, true) ON CONFLICT (merchant_id, key_type) DO UPDATE SET key_hash = $2, active = true`, [MERCHANT_ID, SITE_KEY]);
    await client.query(`INSERT INTO track_keys (merchant_id, key_type, key_hash, active) VALUES ($1, 'secret_server', $2, true) ON CONFLICT (merchant_id, key_type) DO UPDATE SET key_hash = $2, active = true`, [MERCHANT_ID, SERVER_KEY]);

    // Products (5 items) - use deterministic UUIDs
    const products = [
      { id: "a1000000-0000-4000-a000-000000000001", name: "Wireless Earbuds", price: 159800, cost: 95900, stock: 50 },
      { id: "a1000000-0000-4000-a000-000000000002", name: "Phone Case Premium", price: 49900, cost: 29900, stock: 100 },
      { id: "a1000000-0000-4000-a000-000000000003", name: "Coffee Beans 1kg", price: 120000, cost: 70000, stock: 30 },
      { id: "a1000000-0000-4000-a000-000000000004", name: "Power Bank 20000mAh", price: 189900, cost: 119900, stock: 25 },
      { id: "a1000000-0000-4000-a000-000000000005", name: "Wireless Mouse", price: 89900, cost: 53900, stock: 40 },
    ];
    for (const p of products) {
      await client.query(
        `INSERT INTO products (id, merchant_id, name, price_paise, cost_paise, stock, active, price_version)
         VALUES ($1, $2, $3, $4, $5, $6, true, 1) ON CONFLICT (id) DO UPDATE SET name = $3, price_paise = $4, cost_paise = $5, stock = $6`,
        [p.id, MERCHANT_ID, p.name, p.price, p.cost, p.stock]
      );
    }
    console.log(`  Products: ${products.length}`);

    // Customers (23: Riya, Arjun, 1 control, 20 background)
    const riyaPhone = "+919876543210";
    const riyaEmail = "riya@example.com";
    const riyaToken = hmac(riyaPhone);
    const riyaCartId = "c0c0c0c0-0000-4000-a000-000000000088";
    const { rows: riyaRows } = await client.query(
      `INSERT INTO customers (merchant_id, name_enc, email_enc, phone_enc, segment, identity_token, consent_transactional, consent_marketing)
       VALUES ($1, $2, $3, $4, 'first_visit_high_intent', $5, $6, $7)
       ON CONFLICT (merchant_id, identity_token) DO UPDATE SET segment = 'first_visit_high_intent',
         consent_transactional = $6, consent_marketing = $7
       RETURNING id`,
      [MERCHANT_ID, enc("Riya Sharma"), enc(riyaEmail), enc(riyaPhone), riyaToken,
       JSON.stringify({ anchor_cart_ids: [riyaCartId], latest_anchor_at: new Date().toISOString(), expires_at: new Date(Date.now() + 7*86400000).toISOString() }),
       JSON.stringify({ opt_in: true, source: "merchant_server", consented_at: new Date().toISOString() })]
    );
    const riyaId = riyaRows[0].id;
    console.log(`  Riya: ${riyaId}`);

    // Arjun - NO marketing consent
    const arjunPhone = "+919876543211";
    const arjunToken = hmac(arjunPhone);
    const { rows: arjunRows } = await client.query(
      `INSERT INTO customers (merchant_id, name_enc, email_enc, phone_enc, segment, identity_token, consent_transactional)
       VALUES ($1, $2, $3, $4, 'price_sensitive', $5, $6)
       ON CONFLICT (merchant_id, identity_token) DO UPDATE SET segment = 'price_sensitive'
       RETURNING id`,
      [MERCHANT_ID, enc("Arjun Patel"), enc("arjun@example.com"), enc(arjunPhone), arjunToken,
       JSON.stringify({ anchor_cart_ids: [], latest_anchor_at: new Date().toISOString(), expires_at: new Date(Date.now() + 7*86400000).toISOString() })]
    );
    const arjunId = arjunRows[0].id;
    console.log(`  Arjun: ${arjunId}`);

    // Control-arm customer
    const controlToken = hmac("+919000000001");
    const { rows: controlRows } = await client.query(
      `INSERT INTO customers (merchant_id, name_enc, email_enc, phone_enc, segment, identity_token, consent_marketing)
       VALUES ($1, $2, $3, $4, 'repeat_touch', $5, $6) ON CONFLICT (merchant_id, identity_token) DO UPDATE SET segment = 'repeat_touch' RETURNING id`,
      [MERCHANT_ID, enc("Control User"), enc("control@test.com"), enc("+919000000001"), controlToken,
       JSON.stringify({ opt_in: true, source: "explicit", consented_at: new Date().toISOString() })]
    );
    const controlId = controlRows[0].id;
    console.log(`  Control: ${controlId}`);

    // 20 background customers
    const bgTokens: string[] = [];
    for (let i = 0; i < 20; i++) {
      const phone = `+9190000001${String(i).padStart(2, "0")}`;
      const token = hmac(phone);
      const segments = ["repeat_touch", "price_sensitive", "first_visit_high_intent"];
      const seg = segments[i % 3];
      const hasMarketing = i % 3 === 0;
      await client.query(
        `INSERT INTO customers (merchant_id, name_enc, email_enc, phone_enc, segment, identity_token${hasMarketing ? ', consent_marketing' : ''})
         VALUES ($1, $2, $3, $4, $5, $6${hasMarketing ? ', $7' : ''})
         ON CONFLICT (merchant_id, identity_token) DO UPDATE SET segment = $5`,
        hasMarketing
          ? [MERCHANT_ID, enc(`User ${i}`), enc(`user${i}@test.com`), enc(phone), seg, token, JSON.stringify({ opt_in: true, source: "explicit" })]
          : [MERCHANT_ID, enc(`User ${i}`), enc(`user${i}@test.com`), enc(phone), seg, token]
      );
      bgTokens.push(token);
    }
    console.log("  Background customers: 20");

    // Consent events for Riya
    await client.query(
      `INSERT INTO consent_events (customer_id, consent_type, opt_in, source, evidence_reference, merchant_id)
       VALUES ($1, 'marketing', true, 'merchant_server', 'evidence-riya-marketing-001', $2)`,
      [riyaId, MERCHANT_ID]
    );
    await client.query(
      `INSERT INTO consent_events (customer_id, consent_type, opt_in, source, evidence_reference, merchant_id)
       VALUES ($1, 'transactional', true, 'merchant_server', 'evidence-riya-transactional-001', $2)`,
      [riyaId, MERCHANT_ID]
    );

    // Riya's abandoned cart (C-88) abandoned 25h ago — use UUID
    const abandonTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await client.query(
      `INSERT INTO carts (id, merchant_id, customer_id, items_json, total_paise, status, abandoned_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'abandoned', $6, $6)
       ON CONFLICT (id) DO UPDATE SET status = 'abandoned', abandoned_at = $6, customer_id = $3`,
      [riyaCartId, MERCHANT_ID, riyaId, JSON.stringify([{ id: "a1000000-0000-4000-a000-000000000001", qty: 1 }]), 159800, abandonTime]
    );
    console.log("  Cart Riya (abandoned 25h ago, earbuds ₹1,598)");

    // Give Riya a prior touch so she's not first-touch (first-touch rule blocks all incentives)
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    await client.query(
      `INSERT INTO touches (customer_id, day, count) VALUES ($1, $2, 1) ON CONFLICT (customer_id, day) DO NOTHING`,
      [riyaId, yesterday]
    );

    // Payment-failure order (30 min old)
    const failTime = new Date(Date.now() - 30 * 60 * 1000);
    const failCartId = "c0c0c0c0-0000-4000-a000-0000000000f1";
    // Create a cart for the failed order
    await client.query(
      `INSERT INTO carts (id, merchant_id, customer_id, items_json, total_paise, status, abandoned_at, updated_at)
       VALUES ($1, $2, $3, $4, 120000, 'abandoned', $5, $5)
       ON CONFLICT (id) DO NOTHING`,
      [failCartId, MERCHANT_ID, riyaId, JSON.stringify([{ id: "a1000000-0000-4000-a000-000000000003", qty: 1 }]), failTime]
    );
    const { rows: failOrderRows } = await client.query(
      `INSERT INTO orders (merchant_id, source, cart_id, customer_id, amount_paise, status, created_at, fee_basis)
       VALUES ($1, 'recovery', $2, $3, 120000, 'failed', $4, 'modeled') RETURNING id`,
      [MERCHANT_ID, failCartId, riyaId, failTime]
    );
    console.log(`  Failed order: ${failOrderRows[0].id}`);

    // Segment_stats priors {0: 10/100, 50: 20/100, 75: 28/100, 100: 34/100, 150: 36/100}
    // (v4.2 P7: 7500 interpolated between the 5000 and 10000 priors)
    const statsData = [
      { segment: "repeat_touch", bucket: 0, attempts: 100, successes: 10 },
      { segment: "repeat_touch", bucket: 5000, attempts: 100, successes: 20 },
      { segment: "repeat_touch", bucket: 7500, attempts: 100, successes: 28 },
      { segment: "repeat_touch", bucket: 10000, attempts: 100, successes: 34 },
      { segment: "repeat_touch", bucket: 15000, attempts: 100, successes: 36 },
      { segment: "price_sensitive", bucket: 0, attempts: 80, successes: 8 },
      { segment: "price_sensitive", bucket: 5000, attempts: 80, successes: 16 },
      { segment: "first_visit_high_intent", bucket: 0, attempts: 50, successes: 12 },
    ];
    for (const s of statsData) {
      await client.query(
        `INSERT INTO segment_stats (merchant_id, segment, bucket, attempts, successes)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (merchant_id, segment, bucket) DO UPDATE SET attempts = $4, successes = $5`,
        [MERCHANT_ID, s.segment, s.bucket, s.attempts, s.successes]
      );
    }
    console.log("  Segment stats priors");

    // Experiment exp_001
    await client.query(
      `INSERT INTO experiments (id, merchant_id, workflow, baseline_json, target_json, owner, limits_json, stop_rules_json, status)
       VALUES ('exp_001', $1, 'cart_recovery', $2, $3, 'product-team', $4, $5, 'approved')
       ON CONFLICT (id) DO UPDATE SET status = 'approved'`,
      [MERCHANT_ID,
       JSON.stringify({ aov_paise: 149800, gross_margin_percent: 0.40 }),
       JSON.stringify({ min_incremental_lift: 0.30 }),
       JSON.stringify({ max_daily_paise: 500000 }),
       JSON.stringify({ min_roas: 2, conversion_floor: 0.02 })]
    );
    console.log("  Experiment exp_001");

    // Policy v1 (seeded rules)
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
    console.log("  Policy rules v1");

    // Today's budget
    await client.query(
      `INSERT INTO daily_budget (day, merchant_id, cap_paise, reserved_paise, settled_paise, released_paise)
       VALUES (CURRENT_DATE, $1, 5000000, 0, 0, 0)
       ON CONFLICT (merchant_id, day) DO NOTHING`,
      [MERCHANT_ID]
    );
    console.log("  Daily budget");

    // Admin user
    const adminHash = await argon2.hash(process.env.ADMIN_PASSWORD || "admin123");
    await client.query(
      `INSERT INTO merchant_admins (id, email, password_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING`,
      [crypto.randomUUID(), process.env.ADMIN_EMAIL || "admin@sellable.dev", adminHash]
    );
    console.log("  Admin user");

    // Buyer API key
    const buyerKey = `sk_${crypto.randomBytes(32).toString("hex")}`;
    const buyerKeyHash = await argon2.hash(buyerKey);
    await client.query(
      `INSERT INTO buyer_api_keys (merchant_id, label, key_hash, rate_limit_per_min)
       VALUES ($1, 'demo-buyer-key', $2, 60)
       ON CONFLICT DO NOTHING`,
      [MERCHANT_ID, buyerKeyHash]
    );
    console.log(`  Buyer API key: ${buyerKey}`);

    await client.query("COMMIT");
    console.log("\nSeed complete!");
    console.log(`  Track key: ${SITE_KEY}`);
    console.log(`  Server key: ${SERVER_KEY}`);
    console.log(`  Admin: ${process.env.ADMIN_EMAIL || "admin@sellable.dev"} / ${process.env.ADMIN_PASSWORD || "admin123"}`);
    console.log(`  Buyer key: ${buyerKey}`);
    console.log(`  Riya cart: C-88 (abandoned, ₹1,598)`);
    console.log(`  Arjun: ${arjunId} (no marketing consent)`);
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
