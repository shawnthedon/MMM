-- 008 — a terminal that executes real processes on the gateway host.
--
-- The tables exist so that execution is *reviewable*: what ran, where, as whom, with which exit
-- code, and whether it came from a person or an agent. Output lives here as a bounded tail so the
-- audit trail can answer "what did it say?" without keeping an unbounded log in SQLite.
--
-- Nothing here stores a secret: `env_keys` is the *names* of session environment variables, never
-- their values (those stay in process memory for the life of the session).

CREATE TABLE IF NOT EXISTS terminal_workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_id TEXT NOT NULL,
  rel_path TEXT NOT NULL DEFAULT '.',
  description TEXT NOT NULL DEFAULT '',
  trusted INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS terminal_sessions (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  cwd TEXT NOT NULL DEFAULT '.',
  env_keys TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_terminal_sessions_principal ON terminal_sessions(principal_id);

CREATE TABLE IF NOT EXISTS terminal_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  principal_id TEXT NOT NULL,
  agent_id TEXT NOT NULL DEFAULT '',
  command TEXT NOT NULL,
  argv TEXT NOT NULL DEFAULT '[]',
  cwd TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  exit_code INTEGER,
  signal TEXT,
  approval_id TEXT,
  destructive INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_ms INTEGER,
  output_bytes INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  stdout_tail TEXT NOT NULL DEFAULT '',
  stderr_tail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_terminal_runs_session ON terminal_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_terminal_runs_started ON terminal_runs(started_at);

-- Agents are not implicitly trusted with a shell. A grant names the agent and the workspace it may
-- run in; without one, an agent token holding terminal:run is still refused.
CREATE TABLE IF NOT EXISTS terminal_agent_grants (
  agent_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  granted_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (agent_id, workspace_id)
);
