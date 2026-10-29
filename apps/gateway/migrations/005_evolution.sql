-- MMM gateway — 005: autonomous self-modification, experiments, versions and rollback
--
-- Self-modification is a controlled capability, not a command. What is stored here is the whole
-- cycle so it can be reviewed and reproduced: who observed what, what was proposed, which files the
-- candidate touched, the test evidence, the peer review, the comparison against the last known-good
-- version, the approval, the deployment and any rollback.
--
-- Nothing here lets an agent write the live source tree. An experiment owns an isolated workspace
-- under DATA_DIR/experiments/<id>/; a promotion publishes a version under DATA_DIR/runtime/…; the
-- previous version stays intact so a rollback is a pointer move, not a rewrite.

CREATE TABLE IF NOT EXISTS evolution_policies (
  agent_id                TEXT PRIMARY KEY,
  enabled                 INTEGER NOT NULL DEFAULT 1,
  level                   INTEGER NOT NULL DEFAULT 1,      -- 1 recommend … 5 supervised continuous
  scope                   TEXT NOT NULL DEFAULT '[]',      -- JSON glob list the agent may edit
  allow_tests             INTEGER NOT NULL DEFAULT 1,
  allow_auto_stage        INTEGER NOT NULL DEFAULT 0,
  allow_auto_deploy       INTEGER NOT NULL DEFAULT 0,
  require_reviews         INTEGER NOT NULL DEFAULT 1,
  health_check            TEXT NOT NULL DEFAULT '',         -- JSON { command }
  max_experiments_per_day INTEGER NOT NULL DEFAULT 5,
  max_test_runs           INTEGER NOT NULL DEFAULT 4,
  max_runtime_ms          INTEGER NOT NULL DEFAULT 120000,
  updated_by              TEXT NOT NULL DEFAULT 'system',
  updated_at              INTEGER NOT NULL
);

-- Cross-agent access is granted explicitly, by a principal, with an expiry and an audit record.
CREATE TABLE IF NOT EXISTS evolution_grants (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,        -- the agent doing the work
  owner_agent_id TEXT NOT NULL,       -- the agent whose code is in scope ('*' = platform code)
  scope         TEXT NOT NULL DEFAULT '[]',
  reason        TEXT NOT NULL DEFAULT '',
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER,
  revoked_at    INTEGER
);

CREATE TABLE IF NOT EXISTS evolution_observations (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  source      TEXT NOT NULL,          -- task-failure | test-failure | retry | user-correction | peer-review | metric
  kind        TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT '',
  evidence    TEXT NOT NULL DEFAULT '{}',
  measured    INTEGER NOT NULL DEFAULT 1,   -- 0 = assumption, never used as a justification
  created_by  TEXT NOT NULL DEFAULT 'system',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS evolution_experiments (
  id                  TEXT PRIMARY KEY,
  agent_id            TEXT NOT NULL,
  title               TEXT NOT NULL,
  problem             TEXT NOT NULL,
  objective           TEXT NOT NULL DEFAULT '',
  observation_ids     TEXT NOT NULL DEFAULT '[]',
  diagnosis           TEXT NOT NULL DEFAULT '{}',
  plan                TEXT NOT NULL DEFAULT '{}',
  status              TEXT NOT NULL DEFAULT 'proposed',
  level               INTEGER NOT NULL DEFAULT 1,
  risk                TEXT NOT NULL DEFAULT 'unknown',
  base_version        TEXT NOT NULL DEFAULT '',
  workspace           TEXT NOT NULL DEFAULT '',
  files               TEXT NOT NULL DEFAULT '[]',   -- candidate file list + change record
  changes             TEXT NOT NULL DEFAULT '{}',
  diff                TEXT NOT NULL DEFAULT '',
  diff_lines          INTEGER NOT NULL DEFAULT 0,
  tests               TEXT NOT NULL DEFAULT '{}',
  test_runs           INTEGER NOT NULL DEFAULT 0,
  integrity           TEXT NOT NULL DEFAULT '{}',
  review_required     INTEGER NOT NULL DEFAULT 0,
  reviews             TEXT NOT NULL DEFAULT '[]',
  compare             TEXT NOT NULL DEFAULT '{}',
  approval            TEXT NOT NULL DEFAULT '{}',
  blocker             TEXT NOT NULL DEFAULT '',
  version_id          TEXT NOT NULL DEFAULT '',
  created_by          TEXT NOT NULL DEFAULT 'system',
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  ended_at            INTEGER
);

CREATE TABLE IF NOT EXISTS evolution_events (
  id            TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  ts            INTEGER NOT NULL,
  stage         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'info',
  actor         TEXT NOT NULL DEFAULT 'system',
  detail        TEXT NOT NULL DEFAULT '',
  data          TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS evolution_reviews (
  id            TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  reviewer      TEXT NOT NULL,        -- agent id or principal id
  reviewer_kind TEXT NOT NULL DEFAULT 'agent',
  verdict       TEXT NOT NULL,        -- approve | changes-required | reject
  findings      TEXT NOT NULL DEFAULT '[]',
  independent   INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS evolution_versions (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  experiment_id TEXT NOT NULL DEFAULT '',
  version       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'candidate',  -- candidate | staged | deployed | superseded | rolled_back
  path          TEXT NOT NULL DEFAULT '',
  files_hash    TEXT NOT NULL DEFAULT '',
  files         TEXT NOT NULL DEFAULT '[]',
  evidence      TEXT NOT NULL DEFAULT '{}',
  health        TEXT NOT NULL DEFAULT '{}',
  created_by    TEXT NOT NULL DEFAULT 'system',
  created_at    INTEGER NOT NULL,
  deployed_at   INTEGER,
  rolled_back_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_evo_exp_agent ON evolution_experiments (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evo_events_exp ON evolution_events (experiment_id, seq);
CREATE INDEX IF NOT EXISTS idx_evo_versions_agent ON evolution_versions (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evo_obs_agent ON evolution_observations (agent_id, created_at DESC);
