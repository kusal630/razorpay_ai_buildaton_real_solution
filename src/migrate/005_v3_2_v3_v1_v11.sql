-- V3: Consent classes (transactional + marketing)
-- Two separate consent classes with independent policy checks

-- Replace the single consent_json with two-class structure
ALTER TABLE customers DROP COLUMN IF EXISTS consent_json;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS consent_transactional JSONB NOT NULL DEFAULT '{
  "anchor_cart_ids": [],
  "latest_anchor_at": null,
  "expires_at": null
}'::jsonb;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS consent_marketing JSONB NOT NULL DEFAULT '{
  "opt_in": false,
  "source": null,
  "consented_at": null
}'::jsonb;

-- V1: Tracking hardening - public/secret key split
-- Add track_keys table for per-merchant key management
CREATE TABLE IF NOT EXISTS track_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  key_type TEXT NOT NULL CHECK (key_type IN ('public_site', 'secret_server')),
  key_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ
);

-- Insert default keys for the single merchant
INSERT INTO track_keys (merchant_id, key_type, key_hash) VALUES
  ('5a3ac6ce-b2c7-4b1f-a9db-45296841f30b', 'public_site', 'sellable_pub_default'),
  ('5a3ac6ce-b2c7-4b1f-a9db-45296841f30b', 'secret_server', 'sellable_secret_default')
ON CONFLICT DO NOTHING;

-- Rate limiting for tracking
CREATE TABLE IF NOT EXISTS track_rate_limits (
  key_id UUID NOT NULL REFERENCES track_keys(id),
  day DATE NOT NULL DEFAULT CURRENT_DATE,
  event_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, day)
);

-- V11: Budget reservation table
CREATE TABLE IF NOT EXISTS daily_budget (
  day DATE NOT NULL DEFAULT CURRENT_DATE,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  cap_paise BIGINT NOT NULL DEFAULT 500000,
  reserved_paise BIGINT NOT NULL DEFAULT 0,
  realized_paise BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, merchant_id)
);

-- Insert default budget for single merchant
INSERT INTO daily_budget (day, merchant_id, cap_paise) VALUES
  (CURRENT_DATE, '5a3ac6ce-b2c7-4b1f-a9db-45296841f30b', 500000)
ON CONFLICT DO NOTHING;

-- Deferred actions queue for quiet hours
CREATE TABLE IF NOT EXISTS deferred_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id TEXT NOT NULL,
  customer_id UUID REFERENCES customers(id),
  merchant_id UUID NOT NULL,
  action_type TEXT NOT NULL,
  params_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  resume_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispatched', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at TIMESTAMPTZ
);
