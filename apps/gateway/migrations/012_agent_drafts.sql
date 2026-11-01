-- Agent drafts (M31).
--
-- A draft is a definition that has not been activated. It is a row rather than a JSON blob in the
-- browser because the whole point is that it survives a reload, belongs to a person, and can be shown to
-- someone else for approval — none of which a localStorage string can do honestly.
--
--   state       one of the DRAFT_ONLY_STATES in packages/shared/agentDraft.js, recomputed on every write
--   spec        the canonical draft (packages/shared/agentDraft.js), never trusted from the client as-is
--   findings    the validator's output at the last write, so a stale "ready" cannot survive an edit
--   approval_id the approvals row that gates activation; NULL until submitted
--   agent_id    set only by activation, and only once
--
-- There is no `activated_by` column: activation is audited, and an audit trail that can be edited is not
-- an audit trail.

CREATE TABLE IF NOT EXISTS agent_drafts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'copilot',        -- copilot | designer | api
  state TEXT NOT NULL DEFAULT 'draft',
  spec TEXT NOT NULL DEFAULT '{}',
  findings TEXT NOT NULL DEFAULT '[]',
  approval_id TEXT,
  agent_id TEXT,
  model_call_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  submitted_at INTEGER,
  activated_at INTEGER,
  archived_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agent_drafts_owner ON agent_drafts(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_drafts_state ON agent_drafts(state);
