-- 007 — idempotent chat writes.
--
-- A send is retried by browsers, proxies and impatient people. Without a client-supplied key, a
-- retry is a duplicate message in the transcript, and the transcript is the record.
--
-- The column is nullable-with-default because SQLite cannot add NOT NULL without a constant
-- default, and the index is partial so rows written before this migration (client_id = '') are
-- never considered duplicates of each other.
ALTER TABLE messages ADD COLUMN client_id TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client
  ON messages(thread_id, client_id) WHERE client_id <> '';
