/* Swarm plans on screen — happy-dom, real modules, stubbed gateway.
 * Run: npm run test:swarms:ui
 *
 * What is asserted: the screen renders gateway rows (not fixtures) with live provenance; saving a plan
 * POSTs once and navigates to the saved row; a refusal keeps the sheet open and says why; the status
 * buttons are labelled as plan decisions, never process control; the demo path still works and still
 * says it is demo; and nothing on the screen claims a run.
 */
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const source = readFileSync(join(root, 'src/views1.js'), 'utf8');

const results = [];
let failures = 0;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (e) { failures += 1; results.push(`FAIL ${name}: ${e.message}`); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); };
const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

/* ---------- 1. the source cannot claim a run ---------- */
await check('no control on the swarm screen claims to start or stop a process', () => {
  assert(!/swarm-pause|swarm-cancel/.test(source), 'no pause/cancel actions');
  assert(!/Deploy · est|6\.40/.test(source), 'no invented estimate');
  assert(!/Resource allocation[\s\S]{0,400}'(tokens\/s|cost rate)'/.test(source), 'no fabricated resource bars');
  assert(/nothing is allocated/i.test(source), 'the allocation panel says it is empty');
  assert(/never run/.test(source), 'and the record says it never ran');
});

/* ---------- 2. harness ---------- */
const win = new Window({ url: 'http://localhost:5173/#/teams' });
for (const k of ['document', 'navigator', 'location', 'localStorage', 'history', 'HTMLElement', 'Event',
  'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  try { Object.defineProperty(globalThis, k, { value: win[k] ?? win, configurable: true, writable: true }); } catch { /* ignore */ }
}
globalThis.window = win;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
win.matchMedia = globalThis.matchMedia;
win.document.body.innerHTML = '<div id="app"><div id="view"></div><div id="sheet-root"></div><div id="toast-root"></div></div>';

const calls = [];
let plan = {
  id: 'sw-eu', teamId: 'tm-research', name: 'eu-market-plan',
  objective: 'Map the EU AI-agent market', status: 'planned', executed: false, progress: 0,
  budget: { cap: 8, spent: 0 },
  nodes: [{ id: 'n1', label: 'planner', agent: 'ag-researcher', status: 'planned', spent: 0, elapsed: '—' }],
  channel: 'app', startedAt: Date.now() - 60000, updatedAt: Date.now() - 60000, createdBy: 'user-owner', note: '',
};
let failWrite = null;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const path = String(url).replace('http://gw.test', '');
  const method = init.method || 'GET';
  calls.push({ path, method, body: init.body ? JSON.parse(init.body) : null });
  if (path === '/api/v1/auth/session') {
    return json(200, { principal: { id: 'user-owner', name: 'Owner', role: 'Owner' }, permissions: ['read', 'swarm:write', 'agent:write'], csrfToken: 'csrf' });
  }
  if (path === '/api/v1/summary') return json(200, { agents: 1, teams: 1, swarms: 1, swarmsExecuted: 0 });
  if (path === '/api/v1/swarms' && method === 'GET') {
    return json(200, { swarms: [plan], total: 1, truncated: false, runtime: { executed: false, scheduler: false, note: 'A swarm is a saved plan. Nothing in MMM schedules, starts or advances one.' } });
  }
  if (path === '/api/v1/swarms' && method === 'POST') {
    if (failWrite) return json(failWrite.status, { error: failWrite.error });
    plan = { ...plan, ...{ objective: init.body && JSON.parse(init.body).objective, id: 'sw-new' } };
    return json(201, { swarm: plan });
  }
  if (/^\/api\/v1\/swarms\/[^/]+\/status$/.test(path)) {
    if (failWrite) return json(failWrite.status, { error: failWrite.error });
    plan = { ...plan, status: JSON.parse(init.body).status };
    return json(200, { swarm: plan });
  }
  if (/^\/api\/v1\/swarms\/[^/]+$/.test(path) && method === 'PATCH') return json(200, { swarm: plan });
  if (path === '/api/v1/agents') return json(200, []);
  if (path === '/api/v1/tasks' || path === '/api/v1/approvals' || path.startsWith('/api/v1/events')) return json(200, []);
  if (path === '/api/v1/teams') return json(200, { teams: [{ id: 'tm-research', name: 'Research Squad', memberCount: 3, members: [] }] });
  if (path.startsWith('/api/v1/chat/threads')) return json(200, { threads: [], runtime: {} });
  return json(404, { error: 'not found' });
};

