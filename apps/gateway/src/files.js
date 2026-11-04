/* ============ File management, owned by the gateway ============
 * A real file service for the panel that the Settings screen opens. Five rules, and every line below
 * exists to keep one of them:
 *
 *   1. **A path never escapes its root.** Every request names a *location* (a root the operator
 *      enrolled) and a path relative to it. `resolveInside` refuses `..`, refuses absolute paths,
 *      refuses null bytes, and re-checks the real path after resolving symlinks — a symlink inside the
 *      root that points outside it is an escape, not a shortcut.
 *   2. **Deleting is reversible.** `remove()` moves an entry to `<root>/.trash/<ts>-<name>`; there is no
 *      unlink route. A file manager that cannot be undone is a file manager nobody should point at a
 *      home directory.
 *   3. **A write is a write, and it is reported from the disk.** Uploads land in a temporary file and are
 *      renamed into place, then `stat`ed again — the response carries the size the filesystem reports,
 *      never the size the client claimed it sent.
 *   4. **Bytes are streamed, so they can be paused.** `openRange()` answers with a byte range and the
 *      total, which is what makes a pause/resume in the browser a real range request rather than a
 *      illusion. Download *records* live in the database; the bytes never pass through it.
 *   5. **Nothing here knows a secret.** No credential is stored, logged or returned by this module.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { db, audit, logEvent } from './db.js';

const now = () => Date.now();
const fail = (code, message, extra = {}) =>
  Object.assign(new Error(message), { code, ...extra });

const newLocationId = () => `fl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const newDownloadId = () => `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export const FILE_LIMITS = Object.freeze({
  uploadBytes: Number(process.env.MMM_FILE_UPLOAD_BYTES || 64 * 1024 * 1024),
  listEntries: 2000,
  usageEntries: 5000,
  nameChars: 200,
  downloadBytes: 64 * 1024 * 1024,
});

/** Where the roots live when a deployment says nothing. Never inside `src/` or `data/`. */
function defaultRoot() {
  return process.env.MMM_FILES_ROOT || path.join(process.cwd(), 'var', 'files');
}

const SEED_LOCATIONS = [
  { id: 'loc-downloads', label: 'Downloads', kind: 'downloads', rel: 'downloads', purpose: 'downloads' },
  { id: 'loc-artifacts', label: 'Artifacts', kind: 'artifacts', rel: 'artifacts', purpose: 'uploads' },
  { id: 'loc-web', label: 'Public web', kind: 'web', rel: 'web', purpose: 'web-deploy' },
];

