-- SwarmOS gateway — 003: comms channels, messages and settings
-- Credentials move server-side: only an AES-256-GCM ciphertext is stored, and the API never returns
-- a secret back to the browser (masked last-4 only). Channel definitions live in src/commsChannels.js
-- and are shared by the browser panel and this table's validation.

CREATE TABLE IF NOT EXISTS comms_channels (
  channel TEXT PRIMARY KEY,
  workspace TEXT NOT NULL DEFAULT 'default',
  config_ciphertext TEXT NOT NULL DEFAULT '',
  config_fields TEXT NOT NULL DEFAULT '[]',       -- names of stored fields (never their values)
  enabled INTEGER NOT NULL DEFAULT 0,
  routing_json TEXT NOT NULL DEFAULT '{"copilot":true,"agents":[]}',
  verified_at INTEGER,
  last_test_json TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL DEFAULT ''
);

-- One row per outbound attempt (queued → sent | failed) and per inbound delivery.
CREATE TABLE IF NOT EXISTS comms_messages (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  channel TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  body_redacted TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('queued','sent','failed','received','rejected','deferred')),
  reason TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  provider_status INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  dedupe_key TEXT,
  created_by TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_comms_messages_dedupe ON comms_messages(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comms_messages_ts ON comms_messages(ts DESC);
CREATE INDEX IF NOT EXISTS idx_comms_messages_channel ON comms_messages(channel, ts DESC);
CREATE INDEX IF NOT EXISTS idx_comms_messages_due ON comms_messages(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS comms_settings (
  workspace TEXT PRIMARY KEY,
  quiet_hours TEXT NOT NULL DEFAULT '',
  rate_limit_per_min INTEGER NOT NULL DEFAULT 20,
  retry_limit INTEGER NOT NULL DEFAULT 3,
  commands_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL DEFAULT ''
);
