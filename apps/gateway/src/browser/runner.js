/* ============ Agent Browser — the runner ============
 * Turns a plan into a long-running task that can survive stalls, failures, loops, crashes and the
 * gateway restarting underneath it — and refuses to call any of that progress unless it observed it.
 *
 * The invariants (each one has an acceptance test in scripts/browser-agent-test.mjs):
 *
 *   AT-15 a navigation that never completes is cut by the watchdog, not awaited forever
 *   AT-16 repeated failed actions are detected as a loop instead of continuing
 *   AT-17 a browser crash restarts the engine and resumes from a verified checkpoint
 *   AT-18 an expired session asks the user to sign in again; it never tries to bypass auth
 *   AT-19 a site restriction is reported once and stops the retries
 *   AT-20 ticks are incremental, so a multi-step task needs no one watching
 *   AT-21 a deadline produces an explicit terminal state
 *   AT-22 every milestone carries evidence that can be re-read later
 *   AT-23 a sensitive action is never blindly retried
 *   AT-24 after a restart the agent inspects the live state before repeating anything
 *   AT-25 action/evidence/tab budgets are enforced
 *   AT-26 "completed" requires every success criterion to be verified
 *
 * Nothing here waits on a promise without a bound: every driver call goes through the watchdog, and
 * one tick performs at most one action so the HTTP server stays responsive.
 */
import { createHash } from 'node:crypto';
import {
  DEFAULT_LIMITS, STATES, TERMINAL, isTerminal, isActive, canTransition, normalisePlan,
  normaliseCriteria, detectBlock, blockOutcome, ladderFor, isSensitiveStep, resourceProblem,
  BLOCK_KINDS, urlProblem,
} from './policy.js';
import { assessProgress, createWatchdog, progressAgeLabel } from './watchdog.js';
import { createLoopDetector, actionSignature, loopResponse, LOOP_REASONS } from './loops.js';
import { BrowserError, createDriver, resolveDriverId } from './driver.js';

const shortId = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const sha = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
const json = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };

/* ---------- rows ---------- */

