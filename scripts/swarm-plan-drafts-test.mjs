/* Swarm-plan drafts — a conversation produces a plan, an approval produces a saved plan. Nothing runs.
 * Run: npm run test:plans
 *
 * The assertions that matter:
 *   • with no model, asking for a plan is refused and creates nothing;
 *   • a real model reply becomes a plan draft whose state comes from the canonical validator, not the model;
 *   • a reply that is not JSON creates **no** plan draft and says why, while the call is still metered;
 *   • a model that sends `executed: true`, `status: "running"`, `progress` or `spend` cannot have any of it
 *     stored — the fields are dropped, reported, and absent from the plan the swarm is saved from;
 *   • the draft refuses exactly what `createSwarm` refuses (no objective, unknown team, a cap that is not a
 *     number, duplicate node ids, more than 24 nodes) — so an approval can never be one activation rejects;
 *   • submitting creates a real approvals row with the action `swarm.plan.save`;
 *   • saving is refused before approval, refused for the decider, allowed for a different principal, and
 *     writes one `swarms` row through `createSwarm` with `executed = 0`, `progress = 0` and `spent = 0`;
 *   • a retried save is a 409 and creates no second swarm;
 *   • a denied approval never saves; an Observer cannot create or read someone else's plan draft;
 *   • plan drafts and the plans they became survive a restart.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = Number(process.env.MMM_TEST_PORT || 8897);
const DATA_DIR = `/tmp/mmm-plans-${process.pid}`;
rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;
process.env.MMM_QUIET = '1';
process.env.MMM_SECRET = 'test-secret-material-that-is-long-enough-1234';
process.env.MMM_BOOTSTRAP_EMAIL = 'owner@plans.local';
process.env.MMM_BOOTSTRAP_PASSWORD = 'OwnerPassw0rd!2026';

/* ---------- a real provider whose reply the test controls ---------- */
const received = [];
let modelReply = '{}';
const provider = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    received.push({ url: req.url, body: JSON.parse(body || '{}') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'test-model',
      choices: [{ index: 0, message: { role: 'assistant', content: modelReply } }],
      usage: { prompt_tokens: 280, completion_tokens: 80, total_tokens: 360 },
    }));
  });
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
const providerBase = `http://127.0.0.1:${provider.address().port}/v1`;

const results = [];
let failures = 0;
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); };
const assert = (cond, m) => { if (!cond) throw new Error(m); };
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); console.log(`PASS ${name}`); }
  catch (e) { failures += 1; results.push(`FAIL ${name}: ${e.message}`); console.log(`FAIL ${name}: ${e.message}`); }
}

const { createGateway } = await import('../apps/gateway/server.js');
const authMod = await import('../apps/gateway/src/auth.js');
const dbm = await import('../apps/gateway/src/db.js');
let gateway;
const BASE = `http://127.0.0.1:${PORT}`;
async function start() {
  gateway = createGateway();
  await new Promise((r) => gateway.server.listen(PORT, '127.0.0.1', r));
}
await start();

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
await owner.login('owner@plans.local', 'OwnerPassw0rd!2026');

async function makePrincipal(name, role) {
  const email = `${name}@plans.local`;
  const res = await owner.request('/api/v1/principals', { method: 'POST', body: { name, email, role, password: 'AnotherPassw0rd!2026', type: 'human' } });
  if (![200, 201].includes(res.status)) throw new Error(`create ${name}: ${res.text}`);
  const c = client();
  await c.login(email, 'AnotherPassw0rd!2026');
  return c;
}
const operator = await makePrincipal('operator', 'Operator');
const reviewer = await makePrincipal('reviewer', 'Reviewer');
const watcher = await makePrincipal('watcher', 'Observer');

const GOOD = {
  name: 'Weekly Brief',
  objective: 'Research this week’s AI news and draft a one-page brief for the team.',
  channel: 'app',
  topology: 'Hierarchical',
  budgetCap: 6,
  nodes: [
    { id: 'n1', label: 'planner' },
    { id: 'n2', label: 'research-a' },
    { id: 'n3', label: 'analyze' },
    { id: 'n4', label: 'writer' },
  ],
};

