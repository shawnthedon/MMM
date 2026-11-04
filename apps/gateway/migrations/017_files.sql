-- File management (unit: files) — storage locations and the download manager.
--
-- The app has had a Files screen since the prototype, backed by `state.files` in the browser and a
-- hard-coded "248 MB used". That is a picture of files, not file management: nothing on disk is
-- reachable, and an upload writes a JavaScript object. This migration creates the two tables a real
-- file service needs, and nothing else.
--
--   file_locations  a *root* the gateway is allowed to read and write, named, and given a purpose.
--                   Paths in every request are relative to one of these and are re-resolved through
--                   the root, so a path can never escape it (see files.js resolveInside).
--   file_downloads  the record of a download: what was asked for, where it was going, how many bytes
--                   arrived, and whether it is running, paused, cancelled or done. The bytes themselves
--                   are streamed by the browser, which is the only component that can pause a socket it
--                   opened; the row is what lets the manager survive a reload and resume from a byte
--                   count instead of starting over.
--
-- Deliberately absent: no file contents, no blob column, no transcript of a file. The files stay on the
-- filesystem; this is metadata about where they are, so the database and the disk cannot disagree about
-- what a file contains.
--
--   kind     'downloads' | 'artifacts' | 'web' | 'custom' — a purpose, shown on the screen
--   purpose  which app feature is allowed to write here without asking again ('downloads', 'uploads',
--            'web-deploy', '')
--   granted  0 = the location exists but is not enrolled for app use (nothing writes there)

CREATE TABLE IF NOT EXISTS file_locations (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'custom',
  root_path TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  granted INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_file_locations_root ON file_locations(root_path);

CREATE TABLE IF NOT EXISTS file_downloads (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  filename TEXT NOT NULL,
  bytes_total INTEGER NOT NULL DEFAULT 0,
  bytes_done INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_file_downloads_principal ON file_downloads(principal_id, created_at);
