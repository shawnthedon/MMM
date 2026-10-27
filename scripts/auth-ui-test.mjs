/* Sign-in / RBAC client tests: happy-dom + a stub gateway that mimics the real contract.
 * The real gateway behaviour is covered by scripts/gateway-auth-test.mjs.
 * Run: npm run test:auth
 */
import { Window } from 'happy-dom';

const win = new Window({ url: 'http://localhost:5173/#/home' });
for (const k of ['window', 'document', 'navigator', 'location', 'localStorage', 'history', 'HTMLElement',
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

/* ---------- stub gateway ---------- */
const calls = [];
let behaviour = {};
function resetStub(next = {}) {
  behaviour = {
    session: { status: 401, body: { error: 'authentication required' } },
    login: { status: 401, body: { error: 'invalid credentials' } },
    createAgent: { status: 201, body: { id: 'ag-api-1', name: 'ApiBot', status: 'idle' } },
    createTask: { status: 201, body: { id: 'tk-api-1', title: 'Api task', column: 'todo' } },
    decide: { status: 200, body: { id: 'ap-1', action: 'vercel.deploy', status: 'allowed', decider_id: 'user-test' } },
    summary: { status: 200, body: { agents: 2, running: 1, teams: 1, swarmsLive: 0, tasks: 3, approvalsPending: 1, principals: 2 } },
    listAgents: { status: 200, body: [{ id: 'ag-api-1', name: 'ApiBot', framework: 'LangGraph', model: 'm', trust: 60, status: 'idle' }] },
    listTasks: { status: 200, body: [{ id: 'tk-api-1', title: 'Api task', column_name: 'todo', assignee: null }] },
    listApprovals: { status: 200, body: [{ id: 'ap-1', action: 'vercel.deploy', target: 'prod', risk: 'high', principal: 'ApiBot', status: 'pending' }] },
    ...next,
  };
}
resetStub();

const SESSION_BODY = {
  principal: { id: 'user-test', name: 'Test Owner', role: 'Owner', type: 'user', via: 'cookie', status: 'active' },
  permissions: ['read', 'summary:read', 'event:read', 'approval:read', 'approval:request', 'approval:decide',
    'audit:read', 'audit:verify', 'agent:write', 'task:write', 'swarm:write', 'principal:read',
    'principal:write', 'token:issue', 'token:revoke:any', 'system:diagnostics', 'dev:seed'],
  csrfToken: 'csrf-token-abc',
  token: null,
};

function reply({ status, body }) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-swarmos-request-id': 'req-stub' },
  });
}

globalThis.fetch = async (url, options = {}) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '');
  const method = (options.method || 'GET').toUpperCase();
  calls.push({ path, method, headers: options.headers || {}, credentials: options.credentials, body: options.body });
  if (path === '/healthz') return reply({ status: 200, body: { ok: true, db: 'sqlite-wal', auth: { mode: 'required' } } });
  if (path === '/api/v1/auth/session') return reply(behaviour.session);
  if (path === '/api/v1/auth/login') {
    if (behaviour.login.status === 200) return reply({ status: 200, body: { ...SESSION_BODY, permissions: behaviour.login.permissions || SESSION_BODY.permissions } });
    return reply(behaviour.login);
  }
  if (path === '/api/v1/auth/logout') return reply({ status: 200, body: { ok: true } });
  if (path === '/api/v1/auth/password') return reply(behaviour.password || { status: 200, body: { ok: true } });
  if (path === '/api/v1/summary') return reply(behaviour.summary);
  if (path === '/api/v1/agents' && method === 'GET') return reply(behaviour.listAgents);
  if (path === '/api/v1/agents' && method === 'POST') return reply(behaviour.createAgent);
  if (path === '/api/v1/tasks' && method === 'GET') return reply(behaviour.listTasks);
  if (path === '/api/v1/tasks' && method === 'POST') return reply(behaviour.createTask);
  if (path === '/api/v1/approvals' && method === 'GET') return reply(behaviour.listApprovals);
  if (/^\/api\/v1\/approvals\/[^/]+\/(allow|deny)$/.test(path)) return reply(behaviour.decide);
  if (path.startsWith('/api/v1/events')) return reply({ status: 200, body: [] });
  if (path.startsWith('/api/v1/audit')) return reply({ status: 200, body: [] });
  return reply({ status: 404, body: { error: 'not found' } });
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

