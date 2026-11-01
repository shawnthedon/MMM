/* Copilot conversations on the gateway — a real model call, or an honest refusal.
 * Run: npm run test:copilot-api
 *
 * The Copilot used to be a `switch (mode)` in the browser with a localStorage transcript. This suite
 * pins down what replaced it:
 *
 *   • the transcript is rows, owned by one principal, and survives a restart;
 *   • every assistant turn carries the id of the metered call that produced it — and a model turn
 *     without one cannot be stored at all;
 *   • with no sealed key the send is refused with 409, the person's message IS stored, and no assistant
 *     turn is invented;
 *   • the history the provider receives is the stored conversation, oldest-first, with no duplicate turn;
 *   • another principal cannot read or continue your conversation by guessing its id.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = Number(process.env.MMM_TEST_PORT || 8893);
const DATA_DIR = `/tmp/mmm-copilot-${process.pid}`;
rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;
process.env.MMM_QUIET = '1';
process.env.MMM_SECRET = 'test-secret-material-that-is-long-enough-1234';
process.env.MMM_BOOTSTRAP_EMAIL = 'owner@copilot.local';
process.env.MMM_BOOTSTRAP_PASSWORD = 'OwnerPassw0rd!2026';

/* ---------- a real OpenAI-compatible provider that records what it is asked ---------- */
const seen = [];
let reply = 'Sure — here is a short answer.';
const provider = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ url: req.url, body: JSON.parse(body || '{}') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'test-model',
      choices: [{ index: 0, message: { role: 'assistant', content: reply } }],
      usage: { prompt_tokens: 90, completion_tokens: 25, total_tokens: 115 },
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
  try { await fn(); results.push(`PASS ${name}`); }
  catch (e) { failures += 1; results.push(`FAIL ${name}: ${e.message}`); }
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
    jar, csrf: null,
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
await owner.login('owner@copilot.local', 'OwnerPassw0rd!2026');
const observer = client();

async function makePrincipal(name, role) {
  const email = `${name}@copilot.local`;
  const res = await owner.request('/api/v1/principals', { method: 'POST', body: { name, email, role, password: 'AnotherPassw0rd!2026', type: 'human' } });
  if (![200, 201].includes(res.status)) throw new Error(`create ${name}: ${res.text}`);
  const c = client();
  await c.login(email, 'AnotherPassw0rd!2026');
  return c;
}
const operator = await makePrincipal('operator', 'Operator');
const watcher = await makePrincipal('watcher', 'Observer');

/* ---------- 1. before a key: refused, not faked ---------- */
await check('with no sealed key the runtime says so and offers a reason', async () => {
  const res = await owner.request('/api/v1/copilot/runtime');
  eq(res.status, 200, 'GET /copilot/runtime');
  eq(res.body.runtime.configured, false, 'not configured');
  eq(res.body.runtime.streaming, false, 'no streaming');
  assert(/no provider has a sealed key/i.test(res.body.runtime.reason), `the reason names the cause (got "${res.body.runtime.reason}")`);
  assert(/refused rather than faked/i.test(res.body.runtime.note), 'and the note says the refusal is deliberate');
});

await check('a send with no model is a 409, stores the question, and writes no reply', async () => {
  const res = await operator.request('/api/v1/copilot/messages', { method: 'POST', body: { text: 'Hello, is anyone there?' } });
  eq(res.status, 409, 'refused as no-model');
  eq(res.body.code, 'no-model', 'with the code');
  assert(/Nothing was sent to a provider/i.test(res.body.error), `and says nothing was sent (got "${res.body.error}")`);
  const list = await operator.request('/api/v1/copilot');
  eq(list.body.messages.length, 1, 'exactly one message is stored');
  eq(list.body.messages[0].role, 'user', 'the person’s own question');
  eq(list.body.messages[0].text, 'Hello, is anyone there?', 'verbatim');
  eq(list.body.messages[0].modelCallId, null, 'with no call id');
  eq(list.body.runtime.configured, false, 'and the runtime still says it cannot answer');
  eq(seen.length, 0, 'the provider was never contacted');
});

