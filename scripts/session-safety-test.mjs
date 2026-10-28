/* Race and isolation regression tests. Uses the real browser modules with controlled HTTP responses. */
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

const win = new Window({ url: 'https://app.test/#/home' });
for (const key of ['document', 'navigator', 'location', 'localStorage', 'history', 'HTMLElement', 'Event', 'CustomEvent', 'Node']) {
  Object.defineProperty(globalThis, key, { value: win[key], configurable: true, writable: true });
}
globalThis.window = win;
globalThis.matchMedia = win.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
win.document.body.innerHTML = '<div id="app"></div>';
const delay = (ms = 35) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const session = (id) => ({ principal: { id, name: id, role: 'Owner' }, permissions: ['read', 'event:read', 'approval:read', 'comms:read', 'comms:write'], csrfToken: `csrf-${id}` });
let user = 'A';
let pauseData = false;
let pauseLogin = false;
let denyTasks = false;
let commsForbidden = false;
let pauseComms = false;
let commsResolve;
const blocked = [];
let loginResolve;
let currentComms = { channels: [{ id: 'telegram', config: { botToken: '••••MASK' }, status: 'configured_unverified' }], recent: [{ text: 'private-server-message' }] };
const responseFor = (path, id) => {
  if (path === '/api/v1/agents') return [{ id: `agent-${id}`, name: `private-${id}` }];
  if (path === '/api/v1/tasks' || path === '/api/v1/approvals' || path.startsWith('/api/v1/events')) return [];
  return null;
};
globalThis.fetch = (url, opts = {}) => {
  const path = new URL(url, win.location.href).pathname + new URL(url, win.location.href).search;
  if (path === '/api/v1/auth/session') return Promise.resolve(json(session(user)));
  if (path === '/api/v1/auth/login') {
    if (pauseLogin) return new Promise((resolve) => { loginResolve = resolve; }); // deliberately ignores abort
    return Promise.resolve(json(session(user)));
  }
  if (path === '/api/v1/auth/logout') return Promise.resolve(json({ ok: true }));
  if (path === '/api/v1/comms') {
    if (pauseComms) return new Promise((resolve) => { commsResolve = resolve; });
    return Promise.resolve(json(commsForbidden ? { error: 'forbidden' } : currentComms, commsForbidden ? 403 : 200));
  }
  if (path === '/healthz') return new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
  if (denyTasks && path === '/api/v1/tasks') return Promise.resolve(json({ error: 'expired' }, 401));
  const body = responseFor(path, user);
  if (body !== null) {
    if (pauseData) return new Promise((resolve) => blocked.push(() => resolve(json(body))));
    return Promise.resolve(json(body));
  }
  return Promise.resolve(json({ error: 'not found' }, 404));
};
await import('../src/main.js');
await delay();
const auth = await import('../src/auth.js');
const api = await import('../src/api.js');
const core = await import('../src/core.js');
const data = await import('../src/datastore.js');
const comms = await import('../src/commsGateway.js');
const uiComms = await import('../src/comms.js');
const checks = [];
async function check(name, fn) { await fn(); checks.push(`PASS ${name}`); }

await auth.configureGateway('https://gateway.test');
await delay();
await check('late data responses cannot resurrect a signed-out identity', async () => {
  pauseData = true;
  const pending = data.refresh();
  await delay(5);
  assert(blocked.length >= 4);
  const logout = auth.logout();
  assert.equal(auth.getAuth().status, 'anonymous');
  blocked.splice(0).forEach((resolve) => resolve());
  assert.equal((await pending).ok, false);
  await logout;
  await delay();
  assert.equal(core.getProvenance().agents, 'demo');
  assert(!JSON.stringify(core.getState().agents).includes('private-A'));
  pauseData = false;
});

await check('a delayed sign-in cannot restore authentication or CSRF after sign-out', async () => {
  pauseLogin = true;
  const login = auth.login({ email: 'a', password: 'secret' });
  await delay(5);
  const logout = auth.logout();
  loginResolve(json(session('A')));
  assert.equal((await login).ok, false);
  await logout;
  assert.equal(auth.getAuth().status, 'anonymous');
  assert.equal(api.getCsrfToken(), null);
  pauseLogin = false;
});

await check('identity change removes old rows before new rows load', async () => {
  user = 'A';
  await auth.login({ email: 'a', password: 'secret' });
  await data.refresh();
  assert(core.getState().agents.some((a) => a.name === 'private-A'));
  user = 'B';
  pauseData = true;
  await auth.refreshSession({ silent: true });
  assert.equal(auth.getAuth().principal.id, 'B');
  assert(!JSON.stringify(core.getState().agents).includes('private-A'));
  assert.equal(core.getProvenance().agents, 'demo');
  blocked.splice(0).forEach((resolve) => resolve());
  await delay();
  assert(core.getState().agents.some((a) => a.name === 'private-B'));
  pauseData = false;
});

await check('gateway comms records and recent messages are not persisted', async () => {
  await comms.refreshComms();
  assert.equal(comms.commsIsGateway(), true);
  await delay(350);
  const stored = win.localStorage.getItem('swarmos-state-v1');
  assert(stored);
  assert(!stored.includes('private-server-message'));
  assert(!stored.includes('••••MASK'));
});

await check('403 clears previously adopted comms records and blocks local writes', async () => {
  commsForbidden = true;
  assert.equal((await comms.refreshComms()).ok, false);
  assert(!JSON.stringify(core.getState().commsGateway).includes('private-server-message'));
  assert.equal(comms.commsIsGateway(), false);
  // A denied write is a failure, not a browser-local fallback.
  const before = JSON.stringify(core.getState().comms);
  assert.equal(uiComms.toggleChannel('telegram', true).ok, false);
  assert.equal(JSON.stringify(core.getState().comms), before);
  commsForbidden = false;
});

await check('a 401 clears auth, CSRF and all adopted slices', async () => {
  await comms.refreshComms();
  assert.equal(comms.commsIsGateway(), true);
  denyTasks = true;
  await assert.rejects(api.api.tasks(), (e) => e.status === 401);
  await delay();
  assert.equal(auth.getAuth().status, 'anonymous');
  assert.equal(api.getCsrfToken(), null);
  assert.equal(core.getProvenance().agents, 'demo');
  assert.equal(comms.commsIsGateway(), false);
  assert(!JSON.stringify(core.getState().commsGateway).includes('private-server-message'));
  denyTasks = false;
});

await check('late comms responses cannot resurrect a signed-out identity', async () => {
  user = 'A';
  await auth.login({ email: 'a', password: 'secret' });
  await delay();
  pauseComms = true;
  const pending = comms.refreshComms();
  await delay(5);
  const logout = auth.logout();
  commsResolve(json(currentComms));
  assert.equal((await pending).ok, false);
  await logout;
  assert.equal(comms.commsIsGateway(), false);
  assert(!JSON.stringify(core.getState().commsGateway).includes('private-server-message'));
  pauseComms = false;
});

await check('timeout remains effective with a caller-provided signal', async () => {
  const external = new AbortController();
  await assert.rejects(api.api.health({ timeoutMs: 20, signal: external.signal }), (e) => e.code === 'timeout');
  assert.equal(external.signal.aborted, false);
});
console.log(checks.join('\n'));
console.log(`SESSION SAFETY: ${checks.length}/${checks.length} PASSED`);
process.exit(0);
