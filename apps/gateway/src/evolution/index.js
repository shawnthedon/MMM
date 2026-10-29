/* ============ Self-modification — module entry point ============
 * Binds the improvement cycle to this gateway's database, audit log, event feed and WebSocket
 * fan-out, and gives every agent a policy on first use. Called once by `createGateway()`.
 */
import { db, logEvent, audit, DATA_DIR } from '../db.js';
import { createEvolutionRunner } from './runner.js';
import { REPO_ROOT } from './workspace.js';

let broadcastFn = () => {};
export const setEvolutionBroadcast = (fn) => { broadcastFn = typeof fn === 'function' ? fn : () => {}; };

export const evolution = createEvolutionRunner({
  db,
  dataDir: DATA_DIR,
  repoRoot: REPO_ROOT,
  logEvent,
  audit,
  broadcast: (topic, payload) => { try { broadcastFn(topic, payload); } catch { /* socket layer is optional in tests */ } },
});

/** Everyone who can be an agent gets a policy — including agents created before this module shipped. */
export function ensurePoliciesForAllAgents() {
  return evolution.schedulePoliciesForAllAgents();
}
