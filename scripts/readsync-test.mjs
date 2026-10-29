/* Read-sync tests (checklist 2.5): the module screens must show the *gateway's* rows when a
 * session exists, and must say plainly when they are showing demo fixtures instead.
 *
 * The stub gateway deliberately returns rows that do not exist in the demo fixtures, so a screen
 * that still renders fixture data fails the test.
 * Run: npm run test:readsync
 */
import { Window } from 'happy-dom';

const win = new Window({ url: 'http://localhost:5173/#/home' });
for (const k of ['document', 'navigator', 'location', 'localStorage', 'history', 'HTMLElement',
  'Event', 'CustomEvent', 'KeyboardEvent', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  const value = k === 'KeyboardEvent' ? win.KeyboardEvent : win[k] ?? win;
  try {
    Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
  } catch {
    try { globalThis[k] = value; } catch {}
  }
}
globalThis.window = win;
globalThis.document = win.document;
globalThis.localStorage = win.localStorage;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
win.matchMedia = globalThis.matchMedia;
win.document.body.innerHTML = '<div id="app"></div>';

/* ---------- stub gateway: distinct data, no WebSocket (the app must cope) ---------- */
const GW = 'http://gateway.test';
const GW_AGENT = 'Gateway-Bot-Alpha';
const GW_TASK = 'Gateway task from the server';
const GW_APPROVAL_ACTION = 'gateway.migration.apply';

const calls = [];
let behaviour = {};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-mmm-request-id': 'req-readsync' },
  });

const SESSION_BODY = {
  principal: { id: 'user-rs', name: 'Read Syncer', role: 'Owner', type: 'user', via: 'cookie', status: 'active' },
  permissions: ['read', 'summary:read', 'event:read', 'approval:read', 'approval:request', 'approval:decide',
    'audit:read', 'audit:verify', 'agent:write', 'task:write', 'swarm:write', 'principal:read',
    'principal:write', 'token:issue', 'token:revoke:any', 'system:diagnostics', 'dev:seed'],
  csrfToken: 'csrf-readsync',
};

function resetStub(next = {}) {
  behaviour = {
    session: { status: 401, body: { error: 'authentication required' } },
    login: { status: 200, body: SESSION_BODY },
    listAgents: {
      status: 200,
      body: [
        {
          id: 'ag-gw-1', name: GW_AGENT, role: 'Gateway role', framework: 'CrewAI', model: 'openai/gpt-5',
          fallback: 'deepseek/deepseek-v3', status: 'running', trust: 77, autonomy: 3, success_rate: 0.93,
          cost_today: 4.5, runs: 12, last_active: 1_700_000_000_000, tools: '["web.search"]',
          skills: '["core.citations"]', prompt: 'You are a gateway agent.', memory: '{"episodic":5,"semantic":9,"kb":"1 MB"}',
        },
      ],
    },
    listTasks: {
      status: 200,
      body: [{ id: 'tk-gw-1', title: GW_TASK, description: 'from the gateway', column_name: 'review', assignee: 'ag-gw-1', priority: 'high', deps: '[]', created_at: 1_700_000_100_000 }],
    },
    listApprovals: {
      status: 200,
      body: [{ id: 'ap-gw-1', action: GW_APPROVAL_ACTION, target: 'prod-eu', risk: 'high', principal: 'Gateway-Bot-Alpha', evidence: 'server evidence', status: 'pending', created_at: 1_700_000_200_000, decided_at: null, decider_id: null }],
    },
    listEvents: {
      status: 200,
      body: [{ id: 'ev-gw-1', cursor: 9, ts: 1_700_000_300_000, type: 'gateway', text: 'Gateway-side audit event' }],
    },
    createAgent: {
      status: 201,
      body: { id: 'ag-gw-new', name: 'Server-Renamed-Agent', role: 'Gateway role', framework: 'CrewAI', model: 'openai/gpt-5', status: 'idle', trust: 50, autonomy: 2, tools: '[]', skills: '[]', memory: '{}' },
    },
    decide: { status: 403, body: { error: 'separation of duties: you requested this gate' } },
    ...next,
  };
}
resetStub();

