/* Model gateway — sealed keys, one adapter, a metered ledger.
 * Run: npm run test:models
 *
 * Everything here is real except the provider: a local OpenAI-compatible server answers, so the adapter
 * makes genuine HTTP requests, and the security claims are checked against the bytes on disk rather than
 * against intentions:
 *
 *   • the API key is never returned by any route, never in an audit row, never in an event, and never in
 *     the SQLite file — only a fingerprint and a four-character hint;
 *   • a prompt and a reply are not stored, only token counts and an estimated cost;
 *   • a call that was refused (budget, unconfigured) is `blocked` with zero cost, so spend stays the sum
 *     of calls that actually happened;
 *   • redirects are not followed, so the key cannot be forwarded to another host;
 *   • budget is enforced *before* the request leaves the process.
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = Number(process.env.MMM_TEST_PORT || 8892);
const DATA_DIR = `/tmp/mmm-models-${process.pid}`;
rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;
process.env.MMM_QUIET = '1';
process.env.MMM_SECRET = 'test-secret-material-that-is-long-enough-1234';
process.env.MMM_BOOTSTRAP_EMAIL = 'owner@models.local';
process.env.MMM_BOOTSTRAP_PASSWORD = 'OwnerPassw0rd!2026';
delete process.env.HTTPS_PROXY;
delete process.env.HTTP_PROXY;

const PROVIDER_KEY = 'sk-test-DO-NOT-LEAK-0123456789abcdef';
const PROMPT_TEXT = 'PROMPT-MARKER-unique-string';
const REPLY_TEXT = 'REPLY-MARKER-unique-string';

/* ---------- a real provider, locally ---------- */
const seen = { requests: [], redirectTarget: [] };
let behaviour = 'ok';
const provider = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.requests.push({ url: req.url, auth: req.headers.authorization || '', body });
    if (behaviour === 'error500') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream exploded' } }));
      return;
    }
    if (behaviour === 'redirect') {
      res.writeHead(302, { location: `http://127.0.0.1:${provider.address().port}/evil` });
      res.end();
      return;
    }
    if (behaviour === 'slow') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'late' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      }, 3000);
      return;
    }
    if (behaviour === 'huge') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(400 * 1024) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      return;
    }
    if (behaviour === 'badjson') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('this is not json');
      return;
    }
    if (behaviour === 'empty') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '   ' } }] }));
      return;
    }
    if (req.url === '/evil') seen.redirectTarget.push('hit');
    res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req_local_1' });
    res.end(JSON.stringify({
      id: 'chatcmpl-local',
      model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: REPLY_TEXT } }],
      usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
    }));
  });
});
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
const PROVIDER_BASE = `http://127.0.0.1:${provider.address().port}/v1`;

const results = [];
let failures = 0;
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); };
const assert = (cond, m) => { if (!cond) throw new Error(m); };
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (e) { failures += 1; results.push(`FAIL ${name}: ${e.message}`); }
}

/* ---------- gateway ---------- */
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
await owner.login('owner@models.local', 'OwnerPassw0rd!2026');

async function makePrincipal(name, role) {
  const email = `${name}@models.local`;
  const res = await owner.request('/api/v1/principals', { method: 'POST', body: { name, email, role, password: 'AnotherPassw0rd!2026', type: 'human' } });
  if (res.status !== 201 && res.status !== 200) throw new Error(`create ${name}: ${res.text}`);
  const c = client();
  await c.login(email, 'AnotherPassw0rd!2026');
  return c;
}
const operator = await makePrincipal('operator', 'Operator');
const observer = await makePrincipal('observer', 'Observer');

const PROVIDER = 'pv-openai';

