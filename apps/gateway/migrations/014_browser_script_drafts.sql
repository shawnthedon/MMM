-- Browser script drafts (M32/unit 4) — a conversation writes a script, an approval runs it.
--
-- A browser script in MMM is the body `POST /api/v1/browser/tasks` already accepts. This table is the
-- draft half of that: a script nobody has approved yet. It is separate from `agent_drafts` and
-- `swarm_plan_drafts` for the same reason those are separate from each other — activation does something
-- different in each case, and one table with a `kind` column would mean one route guessing which act it
-- is performing from the shape of a row.
--
-- Here activation *is* execution: it calls `browserRunner.createTask`, which queues a real task on the
-- gateway. That is why a script with no available engine is `blocked` and cannot be submitted at all.
--
--   state       one of DRAFT_ONLY_STATES in packages/shared/agentDraft.js, recomputed on every write
--   script      the canonical script (packages/shared/browserScript.js), never trusted from a client
--   findings    the validator's output at the last write
--   approval_id the approvals row that gates the run; NULL until submitted
--   task_id     the browser_tasks row created by activation, set once
--
-- No `status`, `progress` or `evidence` column: those belong to `browser_tasks` / `browser_evidence`, and
-- the draft reads them live rather than copying a number that would go stale.

CREATE TABLE IF NOT EXISTS browser_script_drafts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'copilot',        -- copilot | api
  state TEXT NOT NULL DEFAULT 'draft',
  script TEXT NOT NULL DEFAULT '{}',
  findings TEXT NOT NULL DEFAULT '[]',
  approval_id TEXT,
  task_id TEXT,
  model_call_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  submitted_at INTEGER,
  activated_at INTEGER,
  archived_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_browser_script_drafts_owner ON browser_script_drafts(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_browser_script_drafts_state ON browser_script_drafts(state);