globalThis.fetch = async (url, options = {}) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '');
  const method = (options.method || 'GET').toUpperCase();
  calls.push({ path, method });
  if (path === '/healthz') return json({ ok: true, db: 'sqlite-wal', auth: { mode: 'required' } });
  if (path === '/api/v1/auth/session') return json(behaviour.session.body, behaviour.session.status);
  if (path === '/api/v1/auth/login') return json(behaviour.login.body, behaviour.login.status);
  if (path === '/api/v1/auth/logout') return json({ ok: true });
  if (path === '/api/v1/agents' && method === 'GET') return json(behaviour.listAgents.body, behaviour.listAgents.status);
  if (path === '/api/v1/agents' && method === 'POST') return json(behaviour.createAgent.body, behaviour.createAgent.status);
  if (path === '/api/v1/tasks' && method === 'GET') return json(behaviour.listTasks.body, behaviour.listTasks.status);
  if (path === '/api/v1/tasks' && method === 'POST') return json({ id: 'tk-new', title: 'x' }, 201);
  if (path === '/api/v1/approvals' && method === 'GET') return json(behaviour.listApprovals.body, behaviour.listApprovals.status);
  if (/^\/api\/v1\/approvals\/[^/]+\/(allow|deny)$/.test(path)) return json(behaviour.decide.body, behaviour.decide.status);
  if (path.startsWith('/api/v1/events')) return json(behaviour.listEvents.body, behaviour.listEvents.status);
  if (path.startsWith('/api/v1/audit')) return json([]);
  return json({ error: 'not found' }, 404);
};

