-- MMM gateway — 004: Agent Browser tasks, timeline and evidence
--
-- The browser automation engine is pluggable (see apps/gateway/src/browser/). What is stored here is
-- the part that must survive a restart: the task, its deadline and budgets, the checkpoint needed to
-- resume it, a step-by-step timeline that explains what happened, and the evidence behind every
-- milestone the agent claims. A task is never marked completed without a verified evidence row.

CREATE TABLE IF NOT EXISTS browser_tasks (
  id                        TEXT PRIMARY KEY,
  owner_id                  TEXT NOT NULL DEFAULT 'system',
  objective                 TEXT NOT NULL,
  success_criteria          TEXT NOT NULL DEFAULT '[]',   -- JSON [{ key, expect, describe }]
  entry_url                 TEXT NOT NULL DEFAULT '',
  plan                      TEXT NOT NULL DEFAULT '[]',   -- JSON step list
  sim                       TEXT NOT NULL DEFAULT '{}',   -- JSON script for the simulated driver (tests)
  driver                    TEXT NOT NULL DEFAULT 'auto',
  status                    TEXT NOT NULL DEFAULT 'queued',
  deadline_at               INTEGER,
  started_at                INTEGER,
  ended_at                  INTEGER,
  last_progress_at          INTEGER,
  last_success_at           INTEGER,
  last_milestone            TEXT NOT NULL DEFAULT '',
  current_url               TEXT NOT NULL DEFAULT '',
  step_index                INTEGER NOT NULL DEFAULT 0,
  step_attempts             INTEGER NOT NULL DEFAULT 0,
  consecutive_failures      INTEGER NOT NULL DEFAULT 0,
  retries_used              INTEGER NOT NULL DEFAULT 0,
  max_retries               INTEGER NOT NULL DEFAULT 8,
  max_consecutive_failures  INTEGER NOT NULL DEFAULT 3,
  actions_used              INTEGER NOT NULL DEFAULT 0,
  max_actions               INTEGER NOT NULL DEFAULT 120,
  evidence_bytes            INTEGER NOT NULL DEFAULT 0,
  max_evidence_bytes        INTEGER NOT NULL DEFAULT 4194304,
  blocker                   TEXT,
  blocker_kind              TEXT,
  outcome                   TEXT NOT NULL DEFAULT '',
  checkpoint                TEXT NOT NULL DEFAULT '{}',
  recovery_log              TEXT NOT NULL DEFAULT '[]',
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_browser_tasks_status ON browser_tasks(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_browser_tasks_owner  ON browser_tasks(owner_id, created_at DESC);

-- One row per thing that happened, in order. This is what the user reads when they come back after
-- several hours: it must answer "what did it accomplish, what remains, and why did it stop".
CREATE TABLE IF NOT EXISTS browser_steps (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES browser_tasks(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'info',
  detail      TEXT NOT NULL DEFAULT '',
  url         TEXT NOT NULL DEFAULT '',
  step_id     TEXT NOT NULL DEFAULT '',
  attempt     INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  evidence_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_browser_steps_task ON browser_steps(task_id, seq);

-- Observations the agent actually made. `summary` is a human sentence, `digest` is a hash over the
-- observation so two "milestones" cannot have identical evidence, and `data` holds the artefact
-- (screenshot base64 or accessibility snapshot JSON), capped in size.
CREATE TABLE IF NOT EXISTS browser_evidence (
  id        TEXT PRIMARY KEY,
  task_id   TEXT NOT NULL REFERENCES browser_tasks(id) ON DELETE CASCADE,
  step_id   TEXT NOT NULL DEFAULT '',
  ts        INTEGER NOT NULL,
  kind      TEXT NOT NULL,                 -- screenshot | snapshot | extract | assertion | http
  label     TEXT NOT NULL DEFAULT '',
  summary   TEXT NOT NULL DEFAULT '',
  url       TEXT NOT NULL DEFAULT '',
  digest    TEXT NOT NULL DEFAULT '',
  bytes     INTEGER NOT NULL DEFAULT 0,
  data      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_browser_evidence_task ON browser_evidence(task_id, ts);
