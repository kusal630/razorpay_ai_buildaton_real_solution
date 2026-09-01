-- Sellable v3: Complete schema migration
-- Hand-written SQL, no ORM
-- gen_random_uuid() is built-in since PostgreSQL 13

-- Merchant admins
CREATE TABLE IF NOT EXISTS merchant_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Merchants
CREATE TABLE IF NOT EXISTS merchants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  track_key_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Products
CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  name TEXT NOT NULL,
  price_paise BIGINT NOT NULL CHECK (price_paise > 0),
  cost_paise BIGINT NOT NULL CHECK (cost_paise >= 0),
  stock INTEGER NOT NULL CHECK (stock >= 0),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Customers (PII encrypted at rest)
CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  name_enc TEXT NOT NULL,
  email_enc TEXT NOT NULL,
  phone_enc TEXT NOT NULL,
  segment TEXT NOT NULL DEFAULT 'default',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Carts
CREATE TABLE IF NOT EXISTS carts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  customer_id UUID REFERENCES customers(id),
  items_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_paise BIGINT NOT NULL CHECK (total_paise >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','abandoned','recovered','expired')),
  abandoned_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hold tokens (stock reservations)
CREATE TABLE IF NOT EXISTS hold_tokens (
  token UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  quote_id UUID NOT NULL,
  product_id UUID NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','confirmed','released','expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Orders
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  source TEXT NOT NULL CHECK (source IN ('recovery','upsell','ai_buyer','direct')),
  cart_id UUID REFERENCES carts(id),
  customer_id UUID REFERENCES customers(id),
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','authorized','paid','failed','expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ
);

-- Audit log (append-only, hash-chained)
CREATE TABLE IF NOT EXISTS audit_log (
  seq BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  params_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  decision TEXT NOT NULL CHECK (decision IN ('ALLOW','ESCALATE','BLOCK')),
  policy_checks_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  rationale_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  outcome TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (outcome IN ('PROPOSED','SUCCESS','FAILED','BLOCKED','ESCALATED','DENIED','EXPIRED','DLQ')),
  outcome_detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  prev_hash TEXT NOT NULL DEFAULT '',
  hash TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_outcome ON audit_log(outcome);

-- Ledger checkpoints
CREATE TABLE IF NOT EXISTS ledger_checkpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  head_seq BIGINT NOT NULL,
  head_hash TEXT NOT NULL,
  prev_checkpoint_hash TEXT NOT NULL DEFAULT ''
);

-- Segment stats (Thompson sampling bandits)
CREATE TABLE IF NOT EXISTS segment_stats (
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  segment TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (merchant_id, segment, bucket)
);

-- Touches (customer contact frequency)
CREATE TABLE IF NOT EXISTS touches (
  customer_id UUID NOT NULL,
  day DATE NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (customer_id, day)
);

-- Approvals
CREATE TABLE IF NOT EXISTS approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  audit_seq BIGINT NOT NULL REFERENCES audit_log(seq),
  context_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','expired')),
  decided_by UUID REFERENCES merchant_admins(id),
  decided_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

-- Buyer API keys
CREATE TABLE IF NOT EXISTS buyer_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  label TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  rate_limit_per_min INTEGER NOT NULL DEFAULT 60,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Webhook events
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

-- Dead letters
CREATE TABLE IF NOT EXISTS dead_letters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT REFERENCES webhook_events(event_id),
  payload_json JSONB NOT NULL,
  error TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  response_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Job state (for cursoring)
CREATE TABLE IF NOT EXISTS job_state (
  name TEXT PRIMARY KEY,
  last_run_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Policy rules (editable in dashboard)
CREATE TABLE IF NOT EXISTS policy_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action TEXT NOT NULL,
  auto_limit_paise BIGINT NOT NULL DEFAULT 0,
  escalate_limit_paise BIGINT NOT NULL DEFAULT 0,
  hard_block_limit_paise BIGINT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Policy change audit
CREATE TABLE IF NOT EXISTS policy_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID NOT NULL REFERENCES policy_rules(id),
  changed_by UUID REFERENCES merchant_admins(id),
  old_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  new_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
