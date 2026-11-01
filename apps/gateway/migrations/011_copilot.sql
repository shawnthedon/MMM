-- 011 — Copilot conversations are rows, and a reply must name the call that made it.
--
-- Until now the Copilot never called a model. `src/copilot/orchestrator.js` switches on seven fixed
-- modes and returns typed cards, and its transcript lived in this browser's localStorage — so
-- "conversation" was a list of screens, and nothing survived a reload or a second device.
--
-- This migration gives a real conversation the two things it needs:
--   1. a thread that belongs to one principal (`threads.owner_id`), so two people do not share a
--      transcript;
--   2. a link from every model-written message to the metered `model_calls` row that produced it.
--      A reply cannot exist unless a call did — the same discipline `009` applied to swarm plans.

ALTER TABLE threads ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_threads_owner ON threads(owner_id, kind);

-- NULL for anything a person typed. A non-NULL value points at a real ledger row, which is what makes
-- "the model said this" checkable instead of a claim in the payload.
ALTER TABLE messages ADD COLUMN model_call_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_messages_model_call ON messages(model_call_id) WHERE model_call_id IS NOT NULL;

-- Which provider the Copilot speaks through. Empty means "the first provider with a sealed key";
-- that resolution happens in code, once, and the answer is reported in every read of the runtime.
INSERT OR IGNORE INTO settings (key, value) VALUES ('copilot.provider', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('copilot.model', '');
