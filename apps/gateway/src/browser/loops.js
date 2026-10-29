/* ============ Agent Browser — loop detection ============
 * An agent that keeps doing the same thing is not working, it is waiting to be stopped. Two
 * detectors run side by side because they catch different failures:
 *
 *   1. **Repeated action** — the same action against the same page state, N times. Catches "click
 *      the same button", "submit the same form", "repeat the same search".
 *   2. **Page cycle** — A → B → A → B with no new evidence. Catches "navigate between two pages
 *      without progress", which never repeats a single action and so defeats detector 1.
 *
 * Both are per task, bounded, and reset by real progress (new evidence), so a legitimately repetitive
 * job (paginating 20 result pages) does not trip them while a stuck one always does.
 */

export const LOOP_REASONS = Object.freeze({
  REPEATED_ACTION: 'repeated action',
  PAGE_CYCLE: 'page cycle',
  REPEATED_ERROR: 'repeated error',
});

const key = (value) => String(value || '').slice(0, 300);

export function actionSignature(step, pageFingerprint = '') {
  return `${step?.action || '?'}|${key(step?.selector || step?.url || step?.text)}|${key(pageFingerprint)}`;
}

export function createLoopDetector({ threshold = 3, window = 12, cycleLength = 3, cycleRepeats = 3 } = {}) {
  const actions = [];
  const pages = [];
  const errors = [];
  let lastReason = null;

  const bump = (list, signature, cap) => {
    list.push(signature);
    while (list.length > cap) list.shift();
    return list.filter((s) => s === signature).length;
  };

  return {
    /** Record one attempted action against the current page state. */
    noteAction(signature) {
      const count = bump(actions, signature, window);
      if (count >= threshold) {
        lastReason = { reason: LOOP_REASONS.REPEATED_ACTION, signature, count };
        return lastReason;
      }
      return null;
    },

    /** Record a page fingerprint (url + snapshot digest) after an action. */
    notePage(fingerprint) {
      pages.push(key(fingerprint));
      while (pages.length > window) pages.shift();
      // Look for a short cycle repeated consecutively at the tail: [a,b] x3 or [a,b,c] x3.
      for (let len = 2; len <= cycleLength; len += 1) {
        const need = len * cycleRepeats;
        if (pages.length < need) continue;
        const tail = pages.slice(-need);
        const unit = tail.slice(0, len);
        let repeats = true;
        for (let i = 0; i < need; i += 1) {
          if (tail[i] !== unit[i % len]) { repeats = false; break; }
        }
        if (repeats && new Set(unit).size > 1) {
          lastReason = { reason: LOOP_REASONS.PAGE_CYCLE, signature: unit.join(' → '), count: cycleRepeats };
          return lastReason;
        }
      }
      return null;
    },

    /** Record an error code; the same browser error five times is also a loop. */
    noteError(code) {
      const count = bump(errors, key(code), window);
      if (count >= Math.max(threshold, 4)) {
        lastReason = { reason: LOOP_REASONS.REPEATED_ERROR, signature: key(code), count };
        return lastReason;
      }
      return null;
    },

    /** Real progress clears the history: the agent is doing new work. */
    reset() {
      actions.length = 0;
      pages.length = 0;
      errors.length = 0;
      lastReason = null;
    },

    get last() {
      return lastReason;
    },

    snapshot() {
      return { actions: [...actions], pages: [...pages], errors: [...errors], lastReason };
    },

    restore(state = {}) {
      actions.length = 0; pages.length = 0; errors.length = 0;
      for (const a of state.actions || []) actions.push(a);
      for (const p of state.pages || []) pages.push(p);
      for (const e of state.errors || []) errors.push(e);
      lastReason = state.lastReason || null;
    },
  };
}

/**
 * What to do when a loop is found (spec §5): stop the sequence, keep the evidence, reassess, try a
 * materially different strategy once, and otherwise hand the task to a human.
 */
export function loopResponse(loop, { alternateAvailable = false } = {}) {
  return {
    action: alternateAvailable ? 'alternate-strategy' : 'waiting-for-user',
    message: alternateAvailable
      ? `Detected ${loop.reason} (${loop.count}×). Switching to the alternative strategy the task declared.`
      : `Detected ${loop.reason} (${loop.count}×). The agent stopped instead of repeating it; the task needs you.`,
    detail: loop.signature,
  };
}
