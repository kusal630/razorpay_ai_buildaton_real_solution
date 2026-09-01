-- P1: Write-ahead action intents for deduplication
-- Ensures exactly-once agent actions even across crashes

CREATE TABLE IF NOT EXISTS action_intents (
  id BIGSERIAL PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  customer_id UUID,
  action_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  window_start TIMESTAMPTZ,
  window_end TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','executing','done','skipped','stuck')),
  audit_seq BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_action_intents_dedupe ON action_intents(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_action_intents_status ON action_intents(status);
CREATE INDEX IF NOT EXISTS idx_action_intents_customer ON action_intents(customer_id, action_type);
