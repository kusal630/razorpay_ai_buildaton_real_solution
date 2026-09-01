import argon2 from "argon2";
import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;

async function seed() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || "postgres://sellable:sellable@localhost:5432/sellable",
  });

  try {
    // Create admin
    const passwordHash = await argon2.hash("admin123");
    const { rows: adminRows } = await pool.query(
      "INSERT INTO merchant_admins (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET password_hash = $2 RETURNING id",
      ["admin@sellable.io", passwordHash]
    );
    console.log("Admin created:", adminRows[0].id);

    // Create merchant
    const trackKey = crypto.randomBytes(32).toString("hex");
    const trackKeyHash = await argon2.hash(trackKey);
    const { rows: merchantRows } = await pool.query(
      "INSERT INTO merchants (name, track_key_hash) VALUES ($1, $2) RETURNING id",
      ["Demo Store", trackKeyHash]
    );
    const merchantId = merchantRows[0].id;
    console.log("Merchant created:", merchantId);
    console.log("Track key:", trackKey);

    // Create products
    const products = [
      { name: "Wireless Headphones", price: 299900, cost: 119960, stock: 50 },
      { name: "Smart Watch", price: 499900, cost: 199960, stock: 30 },
      { name: "Phone Case", price: 99900, cost: 29970, stock: 100 },
      { name: "USB-C Cable", price: 49900, cost: 14970, stock: 200 },
      { name: "Bluetooth Speaker", price: 399900, cost: 159960, stock: 25 },
    ];

    const productIds: string[] = [];
    for (const p of products) {
      const { rows } = await pool.query(
        "INSERT INTO products (merchant_id, name, price_paise, cost_paise, stock) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [merchantId, p.name, p.price, p.cost, p.stock]
      );
      productIds.push(rows[0].id);
    }
    console.log("Products created:", productIds.length);

    // Create buyer API key
    const buyerKey = `sk_${crypto.randomBytes(32).toString("hex")}`;
    const buyerKeyHash = await argon2.hash(buyerKey);
    await pool.query(
      "INSERT INTO buyer_api_keys (merchant_id, label, key_hash, rate_limit_per_min) VALUES ($1, $2, $3, $4)",
      [merchantId, "Test Buyer", buyerKeyHash, 60]
    );
    console.log("Buyer API key:", buyerKey);

    // Create default policy rules
    const policies = [
      { action: "payment_link", auto: 1000000, escalate: 5000000, block: 10000000 },
      { action: "recovery_incentive", auto: 15000, escalate: 50000, block: 100000 },
      { action: "upsell_discount", auto: 1500, escalate: 2500, block: 5000 },
      { action: "chat_discount_request", auto: 15000, escalate: 50000, block: 100000 },
      { action: "refund", auto: 100000, escalate: 500000, block: 1000000 },
    ];

    for (const p of policies) {
      await pool.query(
        "INSERT INTO policy_rules (action, auto_limit_paise, escalate_limit_paise, hard_block_limit_paise) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
        [p.action, p.auto, p.escalate, p.block]
      );
    }
    console.log("Policy rules created");

    console.log("\n--- Seed Complete ---");
    console.log("Login: admin@sellable.io / admin123");
    console.log("Track Key:", trackKey);
    console.log("Buyer Key:", buyerKey);
  } finally {
    await pool.end();
  }
}

seed().catch(console.error);