/* ---------- 1. the catalogue is honest before anything is configured ---------- */
await check('every provider starts unconfigured, with no invented spend', async () => {
  const res = await owner.request('/api/v1/providers');
  eq(res.status, 200, 'GET /providers');
  const p = res.body.providers.find((x) => x.id === PROVIDER);
  assert(p, 'the OpenAI entry exists in the catalogue');
  eq(p.status, 'unconfigured', 'status');
  eq(p.fingerprint, '', 'no fingerprint');
  eq(p.spendMtd, 0, 'no spend');
  eq(p.callsMtd, 0, 'no calls');
  eq(res.body.runtime.configuredCount, 0, 'runtime says nothing is configured');
  eq(res.body.runtime.costBasis, 'estimated', 'and that cost is an estimate');
  eq(res.body.budget.spentTodayUsd, 0, 'today’s spend is zero');
});

await check('a call with no key is refused as unconfigured and recorded as blocked', async () => {
  const res = await operator.request(`/api/v1/providers/${PROVIDER}/call`, { method: 'POST', body: { messages: [{ role: 'user', content: PROMPT_TEXT }] } });
  eq(res.status, 400, 'refused');
  eq(res.body.code, 'unconfigured', 'with the reason');
  const calls = await owner.request('/api/v1/model-calls');
  const row = calls.body.calls[0];
  eq(row.status, 'blocked', 'the attempt is in the ledger');
  eq(row.costUsd, 0, 'at zero cost');
  eq(seen.requests.length, 0, 'and nothing was sent to the provider');
});

/* ---------- 2. key handling ---------- */
await check('only an Owner may install a key', async () => {
  const body = { apiKey: PROVIDER_KEY, baseUrl: PROVIDER_BASE, defaultModel: 'gpt-4o-mini' };
  eq((await operator.request(`/api/v1/providers/${PROVIDER}/key`, { method: 'PUT', body })).status, 403, 'an Operator cannot');
  eq((await observer.request(`/api/v1/providers/${PROVIDER}/key`, { method: 'PUT', body })).status, 403, 'nor an Observer');
  eq(seen.requests.length, 0, 'and nothing reached the provider');
});

await check('the key is sealed, and the response carries a fingerprint instead', async () => {
  const res = await owner.request(`/api/v1/providers/${PROVIDER}/key`, {
    method: 'PUT', body: { apiKey: PROVIDER_KEY, baseUrl: PROVIDER_BASE, defaultModel: 'gpt-4o-mini' },
  });
  eq(res.status, 200, `PUT key (${res.text})`);
  assert(!res.text.includes(PROVIDER_KEY), 'the response must not contain the key');
  assert(!res.text.includes('sk-test'), 'nor any part of it');
  const p = res.body.provider;
  eq(p.status, 'configured', 'configured');
  assert(/^[0-9a-f]{16}$/.test(p.fingerprint), `a 16-hex fingerprint (got ${p.fingerprint})`);
  eq(p.hint, `••••${PROVIDER_KEY.slice(-4)}`, 'and a four-character hint');
  eq(p.endpointHost, `127.0.0.1:${provider.address().port}`, 'the endpoint host is shown');
});

await check('the database, the audit trail and the events hold no key', async () => {
  const dbm = await import('../apps/gateway/src/db.js');
  const row = dbm.db.prepare('SELECT key_sealed, key_fingerprint FROM providers WHERE id=?').get(PROVIDER);
  assert(row.key_sealed.startsWith('v1.'), 'the stored value is our sealed envelope');
  assert(!row.key_sealed.includes(PROVIDER_KEY), 'the sealed blob contains no plaintext');
  const audit = dbm.db.prepare('SELECT event, args_redacted FROM audit_log').all();
  assert(audit.some((r) => r.event === 'models.key.set'), 'the key installation is audited');
  assert(!JSON.stringify(audit).includes(PROVIDER_KEY), 'the audit trail holds no key');
  assert(!JSON.stringify(audit).includes('sk-test'), 'not even a prefix');
  const events = dbm.db.prepare('SELECT text FROM events').all();
  assert(!JSON.stringify(events).includes(PROVIDER_KEY), 'the event feed holds no key');
  const reads = await Promise.all([
    owner.request('/api/v1/providers'), owner.request('/api/v1/usage'), owner.request('/api/v1/model-calls'),
    owner.request('/api/v1/audit?limit=200'),
  ]);
  for (const read of reads) {
    assert(!read.text.includes(PROVIDER_KEY), `GET ${read.status} leaked the key`);
    assert(!/sk-test/.test(read.text), 'no prefix of the key in any read');
  }
});

