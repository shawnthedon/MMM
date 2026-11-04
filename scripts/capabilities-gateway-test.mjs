/* Capability catalogue — the drift test.
 * Run: npm run test:capabilities
 *
 * The catalogue in apps/gateway/src/capabilities.js is declared by hand, which is the only way to express a
 * risk class, a confirmation rule, or "no service exists". Hand-declared means it can drift, so this suite
 * is what makes it safe. Against a live gateway it asserts:
 *
 *   • every served route is claimed by exactly one operation or explicitly excused, and every declared route
 *     exists with the permission and mutation flag the operation claims;
 *   • no operation is ever `available` without a real route, a met permission and a held permission;
 *   • the same catalogue reads differently for an Observer and an Owner — in `allowed`, never in `state`;
 *   • the four runtime gates (provider key, Chromium, speech host, evolution policy) move state, and the
 *     provider gate is exercised in both directions;
 *   • an operation with no service says so and claims no route;
 *   • reading the catalogue writes no audit rows, and an unauthenticated caller cannot read it at all.
 */
import { mkdirSync, rmSync } from 'node:fs';

const PORT = Number(process.env.MMM_TEST_PORT || 8898);
const DATA_DIR = `/tmp/mmm-capabilities-${process.pid}`;
rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;
process.env.MMM_QUIET = '1';
process.env.MMM_SECRET = 'test-secret-material-that-is-long-enough-1234';
process.env.MMM_BOOTSTRAP_EMAIL = 'owner@capabilities.local';
process.env.MMM_BOOTSTRAP_PASSWORD = 'OwnerPassw0rd!2026';
process.env.MMM_BROWSER_DISABLE = '1';
process.env.MMM_COMMS_DISABLE = '1';

let passed = 0;
let failures = 0;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    results.push(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    results.push(`FAIL ${name}\n     ${error.message}`);
  }
}
function assert(value, message) {
  if (!value) throw new Error(message || 'assertion failed');
}
function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message || 'value'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const { createGateway } = await import('../apps/gateway/server.js');
const authMod = await import('../apps/gateway/src/auth.js');
const caps = await import('../apps/gateway/src/capabilities.js');
const dbMod = await import('../apps/gateway/src/db.js');

const BASE = `http://127.0.0.1:${PORT}`;
const gateway = createGateway();
await new Promise((resolve) => gateway.server.listen(PORT, '127.0.0.1', resolve));

function client() {
  const jar = {};
  const api = {
    csrf: null,
    async request(path, { method = 'GET', body } = {}) {
      const headers = {};
      const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookies) headers.cookie = cookies;
      if (method !== 'GET' && api.csrf) headers[authMod.CSRF_HEADER] = api.csrf;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      for (const raw of res.headers.getSetCookie?.() || []) {
        const [pair] = raw.split(';');
        const i = pair.indexOf('=');
        jar[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
      }
      const text = await res.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      return { status: res.status, body: parsed, text };
    },
    async login(email, password) {
      const out = await api.request('/api/v1/auth/login', { method: 'POST', body: { email, password } });
      if (out.status !== 200) throw new Error(`login ${email}: ${out.text}`);
      api.csrf = out.body.csrfToken || (await api.request('/api/v1/auth/session')).body.csrfToken;
    },
  };
  return api;
}

const owner = client();
await owner.login('owner@capabilities.local', 'OwnerPassw0rd!2026');