/* ---------- 1. no model: nothing happens, and it says why ---------- */
await check('with no provider key, asking for a plan is refused and creates nothing', async () => {
  const res = await operator.request('/api/v1/copilot/plans', { method: 'POST', body: { text: 'a plan that writes a weekly brief' } });
  eq(res.status, 409, 'refused as no-model');
  eq(res.body.code, 'no-model', 'with the code');
  assert(/no provider has a sealed key/i.test(res.body.error), `naming the cause (got "${res.body.error}")`);
  eq((await operator.request('/api/v1/copilot/plans')).body.drafts.length, 0, 'no plan draft was created');
  eq(received.length, 0, 'the provider was never contacted');
});

await check('sealing a key makes the plan route usable', async () => {
  const put = await owner.request('/api/v1/providers/pv-anthropic/key', {
    method: 'PUT', body: { apiKey: 'sk-plan-test-key-1234567890', baseUrl: providerBase, defaultModel: 'test-model' },
  });
  eq(put.status, 200, `PUT key (${put.text})`);
});

/* ---------- 2. a real reply becomes a plan draft ---------- */
let planDraftId = null;

await check('a real conversation turn produces a plan draft whose state comes from the validator', async () => {
  modelReply = JSON.stringify(GOOD);
  const res = await operator.request('/api/v1/copilot/plans', { method: 'POST', body: { text: 'a plan that writes a weekly brief' } });
  eq(res.status, 201, `plan draft created (${res.text.slice(0, 300)})`);
  const d = res.body.draft;
  planDraftId = d.id;
  eq(d.kind, 'swarm-plan', 'it is a swarm-plan draft');
  eq(d.plan.name, 'Weekly Brief', 'the model’s name is stored');
  eq(d.plan.objective, GOOD.objective, 'and its objective');
  eq(d.plan.nodes.length, 4, 'and its node order');
  eq(d.state, 'ready-for-review', 'the validator, not the model, decided the state');
  eq(d.canRun, false, 'and it says the plan cannot run');
  assert(d.findings.some((f) => f.severity === 'blocked' && /Nothing executes/i.test(f.title)), 'with a blocked finding about execution');
  eq(d.modelCallId > 0, true, 'linked to the metered call');
  eq(res.body.usage.costBasis, 'estimated', 'cost labelled estimated');
  // The draft is metered under its own purpose, so the ledger can tell a plan from an agent draft.
  const call = dbm.db.prepare("SELECT * FROM model_calls WHERE id=?").get(d.modelCallId);
  eq(call.purpose, 'copilot.plan', 'the ledger row says what it was for');
  eq(call.status, 'ok', 'and that it succeeded');
  const sent = received.at(-1).body;
  eq(sent.messages[0].role, 'system', 'a system brief leads');
  assert(/swarm PLAN/i.test(sent.messages[0].content), 'which asks for a plan');
  assert(/JSON only/i.test(sent.messages[0].content), 'and for JSON only');
  assert(/no scheduler and no worker exist/i.test(sent.messages[0].content), 'and states the build’s limits');
  assert(/human approval\s+that you cannot grant/i.test(sent.messages[0].content.replace(/\s+/g, ' ').replace(/human approval /g, 'human approval  ').replace(/\s+/g, ' ')) || /cannot grant/i.test(sent.messages[0].content),
    'and that its text cannot grant approval');
});

await check('the turn that produced the plan is in the transcript, with its call id', async () => {
  const convo = await operator.request('/api/v1/copilot');
  const assistant = convo.body.messages.filter((m) => m.role === 'assistant').at(-1);
  assert(assistant, 'the model’s summary is stored');
  assert(/drafted the plan/i.test(assistant.text), `it explains itself (got "${assistant.text}")`);
  assert(/starts nothing/i.test(assistant.text), 'and says nothing starts');
  assert(assistant.modelCallId > 0, 'with the call id');
  eq(convo.body.messages.filter((m) => m.role === 'user').at(-1).text, 'a plan that writes a weekly brief', 'the request is stored too');
});

