-- MMM gateway — 006: team membership lives on the agent row
--
-- Until now membership lived in `team_members(team_id, agent_id)`, a second copy of a fact that the
-- agent row already has to imply. Two copies drift: a team could list an agent that the agent row did
-- not know about, and deleting a team either cascaded the agent away with it or silently re-homed it.
-- Membership is now a column on `agents`, so every view — the team menu, the agent panel, the grid,
-- the designer — reads one value.
--
-- The legacy table is backfilled and then removed. `agents.team_id` is a real foreign key with
-- ON DELETE SET NULL, and the delete route clears it explicitly inside a transaction, so the intent is
-- visible in the code as well as the schema.

ALTER TABLE agents ADD COLUMN team_id TEXT REFERENCES teams(id) ON DELETE SET NULL;
ALTER TABLE agents ADD COLUMN team_position INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN goal TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN responsibilities TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agents ADD COLUMN approval_gates TEXT NOT NULL DEFAULT '{}';
ALTER TABLE teams ADD COLUMN description TEXT NOT NULL DEFAULT '';

-- Backfill from the legacy join table before it goes.
UPDATE agents
   SET team_id = (SELECT m.team_id FROM team_members m WHERE m.agent_id = agents.id ORDER BY m.team_id LIMIT 1)
 WHERE team_id IS NULL
   AND EXISTS (SELECT 1 FROM team_members m WHERE m.agent_id = agents.id);

-- Dense, deterministic positions inside each team (1-based), so a slider can say "n of m".
UPDATE agents
   SET team_position = (
     SELECT COUNT(*) FROM agents a2
      WHERE a2.team_id = agents.team_id
        AND a2.id < agents.id
   )
 WHERE team_id IS NOT NULL;

DROP TABLE IF EXISTS team_members;
