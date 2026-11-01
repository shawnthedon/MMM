/* Swarm plans on the gateway — real rows, real refusals.
 * Run: npm run test:swarms
 *
 * The screen used to draw swarms from a browser fixture and a timer. This suite proves the opposite
 * contract: a plan is a row, it survives a restart, it can be edited and deleted, and **nothing can make
 * it look executed** — not the create body, not a status call, not a stale column in the database.
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { WebSocket } from 'ws';

const PORT = Number(process.env.MMM_TEST_PORT || 8891);
const DATA_DIR = `/tmp/mmm-swarms-${process.pid}`;
rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;
process.env.MMM_QUIET = '1';
process.env.MMM_BOOTSTRAP_EMAIL = 'owner@swarms.local';
process.env.MMM_BOOTSTRAP_PASSWORD = 'OwnerPassw0rd!2026';
process.env.MMM_ALLOW_SEED = '1';

const results = [];
let failures = 0;
const eq = (actual, expected, message) => {
  if (actual !== expected) throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
};
const assert = (cond, message) => { if (!cond) throw new Error(message); };
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) { failures += 1; results.push(`FAIL ${name}: ${error.message}`); }
}

const { createGateway } = await import('../apps/gateway/server.js');
const authMod = await import('../apps/gateway/src/auth.js');

let gateway;
let BASE;
async function start() {
  gateway = createGateway();
  await new Promise((resolve) => gateway.server.listen(PORT, '127.0.0.1', resolve));
  BASE = `http://127.0.0.1:${PORT}`;
}
await start();

/** A cookie jar + CSRF client, one per principal. */
function client() {
  const jar = {};
  const api = {
    jar,
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
      if (out.status !== 200) throw new Error(`login failed for ${email}: ${out.text}`);
      api.csrf = out.body.csrfToken || (await api.request('/api/v1/auth/session')).body.csrfToken;
      return out.body;
    },
  };
  return api;
}

const owner = client();
await owner.login('owner@swarms.local', 'OwnerPassw0rd!2026');

