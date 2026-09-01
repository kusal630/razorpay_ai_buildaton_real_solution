-- H1: Cancel-before-create + overpayment handler
-- H2: Fee basis
-- H3: pay_tokens
-- H9: Mandate hardening (jti, expiry, per-key caps)

-- H1: open_links table for cancel-before-create
CREATE TABLE IF NOT EXISTS open_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_link_id TEXT NOT NULL,
  cart_id TEXT NOT NULL,
  customer_id UUID REFERENCES customers(id),
  merchant_id UUID NOT NULL,
  amount_paise BIGINT NOT NULL,
  incentive_paise BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled','converted','expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ
);

CREATE INDEX idx_open_links_cart ON open_links(cart_id, status);

-- H1: Overpayment tracking
CREATE TABLE IF NOT EXISTS overpayments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id TEXT NOT NULL,
  cart_id TEXT NOT NULL,
  original_amount_paise BIGINT NOT NULL,
  overpayment_amount_paise BIGINT NOT NULL,
  refund_id TEXT,
  refund_status TEXT CHECK (refund_status IN ('auto_refunded','escalated','pending')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

-- H2: Fee basis on orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fee_paise BIGINT NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_paise BIGINT NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fee_basis TEXT NOT NULL DEFAULT 'modeled' CHECK (fee_basis IN ('entity','modeled'));

-- H3: pay_tokens table
CREATE TABLE IF NOT EXISTS pay_tokens (
  token TEXT PRIMARY KEY,
  audit_seq BIGINT NOT NULL REFERENCES audit_log(seq),
  merchant_id UUID NOT NULL,
  customer_id UUID REFERENCES customers(id),
  amount_paise BIGINT NOT NULL,
  masked_pii JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pay_tokens_audit_seq ON pay_tokens(audit_seq);

-- H3: Per-token rate limiting
CREATE TABLE IF NOT EXISTS pay_token_rate_limits (
  token TEXT NOT NULL REFERENCES pay_tokens(token),
  day DATE NOT NULL DEFAULT CURRENT_DATE,
  access_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (token, day)
);

-- H9: Mandate hardening
ALTER TABLE buyer_sessions ADD COLUMN IF NOT EXISTS mandate_jti TEXT;
ALTER TABLE buyer_sessions ADD COLUMN IF NOT EXISTS mandate_replay_cache JSONB NOT NULL DEFAULT '{}'::jsonb;

-- H9: Per-key daily spend cap
CREATE TABLE IF NOT EXISTS buyer_key_caps (
  key_id UUID NOT NULL REFERENCES track_keys(id),
  day DATE NOT NULL DEFAULT CURRENT_DATE,
  spend_paise BIGINT NOT NULL DEFAULT 0,
  cap_paise BIGINT NOT NULL DEFAULT 100000, -- Rs.1000 default
  PRIMARY KEY (key_id, day)
);