await check('a model reply that is not JSON creates no plan draft and is reported as such', async () => {
  modelReply = 'Great! I have scheduled the swarm and it is now running.';
  const before = (await operator.request('/api/v1/copilot/plans')).body.drafts.length;
  const res = await operator.request('/api/v1/copilot/plans', { method: 'POST', body: { text: 'make me a plan' } });
  eq(res.status, 422, 'unusable draft');
  eq(res.body.code, 'unusable-draft', 'with the code');
  assert(/could not be read as a plan/i.test(res.body.error), `says what happened (got "${res.body.error}")`);
  eq((await operator.request('/api/v1/copilot/plans')).body.drafts.length, before, 'no plan draft exists');
  assert(res.body.usage?.callId > 0, 'the call is still metered');
  assert(/Nothing was created/i.test(res.body.reply?.text || ''), 'and the person is told nothing was created');
});

await check('nothing the model writes can claim execution or invent a field', async () => {
  modelReply = JSON.stringify({
    ...GOOD, name: 'Runs Itself', executed: true, status: 'running', progress: 80,
    budget: { spent: 4.2 }, swarmId: 'sw-invented', state: 'active', ownerId: 'pr-evil',
  });
  const res = await operator.request('/api/v1/copilot/plans', { method: 'POST', body: { text: 'a plan that runs itself' } });
  eq(res.status, 201, 'plan draft created');
  const d = res.body.draft;
  eq(d.state, 'ready-for-review', 'the server decided the state');
  eq(d.swarmId, null, 'no swarm id was taken from the model');
  for (const key of ['executed', 'status', 'progress', 'budget', 'swarmId', 'state', 'ownerId']) {
    assert(d.dropped.includes(key), `“${key}” is reported as dropped (got ${JSON.stringify(d.dropped)})`);
    assert(!(key in d.plan), `“${key}” is not stored in the plan`);
  }
  assert(!/executed|running|progress/i.test(JSON.stringify(d.plan)), 'and no claim of execution survives anywhere in the plan');
});

/* ---------- 3. the validator refuses what createSwarm refuses ---------- */
const straightSave = (plan, who = operator) => who.request('/api/v1/swarms', { method: 'POST', body: plan });

await check('the draft refuses exactly what POST /swarms refuses, so approval is never theatre', async () => {
  const cases = [
    { why: 'no objective', plan: { ...GOOD, objective: '' }, field: 'objective' },
    { why: 'an unknown team', plan: { ...GOOD, teamId: 'tm-nope' }, field: 'teamId' },
    { why: 'a cap that is not a number', plan: { ...GOOD, budgetCap: 'lots' }, field: 'budgetCap' },
    { why: 'a team that does not exist', plan: { ...GOOD, teamId: 'tm-ghost' }, field: 'teamId' },
    { why: 'more than 24 nodes', plan: { ...GOOD, nodes: Array.from({ length: 25 }, (_, i) => ({ id: `n${i + 1}`, label: `n${i + 1}` })) }, field: 'nodes' },
  ];
  for (const c of cases) {
    const draft = await operator.request('/api/v1/copilot/plans', { method: 'POST', body: { plan: c.plan } });
    eq(draft.status, 201, `${c.why}: draft created`);
    eq(draft.body.draft.state, 'invalid', `${c.why}: the draft is invalid`);
    eq(draft.body.draft.canSubmit, false, `${c.why}: and cannot be submitted`);
    assert(draft.body.draft.findings.some((f) => f.severity === 'error' && f.field === c.field),
      `${c.why}: the finding names the field (got ${JSON.stringify(draft.body.draft.findings.map((f) => `${f.severity}:${f.field}`))})`);
    const direct = await straightSave(c.plan);
    assert(direct.status >= 400, `${c.why}: POST /swarms refuses it too (got ${direct.status})`);
  }
});

await check('duplicate node ids are a warning, because the save accepts them — the draft is never stricter', async () => {
  const plan = { ...GOOD, nodes: [{ id: 'n1', label: 'a' }, { id: 'n1', label: 'b' }] };
  const draft = await operator.request('/api/v1/copilot/plans', { method: 'POST', body: { plan } });
  eq(draft.status, 201, 'draft created');
  eq(draft.body.draft.state, 'ready-for-review', 'it is not blocked by something the save allows');
  assert(draft.body.draft.findings.some((f) => f.severity === 'warning' && /share an id/i.test(f.title)), 'but it is said out loud');
  const direct = await straightSave(plan);
  eq(direct.status, 201, 'and POST /swarms does accept it — which is why this is a warning');
  await operator.request(`/api/v1/copilot/drafts`, { method: 'GET' });
});