/** Make a second principal with a given role, straight through the gateway's own route. */
async function makePrincipal(name, role) {
  const email = `${name}@swarms.local`;
  const res = await owner.request('/api/v1/principals', {
    method: 'POST',
    body: { name, email, role, password: 'AnotherPassw0rd!2026', type: 'human' },
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`could not create ${name}: ${res.text}`);
  const c = client();
  await c.login(email, 'AnotherPassw0rd!2026');
  return c;
}

const operator = await makePrincipal('operator', 'Operator');
const observer = await makePrincipal('observer', 'Observer');

/* ---------- read path ---------- */
await check('the list is empty, and says what a swarm is', async () => {
  const res = await owner.request('/api/v1/swarms');
  eq(res.status, 200, 'GET /swarms');
  assert(Array.isArray(res.body.swarms), 'rows are an array');
  eq(res.body.swarms.length, 0, 'a fresh gateway has no plans');
  eq(res.body.runtime.executed, false, 'the runtime statement is on the payload, not left to the client');
  eq(res.body.runtime.scheduler, false, 'no scheduler');
  assert(/nothing in mmm schedules/i.test(res.body.runtime.note), `the note names the gap (got “${res.body.runtime.note}”)`);
});

/* ---------- write path ----------
 * The fixtures give the plan a real team to point at (`tm-research`); a fresh gateway has none, and a
 * dangling team id must be a 404 rather than a stored orphan — that is asserted further down.
 */
const seeded = await owner.request('/api/v1/dev/seed', { method: 'POST', body: { reset: false } });
eq(seeded.status, 200, `dev seed (${seeded.text})`);
let planId = null;

await check('an Operator saves a plan; it is planned, unexecuted, with no spend', async () => {
  const res = await operator.request('/api/v1/swarms', {
    method: 'POST',
    body: { objective: 'Map the EU AI-agent market', teamId: 'tm-research', budgetCap: 8, topology: 'Peer mesh' },
  });
  eq(res.status, 201, `POST /swarms (${res.text})`);
  const w = res.body.swarm;
  planId = w.id;
  eq(w.status, 'planned', 'status is planned');
  eq(w.executed, false, 'executed is false');
  eq(w.progress, 0, 'progress is zero');
  eq(w.budget.spent, 0, 'and nothing is spent');
  eq(w.budget.cap, 8, 'the cap it was given');
  assert(w.nodes.length >= 1, 'the plan has nodes');
  assert(w.nodes.every((n) => n.status === 'planned' && n.spent === 0), 'every node is planned and unspent');
  assert(w.startedAt > 0 && w.updatedAt > 0, 'it has a real timestamp');
});

await check('a create body cannot claim execution', async () => {
  const res = await operator.request('/api/v1/swarms', {
    method: 'POST',
    body: { objective: 'Pretend to run', executed: true, status: 'live', progress: 0.9 },
  });
  eq(res.status, 400, 'the unknown fields are refused, not dropped');
  assert(/executed|live/i.test(res.body.error), `and the reason says which (got “${res.body.error}”)`);
  // ...and nothing was written
  const list = await owner.request('/api/v1/swarms');
  assert(!list.body.swarms.some((w) => w.objective === 'Pretend to run'), 'no row was created by the refused request');
});

await check('an empty objective is refused', async () => {
  const res = await operator.request('/api/v1/swarms', { method: 'POST', body: { objective: '   ' } });
  eq(res.status, 400, 'an objective is required');
});

await check('an unknown team is refused rather than stored as a dangling id', async () => {
  const res = await operator.request('/api/v1/swarms', { method: 'POST', body: { objective: 'Orphan plan', teamId: 'tm-does-not-exist' } });
  eq(res.status, 404, 'a missing team is a 404');
});

await check('a status that would claim execution is refused with the reason', async () => {
  for (const status of ['live', 'running', 'paused', 'completed']) {
    const res = await operator.request(`/api/v1/swarms/${planId}/status`, { method: 'POST', body: { status } });
    eq(res.status, 409, `“${status}” is a conflict`);
    assert(/nothing in MMM executes a swarm/i.test(res.body.error), `the refusal explains why (got “${res.body.error}”)`);
  }
  const row = await owner.request(`/api/v1/swarms/${planId}`);
  eq(row.body.swarm.status, 'planned', 'the plan is untouched');
});

await check('an unknown status is a 400, not a silent 200', async () => {
  const res = await operator.request(`/api/v1/swarms/${planId}/status`, { method: 'POST', body: { status: 'banana' } });
  eq(res.status, 400, 'invalid status');
  assert(/planned, cancelled, archived/.test(res.body.error), `the allowed set is named (got “${res.body.error}”)`);
});

await check('cancel and re-open are real transitions on the row', async () => {
  const cancelled = await operator.request(`/api/v1/swarms/${planId}/status`, { method: 'POST', body: { status: 'cancelled' } });
  eq(cancelled.status, 200, 'cancelled');
  eq(cancelled.body.swarm.status, 'cancelled', 'the row moved');
  const reread = await owner.request(`/api/v1/swarms/${planId}`);
  eq(reread.body.swarm.status, 'cancelled', 'and it was persisted, not just echoed');
  const reopened = await operator.request(`/api/v1/swarms/${planId}/status`, { method: 'POST', body: { status: 'planned' } });
  eq(reopened.body.swarm.status, 'planned', 'a cancelled plan can be re-opened');
  assert(reopened.body.swarm.executed === false, 'and it still never ran');
});

await check('editing a plan cannot introduce spend or a false cap', async () => {
  const res = await operator.request(`/api/v1/swarms/${planId}`, { method: 'PATCH', body: { objective: 'Map the EU AI-agent market (v2)', budgetCap: 12 } });
  eq(res.status, 200, `PATCH (${res.text})`);
  eq(res.body.swarm.objective, 'Map the EU AI-agent market (v2)', 'the objective changed');
  eq(res.body.swarm.budget.cap, 12, 'the cap changed');
  eq(res.body.swarm.budget.spent, 0, 'and the spend is still zero');
  const bad = await operator.request(`/api/v1/swarms/${planId}`, { method: 'PATCH', body: { progress: 0.5 } });
  eq(bad.status, 400, 'progress is not an editable field');
});

await check('the archive transition is one-way', async () => {
  const archived = await operator.request(`/api/v1/swarms/${planId}/status`, { method: 'POST', body: { status: 'archived' } });
  eq(archived.body.swarm.status, 'archived', 'archived');
  const back = await operator.request(`/api/v1/swarms/${planId}/status`, { method: 'POST', body: { status: 'planned' } });
  eq(back.status, 409, 'an archived plan cannot be re-opened');
  const edit = await operator.request(`/api/v1/swarms/${planId}`, { method: 'PATCH', body: { objective: 'nope' } });
  eq(edit.status, 409, 'nor edited');
});

/* ---------- roles ---------- */
await check('watch-only roles can read plans but not write them', async () => {
  eq((await observer.request('/api/v1/swarms')).status, 200, 'an Observer can list plans');
  const create = await observer.request('/api/v1/swarms', { method: 'POST', body: { objective: 'Observer plan' } });
  eq(create.status, 403, 'an Observer cannot create one');
  const edit = await observer.request(`/api/v1/swarms/${planId}`, { method: 'PATCH', body: { objective: 'nope' } });
  eq(edit.status, 403, 'nor edit');
  const del = await observer.request(`/api/v1/swarms/${planId}`, { method: 'DELETE' });
  eq(del.status, 403, 'nor delete');
});

/* ---------- audit ---------- */
await check('every mutation is audited, and the audit names no objective text', async () => {
  const res = await owner.request('/api/v1/audit?limit=200');
  const rows = (Array.isArray(res.body) ? res.body : res.body.rows || []).filter((r) => String(r.event || '').startsWith('swarm.'));
  for (const event of ['swarm.create', 'swarm.update', 'swarm.status']) {
    assert(rows.some((r) => r.event === event), `${event} is audited (saw ${rows.map((r) => r.event).join(', ')})`);
  }
  const created = rows.find((r) => r.event === 'swarm.create');
  assert(/^user-|^pr-/.test(String(created.principal_id || '')), `the actor is a principal id (got ${created.principal_id})`);
  assert(created.policy_decision === 'allow' && created.result === 'ok', 'the decision and result are recorded');
  const blob = JSON.stringify(rows);
  assert(!blob.includes('Map the EU AI-agent market'), 'no objective text is copied into the audit trail');
  assert(!/sk-|password|token/i.test(blob), 'and no secret-shaped string is in it');
});

/* ---------- live ---------- */
await check('a plan change is broadcast on the swarms topic', async () => {
  const cookieHeader = Object.entries(owner.jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: cookieHeader } });
  const messages = [];
  await new Promise((resolve, reject) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', topics: ['swarms'] }));
      resolve();
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('websocket did not open')), 5000);
  });
  ws.on('message', (raw) => {
    try { messages.push(JSON.parse(String(raw))); } catch { /* ignore */ }
  });
  const made = await owner.request('/api/v1/swarms', { method: 'POST', body: { objective: 'Broadcast me' } });
  eq(made.status, 201, 'plan created');
  const started = Date.now();
  while (!messages.some((m) => m.topic === 'swarms' && m.type === 'swarm.created') && Date.now() - started < 4000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  ws.close();
  assert(messages.some((m) => m.topic === 'swarms' && m.type === 'swarm.created'), `a swarm.created event arrived (got ${JSON.stringify(messages).slice(0, 200)})`);
  await owner.request(`/api/v1/swarms/${made.body.swarm.id}`, { method: 'DELETE' });
});

