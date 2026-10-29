-- MMM gateway — 002: identity & access (RBAC, sessions, capability tokens)
-- Adds credential columns to principals and the two auth tables. Existing rows keep working:
-- principals without an email/password simply cannot log in until an Owner sets credentials.

ALTER TABLE principals ADD COLUMN email TEXT;
ALTER TABLE principals ADD COLUMN password_hash TEXT;
ALTER TABLE principals ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE principals ADD COLUMN last_login_at INTEGER;
ALTER TABLE principals ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE principals ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
ALTER TABLE principals ADD COLUMN created_by TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_principals_email ON principals(email) WHERE email IS NOT NULL;

-- Server-side sessions. Only the SHA-256 of the bearer secret is stored.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_reason TEXT,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (principal_id) REFERENCES principals(id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_principal ON sessions(principal_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- Scoped API tokens for CLI / bots / integrations. Only the hash and a display prefix persist.
CREATE TABLE IF NOT EXISTS capability_tokens (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL DEFAULT '',
  scopes_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  created_by TEXT,
  expires_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER,
  revoked_by TEXT,
  FOREIGN KEY (principal_id) REFERENCES principals(id)
);
CREATE INDEX IF NOT EXISTS idx_tokens_principal ON capability_tokens(principal_id);

-- Failed/successful authentication attempts, used for lockout and abuse review.
CREATE TABLE IF NOT EXISTS auth_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  identifier TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_ts ON auth_attempts(ts);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_identifier ON auth_attempts(identifier, ts);
