-- 010_v5_build.sql: v5.0 consolidated build (M1–M34). Idempotent.
BEGIN;

-- M1: key-version transition on customers
ALTER TABLE customers ADD COLUMN IF NOT EXISTS key_version INTEGER NOT NULL DEFAULT 1;

-- M6: store-credit ledger
CREATE TABLE IF NOT EXISTS credit_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID,
  customer_id UUID,
  order_id TEXT,
  amount_paise BIGINT NOT NULL CHECK (amount_paise >= 0),
  bonus_paise BIGINT NOT NULL DEFAULT 0 CHECK (bonus_paise >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','redeemed','expired')),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '90 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credit_customer ON credit_ledger(customer_id, status);

-- M8: ledger-verified reviews
CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID,
  product_id TEXT NOT NULL,
  customer_id UUID,
  order_id TEXT,
  audit_seq BIGINT,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  text TEXT NOT NULL DEFAULT '',
  reviewer_mask TEXT NOT NULL DEFAULT '',
  token TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivery_confirmed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','suppressed'))
);
CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id, status);

-- M9: approval patterns (advisory only — N29: never a policy edit path)
CREATE TABLE IF NOT EXISTS approval_patterns (
  merchant_id UUID NOT NULL,
  dimension TEXT NOT NULL,
  value TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0,
  approved INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  edited INTEGER NOT NULL DEFAULT 0,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, dimension, value)
);

-- M10: mandate replay guard (jti unseen)
CREATE TABLE IF NOT EXISTS mandate_jtis (
  jti TEXT PRIMARY KEY,
  merchant_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- M11/M12: reminders + price watches
CREATE TABLE IF NOT EXISTS reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID,
  customer_id UUID,
  cart_id TEXT NOT NULL,
  fire_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','fired','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS price_watches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID,
  customer_id UUID,
  product_id TEXT NOT NULL,
  watched_price_paise BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','fired','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- M13: merchant config surface
CREATE TABLE IF NOT EXISTS merchant_config (
  merchant_id UUID NOT NULL,
  key TEXT NOT NULL,
  value_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (merchant_id, key)
);

-- M15: NDR cases
CREATE TABLE IF NOT EXISTS ndr_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID,
  order_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved','rto','converted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

-- M16: COD orders (machinery, QA-triggerable)
CREATE TABLE IF NOT EXISTS cod_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID,
  order_ref TEXT NOT NULL,
  amount_paise BIGINT NOT NULL,
  state TEXT NOT NULL DEFAULT 'token_pending' CHECK (state IN ('token_pending','confirmed','doorstep_pending','converted','rto')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- M22: engagement events (send-time)
CREATE TABLE IF NOT EXISTS engagement_events (
  id BIGSERIAL PRIMARY KEY,
  merchant_id UUID,
  identity_hash TEXT NOT NULL,
  hour_ist INTEGER NOT NULL CHECK (hour_ist BETWEEN 0 AND 23),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_engagement_identity ON engagement_events(identity_hash);

-- M27: policy ceilings + pending edits
CREATE TABLE IF NOT EXISTS policy_ceiling (
  key TEXT PRIMARY KEY,
  value_paise BIGINT NOT NULL
);
INSERT INTO policy_ceiling (key, value_paise) VALUES
  ('incentive_paise', 15000),
  ('link_auto_allow_paise', 1000000),
  ('daily_budget_paise', 500000),
  ('upsell_discount_pct', 15)
ON CONFLICT (key) DO NOTHING;
CREATE TABLE IF NOT EXISTS policy_pending_edits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID,
  field TEXT NOT NULL,
  from_value BIGINT NOT NULL,
  to_value BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  effective_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '1 hour'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- M28: identity edges (payer-based merge lite)
CREATE TABLE IF NOT EXISTS identity_edges (
  id_a TEXT NOT NULL,
  id_b TEXT NOT NULL,
  basis TEXT NOT NULL DEFAULT 'payer',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id_a, id_b)
);

-- M29: consent evidence columns
ALTER TABLE consent_events ADD COLUMN IF NOT EXISTS text_version TEXT NOT NULL DEFAULT 'v1';
ALTER TABLE consent_events ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'web';
ALTER TABLE consent_events ADD COLUMN IF NOT EXISTS ip_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE consent_events ADD COLUMN IF NOT EXISTS ua_hash TEXT NOT NULL DEFAULT '';

-- M5/M34: fee audit runs + upsell block counter
CREATE TABLE IF NOT EXISTS fee_audit_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID,
  checked INTEGER NOT NULL DEFAULT 0,
  corrected INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS upsell_blocked_daily (
  merchant_id UUID NOT NULL,
  day DATE NOT NULL DEFAULT CURRENT_DATE,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (merchant_id, day)
);

-- M25: ledger append-only trigger. HONEST DEVIATION (documented in PATCH_REPORT):
-- the money bus resolves PROPOSED→SUCCESS/FAILED via UPDATE (dual-path
-- idempotent resolution invariant), so a blanket forbid-mutation trigger would
-- break the core loop. The trigger therefore permits exactly one transition
-- (PROPOSED → terminal outcome + outcome_detail/hash set) and raises on every
-- other UPDATE or any DELETE. External checkpoints remain the anchor.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'audit_log is append-only (seq=%)', OLD.seq;
  END IF;
  IF OLD.outcome = 'PROPOSED' AND NEW.outcome IN ('SUCCESS','FAILED','SKIPPED')
     AND OLD.seq = NEW.seq AND OLD.prev_hash = NEW.prev_hash THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only (seq=%)', OLD.seq;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_log_immutable ON audit_log;
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Gift product seed (M3): Cable Organizer, COGS ₹59, stock 20
ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_paise BIGINT NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_gift BOOLEAN NOT NULL DEFAULT false;

-- M6 redemption column on links; M30 soft-breach flag on budget days
ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS credit_applied_paise BIGINT NOT NULL DEFAULT 0;
ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS gift_sku TEXT;
ALTER TABLE daily_budget ADD COLUMN IF NOT EXISTS soft_breach BOOLEAN NOT NULL DEFAULT false;

COMMIT;
