-- 008_v4_1.sql: C2 consent evidence + C3 external references + C5 cancel_failed status

BEGIN;

-- C2: Consent events with evidence
CREATE TABLE IF NOT EXISTS consent_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES customers(id),
  consent_type TEXT NOT NULL CHECK (consent_type IN ('transactional', 'marketing')),
  opt_in BOOLEAN NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('merchant_server', 'self_reported', 'checkout_notice')),
  evidence_reference TEXT NOT NULL,
  merchant_id UUID REFERENCES merchants(id),
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

-- C2: Index for consent evidence lookups (whichever shape this database
-- carries: canonical class/created_at, or legacy consent_type/recorded_at).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'consent_events' AND column_name = 'class') THEN
    CREATE INDEX IF NOT EXISTS idx_consent_events_customer ON consent_events (customer_id, class, created_at DESC);
  ELSE
    CREATE INDEX IF NOT EXISTS idx_consent_events_customer ON consent_events (customer_id, consent_type, recorded_at DESC);
  END IF;
END $$;

-- C3: External reference mapping (HMAC-based, one-way)
CREATE TABLE IF NOT EXISTS ext_ref_map (
  ext_ref TEXT PRIMARY KEY,
  audit_seq INTEGER NOT NULL UNIQUE REFERENCES audit_log(seq),
  context TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- C3: Index for reconciliation lookups
CREATE INDEX IF NOT EXISTS idx_ext_ref_map_audit_seq ON ext_ref_map (audit_seq);

-- C5: Add cancel_failed status to open_links (migration already has this, but ensure)
ALTER TABLE open_links DROP CONSTRAINT IF EXISTS open_links_status_check;
ALTER TABLE open_links ADD CONSTRAINT open_links_status_check
  CHECK (status IN ('active', 'cancelled', 'expired', 'converted', 'cancel_failed'));

-- C4: Add re-enqueued status to webhook_events
ALTER TABLE webhook_events DROP CONSTRAINT IF EXISTS webhook_events_status_check;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_status_check
  CHECK (status IN ('received', 'processing', 'processed', 'failed', 're-enqueued'));

-- C1: Add consent_class to policy_audit
ALTER TABLE policy_audit ADD COLUMN IF NOT EXISTS consent_class TEXT;
ALTER TABLE policy_audit ADD COLUMN IF NOT EXISTS clamp_applied BOOLEAN DEFAULT FALSE;
ALTER TABLE policy_audit ADD COLUMN IF NOT EXISTS clamp_reason TEXT;

COMMIT;