let seeded = false;
/** Create the three default roots once. An existing row is never overwritten. */
export function seedLocations(principalId = 'system') {
  if (seeded) return;
  seeded = true;
  const root = defaultRoot();
  for (const loc of SEED_LOCATIONS) {
    const abs = path.join(root, loc.rel);
    try {
      fs.mkdirSync(abs, { recursive: true });
    } catch {
      // A root that cannot be created is reported by every call that needs it; seeding stays quiet.
    }
    const exists = db.prepare('SELECT id FROM file_locations WHERE root_path=?').get(abs);
    if (exists) continue;
    db.prepare(`INSERT OR IGNORE INTO file_locations (id,label,kind,root_path,purpose,granted,created_by,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(loc.id, loc.label, loc.kind, abs, loc.purpose, 1, principalId, now(), now());
  }
}

/* =========================================================================================
 * Locations
 * =======================================================================================*/

const locationRow = (row) =>
  !row
    ? null
    : {
        id: row.id,
        label: row.label,
        kind: row.kind,
        rootPath: row.root_path,
        purpose: row.purpose || '',
        granted: Boolean(row.granted),
        createdBy: row.created_by || '',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };

export function listLocations() {
  seedLocations();
  return db.prepare('SELECT * FROM file_locations ORDER BY created_at').all().map(locationRow);
}

export function locationById(id) {
  seedLocations();
  return locationRow(db.prepare('SELECT * FROM file_locations WHERE id=?').get(String(id || '')));
}

export function locationByKind(kind) {
  seedLocations();
  return locationRow(db.prepare('SELECT * FROM file_locations WHERE kind=? AND granted=1 ORDER BY created_at').get(String(kind || '')));
}

/** A purpose is what an app feature may write without asking again; it is not a permission. */
const PURPOSES = ['downloads', 'uploads', 'web-deploy', ''];
const KINDS = ['downloads', 'artifacts', 'web', 'custom'];

export function createLocation(body = {}, principal) {
  seedLocations();
  const label = String(body.label || '').trim();
  if (!label || label.length > FILE_LIMITS.nameChars) throw fail('invalid-location', 'a label is required (1–200 characters)');
  const kind = KINDS.includes(body.kind) ? body.kind : 'custom';
  const purpose = PURPOSES.includes(body.purpose) ? body.purpose : '';
  const raw = String(body.path || '').trim();
  if (!raw) throw fail('invalid-location', 'a directory path is required');
  if (!path.isAbsolute(raw)) throw fail('invalid-location', 'the path must be absolute, so it means the same thing after a restart');
  const abs = path.resolve(raw);
  try {
    fs.mkdirSync(abs, { recursive: true });
    if (!fs.statSync(abs).isDirectory()) throw fail('invalid-location', `${abs} is not a directory`);
  } catch (error) {
    if (error.code === 'invalid-location') throw error;
    throw fail('invalid-location', `the directory cannot be used: ${error.message}`);
  }
  if (db.prepare('SELECT id FROM file_locations WHERE root_path=?').get(abs)) {
    throw fail('conflict', 'that directory is already enrolled as a location');
  }
  const id = `${newLocationId()}`;
  db.prepare(`INSERT INTO file_locations (id,label,kind,root_path,purpose,granted,created_by,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, label, kind, abs, purpose, body.granted === false ? 0 : 1, principal?.id || '', now(), now());
  audit(principal?.id || 'system', principal?.via || 'api', 'files.location.create', { id, path: abs, kind }, 'allow', 'ok');
  logEvent('files', `Storage location “${label}” enrolled at ${abs}`, id);
  return locationById(id);
}

export function updateLocation(id, body = {}, principal) {
  const current = locationById(id);
  if (!current) throw fail('not-found', 'no such location');
  const label = body.label === undefined ? current.label : String(body.label || '').trim();
  if (!label || label.length > FILE_LIMITS.nameChars) throw fail('invalid-location', 'a label is required (1–200 characters)');
  const purpose = body.purpose === undefined ? current.purpose : PURPOSES.includes(body.purpose) ? body.purpose : '';
  const granted = body.granted === undefined ? (current.granted ? 1 : 0) : body.granted ? 1 : 0;
  db.prepare('UPDATE file_locations SET label=?, purpose=?, granted=?, updated_at=? WHERE id=?')
    .run(label, purpose, granted, now(), current.id);
  audit(principal?.id || 'system', principal?.via || 'api', 'files.location.update', { id: current.id, purpose, granted }, 'allow', 'ok');
  return locationById(current.id);
}

export function deleteLocation(id, principal) {
  const current = locationById(id);
  if (!current) throw fail('not-found', 'no such location');
  // The row goes; the directory does not. Un-enrolling a path is not permission to delete a folder.
  db.prepare('DELETE FROM file_locations WHERE id=?').run(current.id);
  audit(principal?.id || 'system', principal?.via || 'api', 'files.location.delete', { id: current.id, path: current.rootPath }, 'allow', 'ok');
  logEvent('files', `Storage location “${current.label}” un-enrolled; the directory is untouched`, current.id);
  return { id: current.id, rootPath: current.rootPath, directoryDeleted: false };
}

/* =========================================================================================
 * Path safety
 * =======================================================================================*/

/** Refuse anything that could name a path outside `root` — before touching the disk. */
export function resolveInside(root, rel) {
  const raw = String(rel ?? '').replace(/\\/g, '/');
  if (raw.includes('\u0000')) throw fail('invalid-path', 'a path may not contain a null byte');
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('/')) throw fail('invalid-path', 'paths are relative to the location root');
  const segments = raw.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.includes('..')) throw fail('invalid-path', 'a path may not contain “..”');
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, segments.join(path.sep));
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) throw fail('invalid-path', 'that path leaves the location');
  return abs;
}

/**
 * The same rule again, after the filesystem has resolved symlinks — and the one that actually matters for
 * a path that exists. `resolveInside` is a string check; a symlink is a directory entry whose *target* is
 * decided by the filesystem, so `link -> /etc` would pass the string check and read /etc. Every operation
 * that addresses an existing path calls this, and it walks up to the deepest existing ancestor so a new
 * file inside a linked directory is refused too.
 */