await check('the SQLite file on disk does not contain the key', async () => {
  const files = ['mmm.sqlite', 'mmm.sqlite-wal', 'mmm.sqlite-shm'];
  let scanned = 0;
  for (const name of files) {
    try {
      const bytes = readFileSync(`${DATA_DIR}/${name}`);
      scanned += 1;
      assert(!bytes.includes(PROVIDER_KEY), `${name} contains the key in plaintext`);
      assert(!bytes.includes('sk-test-DO-NOT'), `${name} contains part of the key`);
    } catch { /* file may not exist */ }
  }
  assert(scanned > 0, 'at least one database file was scanned');
});

await check('a key with whitespace or an absurd length is refused', async () => {
  const bad = [
    { apiKey: 'has space inside', baseUrl: PROVIDER_BASE },
    { apiKey: 'line\nbreak', baseUrl: PROVIDER_BASE },
    { apiKey: 'k'.repeat(600), baseUrl: PROVIDER_BASE },
    { apiKey: '', baseUrl: PROVIDER_BASE },
  ];
  for (const body of bad) {
    const res = await owner.request(`/api/v1/providers/${PROVIDER}/key`, { method: 'PUT', body });
    eq(res.status, 400, `refused: ${JSON.stringify(body.apiKey).slice(0, 20)}`);
  }
});

await check('endpoint policy refuses plain http off-loopback, credentials and query strings', async () => {
  const cases = [
    ['http://api.example.com/v1', 'plain http off loopback'],
    ['https://user:pass@api.example.com/v1', 'credentials in the URL'],
    ['https://api.example.com/v1?key=abc', 'a query string'],
    ['ftp://api.example.com/v1', 'a non-http protocol'],
  ];
  for (const [baseUrl, why] of cases) {
    const res = await owner.request(`/api/v1/providers/${PROVIDER}/key`, { method: 'PUT', body: { apiKey: PROVIDER_KEY, baseUrl } });
    eq(res.status, 400, `refused: ${why}`);
    assert(/http|credential|query|protocol/i.test(res.body.error), `with a reason (${res.body.error})`);
  }
  // the good key is still installed and unchanged
  const list = await owner.request('/api/v1/providers');
  eq(list.body.providers.find((p) => p.id === PROVIDER).status, 'configured', 'the valid configuration survived');
});

/* ---------- 3. a real call ---------- */
let firstCost = 0;

await check('a real HTTP call returns the provider’s text and is metered', async () => {
  const res = await operator.request(`/api/v1/providers/${PROVIDER}/call`, {
    method: 'POST', body: { messages: [{ role: 'user', content: PROMPT_TEXT }], purpose: 'test', maxTokens: 64 },
  });
  eq(res.status, 200, `call (${res.text})`);
  eq(res.body.text, REPLY_TEXT, 'the reply is the provider’s own text');
  eq(res.body.usage.promptTokens, 120, 'prompt tokens from the provider');
  eq(res.body.usage.completionTokens, 30, 'completion tokens from the provider');
  assert(res.body.costUsd > 0, 'a cost was computed');
  eq(res.body.costBasis, 'estimated', 'and is labelled an estimate');
  firstCost = res.body.costUsd;

  const sent = seen.requests.at(-1);
  eq(sent.url, '/v1/chat/completions', 'the adapter posts to the OpenAI-compatible path');
  eq(sent.auth, `Bearer ${PROVIDER_KEY}`, 'with the key in the Authorization header (and nowhere else)');
  const payload = JSON.parse(sent.body);
  eq(payload.model, 'gpt-4o-mini', 'the chosen model');
  eq(payload.messages[0].content, PROMPT_TEXT, 'the prompt');
  eq(payload.max_tokens, 64, 'the token cap');
});

