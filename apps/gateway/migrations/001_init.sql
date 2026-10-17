-- SwarmOS gateway — initial schema (see docs/DESIGN_SPEC.md §19)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('user','agent','copilot','bot')),
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Operator',
  trust INTEGER NOT NULL DEFAULT 50,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  framework TEXT NOT NULL,
  framework_config TEXT NOT NULL DEFAULT '{}',
  model TEXT NOT NULL,
  fallback TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idle',
  trust INTEGER NOT NULL DEFAULT 50,
  autonomy INTEGER NOT NULL DEFAULT 2,
  success_rate REAL NOT NULL DEFAULT 0.85,
  cost_today REAL NOT NULL DEFAULT 0,
  runs INTEGER NOT NULL DEFAULT 0,
  last_active INTEGER NOT NULL,
  tools TEXT NOT NULL DEFAULT '[]',
  skills TEXT NOT NULL DEFAULT '[]',
  prompt TEXT NOT NULL DEFAULT '',
  memory TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT 'system',
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  topology TEXT NOT NULL DEFAULT 'Hierarchical',
  config TEXT NOT NULL DEFAULT '{}',
  health TEXT NOT NULL DEFAULT 'good',
  created_by TEXT NOT NULL DEFAULT 'system'
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (team_id, agent_id)
);

CREATE TABLE IF NOT EXISTS swarms (
  id TEXT PRIMARY KEY,
  team_id TEXT REFERENCES teams(id),
  name TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  progress REAL NOT NULL DEFAULT 0,
  budget TEXT NOT NULL DEFAULT '{}',
  nodes TEXT NOT NULL DEFAULT '[]',
  channel TEXT NOT NULL DEFAULT 'app',
  started_at INTEGER NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'system'
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  swarm_id TEXT REFERENCES swarms(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  column_name TEXT NOT NULL DEFAULT 'todo',
  assignee TEXT REFERENCES agents(id),
  priority TEXT NOT NULL DEFAULT 'med',
  deps TEXT NOT NULL DEFAULT '[]',
  cost_actual REAL NOT NULL DEFAULT 0,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  risk TEXT NOT NULL DEFAULT 'medium',
  principal TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  decider_id TEXT,
  decided_at INTEGER,
  expires_at INTEGER,
  policy_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  entity TEXT NOT NULL DEFAULT '',
  cursor INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_cursor ON events(cursor);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '0.1.0',
  origin TEXT NOT NULL DEFAULT 'marketplace',
  status TEXT NOT NULL DEFAULT 'active',
  perms TEXT NOT NULL DEFAULT '[]',
  tools TEXT NOT NULL DEFAULT '[]',
  success REAL NOT NULL DEFAULT 1,
  invokes INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  manifest TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Custom',
  installed INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 1,
  calls_today INTEGER NOT NULL DEFAULT 0,
  scopes TEXT NOT NULL DEFAULT '[]',
  tools TEXT NOT NULL DEFAULT '[]',
  config_sealed TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'off',
  auth TEXT NOT NULL DEFAULT 'API key',
  models TEXT NOT NULL DEFAULT '[]',
  latency INTEGER NOT NULL DEFAULT 0,
  spend_mtd REAL NOT NULL DEFAULT 0,
  endpoint TEXT NOT NULL DEFAULT '',
  key_sealed TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS model_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 50,
  rules TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'direct',
  title TEXT NOT NULL,
  unread INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  from_principal TEXT NOT NULL DEFAULT 'me',
  agent TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'text',
  payload TEXT NOT NULL DEFAULT '{}',
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'txt',
  size INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT 'system',
  run_id TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'queued',
  lease_owner TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state, next_run_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seq INTEGER NOT NULL UNIQUE,
  ts INTEGER NOT NULL,
  principal_id TEXT NOT NULL DEFAULT 'system',
  actor_via TEXT NOT NULL DEFAULT 'app',
  event TEXT NOT NULL,
  args_hash TEXT NOT NULL DEFAULT '',
  args_redacted TEXT NOT NULL DEFAULT '',
  policy_decision TEXT NOT NULL DEFAULT 'allow',
  result TEXT NOT NULL DEFAULT 'ok',
  prev_hash TEXT NOT NULL DEFAULT '',
  hash TEXT NOT NULL
);
