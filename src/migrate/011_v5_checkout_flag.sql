-- 011_v5_checkout_flag.sql: persist the checkout-start event (M2 segment split).
-- The /checkout-start track route records it; RecoveryBot segments on it.
BEGIN;
ALTER TABLE carts ADD COLUMN IF NOT EXISTS checkout_started_at TIMESTAMPTZ;
COMMIT;
