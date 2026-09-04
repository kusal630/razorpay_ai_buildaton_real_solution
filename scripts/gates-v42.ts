/**
 * v4.2 live gates — run against the real stack (Supabase + Razorpay TEST + LM Studio).
 * Usage: npx tsx --env-file=.env scripts/gates-v42.ts [gate-name]
 * Gates: u-arm | u-cancel-race | u-lifetime | u-chat-seg | u-chat-cost |
 *        e-two-touch | u-bucket75 | u-refund-alarm | u-checkpt-mail
 */
import crypto from "node:crypto";
import { loadConfig } from "../src/config.js";
import { query, closePool } from "../src/db.js";
import { assignArm, getActiveExperiment } from "../src/lib/experiment.js";

const MERCHANT_ID = "5a3ac6ce-b2c7-4b1f-a9db-45296841f30b";
const IDENTITY_SECRET = process.env.IDENTITY_SECRET || "sellable-identity-secret-v1";

let failures = 0;

function check(name: string, cond: boolean, detail: string) {
  if (cond) console.log(`  ✓ ${name}: ${detail}`);
  else { failures++; console.log(`  ✗ ${name}: ${detail}`); }
}

function identityToken(phone: string): string {
  return crypto.createHmac("sha256", IDENTITY_SECRET).update(phone).digest("hex");
}

