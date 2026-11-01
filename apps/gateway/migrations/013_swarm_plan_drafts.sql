-- Swarm-plan drafts (M32) — unit 3 of the Copilot upgrade.
--
-- A workflow in MMM is a swarm plan. This table is the *draft* half of that: a plan a person has not yet
-- asked anyone to approve. It is a separate table from `agent_drafts` on purpose — an agent draft's
-- activation runs code (`insertAgent`), a plan draft's activation writes a `swarms` row, and giving two
-- different acts one table would mean one route deciding which act it is doing from the shape of a row.
--
-- One consequence, stated here so nobody has to discover it: activating a plan draft while it is
-- already active is a conflict, and the gateway re-runs the validator before it saves, so an approval of
-- a plan that has since become invalid cannot store it.
--
--   kind        always 'swarm-plan'; the drafts list is one list for several artefacts
--   state       one of DRAFT_ONLY_STATES in packages/shared/agentDraft.js, recomputed on every write
--   plan        the canonical plan (packages/shared/swarmPlanDraft.js), never trusted from a client
--   findings    the validator's output at the last write
--   approval_id the approvals row that gates saving; NULL until submitted
--   swarm_id    set only by activation, and only once
--
-- No `executed`, `progress` or `status` column: those live on `swarms`, and this build never sets them
-- to anything but planned/0.


CREATE TABLE IF NOT EXISTS swarm_plan_drafts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'swarm-plan',
  source TEXT NOT NULL DEFAULT 'copilot',        -- copilot | api
  state TEXT NOT NULL DEFAULT 'draft',
  plan TEXT NOT NULL DEFAULT '{}',
  findings TEXT NOT NULL DEFAULT '[]',
  approval_id TEXT,
  swarm_id TEXT,
  model_call_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  submitted_at INTEGER,
  activated_at INTEGER,
  archived_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_swarm_plan_drafts_owner ON swarm_plan_drafts(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_swarm_plan_drafts_state ON swarm_plan_drafts(state);