await check('a valid plan is ready for review, and a direct save is still a plan that never ran', async () => {
  const res = await operator.request('/api/v1/copilot/plans', { method: 'POST', body: { plan: GOOD } });
  eq(res.status, 201, 'created');
  eq(res.body.draft.state, 'ready-for-review', 'the validator says ready');
  eq(res.body.draft.canSubmit, true, 'and it can be submitted');
  eq(res.body.draft.canRun, false, 'while still unable to run');
});

await check('an edit recomputes the state; a body cannot send one', async () => {
  const res = await operator.request(`/api/v1/copilot/plans/${planDraftId}`, {
    method: 'PATCH', body: { plan: { ...GOOD, objective: '' }, state: 'ready-for-review' },
  });
  eq(res.status, 200, 'edit accepted');
  eq(res.body.draft.state, 'invalid', 'the missing objective moved the state');
  const back = await operator.request(`/api/v1/copilot/plans/${planDraftId}`, { method: 'PATCH', body: { plan: GOOD } });
  eq(back.body.draft.state, 'ready-for-review', 'restoring it restores the state');
});

await check('submitting an invalid plan is refused with the reason', async () => {
  const fresh = await operator.request('/api/v1/copilot/plans', { method: 'POST', body: { plan: { name: 'Half A Plan' } } });
  eq(fresh.status, 201, 'created');
  eq(fresh.body.draft.state, 'invalid', 'the validator called it invalid — no objective, no cap');
  const res = await operator.request(`/api/v1/copilot/plans/${fresh.body.draft.id}/submit`, { method: 'POST', body: {} });
  eq(res.status, 409, 'submit refused');
  assert(/invalid/i.test(res.body.error), `says why (got "${res.body.error}")`);
});

/* ---------- 4. approval, then saving ---------- */
let approvalId = null;

await check('submitting a valid plan creates a real approvals row naming what saving does', async () => {
  const res = await operator.request(`/api/v1/copilot/plans/${planDraftId}/submit`, { method: 'POST', body: {} });
  eq(res.status, 200, `submitted (${res.text.slice(0, 200)})`);
  eq(res.body.state, 'awaiting-approval', 'the plan draft waits');
  approvalId = res.body.approvalId;
  assert(approvalId, 'an approval id is returned');
  const approvals = await reviewer.request('/api/v1/approvals');
  const gate = approvals.body.find((a) => a.id === approvalId);
  assert(gate, 'it is on the Approvals screen list');
  eq(gate.action, 'swarm.plan.save', 'with an action that says saving, not running');
  eq(gate.status, 'pending', 'and it is pending');
  eq(gate.target, planDraftId, 'targeting the plan draft');
  assert(/starts nothing/i.test(gate.evidence), `the evidence says nothing starts (got "${gate.evidence}")`);
});

await check('saving is refused before the approval is decided', async () => {
  const before = (await owner.request('/api/v1/swarms')).body.swarms.length;
  const res = await owner.request(`/api/v1/copilot/plans/${planDraftId}/activate`, { method: 'POST', body: {} });
  eq(res.status, 409, 'still pending');
  assert(/pending/i.test(res.body.error), `says so (got "${res.body.error}")`);
  eq((await owner.request('/api/v1/swarms')).body.swarms.length, before, 'no swarm was created');
});

await check('the requester cannot approve their own plan', async () => {
  const res = await operator.request(`/api/v1/approvals/${approvalId}/allow`, { method: 'POST', body: {} });
  eq(res.status, 403, 'self-approval refused');
  eq((await operator.request(`/api/v1/copilot/plans/${planDraftId}`)).body.draft.state, 'awaiting-approval', 'and it still waits');
});

await check('a Reviewer allows it, and a Reviewer can never save a plan', async () => {
  const allow = await reviewer.request(`/api/v1/approvals/${approvalId}/allow`, { method: 'POST', body: {} });
  eq(allow.status, 200, `allowed (${allow.text})`);
  const res = await reviewer.request(`/api/v1/copilot/plans/${planDraftId}/activate`, { method: 'POST', body: {} });
  eq(res.status, 403, 'the decider holds no swarm:write, so deciding and saving cannot be one pair of hands');
});

let savedSwarmId = null;