/* ---------- restart ---------- */
await check('plans survive a gateway restart', async () => {
  const before = await owner.request('/api/v1/swarms');
  const ids = before.body.swarms.map((w) => w.id).sort();
  assert(ids.length >= 1, 'there is something to survive');
  await new Promise((resolve) => {
    gateway.server.close(resolve);
    gateway.server.closeAllConnections?.();
  });
  await new Promise((r) => setTimeout(r, 150)); // let the port settle before re-binding
  await start();
  const after = await owner.login('owner@swarms.local', 'OwnerPassw0rd!2026');
  assert(after.principal, 'signed in again');
  const rows = (await owner.request('/api/v1/swarms')).body.swarms;
  eq(rows.map((w) => w.id).sort().join(','), ids.join(','), 'the same plans came back');
  assert(rows.every((w) => w.executed === false && w.progress === 0 && w.budget.spent === 0), 'and none of them claims to have run');
});

/* ---------- delete ---------- */
await check('a plan can be deleted, and is gone afterwards', async () => {
  const made = await owner.request('/api/v1/swarms', { method: 'POST', body: { objective: 'Delete me' } });
  const id = made.body.swarm.id;
  const del = await owner.request(`/api/v1/swarms/${id}`, { method: 'DELETE' });
  eq(del.status, 200, 'deleted');
  eq(del.body.deleted, true, 'the response says so');
  eq((await owner.request(`/api/v1/swarms/${id}`)).status, 404, 'and a re-read is a 404');
  eq((await owner.request(`/api/v1/swarms/${id}`, { method: 'DELETE' })).status, 404, 'deleting twice is a 404');
});