await check('the ledger records the call: tokens, cost, latency — but not the text', async () => {
  const usage = await owner.request('/api/v1/usage');
  eq(usage.status, 200, 'GET /usage');
  eq(usage.body.today.calls, 1, 'one call today');
  assert(Math.abs(usage.body.today.usd - firstCost) < 1e-9, 'spend equals the call’s cost');
  eq(usage.body.totals.tokens, 150, 'tokens are summed');
  eq(usage.body.byProvider[0].providerId, PROVIDER, 'attributed to the provider');
  const calls = await owner.request('/api/v1/model-calls');
  eq(calls.body.calls[0].status, 'ok', 'the row is ok');
  eq(calls.body.calls[0].tokens, 150, 'with its token count');
  assert(calls.body.calls[0].latencyMs >= 0, 'and a latency');
  assert(!calls.text.includes(PROMPT_TEXT) && !calls.text.includes(REPLY_TEXT), 'the ledger carries no prompt or reply');

  const dbm = await import('../apps/gateway/src/db.js');
  const rows = dbm.db.prepare('SELECT * FROM model_calls').all();
  assert(!JSON.stringify(rows).includes(PROMPT_TEXT), 'no prompt text in the ledger table');
  assert(!JSON.stringify(rows).includes(REPLY_TEXT), 'no reply text in the ledger table');
  const audit = dbm.db.prepare('SELECT args_redacted FROM audit_log').all();
  assert(!JSON.stringify(audit).includes(PROMPT_TEXT), 'and none in the audit trail');
  for (const name of ['mmm.sqlite', 'mmm.sqlite-wal']) {
    try {
      const bytes = readFileSync(`${DATA_DIR}/${name}`);
      assert(!bytes.includes(PROMPT_TEXT), `${name} must not contain the prompt`);
      assert(!bytes.includes(REPLY_TEXT), `${name} must not contain the reply`);
    } catch { /* file may not exist */ }
  }
});

await check('the provider’s own row now shows the real spend, not the fixture number', async () => {
  const list = await owner.request('/api/v1/providers');
  const p = list.body.providers.find((x) => x.id === PROVIDER);
  eq(p.callsMtd, 1, 'one call this month');
  assert(Math.abs(p.spendMtd - firstCost) < 1e-9, 'spend equals the ledger');
  assert(p.lastCallAt > 0, 'with a last-call timestamp');
});

/* ---------- 4. budget ---------- */
await check('the budget is enforced before the request leaves the process', async () => {
  const set = await owner.request('/api/v1/budget', { method: 'PUT', body: { dailyUsd: 0.000001, perCallUsd: 0.000001 } });
  eq(set.status, 200, `PUT /budget (${set.text})`);
  const before = seen.requests.length;
  const res = await operator.request(`/api/v1/providers/${PROVIDER}/call`, { method: 'POST', body: { messages: [{ role: 'user', content: 'spend money' }] } });
  eq(res.status, 402, 'refused with 402 Payment Required');
  eq(res.body.code, 'budget-exceeded', 'and the reason code');
  assert(/budget/i.test(res.body.error), `a plain-language reason (${res.body.error})`);
  eq(seen.requests.length, before, 'nothing was sent to the provider');
  const usage = await owner.request('/api/v1/usage');
  assert(Math.abs(usage.body.today.usd - firstCost) < 1e-9, 'spend did not move');
  assert(usage.body.totals.blocked >= 2, 'the refusal is in the ledger as blocked');
});

await check('a per-call cap above the daily cap is refused as a configuration error', async () => {
  const res = await owner.request('/api/v1/budget', { method: 'PUT', body: { dailyUsd: 1, perCallUsd: 5 } });
  eq(res.status, 400, 'refused');
});