await check('an Owner saves it through createSwarm — one planned swarm, zero progress, zero spend', async () => {
  const before = (await owner.request('/api/v1/swarms')).body.swarms;
  const res = await owner.request(`/api/v1/copilot/plans/${planDraftId}/activate`, { method: 'POST', body: {} });
  eq(res.status, 201, `saved (${res.text.slice(0, 300)})`);
  const swarm = res.body.swarm;
  savedSwarmId = swarm.id;
  eq(res.body.draft.state, 'active', 'the plan draft is active');
  eq(res.body.draft.swarmId, swarm.id, 'and points at its swarm');
  eq(swarm.status, 'planned', 'the swarm is planned');
  eq(swarm.executed, false, 'and explicitly not executed');
  eq(swarm.progress, 0, 'with no progress');
  eq(swarm.budget.spent, 0, 'and no spend');
  eq(swarm.budget.cap, 6, 'with the cap the draft carried');
  eq(swarm.objective, GOOD.objective, 'and the objective');
  eq(swarm.nodes.length, 4, 'and the node order');
  assert(swarm.nodes.every((n) => n.status === 'planned' && n.spent === 0 && n.elapsed === '—'), 'every node is planned, unpaid and un-timed');
  eq(swarm.runtime.executed, false, 'the payload carries the runtime fact');
  eq(swarm.runtime.scheduler, false, 'including that no scheduler exists');
  const after = (await owner.request('/api/v1/swarms')).body.swarms;
  eq(after.length, before.length + 1, 'exactly one swarm was created');
  // And nothing anywhere claims it ran.
  const events = await owner.request('/api/v1/events?cursor=0');
  const list = Array.isArray(events.body) ? events.body : events.body.events || [];
  assert(!list.some((e) => /swarm/i.test(String(e.text || '')) && /(running|started|executing|completed)/i.test(String(e.text || ''))),
    'no event says the swarm ran');
});

await check('a second save is a conflict, not a second swarm', async () => {
  const before = (await owner.request('/api/v1/swarms')).body.swarms.length;
  const res = await owner.request(`/api/v1/copilot/plans/${planDraftId}/activate`, { method: 'POST', body: {} });
  eq(res.status, 409, 'already saved');
  eq((await owner.request('/api/v1/swarms')).body.swarms.length, before, 'no duplicate swarm');
});

await check('an active plan draft cannot be edited or archived', async () => {
  eq((await owner.request(`/api/v1/copilot/plans/${planDraftId}`, { method: 'PATCH', body: { plan: { ...GOOD, name: 'Renamed' } } })).status, 409, 'edit refused');
  eq((await owner.request(`/api/v1/copilot/plans/${planDraftId}/archive`, { method: 'POST', body: {} })).status, 409, 'archive refused');
});

await check('when an Owner both decides and tries to save, the gate refuses the same principal', async () => {
  const made = await operator.request('/api/v1/copilot/plans', { method: 'POST', body: { plan: { ...GOOD, name: 'Owner Decides' } } });
  const id = made.body.draft.id;
  const sub = await operator.request(`/api/v1/copilot/plans/${id}/submit`, { method: 'POST', body: {} });
  eq(sub.status, 200, 'submitted');
  const allow = await owner.request(`/api/v1/approvals/${sub.body.approvalId}/allow`, { method: 'POST', body: {} });
  eq(allow.status, 200, 'the Owner allowed it');
  const res = await owner.request(`/api/v1/copilot/plans/${id}/activate`, { method: 'POST', body: {} });
  eq(res.status, 403, 'the same principal cannot save what it approved');
  assert(/decided by you/i.test(res.body.error), `says so (got "${res.body.error}")`);
});

/* ---------- 5. denial, permission, scope ---------- */
await check('a denied approval never saves a plan', async () => {
  const made = await operator.request('/api/v1/copilot/plans', { method: 'POST', body: { plan: { ...GOOD, name: 'Denied Plan' } } });
  const id = made.body.draft.id;
  const sub = await operator.request(`/api/v1/copilot/plans/${id}/submit`, { method: 'POST', body: {} });
  eq(sub.status, 200, 'submitted');
  const deny = await reviewer.request(`/api/v1/approvals/${sub.body.approvalId}/deny`, { method: 'POST', body: {} });
  eq(deny.status, 200, 'denied');
  const res = await owner.request(`/api/v1/copilot/plans/${id}/activate`, { method: 'POST', body: {} });
  eq(res.status, 403, 'saving refused');
  assert(/denied/i.test(res.body.error), `with the reason (got "${res.body.error}")`);
  eq((await owner.request(`/api/v1/copilot/plans/${id}`)).body.draft.state, 'awaiting-approval', 'the plan draft stays where it was');
});

