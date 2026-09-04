-- 003_experiments.sql (v5.1 repair): holdout experiment layer.
-- REPAIRED: the original created experiments(id TEXT) + TEXT FKs, which
-- conflicts with the canonical experiments(id UUID, charter JSONB) shape the
-- code reads. This file now creates the canonical shapes idempotently.
-- (The original never applied successfully anywhere, so no backfill needed.)

CREATE TABLE IF NOT EXISTS experiments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID,
  charter JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cohort assignments: supports both the legacy (cart_id) and current
-- (merchant_id, customer_id) write shapes; each scoped unique.
CREATE TABLE IF NOT EXISTS cohort_assignments (
  merchant_id UUID,
  customer_id UUID,
  cart_id TEXT,
  experiment_id UUID NOT NULL,
  arm TEXT NOT NULL CHECK (arm IN ('treatment', 'control')),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Backfill columns on out-of-band tables that predate this file.
ALTER TABLE cohort_assignments ADD COLUMN IF NOT EXISTS merchant_id UUID;
ALTER TABLE cohort_assignments ADD COLUMN IF NOT EXISTS customer_id UUID;
ALTER TABLE cohort_assignments ADD COLUMN IF NOT EXISTS cart_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cohort_customer_exp
  ON cohort_assignments (customer_id, experiment_id) WHERE customer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cohort_cart_exp
  ON cohort_assignments (cart_id, experiment_id) WHERE cart_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS experiment_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id UUID NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  treatment_attempts INTEGER NOT NULL DEFAULT 0,
  treatment_successes INTEGER NOT NULL DEFAULT 0,
  control_attempts INTEGER NOT NULL DEFAULT 0,
  control_successes INTEGER NOT NULL DEFAULT 0,
  incremental_revenue_paise BIGINT NOT NULL DEFAULT 0,
  incremental_gross_profit_paise BIGINT NOT NULL DEFAULT 0,
  roas NUMERIC,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb
);
