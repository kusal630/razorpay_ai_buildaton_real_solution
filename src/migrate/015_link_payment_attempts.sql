-- 015: link payment-attempt sightings. A payment_link stays 'created' when an
-- attempt fails (failures live on payment entities, not the link), so the
-- poller records every failed attempt it sees. UNIQUE payment id = the
-- dedupe: one failed attempt notifies exactly once, no matter how many
-- passes (or paths: poller + webhook converge here) observe it.
CREATE TABLE IF NOT EXISTS link_payment_attempts (
  razorpay_payment_id TEXT PRIMARY KEY,
  payment_link_id UUID REFERENCES payment_links(id),
  razorpay_link_id TEXT NOT NULL,
  merchant_id UUID,
  cart_id TEXT,
  customer_id UUID,
  amount_paise BIGINT,
  method TEXT,
  status TEXT NOT NULL DEFAULT 'failed',
  order_id UUID REFERENCES orders(id),
  nudged BOOLEAN NOT NULL DEFAULT false,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_link_attempts_link ON link_payment_attempts(razorpay_link_id);
