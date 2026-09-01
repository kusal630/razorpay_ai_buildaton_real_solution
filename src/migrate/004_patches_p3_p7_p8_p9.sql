-- P3: Profit-based economics
-- Add fee tracking and net profit to orders

ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_fee_paise BIGINT NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS incentive_paise BIGINT NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS net_profit_paise BIGINT NOT NULL DEFAULT 0;

-- P5: Policy hardening - quiet hours, touch tracking enhancements
-- (touch tracking already exists, add 30-day incentive tracking)

-- P8: Consent + PII access log
ALTER TABLE customers ADD COLUMN IF NOT EXISTS consent_json JSONB NOT NULL DEFAULT '{"marketing_opt_in": false, "channels": [], "consented_at": null, "source": null}'::jsonb;

CREATE TABLE IF NOT EXISTS pii_access_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor TEXT NOT NULL,
  customer_id UUID NOT NULL REFERENCES customers(id),
  purpose TEXT NOT NULL,
  audit_seq BIGINT
);

-- P9: Reconciliation runs persistence
CREATE TABLE IF NOT EXISTS reconcile_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rows_checked INTEGER NOT NULL DEFAULT 0,
  matched INTEGER NOT NULL DEFAULT 0,
  mismatches INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0,
  detail_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- P7: Buyer sessions
CREATE TABLE IF NOT EXISTS buyer_sessions (
  id TEXT PRIMARY KEY,
  buyer_agent_id TEXT NOT NULL,
  mandate_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','quoted','intent','paid','escalated','denied','expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  audit_seq BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