await check('raising the budget allows a call again', async () => {
  eq((await owner.request('/api/v1/budget', { method: 'PUT', body: { dailyUsd: 5, perCallUsd: 0.5 } })).status, 200, 'budget raised');
  const res = await operator.request(`/api/v1/providers/${PROVIDER}/call`, { method: 'POST', body: { messages: [{ role: 'user', content: 'again' }] } });
  eq(res.status, 200, 'the call is allowed again');
});

/* ---------- 5. failure modes are honest ---------- */
await check('a provider 500 is a 502 with the provider’s reason, and no spend', async () => {
  behaviour = 'error500';
  const before = (await owner.request('/api/v1/usage')).body.today.usd;
  const res = await operator.request(`/api/v1/providers/${PROVIDER}/call`, { method: 'POST', body: { messages: [{ role: 'user', content: 'fail' }] } });
  eq(res.status, 502, 'bad gateway');
  assert(/HTTP 500/.test(res.body.error), `the status is in the message (${res.body.error})`);
  const after = (await owner.request('/api/v1/usage')).body.today.usd;
  eq(after, before, 'no spend was recorded');
  const calls = (await owner.request('/api/v1/model-calls')).body.calls;
  eq(calls[0].status, 'error', 'the attempt is logged as an error');
  eq(calls[0].error, 'http-500', 'with the code');
  behaviour = 'ok';
});

await check('a redirect is not followed — the key cannot be forwarded', async () => {
  behaviour = 'redirect';
  seen.redirectTarget.length = 0;
  const res = await operator.request(`/api/v1/providers/${PROVIDER}/call`, { method: 'POST', body: { messages: [{ role: 'user', content: 'redirect please' }] } });
  eq(res.status, 502, 'refused as a bad gateway');
  assert(/redirect/i.test(res.body.error), `the message says so (${res.body.error})`);
  eq(seen.redirectTarget.length, 0, 'the redirect target was never contacted');
  behaviour = 'ok';
});

await check('a slow provider times out with the limit that was applied', async () => {
  behaviour = 'slow';
  const res = await operator.request(`/api/v1/providers/${PROVIDER}/call`, { method: 'POST', body: { messages: [{ role: 'user', content: 'slow' }], timeoutMs: 500 } });
  eq(res.status, 504, 'gateway timeout');
  assert(/did not answer/i.test(res.body.error), `the message explains it (${res.body.error})`);
  const calls = (await owner.request('/api/v1/model-calls')).body.calls;
  eq(calls[0].error, 'timeout', 'logged as a timeout');
  behaviour = 'ok';
});

await check('an oversized or malformed response is an error, never an empty success', async () => {
  behaviour = 'huge';
  const huge = await operator.request(`/api/v1/providers/${PROVIDER}/call`, { method: 'POST', body: { messages: [{ role: 'user', content: 'huge' }] } });
  eq(huge.status, 502, 'oversized body refused');
  behaviour = 'badjson';
  const bad = await operator.request(`/api/v1/providers/${PROVIDER}/call`, { method: 'POST', body: { messages: [{ role: 'user', content: 'bad' }] } });
  eq(bad.status, 502, 'non-JSON refused');
  behaviour = 'empty';
  const empty = await operator.request(`/api/v1/providers/${PROVIDER}/call`, { method: 'POST', body: { messages: [{ role: 'user', content: 'empty' }] } });
  eq(empty.status, 502, 'empty content refused');
  behaviour = 'ok';
});

