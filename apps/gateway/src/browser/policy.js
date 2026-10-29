/* ============ Agent Browser — policy, budgets and honest states ============
 * Everything in this file is a *rule*, not an implementation. Keeping the rules in one place is what
 * makes the invariants testable:
 *
 *   • a page that stays open is not progress;
 *   • a retry is only allowed when it is safe and materially different;
 *   • a website that refuses the agent is an outcome, not an obstacle to defeat;
 *   • "completed" requires an evidence row per success criterion.
 *
 * Nothing here solves CAPTCHAs, extracts credentials, alters fingerprints to defeat a site's
 * protections, or bypasses an access control. Those are out of scope by design, not by omission.
 */

/** Task lifecycle. `RECOVERING` and `WAITING_FOR_USER` are first-class, not error states. */
export const STATES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  RECOVERING: 'recovering',
  WAITING_FOR_USER: 'waiting_for_user',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  BLOCKED: 'blocked',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out',
});

export const TERMINAL = Object.freeze([
  STATES.COMPLETED, STATES.FAILED, STATES.BLOCKED, STATES.CANCELLED, STATES.TIMED_OUT,
]);

/** States the ticker may advance. Everything else waits for a human or is finished. */
export const ACTIVE = Object.freeze([STATES.QUEUED, STATES.RUNNING, STATES.RECOVERING]);

export const isTerminal = (status) => TERMINAL.includes(status);
export const isActive = (status) => ACTIVE.includes(status);

export function canTransition(from, to) {
  if (from === to) return true;
  if (isTerminal(from)) return false;
  const allowed = {
    queued: ['running', 'paused', 'cancelled', 'blocked', 'failed', 'timed_out'],
    running: ['recovering', 'waiting_for_user', 'paused', 'completed', 'failed', 'blocked', 'cancelled', 'timed_out'],
    recovering: ['running', 'waiting_for_user', 'paused', 'failed', 'blocked', 'cancelled', 'timed_out'],
    waiting_for_user: ['running', 'paused', 'cancelled', 'failed', 'timed_out'],
    paused: ['running', 'recovering', 'cancelled', 'timed_out'],
  };
  return Boolean(allowed[from]?.includes(to));
}

export const DEFAULT_LIMITS = Object.freeze({
  actionTimeoutMs: Number(process.env.MMM_BROWSER_ACTION_TIMEOUT_MS || 20000),
  stallAfterMs: Number(process.env.MMM_BROWSER_STALL_MS || 45000),
  deadlineMs: Number(process.env.MMM_BROWSER_DEADLINE_MS || 2 * 60 * 60 * 1000),
  maxRetries: 8,
  maxConsecutiveFailures: 3,
  maxActions: 120,
  maxSteps: 200,
  maxLoops: 3,
  maxEvidenceBytes: 4 * 1024 * 1024,
  maxScreenshotBytes: 512 * 1024,
  maxTabs: 4,
  settleMs: 400,
});

/* ---------- actions the runner understands ---------- */

export const ACTIONS = Object.freeze([
  'goto', 'wait', 'waitFor', 'click', 'type', 'extract', 'screenshot', 'assert',
]);

/**
 * A step is one instruction. `sensitive` marks an action that must never be retried blindly
 * (purchase, payment, submission, account change). `idempotent` says whether repeating it is safe;
 * the runner refuses to retry when it cannot prove the action did not already land.
 */
export function normaliseStep(step, index) {
  const action = String(step?.action || '').toLowerCase();
  if (!ACTIONS.includes(action)) throw new Error(`unknown step action: ${step?.action}`);
  return {
    id: String(step.id || `s${index + 1}`),
    action,
    describe: String(step.describe || step.description || '').slice(0, 200),
    url: step.url ? String(step.url).slice(0, 2000) : '',
    selector: step.selector ? String(step.selector).slice(0, 500) : '',
    text: step.text === undefined ? '' : String(step.text).slice(0, 2000),
    key: step.key ? String(step.key).slice(0, 80) : '',
    expect: step.expect ? String(step.expect).slice(0, 300) : '',
    method: step.method ? String(step.method) : '',
    timeoutMs: Math.min(Math.max(Number(step.timeoutMs) || 0, 0), 180000) || null,
    ms: Math.min(Math.max(Number(step.ms) || 0, 0), 60000),
    sensitive: Boolean(step.sensitive),
    idempotent: step.idempotent === undefined ? !step.sensitive : Boolean(step.idempotent),
    optional: Boolean(step.optional),
  };
}

export function normalisePlan(plan) {
  const list = Array.isArray(plan) ? plan : [];
  if (list.length > DEFAULT_LIMITS.maxSteps) throw new Error(`plan has more than ${DEFAULT_LIMITS.maxSteps} steps`);
  return list.map(normaliseStep);
}

export function normaliseCriteria(criteria) {
  const list = Array.isArray(criteria) ? criteria : [];
  return list.slice(0, 20).map((c, i) => ({
    key: String(c?.key || `c${i + 1}`).slice(0, 80),
    expect: String(c?.expect || '').slice(0, 300),
    describe: String(c?.describe || c?.expect || '').slice(0, 200),
  }));
}

/* ---------- refusal signals ----------
 * A website saying "no" is an outcome. These are the signals a driver may raise; the runner maps
 * them to BLOCKED (or WAITING_FOR_USER for a login wall) and stops retrying immediately.
 */
