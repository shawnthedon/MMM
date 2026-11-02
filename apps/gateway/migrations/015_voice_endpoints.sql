-- Voice endpoints (M34) — unit 5 of the Copilot upgrade: open-source voice, local first.
--
-- A speech endpoint is a *host* the gateway is allowed to talk to. It lives on the gateway rather than in
-- browser settings for three reasons that all come down to the same one — audio is the most sensitive
-- payload this app handles:
--
--   • an HTTPS-hosted PWA cannot POST a microphone clip to a plain-http LAN host (mixed content), but the
--     gateway can, because the gateway is the thing sitting next to the speech host;
--   • an endpoint is a capability, so it is permissioned (owner) and audited like one;
--   • the browser never needs to know the host's address, so it cannot be tricked into sending audio
--     somewhere else by a modified client.
--
-- What is deliberately absent: there is no column for audio, no column for a transcript, and no history
-- table. A transcription is returned to the caller and forgotten; the audit row records the shape of the
-- request (bytes, duration, engine, outcome), never what was said.
--
--   kind       'stt' | 'tts' — one row serves one role
--   mode       'whisper.cpp' (POST /inference) | 'openai' (POST /v1/audio/transcriptions); '' for tts
--   url        loopback by default, https-only when remote hosts are enabled
--   enabled    0 rows are kept and readable, and are never chosen
--   last_*     the most recent health probe, so the screen can say "checked 2 minutes ago" honestly

CREATE TABLE IF NOT EXISTS voice_endpoints (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'stt',
  mode TEXT NOT NULL DEFAULT 'whisper.cpp',
  engine TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  remote INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_checked_at INTEGER,
  last_status TEXT NOT NULL DEFAULT '',
  last_detail TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_voice_endpoints_kind ON voice_endpoints(kind, enabled, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_endpoints_url ON voice_endpoints(kind, url);