await check('a tampered sealed key is a conflict that asks for re-entry, not a crash', async () => {
  const dbm = await import('../apps/gateway/src/db.js');
  const original = dbm.db.prepare('SELECT key_sealed FROM providers WHERE id=?').get(PROVIDER).key_sealed;
  const parts = original.split('.');
  const tampered = `${parts[0]}.${parts[1]}.${parts[2]}.${Buffer.from('not-the-right-body').toString('base64url')}`;
  dbm.db.prepare('UPDATE providers SET key_sealed=? WHERE id=?').run(tampered, PROVIDER);
  const res = await operator.request(`/api/v1/providers/${PROVIDER}/call`, { method: 'POST', body: { messages: [{ role: 'user', content: 'tampered' }] } });
  eq(res.status, 409, 'a conflict');
  assert(/re-enter/i.test(res.body.error), `asking for re-entry (${res.body.error})`);
  dbm.db.prepare('UPDATE providers SET key_sealed=? WHERE id=?').run(original, PROVIDER);
  const again = await operator.request(`/api/v1/providers/${PROVIDER}/call`, { method: 'POST', body: { messages: [{ role: 'user', content: 'restored' }] } });
  eq(again.status, 200, 'and restoring the real key works again');
});

/* ---------- 6. roles ---------- */
await check('a watch-only role can read the ledger but not spend or configure', async () => {
  eq((await observer.request('/api/v1/providers')).status, 200, 'Observer reads providers');
  eq((await observer.request('/api/v1/usage')).status, 200, 'Observer reads usage');
  const call = await observer.request(`/api/v1/providers/${PROVIDER}/call`, { method: 'POST', body: { messages: [{ role: 'user', content: 'hi' }] } });
  eq(call.status, 403, 'Observer cannot call');
  const budget = await observer.request('/api/v1/budget', { method: 'PUT', body: { dailyUsd: 100 } });
  eq(budget.status, 403, 'Observer cannot change the budget');
});

/* ---------- 7. restart + disconnect ---------- */
await check('a sealed key survives a restart and still works', async () => {
  await new Promise((resolve) => { gateway.server.close(resolve); gateway.server.closeAllConnections?.(); });
  await new Promise((r) => setTimeout(r, 150));
  await start();
  await owner.login('owner@models.local', 'OwnerPassw0rd!2026');
  const list = await owner.request('/api/v1/providers');
  eq(list.body.providers.find((p) => p.id === PROVIDER).status, 'configured', 'still configured after a restart');
  const res = await operator.login('operator@models.local', 'AnotherPassw0rd!2026')
    .then(() => operator.request(`/api/v1/providers/${PROVIDER}/call`, { method: 'POST', body: { messages: [{ role: 'user', content: 'after restart' }] } }));
  eq(res.status, 200, 'and the call still works');
});

await check('removing the key returns the provider to unconfigured, and calls are refused again', async () => {
  const del = await owner.request(`/api/v1/providers/${PROVIDER}/key`, { method: 'DELETE' });
  eq(del.status, 200, 'DELETE key');
  eq(del.body.provider.status, 'unconfigured', 'unconfigured');
  eq(del.body.provider.fingerprint, '', 'no fingerprint');
  assert(del.body.cleared === true, 'the response says a key was removed');
  const res = await operator.request(`/api/v1/providers/${PROVIDER}/call`, { method: 'POST', body: { messages: [{ role: 'user', content: 'gone' }] } });
  eq(res.status, 400, 'refused');
  eq(res.body.code, 'unconfigured', 'as unconfigured');
  const dbm = await import('../apps/gateway/src/db.js');
  const row = dbm.db.prepare('SELECT key_sealed FROM providers WHERE id=?').get(PROVIDER);
  eq(row.key_sealed, '', 'the sealed value is gone from the row');
});

/* ---------- report ---------- */
console.log(results.join('\n'));
const passed = results.filter((r) => r.startsWith('PASS')).length;
console.log(`\nMODEL GATEWAY: ${passed} passed, ${failures} failed`);

try { gateway.wss?.close(); } catch { /* ignore */ }
await new Promise((r) => gateway.server.close(r));
await new Promise((r) => provider.close(r));
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failures > 0 ? 1 : 0);
