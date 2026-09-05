-- 012_v5_abandonment_cycles.sql: T4 covariate (record now, graduate later).
BEGIN;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS abandonment_cycles INTEGER NOT NULL DEFAULT 0;
COMMIT;