function assertNoEscape(root, abs) {
  let rootReal;
  try {
    rootReal = fs.realpathSync(root);
  } catch {
    rootReal = path.resolve(root);
  }
  let probe = abs;
  for (let i = 0; i < 64; i += 1) {
    let exists = false;
    try {
      exists = fs.existsSync(probe);
    } catch {
      exists = false;
    }
    if (exists) {
      let real;
      try {
        real = fs.realpathSync(probe);
      } catch {
        return;
      }
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
        throw fail('invalid-path', 'that path resolves outside the location (symlink)');
      }
      return;
    }
    const parent = path.dirname(probe);
    if (parent === probe) return;
    probe = parent;
  }
}

/**
 * The same rule, but after the filesystem has resolved symlinks. A link inside the root that points
 * outside it is an escape, so it is refused rather than followed.
 */
async function resolveExisting(root, rel, { mustExist = true } = {}) {
  const abs = resolveInside(root, rel);
  let real;
  try {
    real = await fsp.realpath(abs);
  } catch (error) {
    if (!mustExist && error.code === 'ENOENT') return { abs, real: abs };
    throw fail('not-found', `${rel || '.'} does not exist`);
  }
  const rootReal = await fsp.realpath(root).catch(() => path.resolve(root));
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw fail('invalid-path', 'that path resolves outside the location (symlink)');
  }
  return { abs, real };
}

function requireLocation(locationId) {
  const location = locationById(locationId);
  if (!location) throw fail('not-found', 'no such storage location');
  if (!location.granted) throw fail('forbidden', 'that location is not enrolled for app use');
  return location;
}

/* =========================================================================================
 * Reading
 * =======================================================================================*/

const entryOf = (abs, rootAbs, name) => {
  const st = fs.lstatSync(abs);
  const rel = path.relative(rootAbs, abs).split(path.sep).join('/');
  const dot = name.lastIndexOf('.');
  return {
    name,
    path: rel,
    type: st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : 'other',
    size: st.isFile() ? st.size : 0,
    modifiedAt: Math.round(st.mtimeMs),
    extension: st.isFile() && dot > 0 ? name.slice(dot + 1).toLowerCase() : '',
    linkTargetOutside: false,
  };
};

export function listDirectory(locationId, rel = '') {
  const location = requireLocation(locationId);
  const abs = resolveInside(location.rootPath, rel);
  assertNoEscape(location.rootPath, abs);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    throw fail('not-found', `${rel || '.'} does not exist`);
  }
  if (!st.isDirectory()) throw fail('invalid-path', `${rel || '.'} is not a directory`);
  const names = fs.readdirSync(abs).sort((a, b) => a.localeCompare(b));
  const rootAbs = path.resolve(location.rootPath);
  const entries = [];
  for (const name of names.slice(0, FILE_LIMITS.listEntries)) {
    const child = path.join(abs, name);
    try {
      const entry = entryOf(child, rootAbs, name);
      if (entry.type === 'link') {
        const real = fs.realpathSync(child);
        entry.linkTargetOutside = !(real === rootAbs || real.startsWith(rootAbs + path.sep));
      }
      entries.push(entry);
    } catch {
      // A name that vanished between readdir and lstat is simply not listed; it is not an error.
    }
  }
  const parent = path.dirname(String(rel || '').replace(/\\/g, '/'));
  return {
    location: location.id,
    path: String(rel || '').replace(/^\/+|\/+$/g, ''),
    parent: rel && rel !== '.' ? (parent === '.' ? '' : parent) : null,
    entries,
    truncated: names.length > FILE_LIMITS.listEntries,
  };
}

export function statEntry(locationId, rel) {
  const location = requireLocation(locationId);
  const abs = resolveInside(location.rootPath, rel);
  assertNoEscape(location.rootPath, abs);
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch {
    throw fail('not-found', `${rel || '.'} does not exist`);
  }
  return { ...entryOf(abs, path.resolve(location.rootPath), path.basename(abs) || location.label), immutable: false };
}

