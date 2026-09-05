-- 014_v5_datamode.sql: LIVE/DEMO data-source modes + feed source tags.
-- data_mode: single row (id=true). activity.source_tag + carts.source_tag
-- drive feed badging/filtering ('demo' | 'live' | 'demo-bg' | 'system').

CREATE TABLE IF NOT EXISTS data_mode (
  id BOOLEAN PRIMARY KEY DEFAULT true,
  mode TEXT NOT NULL DEFAULT 'demo' CHECK (mode IN ('demo', 'live')),
  demo_bg_enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);
INSERT INTO data_mode (id, mode, demo_bg_enabled)
VALUES (true, 'demo', true)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE activity ADD COLUMN IF NOT EXISTS source_tag TEXT NOT NULL DEFAULT 'system';
ALTER TABLE carts ADD COLUMN IF NOT EXISTS source_tag TEXT NOT NULL DEFAULT 'demo';
