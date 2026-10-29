/* ============ Agent Browser — module entry point ============
 * Binds the runner to this gateway's database, audit log, event feed and WebSocket fan-out, and
 * exposes the capability report the UI needs to explain what can and cannot run here.
 */
import { db, logEvent, audit } from '../db.js';
import { createBrowserRunner } from './runner.js';
import { driverCapabilities } from './driver.js';
import { STATES, STATE_LABEL, DEFAULT_LIMITS, TERMINAL } from './policy.js';

let broadcastFn = () => {};
const broadcast = (topic, payload) => {
  try { broadcastFn(topic, payload); } catch { /* the socket layer is optional in tests */ }
};

export function setBrowserBroadcast(fn) {
  broadcastFn = typeof fn === 'function' ? fn : () => {};
}

export const runner = createBrowserRunner({
  db,
  logEvent,
  audit,
  broadcast: (topic, payload) => broadcast(topic, payload),
});

/**
 * What the browser module can do here, in the app's own status vocabulary. `available` requires a
 * real engine; the simulated driver never earns it, no matter how green the tests are.
 */
export async function browserCapability() {
  const drivers = await driverCapabilities();
  const engine = drivers.find((d) => d.kind === 'engine' && d.available);
  const sim = drivers.find((d) => d.id === 'simulated');
  const counts = db.prepare(`SELECT status, COUNT(*) AS n FROM browser_tasks GROUP BY status`).all();
  const byStatus = Object.fromEntries(counts.map((r) => [r.status, r.n]));
  const active = (byStatus[STATES.RUNNING] || 0) + (byStatus[STATES.QUEUED] || 0) + (byStatus[STATES.RECOVERING] || 0);

  return {
    drivers,
    engine: engine ? { id: engine.id, label: engine.label } : null,
    simulatedAllowed: Boolean(sim?.available),
    limits: {
      actionTimeoutMs: DEFAULT_LIMITS.actionTimeoutMs,
      stallAfterMs: DEFAULT_LIMITS.stallAfterMs,
      deadlineMs: DEFAULT_LIMITS.deadlineMs,
      maxRetries: DEFAULT_LIMITS.maxRetries,
      maxConsecutiveFailures: DEFAULT_LIMITS.maxConsecutiveFailures,
      maxActions: DEFAULT_LIMITS.maxActions,
      maxTabs: DEFAULT_LIMITS.maxTabs,
    },
    states: STATES,
    stateLabels: STATE_LABEL,
    terminal: TERMINAL,
    counts: byStatus,
    active,
    status: engine ? 'available' : 'unconfigured',
    reason: engine ? `${engine.label} ready` : drivers.map((d) => `${d.id}: ${d.reason}`).join('; '),
  };
}

export { STATES, STATE_LABEL };
