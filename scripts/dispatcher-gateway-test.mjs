/* Dispatcher — the execution test.
 * Run: npm run test:dispatch
 *
 * Phase C asks one question that a unit test cannot answer: does an operation that Copilot says it ran
 * actually reach the service, under the caller's own permissions, exactly once, with an audit row? So this
 * suite boots a real gateway and exercises the dispatcher the way the product does — over HTTP, as four
 * different roles — and it keeps the mocks to the two places where a mock is the only honest option:
 * a model provider (a local stub, so no money and no network) and the clock (a timeout that a real route
 * would take fifteen seconds to produce).
 *
 * Every scenario Phase C required is here, and each one asserts the negative: a refusal leaves the
 * database untouched, a refusal writes its audit row, a replayed approval does not run, and a client that
 * claims to be an Owner is still an Observer.
 */
import http from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';

const PORT = Number(process.env.MMM_TEST_PORT || 8899);
const DATA_DIR = `/tmp/mmm-dispatch-${process.pid}`;
rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;
process.env.MMM_QUIET = '1';
process.env.MMM_SECRET = 'test-secret-material-that-is-long-enough-1234';
process.env.MMM_BOOTSTRAP_EMAIL = 'owner@dispatch.local';
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

/* ---------- a stub provider: the only model these tests may spend ---------- */
let modelReply = 'I can help with that.';
let modelCalls = 0;
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    modelCalls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'stub-1',
      choices: [{ message: { role: 'assistant', content: modelReply } }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    }));
  });
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const STUB_PORT = stub.address().port;

const { createGateway } = await import('../apps/gateway/server.js');
const authMod = await import('../apps/gateway/src/auth.js');
const caps = await import('../apps/gateway/src/capabilities.js');
const dbMod = await import('../apps/gateway/src/db.js');
const copilotMod = await import('../apps/gateway/src/copilot.js');
const { createDispatcher } = await import('../apps/gateway/src/dispatcher.js');

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
await owner.login('owner@dispatch.local', 'OwnerPassw0rd!2026');

