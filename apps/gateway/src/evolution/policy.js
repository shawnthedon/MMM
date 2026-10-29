/* ============ Self-modification — policy, scope and the guards ============
 * Every rule that decides "may this agent do this?" lives here, outside the agent's own instructions
 * and outside anything an agent can write to. The runner asks; the policy answers; the audit log
 * records the answer. A prompt that says “be careful” is not a control.
 *
 * The five authority levels are the product model from the specification. What they grant is narrow
 * and explicit, and an agent can never move itself between them.
 */

export const LEVELS = Object.freeze({
  1: {
    id: 1,
    key: 'recommend',
    label: 'Recommend',
    summary: 'Inspect authorised code, diagnose a problem and propose a patch. Cannot write anything.',
    can: { inspect: true, workspace: false, modify: false, test: false, stage: false, deploy: false, continuous: false },
  },
  2: {
    id: 2,
    key: 'modify-and-test',
    label: 'Modify and test',
    summary: 'Create an isolated working copy, change it, run permitted tests. Promotion needs approval.',
    can: { inspect: true, workspace: true, modify: true, test: true, stage: false, deploy: false, continuous: false },
  },
  3: {
    id: 3,
    key: 'auto-stage',
    label: 'Automatically stage',
    summary: 'Modify, test and obtain the required reviews, then stage a passing candidate. Production still needs approval.',
    can: { inspect: true, workspace: true, modify: true, test: true, stage: true, deploy: false, continuous: false },
  },
  4: {
    id: 4,
    key: 'bounded-deploy',
    label: 'Bounded autonomous deployment',
    summary: 'Deploy eligible low-risk candidates inside its configured scope, after every test, review, security and health condition passes.',
    can: { inspect: true, workspace: true, modify: true, test: true, stage: true, deploy: true, continuous: false },
  },
  5: {
    id: 5,
    key: 'continuous',
    label: 'Supervised continuous improvement',
    summary: 'Continuously raise improvement opportunities and run bounded experiments under a pre-approved policy. High-impact or security-sensitive changes still need approval.',
    can: { inspect: true, workspace: true, modify: true, test: true, stage: true, deploy: true, continuous: true },
  },
});

export const LEVEL_IDS = [1, 2, 3, 4, 5];
export const DEFAULT_LEVEL = 1;
export const levelOf = (n) => LEVELS[Math.min(5, Math.max(1, Number(n) || DEFAULT_LEVEL))];
export const canAt = (level, ability) => Boolean(levelOf(level).can[ability]);

/* ---------- what may never be rewritten by an agent ----------
 * These are the mechanisms that enforce the agent's own limits. An agent may *recommend* a change to
 * one of them (it goes to a human review queue as a recommendation), but the platform refuses to put
 * it in a candidate. Removing or weakening any of these checks must require a human change to this
 * file — which is itself protected.
 */