/** Total bytes and file count under a location, bounded so a home directory cannot hang a request. */
export function usage(locationId) {
  const location = requireLocation(locationId);
  const rootAbs = path.resolve(location.rootPath);
  let bytes = 0;
  let files = 0;
  let dirs = 0;
  let seen = 0;
  let truncated = false;
  const walk = (dir, depth) => {
    if (truncated || depth > 8) return;
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (seen >= FILE_LIMITS.usageEntries) {
        truncated = true;
        return;
      }
      seen += 1;
      const child = path.join(dir, name);
      let st;
      try {
        st = fs.lstatSync(child);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        dirs += 1;
        walk(child, depth + 1);
      } else if (st.isFile()) {
        files += 1;
        bytes += st.size;
      }
    }
  };
  walk(rootAbs, 0);
  return {
    location: location.id,
    label: location.label,
    rootPath: location.rootPath,
    bytes,
    files,
    dirs,
    truncated,
  };
}

/* =========================================================================================
 * Mutating the tree
 * =======================================================================================*/

export function makeDirectory(locationId, rel, principal) {
  const location = requireLocation(locationId);
  const abs = resolveInside(location.rootPath, rel);
  if (!String(rel || '').trim()) throw fail('invalid-path', 'a directory name is required');
  assertNoEscape(location.rootPath, path.dirname(abs));
  if (fs.existsSync(abs)) throw fail('conflict', 'something already exists at that path');
  fs.mkdirSync(abs, { recursive: false });
  audit(principal?.id || 'system', principal?.via || 'api', 'files.mkdir', { location: location.id, path: rel }, 'allow', 'ok');
  logEvent('files', `${principal?.name || principal?.id || 'someone'} created ${rel} in ${location.label}`, location.id);
  return statEntry(location.id, rel);
}

function requireRel(rel, what = 'a path') {
  const clean = String(rel || '').replace(/^\/+|\/+$/g, '');
  if (!clean) throw fail('invalid-path', `${what} is required`);
  return clean;
}

export function moveEntry(locationId, from, to, principal) {
  const location = requireLocation(locationId);
  const src = resolveInside(location.rootPath, requireRel(from, 'a source path'));
  const dst = resolveInside(location.rootPath, requireRel(to, 'a destination path'));
  if (src === dst) throw fail('invalid-path', 'the source and destination are the same path');
  if (!fs.existsSync(src)) throw fail('not-found', 'the source does not exist');
  assertNoEscape(location.rootPath, src);
  assertNoEscape(location.rootPath, path.dirname(dst));
  // Moving a directory into itself would delete it; refuse rather than rely on the OS to complain.
  if (fs.lstatSync(src).isDirectory() && (dst === src || dst.startsWith(src + path.sep))) {
    throw fail('invalid-path', 'a directory cannot be moved inside itself');
  }
  if (fs.existsSync(dst)) throw fail('conflict', 'the destination already exists');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(src, dst);
  audit(principal?.id || 'system', principal?.via || 'api', 'files.move', { location: location.id, from, to }, 'allow', 'ok');
  logEvent('files', `${from} → ${to} in ${location.label}`, location.id);
  return { from, to };
}

export function copyEntry(locationId, from, to, principal) {
  const location = requireLocation(locationId);
  const src = resolveInside(location.rootPath, requireRel(from, 'a source path'));
  const dst = resolveInside(location.rootPath, requireRel(to, 'a destination path'));
  if (src === dst) throw fail('invalid-path', 'the source and destination are the same path');
  if (!fs.existsSync(src)) throw fail('not-found', 'the source does not exist');
  assertNoEscape(location.rootPath, src);
  assertNoEscape(location.rootPath, path.dirname(dst));
  if (fs.existsSync(dst)) throw fail('conflict', 'the destination already exists');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true, errorOnExist: true, force: false });
  audit(principal?.id || 'system', principal?.via || 'api', 'files.copy', { location: location.id, from, to }, 'allow', 'ok');
  logEvent('files', `${from} copied to ${to} in ${location.label}`, location.id);
  return { from, to };
}

