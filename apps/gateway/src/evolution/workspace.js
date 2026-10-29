/* ============ Self-modification — isolated working copies ============
 * An experiment gets its own directory tree:
 *
 *   DATA_DIR/experiments/<experimentId>/
 *     baseline/      an exact copy of the files as they exist today (never written again)
 *     work/          the candidate the agent edits
 *     manifest.json  hashes, sizes, the baseline version and the file list
 *
 * The live source tree is only ever *read*. Nothing in this module can write to the repository, so an
 * experiment cannot damage the running gateway even if it fails completely.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_FILES_PER_EXPERIMENT, MAX_FILE_BYTES, MAX_TOTAL_BYTES, normalisePath,
} from './policy.js';
import { unifiedDiff } from './diff.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '../../../..');

const sha = (value) => createHash('sha256').update(value).digest('hex').slice(0, 32);

export const experimentRoot = (dataDir, experimentId) => join(dataDir, 'experiments', experimentId);

function safeJoin(root, relativePath) {
  const clean = normalisePath(relativePath);
  const target = resolve(root, clean);
  const base = resolve(root) + sep;
  if (!target.startsWith(base)) {
    throw Object.assign(new Error('path escapes the workspace'), { code: 'bad-path' });
  }
  return target;
}

function ensureDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}

/**
 * Copy the declared files from the repository into a fresh baseline, then seed `work/` from it.
 * @returns {{ root: string, baselineVersion: string, files: Record<string, { sha: string, bytes: number, existed: boolean }> }}
 */
export function createWorkspace(dataDir, experimentId, files = [], { sourceRoot = REPO_ROOT } = {}) {
  const root = experimentRoot(dataDir, experimentId);
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'baseline'), { recursive: true });
  mkdirSync(join(root, 'work'), { recursive: true });

  const manifest = {};
  let total = 0;
  for (const path of files.slice(0, MAX_FILES_PER_EXPERIMENT)) {
    const clean = normalisePath(path);
    const source = safeJoin(sourceRoot, clean);
    const existed = existsSync(source) && statSync(source).isFile();
    let content = '';
    if (existed) {
      const size = statSync(source).size;
      if (size > MAX_FILE_BYTES) throw Object.assign(new Error(`“${clean}” is larger than ${MAX_FILE_BYTES} bytes`), { code: 'too-large' });
      total += size;
      if (total > MAX_TOTAL_BYTES) throw Object.assign(new Error('the experiment exceeds its total size budget'), { code: 'too-large' });
      content = readFileSync(source, 'utf8');
      const baseTarget = safeJoin(join(root, 'baseline'), clean);
      ensureDir(baseTarget);
      copyFileSync(source, baseTarget);
      const workTarget = safeJoin(join(root, 'work'), clean);
      ensureDir(workTarget);
      copyFileSync(source, workTarget);
    }
    manifest[clean] = { sha: sha(content), bytes: Buffer.byteLength(content), existed };
  }

  const baselineVersion = sha(Object.entries(manifest).map(([k, v]) => `${k}:${v.sha}`).join('|'));
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ experimentId, baselineVersion, files: manifest, createdAt: Date.now() }, null, 2));
  return { root, baselineVersion, files: manifest };
}

export function readManifest(dataDir, experimentId) {
  const path = join(experimentRoot(dataDir, experimentId), 'manifest.json');
  if (!existsSync(path)) throw Object.assign(new Error('the experiment workspace is missing'), { code: 'no-workspace' });
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function readBaseline(dataDir, experimentId, path) {
  const file = safeJoin(join(experimentRoot(dataDir, experimentId), 'baseline'), path);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

export function readCandidate(dataDir, experimentId, path) {
  const file = safeJoin(join(experimentRoot(dataDir, experimentId), 'work'), path);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

export function writeCandidate(dataDir, experimentId, path, content) {
  const text = String(content ?? '');
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_FILE_BYTES) throw Object.assign(new Error(`the file would exceed ${MAX_FILE_BYTES} bytes`), { code: 'too-large' });
  const file = safeJoin(join(experimentRoot(dataDir, experimentId), 'work'), path);
  ensureDir(file);
  writeFileSync(file, text);
  return { path: normalisePath(path), bytes, sha: sha(text) };
}

export function deleteCandidate(dataDir, experimentId, path) {
  const file = safeJoin(join(experimentRoot(dataDir, experimentId), 'work'), path);
  if (!existsSync(file)) throw Object.assign(new Error('that file is not in the candidate'), { code: 'not-found' });
  rmSync(file, { force: true });
  return { path: normalisePath(path), deleted: true };
}

/** Every file in the workspace, keyed by path, with hashes — the comparison input. */
export function snapshot(dataDir, experimentId) {
  const root = experimentRoot(dataDir, experimentId);
  const walk = (dir) => {
    const out = {};
    if (!existsSync(dir)) return out;
    const visit = (current) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) visit(full);
        else {
          const rel = relative(root, full).split(sep).join('/');
          if (rel === 'manifest.json') continue;
          const [stage, ...rest] = rel.split('/');
          if (!['baseline', 'work'].includes(stage)) continue;
          if (stage === 'baseline') continue;
          const text = readFileSync(full, 'utf8');
          out[rest.join('/')] = { sha: sha(text), bytes: Buffer.byteLength(text) };
        }
      }
    };
    visit(dir);
    return out;
  };
  return walk(join(root, 'work'));
}