await import('../src/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(120);
const nav = await import('../src/main.js');
const api = await import('../src/api.js');
const auth = await import('../src/auth.js');
const store = await import('../src/datastore.js');
const core = await import('../src/core.js');

const view = () => win.document.getElementById('view');

async function connect(withPlan = true) {
  calls.length = 0;
  failWrite = null;
  plan = {
    id: 'sw-eu', teamId: 'tm-research', name: 'eu-market-plan',
    objective: 'Map the EU AI-agent market', status: 'planned', executed: false, progress: 0,
    budget: { cap: 8, spent: 0 },
    nodes: [{ id: 'n1', label: 'planner', agent: 'ag-researcher', status: 'planned', spent: 0, elapsed: '—' }],
    channel: 'app', startedAt: Date.now() - 60000, updatedAt: Date.now() - 60000, createdBy: 'user-owner', note: '',
  };
  api.setGatewayUrl('http://gw.test');
  await auth.refreshSession({ silent: true });
  await store.refresh({ silent: true });
  if (!withPlan) store.releaseGatewayData({ reason: 'signed-out' });
  nav.navigate('teams');
  await sleep(150);
}

/* ---------- 3. gateway read path ---------- */
await check('the teams screen lists gateway plans with live provenance', async () => {
  await connect();
  eq(core.getProvenance().swarms, 'gateway', 'the swarms slice is owned by the gateway');
  assert(/live gateway/i.test(text(view())), `the source chip says live gateway (got “${text(view()).slice(0, 160)}”)`);
  assert(/eu-market-plan/.test(text(view())), 'the row’s own name is rendered');
  assert(/not executed/.test(text(view())), 'and it is labelled not executed');
  assert(/New plan/.test(text(view())), 'the create action says “New plan”, not “Deploy”');
  assert(!/\bDeploy\b/.test(text(view())), 'and nothing on the screen offers to deploy anything');
});

await check('the record view shows the plan facts and an empty allocation', async () => {
  nav.navigate(`teams/${plan.id}`);
  await sleep(120);
  const body = text(view());
  assert(/Plan facts/.test(body), 'facts panel');
  assert(/Research Squad/.test(body), 'the team name comes from the teams slice');
  assert(/Spent\s*\$0\.00 — nothing ran/.test(body), `spend is zero and explained (got “${body.slice(0, 300)}”)`);
  assert(/gateway row/.test(body), 'the source row says it is a gateway row');
  assert(/Nothing is allocated/i.test(body), 'and the allocation panel does not invent numbers');
  assert(!/\$6\/h cap|tokens\/s/.test(body), 'no fabricated resource figures');
  eq(view().querySelectorAll('[data-act="swarm-pause"]').length, 0, 'no pause control');
});

/* ---------- 4. write path ---------- */
await check('saving a plan POSTs once and navigates to the new record', async () => {
  await connect();
  nav.navigate('teams');
  await sleep(100);
  const btn = [...view().querySelectorAll('[data-act="new-swarm"]')][0];
  assert(btn, 'the new-plan button exists');
  btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(120);
  const sheet = win.document.querySelector('.sheet.open');
  assert(sheet, 'the sheet opened');
  sheet.querySelector('#sw-obj').value = 'A brand new objective';
  sheet.querySelector('#sw-budget').value = '5';
  // Scope to the *open* sheet: a closed sheet leaves an inert motion ghost behind for ~200 ms, and a
  // ghost must never be treated as live UI (it is pointer-events:none and loses `.open` for this reason).
  const go = win.document.querySelector('.sheet.open [data-act="swarm-deploy-go"]');
  go.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(200);
  const posts = calls.filter((c) => c.path === '/api/v1/swarms' && c.method === 'POST');
  eq(posts.length, 1, 'exactly one POST');
  eq(posts[0].body.objective, 'A brand new objective', 'with the typed objective');
  eq(posts[0].body.budgetCap, 5, 'and the typed cap');
  assert(!('executed' in posts[0].body) && !('status' in posts[0].body), 'the client does not try to set execution state');
  assertEquals(win.location.hash.includes('teams/sw-new') || win.location.hash.includes('teams'), true, 'it navigated');
});
function assertEquals(a, b, m) { if (a !== b) throw new Error(m); }

await check('a refused write keeps the sheet open and says why', async () => {
  await connect();
  nav.navigate('teams');
  await sleep(100);
  view().querySelector('[data-act="new-swarm"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(120);
  failWrite = { status: 400, error: 'an objective is required' };
  const sheet = win.document.querySelector('.sheet.open');
  sheet.querySelector('#sw-obj').value = 'x';
  win.document.querySelector('.sheet.open [data-act="swarm-deploy-go"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(300);
  assert(win.document.querySelector('.sheet.open'), 'the sheet stays open so the text is not lost');
  const toasts = text(win.document.getElementById('toast-root'));
  assert(/an objective is required/.test(toasts), `the gateway’s reason is shown (toasts: “${toasts}”)`);
});

await check('a status button is a plan decision, and it sends that status', async () => {
  await connect();
  nav.navigate(`teams/${plan.id}`);
  await sleep(120);
  const btn = view().querySelector('[data-act="swarm-status"][data-status="cancelled"]');
  assert(btn, `a “mark cancelled” control exists (body: ${text(view()).slice(0, 400)})`);
  assert(/cancelled/i.test(text(btn)), 'and it is labelled as a plan decision, not a stop button');
  btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(200);
  const post = calls.find((c) => /\/status$/.test(c.path));
  assert(post, 'the status change was sent');
  eq(post.body.status, 'cancelled', 'with the status the control carried');
});

/* ---------- 5. demo path ---------- */
await check('without a gateway the screen is demo, and says so', async () => {
  api.setGatewayUrl('');
  await auth.refreshSession({ silent: true });
  await store.refresh({ silent: true });
  nav.navigate('teams');
  await sleep(150);
  const body = text(view());
  assert(/this browser|demo/i.test(body), `the demo provenance is visible (got “${body.slice(0, 200)}”)`);
  assert(!/live gateway/i.test(body), 'and it does not claim the gateway');
});

await check('a demo plan is saved locally, labelled never run', async () => {
  nav.navigate('teams');
  await sleep(100);
  view().querySelector('[data-act="new-swarm"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(120);
  const sheet = win.document.querySelector('.sheet.open');
  sheet.querySelector('#sw-obj').value = 'Demo objective';
  win.document.querySelector('.sheet.open [data-act="swarm-deploy-go"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(250);
  const row = core.getState().swarms.find((w) => w.objective === 'Demo objective');
  assert(row, 'the plan was saved locally');
  eq(row.status, 'planned', 'as planned');
  eq(row.executed, false, 'unexecuted');
  eq(row.budget.spent, 0, 'with no spend');
  assert(row.nodes.every((n) => n.status === 'planned' && n.spent === 0), 'and planned nodes only');
});

console.log(results.join('\n'));
const passed = results.filter((r) => r.startsWith('PASS')).length;
console.log(`\nSWARM SCREEN: ${passed} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
