import { Router, Request, Response } from "express";
import { query } from "../db.js";
import { resolvePayToken } from "../lib/payToken.js";
import { createLogger } from "../logger.js";

const log = createLogger("chat");
export const chatRouter = Router();

// GET /pay/:token — masked PII, offer terms, "Pay" button
chatRouter.get("/pay/:token", async (req: Request, res: Response) => {
  const { token } = req.params;
  // Sequential probing → 404
  if (/^\d+$/.test(token)) { res.status(404).json({ error: "Not found" }); return; }
  try {
    const resolved = await resolvePayToken(token);
    if (!resolved) { res.status(404).json({ error: "Invalid or expired token" }); return; }
    const { rows: linkRows } = await query(
      `SELECT short_url, amount_paise, incentive_paise, razorpay_link_id,
              expire_by, offer_expires_by, cart_id, merchant_id
       FROM payment_links WHERE audit_seq = $1 AND status = 'live' LIMIT 1`,
      [resolved.auditSeq]
    );
    const link = linkRows[0];
    // Enforced deadline: the offer window when shorter than the gateway floor.
    if (link && link.offer_expires_by && new Date(link.offer_expires_by) < new Date(link.expire_by)) {
      link.expire_by = link.offer_expires_by;
    }
    // N1 (v4.2): control-arm tokens get NO chat widget — decided server-side.
    // Resolve the offer's customer via the link row and check her experiment arm.
    let chatEnabled = true;
    let arm: string | null = null;
    try {
      const { rows: custRows } = await query(
        `SELECT customer_id FROM payment_links WHERE audit_seq = $1 LIMIT 1`,
        [resolved.auditSeq]
      );
      const customerId = custRows[0]?.customer_id;
      if (customerId) {
        const { getCustomerArm } = await import("../lib/experiment.js");
        const armInfo = await getCustomerArm(customerId);
        arm = armInfo?.arm || null;
        chatEnabled = arm !== "control";
      }
    } catch { /* fail open: widget stays enabled */ }
    // G3 (v4.3): live countdown + live stock + trust strip, all rendered from
    // the SAME sources the sweeper/policy enforce. A tampered/unknown source
    // simply omits the claim — the page never renders what it can't ground.
    let expires_in_seconds: number | undefined;
    if (link?.expire_by) {
      expires_in_seconds = Math.max(0, Math.floor((new Date(link.expire_by).getTime() - Date.now()) / 1000));
    }
    let stock: { product_id: string; name: string; stock: number }[] | undefined;
    if (link?.cart_id) {
      try {
        const { rows: stockRows } = await query(
          `SELECT p.id AS product_id, p.name, p.stock
           FROM cart_items ci JOIN products p ON p.id = ci.product_id
           WHERE ci.cart_id = $1`,
          [link.cart_id]
        );
        if (stockRows.length > 0 && stockRows.every((r: any) => r.stock != null)) {
          stock = stockRows.map((r: any) => ({ product_id: r.product_id, name: r.name, stock: Number(r.stock) }));
        }
      } catch { /* omit stock claim */ }
    }
    let merchant_name: string | undefined;
    if (link?.merchant_id) {
      try {
        const { rows: mRows } = await query("SELECT name FROM merchants WHERE id = $1", [link.merchant_id]);
        merchant_name = mRows[0]?.name || undefined;
      } catch { /* omit merchant claim */ }
    }
    // G8 social line, only from a fresh row (stale → suppressed).
    let social_proof: { product_id: string; units_7d: number }[] | undefined;
    if (link?.cart_id) {
      try {
        const { rows: spRows } = await query(
          `SELECT ci.product_id, s.units_7d FROM cart_items ci
           JOIN social_stats s ON s.product_id = ci.product_id
           WHERE ci.cart_id = $1
           AND s.computed_at > NOW() - INTERVAL '26 hours'`,
          [link.cart_id]
        );
        if (spRows.length > 0) {
          social_proof = spRows.map((r: any) => ({ product_id: r.product_id, units_7d: Number(r.units_7d) }));
        }
      } catch { /* table may not exist yet — omit */ }
    }
    // T1: trust strip — returns policy + delivery estimate, resolver-gated:
    // unconfigured sources simply omit the line (never a bare claim).
    let returns_policy: string | undefined;
    let delivery_estimate: string | undefined;
    if (link?.merchant_id) {
      try {
        const { rows: cfgRows } = await query(
          "SELECT key, value_jsonb FROM merchant_config WHERE merchant_id = $1 AND key IN ('returns_policy', 'shipping')",
          [link.merchant_id]
        );
        const cfg: Record<string, any> = {};
        for (const r of cfgRows) cfg[r.key] = r.value_jsonb;
        const summary = String(cfg.returns_policy?.summary || "").slice(0, 80);
        if (summary) returns_policy = summary;
        const eta = Number(cfg.shipping?.eta_days ?? NaN);
        if (Number.isFinite(eta) && eta > 0) delivery_estimate = `delivery in ~${Math.round(eta)} days`;
      } catch { /* omit trust lines */ }
    }
    res.json({
      token, amount_paise: resolved.amountPaise, masked_pii: resolved.maskedPii,
      pay_url: link?.short_url || "", incentive_paise: link?.incentive_paise || 0,
      razorpay_link_id: link?.razorpay_link_id || "",
      chat_enabled: chatEnabled,
      experiment_arm: arm,
      ...(expires_in_seconds !== undefined ? { expires_in_seconds } : {}),
      ...(stock ? { stock } : {}),
      trust: {
        ...(merchant_name ? { merchant_name } : {}),
        secured_by: "Razorpay",
        ...(returns_policy ? { returns_policy } : {}),
        ...(delivery_estimate ? { delivery_estimate } : {}),
      },
      ...(social_proof ? { social_proof } : {}),
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /chat/:seq — ChatAgent explains offer, request_discount routes through PolicyEngine
chatRouter.post("/chat/:seq", async (req: Request, res: Response) => {
  const { seq } = req.params;
  const { message } = req.body;
  if (!message) { res.status(400).json({ error: "message required" }); return; }
  try {
    const { rows } = await query("SELECT * FROM audit_log WHERE seq = $1", [parseInt(seq)]);
    if (!rows[0]) { res.status(404).json({ error: "Audit seq not found" }); return; }
    const { appendActivity } = await import("../lib/activity.js");
    await appendActivity({
      merchant_id: "5a3ac6ce-b2c7-4b1f-a9db-45296841f30b", actor: "ChatAgent", type: "INTENT",
      summary: `Chat message on seq ${seq}: "${message.slice(0, 50)}"`,
      data: { seq: parseInt(seq), message: message.slice(0, 200) },
    });
    const { handleChatMessage } = await import("../agents/chatAgent.js");
    const result = await handleChatMessage(seq, message, `pay-${seq}`);
    res.json({ message: result.response, action: result.action || "explain", audit_seq: parseInt(seq) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});