export const PROTECTED_PATHS = Object.freeze([
  { re: /^apps\/gateway\/src\/evolution\//, reason: 'the safeguards that govern self-modification' },
  { re: /^apps\/gateway\/src\/auth\.js$/, reason: 'authentication and session handling' },
  { re: /^apps\/gateway\/src\/rbac\.js$/, reason: 'role and permission enforcement' },
  { re: /^apps\/gateway\/src\/db\.js$/, reason: 'the database layer and the hash-chained audit log' },
  { re: /^apps\/gateway\/server\.js$/, reason: 'the request pipeline, CSRF/CORS and route authorisation' },
  { re: /^apps\/gateway\/migrations\//, reason: 'the schema, including this module’s own tables' },
  { re: /^scripts\/register-css-stub\.mjs$/, reason: 'the test harness other suites depend on' },
  { re: /^public\/sw\.js$/, reason: 'the service worker and its cache rules' },
  { re: /^(package\.json|package-lock\.json)$/, reason: 'dependencies and the command surface' },
  { re: /^\.github\//, reason: 'CI and deployment configuration' },
  { re: /(^|\/)\.env(\.|$)/, reason: 'secrets' },
  { re: /(^|\/)\.git\//, reason: 'repository internals' },
]);

/** Allowed but high-impact: a change here needs review and can never auto-deploy on a scripted test alone. */
export const SENSITIVE_PATHS = Object.freeze([
  { re: /^apps\/gateway\/src\//, reason: 'gateway server code' },
  { re: /^apps\/gateway\/src\/browser\//, reason: 'the autonomous browser engine' },
  { re: /^src\//, reason: 'the application UI' },
  { re: /^public\//, reason: 'served static assets' },
  { re: /^scripts\/.*-test\.mjs$/, reason: 'a test suite' },
  { re: /^docs\//, reason: 'documentation (low impact, but reviewed all the same)' },
]);

export const MAX_FILES_PER_EXPERIMENT = 40;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
export const MAX_DIFF_LINES = 3000;
export const HARD_RUNTIME_LIMIT_MS = 15 * 60 * 1000;

/** Reject anything that could escape the workspace or smuggle a traversal. */
export function normalisePath(input) {
  const raw = String(input || '').trim();
  if (!raw) throw Object.assign(new Error('a file path is required'), { code: 'bad-path' });
  if (raw.length > 300) throw Object.assign(new Error('path is too long'), { code: 'bad-path' });
  if (/[\u0000-\u001f\\]/.test(raw)) throw Object.assign(new Error('path contains control characters'), { code: 'bad-path' });
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) throw Object.assign(new Error('absolute paths are refused'), { code: 'bad-path' });
  const parts = raw.split('/');
  if (parts.some((p) => p === '..' || p === '.' || p === '')) {
    throw Object.assign(new Error('path traversal is refused'), { code: 'bad-path' });
  }
  return parts.join('/');
}

const globToRe = (glob) =>
  new RegExp(`^${String(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/\u0000/g, '.*')}$`);

export const matchesScope = (path, scope = []) => (scope || []).some((glob) => {
  try { return globToRe(glob).test(path); } catch { return false; }
});

export function classifyPath(path) {
  const p = String(path || '');
  const blocked = PROTECTED_PATHS.find((entry) => entry.re.test(p));
  if (blocked) return { kind: 'protected', reason: blocked.reason };
  const sensitive = SENSITIVE_PATHS.find((entry) => entry.re.test(p));
  if (sensitive) return { kind: 'sensitive', reason: sensitive.reason };
  return { kind: 'normal', reason: '' };
}

/**
 * Is this path inside what the agent may *write*? Scope is the union of its own policy globs and any
 * unexpired cross-agent grants. A protected path is refused even when a glob would match it.
 */
export function checkWriteScope(path, { scope = [], grants = [] } = {}) {
  let clean;
  try { clean = normalisePath(path); } catch (error) { return { ok: false, code: 'bad-path', reason: error.message }; }
  const cls = classifyPath(clean);
  if (cls.kind === 'protected') {
    return { ok: false, code: 'protected', reason: `“${clean}” is protected: ${cls.reason}. An agent may recommend a change here, but the platform will not put it in a candidate.` };
  }
  const writable = [...(scope || []), ...(grants || []).flatMap((g) => g.scope || [])];
  if (!matchesScope(clean, writable)) {
    return { ok: false, code: 'out-of-scope', reason: `“${clean}” is outside the scope this agent was granted (${writable.length ? writable.join(', ') : 'no scope granted'}).` };
  }
  return { ok: true, path: clean, kind: cls.kind, reason: cls.reason };
}

export const isReadable = (path) => classifyPath(path).kind !== 'protected';

/* ---------- test integrity ----------
 * An agent may write tests; it may not make a failing implementation look successful by deleting,
 * skipping or weakening the tests that catch it. We compare the candidate against the baseline and
 * refuse to auto-promote when the evidence got thinner. The comparison is deliberately conservative:
 * it would rather ask a human than stay quiet.
 */
const TEST_FILE = /(^|\/)(scripts\/[\w-]*-test\.mjs|[\w.-]+\.test\.(mjs|js|ts))$/;
const ASSERTION = /\b(assert|check|expect|it|test)\s*\(/g;
const WEAKENING = [/\b(it|test|describe)\.only\s*\(/, /\b(it|test)\.skip\s*\(/, /--test-only\b/, /\bxit\s*\(/, /\bxdescribe\s*\(/];

export const isTestFile = (path) => TEST_FILE.test(String(path || ''));

export function checkTestIntegrity({ baseline = {}, candidate = {} } = {}) {
  const findings = [];
  const testPaths = new Set([...Object.keys(baseline), ...Object.keys(candidate)].filter(isTestFile));
  for (const path of testPaths) {
    const before = baseline[path];
    const after = candidate[path];
    if (before !== undefined && after === undefined) {
      findings.push({ kind: 'test-removed', path, severity: 'block', detail: 'The candidate deletes a test file. Removing the test that catches a defect is not a fix.' });
      continue;
    }
    if (before === undefined) continue; // a brand-new test file is good news
    const countBefore = (String(before).match(ASSERTION) || []).length;
    const countAfter = (String(after).match(ASSERTION) || []).length;
    if (countAfter < countBefore) {
      findings.push({ kind: 'assertions-reduced', path, severity: 'review', detail: `Assertions fell from ${countBefore} to ${countAfter}. A test may change, but the change must be explained and reviewed.` });
    }
    for (const re of WEAKENING) {
      const wasThere = re.test(String(before));
      const isThere = re.test(String(after));
      if (isThere && !wasThere) {
        findings.push({ kind: 'focus-or-skip', path, severity: 'review', detail: `The candidate adds ${re.source} — a way to run fewer tests than the suite declares.` });
      }
    }
  }
  const blocking = findings.filter((f) => f.severity === 'block');
  return {
    ok: blocking.length === 0,
    blocking,
    review: findings.filter((f) => f.severity === 'review'),
    findings,
    note: findings.length ? 'Test evidence changed; independent review is required before promotion.' : 'No test was removed, skipped or weakened.',
  };
}

/* ---------- risk ---------- */

export function classifyRisk({ changes = {}, integrity = { findings: [] }, diffLines = 0, testsPassed = false, scope = [] } = {}) {
  const paths = Object.keys(changes || {});
  const classes = paths.map((p) => ({ path: p, ...classifyPath(p) }));
  const protectedHit = classes.find((c) => c.kind === 'protected');
  const sensitiveHit = classes.find((c) => c.kind === 'sensitive');
  const ownDir = paths.length > 0 && paths.every((p) => matchesScope(p, scope) && /^agents\//.test(p));

  if (protectedHit) return { level: 'high', reason: `touches a protected component (${protectedHit.path})`, protected: true };
  if (integrity.findings?.length) return { level: 'high', reason: 'changes the test evidence' };
  if (sensitiveHit) return { level: 'elevated', reason: `touches ${sensitiveHit.reason}` };
  if (paths.length > 8 || diffLines > 400) return { level: 'elevated', reason: `large change (${paths.length} files, ${diffLines} diff lines)` };
  if (!testsPassed) return { level: 'elevated', reason: 'tests have not passed' };
  if (!ownDir) return { level: 'elevated', reason: 'writes outside the agent’s own implementation directory' };
  return { level: 'low', reason: 'small change, inside the agent’s own scope, with passing tests and untouched test evidence' };
}

/* ---------- sandbox command allowlist ----------
 * The sandbox runs commands with resource limits, a scrubbed environment and the workspace as cwd.
 * It is process-level isolation on the gateway host — not a container — and says so.
 */
export const SANDBOX_COMMANDS = Object.freeze([
  { re: /^node --check [\w./-]+$/, label: 'syntax check' },
  { re: /^node [\w./-]+\.mjs( [\w./=-]+)*$/, label: 'node script' },
  { re: /^npm run test[\w:-]*( -- .*)?$/, label: 'npm test script' },
]);

export function checkSandboxCommand(command) {
  const clean = String(command || '').trim().replace(/\s+/g, ' ');
  if (!clean) return { ok: false, reason: 'no command given' };
  if (/[;&|`$><\n\\]/.test(clean)) return { ok: false, reason: 'shell metacharacters are refused — the sandbox runs one command, not a shell line' };
  const match = SANDBOX_COMMANDS.find((entry) => entry.re.test(clean));
  if (!match) {
    return { ok: false, reason: `“${clean.slice(0, 80)}” is not in the sandbox allowlist (${SANDBOX_COMMANDS.map((c) => c.label).join(', ')})` };
  }
  return { ok: true, command: clean, label: match.label };
}

/* ---------- honest status vocabulary ---------- */

export const EXPERIMENT_STATUS = Object.freeze({
  PROPOSED: 'proposed',
  WORKSPACE_READY: 'workspace_ready',
  MODIFIED: 'modified',
  TESTING: 'testing',
  TEST_FAILED: 'test_failed',
  REVIEW_REQUIRED: 'review_required',
  REVIEWED: 'reviewed',
  COMPARED: 'compared',
  STAGED: 'staged',
  APPROVED: 'approved',
  DEPLOYED: 'deployed',
  ROLLED_BACK: 'rolled_back',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  BLOCKED: 'blocked',
});

export const TERMINAL_STATUS = Object.freeze([
  EXPERIMENT_STATUS.DEPLOYED, EXPERIMENT_STATUS.ROLLED_BACK, EXPERIMENT_STATUS.REJECTED,
  EXPERIMENT_STATUS.CANCELLED, EXPERIMENT_STATUS.BLOCKED,
]);

export const STATUS_LABEL = Object.freeze({
  proposed: 'Proposed',
  workspace_ready: 'Working copy ready',
  modified: 'Being modified',
  testing: 'Testing',
  test_failed: 'Tests failed',
  review_required: 'Review required',
  reviewed: 'Reviewed',
  compared: 'Compared',
  staged: 'Staged',
  approved: 'Approved',
  deployed: 'Deployed',
  rolled_back: 'Rolled back',
  rejected: 'Rejected',
  cancelled: 'Stopped',
  blocked: 'Blocked',
});

export const isTerminal = (status) => TERMINAL_STATUS.includes(status);

/** Every experiment stores the authority it was created under, so a later level change cannot rewrite history. */
export const levelCapabilities = (level) => ({ ...levelOf(level).can });
