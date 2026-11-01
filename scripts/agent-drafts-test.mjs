/* Agent drafts — a conversation produces a definition, an approval produces an agent.
 * Run: npm run test:drafts
 *
 * The assertions that matter:
 *   • with no model, asking for a draft is refused and creates nothing;
 *   • a real model reply becomes a draft whose state comes from the canonical validator, not from the model;
 *   • a reply that is not usable JSON creates **no** draft and says why, while the model call is still metered;
 *   • a body cannot set a draft's state, and an unknown field is dropped and reported;
 *   • submitting requires a complete definition and creates a real approvals row;
 *   • activation is refused before approval, refused for the requester, allowed for a different decider —
 *     and creates an agent through the same insert path as POST /agents;
 *   • a denied approval never activates; a retried activation cannot create a second agent;
 *   • one principal cannot read another's draft.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = Number(process.env.MMM_TEST_PORT || 8895);
const DATA_DIR = `/tmp/mmm-drafts-${process.pid}`;
rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;
process.env.MMM_QUIET = '1';
process.env.MMM_SECRET = 'test-secret-material-that-is-long-enough-1234';
process.env.MMM_BOOTSTRAP_EMAIL = 'owner@drafts.local';
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
      usage: { prompt_tokens: 300, completion_tokens: 90, total_tokens: 390 },
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
await owner.login('owner@drafts.local', 'OwnerPassw0rd!2026');

async function makePrincipal(name, role) {
  const email = `${name}@drafts.local`;
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
  name: 'Ticket Triage',
  role: 'triages inbound support tickets',
  description: 'Sorts and labels inbound support mail.',
  goal: 'Label and route every inbound support ticket within a minute.',
  framework: 'LangGraph',
  model: 'anthropic/claude-sonnet-4',
  fallback: 'openai/gpt-5',
  autonomy: 2,
  preset: 'review-first',
  limits: { steps: 10, minutes: 5, costUsd: 1 },
  gates: { enabled: true, expiry: '30d' },
  skills: [],
  plugins: [],
  interaction: ['text'],
  responsibilities: ['label the ticket', 'route it to the right queue'],
};

/* ---------- 1. no model: nothing happens, and it says why ---------- */
await check('with no provider key, asking for a draft is refused and creates nothing', async () => {
  const res = await operator.request('/api/v1/copilot/drafts', { method: 'POST', body: { text: 'an agent that triages tickets' } });
  eq(res.status, 409, 'refused as no-model');
  eq(res.body.code, 'no-model', 'with the code');
  assert(/no provider has a sealed key/i.test(res.body.error), `naming the cause (got "${res.body.error}")`);
  const list = await operator.request('/api/v1/copilot/drafts');
  eq(list.body.drafts.length, 0, 'no draft was created');
  eq(received.length, 0, 'the provider was never contacted');
});

/* ---------- 2. a real model reply becomes a draft ---------- */
await check('sealing a key makes the draft route usable', async () => {
  const put = await owner.request('/api/v1/providers/pv-anthropic/key', {
    method: 'PUT', body: { apiKey: 'sk-draft-test-key-1234567890', baseUrl: providerBase, defaultModel: 'test-model' },
  });
  eq(put.status, 200, `PUT key (${put.text})`);
});

let draftId = null;

await check('a real conversation turn produces a draft whose state comes from the validator', async () => {
  modelReply = JSON.stringify(GOOD);
  const res = await operator.request('/api/v1/copilot/drafts', { method: 'POST', body: { text: 'an agent that triages inbound tickets' } });
  eq(res.status, 201, `draft created (${res.text.slice(0, 300)})`);
  const d = res.body.draft;
  draftId = d.id;
  eq(d.spec.name, 'Ticket Triage', 'the model’s name is stored');
  eq(d.state, 'ready-for-review', 'the validator, not the model, decided the state');
  eq(d.canRun, false, 'and it says the definition cannot run');
  assert(d.findings.some((f) => f.severity === 'blocked' && /cannot run/i.test(f.title)), 'with a blocked finding about running');
  eq(d.modelCallId > 0, true, 'linked to the metered call');
  eq(res.body.usage.costBasis, 'estimated', 'cost labelled estimated');
  const sent = received.at(-1).body;
  eq(sent.messages[0].role, 'system', 'a system brief leads');
  assert(/JSON only/i.test(sent.messages[0].content), 'which asks for JSON only');
  assert(/no runtime adapter exists/i.test(sent.messages[0].content), 'and states the build’s limits');
  assert(/nothing you write can\s+approve, activate or grant permissions/i.test(sent.messages[0].content.replace(/\s+/g, ' ')),
    'and that its text cannot approve anything');
});

