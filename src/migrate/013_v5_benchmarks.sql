-- 013_v5_benchmarks.sql: P1 industry benchmarks (survey priors, never merchant data).
BEGIN;
CREATE TABLE IF NOT EXISTS industry_benchmarks (
  industry TEXT PRIMARY KEY,
  abandonment_rate NUMERIC NOT NULL,
  recovery_rate NUMERIC NOT NULL,
  avg_cart_value NUMERIC NOT NULL,
  avg_abandoned_value NUMERIC NOT NULL,
  source TEXT NOT NULL,
  as_of DATE NOT NULL
);
INSERT INTO industry_benchmarks (industry, abandonment_rate, recovery_rate, avg_cart_value, avg_abandoned_value, source, as_of) VALUES
  ('Clothing', 0.34, 0.07, 127, 158, 'Metorik 2026 (survey)', '2026-01-15'),
  ('Electronics', 0.21, 0.10, 117, 141, 'Metorik 2026 (survey)', '2026-01-15'),
  ('Other', 0.07, 0.15, 95, 120, 'Metorik 2026 (survey)', '2026-01-15')
ON CONFLICT (industry) DO UPDATE SET
  abandonment_rate = EXCLUDED.abandonment_rate, recovery_rate = EXCLUDED.recovery_rate,
  avg_cart_value = EXCLUDED.avg_cart_value, avg_abandoned_value = EXCLUDED.avg_abandoned_value,
  source = EXCLUDED.source, as_of = EXCLUDED.as_of;
COMMIT;
