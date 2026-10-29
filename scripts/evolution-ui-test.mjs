/* Self-Improvement panel tests — the honesty and layout of the visibility surface (AC17 in the UI).
 * Run: npm run test:evolution-ui
 *
 * The gateway tests (evolution-test.mjs) prove the enforcement. These prove that the panel tells the
 * truth about it: no controls without a gateway, no fabricated activity, the real status vocabulary,
 * the diff, the test output and the limitations — on a phone-sized layout.
 */
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const css = readFileSync(join(root, 'src/evolution.css'), 'utf8');
const js = readFileSync(join(root, 'src/evolution.js'), 'utf8');

const results = [];
let failures = 0;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); } catch (error) { failures += 1; results.push(`FAIL ${name}: ${error.message}`); }
}
const assert = (cond, message) => { if (!cond) throw new Error(message); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); };

/* ---------- 1. stylesheet ---------- */
await check('the panel is mobile-first with 44px targets and token colours', () => {
  assert(!/@media\s*\(max-width/.test(css), 'no max-width media queries');
  const grid = css.match(/\.evo-grid \{[^}]*\}/);
  assert(grid && /grid-template-columns:\s*1fr/.test(grid[0]), 'the base layout is a single column');
  assert(/@media \(min-width: 960px\)/.test(css), 'the wide layout is a min-width enhancement');
  assert(/\.evo-actions \.btn \{[^}]*min-height:\s*44px/.test(css), 'controls need 44px touch targets');
  assert(/\.evo-step > summary \{[^}]*min-height:\s*44px/.test(css), 'each step header is a 44px target');
  assert(!/#[0-9a-fA-F]{3,6}\b/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'no hard-coded hex colours');
  assert(/overflow-wrap:\s*anywhere/.test(css), 'long paths must wrap, never clip');
  assert(/\.evo-diff[\s\S]{0,200}overflow:\s*auto/.test(css), 'a diff scrolls inside its own box');
});

/* ---------- 2. harness ---------- */
const win = new Window({ url: 'http://localhost:5173/#/home' });
for (const k of ['document', 'navigator', 'location', 'localStorage', 'history', 'HTMLElement',
  'Event', 'CustomEvent', 'KeyboardEvent', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame', 'Blob']) {
  const value = win[k] ?? win;
  try { Object.defineProperty(globalThis, k, { value, configurable: true, writable: true }); } catch { try { globalThis[k] = value; } catch {} }
}
globalThis.window = win;
globalThis.document = win.document;
globalThis.localStorage = win.localStorage;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
win.matchMedia = globalThis.matchMedia;
win.document.body.innerHTML = '<div id="app"><div id="view"></div><div id="sheet-root"></div><div id="toast-root"></div></div>';

const capability = {
  status: 'available',
  defaultLevel: 1,
  levels: [
    { id: 1, label: 'Recommend', key: 'recommend', summary: 'Inspect, diagnose, propose. Cannot write.' },
    { id: 2, label: 'Modify and test', key: 'modify-and-test', summary: 'Isolated copy, change, test.' },
    { id: 3, label: 'Automatically stage', key: 'auto-stage', summary: 'Stage a passing candidate.' },
    { id: 4, label: 'Bounded autonomous deployment', key: 'bounded-deploy', summary: 'Deploy low-risk candidates.' },
    { id: 5, label: 'Supervised continuous improvement', key: 'continuous', summary: 'Continuous, under a pre-approved policy.' },
  ],
  protected: [{ pattern: 'apps/gateway/src/evolution/', reason: 'the safeguards governing self-modification' }],
  sandbox: {
    isolation: 'process',
    label: 'Process isolation on the gateway host',
    enforced: ['environment is rebuilt from scratch', 'command must match the allowlist'],
    notEnforced: ['kernel network isolation — the sandbox inherits the host network'],
    recommendation: 'Run the gateway in a container without ambient credentials.',
  },
  agents: { total: 2, withPolicy: 2 },
  note: 'Every agent has a policy. The default is level 1 (recommend only).',
};

const agent = (over = {}) => ({
  id: 'demo-writer', name: 'Demo Writer', policy: {
    agentId: 'demo-writer', enabled: true, level: 2, levelLabel: 'Modify and test', levelSummary: 'Create an isolated working copy, change it, run permitted tests. Promotion needs approval.',
    capabilities: { inspect: true, workspace: true, modify: true, test: true, stage: false, deploy: false, continuous: false },
    scope: ['agents/demo-writer/**'], allowTests: true, allowAutoStage: false, allowAutoDeploy: false, requireReviews: true,
    healthCheck: {}, limits: { maxExperimentsPerDay: 5, maxTestRuns: 4, maxRuntimeMs: 120000 },
  },
  grants: [], versions: 1, activeVersion: null, activeExperiment: null,
  ...over,
});

const experiment = (over = {}) => ({
  id: 'exp-1', agentId: 'demo-writer', title: 'Fix the greeting defect', problem: 'greet() returns “hi Ada”; the suite expects “Hello, Ada”.',
  status: 'review_required', statusLabel: 'Review required', terminal: false, level: 2, levelLabel: 'Modify and test',
  risk: 'low', baseVersion: 'abc123def456', hasWorkspace: true,
  files: [{ path: 'agents/demo-writer/greet.mjs', reason: 'match the documented greeting' }],
  changes: { 'agents/demo-writer/greet.mjs': { kind: 'modified', reason: 'match the documented greeting', added: 2, removed: 2 } },
  diff: '--- a/agents/demo-writer/greet.mjs\n+++ b/agents/demo-writer/greet.mjs\n@@ -1,3 +1,3 @@\n-  return `hi ${name}`;\n+  return `Hello, ${name}`;\n',
  diffLines: 4,
  tests: { passed: true, command: 'node agents/demo-writer/greet.test.mjs', runs: [{ at: Date.now(), ok: true, code: 0, durationMs: 812, command: 'node agents/demo-writer/greet.test.mjs', stdout: 'PASS greets by name\nall passing' }] },
  testRuns: 1, integrity: { findings: [] }, reviewRequired: true,
  reviews: [{ reviewer: 'demo-reviewer', verdict: 'approve', findings: ['wording matches the README'], independent: true, created_at: Date.now() }],
  compare: {
    baselineVersion: 'abc123def456', candidateVersion: 'fff999eee111',
    evidence: { testsPassed: true, lastSummary: 'node greet.test.mjs → passed', approvals: 1, objections: 0, diffFiles: 1, diffLines: 4 },
    coverage: 'The recorded check(s) passed. This is the evidence we have — it is not a proof that nothing else regressed.',
    limitations: ['Only the files in this experiment were exercised.', 'The sandbox is process isolation, not a container (no network isolation).'],
    risk: { level: 'low', reason: 'small change, inside the agent’s own scope' },
  },
  approval: { pending: false }, events: [
    { seq: 1, ts: Date.now() - 60000, stage: 'proposed', status: 'info', actor: 'owner', detail: 'Experiment opened at autonomy level 2' },
    { seq: 2, ts: Date.now() - 30000, stage: 'test', status: 'ok', actor: 'owner', detail: 'node greet.test.mjs → passed in 0.8s' },
  ],
  createdBy: 'owner', createdAt: Date.now() - 60000, updatedAt: Date.now() - 30000, endedAt: null, versionId: '',
  ...over,
});

let mode = 'ok';
let experimentData = experiment();
const calls = [];
globalThis.fetch = async (input, init = {}) => {
  const url = String(typeof input === 'string' ? input : input.url);
  calls.push(`${init.method || 'GET'} ${url}`);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (mode === 'down') return json({ error: 'gateway unavailable' }, 503);
  if (url.endsWith('/api/v1/auth/session')) {
    if (mode === 'anon') return json({ error: 'not signed in' }, 401);
    if (mode === 'viewer') {
      return json({ principal: { id: 'pr-viewer', name: 'Viewer', role: 'Viewer' }, permissions: ['read', 'evolution:read'], csrfToken: 'csrf-test', mode: 'required' });
    }
    return json({
      principal: { id: 'pr-owner', name: 'Owner', role: 'Owner' },
      permissions: ['read', 'evolution:read', 'evolution:run', 'evolution:review', 'evolution:approve', 'evolution:deploy', 'evolution:policy'],
      csrfToken: 'csrf-test', mode: 'required',
    });
  }
  if (mode === 'anon') return json({ error: 'not signed in' }, 401);
  if (url.endsWith('/api/v1/evolution/capabilities')) return json(capability);
  if (url.endsWith('/api/v1/evolution/agents')) {
    return json({ agents: [agent(), agent({ id: 'demo-reviewer', name: 'Demo Reviewer', policy: { ...agent().policy, agentId: 'demo-reviewer', level: 1, levelLabel: 'Recommend', levelSummary: 'Inspect and propose only.' } })] });
  }
  if (/\/agents\/[^/]+\/policy$/.test(url)) return json(agent().policy);
  if (/\/agents\/[^/]+\/versions$/.test(url)) {
    return json({ versions: [{ id: 'v-1', status: 'deployed', created_at: Date.now() - 3600_000, files: { 'agents/demo-writer/greet.mjs': 'sha' }, evidence: { tests: 'node greet.test.mjs → passed' }, health: { ok: true, summary: 'node agents/demo-writer/health.mjs → passed' } }], active: { versionId: 'v-1' } });
  }
  if (/\/agents\/[^/]+\/observations$/.test(url)) return json({ observations: [{ id: 'obs-1', source: 'test-failure', detail: 'greet.test.mjs fails: expected “Hello, Ada”', measured: 1, created_at: Date.now() }] });
  if (/\/experiments\/[^/]+$/.test(url)) return json(experimentData);
  if (url.includes('/api/v1/evolution/experiments')) return json({ experiments: [experimentData] });
  return json({}, 404);
};

await import('../src/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(120);
const nav = await import('../src/main.js');
const api = await import('../src/api.js');
const auth = await import('../src/auth.js');
const mod = await import('../src/evolution.js');
const shell = await import('../src/shell.js');
const doc = win.document;
const q = (sel, r = doc) => r.querySelector(sel);
const qa = (sel, r = doc) => [...r.querySelectorAll(sel)];
const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
async function openPanel() {
  shell.closeAllSheets();
  nav.navigate('home');
  await sleep(40);
  nav.navigate('evolution');
  await sleep(220);
  return q('#view');
}

/* ---------- 3. no gateway ---------- */
await check('without a gateway the panel explains where the cycle runs and offers no controls', async () => {
  const view = await openPanel();
  const body = text(view);
  assert(/Self-Improvement/.test(text(q('h1', view))), 'screen title');
  assert(/runs on the gateway/i.test(body), 'must say the cycle runs on the gateway');
  eq(q('[data-act="evo-create"]', view), null, 'no experiment controls without a gateway');
  eq(q('[data-act="evo-save-policy"]', view), null, 'no authority controls without a gateway');
  assert(/nothing is simulated here/i.test(body), 'must not imply local activity');
});

/* ---------- 4. signed in, no permission ---------- */
await check('a signed-out visitor is sent to sign in and sees no agent data', async () => {
  api.setGatewayUrl('http://gateway.test');
  mode = 'anon';
  await auth.refreshSession();
  const view = await openPanel();
  eq(q('.evo-agent', view), null, 'no agent data is invented for a signed-out viewer');
  eq(q('[data-act="evo-save-policy"]', view), null, 'an unauthenticated viewer gets no authority controls');
  eq(q('[data-act="evo-create"]', view), null, 'and no way to open an experiment');
});

await check('a reader who may only look sees the policy but none of the controls', async () => {
  mode = 'viewer';
  await auth.refreshSession();
  mod.evolutionInternals.cache.selectedId = '';
  const view = await openPanel();
  const body = text(view);
  assert(/Every agent has a self-improvement policy/i.test(body), 'the policy banner is shown');
  assert(/Demo Writer/.test(body), 'the agent is listed');
  assert(/Level 2/.test(body), 'the enforced level is shown');
  assert(/Only an Owner can change autonomy/i.test(body), 'the panel says who can change it');
  eq(q('[data-act="evo-save-policy"]', view), null, 'a reader gets no authority controls');
  eq(q('[data-act="evo-create"]', view), null, 'a reader cannot open experiments');
  assert(/an agent can never grant itself more/.test(text(view)), 'the enforcement boundary is stated');
});

/* ---------- 5. honest statuses, diffs and evidence ---------- */
await check('a candidate in review shows the real stage, diff, test output and its limitations', async () => {
  mode = 'ok';
  await auth.refreshSession();
  mod.evolutionInternals.cache.agentId = 'demo-writer';
  mod.evolutionInternals.cache.selectedId = '';
  const view = await openPanel();
  const tile = q('.evo-exp', view);
  assert(tile, 'the experiment tile is rendered');
  assert(/Review required/.test(text(tile)), 'the real status is shown, not a friendlier one');
  assert(/low risk/.test(text(tile)), 'the risk level is shown');
  assert(/1 review/.test(text(tile)), 'review count is shown');

  tile.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(160);
  const detail = q('#evo-detail', view);
  const body = text(detail);
  assert(/Review required/.test(body), 'the detail repeats the honest status');
  assert(/return `hi/.test(body) && /return `Hello/.test(body), 'the diff shows both sides of the change');
  assert(/all passing/.test(body), 'the real test output is shown');
  assert(/not a proof that nothing else regressed/i.test(body), 'coverage is bounded');
  assert(/process isolation, not a container/i.test(body), 'the sandbox limitation is shown');
  assert(/match the documented greeting/.test(body), 'each change carries its reason');
  assert(!/Deployed/.test(text(q('.evo-exp-top', detail))), 'a reviewed candidate is not dressed up as deployed');
  const stages = qa('.evo-stage', detail).map(text);
  eq(stages.length, 10, 'the ten stages of the cycle are listed');
  assert(stages.includes('Peer review'), 'the cycle names peer review');
  assert(/Peer review/.test(text(q('.evo-stage.current', detail))), 'the bar marks where the candidate actually is');
});

/* ---------- 6. authority controls only for an Owner ---------- */
await check('the authority form appears for an Owner and states what a level change means', async () => {
  const view = await openPanel();
  const form = q('[data-act="evo-save-policy"]', view);
  assert(form, 'an Owner sees the authority form');
  const levelSelect = q('#evo-level', view);
  assert(levelSelect && qa('option', levelSelect).length === 5, 'all five levels are offered');
  assert(/I understand level 3\+ can stage or deploy without my approval/.test(text(view)), 'the confirmation text explains the risk');
  assert(/an agent can never change its own policy/i.test(text(view)), 'the panel says the platform enforces it');
});

/* ---------- 7. gateway down ---------- */
await check('a gateway that cannot be read reports the failure and invents nothing', async () => {
  mode = 'down';
  mod.evolutionInternals.cache.selectedId = '';
  const view = await openPanel();
  const body = text(view);
  assert(/Gateway not readable/.test(body), 'the failure is named');
  eq(qa('.evo-exp', view).length, 0, 'no experiments are invented');
  eq(q('[data-act="evo-create"]', view), null, 'no controls on a failed read');
  assert(/Try again/.test(body), 'the retry is a real control');
  mode = 'ok';
});

/* ---------- 8. deployed state ---------- */
await check('a deployed candidate shows its version, health and rollback, and never hides the limits', async () => {
  mod.evolutionInternals.cache.selectedId = '';
  experimentData = experiment({ status: 'deployed', statusLabel: 'Deployed', terminal: true, versionId: 'v-2', blocker: '' });
  const view = await openPanel();
  const tile = q('.evo-exp', view);
  assert(tile, `an experiment tile is rendered (debug: ${JSON.stringify({ err: mod.evolutionInternals.cache.error, n: mod.evolutionInternals.cache.experiments.length })})`);
  assert(/Deployed/.test(text(tile)), 'the deployed state is labelled');
  assert(/Version|rollback/i.test(text(view)), 'versions and rollback are visible');
  const versions = text(view);
  assert(/v-1 live/.test(versions), 'the live version is shown');
  assert(/Run health check/.test(versions), 'the health check is offered');
  assert(/does not reverse database migrations/i.test(versions), 'the rollback limits are stated');
});

/* ---------- 9. deep links ---------- */
await check('an agent can be deep-linked, and the tab follows the URL', async () => {
  nav.navigate('evolution/demo-reviewer');
  await sleep(220);
  const on = q('.evo-agent.on', q('#view'));
  assert(on, 'an agent tab is selected');
  assert(/Demo Reviewer/.test(text(on)), 'the deep-linked agent is the selected one');
  assert(/Recommend/.test(text(on)), 'its real level is shown');
  const tile = q('.evo-agent[data-id="demo-writer"]');
  tile.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(220);
  assert(/#\/evolution\/demo-writer$/.test(win.location.hash), 'choosing an agent changes the URL');
  assert(/Demo Writer/.test(text(q('.evo-agent.on', q('#view')))), 'and the panel follows it');
});

/* ---------- 10. static honesty of the module ---------- */
await check('the module never claims an unrun test or a self-granted permission', () => {
  assert(!/Math\.random\(\).*passed/.test(js), 'no fabricated pass');
  assert(!/setState\([^)]*status:\s*'deployed'/.test(js), 'the panel never sets a status locally');
  assert(/canPolicy\(\)/.test(js) && /canApprove\(\)/.test(js) && /canDeploy\(\)/.test(js), 'controls are gated on real permissions');
  assert(/The repository is never modified by the gateway/.test(js), 'the write boundary is stated where a user writes a change');
  const datastore = readFileSync(join(root, 'src/datastore.js'), 'utf8');
  assert(/topics: \['agents', 'tasks', 'approvals', 'system', 'evolution'\]/.test(datastore), 'the socket subscribes to the evolution topic');
  assert(/subscribeEvolution/.test(js), 'the panel refreshes from that topic instead of only polling');
  assert(/if \(msg\?\.topic === 'evolution'\)/.test(datastore), 'evolution events are routed to their listeners, not the app-wide refresh');
});

/* ---------- report ---------- */
console.log(results.join('\n'));
const passed = results.filter((r) => r.startsWith('PASS')).length;
console.log(`\nSELF-IMPROVEMENT PANEL: ${passed} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