async function makePrincipal(name, role) {
  const email = `${name}@capabilities.local`;
  const res = await owner.request('/api/v1/principals', {
    method: 'POST',
    body: { name, email, role, password: 'AnotherPassw0rd!2026', type: 'human' },
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`create ${name}: ${res.status} ${res.text}`);
  const c = client();
  await c.login(email, 'AnotherPassw0rd!2026');
  return c;
}
const observer = await makePrincipal('observer', 'Observer');
const reviewer = await makePrincipal('reviewer', 'Reviewer');

async function getCatalogue(who) {
  const res = await who.request('/api/v1/capabilities');
  eq(res.status, 200, 'GET /capabilities');
  return res.body;
}
const byId = (body) => Object.fromEntries(body.operations.map((o) => [o.id, o]));

/* ---------- 1. the catalogue describes the whole route table ---------- */

await check('every served route is claimed by exactly one operation or explicitly excused, and claims match the table', async () => {
  const cov = caps.coverage();
  assert(cov.served >= 150, `expected the full route table, saw ${cov.served}`);
  eq(cov.missing.length, 0, `declared routes that do not exist: ${JSON.stringify(cov.missing)}`);
  eq(cov.undeclared.length, 0, `served routes nobody claims and no excuse covers: ${JSON.stringify(cov.undeclared)}`);
  eq(cov.staleExcuses.length, 0, `excuses for routes that no longer exist: ${JSON.stringify(cov.staleExcuses)}`);
  eq(cov.mismatched.length, 0, `declared metadata disagrees with the route table: ${JSON.stringify(cov.mismatched)}`);
  eq(cov.claims + cov.unexposed, cov.served, 'claims + excuses must account for every route exactly once');
  eq(cov.ok, true, 'coverage.ok');

  const body = await getCatalogue(owner);
  eq(body.coverage.served, cov.served, 'the response reports the table it checked');
  eq(body.coverage.ok, true, 'the response reports no drift');
});

/* ---------- 2. shape: the fields a dispatcher needs ---------- */

await check('every operation carries the fields a dispatcher needs', async () => {
  const body = await getCatalogue(owner);
  const risks = ['read-only', 'reversible', 'consequential', 'destructive'];
  const confirmations = ['none', 'confirm', 'approval'];
  for (const op of body.operations) {
    assert(op.id && op.module && op.label && op.description, `${op.id}: identity fields`);
    assert(['read', 'mutation'].includes(op.kind), `${op.id}: kind “${op.kind}”`);
    assert(risks.includes(op.risk), `${op.id}: risk “${op.risk}”`);
    assert(confirmations.includes(op.confirmation), `${op.id}: confirmation “${op.confirmation}”`);
    assert(typeof op.reversible === 'boolean', `${op.id}: reversible`);
    assert(typeof op.idempotent === 'boolean', `${op.id}: idempotent`);
    assert(['none', 'per-request'].includes(op.audit), `${op.id}: audit “${op.audit}”`);
    assert(Number.isFinite(op.timeoutMs) && op.timeoutMs > 0, `${op.id}: timeoutMs`);
    assert(typeof op.permission === 'string' && op.permission.length > 0, `${op.id}: permission`);
    assert(Array.isArray(op.routes) && Array.isArray(op.requires), `${op.id}: routes/requires arrays`);
  }
});

await check('a read is read-only and unconfirmed; a mutation is audited per request', async () => {
  const body = await getCatalogue(owner);
  for (const op of body.operations) {
    if (op.kind === 'read') {
      eq(op.risk, 'read-only', `${op.id}: a read must be read-only`);
      eq(op.confirmation, 'none', `${op.id}: a read must not ask for confirmation`);
      eq(op.audit, 'none', `${op.id}: a read is not audited per request`);
    } else {
      eq(op.audit, 'per-request', `${op.id}: a mutation is audited per request`);
    }
  }
});

await check('every destructive operation is irreversible and needs an approval gate', async () => {
  const body = await getCatalogue(owner);
  const destructive = body.operations.filter((o) => o.risk === 'destructive');
  assert(destructive.length >= 8, `expected the destructive operations to be declared, saw ${destructive.length}`);
  for (const op of destructive) {
    eq(op.reversible, false, `${op.id}: destructive but reversible`);
    eq(op.confirmation, 'approval', `${op.id}: destructive operations need an approval gate`);
  }
});

/* ---------- 3. availability is earned, never asserted ---------- */

await check('an operation is never available without a route and a met requirement, for any role', async () => {
  for (const who of [owner, observer, reviewer]) {
    const body = await getCatalogue(who);
    for (const op of body.operations) {
      if (op.state !== 'available') continue;
      assert(op.routes.length > 0, `${op.id} is available with no route`);
      const unmet = (op.requires || []).filter((r) => !body.requirements[r]?.met);
      eq(unmet.length, 0, `${op.id} is available with unmet requirements ${unmet.join(',')}`);
    }
    // State is a deployment fact: it must not change with the caller.
    const baseline = byId(await getCatalogue(owner));
    for (const op of body.operations) eq(op.state, baseline[op.id].state, `${op.id}: state changed with the role`);
  }
  // Authority is the other axis, and an Owner holds every declared permission.
  const asOwner = await getCatalogue(owner);
  for (const op of asOwner.operations) eq(op.allowed, true, `${op.id}: an Owner must hold every declared permission`);
});

await check('the same catalogue reads differently for an Observer — in allowed, never in state', async () => {
  const asOwner = await getCatalogue(owner);
  const asObserver = await getCatalogue(observer);
  eq(asObserver.operations.length, asOwner.operations.length, 'operation count must not depend on role');
  eq(asObserver.operations.map((o) => o.id).join(','), asOwner.operations.map((o) => o.id).join(','), 'same ids, same order');

  const o = byId(asOwner);
  const v = byId(asObserver);
  eq(v['agents.create'].allowed, false, 'Observer must not hold agent:write');
  eq(o['agents.create'].allowed, true, 'Owner holds agent:write');
  eq(v['agents.create'].state, o['agents.create'].state, 'state is a deployment fact, not a role fact');
  eq(v['agents.list'].allowed, true, 'Observer may read agents');
  eq(v['audit.verify'].allowed, false, 'Observer may not verify the audit chain');
  eq(v['agents.delete'].allowed, false, 'Observer may not delete an agent');
});

await check('a refusal names the permission the role lacks', async () => {
  const body = await getCatalogue(observer);
  const op = byId(body)['agents.create'];
  assert(/role does not hold the permission/i.test(op.reason), `the reason must name the missing permission, got “${op.reason}”`);
  eq(op.permission, 'agent:write', 'the operation states the permission it needs');
});

await check('a Reviewer holds approval:decide but neither evolution:policy nor terminal:run', async () => {
  const body = await getCatalogue(reviewer);
  const o = byId(body);
  eq(o['approvals.decide'].allowed, true, 'Reviewer decides approvals');
  eq(o['evolution.policy.set'].allowed, false, 'evolution:policy is Owner-only');
  eq(o['terminal.exec'].allowed, false, 'terminal:run is Operator and above, not Reviewer');
  eq(o['evolution.experiments.review'].allowed, true, 'Reviewer reviews candidates');
});

await check('every declared permission exists in the gateway’s permission set', async () => {
  const rbac = await import('../apps/gateway/src/rbac.js');
  const known = new Set([...rbac.PERMISSION_LIST, 'public']);
  const body = await getCatalogue(owner);
  for (const op of body.operations) {
    assert(known.has(op.permission), `${op.id} declares “${op.permission}”, which the gateway does not define`);
  }
});

await check('what the catalogue calls forbidden, the gateway actually refuses', async () => {
  const body = await getCatalogue(observer);
  const o = byId(body);
  const sample = [
    ['agents.create', 'POST', '/api/v1/agents', { name: 'Nope' }],
    ['tasks.create', 'POST', '/api/v1/tasks', { title: 'Nope' }],
    ['teams.create', 'POST', '/api/v1/teams', { name: 'Nope' }],
    ['models.budget', 'PUT', '/api/v1/budget', { dailyUsd: 1 }],
    ['copilot.send', 'POST', '/api/v1/copilot/messages', { text: 'hi' }],
    ['terminal.session.create', 'POST', '/api/v1/terminal/sessions', {}],
  ];
  for (const [id, method, path, payload] of sample) {
    eq(o[id].allowed, false, `${id} must be reported as forbidden for an Observer`);
    const res = await observer.request(path, { method, body: payload });
    eq(res.status, 403, `${id}: the gateway must refuse it too (got ${res.status} ${res.text})`);
    assert(new RegExp(o[id].permission.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(res.text), `${id}: the refusal should name “${o[id].permission}”, got “${res.text}”`);
  }
});

/* ---------- 4. the runtime gates are real probes ---------- */

await check('with no sealed key, every model-calling operation is unconfigured and names the key', async () => {
  const body = await getCatalogue(owner);
  const o = byId(body);
  eq(body.requirements['provider-key'].met, false, 'the probe says no key is sealed');
  for (const id of ['copilot.send', 'providers.call']) {
    eq(o[id].state, 'unconfigured', `${id} state`);
    assert(/provider key/i.test(o[id].reason), `${id} must name the missing key, got “${o[id].reason}”`);
  }
  eq(o['agents.list'].state, 'available', 'an operation with no runtime need stays available');
});

await check('sealing a key flips those operations to available, and clearing it flips them back', async () => {
  eq(byId(await getCatalogue(owner))['copilot.send'].state, 'unconfigured', 'before');

  const put = await owner.request('/api/v1/providers/pv-openai/key', {
    method: 'PUT',
    body: { apiKey: 'sk-test-capabilities-0123456789abcdef', endpoint: 'http://127.0.0.1:9/v1/chat/completions' },
  });
  eq(put.status, 200, `seal key: ${put.text}`);

  const during = await getCatalogue(owner);
  eq(during.requirements['provider-key'].met, true, 'the probe sees the key');
  eq(byId(during)['copilot.send'].state, 'available', 'after sealing');
  eq(byId(during)['providers.call'].state, 'available', 'the test call is offered too');

  const clear = await owner.request('/api/v1/providers/pv-openai/key', { method: 'DELETE' });
  eq(clear.status, 200, `clear key: ${clear.text}`);
  const after = await getCatalogue(owner);
  eq(after.requirements['provider-key'].met, false, 'the probe sees the key is gone');
  eq(byId(after)['copilot.send'].state, 'unconfigured', 'after clearing');
});

await check('with no browser engine, automation is unconfigured rather than offered', async () => {
  const body = await getCatalogue(owner);
  const o = byId(body);
  eq(body.requirements.chromium.met, false, 'the engine probe');
  for (const id of ['browser.start', 'browser.control', 'copilot.scripts.activate']) {
    eq(o[id].state, 'unconfigured', `${id} state`);
    assert(/browser engine/i.test(o[id].reason), `${id} must name the engine, got “${o[id].reason}”`);
  }
});

await check('with no speech host, transcription is unconfigured and names the host', async () => {
  const body = await getCatalogue(owner);
  const op = byId(body)['voice.transcribe'];
  eq(body.requirements['speech-host'].met, false, 'the speech probe');
  eq(op.state, 'unconfigured', 'voice.transcribe state');
  assert(/speech host/i.test(op.reason), `reason: “${op.reason}”`);
});

await check('an evolution operation follows the policy probe instead of claiming readiness', async () => {
  const body = await getCatalogue(owner);
  const met = body.requirements['evolution-policy'].met;
  const expected = met ? 'available' : 'unconfigured';
  eq(byId(body)['evolution.health'].state, expected, `evolution.health must follow the probe (met=${met})`);
  if (!met) assert(/evolution policy/i.test(byId(body)['evolution.health'].reason), 'the reason names the policy');
});

await check('an unconfigured operation is still listed, with the route that would serve it', async () => {
  const body = await getCatalogue(owner);
  const op = byId(body)['browser.start'];
  eq(op.routes.length, 1, 'the route is still reported');
  eq(op.routes[0], 'POST /api/v1/browser/tasks', 'and it is the real one');
});

/* ---------- 5. operations with no service ---------- */

await check('an operation with no service claims no route and explains itself', async () => {
  const body = await getCatalogue(owner);
  const none = body.operations.filter((o) => o.state === 'no-service');
  // The floor was 9 while `files.upload` had no service. The file service exists now, so the honest floor
  // is 8 — and the named list below is what actually guards against a service disappearing quietly.
  assert(none.length >= 8, `expected the declared no-service operations, saw ${none.length}`);
  for (const op of none) {
    eq(op.routes.length, 0, `${op.id} must claim no route`);
    assert(op.reason.length > 20, `${op.id} must explain itself, got “${op.reason}”`);
  }
  const ids = none.map((o) => o.id);
  // `files.upload` was on this list until the file service existed. The registry placeholder is gone and
  // the operation is real now, so the assertion moved with it: files has routes, and what remains without
  // a service still says so by name.
  for (const expected of ['agents.run', 'swarms.execute', 'skills.activate', 'local.inference', 'analytics.series', 'plugins.connect', 'training.validate']) {
    assert(ids.includes(expected), `${expected} must be declared as having no service`);
  }
  assert(!ids.includes('files.upload'), 'the files.upload placeholder must be gone now that the file service exists');
  assert(byId(body)['files.list'].routes.length > 0, 'and files.list must declare the route it is served by');
  eq(byId(body)['swarms.execute'].state, 'no-service', 'a swarm plan cannot be executed');
  assert(/deploy/i.test(byId(body)['swarms.execute'].note), 'the note names the phantom deploy route');
});

/* ---------- 6. reads do not write, and the door is locked ---------- */

await check('reading the catalogue adds nothing to the audit log', async () => {
  const before = dbMod.db.prepare('SELECT COUNT(*) n FROM audit_log').get().n;
  await getCatalogue(owner);
  await getCatalogue(observer);
  const after = dbMod.db.prepare('SELECT COUNT(*) n FROM audit_log').get().n;
  eq(after, before, 'a read must not write audit rows');
});

await check('GET /capabilities/:id returns one operation, and an unknown id is a 404', async () => {
  const one = await owner.request('/api/v1/capabilities/agents.create');
  eq(one.status, 200, 'GET /capabilities/agents.create');
  eq(one.body.id, 'agents.create', 'the operation id');
  eq(one.body.permission, 'agent:write', 'its permission');
  const missing = await owner.request('/api/v1/capabilities/not.a.real.operation');
  eq(missing.status, 404, 'unknown id');
  assert(/no capability/i.test(missing.body.error), 'the 404 explains itself');
});

await check('an unauthenticated caller cannot read the catalogue', async () => {
  const res = await client().request('/api/v1/capabilities');
  eq(res.status, 401, 'the catalogue needs a session');
});

await check('the response publishes its vocabulary, and the counts add up', async () => {
  const body = await getCatalogue(owner);
  eq(Object.keys(body.vocabulary).join(','), 'available,degraded,unconfigured,unverified,demo,blocked,no-service', 'the seven states, in order');
  for (const [id, def] of Object.entries(body.vocabulary)) {
    assert(def.label, `${id} needs a label`);
    assert(def.definition.length > 20, `${id} needs a definition`);
  }
  const used = new Set(body.operations.map((o) => o.state));
  for (const state of used) assert(body.vocabulary[state], `the catalogue used an undeclared state “${state}”`);
  const total = Object.values(body.states).reduce((sum, n) => sum + n, 0);
  eq(total, body.operations.length, 'the counts must add up to the operations');
});

/* ---------- report ---------- */

await new Promise((resolve) => gateway.server.close(resolve));
rmSync(DATA_DIR, { recursive: true, force: true });

console.log(results.join('\n'));
console.log(`\nCAPABILITY CATALOGUE: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
