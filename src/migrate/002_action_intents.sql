-- P1: Write-ahead action intents for deduplication
-- Ensures exactly-once agent actions even across crashes.
-- (v5.1 repair: canonical shape — UUID ids, full lifecycle columns and
-- status set. Older revisions of this file defined a narrower table that the
-- code outgrew; IF NOT EXISTS keeps deployed databases untouched.)

CREATE TABLE IF NOT EXISTS action_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  dedupe_key TEXT NOT NULL UNIQUE,
  customer_id UUID REFERENCES customers(id),
  target_type TEXT NOT NULL DEFAULT 'cart',
  target_id TEXT NOT NULL DEFAULT '',
  action_type TEXT NOT NULL,
  window_day TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'deferred', 'executing', 'awaiting_gateway', 'done',
    'skipped', 'blocked', 'failed', 'expired', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  resume_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_action_intents_dedupe ON action_intents(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_action_intents_status ON action_intents(status);
CREATE INDEX IF NOT EXISTS idx_action_intents_customer ON action_intents(customer_id, action_type);
