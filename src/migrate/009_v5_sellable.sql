-- 009_v5_sellable.sql: Add missing tables and columns for full pipeline.
-- Works with the existing 41-table schema (001-008).

BEGIN;

-- Activity feed (drives Live Agent Console SSE feed)
CREATE TABLE IF NOT EXISTS activity (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  merchant_id UUID,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  amount_paise BIGINT,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  simulated BOOLEAN NOT NULL DEFAULT false,
  severity TEXT NOT NULL DEFAULT 'info'
);
CREATE INDEX IF NOT EXISTS idx_activity_id ON activity(id DESC);
CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity(ts DESC);

-- Admin audit trail
CREATE TABLE IF NOT EXISTS admin_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  admin_id UUID,
  action TEXT NOT NULL,
  params_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip TEXT
);

-- Payment links
CREATE TABLE IF NOT EXISTS payment_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID,
  razorpay_link_id TEXT,
  razorpay_order_id TEXT,
  ext_ref TEXT UNIQUE,
  audit_seq BIGINT REFERENCES audit_log(seq),
  token TEXT UNIQUE,
  cart_id TEXT,
  customer_id UUID,
  amount_paise BIGINT NOT NULL,
  incentive_paise BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live','paid','expired','cancelled')),
  simulate BOOLEAN NOT NULL DEFAULT false,
  expire_by TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_payment_links_status ON payment_links(status);
CREATE INDEX IF NOT EXISTS idx_payment_links_cart ON payment_links(cart_id, status);
CREATE INDEX IF NOT EXISTS idx_payment_links_token ON payment_links(token);

-- Orders missing columns
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_paise BIGINT NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS simulated BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ext_ref TEXT;

-- Products: price_version for 409 "catalog changed, re-quote"
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_version INTEGER NOT NULL DEFAULT 1;

-- Buyer sessions: quote snapshot
ALTER TABLE buyer_sessions ADD COLUMN IF NOT EXISTS quote_snapshot_json JSONB;
ALTER TABLE buyer_sessions ADD COLUMN IF NOT EXISTS price_version INTEGER NOT NULL DEFAULT 1;

-- Daily budget: add settled/released columns
ALTER TABLE daily_budget ADD COLUMN IF NOT EXISTS settled_paise BIGINT NOT NULL DEFAULT 0;
ALTER TABLE daily_budget ADD COLUMN IF NOT EXISTS released_paise BIGINT NOT NULL DEFAULT 0;

-- Incentive reservations
CREATE TABLE IF NOT EXISTS incentive_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID,
  cart_id TEXT,
  intent_id UUID,
  budget_day DATE NOT NULL DEFAULT CURRENT_DATE,
  amount_paise BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','settled','released','expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

-- Kill switch state
CREATE TABLE IF NOT EXISTS kill_switch_state (
  id BOOLEAN PRIMARY KEY DEFAULT true,
  enabled BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO kill_switch_state (id, enabled) VALUES (true, false) ON CONFLICT DO NOTHING;

-- Insert default merchant + admin + track keys if missing
INSERT INTO merchants (id, name, track_key_hash)
VALUES ('5a3ac6ce-b2c7-4b1f-a9db-45296841f30b', 'Demo Store', 'default')
ON CONFLICT DO NOTHING;

-- Ensure today's budget exists
INSERT INTO daily_budget (day, merchant_id, cap_paise)
VALUES (CURRENT_DATE, '5a3ac6ce-b2c7-4b1f-a9db-45296841f30b', 500000)
ON CONFLICT DO NOTHING;

COMMIT;