/* ---------- 2. install a key, then a real turn ---------- */
await check('only an Owner may point the Copilot at a provider', async () => {
  const body = { providerId: 'pv-openai' };
  eq((await operator.request('/api/v1/copilot/model', { method: 'PUT', body })).status, 403, 'an Operator cannot');
  eq((await watcher.request('/api/v1/copilot/model', { method: 'PUT', body })).status, 403, 'nor an Observer');
});

await check('pointing the Copilot at an unconfigured provider is refused', async () => {
  const res = await owner.request('/api/v1/copilot/model', { method: 'PUT', body: { providerId: 'pv-openai' } });
  eq(res.status, 409, 'a conflict, not a silent success');
  assert(/no sealed key/i.test(res.body.error), `the reason is the missing key (got "${res.body.error}")`);
});

await check('an unknown provider is a 404 rather than a dangling setting', async () => {
  const res = await owner.request('/api/v1/copilot/model', { method: 'PUT', body: { providerId: 'pv-nope' } });
  eq(res.status, 404, 'not found');
});

await check('after sealing a key the runtime resolves a provider and model', async () => {
  const put = await owner.request('/api/v1/providers/pv-openai/key', {
    method: 'PUT', body: { apiKey: 'sk-copilot-test-key-1234567890', baseUrl: providerBase, defaultModel: 'test-model' },
  });
  eq(put.status, 200, `PUT key (${put.text})`);
  const res = await owner.request('/api/v1/copilot/runtime');
  eq(res.body.runtime.configured, true, 'configured');
  eq(res.body.runtime.providerId, 'pv-openai', 'resolved to the sealed provider');
  eq(res.body.runtime.model, 'test-model', 'with its default model');
  assert(/estimated/.test(res.body.runtime.note), 'and the note says cost is estimated');
});

let firstCallId = null;

await check('a real turn: the answer comes from the provider and carries the call id', async () => {
  reply = 'I can help with that.';
  const res = await operator.request('/api/v1/copilot/messages', { method: 'POST', body: { text: 'What can you do?' } });
  eq(res.status, 200, `send (${res.text})`);
  eq(res.body.reply.text, 'I can help with that.', 'the provider’s own text');
  eq(res.body.reply.role, 'assistant', 'stored as an assistant turn');
  assert(Number.isFinite(res.body.reply.modelCallId), 'carrying the ledger id of the call');
  firstCallId = res.body.reply.modelCallId;
  eq(res.body.usage.costBasis, 'estimated', 'cost labelled estimated');
  assert(res.body.usage.costUsd > 0, 'with a cost');
  eq(seen.length, 1, 'the provider was called once');
});

await check('the prompt is the system brief plus the stored turns, oldest first', async () => {
  const sent = seen[0].body;
  eq(seen[0].url, '/v1/chat/completions', 'the OpenAI-compatible path');
  eq(sent.model, 'test-model', 'the chosen model');
  eq(sent.messages[0].role, 'system', 'a system prompt leads');
  assert(/Never claim an action/i.test(sent.messages[0].content), 'which forbids claiming unperformed actions');
  assert(/No agent runtime exists/i.test(sent.messages[0].content), 'and states what the build cannot do');
  const turns = sent.messages.filter((m) => m.role !== 'system');
  eq(turns[0].role, 'user', 'the earlier question is history');
  eq(turns[0].content, 'Hello, is anyone there?', 'verbatim');
  eq(turns[turns.length - 1].content, 'What can you do?', 'and the new turn is last');
  eq(turns.filter((m) => m.content === 'What can you do?').length, 1, 'exactly once — never duplicated');
});

await check('a second turn sends the conversation, including the model’s earlier answer', async () => {
  reply = 'Noted.';
  const res = await operator.request('/api/v1/copilot/messages', { method: 'POST', body: { text: 'And what cannot you do?' } });
  eq(res.status, 200, 'second send');
  const turns = seen[1].body.messages.filter((m) => m.role !== 'system');
  assert(turns.some((m) => m.role === 'assistant' && m.content === 'I can help with that.'), 'the previous answer is in context');
  assert(turns[turns.length - 1].content === 'And what cannot you do?', 'with the new question last');
  const list = await operator.request('/api/v1/copilot');
  eq(list.body.messages.length, 5, 'five turns stored (the refused question is still a turn)');
  // The first turn was refused (no model yet), so its user turn has no reply: what must hold is that a
  // reply is never orphaned — every assistant turn is preceded by a user turn.
  const roles = list.body.messages.map((m) => m.role);
  roles.forEach((role, i) => {
    if (role === 'assistant') eq(roles[i - 1], 'user', `an assistant turn at ${i} follows a user turn`);
  });
});