await import('../src/main.js');
await sleep(120);

const auth = await import('../src/auth.js');
const apiMod = await import('../src/api.js');
const copilot = await import('../src/copilot.js');
const nav = await import('../src/main.js');
const view = () => win.document.getElementById('view');
const panel = () => win.document.getElementById('copilot-panel');

/* ---------- 1. default: demo mode, clearly labelled ---------- */
await check('starts in demo mode with no gateway configured', async () => {
  const state = auth.getAuth();
  eq(state.status, 'demo', 'auth status');
  eq(apiMod.mode(), 'demo', 'api mode');
  eq(apiMod.isApiMode(), false, 'isApiMode');
  nav.navigate('home');
  const chip = win.document.getElementById('identity-chip');
  assert(/demo/i.test(chip.textContent), `identity chip should say demo (got "${chip.textContent.trim()}")`);
});

/* ---------- 2. configuring a gateway that requires auth gated to login ---------- */
await check('configuring an auth-required gateway gates the app to the sign-in screen', async () => {
  resetStub();
  await auth.configureGateway('http://gateway.test');
  eq(apiMod.gatewayUrl(), 'http://gateway.test', 'gateway url stored');
  eq(auth.getAuth().status, 'anonymous', 'status after 401 session');
  nav.navigate('login');
  const html = view().innerHTML;
  assert(/Sign in/.test(html), 'login heading missing');
  assert(win.document.getElementById('login-email'), 'email field missing');
  assert(win.document.getElementById('login-password')?.type === 'password', 'password field must be masked');
  assert(/HttpOnly/.test(html), 'should explain cookie handling');
  assert(/signed out/i.test(win.document.getElementById('identity-chip').textContent), 'identity chip should show signed out');
});

await check('demo mode is still explicitly offered from the login screen', async () => {
  const html = view().innerHTML;
  assert(/Continue without a gateway/.test(html), 'demo escape hatch missing');
  assert(/unenforced/i.test(html), 'demo mode must be labelled unenforced');
});

/* ---------- 3. failed login surfaces the gateway message ---------- */
await check('failed sign-in shows the gateway error and stays anonymous', async () => {
  resetStub({ login: { status: 401, body: { error: 'invalid credentials' } } });
  const out = await auth.login({ email: 'owner@test.local', password: 'wrong' });
  eq(out.ok, false, 'login result');
  eq(out.error, 'invalid credentials', 'error surfaced verbatim');
  eq(auth.getAuth().status, 'anonymous', 'still anonymous');
  nav.navigate('login');
  nav.rerender();
  const form = win.document.getElementById('login-form');
  form.querySelector('#login-email').value = 'owner@test.local';
  form.querySelector('#login-password').value = 'wrong';
  form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(60);
  assert(/invalid credentials/i.test(win.document.getElementById('login-error').textContent), 'inline error not shown');
});

/* ---------- 4. successful login ---------- */
await check('successful sign-in stores the session, role and CSRF token', async () => {
  resetStub({ login: { status: 200 } });
  const out = await auth.login({ email: 'owner@test.local', password: 'OwnerPassw0rd!2026' });
  eq(out.ok, true, 'login result');
  const state = auth.getAuth();
  eq(state.status, 'authenticated', 'status');
  eq(state.principal.role, 'Owner', 'role');
  assert(state.permissions.includes('agent:write'), 'permissions stored');
  eq(apiMod.getCsrfToken(), 'csrf-token-abc', 'csrf token captured from login response');
  nav.navigate('home');
  nav.rerender();
  assert(/Owner/.test(win.document.getElementById('identity-chip').textContent), 'identity chip should show the role');
  assert(!JSON.stringify(win.localStorage).includes('csrf-token-abc'), 'CSRF token must not be persisted to localStorage');
});