export const BLOCK_KINDS = Object.freeze({
  CAPTCHA: 'captcha',
  RATE_LIMIT: 'rate_limit',
  FORBIDDEN: 'forbidden',
  PAYWALL: 'paywall',
  LOGIN: 'login',
  ROBOTS: 'robots',
  OTHER: 'restriction',
});

/** Text a page shows when it refuses an automated client. Matched case-insensitively. */
export const BLOCK_SIGNALS = [
  { kind: BLOCK_KINDS.CAPTCHA, re: /(captcha|are you a robot|verify you are human|cf-challenge|hcaptcha|recaptcha)/i },
  { kind: BLOCK_KINDS.RATE_LIMIT, re: /(too many requests|rate limit|slow down|429)/i },
  { kind: BLOCK_KINDS.FORBIDDEN, re: /(access denied|403 forbidden|not authorised for this server|blocked by)/i },
  { kind: BLOCK_KINDS.LOGIN, re: /(sign in required|log ?in required|please log in|session expired|authentication required)/i },
  { kind: BLOCK_KINDS.PAYWALL, re: /(subscribe to continue|subscriber[- ]only|paywall)/i },
];

export function detectBlock(text, statusCode = 0) {
  if (statusCode === 429) return { kind: BLOCK_KINDS.RATE_LIMIT, signal: 'HTTP 429' };
  if (statusCode === 403) return { kind: BLOCK_KINDS.FORBIDDEN, signal: 'HTTP 403' };
  if (statusCode === 401) return { kind: BLOCK_KINDS.LOGIN, signal: 'HTTP 401' };
  const haystack = String(text || '').slice(0, 20000);
  for (const { kind, re } of BLOCK_SIGNALS) {
    const match = haystack.match(re);
    if (match) return { kind, signal: match[0].slice(0, 80) };
  }
  return null;
}

/**
 * A block is never "recovered" by defeating it. The only legitimate responses are: stop, ask the
 * user, or use an alternative the task declared up front.
 */
export function blockOutcome(kind) {
  if (kind === BLOCK_KINDS.LOGIN) {
    return {
      status: STATES.WAITING_FOR_USER,
      message: 'The site requires you to sign in again. The agent will not attempt to bypass authentication.',
      retryable: false,
    };
  }
  return {
    status: STATES.BLOCKED,
    message: `The site refused the agent (${kind}). Retrying the rejected action would be circumvention, so the task stopped and kept what it had already verified.`,
    retryable: false,
  };
}

/* ---------- recovery ladder (spec §4) ----------
 * Ordered, bounded, and state-aware: an attempt that already failed for this obstacle is skipped the
 * second time round, so the agent cannot loop through the same seven ideas forever.
 */
export const RECOVERY_LADDER = Object.freeze([
  { id: 'settle', label: 'Wait for the expected page state', max: 2 },
  { id: 'inspect', label: 'Re-inspect the page snapshot', max: 2 },
  { id: 'refresh', label: 'Refresh the page (only when safe)', max: 1 },
  { id: 'relocate', label: 'Locate the target element again', max: 2 },
  { id: 'alternate-interaction', label: 'Retry with a different interaction method', max: 1 },
  { id: 'alternate-source', label: 'Try the alternative source declared by the task', max: 1 },
]);

/** The ladder is filtered per obstacle: a 403 is not fixable by refreshing. */
export function ladderFor(obstacle) {
  const blocked = ['restriction', 'captcha', 'rate_limit', 'forbidden', 'login', 'paywall'];
  if (blocked.includes(obstacle)) return [];
  if (obstacle === 'not_found') return RECOVERY_LADDER.filter((s) => ['settle', 'inspect', 'relocate', 'alternate-source'].includes(s.id));
  return RECOVERY_LADDER.slice();
}

/* ---------- sensitive actions ---------- */

const SENSITIVE_RE = /(pay|purchase|checkout|buy|order|submit|confirm|transfer|withdraw|delete|remove|unsubscribe|cancel[- ]subscription|change[- ]password|invite|send)/i;

/**
 * A step the UI marked sensitive, or one whose description reads like a commitment. Never retried
 * automatically: a duplicate payment is worse than a failed task.
 */
export function isSensitiveStep(step) {
  if (!step) return false;
  if (step.sensitive) return true;
  return SENSITIVE_RE.test(`${step.describe} ${step.selector} ${step.text}`);
}

/* ---------- resource limits ---------- */

export function resourceProblem(task, usage = {}) {
  const limits = DEFAULT_LIMITS;
  if (task.actions_used >= task.max_actions) return { kind: 'actions', message: `Action budget exhausted (${task.max_actions}).` };
  if (task.evidence_bytes >= task.max_evidence_bytes) return { kind: 'evidence', message: `Evidence storage cap reached (${Math.round(task.max_evidence_bytes / 1024)} KB).` };
  if ((usage.tabs || 0) > limits.maxTabs) return { kind: 'tabs', message: `More than ${limits.maxTabs} tabs are open.` };
  if (usage.memoryMB && usage.memoryMB > (usage.memoryLimitMB || 2048)) return { kind: 'memory', message: 'Browser memory limit reached.' };
  return null;
}

/** Short, stable label for a task state, used by the API and the UI. */
export const STATE_LABEL = Object.freeze({
  queued: 'Queued',
  running: 'Running',
  recovering: 'Recovering',
  waiting_for_user: 'Needs you',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  blocked: 'Blocked',
  cancelled: 'Stopped',
  timed_out: 'Timed out',
});
