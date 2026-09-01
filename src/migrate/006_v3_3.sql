-- W5: Identity token + ingestion integrity
-- W2: Intent lifecycle v2 with lease fields
-- W4: Action class support
-- W7: Link lifecycle (open_links)
-- W9: Refunds + margin snapshots
-- W10: Policy versions, notification outbox

-- W5: Identity token on customers
ALTER TABLE customers ADD COLUMN IF NOT EXISTS identity_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_identity_token ON customers(identity_token) WHERE identity_token IS NOT NULL;

-- W5: Normalize email/phone before identity creation
-- identity_token = HMAC(secret, normalize(contact))

-- W2: Intent lifecycle v2 - extend action_intents
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS lease_owner TEXT;
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 3;
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS resume_at TIMESTAMPTZ;
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS margin_snapshot_paise BIGINT NOT NULL DEFAULT 0;
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS idempotency_hash TEXT;

-- W2: Expand status check constraint
ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_status_check;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_status_check
  CHECK (status IN ('proposed','deferred','pending','executing','awaiting_gateway','done','skipped','blocked','failed','expired','stuck'));

-- W2: Notification outbox
CREATE TABLE IF NOT EXISTS notification_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id BIGINT NOT NULL REFERENCES action_intents(id),
  channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  payload_hash TEXT NOT NULL,
  message_version INTEGER NOT NULL DEFAULT 1,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(intent_id, channel, message_version)
);

-- W7: Open payment links tracking
CREATE TABLE IF NOT EXISTS open_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_link_id TEXT NOT NULL,
  cart_id TEXT,
  customer_id UUID REFERENCES customers(id),
  merchant_id UUID NOT NULL,
  amount_paise BIGINT NOT NULL,
  incentive_paise BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled','converted','expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ
);

-- W9: Refunds tracking
CREATE TABLE IF NOT EXISTS refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id TEXT NOT NULL,
  payment_link_id TEXT,
  refund_id TEXT NOT NULL,
  amount_paise BIGINT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processed','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

-- W9: Margin snapshots on intents
-- (margin_snapshot_paise already added to action_intents above)

-- W10: Policy versions
CREATE TABLE IF NOT EXISTS policy_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version TEXT NOT NULL,
  rules_json JSONB NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ
);

-- W10: Idempotency payload hash
ALTER TABLE idempotency ADD COLUMN IF NOT EXISTS payload_hash TEXT;

-- W10: Retention legal holds
ALTER TABLE customers ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT false;
