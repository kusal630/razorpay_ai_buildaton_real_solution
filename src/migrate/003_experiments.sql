-- P2: Holdout experiment layer
-- Deterministic cohort assignment for incrementality measurement

CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  workflow TEXT NOT NULL,
  baseline_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  target_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  owner TEXT NOT NULL,
  limits_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  stop_rules_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','paused','completed','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cohort_assignments (
  cart_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL REFERENCES experiments(id),
  arm TEXT NOT NULL CHECK (arm IN ('treatment','control')),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cart_id, experiment_id)
);

CREATE TABLE IF NOT EXISTS experiment_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id TEXT NOT NULL REFERENCES experiments(id),
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