/** Brute-force a phone whose HMAC arm is `want` for the experiment. */
function findPhoneForArm(expId: string, want: "treatment" | "control", tag: string): string {
  // Numeric suffix keeps the full 13-char phone varying across iterations.
  // Random start offset: the scan is deterministic per tag, so without this
  // two tags hashing to the same prefix would collide on the same identity.
  const tagNum = String(Math.abs([...tag].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 100);
  const start = Math.floor(Math.random() * 20000);
  for (let k = 0; k < 20000; k++) {
    const i = (start + k) % 20000;
    const phone = `+91942${tagNum.padStart(2, "0")}${String(i).padStart(4, "0")}`;
    if (assignArm(identityToken(phone), expId) === want) return phone;
  }
  throw new Error(`no ${want} identity found`);
}

export async function seedV42Customer(opts: {
  tag: string;
  arm: "treatment" | "control";
  segment?: string;
  marketingOptIn?: boolean;
  productId?: string;
  cartTotalPaise?: number;
  abandonedHoursAgo?: number;
  touchesToday?: number;
}): Promise<{ customerId: string; cartId: string; identityToken: string; productId: string; merchantId: string; segment: string }> {
  const experiment = await getActiveExperiment("cart_recovery");
  if (!experiment) throw new Error("no active cart_recovery experiment");
  const phone = findPhoneForArm(experiment.id, opts.arm, opts.tag);
  const token = identityToken(phone);
  const segment = opts.segment || "repeat_touch";
  const merchantId = MERCHANT_ID;

  const { rows: prodRows } = opts.productId
    ? await query(`SELECT id, merchant_id, price_paise FROM products WHERE id = $1`, [opts.productId])
    : await query(`SELECT id, merchant_id, price_paise FROM products WHERE active = true AND stock > 0 ORDER BY price_paise DESC LIMIT 1`);
  const product = prodRows[0];
  if (!product) throw new Error("seed product missing");
  const cartTotal = opts.cartTotalPaise ?? Number(product.price_paise);
  const cartId = crypto.randomUUID();

  const { encrypt } = await import("../src/lib/crypto.js");
  const { rows: custRows } = await query(
    `INSERT INTO customers (merchant_id, identity_hash, contact_enc, segment, consent_transactional, consent_marketing)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      merchantId, token, encrypt(phone), segment,
      JSON.stringify({
        anchor_cart_ids: [cartId],
        latest_anchor_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      }),
      JSON.stringify(opts.marketingOptIn === false
        ? { opt_in: false }
        : { opt_in: true, source: "merchant_server", consented_at: new Date().toISOString() }),
    ]
  );
  const customerId = custRows[0].id;

  // Record the cohort row exactly as the pipeline would (deterministic arm)
  const { assignToExperiment } = await import("../src/lib/experiment.js");
  const arm = await assignToExperiment(token, experiment.id, { merchantId, customerId });

  // Consent events (marketing iff opted in; transactional anchor always)
  if (opts.marketingOptIn !== false) {
    await query(
      `INSERT INTO consent_events (merchant_id, customer_id, class, opt_in, source, evidence_ref)
       VALUES ($1, $2, 'marketing', true, 'merchant_server', $3)`,
      [merchantId, customerId, `v42-${opts.tag}-mkt`]
    );
  }
  await query(
    `INSERT INTO consent_events (merchant_id, customer_id, class, opt_in, source, evidence_ref)
     VALUES ($1, $2, 'transactional', true, 'merchant_server', $3)`,
    [merchantId, customerId, `v42-${opts.tag}-txn`]
  );

  // Abandoned cart + line item (catalog merchant so joins resolve)
  const abandonedAt = new Date(Date.now() - (opts.abandonedHoursAgo ?? 25) * 3600e3);
  await query(
    `INSERT INTO carts (id, merchant_id, customer_id, total_paise, status, abandoned_at, updated_at)
     VALUES ($1, $2, $3, $4, 'abandoned', $5, $5)`,
    [cartId, product.merchant_id, customerId, cartTotal, abandonedAt.toISOString()]
  );
  await query(
    `INSERT INTO cart_items (cart_id, product_id, qty, unit_price_paise)
     VALUES ($1, $2, 1, $3)`,
    [cartId, product.id, Number(product.price_paise)]
  );

  // Prior touches today (repeat-touch by default so incentives are on-menu)
  const today = new Date().toISOString().slice(0, 10);
  const touches = opts.touchesToday ?? 1;
  if (touches > 0) {
    await query(
      `INSERT INTO touches (merchant_id, customer_id, day, count)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (customer_id, day) DO UPDATE SET count = touches.count + $4`,
      [merchantId, customerId, today, touches]
    );
  }

  return { customerId, cartId, identityToken: token, productId: product.id, merchantId: product.merchant_id, segment };
}

async function gateUArm() {
  console.log("\nGATE U-ARM — experiment integrity (control arm)");
  const { processAbandonedCart } = await import("../src/agents/recoveryBot.js");
  const { resolvePayment } = await import("../src/lib/moneyBus.js");

  const startRow = await query("SELECT COALESCE(MAX(id),0) as m FROM activity");
  const startId = Number(startRow.rows[0].m);

  const seeded = await seedV42Customer({ tag: `arm${crypto.randomUUID().slice(0,8)}`, arm: "control", marketingOptIn: true });
  console.log(`  seeded control customer ${seeded.customerId.slice(0, 8)} cart ${seeded.cartId.slice(0, 8)}`);

  await processAbandonedCart(seeded.cartId);

  // 1. Plain ₹0 link, neutral copy
  const { rows: links } = await query(
    `SELECT * FROM payment_links WHERE cart_id = $1 ORDER BY created_at DESC LIMIT 5`,
    [seeded.cartId]
  );
  const link = links[0];
  check("control link exists", !!link, link ? `link ${link.id.slice(0, 8)}` : "none");
  check("control incentive is 0", Number(link?.incentive_paise || 0) === 0, `incentive_paise=${link?.incentive_paise}`);
  const { rows: thoughtRows } = await query(
    `SELECT data FROM activity WHERE actor = 'RecoveryBot' AND type = 'AGENT_THOUGHT'
     AND data->>'cart_id' = $1 ORDER BY id DESC LIMIT 1`,
    [seeded.cartId]
  );
  const thought = thoughtRows[0]?.data;
  check("control thought neutral", thought?.tone === "neutral" && thought?.arm === "control" && thought?.strategy === "send_plain_link",
    `tone=${thought?.tone} arm=${thought?.arm} strategy=${thought?.strategy}`);
  // Neutral copy by construction: the control branch never calls the brain
  // (no AGENT_THOUGHT with mode llm exists for this cart — asserted below via link + thought mode rules)
  check("control thought rules-mode", thought?.mode === "rules", `mode=${thought?.mode}`);

  if (!link) return;

  // 2. She pays → resolve → revenue counted, control stats updated
  await resolvePayment({
    id: link.id, merchant_id: link.merchant_id, razorpay_link_id: link.razorpay_link_id,
    audit_seq: link.audit_seq, amount_paise: Number(link.amount_paise),
    incentive_paise: Number(link.incentive_paise), cart_id: link.cart_id, customer_id: link.customer_id,
  });
  const { rows: orderRows } = await query(
    `SELECT status FROM orders WHERE cart_id = $1 ORDER BY created_at DESC LIMIT 1`, [seeded.cartId]
  );
  check("order paid", orderRows[0]?.status === "paid", `status=${orderRows[0]?.status}`);
  const { rows: statRows } = await query(
    `SELECT attempts, successes FROM segment_stats WHERE merchant_id = $1 AND segment = 'repeat_touch' AND bucket = 0`,
    [MERCHANT_ID]
  );
  check("bucket-0 stats ticked", Number(statRows[0]?.attempts || 0) >= 1 && Number(statRows[0]?.successes || 0) >= 1,
    `attempts=${statRows[0]?.attempts} successes=${statRows[0]?.successes}`);

  // 3. ZERO upsell proposals for her (only arm_suppressed evidence)
  const { rows: upsellLinks } = await query(
    `SELECT COUNT(*) as cnt FROM payment_links WHERE customer_id = $1 AND id <> $2`,
    [seeded.customerId, link.id]
  );
  check("zero upsell links", Number(upsellLinks[0]?.cnt || 0) === 0, `extra links=${upsellLinks[0]?.cnt}`);
  const { rows: armRows } = await query(
    `SELECT COUNT(*) as cnt FROM audit_log WHERE actor = 'UpsellBot' AND action = 'arm_suppressed'
      AND params_json->>'customer_id' = $1`,
    [seeded.customerId]
  );
  check("one arm_suppressed ledger row", Number(armRows[0]?.cnt || 0) === 1, `arm_suppressed=${armRows[0]?.cnt}`);
  const { rows: upsellThoughts } = await query(
    `SELECT COUNT(*) as cnt FROM activity WHERE actor = 'UpsellBot' AND type = 'AGENT_THOUGHT' AND id > $1`,
    [startId]
  );
  check("zero upsell thoughts", Number(upsellThoughts[0]?.cnt || 0) === 0, `thoughts=${upsellThoughts[0]?.cnt}`);

  // 4. NO chat widget on her pay page (pay-token, not link token)
  const { rows: payRows } = await query(
    `SELECT token FROM pay_tokens WHERE audit_seq = $1 ORDER BY created_at DESC LIMIT 1`,
    [link.audit_seq]
  );
  const payToken = payRows[0]?.token;
  if (!payToken) {
    check("chat widget suppressed", false, "no pay token issued for control link");
    return;
  }
  const resp = await fetch(`http://localhost:3000/pay/${payToken}`);
  const body = await resp.json().catch(() => ({}));
  check("chat widget suppressed", body.chat_enabled === false, `chat_enabled=${body.chat_enabled} arm=${body.experiment_arm}`);
}

async function gateUCancelRace() {
  console.log("\nGATE U-CANCEL-RACE — link paid mid-cancel resolves, no replacement");
  const nock = (await import("nock")).default;
  nock.disableNetConnect();
  try {
    const seeded = await seedV42Customer({ tag: `race${crypto.randomUUID().slice(0,8)}`, arm: "control", marketingOptIn: true });
    console.log(`  seeded control customer ${seeded.customerId.slice(0, 8)} cart ${seeded.cartId.slice(0, 8)}`);

    const { createIntent } = await import("../src/lib/intentExecutor.js");
    const { appendLedger } = await import("../src/lib/ledger.js");
    const intent = await createIntent({
      merchantId: MERCHANT_ID, customerId: seeded.customerId,
      identityToken: seeded.identityToken, actionType: "recovery_24h", targetId: seeded.cartId,
    });
    const { seq: priorSeq } = await appendLedger({
      merchantId: MERCHANT_ID, actor: "RecoveryBot", action: "create_payment_link",
      params: { amount: 159800, cart_id: seeded.cartId },
      decision: "ALLOW", policy_checks: {}, rationale: { fixture: "cancel-race prior link" },
      outcome: "PROPOSED",
    });
    const fakeRpId = `plink_race_${Date.now().toString(36)}`;
    const { rows: linkRows } = await query(
      `INSERT INTO payment_links (merchant_id, razorpay_link_id, audit_seq, token, amount_paise,
        incentive_paise, status, cart_id, customer_id)
       VALUES ($1, $2, $3, $4, 159800, 0, 'live', $5, $6) RETURNING id`,
      [MERCHANT_ID, fakeRpId, priorSeq, `tok_race_${Date.now().toString(36)}`, seeded.cartId, seeded.customerId]
    );
    const priorLinkId = linkRows[0].id;

    // Razorpay: cancel always errors (initial + 2 retries), status fetch says PAID.
    // Create endpoints guarded: must never be reached.
    const scope = nock("https://api.razorpay.com");
    scope.put(new RegExp(`/v1/payment_links/${fakeRpId}`)).times(3).reply(500, { error: { description: "boom" } });
    scope.get(new RegExp(`/v1/payment_links/${fakeRpId}`)).reply(200, { id: fakeRpId, status: "paid", amount: 159800 });
    scope.post("/v1/orders").reply(500, { error: { description: "MUST-NOT-CREATE-ORDER" } });
    scope.post("/v1/payment_links").reply(500, { error: { description: "MUST-NOT-CREATE-LINK" } });

    const moneyBus = await import("../src/lib/moneyBus.js");
    const result = await moneyBus.execute(
      "RecoveryBot",
      { type: "create_payment_link", params: { amount: 159800, description: "race replacement (must not exist)" } },
      { decision: "ALLOW", checks: {}, reasons: [] },
      { cart_id: seeded.cartId, customer_id: seeded.customerId, intent_id: intent.intentId, trigger: "cart_abandoned_24h" },
      MERCHANT_ID
    );

    check("race resolved, no new link", result.status === "cancel_race_paid" && (result.data as any)?.resolved === true,
      `status=${result.status} resolved=${(result.data as any)?.resolved}`);
    const { rows: orderRows } = await query(
      `SELECT id, status FROM orders WHERE cart_id = $1 ORDER BY created_at DESC LIMIT 1`, [seeded.cartId]
    );
    check("order paid via resolution", orderRows[0]?.status === "paid", `status=${orderRows[0]?.status}`);
    const { rows: linkCount } = await query(
      `SELECT COUNT(*) as cnt FROM payment_links WHERE cart_id = $1`, [seeded.cartId]
    );
    check("no replacement link", Number(linkCount[0]?.cnt) === 1, `links=${linkCount[0]?.cnt}`);
    const { rows: ledgerRows } = await query(
      `SELECT COUNT(*) as cnt FROM audit_log WHERE action = 'cancel_failed_link_paid_resolved'
       AND params_json->>'cart_id' = $1`, [seeded.cartId]
    );
    check("race ledger row", Number(ledgerRows[0]?.cnt) === 1, `rows=${ledgerRows[0]?.cnt}`);
    const { rows: intentRows } = await query(`SELECT status FROM action_intents WHERE id = $1`, [intent.intentId]);
    check("intent done", intentRows[0]?.status === "done", `status=${intentRows[0]?.status}`);
    const { rows: armRows } = await query(
      `SELECT COUNT(*) as cnt FROM audit_log WHERE actor = 'UpsellBot' AND action = 'arm_suppressed'
       AND params_json->>'customer_id' = $1`, [seeded.customerId]
    );
    check("upsell suppressed on resolve", Number(armRows[0]?.cnt) === 1, `arm_suppressed=${armRows[0]?.cnt}`);
    void priorLinkId;
  } finally {
    nock.cleanAll();
    nock.enableNetConnect();
  }
}

async function gateULifetime() {
  console.log("\nGATE U-LIFETIME — lifetime incentive cap per identity");
  const { evaluateAction } = await import("../src/lib/policyEngine.js");

  const seeded = await seedV42Customer({ tag: `life${crypto.randomUUID().slice(0,8)}`, arm: "treatment", marketingOptIn: true });
  // 3 prior SETTLED incentives for this identity
  for (let i = 0; i < 3; i++) {
    await query(
      `INSERT INTO payment_links (merchant_id, razorpay_link_id, token, amount_paise,
        incentive_paise, status, cart_id, customer_id, paid_at)
       VALUES ($1, $2, $3, 159800, 5000, 'paid', $4, $5, NOW() - INTERVAL '${i + 40} days')`,
      [MERCHANT_ID, `plink_life_${Date.now().toString(36)}_${i}`, `tok_life_${Date.now().toString(36)}_${i}`, seeded.cartId, seeded.customerId]
    );
  }

  const blocked = await evaluateAction("recovery_incentive", {
    amount_paise: 5000, incentive_paise: 5000, margin_paise: 63900,
    cart_total_paise: 159800, customer_touches_today: 1, customerId: seeded.customerId,
    isRecovery: true, actionClass: "proactive_marketing_touch",
  });
  check("incentive BLOCKED", blocked.decision === "BLOCK", `decision=${blocked.decision}`);
  check("lifetime reason", blocked.reasons.some((r) => r.includes("lifetime_incentive_cap")),
    `reasons=${JSON.stringify(blocked.reasons)}`);

  const plain = await evaluateAction("recovery_incentive", {
    amount_paise: 0, incentive_paise: 0, margin_paise: 63900,
    cart_total_paise: 159800, customer_touches_today: 1, customerId: seeded.customerId,
    isRecovery: true, actionClass: "proactive_marketing_touch",
  });
  check("plain still allowed", plain.decision === "ALLOW", `decision=${plain.decision}`);
}

async function gateUChatSeg() {
  console.log("\nGATE U-CHAT-SEG — chat discounts are measured, not assumed");
  const { evaluateChatGrant } = await import("../src/lib/chatEconomics.js");

  // Fixture: 10 asks with 1 success on the ₹100 bucket (θ≈0.167) against a
  // warm bucket-0 baseline (θ≈0.19), so the haggle loses money on demo margins.
  await query(`DELETE FROM segment_stats WHERE merchant_id = $1 AND segment = 'chat_requested'`, [MERCHANT_ID]);
  await query(
    `INSERT INTO segment_stats (merchant_id, segment, bucket, attempts, successes) VALUES
     ($1, 'chat_requested', 10000, 10, 1),
     ($1, 'chat_requested', 0, 30, 5)`,
    [MERCHANT_ID]
  );

  const refused = await evaluateChatGrant({
    merchantId: MERCHANT_ID, requestedPaise: 10000, cartTotalPaise: 159800, marginPaise: 63900,
  });
  check("haggle refused", refused.granted === false, `granted=${refused.granted} ev=${refused.evPaise}`);
  check("ledger reason", refused.reason === "chat_segment_ev_negative", `reason=${refused.reason}`);
  check("theta measured", refused.theta >= 0.15 && refused.theta <= 0.20, `theta=${refused.theta.toFixed(3)}`);

  // Positive control: a hot bucket grants
  await query(
    `INSERT INTO segment_stats (merchant_id, segment, bucket, attempts, successes)
     VALUES ($1, 'chat_requested', 5000, 100, 60)
     ON CONFLICT (merchant_id, segment, bucket)
     DO UPDATE SET attempts = 100, successes = 60`,
    [MERCHANT_ID]
  );
  const granted = await evaluateChatGrant({
    merchantId: MERCHANT_ID, requestedPaise: 5000, cartTotalPaise: 159800, marginPaise: 63900,
  });
  check("hot bucket grants", granted.granted === true, `granted=${granted.granted} ev=${granted.evPaise}`);
}

async function gateUChatCost() {
  console.log("\nGATE U-CHAT-COST — turn cap, FAQ zero-billing, lockout");
  const { handleChatMessage } = await import("../src/agents/chatAgent.js");
  const { CHAT_LOCKOUT_COPY } = await import("../src/lib/chatSession.js");

  const { rows: seqRows } = await query("SELECT MAX(seq) as m FROM audit_log");
  const seq = String(seqRows[0]?.m || 1);
  const sessionToken = `u-chat-cost-${Date.now()}`;

  const answers: string[] = [];
  for (let i = 0; i < 15; i++) {
    const r = await handleChatMessage(seq, "what is the price?", sessionToken);
    answers.push(r.response);
  }
  const answered = answers.filter((a) => a !== CHAT_LOCKOUT_COPY).length;
  const refused = answers.filter((a) => a === CHAT_LOCKOUT_COPY).length;
  check("10 answered, 5 refused", answered === 10 && refused === 5, `answered=${answered} refused=${refused}`);

  const { rows: usageRows } = await query(
    `SELECT kind, COUNT(*) as n, COALESCE(SUM(tokens),0) as tokens, COALESCE(SUM(cost_paise),0) as cost
     FROM ai_usage WHERE session_key = $1 GROUP BY kind ORDER BY kind`,
    [sessionToken]
  );
  const byKind: Record<string, { n: number; tokens: number; cost: number }> = {};
  for (const r of usageRows) {
    byKind[r.kind] = { n: Number(r.n), tokens: Number(r.tokens), cost: Number(r.cost) };
  }
  check("faq turns metered", (byKind.faq?.n || 0) === 10, `faq=${byKind.faq?.n || 0}`);
  check("faq billed zero tokens", (byKind.faq?.tokens || 0) === 0 && (byKind.faq?.cost || 0) === 0,
    `tokens=${byKind.faq?.tokens || 0} cost=${byKind.faq?.cost || 0}`);
  check("refusals metered", (byKind.refused?.n || 0) === 5, `refused=${byKind.refused?.n || 0}`);

  const { rows: sessRows } = await query(
    `SELECT turn_count FROM chat_sessions WHERE session_key = $1`, [sessionToken]
  );
  check("session turn count", Number(sessRows[0]?.turn_count || 0) === 10, `turns=${sessRows[0]?.turn_count}`);
}

async function gateETwoTouch() {
  console.log("\nGATE E-TWO-TOUCH — early plain nudge, then normal 24h evaluation");
  const { processAbandonedCart } = await import("../src/agents/recoveryBot.js");

  const seeded = await seedV42Customer({
    tag: `two${crypto.randomUUID().slice(0,8)}`, arm: "treatment", marketingOptIn: true,
    abandonedHoursAgo: 1.5, touchesToday: 0,
  });
  console.log(`  seeded zero-touch customer ${seeded.customerId.slice(0, 8)} cart ${seeded.cartId.slice(0, 8)}`);

  // Touch 1: early window
  await processAbandonedCart(seeded.cartId, { stage: "early" });

  const { rows: earlyLinks } = await query(
    `SELECT incentive_paise FROM payment_links WHERE cart_id = $1 ORDER BY created_at`, [seeded.cartId]
  );
  check("early plain link fires", earlyLinks.length >= 1 && Number(earlyLinks[0]?.incentive_paise) === 0,
    `links=${earlyLinks.length} incentive=${earlyLinks[0]?.incentive_paise}`);
  const { rows: earlyIntents } = await query(
    `SELECT action_type, status FROM action_intents WHERE target_id = $1 AND action_type = 'recovery_early'`,
    [seeded.cartId]
  );
  check("early intent row", earlyIntents.length === 1, `action=${earlyIntents[0]?.action_type} status=${earlyIntents[0]?.status}`);
  const { rows: touchRows } = await query(
    `SELECT COALESCE(SUM(count),0) as n FROM touches WHERE customer_id = $1`, [seeded.customerId]
  );
  check("touch counter +1", Number(touchRows[0]?.n) >= 1, `touches=${touchRows[0]?.n}`);

  // Touch 2: simulate 24h passing, incentivized path evaluates normally
  await query(`UPDATE carts SET abandoned_at = NOW() - INTERVAL '25 hours' WHERE id = $1`, [seeded.cartId]);
  await processAbandonedCart(seeded.cartId, { stage: "24h" });

  const { rows: allLinks } = await query(
    `SELECT COUNT(*) as cnt FROM payment_links WHERE cart_id = $1`, [seeded.cartId]
  );
  check("24h second link", Number(allLinks[0]?.cnt) >= 2, `links=${allLinks[0]?.cnt}`);
  const { rows: intents24 } = await query(
    `SELECT action_type FROM action_intents WHERE target_id = $1 AND action_type = 'recovery_24h'`,
    [seeded.cartId]
  );
  check("24h intent row", intents24.length === 1, `action=${intents24[0]?.action_type}`);

  // Paid-skip: a paid cart is never chased again
  await query(
    `INSERT INTO payment_links (merchant_id, razorpay_link_id, token, amount_paise, incentive_paise, status, cart_id, customer_id, paid_at)
     VALUES ($1, $2, $3, 159800, 0, 'paid', $4, $5, NOW())`,
    [MERCHANT_ID, `plink_paidskip_${Date.now().toString(36)}`, `tok_paidskip_${Date.now().toString(36)}`, seeded.cartId, seeded.customerId]
  );
  const linksBefore = Number(allLinks[0]?.cnt);
  await processAbandonedCart(seeded.cartId, { stage: "early" });
  const { rows: linksAfter } = await query(
    `SELECT COUNT(*) as cnt FROM payment_links WHERE cart_id = $1`, [seeded.cartId]
  );
  // +1 from the fixture row itself; the re-run must add nothing
  check("paid cart skipped", Number(linksAfter[0]?.cnt) === linksBefore + 1, `links=${linksAfter[0]?.cnt}`);
  const { rows: skipRows } = await query(
    `SELECT COUNT(*) as cnt FROM activity WHERE actor = 'RecoveryBot'
     AND data->>'reason' = 'already_paid' AND data->>'cart_id' = $1`, [seeded.cartId]
  );
  check("already_paid event", Number(skipRows[0]?.cnt) >= 1, `events=${skipRows[0]?.cnt}`);
}

async function gateUBucket75() {
  console.log("\nGATE U-BUCKET75 — margin-constrained fixture picks ₹75 over ₹100");
  const { selectBucket } = await import("../src/lib/economics.js");
  const { evaluateAction } = await import("../src/lib/policyEngine.js");

  // Seed the interpolated prior (idempotent)
  await query(
    `INSERT INTO segment_stats (merchant_id, segment, bucket, attempts, successes)
     VALUES ($1, 'repeat_touch', 7500, 100, 28)
     ON CONFLICT (merchant_id, segment, bucket) DO UPDATE SET attempts = 100, successes = 28`,
    [MERCHANT_ID]
  );
  const { rows } = await query(
    `SELECT attempts, successes FROM segment_stats WHERE merchant_id = $1 AND segment = 'repeat_touch' AND bucket = 7500`,
    [MERCHANT_ID]
  );
  const theta75 = (Number(rows[0].successes) + 1) / (Number(rows[0].attempts) + 2);
  check("theta(7500) seeded", Math.abs(theta75 - 0.28) < 0.02, `theta=${theta75.toFixed(3)}`);

  // Margin-constrained fixture: margin 35000 → floor min(15000, 8750) = 8750.
  // ₹100 (10000) breaches it; ₹75 (7500) clears it — and wins on EV.
  const thetas: Record<number, number> = { 0: 0.10, 5000: 0.20, 7500: 0.34, 10000: 0.34, 15000: 0.36 };
  const { bucket, decision } = selectBucket({ thetas, theta_0: 0.10, marginPaise: 35000 });
  check("EV picks 7500", bucket === 7500 && decision === "ACTION", `bucket=${bucket} decision=${decision}`);

  const pass75 = await evaluateAction("recovery_incentive", {
    amount_paise: 7500, incentive_paise: 7500, margin_paise: 35000,
  });
  check("7500 passes margin floor", pass75.checks.incentive_cap === "PASS",
    `incentive_cap=${pass75.checks.incentive_cap}`);
  const esc100 = await evaluateAction("recovery_incentive", {
    amount_paise: 10000, incentive_paise: 10000, margin_paise: 35000,
  });
  check("10000 hits margin floor", esc100.checks.incentive_cap === "ESCALATE",
    `incentive_cap=${esc100.checks.incentive_cap} reasons=${JSON.stringify(esc100.reasons)}`);
}

async function gateURefundAlarm() {
  console.log("\nGATE U-REFUND-ALARM — burst fires banner + alert, alarm only");
  const { checkRefundAnomaly, getActiveBanners } = await import("../src/lib/refundAlarm.js");

  // Fixture burst: 6 refunds in the last hour against real paid orders (FK-safe)
  const { rows: paidOrders } = await query(
    `SELECT id, merchant_id FROM orders WHERE status = 'paid' ORDER BY paid_at DESC NULLS LAST LIMIT 6`
  );
  if (paidOrders.length < 2) throw new Error("need ≥2 paid orders for the burst fixture");
  for (let i = 0; i < 6; i++) {
    const o = paidOrders[i % paidOrders.length];
    await query(
      `INSERT INTO refunds (merchant_id, order_id, razorpay_refund_id, amount_paise, status)
       VALUES ($1, $2, $3, 20000, 'processed')`,
      [o.merchant_id, o.id, `rfnd_alarm_${Date.now().toString(36)}_${i}`]
    );
  }

  const { fired } = await checkRefundAnomaly();
  check("alarm fired", fired.length >= 1, `scopes=${fired.map((f) => f.scope).join(",")}`);
  const tenant = fired.find((f) => f.scope === "tenant");
  check("tenant scope", !!tenant, `hour_count=${tenant?.hour_count} ratio=${tenant?.ratio}`);

  const banners = await getActiveBanners();
  check("dashboard banner", banners.some((b) => b.banner === "refund_anomaly"), `banners=${banners.map((b) => b.banner).join(",")}`);

  const { rows: alertRows } = await query(
    `SELECT COUNT(*) as cnt FROM activity WHERE actor = 'RefundAlarm' AND type = 'ALERT'`
  );
  check("alert event", Number(alertRows[0]?.cnt) >= 1, `alerts=${alertRows[0]?.cnt}`);
  const { rows: ledgerRows } = await query(
    `SELECT COUNT(*) as cnt FROM audit_log WHERE actor = 'RefundAlarm' AND action = 'refund_anomaly'`
  );
  check("alarm ledger row", Number(ledgerRows[0]?.cnt) >= 1, `rows=${ledgerRows[0]?.cnt}`);
}

async function gateUCheckptMail() {
  console.log("\nGATE U-CHECKPT-MAIL — checkpoint run emails the fingerprint (mock transport)");
  process.env.CHECKPOINT_EMAIL_ENABLED = "true";
  process.env.CHECKPOINT_EMAIL_TO = "owner@example.com";
  delete process.env.CHECKPOINT_EMAIL_WEBHOOK;

  const fs = await import("node:fs");
  const { createCheckpoint } = await import("../src/lib/ledger.js");
  const result = await createCheckpoint(MERCHANT_ID);
  check("checkpoint ran", !!result?.id && !!result?.file, `id=${result?.id}`);
  check("file exists", !!result?.file && fs.existsSync(result.file), `file=${result?.file}`);
  check("email sent (mock)", result?.email.sent === true && result?.email.transport === "mock",
    `sent=${result?.email.sent} transport=${result?.email.transport}`);
  const { rows: headRows } = await query("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1");
  const fileTail = result?.file ? fs.readFileSync(result.file, "utf8").trim().split("\n").pop() || "" : "";
  const fileJson = JSON.parse(fileTail || "{}");
  check("email carries head hash", fileJson.head_hash === headRows[0]?.hash && fileJson.head_seq === headRows[0]?.seq,
    `seq=${fileJson.head_seq} hash=${String(fileJson.head_hash).slice(0, 8)}`);
  const { rows: mailRows } = await query(
    `SELECT COUNT(*) as cnt FROM activity WHERE actor = 'Checkpoint' AND type = 'EMAIL_SENT'`
  );
  check("email logged", Number(mailRows[0]?.cnt) >= 1, `events=${mailRows[0]?.cnt}`);
  delete process.env.CHECKPOINT_EMAIL_ENABLED;
}

async function gateUGround() {
  console.log("\nGATE U-GROUND — ungrounded claims stripped, grounded claims render");
  const { finalizeCopy } = await import("../src/lib/claims.js");
  const { rows: prodRows } = await query(
    `SELECT id, stock FROM products WHERE active = true ORDER BY price_paise ASC LIMIT 1`
  );
  const product = prodRows[0];
  if (!product) throw new Error("no active product for fixture");
  const origStock = Number(product.stock);

  try {
    // (a) Unresolvable stock token → strip + template + ledgered refusal
    const bad = await finalizeCopy({
      copy: "Only [claim:stock:00000000-0000-4000-a000-000000000099] left! Buy now!",
      facts: { incentive_paise: 5000, cart_total_paise: 159800 },
      source: "llm",
      fallbackTemplate: "A few items are still available — complete your purchase here.",
      ledger: { merchantId: MERCHANT_ID, actor: "GateUGround", action: "create_payment_link" },
    });
    check("ungrounded stripped", bad.result.stripped.length === 1 && bad.result.stripped[0].type === "stock",
      `stripped=${JSON.stringify(bad.result.stripped)}`);
    check("template fallback", bad.copy.startsWith("A few items are still available"),
      `copy=${JSON.stringify(bad.copy.slice(0, 60))}`);
    const { rows: fbRows } = await query(
      `SELECT COUNT(*) as cnt FROM audit_log WHERE actor = 'GateUGround' AND action = 'copy_fallback'
       AND rationale_json->>'reason' = 'claim_ungrounded'`
    );
    check("fallback ledgered", Number(fbRows[0]?.cnt) >= 1, `rows=${fbRows[0]?.cnt}`);

    // (b) Resolvable token renders the true value
    await query(`UPDATE products SET stock = 3 WHERE id = $1`, [product.id]);
    const good = await finalizeCopy({
      copy: "Only [claim:stock:" + product.id + "] left at this price!",
      facts: { incentive_paise: 5000, cart_total_paise: 159800 },
      source: "llm",
      fallbackTemplate: "Items are still available — complete your purchase here.",
      ledger: { merchantId: MERCHANT_ID, actor: "GateUGround", action: "create_payment_link" },
    });
    check("grounded renders", good.copy.includes("Only 3 left"), `copy=${JSON.stringify(good.copy)}`);
    check("resolution recorded", good.result.resolved.some((r) => r.type === "stock" && r.value === 3),
      `resolved=${JSON.stringify(good.result.resolved)}`);
    check("no fallback", good.result.fallback === false, `fallback=${good.result.fallback}`);
  } finally {
    await query(`UPDATE products SET stock = $1 WHERE id = $2`, [origStock, product.id]);
  }
}

async function seedLadderPriors() {
  const rows: [string, number, number, number][] = [
    ["ladder_e2e", 0, 50, 5],
    ["ladder_e2e", 5000, 20, 2],
    ["ladder_e2e", 7500, 20, 3],
    ["ladder_e2e", 10000, 100, 50],
    ["ladder_e2e", 15000, 20, 2],
  ];
  for (const [seg, bucket, att, suc] of rows) {
    await query(
      `INSERT INTO segment_stats (merchant_id, segment, bucket, attempts, successes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (merchant_id, segment, bucket) DO UPDATE SET attempts = $4, successes = $5`,
      [MERCHANT_ID, seg, bucket, att, suc]
    );
  }
}

async function gateELadder() {
  console.log("\nGATE E-LADDER — 1h plain → 24h ₹100 (+48h) → 72h final on the true deadline");
  const { processAbandonedCart, processFinalCall } = await import("../src/agents/recoveryBot.js");
  const { setKillSwitch } = await import("../src/lib/sharedBrain.js");
  const { sweepExpiredLinks } = await import("../src/lib/moneyBus.js");
  const { reserveBudget } = await import("../src/lib/budget.js");
  setKillSwitch(true); // deterministic EV-max brain for the fixture
  try {
    await seedLadderPriors();
    const budget = async () => {
      const { rows } = await query(
        `SELECT reserved_paise FROM daily_budget WHERE merchant_id = $1 AND day = TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD')`,
        [MERCHANT_ID]
      );
      return Number(rows[0]?.reserved_paise || 0);
    };

    // ── Cart A: full ladder on the live-link path ──
    const a = await seedV42Customer({
      tag: `ladA${crypto.randomUUID().slice(0, 8)}`, arm: "treatment", marketingOptIn: true,
      segment: "ladder_e2e", abandonedHoursAgo: 1.5, touchesToday: 0,
    });
    await processAbandonedCart(a.cartId, { stage: "early" });
    const { rows: aLinks1 } = await query(`SELECT incentive_paise FROM payment_links WHERE cart_id = $1`, [a.cartId]);
    check("A early plain", aLinks1.length === 1 && Number(aLinks1[0]?.incentive_paise) === 0,
      `links=${aLinks1.length} inc=${aLinks1[0]?.incentive_paise}`);
    const { rows: aThought } = await query(
      `SELECT data FROM activity WHERE actor = 'RecoveryBot' AND type = 'AGENT_THOUGHT' AND data->>'cart_id' = $1 ORDER BY id DESC LIMIT 1`,
      [a.cartId]
    );
    check("A endowment frame", ((aThought[0]?.data?.message_copy || "") as string).startsWith("We've reserved your"),
      `copy=${JSON.stringify(((aThought[0]?.data?.message_copy || "") as string).slice(0, 50))}`);

    // Simulate passage to T+24h (touch day backdated; dedupe is day-scoped anyway).
    // Consolidate to one row first: touches_pkey is (customer_id, day).
    const yd = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    const { rows: tcRows } = await query(`SELECT COALESCE(SUM(count),0) as n FROM touches WHERE customer_id = $1`, [a.customerId]);
    await query(`DELETE FROM touches WHERE customer_id = $1`, [a.customerId]);
    await query(`INSERT INTO touches (merchant_id, customer_id, day, count) VALUES ($1, $2, $3, $4)`,
      [MERCHANT_ID, a.customerId, yd, Number(tcRows[0]?.n || 1)]);
    await query(`UPDATE carts SET abandoned_at = NOW() - INTERVAL '25 hours' WHERE id = $1`, [a.cartId]);
    const r0 = await budget();
    await processAbandonedCart(a.cartId, { stage: "24h" });
    const { rows: aLink2 } = await query(
      `SELECT incentive_paise, expire_by, short_url, razorpay_link_id FROM payment_links WHERE cart_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [a.cartId]
    );
    check("A 24h incentive 100", Number(aLink2[0]?.incentive_paise) === 10000, `inc=${aLink2[0]?.incentive_paise}`);
    const expHrs = (new Date(aLink2[0]?.expire_by).getTime() - Date.now()) / 3600e3;
    check("A link expires +48h", expHrs > 47 && expHrs < 49, `in ${expHrs.toFixed(1)}h`);
    check("A budget spent once", (await budget()) === r0 + 10000, `reserved=${await budget()}`);

    // Simulate T+72h: link near expiry, touches aged out
    await query(`UPDATE payment_links SET expire_by = NOW() + INTERVAL '2 hours' WHERE cart_id = $1 AND incentive_paise = 10000`, [a.cartId]);
    const { rows: aLink2b } = await query(
      `SELECT expire_by, short_url FROM payment_links WHERE cart_id = $1 AND incentive_paise = 10000`, [a.cartId]
    );
    const dd = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
    const { rows: tc2Rows } = await query(`SELECT COALESCE(SUM(count),0) as n FROM touches WHERE customer_id = $1`, [a.customerId]);
    await query(`DELETE FROM touches WHERE customer_id = $1`, [a.customerId]);
    await query(`INSERT INTO touches (merchant_id, customer_id, day, count) VALUES ($1, $2, $3, $4)`,
      [MERCHANT_ID, a.customerId, dd, Number(tc2Rows[0]?.n || 2)]);
    await processFinalCall(a.cartId);
    const { rows: aLinksFinal } = await query(`SELECT COUNT(*) as cnt FROM payment_links WHERE cart_id = $1`, [a.cartId]);
    check("A final reuses live link", Number(aLinksFinal[0]?.cnt) === 2, `links=${aLinksFinal[0]?.cnt}`);
    const { rows: aFinal } = await query(
      `SELECT data FROM activity WHERE actor = 'RecoveryBot' AND type = 'AGENT_THOUGHT'
       AND data->>'strategy' = 'send_final_call' ORDER BY id DESC LIMIT 1`
    );
    const statedIso = aFinal[0]?.data?.stated_deadline_iso;
    const storedIso = new Date(aLink2b[0]?.expire_by).toISOString();
    check("A deadline equals stored expiry (U-DEADLINE)",
      !!statedIso && new Date(statedIso).getTime() === new Date(storedIso).getTime(),
      `stated=${statedIso} stored=${storedIso}`);
    check("A final points at live link", ((aFinal[0]?.data?.message_copy || "") as string).includes(aLink2b[0]?.short_url || "IMPOSSIBLE"),
      "short_url in copy");
    check("A no new spend", (await budget()) === r0 + 10000, `reserved=${await budget()}`);
    const { rows: aIntents } = await query(
      `SELECT action_type FROM action_intents WHERE target_id = $1 ORDER BY created_at`, [a.cartId]
    );
    check("A three intents, one incentive",
      JSON.stringify(aIntents.map((r: any) => r.action_type)) === JSON.stringify(["recovery_early", "recovery_24h", "recovery_final"]),
      `intents=${aIntents.map((r: any) => r.action_type).join(",")}`);

    // ── Cart B: re-issue path (24h link dead) preserves the deadline ──
    const b = await seedV42Customer({
      tag: `ladB${crypto.randomUUID().slice(0, 8)}`, arm: "treatment", marketingOptIn: true,
      segment: "ladder_e2e", abandonedHoursAgo: 1.5, touchesToday: 0,
    });
    await processAbandonedCart(b.cartId, { stage: "early" });
    const { rows: btcRows } = await query(`SELECT COALESCE(SUM(count),0) as n FROM touches WHERE customer_id = $1`, [b.customerId]);
    await query(`DELETE FROM touches WHERE customer_id = $1`, [b.customerId]);
    await query(`INSERT INTO touches (merchant_id, customer_id, day, count) VALUES ($1, $2, $3, $4)`,
      [MERCHANT_ID, b.customerId, yd, Number(btcRows[0]?.n || 1)]);
    await query(`UPDATE carts SET abandoned_at = NOW() - INTERVAL '25 hours' WHERE id = $1`, [b.cartId]);
    await processAbandonedCart(b.cartId, { stage: "24h" });
    const r1 = await budget();
    const { rows: bLink } = await query(
      `SELECT expire_by FROM payment_links WHERE cart_id = $1 AND incentive_paise = 10000`, [b.cartId]
    );
    const origExpiry = new Date(bLink[0]?.expire_by).toISOString();
    await query(`UPDATE payment_links SET status = 'expired' WHERE cart_id = $1 AND incentive_paise = 10000`, [b.cartId]);
    const { rows: btc2Rows } = await query(`SELECT COALESCE(SUM(count),0) as n FROM touches WHERE customer_id = $1`, [b.customerId]);
    await query(`DELETE FROM touches WHERE customer_id = $1`, [b.customerId]);
    await query(`INSERT INTO touches (merchant_id, customer_id, day, count) VALUES ($1, $2, $3, $4)`,
      [MERCHANT_ID, b.customerId, dd, Number(btc2Rows[0]?.n || 2)]);
    await processFinalCall(b.cartId);
    const { rows: bLinks } = await query(
      `SELECT incentive_paise, expire_by FROM payment_links WHERE cart_id = $1 AND status = 'live' ORDER BY created_at DESC LIMIT 1`,
      [b.cartId]
    );
    check("B re-issued same incentive", Number(bLinks[0]?.incentive_paise) === 10000, `inc=${bLinks[0]?.incentive_paise}`);
    check("B deadline preserved",
      new Date(bLinks[0]?.expire_by).getTime() === new Date(origExpiry).getTime(),
      `new=${bLinks[0]?.expire_by} orig=${origExpiry}`);
    check("B no double spend", (await budget()) === r1, `reserved=${await budget()}`);

    // ── Sweeper releases an expired hold ──
    await reserveBudget(MERCHANT_ID, 5000);
    const r2 = await budget();
    const { rows: swRows } = await query(
      `INSERT INTO payment_links (merchant_id, razorpay_link_id, token, amount_paise, incentive_paise, status, cart_id, expire_by)
       VALUES ($1, $2, $3, 100000, 5000, 'live', $4, NOW() - INTERVAL '1 hour') RETURNING id`,
      [MERCHANT_ID, `plink_sweep_${Date.now().toString(36)}`, `tok_sweep_${Date.now().toString(36)}`, a.cartId]
    );
    const swept = await sweepExpiredLinks();
    const { rows: swLink } = await query(`SELECT status FROM payment_links WHERE id = $1`, [swRows[0].id]);
    check("sweeper expires hold", swept.expired >= 1 && swLink[0]?.status === "expired",
      `swept=${swept.expired} status=${swLink[0]?.status}`);
    check("sweeper releases budget", (await budget()) === r2 - 5000, `reserved=${await budget()}`);
  } finally {
    setKillSwitch(false);
  }
}

async function gateUCountdown() {
  console.log("\nGATE U-COUNTDOWN — pay page countdown/stock/trust grounded live");
  const { rows: linkRows } = await query(
    `SELECT pl.expire_by, pl.cart_id, pl.merchant_id, pt.token AS pay_token
     FROM payment_links pl JOIN pay_tokens pt ON pt.audit_seq = pl.audit_seq
     WHERE pl.status = 'live' AND pl.expire_by IS NOT NULL
     ORDER BY pl.created_at DESC LIMIT 1`
  );
  const link = linkRows[0];
  if (!link?.pay_token) throw new Error("no live link with pay token for fixture");

  const before = Date.now();
  const resp = await fetch(`http://localhost:3000/pay/${link.pay_token}`);
  const body = await resp.json();
  const expected = Math.floor((new Date(link.expire_by).getTime() - before) / 1000);
  check("countdown equals expire_by-now",
    typeof body.expires_in_seconds === "number" && Math.abs(body.expires_in_seconds - expected) <= 15,
    `page=${body.expires_in_seconds}s expected≈${expected}s`);

  const { rows: dbStock } = await query(
    `SELECT p.id, p.stock FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.cart_id = $1`,
    [link.cart_id]
  );
  const pageStock = (body.stock || []).map((s: any) => `${s.product_id}:${s.stock}`).sort().join(",");
  const realStock = dbStock.map((r: any) => `${r.id}:${r.stock}`).sort().join(",");
  check("stock equals DB", body.stock && pageStock === realStock, `page=[${pageStock}]`);

  const { rows: mRows } = await query("SELECT name FROM merchants WHERE id = $1", [link.merchant_id]);
  check("trust strip", body.trust?.merchant_name === mRows[0]?.name && body.trust?.secured_by === "Razorpay",
    `trust=${JSON.stringify(body.trust)}`);

  // Tamper either source → claim omitted, page still renders.
  const { rows: expRows } = await query(
    `SELECT expire_by FROM payment_links WHERE cart_id = $1 AND status = 'live' LIMIT 1`, [link.cart_id]
  );
  const savedExpiry = expRows[0]?.expire_by;
  // Stock omission is simulated by detaching the line item (stock is NOT NULL).
  const { rows: lineRows } = await query(`SELECT * FROM cart_items WHERE cart_id = $1`, [link.cart_id]);
  try {
    await query(`UPDATE payment_links SET expire_by = NULL WHERE cart_id = $1 AND status = 'live'`, [link.cart_id]);
    await query(`DELETE FROM cart_items WHERE cart_id = $1`, [link.cart_id]);
    const resp2 = await fetch(`http://localhost:3000/pay/${link.pay_token}`);
    const body2 = await resp2.json();
    check("tampered countdown omitted", body2.expires_in_seconds === undefined && !!body2.pay_url,
      `keys=${Object.keys(body2).join(",")}`);
    check("tampered stock omitted", body2.stock === undefined, `stock=${JSON.stringify(body2.stock)}`);
  } finally {
    if (savedExpiry) await query(`UPDATE payment_links SET expire_by = $1 WHERE cart_id = $2 AND status = 'live'`, [savedExpiry, link.cart_id]);
    for (const lr of lineRows) {
      await query(
        `INSERT INTO cart_items (id, cart_id, product_id, qty, unit_price_paise) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [lr.id, lr.cart_id, lr.product_id, lr.qty, lr.unit_price_paise]
      );
    }
  }
}

async function gateUFailCopy() {
  console.log("\nGATE U-FAILCOPY — retry reassurance frame, ₹0, recency intact");
  const { processFailedOrder, classifyFailureRecency, ensureFailureColumns } =
    await import("../src/agents/failureRetryBot.js");
  await ensureFailureColumns();

  // Recency rule units (pure logic, no DB).
  check("recent failure is reactive",
    classifyFailureRecency(new Date(Date.now() - 30 * 60e3)) === "reactive_buyer_action", "30min → reactive");
  check("old failure is proactive",
    classifyFailureRecency(new Date(Date.now() - 90 * 60e3)) === "proactive_marketing_touch", "90min → proactive");

  const seeded = await seedV42Customer({
    tag: `fail${crypto.randomUUID().slice(0, 8)}`, arm: "treatment", marketingOptIn: true,
    abandonedHoursAgo: 2, touchesToday: 0,
  });
  const { rows: orderRows } = await query(
    `INSERT INTO orders (id, merchant_id, source, cart_id, customer_id, amount_paise, status, created_at, payment_method, failed_at)
     VALUES ($1, $2, 'recovery', $3, $4, 159800, 'failed', NOW() - INTERVAL '30 minutes', 'upi', NOW() - INTERVAL '30 minutes')
     RETURNING id`,
    [crypto.randomUUID(), MERCHANT_ID, seeded.cartId, seeded.customerId]
  );
  const orderId = orderRows[0].id;

  await processFailedOrder(orderId);

  const { rows: links } = await query(
    `SELECT incentive_paise, status FROM payment_links WHERE cart_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [seeded.cartId]
  );
  check("retry link plain", links.length === 1 && Number(links[0]?.incentive_paise) === 0,
    `links=${links.length} inc=${links[0]?.incentive_paise}`);
  const { rows: thoughtRows } = await query(
    `SELECT data FROM activity WHERE actor = 'FailureRetryBot' AND type = 'AGENT_THOUGHT' ORDER BY id DESC LIMIT 1`
  );
  const copy = String(thoughtRows[0]?.data?.message_copy || "");
  check("reassurance frame", copy.includes("no worries") && copy.includes("still reserved") && copy.includes("pay by card instead"),
    `copy=${JSON.stringify(copy.slice(0, 110))}`);
  check("no incentive increase", !/₹\s?[1-9]/.test(copy), "copy promises no rupee amount");
  const { rows: intentRows } = await query(
    `SELECT status FROM action_intents WHERE target_id = $1 AND action_type = 'recovery_retry'`,
    [orderId]
  );
  check("retry intent done", intentRows[0]?.status === "done", `status=${intentRows[0]?.status}`);
  check("recency reactive", String(thoughtRows[0]?.data?.recency_class || "") === "reactive_buyer_action",
    `class=${thoughtRows[0]?.data?.recency_class}`);
}

async function gateUFastAdd() {
  console.log("\nGATE U-FASTADD — single-item prefilled 10-min add-on, honest wording");
  const { processPaidOrder } = await import("../src/agents/upsellBot.js");
  const { checkDarkPatterns } = await import("../src/lib/darkPatternFilter.js");

  const seeded = await seedV42Customer({
    tag: `fast${crypto.randomUUID().slice(0, 8)}`, arm: "treatment", marketingOptIn: true,
    abandonedHoursAgo: 0.1, touchesToday: 1,
  });
  // A paid order for her cart (no gateway involved — resolution path is gated elsewhere).
  const { rows: orderRows } = await query(
    `INSERT INTO orders (id, merchant_id, source, cart_id, customer_id, amount_paise, status, created_at, paid_at)
     VALUES ($1, $2, 'recovery', $3, $4, 159800, 'paid', NOW(), NOW()) RETURNING id`,
    [crypto.randomUUID(), MERCHANT_ID, seeded.cartId, seeded.customerId]
  );
  const orderId = orderRows[0].id;
  // Force a deterministic candidate: within the cart's merchant catalog, the cart
  // holds everything except the cheapest product, so the only upsell candidate
  // clears the ₹150 auto-approve limit at 15% off.
  const { rows: catRows } = await query(`SELECT merchant_id FROM carts WHERE id = $1`, [seeded.cartId]);
  const { rows: allProds } = await query(
    `SELECT id, price_paise FROM products WHERE merchant_id = $1 AND active = true AND stock > 0 ORDER BY price_paise ASC`,
    [catRows[0]?.merchant_id]
  );
  if (allProds.length < 2) throw new Error("need ≥2 same-merchant products for fixture");
  for (const p of allProds.slice(1)) {
    await query(
      `INSERT INTO cart_items (cart_id, product_id, qty, unit_price_paise) VALUES ($1, $2, 1, $3)`,
      [seeded.cartId, p.id, Number(p.price_paise)]
    );
  }
  const { rows: before } = await query(
    `SELECT COUNT(*) as cnt FROM payment_links WHERE customer_id = $1`, [seeded.customerId]
  );

  await processPaidOrder({ id: orderId, cart_id: seeded.cartId, customer_id: seeded.customerId, amount_paise: 159800 });

  const { rows: links } = await query(
    `SELECT * FROM payment_links WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 2`,
    [seeded.customerId]
  );
  check("single add-on link", links.length === Number(before[0]?.cnt) + 1, `new links=${links.length - Number(before[0]?.cnt)}`);
  const link = links[0];
  const { rows: ttlRows } = await query(
    `SELECT offer_expires_by, expire_by, created_at FROM payment_links WHERE id = $1`, [link?.id]
  );
  const offerS = link ? (new Date(ttlRows[0]?.offer_expires_by).getTime() - new Date(ttlRows[0]?.created_at).getTime()) / 1000 : -1;
  check("offer TTL <= 10 min", offerS > 0 && offerS <= 600, `offer_ttl=${offerS.toFixed(0)}s`);
  const gwS = link ? (new Date(ttlRows[0]?.expire_by).getTime() - new Date(ttlRows[0]?.created_at).getTime()) / 1000 : -1;
  check("gateway holds safe floor", gwS >= 25 * 60, `gateway_ttl=${gwS.toFixed(0)}s (offer enforced separately)`);
  // Prefill + framing observable on the live TEST link object.
  const { getRazorpay } = await import("../src/lib/razorpayService.js");
  let fetched: any = null;
  try { fetched = await getRazorpay().paymentLink.fetch(link.razorpay_link_id); } catch { /* link may be gone */ }
  const customer = (fetched as any)?.customer || {};
  check("customer pre-filled", !!(customer.email || customer.contact),
    `customer=${JSON.stringify(customer).slice(0, 80)}`);
  check("framing copy", ((fetched as any)?.description || "").includes("Add to your order"),
    `desc=${JSON.stringify(((fetched as any)?.description || "").slice(0, 60))}`);
  // Wording rule on everything customer-facing about this touch.
  const { rows: thoughtRows } = await query(
    `SELECT data FROM activity WHERE actor = 'UpsellBot' AND type = 'AGENT_THOUGHT' ORDER BY id DESC LIMIT 1`
  );
  const copy = String(thoughtRows[0]?.data?.message_copy || "");
  const banned = checkDarkPatterns(copy).violations.filter((v) =>
    /one-tap charge|instant ?charge|everyone is buying/i.test(copy));
  check("no stored-instrument wording", banned.length === 0, `copy=${JSON.stringify(copy.slice(0, 80))}`);
  // Declining (no pay event) produces no further touch: still exactly one link.
  const { rows: after } = await query(
    `SELECT COUNT(*) as cnt FROM payment_links WHERE customer_id = $1`, [seeded.customerId]
  );
  check("decline is silent", Number(after[0]?.cnt) === Number(before[0]?.cnt) + 1, `links=${after[0]?.cnt}`);
}

async function gateUReassure() {
  console.log("\nGATE U-REASSURE — saved claim only when true, help always");
  const { resolvePayment } = await import("../src/lib/moneyBus.js");

  const mkFixtureLink = async (tag: string, incentive: number) => {
    const seeded = await seedV42Customer({
      tag: `${tag}${crypto.randomUUID().slice(0, 8)}`, arm: "control", marketingOptIn: true,
      abandonedHoursAgo: 0.1, touchesToday: 0,
    });
    const { rows } = await query(
      `INSERT INTO payment_links (merchant_id, razorpay_link_id, token, amount_paise,
        incentive_paise, status, cart_id, customer_id)
       VALUES ($1, $2, $3, 159800, $4, 'live', $5, $6) RETURNING id`,
      [MERCHANT_ID, `plink_reassure_${Date.now().toString(36)}_${tag}`, `tok_reassure_${Date.now().toString(36)}_${tag}`,
       incentive, seeded.cartId, seeded.customerId]
    );
    return { linkId: rows[0].id, cartId: seeded.cartId, customerId: seeded.customerId };
  };

  // ₹0 incentive → NO saved-amount claim anywhere in the message.
  const { appendLedger } = await import("../src/lib/ledger.js");
  const plain = await mkFixtureLink("plain", 0);
  const { seq: plainSeq } = await appendLedger({
    merchantId: MERCHANT_ID, actor: "GateUReassure", action: "fixture", params: {},
    decision: "ALLOW", policy_checks: {}, rationale: {}, outcome: "PROPOSED",
  });
  await resolvePayment({
    id: plain.linkId, merchant_id: MERCHANT_ID, razorpay_link_id: "plink_reassure_plain",
    audit_seq: plainSeq, amount_paise: 159800, incentive_paise: 0,
    cart_id: plain.cartId, customer_id: plain.customerId,
  });
  const { rows: plainRows } = await query(
    `SELECT data FROM activity WHERE actor = 'MoneyBus' AND type = 'REASSURANCE' ORDER BY id DESC LIMIT 1`
  );
  const plainCopy = String(plainRows[0]?.data?.message_copy || "");
  check("zero incentive, no saved claim", !/saved/i.test(plainCopy) && plainCopy.includes("here to help"),
    `copy=${JSON.stringify(plainCopy.slice(0, 90))}`);

  // ₹100 incentive, paid → "You saved ₹100" renders grounded.
  const incent = await mkFixtureLink("incent", 10000);
  const { seq: incentSeq } = await appendLedger({
    merchantId: MERCHANT_ID, actor: "GateUReassure", action: "fixture", params: {},
    decision: "ALLOW", policy_checks: {}, rationale: {}, outcome: "PROPOSED",
  });
  await resolvePayment({
    id: incent.linkId, merchant_id: MERCHANT_ID, razorpay_link_id: "plink_reassure_incent",
    audit_seq: incentSeq, amount_paise: 149800, incentive_paise: 10000,
    cart_id: incent.cartId, customer_id: incent.customerId,
  });
  const { rows: incentRows } = await query(
    `SELECT data FROM activity WHERE actor = 'MoneyBus' AND type = 'REASSURANCE' ORDER BY id DESC LIMIT 1`
  );
  const incentCopy = String(incentRows[0]?.data?.message_copy || "");
  check("paid incentive renders saved", incentCopy.includes("You saved ₹100"), `copy=${JSON.stringify(incentCopy.slice(0, 90))}`);
  check("no upsell inside reassurance", !/add to your order|special offer|discount.*%/i.test(incentCopy), "pitch-free");
}

async function gateUStrategy() {
  console.log("\nGATE U-STRATEGY — five angles measured, min-n honest");
  const { chooseMessageStrategy, recordStrategyAttempt, recordStrategySuccess, getStrategyTable, COPY_STRATEGIES } =
    await import("../src/lib/copyStrategy.js");
  const { appendLedger } = await import("../src/lib/ledger.js");
  const fs = await import("node:fs");

  // 50 fixture decisions, LLM picks cycling uniformly through all five angles.
  const counts: Record<string, number> = {};
  let explored = 0;
  for (let i = 0; i < 50; i++) {
    const fixture = COPY_STRATEGIES[i % COPY_STRATEGIES.length];
    const { strategy, explored: ex } = chooseMessageStrategy(fixture);
    counts[strategy] = (counts[strategy] || 0) + 1;
    if (ex) explored++;
  }
  const floors = COPY_STRATEGIES.map((s) => `${s}=${counts[s] || 0}`).join(" ");
  check("all five ≥ ε-floor (5)", COPY_STRATEGIES.every((s) => (counts[s] || 0) >= 5), floors);
  check("exploration live", explored >= 1 && explored <= 20, `explored=${explored}/50`);

  // Deterministic exploration unit: forced draw lands uniform + flagged.
  const forced = chooseMessageStrategy("functional", () => 0.05);
  check("forced exploration", forced.explored === true && forced.strategy === "functional",
    `strategy=${forced.strategy} explored=${forced.explored}`);

  // Ledger rows carry the field.
  for (const s of COPY_STRATEGIES) {
    await appendLedger({
      merchantId: MERCHANT_ID, actor: "GateUStrategy", action: "strategy_fixture",
      params: {}, decision: "ALLOW", policy_checks: {},
      rationale: { message_strategy: s }, outcome: "SKIPPED",
    });
  }
  const { rows: ledRows } = await query(
    `SELECT COUNT(*) as cnt FROM audit_log WHERE actor = 'GateUStrategy'
     AND rationale_json->>'message_strategy' IN ('functional','loss_framed','social_proof','endowment','autonomy')`
  );
  check("ledger carries strategy", Number(ledRows[0]?.cnt) >= 5, `rows=${ledRows[0]?.cnt}`);

  // Dashboard split: record + read back with min-n honesty.
  await recordStrategyAttempt(MERCHANT_ID, "gate_seg", "functional");
  await recordStrategyAttempt(MERCHANT_ID, "gate_seg", "functional");
  await recordStrategySuccess(MERCHANT_ID, "gate_seg", "functional");
  const table = await getStrategyTable(MERCHANT_ID);
  const gateRow = table.find((r) => r.strategy === "functional" && r.attempts >= 2);
  check("table splits", !!gateRow && gateRow.successes >= 1, JSON.stringify(gateRow || null).slice(0, 120));
  check("min-n honesty", !!gateRow && gateRow.state === "collecting" && gateRow.rate === null,
    `state=${gateRow?.state} rate=${gateRow?.rate}`);
  const html = fs.readFileSync("src/public/dashboard/index.html", "utf8");
  check("dashboard renders table", html.includes("strategy-body") && html.includes("/api/strategy-stats"),
    "strategy-body + endpoint wired");
}

async function gateUSocial() {
  console.log("\nGATE U-SOCIAL — measured buyers, fresh rows only");
  const nock = (await import("nock")).default;
  nock.disableNetConnect();
  try {
    const { computeSocialProof } = await import("../src/lib/socialProof.js");
    const { finalizeCopy } = await import("../src/lib/claims.js");

    // Fixture cart → items → link carrying a known gateway order id.
    const seeded = await seedV42Customer({
      tag: `soc${crypto.randomUUID().slice(0, 8)}`, arm: "treatment", marketingOptIn: true,
      abandonedHoursAgo: 0.1, touchesToday: 0,
    });
    const { rows: prodRows } = await query(
      `SELECT ci.product_id FROM cart_items ci WHERE ci.cart_id = $1 LIMIT 1`, [seeded.cartId]
    );
    const productId = prodRows[0]?.product_id;
    if (!productId) throw new Error("fixture cart has no items");
    const fixtureOrder = `order_fixture_social_${Date.now().toString(36)}`;
    await query(
      `INSERT INTO payment_links (merchant_id, razorpay_link_id, razorpay_order_id, token, amount_paise, incentive_paise, status, cart_id, customer_id)
       VALUES ($1, $2, $3, $4, 159800, 0, 'live', $5, $6)`,
      [MERCHANT_ID, `plink_soc_${Date.now().toString(36)}`, fixtureOrder,
       `tok_soc_${Date.now().toString(36)}`, seeded.cartId, seeded.customerId]
    );

    // 127 gateway payments from 127 distinct buyers against that order.
    const nowSec = Math.floor(Date.now() / 1000);
    const items = Array.from({ length: 127 }, (_, i) => ({
      id: `pay_fixture_${i}`, order_id: fixtureOrder,
      email: `buyer${i}@example.com`, contact: `+919800000${String(i).padStart(3, "0")}`,
      created_at: nowSec - i * 60, captured: true, status: "captured",
    }));
    const scope = nock("https://api.razorpay.com");
    scope.get("/v1/payments").query(true).reply(200, { items });
    scope.get("/v1/payments").query(true).reply(200, { items: [] });

    const computed = await computeSocialProof();
    check("stats computed", computed.products >= 1 && computed.payments === 127,
      `products=${computed.products} payments=${computed.payments}`);
    const { rows: statRows } = await query(`SELECT units_7d, buyers_7d FROM social_stats WHERE product_id = $1`, [productId]);
    check("true counts", Number(statRows[0]?.units_7d) === 127 && Number(statRows[0]?.buyers_7d) === 127,
      `units=${statRows[0]?.units_7d} buyers=${statRows[0]?.buyers_7d}`);

    const rendered = await finalizeCopy({
      copy: `[claim:social_proof:${productId}] bought in the last 7 days — grab yours.`,
      facts: {},
      source: "llm",
      fallbackTemplate: "Popular with our customers — grab yours.",
      ledger: null,
    });
    check("token renders true count", rendered.copy.startsWith("127 bought in the last 7 days"),
      `copy=${JSON.stringify(rendered.copy.slice(0, 50))}`);
    check("resolution recorded",
      rendered.result.resolved.some((r) => r.type === "social_proof" && r.value === 127),
      `resolved=${JSON.stringify(rendered.result.resolved)}`);

    // Stale row (>26h) → suppressed, template fallback.
    await query(`UPDATE social_stats SET computed_at = NOW() - INTERVAL '30 hours' WHERE product_id = $1`, [productId]);
    const stale = await finalizeCopy({
      copy: `[claim:social_proof:${productId}] bought in the last 7 days — grab yours.`,
      facts: {},
      source: "llm",
      fallbackTemplate: "Popular with our customers — grab yours.",
      ledger: null,
    });
    check("stale suppressed", stale.copy === "Popular with our customers — grab yours.",
      `copy=${JSON.stringify(stale.copy.slice(0, 60))}`);
    check("stale noted", stale.result.stripped.some((s) => String(s.reason).includes("stale")),
      `stripped=${JSON.stringify(stale.result.stripped)}`);

    await query(`DELETE FROM social_stats WHERE product_id = $1`, [productId]);
  } finally {
    nock.cleanAll();
    nock.enableNetConnect();
  }
}

async function gateUFatigue() {
  console.log("\nGATE U-FATIGUE — two misses double spacing, engagement resets");
  const { getFatigueState, isTouchAllowed } = await import("../src/lib/fatigue.js");
  const { evaluateAction } = await import("../src/lib/policyEngine.js");

  const seeded = await seedV42Customer({
    tag: `fat${crypto.randomUUID().slice(0, 8)}`, arm: "treatment", marketingOptIn: true,
    abandonedHoursAgo: 0.1, touchesToday: 0,
  });
  const today = new Date().toISOString().slice(0, 10);
  const yd = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  await query(`DELETE FROM touches WHERE customer_id = $1`, [seeded.customerId]);
  await query(
    `INSERT INTO touches (merchant_id, customer_id, day, count) VALUES ($1, $2, $3, 1), ($1, $2, $4, 1)`,
    [MERCHANT_ID, seeded.customerId, today, yd]
  );

  const state = await getFatigueState(seeded.customerId);
  check("two misses measured", state.consecutive_misses === 2 && state.multiplier === 2,
    `misses=${state.consecutive_misses} mult=${state.multiplier}`);
  const gate = await isTouchAllowed(seeded.customerId);
  check("next touch held", gate.allowed === false && gate.reason === "fatigue_doubled_spacing",
    `allowed=${gate.allowed} reason=${gate.reason}`);
  const pol = await evaluateAction("recovery_incentive", {
    amount_paise: 0, incentive_paise: 0, margin_paise: 63900, customer_touches_today: 1,
    customerId: seeded.customerId, isRecovery: true, actionClass: "proactive_marketing_touch",
  });
  check("fatigue logged in checks", pol.checks.fatigue === "DOUBLE_SPACING",
    `fatigue=${pol.checks.fatigue}`);

  // Engagement resets: a paid order clears the doubling.
  await query(
    `INSERT INTO orders (id, merchant_id, source, cart_id, customer_id, amount_paise, status, created_at, paid_at)
     VALUES ($1, $2, 'recovery', $3, $4, 159800, 'paid', NOW(), NOW())`,
    [crypto.randomUUID(), MERCHANT_ID, seeded.cartId, seeded.customerId]
  );
  const reset = await getFatigueState(seeded.customerId);
  check("engagement resets", reset.multiplier === 1 && reset.consecutive_misses === 0,
    `mult=${reset.multiplier} misses=${reset.consecutive_misses}`);
  const gate2 = await isTouchAllowed(seeded.customerId);
  check("touch allowed again", gate2.allowed === true, `allowed=${gate2.allowed}`);
}

async function main() {
  loadConfig();
  const which = process.argv[2] || "u-arm";
  try {
    if (which === "u-arm") await gateUArm();
    else if (which === "u-cancel-race") await gateUCancelRace();
    else if (which === "u-lifetime") await gateULifetime();
    else if (which === "u-chat-seg") await gateUChatSeg();
    else if (which === "u-chat-cost") await gateUChatCost();
    else if (which === "e-two-touch") await gateETwoTouch();
    else if (which === "u-bucket75") await gateUBucket75();
    else if (which === "u-refund-alarm") await gateURefundAlarm();
    else if (which === "u-checkpt-mail") await gateUCheckptMail();
    else if (which === "u-ground") await gateUGround();
    else if (which === "e-ladder") await gateELadder();
    else if (which === "u-countdown") await gateUCountdown();
    else if (which === "u-failcopy") await gateUFailCopy();
    else if (which === "u-fastadd") await gateUFastAdd();
    else if (which === "u-reassure") await gateUReassure();
    else if (which === "u-strategy") await gateUStrategy();
    else if (which === "u-social") await gateUSocial();
    else if (which === "u-fatigue") await gateUFatigue();
    else { console.log(`unknown gate: ${which}`); process.exit(2); }
  } catch (err: any) {
    console.error("GATE ERROR:", err.message);
    failures++;
  } finally {
    await closePool();
  }
  console.log(failures === 0 ? "\nGATE GREEN" : `\nGATE RED (${failures} failures)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