/* ---------- 5. Copilot reflects server enforcement ---------- */
await check('copilot capability reports server-enforced actions when signed in', async () => {
  const cap = copilot.getCapability('actions');
  eq(cap.status, 'available', 'capability status');
  assert(/Server-enforced/i.test(cap.summary), 'summary should say server-enforced');
  assert(/audit/i.test(cap.detail), 'detail should mention the audit log');
});

await check('agent creation goes through the gateway with CSRF and reports the gateway id', async () => {
  calls.length = 0;
  copilot.resetCopilotSession();
  copilot.openCopilot({ mode: 'operate' });
  copilot.copilotSend('create agent ApiBot');
  await sleep(400);
  const btn = panel().querySelector('[data-cp="confirm"]');
  assert(btn, 'no confirm button');
  btn.click();
  await sleep(300);
  const post = calls.find((c) => c.path === '/api/v1/agents' && c.method === 'POST');
  assert(post, 'no POST /api/v1/agents request');
  eq(post.credentials, 'include', 'credentials mode');
  eq(post.headers['x-swarmos-csrf'], 'csrf-token-abc', 'CSRF header must be sent');
  const text = panel().querySelector('#copilot-work').textContent;
  assert(/created on the gateway/i.test(text), `result should cite the gateway (got: ${text.slice(-300)})`);
  assert(/ag-api-1/.test(text), 'should include the gateway record id');
  assert(/audit/i.test(text), 'should mention the audit entry');
});

await check('a 403 from the gateway is reported as blocked, with no local mutation', async () => {
  resetStub({ createAgent: { status: 403, body: { error: 'role "Observer" lacks permission "agent:write"' } } });
  copilot.resetCopilotSession();
  copilot.openCopilot({ mode: 'operate' });
  copilot.copilotSend('create agent DeniedBot');
  await sleep(400);
  const btn = panel().querySelector('[data-cp="confirm"]');
  btn.click();
  await sleep(300);
  const text = panel().querySelector('#copilot-work').textContent;
  assert(/lacks permission/i.test(text), 'gateway denial text missing');
  assert(/blocked/i.test(text), 'should be marked blocked');
  const { getState } = await import('../src/core.js');
  assert(!getState().agents.some((a) => /DeniedBot/i.test(a.name)), 'must not fall back to the demo store');
});

await check('permission is checked locally before the request when the role is insufficient', async () => {
  resetStub({ login: { status: 200, permissions: ['read', 'summary:read', 'event:read', 'approval:read', 'token:issue'] } });
  await auth.login({ email: 'observer@test.local', password: 'ObserverPass1!' });
  eq(auth.getAuth().principal.role, 'Owner', 'stub keeps owner principal by design');
  const cap = copilot.getCapability('actions');
  eq(cap.status, 'blocked', 'capability should be blocked for a read-only permission set');
  calls.length = 0;
  copilot.resetCopilotSession();
  copilot.openCopilot({ mode: 'operate' });
  copilot.copilotSend('create agent ShouldNotPost');
  await sleep(400);
  const btn = panel().querySelector('[data-cp="confirm"]');
  if (btn) btn.click();
  await sleep(250);
  const posted = calls.some((c) => c.path === '/api/v1/agents' && c.method === 'POST');
  assert(!posted, 'no request should be sent without agent:write');
  assert(/lacks/i.test(panel().querySelector('#copilot-work').textContent), 'should explain the missing permission');
});

/* ---------- 6. approval decisions + separation of duties messaging ---------- */
await check('approval decisions are sent to the gateway', async () => {
  resetStub({ login: { status: 200 } });
  await auth.login({ email: 'owner@test.local', password: 'OwnerPassw0rd!2026' });
  calls.length = 0;
  copilot.resetCopilotSession();
  copilot.openCopilot({ mode: 'operate' });
  copilot.copilotSend('approve ap-1');
  await sleep(420);
  const arm = panel().querySelector('[data-cp="arm"]');
  assert(arm, 'consequential gate decision must need arming');
  arm.click();
  panel().querySelector('[data-cp="confirm"]').click();
  await sleep(320);
  assert(calls.some((c) => /^\/api\/v1\/approvals\/ap-1\/allow$/.test(c.path) && c.method === 'POST'), 'no decide request');
  assert(/audit chain/i.test(panel().querySelector('#copilot-work').textContent), 'should confirm the audit entry');
});