await check('every model turn points at a real, successful ledger row', async () => {
  const dbm = await import('../apps/gateway/src/db.js');
  const rows = dbm.db.prepare("SELECT * FROM messages WHERE from_principal='agent'").all();
  assert(rows.length >= 2, 'the model turns exist');
  for (const row of rows) {
    assert(row.model_call_id != null, 'each has a call id');
    const call = dbm.db.prepare('SELECT * FROM model_calls WHERE id=?').get(row.model_call_id);
    assert(call, `call ${row.model_call_id} exists in the ledger`);
    eq(call.status, 'ok', 'and it succeeded');
    eq(call.purpose, 'copilot', 'attributed to the Copilot');
  }
  // The rule is enforced in code, at the one insert path: `copilot.js` writes an agent turn only with a
  // call id, and offers no other way in. A caller cannot reach that path with a hand-made message.
  const mod = await import('../apps/gateway/src/copilot.js');
  assert(!('insertMessage' in mod), 'the raw insert is not exported');
  assert(typeof mod.send === 'function' && typeof mod.clearConversation === 'function', 'only send/clear are public');
});

await check('the reply is audited without its text, and the call is metered', async () => {
  const dbm = await import('../apps/gateway/src/db.js');
  const audit = dbm.db.prepare('SELECT event, args_redacted FROM audit_log').all();
  const replyAudit = audit.filter((r) => r.event === 'copilot.reply');
  assert(replyAudit.length >= 2, 'a reply is audited');
  assert(!JSON.stringify(audit).includes('I can help with that.'), 'the reply text is not in the audit trail');
  assert(!JSON.stringify(audit).includes('What can you do?'), 'nor the question');
  const usage = await owner.request('/api/v1/usage?days=1');
  assert(usage.body.totals.calls >= 2, 'the ledger counts the calls');
});

/* ---------- 3. scoping and idempotency ---------- */
await check('a conversation id in the body is ignored: everyone gets their own thread', async () => {
  const operatorThread = (await operator.request('/api/v1/copilot')).body.conversation.id;
  const ownerRead = await owner.request(`/api/v1/copilot?conversationId=${encodeURIComponent(operatorThread)}`);
  eq(ownerRead.status, 200, 'the read succeeds');
  assert(ownerRead.body.conversation.id !== operatorThread, 'but it is the owner’s own conversation');
  eq(ownerRead.body.messages.length, 0, 'with none of the operator’s turns in it');
  // The operator, who may spend, asks with the owner's id attached: it must be ignored, not honoured.
  const send = await operator.request('/api/v1/copilot/messages', { method: 'POST', body: { text: 'whose thread is this?', conversationId: ownerRead.body.conversation.id } });
  eq(send.status, 200, 'the send succeeds');
  assert(!(await owner.request('/api/v1/copilot')).body.messages.some((m) => m.text === 'whose thread is this?'),
    'and it did not land in the other principal’s transcript');
  assert((await operator.request('/api/v1/copilot')).body.messages.some((m) => m.text === 'whose thread is this?'),
    'it landed in the sender’s own');
});

await check('a retried send with the same clientId does not become a second turn', async () => {
  reply = 'Once is enough.';
  const before = seen.length;
  const one = await operator.request('/api/v1/copilot/messages', { method: 'POST', body: { text: 'Say it once', clientId: 'turn-abc' } });
  eq(one.status, 200, 'first send');
  const two = await operator.request('/api/v1/copilot/messages', { method: 'POST', body: { text: 'Say it once', clientId: 'turn-abc' } });
  eq(two.status, 200, 'the retry also succeeds');
  eq(two.body.duplicate, true, 'but is reported as a duplicate');
  eq(seen.length, before + 1, 'the provider was called once');
  const list = await operator.request('/api/v1/copilot');
  eq(list.body.messages.filter((m) => m.text === 'Say it once').length, 1, 'one stored user turn');
});

