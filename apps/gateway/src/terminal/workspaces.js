/* ============ Terminal — workspaces ============
 * A workspace is the only place a command may run. It is resolved once, here, and every later path
 * check is made against it, so `cd ../../..` cannot become a way to see the host.
 *
 * Roots come from the deployment, never from a request:
 *   MMM_TERMINAL_ROOTS=/srv/projects:/home/me/code     (colon-separated, absolute)
 * The default is `<DATA_DIR>/workspaces`, which keeps `npm init` and `npm install` away from the
 * gateway's own checkout — an install in the repo would rewrite MMM's lockfile while it is running.
 *
 * The repository may be added as a root explicitly. When it is, every command in it needs an
 * approval, because the app is executing its own source.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { DATA_DIR } from '../db.js';

const MAX_PACKAGE_JSON = 512 * 1024;

/** The gateway's own checkout — allowed only as an explicit root, and then gated. */
export const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../../../../');

/**
 * Configured roots, in order, with stable ids. Ids are names, not indexes, so a stored workspace
 * still resolves after the list is reordered.
 */
export function roots() {
  const raw = String(process.env.MMM_TERMINAL_ROOTS || '').trim();
  const list = raw
    ? raw.split(':').map((p) => p.trim()).filter(Boolean)
    : [join(DATA_DIR, 'workspaces')];
  const out = [];
  for (const [index, path] of list.entries()) {
    if (!isAbsolute(path)) continue; // a relative root would move with the process's cwd
    const abs = resolve(path);
    const id = abs === REPO_ROOT ? 'repo' : (abs.startsWith(DATA_DIR) ? `data-${index}` : `root-${index}`);
    out.push({ id, path: abs, label: abs === REPO_ROOT ? 'MMM repository' : abs, isRepo: abs === REPO_ROOT });
  }
  if (!out.length) out.push({ id: 'data-0', path: join(DATA_DIR, 'workspaces'), label: join(DATA_DIR, 'workspaces'), isRepo: false });
  return out;
}

export function rootById(rootId) {
  const all = roots();
  return all.find((r) => r.id === rootId) || all[0];
}

export function describeRoots() {
  return roots().map((r) => ({
    id: r.id,
    label: r.label,
    // The full path is shown to the operator on purpose: "where will this delete things?" is a
    // question the UI must be able to answer.
    path: r.path,
    isRepo: r.isRepo,
    exists: existsSync(r.path),
  }));
}

/**
 * Resolve `cwd` (relative to the workspace) and refuse anything that leaves it.
 * @returns {{ ok: true, abs: string, rel: string } | { ok: false, reason: string }}
 */
export function resolveInside(rootPath, workspaceRel, requested = '.') {
  const workspaceAbs = resolve(rootPath, workspaceRel || '.');
  const base = resolve(workspaceAbs);
  let target = resolve(base, String(requested || '.'));
  if (target !== base && !target.startsWith(base + sep)) {
    return { ok: false, reason: 'that path is outside the workspace' };
  }
  if (!existsSync(target)) return { ok: false, reason: `no such directory: ${requested}` };
  try {
    if (!statSync(target).isDirectory()) return { ok: false, reason: `${requested} is not a directory` };
  } catch {
    return { ok: false, reason: `cannot read ${requested}` };
  }
  return { ok: true, abs: target, rel: relative(base, target) || '.' };
}

/** Ensure the default workspace exists so a first `npm init -y` has somewhere to land. */
export function ensureWorkspaceDirectory(rootPath, workspaceRel) {
  const abs = resolve(rootPath, workspaceRel || '.');
  mkdirSync(abs, { recursive: true });
  return abs;
}

/**
 * What the project says about itself. Read-only, bounded, and never executed.
 * @returns {null | { name, version, scripts: Record<string,string>, dependencies: string[], devDependencies: string[], hasLockfile: boolean, private: boolean }}
 */
export function readProject(absDir) {
  const pkgPath = join(absDir, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const raw = readFileSync(pkgPath, 'utf8');
    if (raw.length > MAX_PACKAGE_JSON) return { error: 'package.json is larger than 512 KB' };
    const pkg = JSON.parse(raw);
    const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    return {
      name: typeof pkg.name === 'string' ? pkg.name : '',
      version: typeof pkg.version === 'string' ? pkg.version : '',
      private: pkg.private === true,
      scripts: Object.fromEntries(Object.entries(scripts).map(([k, v]) => [String(k), String(v).slice(0, 500)])),
      dependencies: Object.keys(pkg.dependencies || {}),
      devDependencies: Object.keys(pkg.devDependencies || {}),
      hasLockfile: existsSync(join(absDir, 'package-lock.json')) || existsSync(join(absDir, 'npm-shrinkwrap.json')),
      hasNodeModules: existsSync(join(absDir, 'node_modules')),
    };
  } catch (error) {
    return { error: `package.json could not be read: ${error.message}` };
  }
}

/** `npm run` output, from the file itself — not from a guess. */
export function listScripts(absDir) {
  const project = readProject(absDir);
  if (!project) return { scripts: [], note: 'no package.json here — run `npm init -y` first' };
  if (project.error) return { scripts: [], note: project.error };
  return {
    scripts: Object.entries(project.scripts).map(([name, command]) => ({ name, command })),
    note: Object.keys(project.scripts).length ? '' : 'package.json has no scripts',
  };
}

export const normaliseCwd = (value) => normalize(String(value || '.').replace(/^\.\//, ''));