await check('gateway refusal for self-approval is surfaced as blocked', async () => {
  resetStub({ decide: { status: 403, body: { error: 'separation of duties: you requested this gate' } } });
  copilot.resetCopilotSession();
  copilot.openCopilot({ mode: 'operate' });
  copilot.copilotSend('approve ap-1');
  await sleep(420);
  panel().querySelector('[data-cp="arm"]')?.click();
  panel().querySelector('[data-cp="confirm"]')?.click();
  await sleep(320);
  const text = panel().querySelector('#copilot-work').textContent;
  assert(/separation of duties/i.test(text), 'server reason must reach the user');
});

/* ---------- 7. session expiry / 401 handling ---------- */
await check('a 401 during work drops the app back to sign-in', async () => {
  resetStub({ session: { status: 200, body: SESSION_BODY }, createAgent: { status: 401, body: { error: 'session expired' } } });
  await auth.refreshSession();
  eq(auth.getAuth().status, 'authenticated', 'precondition: signed in');
  nav.navigate('home');
  copilot.resetCopilotSession();
  copilot.openCopilot({ mode: 'operate' });
  copilot.copilotSend('create agent ExpiryBot');
  await sleep(400);
  panel().querySelector('[data-cp="confirm"]')?.click();
  await sleep(350);
  assert(/session expired/i.test(panel().querySelector('#copilot-work').textContent), '401 detail surfaced');
  resetStub();
  await auth.refreshSession();
  eq(auth.getAuth().status, 'anonymous', 'session lost after 401');
  nav.navigate('login');
  nav.rerender();
  assert(/Sign in/.test(view().innerHTML), 'sign-in screen reachable after 401');
});

/* ---------- 8. gateway URL persistence + logout ---------- */
await check('gateway URL persists locally but credentials never do', async () => {
  const raw = win.localStorage.getItem('swarmos.gateway');
  eq(raw, 'http://gateway.test', 'gateway url stored');
  const dump = JSON.stringify({ ...win.localStorage });
  assert(!/OwnerPassw0rd/.test(dump), 'password must never be persisted');
  assert(!/swarmos_session/i.test(dump), 'session cookie must never be persisted by the client');
});

await check('signing out clears the session state', async () => {
  resetStub({ session: { status: 200, body: SESSION_BODY } });
  await auth.refreshSession();
  eq(auth.getAuth().status, 'authenticated', 'signed in before logout');
  await auth.logout();
  eq(auth.getAuth().status, 'anonymous', 'anonymous after logout');
  eq(auth.can('agent:write'), false, 'permissions cleared');
});

/* ---------- 9. unreachable gateway ---------- */
await check('an unreachable gateway is reported, not silently faked', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await auth.configureGateway('http://down.test');
  eq(auth.getAuth().status, 'unreachable', 'status');
  assert(/unreachable/i.test(auth.getAuth().error), 'error should say unreachable');
  eq(copilot.getCapability('actions').status, 'unconfigured', 'capability should be unconfigured while offline');
  globalThis.fetch = realFetch;
});

await check('returning to demo mode restores the unenforced label', async () => {
  await auth.configureGateway('');
  eq(auth.getAuth().status, 'demo', 'status');
  nav.rerender();
  assert(/demo/i.test(win.document.getElementById('identity-chip').textContent), 'identity chip back to demo');
  eq(copilot.getCapability('actions').status, 'demo', 'capability demo');
});

copilot.resetCopilotSession();

console.log(results.join('\n'));
if (failures) {
  console.error(`\n${failures} auth client test(s) failed`);
  process.exit(1);
}
console.log(`\nAUTH CLIENT: ${results.length}/${results.length} PASSED`);
process.exit(0);
