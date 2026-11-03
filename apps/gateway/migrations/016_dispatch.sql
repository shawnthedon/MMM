-- 016 — an approval gate is single-use when a dispatcher consumes it.
--
-- The dispatcher (apps/gateway/src/dispatcher.js) executes operations on behalf of a principal, and a
-- destructive or consequential operation needs an approval decided by *someone else*. Two properties are
-- required for that to mean anything:
--
--   1. the approval must name the operation *and its target* — enforced in code by comparing the row's
--      `action`/`target` with the operation about to run;
--   2. the approval must be spendable once, so a replay of the same request cannot reuse it.
--
-- `status` already records the decision; this column records the spend. NULL means the gate is still
-- unspent, which is the honest reading for every gate created before this migration.
ALTER TABLE approvals ADD COLUMN consumed_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_approvals_action_target ON approvals(action, target, status);