/* ---------- harness ---------- */
const results = [];
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (err) {
    failures += 1;
    results.push(`FAIL ${name}: ${err.message}`);
  }
}
const assert = (cond, message) => { if (!cond) throw new Error(message); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

await import('../src/main.js');
await sleep(150);

const core = await import('../src/core.js');
const auth = await import('../src/auth.js');
const apiMod = await import('../src/api.js');
const data = await import('../src/datastore.js');
const nav = await import('../src/main.js');
const view = () => win.document.getElementById('view');
const chip = () => text(win.document.getElementById('source-chip'));
const note = () => text(win.document.getElementById('source-note-root'));

const demoAgentNames = core.getState().agents.map((a) => a.name);
assert(demoAgentNames.length > 0, 'demo fixtures should seed agents');

/* ---------- 1. no gateway → demo, labelled ---------- */
await check('demo mode reports demo provenance and never claims a gateway', async () => {
  const st = data.getStatus();
  eq(st.status, 'demo', 'status');
  eq(st.liveSlices.length, 0, 'no live slices');
  for (const slice of data.GATEWAY_SLICES) eq(core.getProvenance()[slice], 'demo', `${slice} provenance`);
  eq(data.sourceExplanation('agents').source, 'demo', 'agents explanation');
  nav.navigate('home');
  assert(/demo/i.test(chip()), `source chip should say demo (got "${chip()}")`);
  eq(note(), '', 'no gateway note while unconfigured');
});

/* ---------- 2. sign in → gateway rows replace fixtures ---------- */
await check('signing in adopts the gateway rows for agents, tasks, approvals and events', async () => {
  await auth.configureGateway(GW);
  await auth.login({ email: 'owner@test.local', password: 'right' });
  eq(auth.getAuth().status, 'authenticated', 'signed in');
  const out = await data.refresh();
  assert(out.ok, `refresh should succeed (got ${JSON.stringify(out)})`);

  const s = core.getState();
  eq(s.agents.length, 1, 'gateway agent count');
  eq(s.agents[0].name, GW_AGENT, 'gateway agent name');
  eq(s.agents[0].trust, 77, 'trust mapped from trust column');
  eq(s.agents[0].successRate, 0.93, 'success_rate mapped');
  eq(s.tasks.length, 1, 'gateway task count');
  eq(s.tasks[0].title, GW_TASK, 'gateway task title');
  eq(s.tasks[0].column, 'review', 'column_name mapped to column');
  eq(s.approvals.length, 1, 'gateway approval count');
  eq(s.approvals[0].action, GW_APPROVAL_ACTION, 'gateway approval action');
  eq(s.approvals[0].source, 'gateway', 'approval row tagged as gateway');

  assert(!s.agents.some((a) => demoAgentNames.includes(a.name)), 'demo agents must be gone, not merged');
  for (const slice of data.GATEWAY_SLICES) eq(core.getProvenance()[slice], 'gateway', `${slice} provenance`);
  eq(core.getProvenance().swarms, 'demo', 'swarms stay local (no gateway endpoint)');
});

await check('the agents screen renders gateway rows and says "live gateway"', async () => {
  nav.navigate('agents');
  const html = view().innerHTML;
  assert(html.includes(GW_AGENT), 'gateway agent should be on screen');
  assert(!html.includes(demoAgentNames[0]), `demo agent "${demoAgentNames[0]}" must not be on screen`);
  assert(/live gateway/.test(html), 'screen should carry the live-gateway tag');
  assert(!/demo data/.test(html), 'a live screen must not show the demo banner');
  // "live" once the WebSocket is open, "synced" while only the HTTP poll has run (no WS here).
  assert(/^(live|synced)$/.test(chip()), `chrome should say live/synced (got "${chip()}")`);
  assert(['off', 'connecting', 'reconnecting', 'refused'].includes(data.getStatus().ws), `ws state (${data.getStatus().ws})`);
  eq(note(), '', 'no fallback note when the gateway is live');
});

await check('the tasks screen renders the gateway card in its server column', async () => {
  nav.navigate('tasks');
  const html = view().innerHTML;
  assert(html.includes(GW_TASK), 'gateway task should be on screen');
  assert(/live gateway/.test(html), 'tasks screen should carry the live-gateway tag');
  const reviewCol = html.split('data-col="review"')[1] || '';
  assert(reviewCol.includes(GW_TASK), 'gateway task must sit in the review column');
});

await check('gateway rows are never written to localStorage', async () => {
  await sleep(400); // persist() is debounced
  const raw = globalThis.localStorage.getItem('mmm-state-v1') || '';
  assert(!raw.includes(GW_AGENT), 'gateway agent must not be persisted');
  assert(!raw.includes(GW_TASK), 'gateway task must not be persisted');
  assert(!raw.includes(GW_APPROVAL_ACTION), 'gateway approval must not be persisted');
  assert(demoAgentNames.some((n) => raw.includes(n)), 'the demo snapshot should still be persisted for offline use');
});

/* ---------- 3. writes: server copy wins, no duplicates ---------- */
await check('a create response replaces the local row with the server copy (no duplicate)', async () => {
  const before = core.getState().agents.length;
  const row = await data.createAgent({ name: 'Draft-Name-That-The-Server-Overrides' });
  eq(row.name, 'Server-Renamed-Agent', 'adapted server copy');
  const after = core.getState().agents;
  eq(after.length, before + 1, 'exactly one row added');
  eq(after.filter((a) => a.id === 'ag-gw-new').length, 1, 'server id appears once');
  assert(!after.some((a) => a.name === 'Draft-Name-That-The-Server-Overrides'), 'the client draft must not linger as a row');
  eq(after[0].id, 'ag-gw-new', 'the server copy leads the list');
});

await check('a refused approval decision leaves the gate pending and says why', async () => {
  resetStub({ session: { status: 200, body: SESSION_BODY } });
  await data.refresh();
  const gate = core.getState().approvals.find((a) => a.id === 'ap-gw-1');
  eq(gate.status, 'pending', 'gate starts pending');
  let error = null;
  try {
    await data.decideApproval('ap-gw-1', 'allow');
  } catch (err) {
    error = err;
  }
  assert(error, 'the 403 must surface as an error');
  assert(/separation of duties/i.test(error.message), `server message should be passed through (got "${error.message}")`);
  eq(core.getState().approvals.find((a) => a.id === 'ap-gw-1').status, 'pending', 'gate must not be marked decided locally');
});

await check('local events cannot be appended to a gateway-backed feed', async () => {
  eq(core.logEvent('agent', 'browser-only note'), false, 'logEvent must refuse when events are live');
  assert(!core.getState().events.some((e) => e.text === 'browser-only note'), 'event must not be in the feed');
});

/* ---------- 4. failures are labelled, not hidden ---------- */
await check('a failed refresh keeps the gateway rows but calls them stale', async () => {
  resetStub({ session: { status: 200, body: SESSION_BODY }, listTasks: { status: 500, body: { error: 'db locked' } } });
  const out = await data.refresh();
  eq(out.ok, false, 'refresh should report failure');
  const st = data.getStatus();
  eq(st.status, 'error', 'status');
  eq(core.getProvenance().agents, 'gateway', 'gateway provenance is not downgraded to demo');
  assert(core.getState().agents.some((a) => a.name === GW_AGENT), 'server rows stay on screen');
  nav.navigate('agents');
  assert(/stale/.test(chip()), `chrome should say stale (got "${chip()}")`);
  assert(/stale/i.test(note()), `note should explain staleness (got "${note()}")`);
});

await check('an unreachable gateway at boot falls back to demo and says so', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  await auth.refreshSession();
  eq(auth.getAuth().status, 'unreachable', 'auth status');
  await sleep(60);
  const st = data.getStatus();
  assert(['error', 'degraded'].includes(st.status), `status should be error/degraded (got ${st.status})`);
  eq(core.getProvenance().agents, 'demo', 'provenance falls back to demo');
  assert(core.getState().agents.some((a) => demoAgentNames.includes(a.name)), 'demo fixtures are back');
  assert(!core.getState().agents.some((a) => a.name === GW_AGENT), 'gateway rows must be gone, not mixed in');

  // Label first, then restore: the screen must admit it is showing fixtures.
  nav.navigate('agents');
  const html = view().innerHTML;
  assert(/demo data/.test(html), 'screen should label demo rows');
  assert(/not the gateway|unreachable|demo/i.test(note().concat(' ', chip())), `chrome should explain the fallback (note "${note()}", chip "${chip()}")`);
  assert(!/live gateway/.test(html), 'a demo screen must not claim live gateway');

  globalThis.fetch = realFetch;
  resetStub({ session: { status: 200, body: SESSION_BODY } });
  await auth.refreshSession();
  await sleep(80);
  nav.rerender();
  assert(/live gateway/.test(view().innerHTML), 'once the gateway is back the screen returns to live data');
});