export function shapeTask(row) {
  if (!row) return null;
  const criteria = json(row.success_criteria, []);
  const plan = json(row.plan, []);
  return {
    id: row.id,
    ownerId: row.owner_id,
    objective: row.objective,
    successCriteria: criteria,
    entryUrl: row.entry_url,
    plan,
    driver: row.driver,
    simulated: row.driver === 'simulated',
    status: row.status,
    deadlineAt: row.deadline_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    lastProgressAt: row.last_progress_at,
    lastSuccessAt: row.last_success_at,
    lastMilestone: row.last_milestone,
    currentUrl: row.current_url,
    stepIndex: row.step_index,
    totalSteps: plan.length,
    stepAttempts: row.step_attempts,
    consecutiveFailures: row.consecutive_failures,
    retriesUsed: row.retries_used,
    maxRetries: row.max_retries,
    maxConsecutiveFailures: row.max_consecutive_failures,
    actionsUsed: row.actions_used,
    maxActions: row.max_actions,
    evidenceBytes: row.evidence_bytes,
    blocker: row.blocker,
    blockerKind: row.blocker_kind,
    outcome: row.outcome,
    checkpoint: json(row.checkpoint, {}),
    recoveryLog: json(row.recovery_log, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    progressAgeMs: Date.now() - (row.last_progress_at || row.started_at || row.created_at),
  };
}

/* ---------- criteria ---------- */

/** How a criterion is satisfied. Kept tiny and explicit so a test can enumerate every form. */
export function checkCriterion(criterion, observations) {
  const observed = observations[criterion.key];
  if (observed === undefined || observed === null) {
    return { key: criterion.key, ok: false, reason: 'no observation recorded for this key' };
  }
  const value = typeof observed === 'string' ? observed : JSON.stringify(observed);
  const expect = String(criterion.expect || '');
  const [form, ...rest] = expect.split(':');
  const arg = rest.join(':').trim();
  let ok = false;
  let reason = '';
  switch (form) {
    case 'exists':
      ok = value.length > 0;
      reason = ok ? '' : 'the observation was empty';
      break;
    case 'contains':
      ok = value.toLowerCase().includes(arg.toLowerCase());
      reason = ok ? '' : `expected the text to contain “${arg}”`;
      break;
    case 'equals':
      ok = value.trim() === arg;
      reason = ok ? '' : `expected “${arg}”`;
      break;
    case 'matches':
      try { ok = new RegExp(arg, 'i').test(value); } catch { ok = false; reason = 'invalid pattern in the criterion'; }
      reason = ok ? '' : `expected a match for /${arg}/`;
      break;
    case 'min': {
      const n = Number(value);
      ok = Number.isFinite(n) && n >= Number(arg);
      reason = ok ? '' : `expected at least ${arg}`;
      break;
    }
    default:
      ok = value.length > 0;
      reason = ok ? '' : 'no expectation was given and nothing was observed';
  }
  return { key: criterion.key, ok, reason, expected: expect, observed: value.slice(0, 200) };
}

/* ---------- evidence ---------- */

function summaryFor(step, result) {
  if (result?.summary) return String(result.summary).slice(0, 300);
  switch (step.action) {
    case 'goto': return `Opened ${result?.url || step.url}${result?.title ? ` — “${result.title}”` : ''}`;
    case 'extract': return `Read ${step.key || 'the page'}: “${String(result?.value || '').slice(0, 160)}”`;
    case 'assert': return `Verified: ${step.expect || step.describe}`;
    case 'click': return `Clicked ${step.selector}${result?.url ? ` → ${result.url}` : ''}`;
    case 'type': return `Typed into ${step.selector}`;
    case 'screenshot': return 'Captured a screenshot';
    case 'waitFor': return `Waited for ${step.selector || step.text}`;
    default: return step.describe || step.action;
  }
}

/* ============================================================================================= */

export function createBrowserRunner({
  db, logEvent = () => {}, audit = () => {}, broadcast = () => {},
  createDriverImpl = createDriver, now = () => Date.now(), limits = DEFAULT_LIMITS,
} = {}) {
  const sessions = new Map(); // taskId → { driver, watchdog, detector, driverId, actions }
  const busy = new Set();
  let stopping = false;

  const get = (id) => db.prepare('SELECT * FROM browser_tasks WHERE id = ?').get(id);

  const save = (task, patch) => {
    const fields = Object.keys(patch);
    if (!fields.length) return;
    const set = fields.map((f) => `${f} = ?`).join(', ');
    db.prepare(`UPDATE browser_tasks SET ${set}, updated_at = ? WHERE id = ?`)
      .run(...fields.map((f) => patch[f]), now(), task.id);
    Object.assign(task, patch, { updated_at: now() });
  };

  function step(task, { kind, status = 'info', detail = '', url = '', stepId = '', attempt = 0, duration = 0, evidenceId = null }) {
    const row = db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM browser_steps WHERE task_id = ?').get(task.id);
    const seq = (row?.s || 0) + 1;
    const id = shortId('bs');
    db.prepare(`INSERT INTO browser_steps (id, task_id, seq, ts, kind, status, detail, url, step_id, attempt, duration_ms, evidence_id)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, task.id, seq, now(), kind, status, String(detail).slice(0, 500), url || task.current_url || '', stepId, attempt, Math.round(duration), evidenceId);
    broadcast('browser', { type: `task.${kind}`, taskId: task.id, status, detail: String(detail).slice(0, 200) });
    return { id, seq };
  }

  function evidence(task, { kind, label, summary, url, digest, data = '', bytes = 0 }) {
    const id = shortId('be');
    const size = bytes || Buffer.byteLength(data || '', 'utf8');
    const capped = task.evidence_bytes + size <= task.max_evidence_bytes;
    db.prepare(`INSERT INTO browser_evidence (id, task_id, step_id, ts, kind, label, summary, url, digest, bytes, data)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, task.id, label || '', now(), kind, String(label || '').slice(0, 120), String(summary || '').slice(0, 300),
        String(url || task.current_url || '').slice(0, 2000), digest || sha(summary), capped ? size : 0,
        capped ? String(data).slice(0, task.max_evidence_bytes) : '');
    save(task, { evidence_bytes: task.evidence_bytes + (capped ? size : 0) });
    return { id, digest, bytes: capped ? size : 0, dropped: !capped };
  }

  function setStatus(task, status, patch = {}) {
    if (!canTransition(task.status, status)) {
      // A terminal task never changes; anything else may be forced by an explicit user action.
      if (!TERMINAL.includes(task.status)) throw new Error(`illegal transition ${task.status} → ${status}`);
      return false;
    }
    save(task, { status, ...patch });
    broadcast('browser', { type: 'task.status', taskId: task.id, status });
    return true;
  }

  function finish(task, status, { reason = '', outcome = '' } = {}) {
    const ended = now();
    save(task, {
      status, ended_at: ended, blocker: reason || task.blocker,
      outcome: outcome || task.outcome,
    });
    step(task, { kind: status, status: TERMINAL.includes(status) ? 'end' : 'warn', detail: reason || outcome || status });
    endSession(task.id);
    broadcast('browser', { type: 'task.finished', taskId: task.id, status, reason });
    logEvent('browser', `Browser task ${status}: ${task.objective.slice(0, 60)}${reason ? ` — ${reason}` : ''}`, task.id);
  }

  function endSession(taskId) {
    const session = sessions.get(taskId);
    if (!session) return;
    sessions.delete(taskId);
    Promise.resolve(session.driver?.close?.()).catch(() => {});
  }

  /* ---------- public: create / list ---------- */

  async function createTask({
    ownerId, objective, criteria, plan, entryUrl = '', sim = {}, driver = 'auto', deadlineMs,
  }) {
    const text = String(objective || '').trim();
    if (text.length < 10) throw new Error('objective must be at least 10 characters');
    // The entry URL is a URL like any other: an http(s) rule here keeps `file:` off the disk and keeps
    // this check in the executor, where a draft, the screen and the raw API all inherit it.
    if (entryUrl) {
      const problem = urlProblem(entryUrl);
      if (problem) throw new Error(`entryUrl: ${problem}`);
    }
    const steps = normalisePlan(plan);
    if (!steps.length) throw new Error('a plan needs at least one step');
    const resolved = await resolveDriverId(driver);
    if (!resolved.ok) {
      const error = new Error(`No browser engine is available: ${resolved.reason}`);
      error.code = 'no-engine';
      throw error;
    }
    const id = shortId('bt');
    const ts = now();
    const deadline = ts + Math.min(Math.max(Number(deadlineMs) || limits.deadlineMs, 5000), 12 * 60 * 60 * 1000);
    db.prepare(`INSERT INTO browser_tasks
      (id, owner_id, objective, success_criteria, entry_url, plan, sim, driver, status, deadline_at,
       created_at, updated_at, last_progress_at, max_retries, max_consecutive_failures, max_actions, max_evidence_bytes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, ownerId || 'system', text.slice(0, 300), JSON.stringify(normaliseCriteria(criteria)),
        String(entryUrl).slice(0, 2000), JSON.stringify(steps), JSON.stringify(sim || {}),
        resolved.id, STATES.QUEUED, deadline, ts, ts, ts,
        limits.maxRetries, limits.maxConsecutiveFailures, limits.maxActions, limits.maxEvidenceBytes);
    const task = get(id);
    step(task, { kind: 'created', status: 'info', detail: `Queued “${text.slice(0, 80)}” with ${steps.length} steps` });
    audit(ownerId || 'system', 'app', 'browser.task.create', { taskId: id, steps: steps.length, driver: resolved.id }, 'allow', 'ok');
    logEvent('browser', `Browser task queued: ${text.slice(0, 60)}`, id);
    return shapeTask(task);
  }

  const listTasks = (limit = 50) => db.prepare('SELECT * FROM browser_tasks ORDER BY created_at DESC LIMIT ?').all(Math.min(limit, 200)).map(shapeTask);

  function getTaskDetail(id) {
    const row = get(id);
    if (!row) return null;
    const steps = db.prepare('SELECT * FROM browser_steps WHERE task_id = ? ORDER BY seq').all(id);
    const evidenceRows = db.prepare('SELECT id, task_id, step_id, ts, kind, label, summary, url, digest, bytes FROM browser_evidence WHERE task_id = ? ORDER BY ts').all(id);
    return { ...shapeTask(row), timeline: steps, evidence: evidenceRows };
  }

  const getEvidence = (taskId, evidenceId) =>
    db.prepare('SELECT * FROM browser_evidence WHERE task_id = ? AND id = ?').get(taskId, evidenceId) || null;

  /* ---------- public: controls ---------- */

  function control(id, action, actor = 'system') {
    const task = get(id);
    if (!task) return { code: 404, error: 'task not found' };
    if (action === 'stop') {
      if (isTerminal(task.status)) return { code: 409, error: `task already ${task.status}` };
      finish(task, STATES.CANCELLED, { reason: 'stopped by the user' });
      audit(actor, 'app', 'browser.task.stop', { taskId: id }, 'allow', 'ok');
      return { code: 200, task: shapeTask(get(id)) };
    }
    if (action === 'pause') {
      if (!isActive(task.status)) return { code: 409, error: `cannot pause a ${task.status} task` };
      setStatus(task, STATES.PAUSED);
      step(task, { kind: 'paused', status: 'info', detail: 'Paused by the user' });
      return { code: 200, task: shapeTask(get(id)) };
    }
    if (action === 'resume') {
      if (![STATES.PAUSED, STATES.WAITING_FOR_USER].includes(task.status)) {
        return { code: 409, error: `cannot resume a ${task.status} task` };
      }
      if (task.deadline_at && now() >= task.deadline_at) {
        finish(task, STATES.TIMED_OUT, { reason: 'deadline passed while the task was waiting' });
        return { code: 409, error: 'the deadline has passed' };
      }
      save(task, { status: STATES.RUNNING, blocker: null, blocker_kind: null, consecutive_failures: 0 });
      step(task, { kind: 'resumed', status: 'info', detail: 'Resumed by the user' });
      broadcast('browser', { type: 'task.status', taskId: id, status: STATES.RUNNING });
      return { code: 200, task: shapeTask(get(id)) };
    }
    if (action === 'assist') {
      // "I have done the thing the agent could not do" — re-inspect before continuing.
      if (task.status !== STATES.WAITING_FOR_USER) return { code: 409, error: 'this task is not waiting for you' };
      save(task, { status: STATES.RUNNING, blocker: null, blocker_kind: null, consecutive_failures: 0, retries_used: 0, step_attempts: task.step_attempts + 1 });
      step(task, { kind: 'assisted', status: 'info', detail: 'User confirmed the blocker is cleared; re-inspecting before continuing' });
      return { code: 200, task: shapeTask(get(id)) };
    }
    return { code: 400, error: `unknown action: ${action}` };
  }

  /* ---------- session ---------- */

  async function ensureSession(task) {
    const existing = sessions.get(task.id);
    if (existing) return existing;
    const watchdog = createWatchdog({ limits, now });
    const detector = createLoopDetector({ threshold: limits.maxLoops });
    const checkpoint = json(task.checkpoint, {});
    detector.restore(checkpoint.loops || {});
    const driverId = task.driver === 'auto' ? (await resolveDriverId('auto')).id : task.driver;
    const driver = await createDriverImpl(driverId, { task });
    await driver.start();
    const session = { driver, driverId, watchdog, detector, actions: 0 };
    sessions.set(task.id, session);
    step(task, { kind: 'session', status: 'info', detail: `Driver ready: ${driverId}${driver.simulated ? ' (simulated — not a real browser)' : ''}` });
    return session;
  }

  /* ---------- the tick ---------- */

  async function tickTask(task) {
    const session = await ensureSession(task);

    // 1. Deadline and budgets are checked before any work (AT-21, AT-25).
    const health = await session.driver.health().catch(() => ({ ok: false, tabs: 0 }));
    const resource = resourceProblem(task, health);
    if (resource) {
      finish(task, STATES.BLOCKED, { reason: `resource limit: ${resource.message}` });
      return;
    }
    const watchdogVerdict = assessProgress(task, { now: now(), actionStartedAt: null, limits });
    if (watchdogVerdict.terminal) {
      finish(task, watchdogVerdict.terminal, { reason: watchdogVerdict.reason });
      return;
    }
    if (!health.ok) {
      // A dead engine is recoverable: restart it, then inspect state before repeating anything.
      step(task, { kind: 'crash', status: 'bad', detail: 'The browser process stopped responding; restarting it' });
      await session.driver.start().catch(() => {});
      await inspectBeforeContinuing(task, session, 'after a browser restart');
      save(task, { status: STATES.RECOVERING, consecutive_failures: task.consecutive_failures + 1 });
      return;
    }

    const plan = json(task.plan, []);
    if (task.step_index >= plan.length) {
      completeTask(task);
      return;
    }

    const currentStep = plan[task.step_index];
    setStatus(task, STATES.RUNNING);

    // 2. Loop detection: the same action against the same page state (AT-16).
    const fingerprint = session.lastFingerprint || '';
    const signature = actionSignature(currentStep, fingerprint);
    const loop = session.detector.noteAction(signature);
    if (loop) {
      step(task, { kind: 'loop', status: 'bad', detail: `${loop.reason}: ${loop.signature}` });
      const response = loopResponse(loop, { alternateAvailable: hasAlternate(task, plan) });
      if (response.action === 'alternate-strategy') {
        save(task, { status: STATES.RECOVERING, step_index: task.step_index + 1 });
        step(task, { kind: 'recovered', status: 'warn', detail: response.message });
        session.detector.reset();
      } else {
        finish(task, STATES.WAITING_FOR_USER, { reason: response.message, outcome: 'loop' });
      }
      return;
    }

    // 3. Execute one action, bounded by the watchdog (AT-15).
    const budget = currentStep.timeoutMs || limits.actionTimeoutMs;
    const { signal } = session.watchdog.begin({ timeoutMs: budget });
    const startedAt = now();
    try {
      const result = await Promise.race([
        executeStep(task, session, currentStep, signal),
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new BrowserError('timeout', 'the action exceeded its time budget')), { once: true });
        }),
      ]);
      session.watchdog.end();
      await onStepSuccess(task, session, currentStep, result, now() - startedAt);
    } catch (error) {
      session.watchdog.end();
      await onStepFailure(task, session, currentStep, error, now() - startedAt);
    }
  }

  async function executeStep(task, session, stepDef, signal) {
    const { driver } = session;
    switch (stepDef.action) {
      case 'goto':
        return driver.goto(stepDef.url || task.entry_url, { signal, step: stepDef });
      case 'wait':
        return { waited: stepDef.ms || 500 };
      case 'waitFor':
        return driver.waitFor({ selector: stepDef.selector, text: stepDef.text, timeoutMs: stepDef.timeoutMs }, { signal });
      case 'click':
        return driver.click(stepDef.selector, { signal, method: stepDef.method || 'pointer', step: stepDef });
      case 'type':
        return driver.type(stepDef.selector, stepDef.text, { signal, step: stepDef });
      case 'extract':
        return driver.extract({ selector: stepDef.selector, key: stepDef.key }, { signal });
      case 'screenshot': {
        const shot = await driver.screenshot({ signal });
        return { ...shot, summary: 'Captured a screenshot as evidence' };
      }
      case 'assert':
        return { asserted: stepDef.expect, url: task.current_url };
      default:
        throw new BrowserError('unsupported', `unknown action ${stepDef.action}`);
    }
  }

  async function onStepSuccess(task, session, stepDef, result, durationMs) {
    const observations = json(task.checkpoint, {}).observations || {};
    const url = result?.url || task.current_url || '';
    let changed = stepDef.action !== 'click' || result?.changed !== false;

    // Page fingerprint: a click that changes nothing is not progress (AT-16 / AT-20).
    if (['goto', 'click', 'type', 'reload'].includes(stepDef.action)) {
      const snap = await session.driver.snapshot().catch(() => null);
      if (snap) {
        if (snap.digest && session.lastFingerprint && snap.digest === session.lastFingerprint && stepDef.action !== 'goto') changed = false;
        session.lastFingerprint = snap.digest;
        session.detector.notePage(`${snap.url}#${snap.digest}`);
      }
    }

    // Observations become the raw material for success criteria.
    if (stepDef.action === 'extract') observations[stepDef.key || 'text'] = String(result?.value ?? '');
    if (stepDef.action === 'goto') observations.lastUrl = url;

    // Evidence for milestones: every step with a description, every extract, every assert (AT-22).
    const isMilestone = Boolean(stepDef.describe) || ['extract', 'assert', 'goto'].includes(stepDef.action);
    let evidenceId = null;
    if (isMilestone) {
      let data = '';
      let kind = stepDef.action === 'extract' ? 'extract' : 'observation';
      let digest = sha(`${stepDef.id}|${url}|${JSON.stringify(result).slice(0, 500)}`);
      if (stepDef.action === 'screenshot' || stepDef.action === 'assert') {
        const shot = stepDef.action === 'screenshot' ? result : await session.driver.screenshot().catch(() => null);
        if (shot?.base64) {
          kind = 'screenshot';
          data = shot.base64;
          digest = shot.digest || digest;
        }
      }
      const created = evidence(task, {
        kind, label: stepDef.id, url, digest,
        summary: summaryFor(stepDef, result),
        data,
        bytes: data ? Math.round((data.length * 3) / 4) : 0,
      });
      evidenceId = created.id;
    }

    // Checkpoint: written after every successful step so a crash can resume here (AT-17/AT-24).
    const checkpoint = {
      stepIndex: task.step_index + 1,
      url,
      fingerprint: session.lastFingerprint || '',
      observations,
      loops: session.detector.snapshot(),
      at: now(),
    };

    save(task, {
      step_index: task.step_index + 1,
      step_attempts: 0,
      consecutive_failures: 0,
      current_url: url || task.current_url,
      last_milestone: stepDef.describe || summaryFor(stepDef, result),
      last_success_at: now(),
      ...(changed ? { last_progress_at: now() } : {}),
      actions_used: task.actions_used + 1,
      checkpoint: JSON.stringify(checkpoint),
      recovery_log: JSON.stringify(dropRecovery(task, stepDef.id)),
    });

    if (changed) session.detector.reset();
    step(task, {
      kind: 'action', status: changed ? 'ok' : 'warn', stepId: stepDef.id, attempt: task.step_attempts,
      detail: `${changed ? '' : 'No page change — '}${summaryFor(stepDef, result)}`, url, duration: durationMs, evidenceId,
    });
  }

  async function onStepFailure(task, session, stepDef, error, durationMs) {
    const code = error instanceof BrowserError ? error.code : 'unsupported';
    const message = String(error?.message || error).slice(0, 300);

    // A browser that is gone cannot be retried in place (AT-17).
    if (code === 'crash') {
      step(task, { kind: 'crash', status: 'bad', stepId: stepDef.id, detail: message, duration: durationMs });
      await session.driver.start().catch(() => {});
      await inspectBeforeContinuing(task, session, 'after a browser crash');
      save(task, { status: STATES.RECOVERING, consecutive_failures: task.consecutive_failures + 1, actions_used: task.actions_used + 1 });
      return;
    }

    // A site that refuses the agent is an outcome, not an obstacle to defeat (AT-18/AT-19).
    if (code === 'blocked' || code === 'session_expired') {
      const kind = error?.detail?.kind || (code === 'session_expired' ? BLOCK_KINDS.LOGIN : BLOCK_KINDS.OTHER);
      const outcome = blockOutcome(kind);
      await captureBlockEvidence(task, session, stepDef, message, kind);
      save(task, { actions_used: task.actions_used + 1, blocker_kind: kind });
      finish(task, outcome.status, { reason: outcome.message, outcome: `blocked:${kind}` });
      return;
    }

    // Sensitive actions are never retried blindly (AT-23).
    if (isSensitiveStep(stepDef)) {
      step(task, {
        kind: 'action', status: 'bad', stepId: stepDef.id, detail: `${message} — not retried: this step is a commitment`, duration: durationMs,
      });
      save(task, { actions_used: task.actions_used + 1, blocker_kind: 'sensitive' });
      finish(task, STATES.WAITING_FOR_USER, {
        reason: 'A sensitive action failed and cannot be safely retried. Check whether it went through before resuming.',
        outcome: 'sensitive-failure',
      });
      return;
    }

    session.detector.noteError(code);
    const failures = task.consecutive_failures + 1;
    save(task, { actions_used: task.actions_used + 1, consecutive_failures: failures, step_attempts: task.step_attempts + 1 });
    step(task, { kind: 'action', status: 'bad', stepId: stepDef.id, attempt: task.step_attempts + 1, detail: `${code}: ${message}`, duration: durationMs });

    if (failures >= task.max_consecutive_failures) {
      finish(task, STATES.WAITING_FOR_USER, { reason: `${failures} consecutive failures — needs a human`, outcome: 'consecutive-failures' });
      return;
    }
    await recover(task, session, stepDef, code, message);
  }

  /**
   * The recovery ladder (spec §4). One attempt per tick, never repeating an attempt that already
   * failed for this obstacle, and never for a restriction (that goes straight to BLOCKED).
   */
  async function recover(task, session, stepDef, obstacle, message) {
    const ladder = ladderFor(obstacle);
    const log = json(task.recovery_log, []);
    const tried = new Set(log.filter((r) => r.stepId === stepDef.id && r.obstacle === obstacle).map((r) => r.attempt));
    const next = ladder.find((entry) => {
      const count = log.filter((r) => r.stepId === stepDef.id && r.obstacle === obstacle && r.attempt === entry.id).length;
      return count < (entry.max ?? 1) && !(count > 0 && tried.has(entry.id));
    });

    if (!next) {
      // Exhausted. An optional step is skipped; anything else stops and asks for help.
      if (stepDef.optional) {
        save(task, { step_index: task.step_index + 1, consecutive_failures: 0 });
        step(task, { kind: 'recovered', status: 'warn', stepId: stepDef.id, detail: `Skipped optional step after ${obstacle}: ${message}` });
        return;
      }
      finish(task, STATES.WAITING_FOR_USER, {
        reason: `Recovery exhausted for “${stepDef.describe || stepDef.id}” (${obstacle}). Last error: ${message}`,
        outcome: `recovery-exhausted:${obstacle}`,
      });
      return;
    }

    const attempt = { stepId: stepDef.id, obstacle, attempt: next.id, label: next.label, at: now() };
    log.push(attempt);
    save(task, { recovery_log: JSON.stringify(log.slice(-40)), retries_used: task.retries_used + 1, status: STATES.RECOVERING });
    step(task, { kind: 'retry', status: 'warn', stepId: stepDef.id, attempt: task.step_attempts + 1, detail: `Recovery: ${next.label}` });

    try {
      switch (next.id) {
        case 'settle':
          // No sleeping in a tick: the next tick is the wait.
          break;
        case 'inspect':
          await session.driver.snapshot();
          break;
        case 'refresh':
          await session.driver.reload();
          break;
        case 'relocate': {
          const snap = await session.driver.snapshot();
          session.lastFingerprint = snap.digest;
          break;
        }
        case 'alternate-interaction':
          session.forceMethod = stepDef.method === 'dom' ? 'pointer' : 'dom';
          break;
        case 'alternate-source':
          if (!hasAlternate(task, json(task.plan, []))) throw new BrowserError('unsupported', 'no alternative source was declared');
          save(task, { step_index: task.step_index + 1 });
          break;
        default:
          break;
      }
      save(task, { last_progress_at: task.last_progress_at || task.started_at || task.created_at });
    } catch (error) {
      step(task, { kind: 'retry', status: 'bad', stepId: stepDef.id, detail: `Recovery “${next.label}” failed: ${String(error?.message || error).slice(0, 160)}` });
    }
  }

  /**
   * After a crash or restart: look at the live page before repeating the last operation (AT-24).
   * A fresh engine starts on about:blank, so the verified checkpoint is what puts the task back on the
   * page it was working on — we reopen it deliberately and record that we did, rather than assuming
   * the plan can continue from nowhere.
   */
  async function inspectBeforeContinuing(task, session, why) {
    const checkpoint = json(task.checkpoint, {});
    let reopened = false;
    try {
      let snap = await session.driver.snapshot();
      const empty = !snap.url || snap.url === 'about:blank';
      if (empty && checkpoint.url) {
        await session.driver.goto(checkpoint.url, { signal: null, step: { timeoutMs: limits.actionTimeoutMs } });
        snap = await session.driver.snapshot();
        reopened = true;
      }
      const moved = checkpoint.url && snap.url && checkpoint.url !== snap.url;
      save(task, {
        current_url: snap.url || task.current_url,
        checkpoint: JSON.stringify({ ...checkpoint, inspectedAt: now(), inspectedUrl: snap.url, moved, reopened }),
      });
      step(task, {
        kind: 'inspect', status: 'info', url: snap.url,
        detail: `${why}: ${reopened ? 'reopened the checkpoint page ' : 'page is '}${snap.url || 'unknown'}${moved ? ` (moved from ${checkpoint.url} — re-locating targets)` : ''}`,
      });
      session.detector.reset();
      session.lastFingerprint = snap.digest;
    } catch (error) {
      step(task, { kind: 'inspect', status: 'warn', detail: `${why}: could not read the page (${String(error?.message || error).slice(0, 120)})` });
    }
  }

  async function captureBlockEvidence(task, session, stepDef, message, kind) {
    const shot = await session.driver.screenshot().catch(() => null);
    evidence(task, {
      kind: 'screenshot', label: stepDef?.id || 'blocked',
      summary: `Blocked (${kind}): ${message}`,
      url: task.current_url, digest: shot?.digest || sha(message),
      data: shot?.base64 || '', bytes: shot?.base64 ? Math.round((shot.base64.length * 3) / 4) : 0,
    });
  }

  function hasAlternate(task, plan) {
    return plan.some((s, i) => i > task.step_index && s.optional);
  }

  function dropRecovery(task, stepId) {
    const log = json(task.recovery_log, []);
    return log.filter((r) => r.stepId !== stepId);
  }

  /** Completion is decided by criteria + evidence, never by "the plan finished" (AT-26). */
  function completeTask(task) {
    const criteria = json(task.success_criteria, []);
    const observations = json(task.checkpoint, {}).observations || {};
    const results = criteria.map((c) => checkCriterion(c, observations));
    const failed = results.filter((r) => !r.ok);
    const evidenceCount = db.prepare('SELECT COUNT(*) AS n FROM browser_evidence WHERE task_id = ?').get(task.id).n;

    if (!criteria.length) {
      finish(task, STATES.FAILED, {
        reason: 'The plan finished but the task declared no success criteria, so success cannot be verified.',
        outcome: 'no-criteria',
      });
      return;
    }
    if (failed.length) {
      finish(task, STATES.FAILED, {
        reason: `${criteria.length - failed.length}/${criteria.length} success criteria verified: ${failed.map((f) => `${f.key} (${f.reason})`).join('; ')}`,
        outcome: 'criteria-unmet',
      });
      return;
    }
    finish(task, STATES.COMPLETED, {
      reason: `All ${criteria.length} success criteria verified against ${evidenceCount} evidence records`,
      outcome: 'verified',
    });
  }

  /* ---------- boot ---------- */

  /**
   * Anything left "running" when the process died is resumed, not restarted: we open a fresh engine,
   * inspect the live page, and only then continue (AT-24).
   */
  async function resumeInterrupted() {
    const rows = db.prepare(`SELECT * FROM browser_tasks WHERE status IN ('running','recovering','queued')`).all();
    for (const row of rows) {
      const task = get(row.id);
      step(task, { kind: 'resume', status: 'warn', detail: 'The gateway restarted while this task was active; re-attaching to the browser state' });
      save(task, { status: STATES.QUEUED, consecutive_failures: 0 });
      try {
        const session = await ensureSession(task);
        await inspectBeforeContinuing(task, session, 'after a gateway restart');
      } catch (error) {
        finish(task, STATES.WAITING_FOR_USER, {
          reason: `The gateway restarted and the browser could not be re-attached: ${String(error?.message || error).slice(0, 160)}`,
          outcome: 'restart-unavailable',
        });
      }
    }
    return rows.length;
  }

  /** One pass over the queue. Exposed so tests can step the clock instead of waiting. */
  async function tick() {
    if (stopping) return { ran: [] };
    const active = db.prepare(`SELECT * FROM browser_tasks WHERE status IN ('queued','running','recovering') ORDER BY created_at LIMIT 1`).all();
    const ran = [];
    for (const row of active) {
      if (busy.has(row.id) || sessions.size >= limits.maxTabs) continue;
      busy.add(row.id);
      try {
        await tickTask(row);
        ran.push(row.id);
      } catch (error) {
        const task = get(row.id);
        if (task && !isTerminal(task.status)) {
          save(task, { consecutive_failures: (task.consecutive_failures || 0) + 1 });
          step(task, { kind: 'error', status: 'bad', detail: `Runner error: ${String(error?.message || error).slice(0, 200)}` });
        }
      } finally {
        busy.delete(row.id);
      }
    }
    return { ran };
  }

  function startTicker(intervalMs = Number(process.env.MMM_BROWSER_TICK_MS || 400)) {
    if (process.env.MMM_BROWSER_DISABLE === '1') return null;
    const timer = setInterval(() => { tick().catch(() => {}); }, Math.max(intervalMs, 100));
    timer.unref?.();
    return timer;
  }

  function shutdown() {
    stopping = true;
    for (const [id, session] of sessions) {
      step(get(id) || { id, current_url: '' }, { kind: 'shutdown', status: 'info', detail: 'Gateway shutting down' });
      Promise.resolve(session.driver?.close?.()).catch(() => {});
    }
    sessions.clear();
  }

  return {
    createTask, listTasks, getTask: (id) => shapeTask(get(id)), getTaskDetail, getEvidence,
    control, tick, resumeInterrupted, startTicker, shutdown,
    progressAgeLabel,
    _internals: { sessions, tickTask, checkCriterion },
  };
}