await check('a watch-only role can read the runtime but cannot spend a model call', async () => {
  eq((await watcher.request('/api/v1/copilot/runtime')).status, 200, 'Observer reads the runtime');
  eq((await watcher.request('/api/v1/copilot')).status, 200, 'and their own (empty) conversation');
  const before = seen.length;
  const res = await watcher.request('/api/v1/copilot/messages', { method: 'POST', body: { text: 'let me spend money' } });
  eq(res.status, 403, 'a send is refused — every turn is a metered call');
  eq(seen.length, before, 'the provider was never contacted');
});

await check('an empty message is refused before anything is stored', async () => {
  const before = (await operator.request('/api/v1/copilot')).body.messages.length;
  const res = await operator.request('/api/v1/copilot/messages', { method: 'POST', body: { text: '   ' } });
  eq(res.status, 400, 'bad request');
  eq((await operator.request('/api/v1/copilot')).body.messages.length, before, 'nothing was stored');
});

await check('a provider failure is an error state, not a fabricated answer', async () => {
  const before = (await operator.request('/api/v1/copilot')).body.messages.length;
  const realFetch = globalThis.fetch;
  // The gateway is in-process: break the adapter's egress for this one call.
  const original = seen.push.bind(seen);
  try {
    provider.close();
    await new Promise((r) => setTimeout(r, 60));
    const res = await operator.request('/api/v1/copilot/messages', { method: 'POST', body: { text: 'this will fail' } });
    eq(res.status, 502, 'a bad gateway');
    const after = (await operator.request('/api/v1/copilot')).body.messages.length;
    eq(after, before + 1, 'only the person’s message was stored');
    assert(!/Sure — here is a short answer/.test(res.text), 'no canned reply');
  } finally {
    void original; void realFetch;
  }
});

/* ---------- 4. what the chat screen sees ---------- */
await check('copilot conversations are kept out of the chat transcript list', async () => {
  const threads = await owner.request('/api/v1/threads');
  eq(threads.status, 200, 'GET /threads');
  assert(!threads.body.threads.some((t) => t.kind === 'copilot'), 'no copilot thread leaks into Chat');
  eq(threads.body.runtime.generatesReplies, false, 'and Chat still says it generates nothing');
});

/* ---------- 5. restart, then clear ---------- */
await check('the conversation survives a gateway restart', async () => {
  await new Promise((resolve) => { gateway.server.close(resolve); gateway.server.closeAllConnections?.(); });
  await new Promise((r) => setTimeout(r, 150));
  await start();
  await operator.login('operator@copilot.local', 'AnotherPassw0rd!2026');
  const list = await operator.request('/api/v1/copilot');
  eq(list.status, 200, 'the read works after a restart');
  assert(list.body.messages.length >= 4, 'with the turns still there');
  assert(list.body.messages.some((m) => m.modelCallId != null), 'including the metered model turns');
});

await check('clearing a conversation deletes only your own turns and says how many', async () => {
  const mineBefore = (await owner.request('/api/v1/copilot')).body.messages.length;
  const theirsBefore = (await operator.request('/api/v1/copilot')).body.messages.length;
  const res = await operator.request('/api/v1/copilot', { method: 'DELETE' });
  eq(res.status, 200, 'DELETE /copilot');
  eq(res.body.cleared, theirsBefore, 'reports what it removed');
  eq((await operator.request('/api/v1/copilot')).body.messages.length, 0, 'the operator’s transcript is empty');
  eq((await owner.request('/api/v1/copilot')).body.messages.length, mineBefore, 'the owner’s is untouched');
});

/* ---------- report ---------- */
console.log(results.join('\n'));
const passed = results.filter((r) => r.startsWith('PASS')).length;
console.log(`\nCOPILOT API: ${passed} passed, ${failures} failed`);
try { gateway.wss?.close(); } catch { /* ignore */ }
await new Promise((r) => gateway.server.close(r));
try { await new Promise((r) => provider.close(r)); } catch { /* already closed */ }
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failures > 0 ? 1 : 0);