await check('signing out restores the demo snapshot and clears gateway provenance', async () => {
  await auth.login({ email: 'owner@test.local', password: 'right' });
  const ok = await data.refresh();
  assert(ok.ok, 'refresh after sign-in');
  await auth.logout();
  await sleep(60);
  eq(core.getProvenance().agents, 'demo', 'provenance reset');
  assert(core.getState().agents.some((a) => demoAgentNames.includes(a.name)), 'demo fixtures restored');
  assert(!core.getState().agents.some((a) => a.name === GW_AGENT), 'gateway rows dropped');
  const st = data.getStatus();
  eq(st.liveSlices.length, 0, 'no live slices after sign-out');
});

await check('demo mode keeps local writes and local events working', async () => {
  await auth.configureGateway('');
  eq(apiMod.isApiMode(), false, 'back to demo mode');
  eq(core.logEvent('agent', 'demo event still works'), true, 'logEvent works in demo mode');
  assert(core.getState().events.some((e) => e.text === 'demo event still works'), 'event recorded');
  nav.navigate('agents');
  assert(/demo/i.test(chip()), 'chip back to demo');
});

const realLog = console.log;
realLog(results.join('\n'));
if (failures) {
  console.error(`\n${failures} read-sync test(s) failed`);
  process.exit(1);
}
console.log(`\nREAD SYNC: ${results.length}/${results.length} PASSED`);
process.exit(0);