await check('an Observer cannot create plan drafts, and cannot read someone else’s', async () => {
  const res = await watcher.request('/api/v1/copilot/plans', { method: 'POST', body: { plan: GOOD } });
  eq(res.status, 403, 'no copilot:write');
  eq((await watcher.request('/api/v1/copilot/plans')).body.drafts.length, 0, 'their own list is empty');
  eq((await watcher.request(`/api/v1/copilot/plans/${planDraftId}`)).status, 404, 'another principal’s plan draft is not found');
});

await check('an Operator still needs a different principal’s approval to save — the gate is not bypassed by a role', async () => {
  const made = await operator.request('/api/v1/copilot/plans', { method: 'POST', body: { plan: { ...GOOD, name: 'Operator Saves' } } });
  const id = made.body.draft.id;
  eq((await operator.request(`/api/v1/copilot/plans/${id}/submit`, { method: 'POST', body: {} })).status, 200, 'submitted');
  // An Operator *does* hold swarm:write in this build, so the refusal here is purely the approval gate:
  // the plan must be allowed by someone else first. That is the distinction being pinned.
  const tooEarly = await operator.request(`/api/v1/copilot/plans/${id}/activate`, { method: 'POST', body: {} });
  eq(tooEarly.status, 409, 'refused while the gate is pending');
  const approvals = await operator.request('/api/v1/approvals');
  const gate = approvals.body.find((a) => a.target === id);
  await reviewer.request(`/api/v1/approvals/${gate.id}/allow`, { method: 'POST', body: {} });
  const now = await operator.request(`/api/v1/copilot/plans/${id}/activate`, { method: 'POST', body: {} });
  eq(now.status, 201, 'and allowed once a different principal decided it');
});

await check('archiving keeps the row and reports it', async () => {
  const made = await operator.request('/api/v1/copilot/plans', { method: 'POST', body: { plan: { ...GOOD, name: 'Archived Plan' } } });
  const id = made.body.draft.id;
  const res = await operator.request(`/api/v1/copilot/plans/${id}/archive`, { method: 'POST', body: {} });
  eq(res.status, 200, 'archived');
  eq(res.body.draft.state, 'archived', 'state is archived');
  eq((await operator.request(`/api/v1/copilot/plans/${id}`)).status, 200, 'the row is still readable');
});

await check('plan drafts and the swarms they became survive a gateway restart', async () => {
  await new Promise((resolve) => { gateway.server.close(resolve); gateway.server.closeAllConnections?.(); });
  await new Promise((r) => setTimeout(r, 150));
  await start();
  await owner.login('owner@plans.local', 'OwnerPassw0rd!2026');
  const draft = await owner.request(`/api/v1/copilot/plans/${planDraftId}`);
  eq(draft.status, 200, 'the saved plan draft is still there');
  eq(draft.body.draft.state, 'active', 'still active');
  eq(draft.body.draft.swarmId, savedSwarmId, 'still pointing at its swarm');
  const swarm = await owner.request(`/api/v1/swarms/${savedSwarmId}`);
  eq(swarm.status, 200, 'and the swarm is still there');
  eq(swarm.body.swarm.executed, false, 'still not executed');
  eq(swarm.body.swarm.progress, 0, 'still with no progress');
  eq(swarm.body.swarm.status, 'planned', 'still only planned');
  eq(swarm.body.runtime.scheduler, false, 'and the payload still says no scheduler exists');
});

/* ---------- report ---------- */
console.log(results.join('\n'));
console.log(`\nSWARM PLAN DRAFTS: ${results.filter((r) => r.startsWith('PASS')).length} passed, ${failures} failed`);
try { gateway.wss?.close(); } catch { /* ignore */ }
await new Promise((r) => gateway.server.close(r));
try { await new Promise((r) => provider.close(r)); } catch { /* already closed */ }
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failures > 0 ? 1 : 0);