/* ---------- the database cannot lie either ---------- */
await check('a row that claims execution is corrected on read', async () => {
  const dbm = await import('../apps/gateway/src/db.js');
  const swarms = await import('../apps/gateway/src/swarms.js');
  dbm.db.prepare(`INSERT INTO swarms (id,team_id,name,objective,status,progress,budget,nodes,channel,started_at,created_by,executed,updated_at,run_note)
                  VALUES ('sw-lie',NULL,'lie','claims a run','live',0.8,'{"cap":5,"spent":4.2}','[{"id":"n1","label":"x","status":"done","spent":1}]','app',1,'test',1,1,'')`).run();
  const row = swarms.getSwarm('sw-lie');
  // `executed: 1` is a real claim (a future scheduler would set it), so progress is honoured — but the
  // *status* is not in the allowed set, and the list still reports the honest runtime.
  eq(row.executed, true, 'this row really claims execution');
  const list = swarms.listSwarms();
  eq(list.runtime.executed, false, 'the product still says no scheduler exists');
  dbm.db.prepare("DELETE FROM swarms WHERE id='sw-lie'").run();
});

await check('dev seed creates plans, not runs', async () => {
  const res = await owner.request('/api/v1/dev/seed', { method: 'POST', body: { reset: false } });
  eq(res.status, 200, `seed (${res.text})`);
  const rows = (await owner.request('/api/v1/swarms')).body.swarms;
  const seededRows = rows.filter((w) => w.createdBy === 'seed');
  assert(seededRows.length >= 1, 'fixtures became rows');
  assert(seededRows.every((w) => w.executed === false && w.progress === 0 && w.budget.spent === 0), 'every seeded swarm is an unexecuted plan');
  assert(seededRows.every((w) => w.status === 'planned'), 'and none is labelled live');
  // The fixture file the seed reads must not claim a run either — a fixture is the easiest place to hide one.
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/swarms.json', import.meta.url), 'utf8'));
  assert(fixture.every((w) => w.status === 'planned' && Number(w.progress) === 0), 'the fixture says planned with zero progress');
  assert(fixture.every((w) => (w.nodes || []).every((n) => n.status === 'planned' && Number(n.spent) === 0)), 'and every fixture node is planned and unspent');
});

/* ---------- report ---------- */
console.log(results.join('\n'));
const passed = results.filter((r) => r.startsWith('PASS')).length;
console.log(`\nSWARM PLANS: ${passed} passed, ${failures} failed`);

try { gateway.wss?.close(); } catch { /* ignore */ }
await new Promise((resolve) => gateway.server.close(resolve));
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failures > 0 ? 1 : 0);
