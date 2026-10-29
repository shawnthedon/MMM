/* ============ Agent Browser — progress watchdog ============
 * The watchdog answers one question on every tick: *is this task still making progress, or is it just
 * still open?* A page that stays open is not evidence of work, so progress is only recorded when an
 * observation actually changed (new URL, new snapshot digest, or a verified milestone).
 *
 * Pure functions + one small class, so the tests can move time instead of waiting for it.
 */
import { DEFAULT_LIMITS, STATES, isTerminal } from './policy.js';

/**
 * @typedef {object} TaskSnapshot
 * @property {string} status
 * @property {number|null} deadline_at
 * @property {number|null} last_progress_at
 * @property {number|null} last_success_at
 * @property {number} consecutive_failures
 * @property {number} retries_used
 * @property {number} max_retries
 * @property {number} max_consecutive_failures
 * @property {number} actions_used
 * @property {number} max_actions
 * @property {number} created_at
 */

/**
 * Evaluate a task without mutating it.
 * @returns {{ terminal: string|null, stalled: boolean, reason: string, actionAgeMs: number, progressAgeMs: number }}
 */
export function assessProgress(task, { now = Date.now(), actionStartedAt = null, limits = DEFAULT_LIMITS } = {}) {
  const progressAgeMs = now - (task.last_progress_at || task.started_at || task.created_at);
  const actionAgeMs = actionStartedAt ? now - actionStartedAt : 0;
  const base = { terminal: null, stalled: false, reason: '', actionAgeMs, progressAgeMs };

  if (isTerminal(task.status)) return { ...base, reason: 'finished' };

  // 1. Deadline is absolute: it wins over everything else.
  if (task.deadline_at && now >= task.deadline_at) {
    return { ...base, terminal: STATES.TIMED_OUT, reason: 'deadline reached' };
  }

  // 2. Hard budgets.
  if (task.actions_used >= task.max_actions) {
    return { ...base, terminal: STATES.BLOCKED, reason: `action budget exhausted (${task.max_actions})` };
  }
  if (task.consecutive_failures >= task.max_consecutive_failures) {
    return { ...base, terminal: STATES.BLOCKED, reason: `${task.consecutive_failures} consecutive failures` };
  }
  if (task.retries_used > task.max_retries) {
    return { ...base, terminal: STATES.FAILED, reason: `retry budget exhausted (${task.max_retries})` };
  }

  // 3. Stall: either the current action has run past its own timeout, or nothing meaningful has
  //    happened for longer than the stall window. Both mean "recover now", not "wait more".
  if (actionStartedAt && actionAgeMs > (task.action_timeout_ms || limits.actionTimeoutMs)) {
    return { ...base, stalled: true, reason: `action exceeded ${Math.round((task.action_timeout_ms || limits.actionTimeoutMs) / 1000)}s` };
  }
  if (progressAgeMs > (task.stall_after_ms || limits.stallAfterMs)) {
    return { ...base, stalled: true, reason: `no meaningful progress for ${Math.round(progressAgeMs / 1000)}s` };
  }

  return base;
}

/**
 * Tracks the in-flight action for one task so the watchdog can measure it. The runner uses this to
 * abort a navigation that never completes, rather than awaiting a promise forever.
 */
export function createWatchdog({ limits = DEFAULT_LIMITS, now = () => Date.now() } = {}) {
  let startedAt = null;
  let controller = null;

  return {
    limits,
    begin({ timeoutMs } = {}) {
      this.end();
      startedAt = now();
      controller = new AbortController();
      const budget = timeoutMs || limits.actionTimeoutMs;
      const timer = setTimeout(() => controller.abort(new Error('timeout')), budget);
      timer.unref?.();
      const finish = () => clearTimeout(timer);
      controller.signal.addEventListener('abort', finish, { once: true });
      return { signal: controller.signal, startedAt, budget };
    },
    elapsed() {
      return startedAt ? now() - startedAt : 0;
    },
    running() {
      return Boolean(controller);
    },
    abort(reason = 'watchdog') {
      try { controller?.abort(new Error(reason)); } catch { /* already aborted */ }
    },
    end() {
      try { controller?.abort(new Error('settled')); } catch { /* already aborted */ }
      controller = null;
      startedAt = null;
    },
    assess(task) {
      return assessProgress(task, { now: now(), actionStartedAt: startedAt, limits });
    },
  };
}

/** Human sentence for "time since meaningful progress", used by the API and the UI. */
export function progressAgeLabel(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m ago` : `${h}h ago`;
}