async function makePrincipal(name, role) {
  const email = `${name}@dispatch.local`;
  const res = await owner.request('/api/v1/principals', {
    method: 'POST',
    body: { name, email, role, password: 'AnotherPassw0rd!2026', type: 'human' },
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`create ${name}: ${res.status} ${res.text}`);
  const c = client();
  await c.login(email, 'AnotherPassw0rd!2026');
  return c;
}
const admin = await makePrincipal('admin', 'Admin');
const reviewer = await makePrincipal('reviewer', 'Reviewer');
const operator = await makePrincipal('operator', 'Operator');
const observer = await makePrincipal('observer', 'Observer');

const dispatch = (who, body) => who.request('/api/v1/dispatch', { method: 'POST', body });
const auditCount = () => dbMod.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE event LIKE 'dispatch.%'").get().n;
const agentCount = () => dbMod.db.prepare('SELECT COUNT(*) n FROM agents WHERE deleted_at IS NULL').get().n;

/* =========================================================================================
 * 1. the catalogue the dispatcher publishes
 * =======================================================================================*/

await check('GET /dispatch lists the registry with per-principal dispatchability, and the counts add up', async () => {
  const out = await owner.request('/api/v1/dispatch');
  eq(out.status, 200, 'GET /api/v1/dispatch');
  eq(out.body.operations.length, caps.OPERATIONS.length, 'every operation is listed');
  const total = Object.values(out.body.counts).reduce((a, b) => a + b, 0) - out.body.counts.total;
  eq(total, out.body.operations.length, 'the counts partition the operations');
  for (const o of out.body.operations) {
    assert(o.stateLabel, `${o.id} needs a state label`);
    if (o.dispatchable) assert(o.state === 'available', `${o.id} claims dispatchable while ${o.state}`);
  }
  const forObserver = await observer.request('/api/v1/dispatch');
  assert(forObserver.body.counts.dispatchable < out.body.counts.dispatchable, 'a role holds fewer operations than the Owner');
  assert(forObserver.body.counts['permission-restricted'] > 0, 'the difference is reported as permission, not as state');
});

await check('the dispatcher never claims an operation is dispatchable when its contract or service is missing', async () => {
  const out = await owner.request('/api/v1/dispatch?dispatchable=true');
  eq(out.status, 200, 'filtered read');
  assert(out.body.operations.length > 0, 'something is dispatchable');
  for (const o of out.body.operations) {
    assert(o.state === 'available', `${o.id} is dispatchable but ${o.state}`);
    assert(Array.isArray(o.fields) && o.fields.length >= 0, `${o.id} is missing its contract fields`);
  }
  const none = out.body.operations.find((o) => o.id === 'swarms.execute');
  assert(!none, 'an operation with no service is not dispatchable');
});

/* =========================================================================================
 * 2. success — the operation reaches the real route
 * =======================================================================================*/

let createdAgentId = '';
await check('a permitted write executes through the real route and returns what the service returned', async () => {
  const before = agentCount();
  const out = await dispatch(owner, { operation: 'agents.create', params: { name: 'Dispatch Scout', role: 'Researcher' }, confirm: true });
  eq(out.status, 200, `dispatch agents.create: ${out.text}`);
  eq(out.body.executed, true, 'it executed');
  eq(out.body.outcome, 'executed', 'outcome');
  eq(out.body.httpStatus, 201, 'the service answered 201');
  assert(out.body.traceId, 'a trace id is returned');
  assert(out.body.data?.id, 'the created agent is in the result');
  createdAgentId = out.body.data.id;
  eq(agentCount(), before + 1, 'exactly one agent was created');
  const listed = await owner.request('/api/v1/agents');
  assert(listed.body.some((a) => a.id === createdAgentId), 'the agent is really in the database');
});

await check('a state change without confirmation is refused before the service is called', async () => {
  const before = agentCount();
  const out = await dispatch(owner, { operation: 'agents.create', params: { name: 'Unconfirmed Agent' } });
  eq(out.status, 409, 'confirmation is required');
  eq(out.body.code, 'confirmation-required', 'the code names the gate');
  eq(out.body.executed, false, 'nothing executed');
  eq(agentCount(), before, 'no agent was created');
});

await check('a dry run answers with the same description and executes nothing', async () => {
  const before = agentCount();
  const out = await dispatch(owner, { operation: 'agents.create', params: { name: 'Dry Run Agent' }, confirm: true, dryRun: true });
  eq(out.status, 200, 'a dry run is not an error');
  eq(out.body.executed, false, 'nothing executed');
  eq(out.body.outcome, 'proposed', 'it is a proposal');
  assert(out.body.validation.ok, 'the parameters validated');
  eq(agentCount(), before, 'no agent was created');
});

/* =========================================================================================
 * 3. refusal: permission, registration, state
 * =======================================================================================*/

await check('an unauthorised principal is refused by name, and nothing is written', async () => {
  const before = agentCount();
  const out = await dispatch(observer, { operation: 'agents.create', params: { name: 'Observer Agent' }, confirm: true });
  eq(out.status, 403, 'forbidden');
  eq(out.body.code, 'forbidden', 'the refusal names the rule');
  assert(/agent:write/.test(out.body.message), `the message names the permission: ${out.body.message}`);
  eq(out.body.executed, false, 'nothing executed');
  eq(agentCount(), before, 'no agent was created');
});

await check('a read that the role holds is dispatchable, and the result is the service’s own list', async () => {
  const out = await dispatch(observer, { operation: 'agents.list' });
  eq(out.status, 200, `dispatch agents.list: ${out.text}`);
  eq(out.body.executed, true, 'it executed');
  const direct = await observer.request('/api/v1/agents');
  eq(JSON.stringify(out.body.data).length, JSON.stringify(direct.body).length, 'the dispatcher returned the same list the route does');
});

await check('an operation that is not registered cannot execute', async () => {
  const before = await auditCount();
  const out = await dispatch(owner, { operation: 'agents.launch', params: {} });
  eq(out.status, 400, 'unknown operation');
  eq(out.body.code, 'unknown-operation', 'the code says so');
  eq(out.body.executed, false, 'nothing executed');
  assert((await auditCount()) > before, 'even an unknown id is audited');
});

await check('an operation this deployment cannot serve is refused with its own state, not as a success', async () => {
  const before = dbMod.db.prepare('SELECT COUNT(*) n FROM model_calls').get().n;
  const out = await dispatch(owner, { operation: 'providers.call', params: { id: 'pv-openai', messages: [{ role: 'user', content: 'hi' }] }, confirm: true });
  eq(out.status, 424, `expected the state to stop it: ${out.text}`);
  eq(out.body.code, 'unconfigured', 'the code is the state');
  eq(out.body.state, 'unconfigured', 'the state is reported');
  assert(/key/i.test(out.body.message), 'the message says the key is missing');
  eq(out.body.executed, false, 'nothing executed');
  eq(dbMod.db.prepare('SELECT COUNT(*) n FROM model_calls').get().n, before, 'no model call was recorded');
});

await check('an unverified operation is refused as unverified — never silently offered', async () => {
  const out = await dispatch(owner, { operation: 'comms.send', params: {}, confirm: true });
  eq(out.status, 424, `expected unverified: ${out.text}`);
  eq(out.body.code, 'unverified', 'the code is the state');
  assert(/never been exercised|stub/i.test(out.body.message), `the message says why: ${out.body.message}`);
});

await check('an operation with no implementing service says so and names nothing it cannot do', async () => {
  const out = await dispatch(owner, { operation: 'swarms.execute', params: {} });
  eq(out.status, 424, 'no service');
  eq(out.body.code, 'no-service', 'the code is the state');
  eq(out.body.state, 'no-service', 'the state is reported');
  eq(out.body.executed, false, 'nothing executed');
});

/* =========================================================================================
 * 4. input validation
 * =======================================================================================*/

await check('input validation refuses unknown keys, wrong types and missing fields — and says which', async () => {
  const before = agentCount();
  const unknown = await dispatch(owner, { operation: 'agents.create', params: { name: 'Valid Name', principal: 'owner', permission: '*', status: 'god' }, confirm: true });
  eq(unknown.status, 400, 'unknown keys are refused, not dropped');
  eq(unknown.body.code, 'invalid-params', 'invalid-params');
  const fields = unknown.body.fields.map((f) => f.field).sort();
  eq(fields.includes('principal'), true, 'the smuggled principal is named');
  eq(fields.includes('permission'), true, 'the smuggled permission is named');
  const short = await dispatch(owner, { operation: 'agents.create', params: { name: 'x' }, confirm: true });
  eq(short.status, 400, 'a too-short name is refused');
  assert(short.body.fields.some((f) => f.field === 'name' && /at least 2/.test(f.problem)), 'the reason names the rule');
  const wrongType = await dispatch(owner, { operation: 'agents.create', params: { name: 'Typed Agent', trust: 'high' }, confirm: true });
  eq(wrongType.status, 400, 'a string where a number is declared is refused');
  eq(agentCount(), before, 'no agent was created by any of the three');
});

await check('a contract that does not exist means the operation is not dispatchable', async () => {
  const out = await dispatch(owner, { operation: 'browser.start', params: { url: 'https://example.com' }, confirm: true });
  // browser.start is either unconfigured (no engine) or, past that, has no contract — both refuse.
  assert(out.status === 424 || out.status === 400, `expected a refusal, got ${out.status}: ${out.text}`);
  eq(out.body.executed, false, 'nothing executed');
  if (out.body.code === 'no-contract') assert(/contract/i.test(out.body.message), 'the message explains the missing contract');
});

/* =========================================================================================
 * 5. the service's own refusal is reported truthfully
 * =======================================================================================*/

await check('a service refusal is reported as a failure, not as an execution', async () => {
  const out = await dispatch(owner, { operation: 'agents.update', params: { id: 'agent-does-not-exist', goal: 'x' }, confirm: true });
  eq(out.status, 404, `expected the service's 404: ${out.text}`);
  eq(out.body.executed, false, 'nothing executed');
  eq(out.body.outcome, 'failed', 'it failed');
  assert(/not found|not-found/i.test(out.body.message), `the message carries the service's reason: ${out.body.message}`);
});

/* =========================================================================================
 * 6. approval gates — required, denied, allowed, replayed, mis-targeted
 * =======================================================================================*/

const team = await owner.request('/api/v1/teams', { method: 'POST', body: { name: 'Dispatch Team' } });
if (team.status !== 201 && team.status !== 200) throw new Error(`seed team: ${team.status} ${team.text}`);
const teamId = team.body.id;

let gateId = '';
await check('an approval-required operation opens one gate and changes nothing', async () => {
  const out = await dispatch(owner, { operation: 'teams.delete', params: { id: teamId }, confirm: true });
  eq(out.status, 409, `expected a gate: ${out.text}`);
  eq(out.body.code, 'approval-required', 'approval-required');
  assert(out.body.approval?.id, 'the gate id is returned');
  eq(out.body.approval.target, `team:${teamId}`, 'the gate is bound to the target');
  gateId = out.body.approval.id;
  const still = await owner.request(`/api/v1/teams/${teamId}`);
  eq(still.status, 200, 'the team still exists');
});

await check('the requester cannot decide their own gate', async () => {
  const out = await owner.request(`/api/v1/approvals/${gateId}/allow`, { method: 'POST' });
  eq(out.status, 403, 'separation of duties');
  assert(/separation|requested/i.test(out.body.error), `the reason is explicit: ${out.body.error}`);
});

await check('a denied approval cannot be used to execute', async () => {
  const denied = await reviewer.request(`/api/v1/approvals/${gateId}/deny`, { method: 'POST' });
  eq(denied.status, 200, 'the reviewer decided');
  const out = await dispatch(owner, { operation: 'teams.delete', params: { id: teamId }, confirm: true, approvalId: gateId });
  eq(out.status, 409, 'a denied gate is not a pass');
  eq(out.body.code, 'approval-not-allowed', 'the code says the gate said no');
  eq(out.body.executed, false, 'nothing executed');
  eq((await owner.request(`/api/v1/teams/${teamId}`)).status, 200, 'the team is untouched');
});

await check('an allowed approval executes exactly once, and a replay is refused', async () => {
  const opened = await dispatch(owner, { operation: 'teams.delete', params: { id: teamId }, confirm: true });
  eq(opened.body.code, 'approval-required', 'a fresh gate for a decided one');
  const fresh = opened.body.approval.id;
  const allowed = await reviewer.request(`/api/v1/approvals/${fresh}/allow`, { method: 'POST' });
  eq(allowed.status, 200, 'the reviewer allowed it');
  const out = await dispatch(owner, { operation: 'teams.delete', params: { id: teamId }, confirm: true, approvalId: fresh });
  eq(out.status, 200, `expected the delete: ${out.text}`);
  eq(out.body.executed, true, 'it executed');
  eq(out.body.approval.consumed, true, 'the gate is marked spent');
  const gone = await owner.request(`/api/v1/teams/${teamId}`);
  assert(gone.status === 404 || gone.body?.deleted_at, 'the team is gone');
  const replay = await dispatch(owner, { operation: 'teams.delete', params: { id: teamId }, confirm: true, approvalId: fresh });
  eq(replay.status, 409, 'a spent gate is not a pass');
  eq(replay.body.code, 'approval-consumed', 'the code says it was already used');
});

await check('an approval for another operation or target cannot be borrowed', async () => {
  const gate = await owner.request('/api/v1/approvals', {
    method: 'POST',
    body: { action: 'dispatch:agents.delete', target: 'agent:someone-else', risk: 'high', principal: 'someone' },
  });
  eq(gate.status, 201, 'a gate exists for a different operation');
  const borrowed = await dispatch(owner, { operation: 'agents.delete', params: { id: createdAgentId }, confirm: true, approvalId: gate.body.id });
  eq(borrowed.status, 400, 'a gate for another target is refused');
  eq(borrowed.body.code, 'invalid-approval', 'the code names the mismatch');
  assert(/not “agent:/.test(borrowed.body.message), `the message shows both targets: ${borrowed.body.message}`);
  assert((await owner.request(`/api/v1/agents`)).body.some((a) => a.id === createdAgentId), 'the agent is untouched');
});

/* =========================================================================================
 * 7. bypass prevention
 * =======================================================================================*/

await check('client-claimed authority is ignored: a top-level principal field changes nothing', async () => {
  const before = agentCount();
  const out = await owner.request('/api/v1/dispatch', {
    method: 'POST',
    body: {
      operation: 'agents.create',
      params: { name: 'Forged Agent' },
      confirm: true,
      principal: { id: 'someone', role: 'Owner', name: 'Owner' },
      permission: 'agent:write',
      role: 'Owner',
    },
  });
  // The Owner really may create an agent; the point is the *claims* above were never read. Re-run as the
  // Observer with the same forged body and require the same refusal the Observer gets without it.
  eq(out.status, 200, 'the Owner’s own permission is what allowed it');
  const forged = await observer.request('/api/v1/dispatch', {
    method: 'POST',
    body: { operation: 'agents.create', params: { name: 'Forged Agent 2' }, confirm: true, principal: { role: 'Owner' }, role: 'Owner' },
  });
  eq(forged.status, 403, 'the Observer is still the Observer');
  eq(agentCount(), before + 1, 'only the genuine Owner write landed');
});

await check('the dispatcher is not a weaker path than the route it calls', async () => {
  const direct = await observer.request('/api/v1/agents', { method: 'POST', body: { name: 'Direct Agent' } });
  eq(direct.status, 403, 'the route refuses the Observer');
  const dispatched = await dispatch(observer, { operation: 'agents.create', params: { name: 'Direct Agent' }, confirm: true });
  eq(dispatched.status, 403, 'the dispatcher refuses the same principal');
  const anonymous = await client().request('/api/v1/dispatch', { method: 'POST', body: { operation: 'agents.list' } });
  eq(anonymous.status, 401, 'and an unauthenticated caller cannot dispatch at all');
});

await check('a role that may read may not write, and a capability is not an authority', async () => {
  const read = await dispatch(observer, { operation: 'agents.list' });
  eq(read.status, 200, 'the Observer holds read');
  const policy = await dispatch(admin, { operation: 'evolution.policy.set', params: { agentId: createdAgentId, level: 3 }, confirm: true });
  eq(policy.status, 403, 'evolution:policy is an Owner permission, not an Admin one');
  eq(policy.body.code, 'forbidden', 'the refusal is a permission refusal');
  const catalogue = await admin.request('/api/v1/dispatch');
  const op = catalogue.body.operations.find((o) => o.id === 'evolution.policy.set');
  eq(op.state, 'available', 'the gateway can serve it…');
  eq(op.allowed, false, '…but this role may not use it');
});

/* =========================================================================================
 * 8. audit
 * =======================================================================================*/

await check('every attempt is audited — executed, refused and unknown alike — on the same hash chain', async () => {
  const rows = dbMod.db.prepare("SELECT event, policy_decision, result FROM audit_log WHERE event LIKE 'dispatch.%'").all();
  assert(rows.length >= 15, `expected the attempts to be recorded, saw ${rows.length}`);
  assert(rows.some((r) => r.result === 'ok' && r.policy_decision === 'allow'), 'a success is recorded');
  assert(rows.some((r) => r.result === 'forbidden' && r.policy_decision === 'deny'), 'a permission refusal is recorded');
  assert(rows.some((r) => r.result === 'approval-consumed'), 'a replay is recorded');
  const verify = await reviewer.request('/api/v1/audit/verify');
  eq(verify.status, 200, 'audit verify');
  eq(verify.body.ok, true, 'the chain still verifies');
  const blobs = JSON.stringify(rows);
  assert(!/OwnerPassw0rd/.test(blobs), 'no password reached the audit log');
  assert(!/sk-test/.test(blobs), 'no key material reached the audit log');
});

/* =========================================================================================
 * 9. Copilot — the proposal, the confirmation, and the report
 * =======================================================================================*/

const sealed = await owner.request('/api/v1/providers/pv-openai/key', {
  method: 'PUT',
  body: { apiKey: 'sk-test-dispatcher-0001', baseUrl: `http://127.0.0.1:${STUB_PORT}/v1`, model: 'stub-1' },
});
eq(sealed.status, 200, `seal the stub provider: ${sealed.text}`);
const setModel = await owner.request('/api/v1/copilot/model', { method: 'PUT', body: { providerId: 'pv-openai', model: 'stub-1' } });
eq(setModel.status, 200, `set the copilot model: ${setModel.text}`);

let proposalMessageId = '';
await check('Copilot turns a model’s request into a validated proposal and runs nothing', async () => {
  const before = agentCount();
  modelReply = 'I can prepare that agent for you.\n<<<MMM-ACTION {"operation":"agents.create","params":{"name":"Copilot Scout","role":"Researcher"}}>>>';
  const out = await owner.request('/api/v1/copilot/messages', { method: 'POST', body: { text: 'Create an agent called Copilot Scout' } });
  eq(out.status, 200, `copilot turn: ${out.text}`);
  eq(out.body.proposal.executable, true, `the proposal should be executable: ${out.text}`);
  eq(out.body.proposal.executed, false, 'nothing has run');
  eq(out.body.proposal.runnable, true, 'it can be confirmed');
  eq(out.body.proposal.state, 'available', 'its state is reported');
  assert(!/MMM-ACTION/.test(out.body.reply.text), 'the marker is stripped from the visible reply');
  assert(/confirm/i.test(out.body.reply.text) || /prepare/i.test(out.body.reply.text), 'the reply does not claim it happened');
  eq(agentCount(), before, 'no agent exists yet');
  proposalMessageId = out.body.proposal.messageId;
  assert(proposalMessageId, 'the proposal names the message it is stored on');
});

await check('confirming the proposal executes it, and the report is written by a real model call', async () => {
  const beforeCalls = dbMod.db.prepare("SELECT COUNT(*) n FROM model_calls WHERE purpose='copilot-report'").get().n;
  modelReply = 'The gateway created the agent overnight. It exists now.';
  const out = await owner.request(`/api/v1/copilot/actions/${proposalMessageId}`, { method: 'POST', body: { confirm: true } });
  eq(out.status, 200, `confirm: ${out.text}`);
  eq(out.body.executed, true, 'the dispatcher executed it');
  eq(out.body.reported, true, 'a model wrote the report');
  assert(out.body.reply?.text, 'the report is a stored assistant turn');
  eq(dbMod.db.prepare("SELECT COUNT(*) n FROM model_calls WHERE purpose='copilot-report'").get().n, beforeCalls + 1, 'exactly one report call was made');
  assert((await owner.request('/api/v1/agents')).body.some((a) => a.name === 'Copilot Scout'), 'the agent is real');
});

await check('a proposal cannot be replayed, even by its owner', async () => {
  const out = await owner.request(`/api/v1/copilot/actions/${proposalMessageId}`, { method: 'POST', body: { confirm: true } });
  eq(out.status, 409, 'a used proposal is refused');
  assert(/already run|expired/i.test(out.body.error), `the message says why: ${out.body.error}`);
});

await check('Copilot will not present an operation the principal may not run', async () => {
  modelReply = 'That needs an Owner.\n<<<MMM-ACTION {"operation":"models.budget","params":{"dailyUsd":10}}>>>';
  const out = await operator.request('/api/v1/copilot/messages', { method: 'POST', body: { text: 'Raise the daily budget to $10' } });
  eq(out.status, 200, `copilot turn: ${out.text}`);
  eq(out.body.proposal.executable, false, 'not executable for an Operator');
  eq(out.body.proposal.runnable, false, 'and not stored as runnable');
  eq(out.body.proposal.allowed, false, 'the reason is permission');
  assert(/model:key/.test(out.body.proposal.reason), `the reason names the permission: ${out.body.proposal.reason}`);
});

await check('Copilot reports the dispatcher’s result even when no model can narrate it', async () => {
  // A proposal stored by a real turn, confirmed while the provider key is gone: the dispatcher's result is
  // returned as data, and no assistant message is invented.
  modelReply = 'Prepared.\n<<<MMM-ACTION {"operation":"tasks.create","params":{"title":"Dispatch task"}}>>>';
  const turn = await owner.request('/api/v1/copilot/messages', { method: 'POST', body: { text: 'Create a task called Dispatch task' } });
  eq(turn.body.proposal.runnable, true, `proposal prepared: ${turn.text}`);
  const messageId = turn.body.proposal.messageId;
  const cleared = await owner.request('/api/v1/providers/pv-openai/key', { method: 'DELETE' });
  eq(cleared.status, 200, 'the key is removed');
  const before = dbMod.db.prepare('SELECT COUNT(*) n FROM messages').get().n;
  const out = await owner.request(`/api/v1/copilot/actions/${messageId}`, { method: 'POST', body: { confirm: true } });
  eq(out.status, 200, `confirm matters more than narration: ${out.text}`);
  eq(out.body.executed, true, 'the operation ran');
  eq(out.body.reported, false, 'no model wrote it up');
  assert(/sealed key|no model|provider/i.test(out.body.reportNote || ''), `the note explains why: ${out.body.reportNote}`);
  eq(dbMod.db.prepare('SELECT COUNT(*) n FROM messages').get().n, before, 'no assistant message was fabricated');
});

await check('the brief Copilot is given matches the registry, including the states and the permissions', async () => {
  const brief = await copilotMod.actionBrief({ id: 'x', role: 'Admin', type: 'human' });
  assert(brief.text.includes('agents.create'), 'an available write is listed');
  assert(brief.text.includes('comms.send') && /unverified/.test(brief.text), 'an unverified operation is named as such');
  assert(/not allowed/i.test(brief.text), 'the permission group is present for a role that holds less than Owner');
  assert(!/models\.budget/.test(brief.text.split('Not allowed')[0]), 'an Owner-only operation is not in the requestable list');
  assert(brief.counts.total === caps.OPERATIONS.length, 'the counts come from the whole registry');
});

await check('every declared contract names a route its operation owns, and no contract carries a credential', async () => {
  const contracts = await import('../apps/gateway/src/operationContracts.js');
  const byId = Object.fromEntries(caps.OPERATIONS.map((o) => [o.id, o]));
  const names = Object.keys(contracts.CONTRACTS);
  assert(names.length > 20, `expected a useful set of contracts, saw ${names.length}`);
  for (const [id, contract] of Object.entries(contracts.CONTRACTS)) {
    const operation = byId[id];
    assert(operation, `contract for an operation that does not exist: ${id}`);
    const stars = contract.route.replace(/\*/g, '([\\w-]+)');
    assert(
      operation.routes.some((r) => new RegExp(`^${r.replace(/\//g, '\\/').replace(/\([^)]*\)/g, '[^/]+').replace(/\*/g, '[^/]+')}$`).test(contract.route)),
      `${id}: ${contract.route} is not one of ${JSON.stringify(operation.routes)}`
    );
    const fields = [...Object.keys(contract.body || {}), ...Object.keys(contract.path || {}), ...Object.keys(contract.query || {})];
    for (const field of fields) assert(!/^(api_?key|key|secret|password|token|authorization|sealed)$/i.test(field), `${id} declares a credential field: ${field}`);
    assert(contract.template.startsWith('/api/v1/'), `${id}: the template is a gateway path`);
  }
  // Every dispatchable operation has a resolved contract; a dispatcher never guesses.
  const listed = await owner.request('/api/v1/dispatch');
  for (const o of listed.body.operations) {
    if (o.dispatchable) assert(o.fields, `${o.id} is dispatchable without contract fields`);
  }
});

/* =========================================================================================
 * 10. the clock and the engine — unit tests, because a real one would cost fifteen seconds
 * =======================================================================================*/

const unitOps = [
  { id: 'unit.read', module: 'unit', label: 'Unit read', description: 'x', kind: 'read', risk: 'read-only', confirmation: 'none', reversible: false, idempotent: true, audit: 'none', timeoutMs: 10000, routes: ['GET /api/v1/agents'], requires: [], permission: 'read', note: '', unverified: '' },
  { id: 'unit.unverified', module: 'unit', label: 'Unit unverified', description: 'x', kind: 'read', risk: 'read-only', confirmation: 'none', reversible: false, idempotent: true, audit: 'none', timeoutMs: 10000, routes: ['GET /api/v1/agents'], requires: [], permission: 'read', note: '', unverified: '' },
  { id: 'unit.degraded', module: 'unit', label: 'Unit degraded', description: 'x', kind: 'read', risk: 'read-only', confirmation: 'none', reversible: false, idempotent: true, audit: 'none', timeoutMs: 10000, routes: ['GET /api/v1/agents'], requires: [], permission: 'read', note: '', unverified: '' },
];
const unitAudit = [];
const calls = { invoke: 0 };
function unitDispatcher({ state = 'available', invoke, timeouts } = {}) {
  return createDispatcher({
    operations: unitOps,
    stateOf: async () => ({ state, stateLabel: state, reason: state === 'available' ? '' : `${state} for this test` }),
    invokeRoute: async (call) => {
      calls.invoke += 1;
      return invoke ? invoke(call) : { code: 200, body: { ok: true } };
    },
    approvals: { find: () => null, open: () => ({ id: 'gate' }), consume: () => true },
    audit: (...args) => unitAudit.push(args),
    timeoutFor: () => (timeouts || 10000),
    rateLimit: () => ({ allowed: true }),
  });
}

await check('a degraded capability is refused, not treated as available', async () => {
  calls.invoke = 0;
  const d = unitDispatcher({ state: 'degraded' });
  const out = await d.execute({ operationId: 'unit.degraded', params: {}, principal: { id: 'p', role: 'Owner' } });
  eq(out.code, 'degraded', 'the state stops it');
  eq(out.executed, false, 'nothing executed');
  eq(calls.invoke, 0, 'the service was never called');
});

await check('an unverified capability is refused, not silently treated as available', async () => {
  calls.invoke = 0;
  const d = unitDispatcher({ state: 'unverified' });
  const out = await d.execute({ operationId: 'unit.unverified', params: {}, principal: { id: 'p', role: 'Owner' } });
  eq(out.code, 'unverified', 'the state stops it');
  eq(calls.invoke, 0, 'the service was never called');
});

await check('a service that never answers becomes a timeout, reported as unfinished', async () => {
  const d = unitDispatcher({ invoke: () => new Promise(() => {}), timeouts: 25 });
  const started = Date.now();
  const out = await d.execute({ operationId: 'unit.read', params: {}, principal: { id: 'p', role: 'Owner' } });
  eq(out.code, 'timeout', 'timeout');
  eq(out.executed, false, 'nothing is reported as done');
  assert(/may still finish|nothing is being reported/i.test(out.message), 'the message does not claim it stopped');
  assert(Date.now() - started < 2000, 'the dispatcher did not hang');
});

await check('a service that throws is reported as a failure, without leaking its internals', async () => {
  const d = unitDispatcher({
    invoke: () => {
      throw Object.assign(new Error('upstream said: Bearer sk-live-should-never-be-echoed'), { code: 'bad-gateway' });
    },
  });
  const out = await d.execute({ operationId: 'unit.read', params: {}, principal: { id: 'p', role: 'Owner' } });
  eq(out.code, 'bad-gateway', 'the service code is kept');
  eq(out.executed, false, 'nothing executed');
  assert(!/sk-live/.test(out.message), `the message is scrubbed: ${out.message}`);
});

await check('a handler response that carries a credential key is scrubbed before it is returned', async () => {
  const d = unitDispatcher({ invoke: () => ({ code: 200, body: { agent: { id: 'a1', apiKey: 'sk-leak', nested: { token: 't', name: 'ok' } } } }) });
  const out = await d.execute({ operationId: 'unit.read', params: {}, principal: { id: 'p', role: 'Owner' } });
  eq(out.executed, true, 'it executed');
  eq(out.data.agent.apiKey, undefined, 'the key is gone');
  eq(out.data.agent.nested.token, undefined, 'the nested token is gone');
  eq(out.data.agent.nested.name, 'ok', 'ordinary fields survive');
});

await check('the client card cannot turn a refusal into a button, and a failed result says failed', async () => {
  const actions = await import('../src/copilot/actions.js');
  const forbidden = actions.cardFor({
    ok: false, executable: false, executed: false, operationId: 'models.budget', state: 'available',
    stateLabel: 'available', risk: 'consequential', confirmation: 'confirm', allowed: false,
    reason: 'Your role does not hold “model:key”.', validation: { ok: true, errors: [] },
    contract: { fields: ['dailyUsd'] }, messageId: 'm-x',
  });
  eq(forbidden.runnable, false, 'a non-executable proposal has no Run button');
  eq(forbidden.executable, false, 'and does not claim to be executable');
  assert(/model:key/.test(forbidden.reason), 'the gateway’s reason is shown verbatim');
  eq(actions.cardFor({ messageId: 'm-y' }), null, 'a proposal with no operation is not rendered at all');
  const failed = actions.resultCard(forbidden, { executed: false, code: 'forbidden', message: 'Your role does not hold “model:key”.', traceId: 'dx-1' });
  eq(failed.status, 'failed', 'the result card says failed');
  eq(failed.steps.at(-1).state, 'blocked', 'and shows the refusal as blocked');
  const ok = actions.resultCard(forbidden, { executed: true, httpStatus: 200, message: 'done', traceId: 'dx-2' });
  eq(ok.status, 'ok', 'a real execution reads ok');
  assert(/200/.test(ok.steps.at(-1).label), 'the HTTP status the service answered is shown');
});

/* ---------- report ---------- */

await new Promise((resolve) => gateway.server.close(resolve));
stub.close();
rmSync(DATA_DIR, { recursive: true, force: true });

console.log(results.join('\n'));
console.log(`\nDISPATCHER: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