/** Baseline and candidate content maps, used for integrity checks and diffs. */
export function compareTrees(dataDir, experimentId) {
  const manifest = readManifest(dataDir, experimentId);
  const baseline = {};
  const candidate = {};
  for (const path of Object.keys(manifest.files)) {
    const base = readBaseline(dataDir, experimentId, path);
    if (base !== null) baseline[path] = base;
    const work = readCandidate(dataDir, experimentId, path);
    if (work !== null) candidate[path] = work;
  }
  // Files the candidate added that were not in the baseline.
  for (const path of Object.keys(snapshot(dataDir, experimentId))) {
    if (candidate[path] === undefined) {
      const work = readCandidate(dataDir, experimentId, path);
      if (work !== null) candidate[path] = work;
    }
  }
  return { manifest, baseline, candidate };
}

/**
 * The change record plus a unified diff. `changes` is the map the runner stores on the experiment:
 * every path, whether it was added/modified/deleted, and why.
 */
export function diffWorkspace(dataDir, experimentId, notes = {}) {
  const { manifest, baseline, candidate } = compareTrees(dataDir, experimentId);
  const paths = [...new Set([...Object.keys(baseline), ...Object.keys(candidate)])].sort();
  const changes = {};
  const parts = [];
  let added = 0;
  let removed = 0;

  for (const path of paths) {
    const before = baseline[path];
    const after = candidate[path];
    if (before === after) continue;
    const kind = before === undefined ? 'added' : after === undefined ? 'deleted' : 'modified';
    changes[path] = {
      kind,
      reason: notes[path] || '',
      added: 0,
      removed: 0,
      existedInBaseline: manifest.files[path]?.existed ?? before !== undefined,
    };
    const result = unifiedDiff(before ?? '', after ?? '', { beforeName: `a/${path}`, afterName: `b/${path}` });
    if (result.text) parts.push(result.text);
    changes[path].added = result.added;
    changes[path].removed = result.removed;
    added += result.added;
    removed += result.removed;
  }

  return {
    changes,
    diff: parts.join(''),
    diffLines: added + removed,
    added,
    removed,
    files: Object.keys(changes),
    baselineVersion: manifest.baselineVersion,
  };
}

export function removeWorkspace(dataDir, experimentId) {
  rmSync(experimentRoot(dataDir, experimentId), { recursive: true, force: true });
}

/** Publish a candidate as an immutable version directory (used for staging, deployment and rollback). */
export function publishVersion(dataDir, agentId, versionId, dataDirPaths, { fromExperiment = null } = {}) {
  const target = join(dataDir, 'runtime', agentId, versionId);
  mkdirSync(target, { recursive: true });
  const files = {};
  if (fromExperiment) {
    const source = join(experimentRoot(dataDir, fromExperiment), 'work');
    const visit = (current) => {
      if (!existsSync(current)) return;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) visit(full);
        else {
          const rel = relative(source, full).split(sep).join('/');
          const dest = join(target, 'files', rel);
          ensureDir(dest);
          copyFileSync(full, dest);
          files[rel] = sha(readFileSync(full, 'utf8'));
        }
      }
    };
    visit(source);
  } else if (dataDirPaths) {
    for (const [rel, content] of Object.entries(dataDirPaths)) {
      const dest = join(target, 'files', rel);
      ensureDir(dest);
      writeFileSync(dest, content);
      files[rel] = sha(content);
    }
  }
  const filesHash = sha(Object.entries(files).map(([k, v]) => `${k}:${v}`).join('|'));
  writeFileSync(join(target, 'version.json'), JSON.stringify({ versionId, agentId, filesHash, files, publishedAt: Date.now() }, null, 2));
  return { path: target, files, filesHash };
}

/** Point `current` at a version directory. Rollback is the same operation with an older version. */
export function activateVersion(dataDir, agentId, versionId) {
  const source = join(dataDir, 'runtime', agentId, versionId);
  if (!existsSync(source)) throw Object.assign(new Error('that version is not published'), { code: 'no-version' });
  const current = join(dataDir, 'runtime', agentId, 'current');
  if (existsSync(current)) rmSync(current, { recursive: true, force: true });
  mkdirSync(dirname(current), { recursive: true });
  copyDir(source, current);
  writeFileSync(join(dataDir, 'runtime', agentId, 'current.json'), JSON.stringify({ versionId, activatedAt: Date.now() }, null, 2));
  return { current, versionId };
}

export function activeVersion(dataDir, agentId) {
  const marker = join(dataDir, 'runtime', agentId, 'current.json');
  return existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : null;
}

function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else copyFileSync(src, dest);
  }
}