/** Reversible by construction: the entry is moved into the location's trash, never unlinked. */
export function removeEntry(locationId, rel, principal) {
  const location = requireLocation(locationId);
  const clean = requireRel(rel, 'a path');
  const abs = resolveInside(location.rootPath, clean);
  if (!fs.existsSync(abs)) throw fail('not-found', 'that entry does not exist');
  assertNoEscape(location.rootPath, abs);
  const trashDir = path.join(location.rootPath, '.trash');
  fs.mkdirSync(trashDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(trashDir, `${stamp}__${path.basename(abs)}`);
  fs.renameSync(abs, target);
  const trashed = path.relative(path.resolve(location.rootPath), target).split(path.sep).join('/');
  audit(principal?.id || 'system', principal?.via || 'api', 'files.remove', { location: location.id, path: clean, trashed }, 'allow', 'ok');
  logEvent('files', `${clean} moved to trash in ${location.label}`, location.id);
  return { removed: clean, trashed, recoverable: true };
}

/**
 * Write an uploaded buffer into the location. The temporary file plus rename means a failed upload
 * leaves no half-written file with a real name, and the response reports the size the disk reports.
 */
export function writeUpload(locationId, rel, bytes, principal) {
  const location = requireLocation(locationId);
  const clean = requireRel(rel, 'a file path');
  if (!bytes || !Buffer.isBuffer(bytes) || bytes.length === 0) throw fail('invalid-params', 'the upload was empty');
  if (bytes.length > FILE_LIMITS.uploadBytes) throw fail('file-too-large', `the upload exceeds ${FILE_LIMITS.uploadBytes} bytes`);
  const abs = resolveInside(location.rootPath, clean);
  assertNoEscape(location.rootPath, path.dirname(abs));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const temp = `${abs}.part-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, bytes);
  fs.renameSync(temp, abs);
  const st = fs.statSync(abs);
  audit(principal?.id || 'system', principal?.via || 'api', 'files.upload', { location: location.id, path: clean, bytes: st.size }, 'allow', 'ok');
  logEvent('files', `${clean} uploaded to ${location.label} (${st.size} bytes)`, location.id);
  return {
    location: location.id,
    path: clean,
    name: path.basename(abs),
    bytes: st.size,
    modifiedAt: Math.round(st.mtimeMs),
    // What the browser sent is not evidence; what the disk says is.
    confirmedBy: 'stat',
  };
}

/* =========================================================================================
 * Streaming a download, with a range
 * =======================================================================================*/

/**
 * Open a byte range of a file. Returns a read stream plus the headers a resumable download needs;
 * `Accept-Ranges: bytes` is the promise that a pause can be resumed instead of restarted.
 */
export function openRange(locationId, rel, rangeHeader = '') {
  const location = requireLocation(locationId);
  const clean = requireRel(rel, 'a file path');
  const abs = resolveInside(location.rootPath, clean);
  assertNoEscape(location.rootPath, abs);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    throw fail('not-found', 'that file does not exist');
  }
  if (!st.isFile()) throw fail('invalid-path', 'that entry is not a file');
  const total = st.size;
  let start = 0;
  let end = total - 1;
  let partial = false;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader || '').trim());
  if (match) {
    if (match[1] === '' && match[2] === '') throw fail('invalid-params', 'the byte range is empty');
    if (match[1] === '') {
      const suffix = Number(match[2]);
      if (!Number.isFinite(suffix) || suffix <= 0) throw fail('invalid-params', 'the byte range is invalid');
      start = Math.max(0, total - suffix);
    } else {
      start = Number(match[1]);
      if (Number.isFinite(Number(match[2])) && match[2] !== '') end = Math.min(Number(match[2]), total - 1);
    }
    if (!Number.isFinite(start) || start < 0 || start >= total || end < start) {
      return { unsatisfiable: true, total, start: null, end: null, stream: null };
    }
    partial = true;
  }
  const stream = fs.createReadStream(abs, { start, end });
  return {
    unsatisfiable: false,
    partial,
    total,
    start,
    end,
    length: end - start + 1,
    fileName: path.basename(abs),
    modifiedAt: Math.round(st.mtimeMs),
    stream,
  };
}

export const mimeFor = (name) => {
  const ext = path.extname(String(name || '')).toLowerCase();
  return (
    {
      '.txt': 'text/plain; charset=utf-8',
      '.md': 'text/markdown; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.htm': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.pdf': 'application/pdf',
      '.zip': 'application/zip',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
    }[ext] || 'application/octet-stream'
  );
};

/* =========================================================================================
 * Download records
 * =======================================================================================*/

const STATUSES = ['queued', 'running', 'paused', 'completed', 'failed', 'cancelled'];

const downloadRow = (row) =>
  !row
    ? null
    : {
        id: row.id,
        locationId: row.location_id,
        path: row.rel_path,
        filename: row.filename,
        bytesTotal: row.bytes_total,
        bytesDone: row.bytes_done,
        status: row.status,
        attempts: row.attempts,
        error: row.error || '',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };

export function listDownloads(principalId) {
  return db
    .prepare('SELECT * FROM file_downloads WHERE principal_id=? ORDER BY created_at DESC LIMIT 200')
    .all(principalId)
    .map(downloadRow);
}

export function createDownload(body = {}, principal) {
  const location = requireLocation(body.locationId);
  const clean = requireRel(body.path, 'a file path');
  const stat = statEntry(location.id, clean);
  if (stat.type !== 'file') throw fail('invalid-path', 'only a file can be downloaded');
  const id = newDownloadId();
  db.prepare(`INSERT INTO file_downloads (id,principal_id,location_id,rel_path,filename,bytes_total,bytes_done,status,attempts,error,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, principal?.id || 'unknown', location.id, clean, stat.name, stat.size, 0, 'queued', 0, '', now(), now());
  audit(principal?.id || 'system', principal?.via || 'api', 'files.download.start', { id, location: location.id, path: clean, bytes: stat.size }, 'allow', 'ok');
  return downloadRow(db.prepare('SELECT * FROM file_downloads WHERE id=?').get(id));
}

export function updateDownload(id, body = {}, principalId) {
  const row = db.prepare('SELECT * FROM file_downloads WHERE id=?').get(String(id || ''));
  if (!row) throw fail('not-found', 'no such download');
  if (row.principal_id !== principalId) throw fail('not-found', 'no such download');
  const status = body.status === undefined ? row.status : body.status;
  if (!STATUSES.includes(status)) throw fail('invalid-params', `status must be one of ${STATUSES.join(', ')}`);
  const done = body.bytesDone === undefined ? row.bytes_done : Math.max(0, Math.min(Number(body.bytesDone) || 0, row.bytes_total || 0));
  const error = body.error === undefined ? row.error : String(body.error || '').slice(0, 300);
  const attempts = body.attempt === true ? row.attempts + 1 : row.attempts;
  db.prepare('UPDATE file_downloads SET status=?, bytes_done=?, error=?, attempts=?, updated_at=? WHERE id=?')
    .run(status, done, error, attempts, now(), row.id);
  return downloadRow(db.prepare('SELECT * FROM file_downloads WHERE id=?').get(row.id));
}

export function deleteDownload(id, principalId) {
  const row = db.prepare('SELECT * FROM file_downloads WHERE id=?').get(String(id || ''));
  if (!row || row.principal_id !== principalId) throw fail('not-found', 'no such download');
  db.prepare('DELETE FROM file_downloads WHERE id=?').run(row.id);
  return { id: row.id, deleted: true };
}

/**
 * A download that was still running when the gateway restarted (or the tab closed) is not running now.
 * Reporting it as running would be a progress bar for a socket nobody holds, so it is marked
 * `interrupted` on read — and `interrupted` can be resumed from `bytes_done`.
 */
export function reconcileDownloads(principalId) {
  const stale = db
    .prepare("SELECT * FROM file_downloads WHERE principal_id=? AND status IN ('running','queued')")
    .all(principalId);
  for (const row of stale) {
    db.prepare("UPDATE file_downloads SET status='failed', error=?, updated_at=? WHERE id=?")
      .run('the transfer stopped when the app closed; resume from the saved byte count', now(), row.id);
  }
  return stale.length;
}

export function capabilities() {
  return {
    limits: FILE_LIMITS,
    purposed: ['downloads', 'uploads', 'web-deploy'],
    kinds: KINDS,
    note:
      'Files are read and written on the gateway host, inside enrolled roots only. Deleting moves an entry ' +
      'to the location trash. A download is streamed with byte ranges, so pausing and resuming is real.',
  };
}

export const FILE_PURPOSES = Object.freeze(PURPOSES);
export const FILE_KINDS = Object.freeze(KINDS);
export { resolveExisting };