await check('the turn that produced the draft is in the transcript, with its call id', async () => {
  const convo = await operator.request('/api/v1/copilot');
  const assistant = convo.body.messages.filter((m) => m.role === 'assistant').at(-1);
  assert(assistant, 'the model’s summary is stored');
  assert(/drafted/i.test(assistant.text), `it explains itself (got "${assistant.text}")`);
  assert(assistant.modelCallId > 0, 'with the call id');
  const user = convo.body.messages.filter((m) => m.role === 'user').at(-1);
  eq(user.text, 'an agent that triages inbound tickets', 'the request is stored too');
});

await check('a model reply that is not JSON creates no draft and is reported as such', async () => {
  modelReply = 'Sure! I have created the agent for you and activated it.';
  const before = (await operator.request('/api/v1/copilot/drafts')).body.drafts.length;
  const res = await operator.request('/api/v1/copilot/drafts', { method: 'POST', body: { text: 'make me something' } });
  eq(res.status, 422, 'unusable draft');
  eq(res.body.code, 'unusable-draft', 'with the code');
  assert(/could not be read as a draft/i.test(res.body.error), `says what happened (got "${res.body.error}")`);
  eq((await operator.request('/api/v1/copilot/drafts')).body.drafts.length, before, 'no draft exists');
  assert(res.body.usage?.callId > 0, 'the call is still metered');
  assert(/Nothing was created/i.test(res.body.reply?.text || ''), 'and the person is told nothing was created');
});

await check('nothing the model writes can set a draft’s state or invent a field', async () => {
  modelReply = JSON.stringify({ ...GOOD, name: 'Parser Bot', state: 'active', agentId: 'ag-invented', ownerId: 'pr-evil', findings: [] });
  const res = await operator.request('/api/v1/copilot/drafts', { method: 'POST', body: { text: 'a parser' } });
  eq(res.status, 201, 'draft created');
  assert(!('state' in res.body.draft.spec), 'state is not part of the spec');
  eq(res.body.draft.state, 'ready-for-review', 'the server decided the state');
  eq(res.body.draft.agentId, null, 'no agent id was taken from the model');
  assert(res.body.draft.dropped.includes('agentId'), `unknown fields are reported, not stored (got ${JSON.stringify(res.body.draft.dropped)})`);
});

/* ---------- 3. editing ---------- */
await check('an edit recomputes the state; a body cannot send one', async () => {
  const res = await operator.request(`/api/v1/copilot/drafts/${draftId}`, {
    method: 'PATCH', body: { spec: { ...GOOD, goal: '' }, state: 'ready-for-review' },
  });
  eq(res.status, 200, 'edit accepted');
  eq(res.body.draft.state, 'needs-information', 'the missing goal moved the state');
  eq(res.body.draft.canSubmit, false, 'and it cannot be submitted');
  const back = await operator.request(`/api/v1/copilot/drafts/${draftId}`, { method: 'PATCH', body: { spec: GOOD } });
  eq(back.body.draft.state, 'ready-for-review', 'restoring the goal restores the state');
});

await check('submitting an incomplete draft is refused with the reason', async () => {
  const fresh = await operator.request('/api/v1/copilot/drafts', { method: 'POST', body: { spec: { name: 'Half An Agent' } } });
  eq(fresh.status, 201, 'created');
  const res = await operator.request(`/api/v1/copilot/drafts/${fresh.body.draft.id}/submit`, { method: 'POST', body: {} });
  eq(res.status, 409, 'refused');
  assert(/needs information/i.test(res.body.error), `says why (got "${res.body.error}")`);
});

/* ---------- 4. approval ---------- */
let approvalId = null;

await check('submitting a complete draft creates a real approvals row', async () => {
  const res = await operator.request(`/api/v1/copilot/drafts/${draftId}/submit`, { method: 'POST', body: {} });
  eq(res.status, 200, `submitted (${res.text.slice(0, 200)})`);
  eq(res.body.state, 'awaiting-approval', 'the draft waits');
  approvalId = res.body.approvalId;
  assert(approvalId, 'an approval id is returned');
  const approvals = await reviewer.request('/api/v1/approvals');
  const gate = approvals.body.find((a) => a.id === approvalId);
  assert(gate, 'it is on the Approvals screen list');
  eq(gate.action, 'agent.draft.activate', 'with a named action');
  eq(gate.status, 'pending', 'and it is pending');
  eq(gate.target, draftId, 'targeting the draft');
});

