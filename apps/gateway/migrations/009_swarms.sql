-- MMM gateway — 009: swarms are records, and they say so
--
-- `swarms` has existed since 001 with a `status` column that nothing wrote and a `nodes` blob that
-- nothing read. The screen showed them as live runs, with progress and spend that came from a browser
-- timer. This migration adds the two facts that were missing:
--
--   executed   — has any process ever read this plan? In this build: never. The column exists so a
--                future scheduler can set it truthfully, and so today's default is explicit rather than
--                implied by a status string.
--   updated_at — so a list can be ordered by change without inventing a timestamp.
--
-- It also normalises what is already stored. Any row claiming to be `live`, `running` or `paused`, or
-- carrying progress or spend, was written by seed data or a browser timer — not by anything that ran.
-- Those rows are reset to `planned` with zero progress and zero spend, because a plan that never
-- executed cannot have either.

ALTER TABLE swarms ADD COLUMN executed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE swarms ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE swarms ADD COLUMN run_note TEXT NOT NULL DEFAULT '';

UPDATE swarms SET status = 'planned'
 WHERE status NOT IN ('planned', 'cancelled', 'archived');

UPDATE swarms
   SET progress = 0,
       budget = json_set(COALESCE(NULLIF(budget, ''), '{}'), '$.spent', 0),
       updated_at = started_at
 WHERE executed = 0;

UPDATE swarms SET updated_at = started_at WHERE updated_at = 0;

CREATE INDEX IF NOT EXISTS idx_swarms_updated ON swarms(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_swarms_team ON swarms(team_id);