await check('activation is refused before the approval is decided', async () => {
  const before = (await owner.request('/api/v1/agents')).body.length;
  const res = await owner.request(`/api/v1/copilot/drafts/${draftId}/activate`, { method: 'POST', body: {} });
  eq(res.status, 409, 'still pending');
  assert(/pending/i.test(res.body.error), `says so (got "${res.body.error}")`);
  eq((await owner.request('/api/v1/agents')).body.length, before, 'no agent was created');
});

await check('the requester cannot approve their own draft', async () => {
  const res = await operator.request(`/api/v1/approvals/${approvalId}/allow`, { method: 'POST', body: {} });
  eq(res.status, 403, 'self-approval refused');
  const draft = await operator.request(`/api/v1/copilot/drafts/${draftId}`);
  eq(draft.body.draft.state, 'awaiting-approval', 'and the draft still waits');
});

await check('a reviewer allows it, and a Reviewer can never activate anything', async () => {
  const allow = await reviewer.request(`/api/v1/approvals/${approvalId}/allow`, { method: 'POST', body: {} });
  eq(allow.status, 200, `allowed (${allow.text})`);
  eq(allow.body.status, 'allowed', 'recorded as allowed');
  // Two separate locks, and this is the first: the role that decides gates holds no agent:write, so
  // deciding and creating cannot happen in one pair of hands.
  const res = await reviewer.request(`/api/v1/copilot/drafts/${draftId}/activate`, { method: 'POST', body: {} });
  eq(res.status, 403, 'the decider cannot also activate');
});

await check('when an Owner both decides and tries to activate, the gate refuses the same principal', async () => {
  const made = await operator.request('/api/v1/copilot/drafts', { method: 'POST', body: { spec: { ...GOOD, name: 'Owner Decides' } } });
  const id = made.body.draft.id;
  const sub = await operator.request(`/api/v1/copilot/drafts/${id}/submit`, { method: 'POST', body: {} });
  eq(sub.status, 200, 'submitted');
  const allow = await owner.request(`/api/v1/approvals/${sub.body.approvalId}/allow`, { method: 'POST', body: {} });
  eq(allow.status, 200, 'the Owner allowed it');
  const res = await owner.request(`/api/v1/copilot/drafts/${id}/activate`, { method: 'POST', body: {} });
  eq(res.status, 403, 'the same principal cannot activate what it approved');
  assert(/decided by you/i.test(res.body.error), `says so (got "${res.body.error}")`);
});

let createdAgentId = null;

await check('activation by another principal creates an agent through the shared insert path', async () => {
  const before = (await owner.request('/api/v1/agents')).body;
  const res = await owner.request(`/api/v1/copilot/drafts/${draftId}/activate`, { method: 'POST', body: {} });
  eq(res.status, 201, `activated (${res.text.slice(0, 300)})`);
  const agent = res.body.agent;
  createdAgentId = agent.id;
  eq(res.body.draft.state, 'active', 'the draft is active');
  eq(res.body.draft.agentId, agent.id, 'and points at its agent');
  const after = (await owner.request('/api/v1/agents')).body;
  eq(after.length, before.length + 1, 'exactly one agent was created');
  const stored = after.find((a) => a.id === agent.id);
  eq(stored.name, 'Ticket Triage', 'with the draft’s name');
  eq(stored.status, 'idle', 'idle — nothing was started');
  assert(stored.approval_gates?.draft === true, 'and a marker that it came from a draft');
  const policy = await owner.request(`/api/v1/agents/${agent.id}`);
  eq(policy.status, 200, 'the agent is readable');
});

await check('a second activation is a conflict, not a second agent', async () => {
  const before = (await owner.request('/api/v1/agents')).body.length;
  const res = await owner.request(`/api/v1/copilot/drafts/${draftId}/activate`, { method: 'POST', body: {} });
  eq(res.status, 409, 'already active');
  eq((await owner.request('/api/v1/agents')).body.length, before, 'no duplicate agent');
});

await check('an active draft cannot be edited or archived', async () => {
  eq((await owner.request(`/api/v1/copilot/drafts/${draftId}`, { method: 'PATCH', body: { spec: { ...GOOD, name: 'Renamed' } } })).status, 409, 'edit refused');
  eq((await owner.request(`/api/v1/copilot/drafts/${draftId}/archive`, { method: 'POST', body: {} })).status, 409, 'archive refused');
});

/* ---------- 5. denial, permission, scope ---------- */
await check('a denied approval never activates', async () => {
  const made = await operator.request('/api/v1/copilot/drafts', { method: 'POST', body: { spec: { ...GOOD, name: 'Denied Bot' } } });
  eq(made.status, 201, 'created');
  const id = made.body.draft.id;
  const sub = await operator.request(`/api/v1/copilot/drafts/${id}/submit`, { method: 'POST', body: {} });
  eq(sub.status, 200, 'submitted');
  const deny = await reviewer.request(`/api/v1/approvals/${sub.body.approvalId}/deny`, { method: 'POST', body: {} });
  eq(deny.status, 200, 'denied');
  const res = await owner.request(`/api/v1/copilot/drafts/${id}/activate`, { method: 'POST', body: {} });
  eq(res.status, 403, 'activation refused');
  assert(/denied/i.test(res.body.error), `with the reason (got "${res.body.error}")`);
  const draft = await owner.request(`/api/v1/copilot/drafts/${id}`);
  eq(draft.body.draft.state, 'awaiting-approval', 'the draft stays where it was');
});

await check('an Observer cannot create drafts, and cannot read someone else’s', async () => {
  const res = await watcher.request('/api/v1/copilot/drafts', { method: 'POST', body: { spec: GOOD } });
  eq(res.status, 403, 'no copilot:write');
  const list = await watcher.request('/api/v1/copilot/drafts');
  eq(list.body.drafts.length, 0, 'their own list is empty');
  const peeking = await watcher.request(`/api/v1/copilot/drafts/${draftId}`);
  eq(peeking.status, 404, 'another principal’s draft is not found');
});

await check('a draft from the visual builder arrives as a spec and is validated the same way', async () => {
  const res = await operator.request('/api/v1/copilot/drafts', { method: 'POST', body: { spec: { ...GOOD, name: 'From The Builder', interaction: ['text', 'files'], gates: { enabled: false } } } });
  eq(res.status, 201, 'created');
  eq(res.body.draft.source, 'designer', 'marked as coming from the builder');
  eq(res.body.draft.state, 'invalid', 'write capability without a gate is an error');
  assert(res.body.draft.findings.some((f) => /approval gate/i.test(f.title)), 'and the finding says why');
});

await check('archiving keeps the row and reports it', async () => {
  const made = await operator.request('/api/v1/copilot/drafts', { method: 'POST', body: { spec: { ...GOOD, name: 'Archived Bot' } } });
  const id = made.body.draft.id;
  const res = await operator.request(`/api/v1/copilot/drafts/${id}/archive`, { method: 'POST', body: {} });
  eq(res.status, 200, 'archived');
  eq(res.body.draft.state, 'archived', 'state is archived');
  const read = await operator.request(`/api/v1/copilot/drafts/${id}`);
  eq(read.status, 200, 'the row is still readable');
});

await check('drafts and their approvals survive a gateway restart', async () => {
  await new Promise((resolve) => { gateway.server.close(resolve); gateway.server.closeAllConnections?.(); });
  await new Promise((r) => setTimeout(r, 150));
  await start();
  await owner.login('owner@drafts.local', 'OwnerPassw0rd!2026');
  const res = await owner.request(`/api/v1/copilot/drafts/${draftId}`);
  eq(res.status, 200, 'the activated draft is still there');
  eq(res.body.draft.state, 'active', 'still active');
  eq(res.body.draft.agentId, createdAgentId, 'still pointing at its agent');
});

/* ---------- report ---------- */
console.log(results.join('\n'));
console.log(`\nAGENT DRAFTS: ${results.filter((r) => r.startsWith('PASS')).length} passed, ${failures} failed`);
try { gateway.wss?.close(); } catch { /* ignore */ }
await new Promise((r) => gateway.server.close(r));
try { await new Promise((r) => provider.close(r)); } catch { /* already closed */ }
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failures > 0 ? 1 : 0);
