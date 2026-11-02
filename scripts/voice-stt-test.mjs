/* Local speech hosts — open-source voice, local first (unit 5 of the Copilot upgrade).
 * Run: npm run test:voice-stt
 *
 * The assertions that matter, in the order a person would meet them:
 *   • with no host configured, transcription is refused and says what to install — nothing is guessed;
 *   • an endpoint is an owner act: an Operator can transcribe but cannot point the gateway somewhere new
 *     (`voice:configure` is Owner), and an Observer can read but do neither;
 *   • the endpoint validator refuses a non-loopback host, `http://user:pass@…`, a non-http scheme and a
 *     url carrying a query — a recording must go exactly where the operator said;
 *   • a clip is forwarded as multipart to the documented path (`/inference` for whisper.cpp,
 *     `/v1/audio/transcriptions` for the OpenAI-shaped mode), with the right form fields per mode —
 *     whisper.cpp's server does not document a `language` field, so we do not invent one;
 *   • **nothing spoken is stored**: after a successful transcription there is no audio, no transcript and
 *     no reference to either in the database — only an audit row describing bytes, engine and outcome;
 *   • a host failure is never an empty transcript: 500 → 502 with the host's status, a body with no `text`
 *     → 502 `bad-response`, a genuinely silent clip → 200 with `empty: true`;
 *   • too large → 413 before the host is contacted, a non-audio type → 415, a timeout → 504, a dead host
 *     → 502, and the rate limit is 20/min per principal;
 *   • a health probe reports `available` / `no-health-endpoint` (a 404 is not a failure) / `unreachable`,
 *     and the result is persisted on the row;
 *   • a disabled endpoint is never chosen; capabilities tell the panel the truth about what exists.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = Number(process.env.MMM_TEST_PORT || 8896);
const DATA_DIR = `/tmp/mmm-voice-${process.pid}`;
rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;
process.env.MMM_QUIET = '1';
process.env.MMM_SECRET = 'test-secret-material-that-is-long-enough-1234';
process.env.MMM_BOOTSTRAP_EMAIL = 'owner@voice.local';
process.env.MMM_BOOTSTRAP_PASSWORD = 'OwnerPassw0rd!2026';
delete process.env.MMM_VOICE_ALLOW_REMOTE;

/* ---------- a real local speech host, on loopback ---------- */
const host = {
  requests: [],
  mode: 'ok',
  text: 'read the pricing page',
  healthStatus: 200,
  delayMs: 0,
};
const speech = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  host.requests.push({
    url: req.url,
    method: req.method,
    contentType: req.headers['content-type'] || '',
    bytes: body.length,
    body,
  });
  if (host.delayMs) await new Promise((r) => setTimeout(r, host.delayMs));
  if (req.url === '/health') {
    if (host.healthStatus === 0) { res.destroy(); return; }
    res.writeHead(host.healthStatus, { 'content-type': 'application/json' });
    res.end(JSON.stringify(host.healthStatus === 200 ? { status: 'ok', engine: 'whisper.cpp', model: 'ggml-base.en' } : { error: 'nope' }));
    return;
  }
  if (host.mode === 'fail') {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'model crashed' }));
    return;
  }
  if (host.mode === 'garbage') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result: 'not the shape we understand' }));
    return;
  }
  if (host.mode === 'prose') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('I am a helpful server');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(host.mode === 'empty' ? { text: '' } : { text: host.text, language: 'en' }));
});
await new Promise((r) => speech.listen(0, '127.0.0.1', r));
const HOST = `http://127.0.0.1:${speech.address().port}`;

const results = [];
let failures = 0;
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); };
const ok = (cond, m) => { if (!cond) throw new Error(m); };
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); console.log(`PASS ${name}`); }
  catch (e) { failures += 1; results.push(`FAIL ${name}: ${e.message}`); console.log(`FAIL ${name}: ${e.message}`); }
}

const { createGateway } = await import('../apps/gateway/server.js');
const authMod = await import('../apps/gateway/src/auth.js');
const dbm = await import('../apps/gateway/src/db.js');
const voiceMod = await import('../apps/gateway/src/voice.js');
const gateway = createGateway();
await new Promise((r) => gateway.server.listen(PORT, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${PORT}`;

function client() {
  const jar = {};
  const api = {
    csrf: null,
    async request(path, { method = 'GET', body, raw, contentType } = {}) {
      const headers = {};
      const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookies) headers.cookie = cookies;
      if (method !== 'GET' && api.csrf) headers[authMod.CSRF_HEADER] = api.csrf;
      if (raw !== undefined) headers['content-type'] = contentType || 'application/octet-stream';
      else if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(BASE + path, {
        method, headers,
        body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
      });
      for (const rawCookie of res.headers.getSetCookie?.() || []) {
        const [pair] = rawCookie.split(';');
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
await owner.login('owner@voice.local', 'OwnerPassw0rd!2026');

async function makePrincipal(name, role) {
  const email = `${name}@voice.local`;
  const res = await owner.request('/api/v1/principals', { method: 'POST', body: { name, email, role, password: 'AnotherPassw0rd!2026', type: 'human' } });
  if (![200, 201].includes(res.status)) throw new Error(`create ${name}: ${res.text}`);
  const c = client();
  await c.login(email, 'AnotherPassw0rd!2026');
  return c;
}
const operator = await makePrincipal('operator', 'Operator');
const reviewer = await makePrincipal('reviewer', 'Reviewer');
const watcher = await makePrincipal('watcher', 'Observer');

// A small, plausible clip: the bytes do not have to be valid audio for any of this, and pretending to
// decode them here would be the test lying about what it verified.
const CLIP = Buffer.from('1a45dfa3-opus-ish-bytes-for-a-recording-'.repeat(40), 'utf8');
const audio = (bytes = CLIP) => bytes;

await check('with no host configured, transcription is refused and says what to install', async () => {
  const res = await operator.request('/api/v1/voice/transcribe', { method: 'POST', raw: audio(), contentType: 'audio/webm' });
  eq(res.status, 409, `refused (${res.text.slice(0, 200)})`);
  eq(res.body.code, 'no-endpoint', 'with the code');
  ok(/no local transcription host/i.test(res.body.error), `naming the cause (got "${res.body.error}")`);
  ok(/whisper\.cpp/i.test(res.body.hint || ''), 'and what to install');
  eq(speech === null, false, 'the speech host object still exists');
  eq(host.requests.length, 0, 'nothing was sent anywhere');
});

await check('an endpoint is an owner act: an Operator and an Observer are both refused', async () => {
  const body = { kind: 'stt', engine: 'whisper.cpp', label: 'Local whisper', url: HOST };
  eq((await operator.request('/api/v1/voice/endpoints', { method: 'POST', body })).status, 403, 'an Operator cannot add one');
  eq((await reviewer.request('/api/v1/voice/endpoints', { method: 'POST', body })).status, 403, 'nor a Reviewer');
  eq((await watcher.request('/api/v1/voice/endpoints', { method: 'POST', body })).status, 403, 'nor an Observer');
  eq((await watcher.request('/api/v1/voice')).status, 200, 'but an Observer can read what exists');
});

await check('the endpoint validator refuses what would send audio somewhere else', async () => {
  const bad = [
    { url: 'https://speech.example.com', why: 'a remote host, without opting in' },
    { url: `http://user:pass@127.0.0.1:${speech.address().port}`, why: 'credentials in the url' },
    { url: 'file:///etc/passwd', why: 'a non-http scheme' },
    { url: `${HOST}/inference`, why: 'a url that already carries the request path' },
    { url: `${HOST}/?x=1`, why: 'a url carrying a query' },
  ];
  for (const { url, why } of bad) {
    const res = await owner.request('/api/v1/voice/endpoints', { method: 'POST', body: { kind: 'stt', engine: 'whisper.cpp', url } });
    eq(res.status, 400, `refused ${why} (${res.text.slice(0, 160)})`);
  }
  eq((await owner.request('/api/v1/voice/endpoints')).body.endpoints.length, 0, 'and none was stored');
  const pathy = await owner.request('/api/v1/voice/endpoints', { method: 'POST', body: { kind: 'stt', engine: 'whisper.cpp', url: `${HOST}/inference` } });
  ok(/host root/i.test(pathy.body.error || ''), `a request path is refused with a message that says what to do (got "${pathy.body.error}")`);
});

await check('an engine that does not serve HTTP is refused rather than silently unexplained', async () => {
  const res = await owner.request('/api/v1/voice/endpoints', {
    method: 'POST', body: { kind: 'tts', engine: 'piper', url: HOST },
  });
  eq(res.status, 400, 'refused');
  ok(/does not serve HTTP/i.test(res.body.error), `with the reason (got "${res.body.error}")`);
  ok(/compatible host/i.test(res.body.error), `and what to do about it (got "${res.body.error}")`);
});

let endpointId = null;
await check('an Owner adds a loopback host, and it is stored as local', async () => {
  const res = await owner.request('/api/v1/voice/endpoints', {
    method: 'POST',
    body: { kind: 'stt', engine: 'whisper.cpp', label: 'Local whisper', url: HOST, language: 'en' },
  });
  eq(res.status, 201, `created (${res.text.slice(0, 300)})`);
  endpointId = res.body.endpoint.id;
  eq(res.body.endpoint.remote, false, 'marked local');
  eq(res.body.endpoint.enabled, true, 'and enabled');
  eq(res.body.endpoint.mode, 'whisper.cpp', 'with the mode its engine documents');
  eq(res.body.capabilities.localStt, true, 'capabilities now report a local host');
  const dupe = await owner.request('/api/v1/voice/endpoints', { method: 'POST', body: { kind: 'stt', engine: 'whisper.cpp', url: HOST } });
  eq(dupe.status, 409, 'the same url twice is a conflict, not a second host');
});

await check('the health probe separates “no health route” from “unreachable”', async () => {
  const good = await owner.request(`/api/v1/voice/endpoints/${endpointId}/check`, { method: 'POST', body: {} });
  eq(good.status, 200, 'checked');
  eq(good.body.endpoint.lastStatus, 'available', 'available');
  ok(/whisper\.cpp/.test(good.body.endpoint.lastDetail), `with the engine it named (got "${good.body.endpoint.lastDetail}")`);

  host.healthStatus = 404;
  const none = await owner.request(`/api/v1/voice/endpoints/${endpointId}/check`, { method: 'POST', body: {} });
  eq(none.body.endpoint.lastStatus, 'no-health-endpoint', 'a 404 is “no health route”, not a failure');
  ok(/attempted anyway/i.test(none.body.endpoint.lastDetail), 'and it says transcription is still tried');
  let row = dbm.db.prepare('SELECT * FROM voice_endpoints WHERE id=?').get(endpointId);
  eq(row.last_status, 'no-health-endpoint', 'the probe result is persisted on the row');

  host.healthStatus = 0; // the host drops the socket
  const dead = await owner.request(`/api/v1/voice/endpoints/${endpointId}/check`, { method: 'POST', body: {} });
  eq(dead.body.endpoint.lastStatus, 'unreachable', 'a dropped socket is unreachable');
  row = dbm.db.prepare('SELECT * FROM voice_endpoints WHERE id=?').get(endpointId);
  eq(row.last_status, 'unreachable', 'and that result is persisted too, replacing the last one');
  host.healthStatus = 200;
});

await check('a clip is forwarded to the documented path as multipart', async () => {
  host.requests.length = 0;
  host.mode = 'ok';
  const res = await operator.request('/api/v1/voice/transcribe', { method: 'POST', raw: audio(), contentType: 'audio/webm;codecs=opus' });
  eq(res.status, 200, `transcribed (${res.text.slice(0, 300)})`);
  eq(res.body.text, 'read the pricing page', 'the transcript comes back');
  eq(res.body.empty, false, 'and is not empty');
  eq(res.body.engine, 'whisper.cpp', 'with the engine that produced it');
  eq(res.body.stayedLocal, true, 'and a statement that the audio stayed on this network');
  eq(host.requests.length, 1, 'the host was called once');
  const sent = host.requests[0];
  eq(sent.url, '/inference', 'at whisper.cpp’s documented inference path');
  ok(/^multipart\/form-data; boundary=/.test(sent.contentType), `as multipart (got "${sent.contentType}")`);
  ok(sent.body.includes('response_format'), 'with response_format, which that server documents');
  ok(!sent.body.includes('name="language"'), 'and no language field, which it does not');
  ok(sent.bytes > CLIP.length, 'the file part carries the clip');
});

await check('a host mounted under a prefix keeps the prefix, and the OpenAI mode sends language', async () => {
  // The fake host answers the same telegram whatever the prefix; what matters is the path we build and
  // the fields we send, so the assertion is on the recorded request, not on the reply.
  const prefixed = await owner.request('/api/v1/voice/endpoints', {
    method: 'POST',
    body: { kind: 'stt', engine: 'faster-whisper-server', mode: 'openai', label: 'Wrapper', url: `${HOST}/speech`, model: 'small', language: 'de' },
  });
  eq(prefixed.status, 201, `created (${prefixed.text.slice(0, 200)})`);
  eq(prefixed.body.endpoint.remote, false, 'a prefixed loopback host is still local');
  host.requests.length = 0;
  const res = await operator.request(`/api/v1/voice/transcribe?endpointId=${prefixed.body.endpoint.id}`, { method: 'POST', raw: audio(), contentType: 'audio/wav' });
  eq(res.status, 200, `transcribed (${res.text.slice(0, 200)})`);
  const sent = host.requests[0];
  eq(sent.url, '/speech/v1/audio/transcriptions', 'the prefix is kept and the OpenAI path appended');
  ok(sent.body.includes('name="language"') && sent.body.includes('de'), 'and language is sent, which that shape documents');
  ok(sent.body.includes('name="model"'), 'with the model the endpoint names');
  await owner.request(`/api/v1/voice/endpoints/${prefixed.body.endpoint.id}`, { method: 'DELETE' });
});

await check('nothing spoken is stored: no audio, no transcript, only an audit row', async () => {
  const tables = dbm.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  const secret = 'read the pricing page';
  for (const table of tables) {
    const cols = dbm.db.prepare(`PRAGMA table_info(${table})`).all();
    const textCols = cols.filter((c) => /TEXT|CHAR|CLOB/i.test(c.type || '')).map((c) => c.name);
    if (!textCols.length) continue;
    const rows = dbm.db.prepare(`SELECT ${textCols.join(',')} FROM ${table}`).all();
    for (const row of rows) {
      for (const [col, value] of Object.entries(row)) {
        if (typeof value !== 'string') continue;
        ok(!value.includes(secret), `table ${table}.${col} holds the transcript (${value.slice(0, 80)})`);
      }
    }
  }
  const audits = dbm.db.prepare("SELECT * FROM audit_log WHERE event='voice.transcribe'").all();
  ok(audits.length >= 1, 'the transcription is audited');
  const last = audits.at(-1);
  ok(/"bytes"/.test(last.args_redacted) && /"engine"/.test(last.args_redacted), `the audit records the shape of the request (got ${last.args_redacted})`);
  ok(!last.args_redacted.includes(secret), 'and never the words');
  eq(last.policy_decision, 'allow', 'allowed');
  eq(last.result, 'ok', 'ok');
});

await check('a host failure is a failure, never an empty transcript', async () => {
  host.mode = 'fail';
  const failed = await operator.request('/api/v1/voice/transcribe', { method: 'POST', raw: audio(), contentType: 'audio/webm' });
  eq(failed.status, 502, 'a 500 from the host is a bad gateway');
  ok(/HTTP 500/.test(failed.body.error), `with the host's status (got "${failed.body.error}")`);
  eq(failed.body.text, undefined, 'and no text at all');

  host.mode = 'garbage';
  const garbage = await operator.request('/api/v1/voice/transcribe', { method: 'POST', raw: audio(), contentType: 'audio/webm' });
  eq(garbage.status, 502, 'a body without text is a bad response');
  eq(garbage.body.code, 'bad-response', 'named as such');
  ok(/without a text field/i.test(garbage.body.error), 'and saying what was wrong');
  eq(garbage.body.text, undefined, 'still no invented transcript');

  host.mode = 'prose';
  const prose = await operator.request('/api/v1/voice/transcribe', { method: 'POST', raw: audio(), contentType: 'audio/webm' });
  eq(prose.status, 502, 'plain prose is not accepted as a transcript either');

  host.mode = 'empty';
  const empty = await operator.request('/api/v1/voice/transcribe', { method: 'POST', raw: audio(), contentType: 'audio/webm' });
  eq(empty.status, 200, 'a genuinely silent clip is not an error');
  eq(empty.body.text, '', 'with empty text');
  eq(empty.body.empty, true, 'and a flag that says nothing was heard');
  host.mode = 'ok';
});

await check('a clip that is too large or the wrong type never reaches the host', async () => {
  host.requests.length = 0;
  const big = Buffer.alloc(6 * 1024 * 1024 + 1024, 1);
  const tooBig = await operator.request('/api/v1/voice/transcribe', { method: 'POST', raw: big, contentType: 'audio/webm' });
  eq(tooBig.status, 413, 'refused for size');
  eq(host.requests.length, 0, 'and the host was never contacted');

  const wrong = await operator.request('/api/v1/voice/transcribe', { method: 'POST', raw: Buffer.from('hello'), contentType: 'text/plain' });
  eq(wrong.status, 415, 'refused for type');
  eq(wrong.body.code, 'audio-refused', 'named as such');
  eq(host.requests.length, 0, 'and still nothing was sent');

  const none = await operator.request('/api/v1/voice/transcribe', { method: 'POST', raw: Buffer.alloc(0), contentType: 'audio/webm' });
  eq(none.status, 415, 'an empty recording is refused, not transcribed');
});

await check('a host that never answers is a timeout, and a dead host is unreachable', async () => {
  host.delayMs = 32000;
  const slow = await operator.request('/api/v1/voice/transcribe', { method: 'POST', raw: audio(), contentType: 'audio/webm' });
  host.delayMs = 0;
  eq(slow.status, 504, `timed out (${slow.text.slice(0, 160)})`);
  eq(slow.body.code, 'timeout', 'named as a timeout');

  // Point a second endpoint at a port nothing is listening on: the honest failure is "unreachable".
  const deadPort = await (async () => {
    const probe = createServer(() => {});
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));
    return port;
  })();
  const created = await owner.request('/api/v1/voice/endpoints', {
    method: 'POST', body: { kind: 'stt', engine: 'whisper.cpp', label: 'Dead host', url: `http://127.0.0.1:${deadPort}` },
  });
  eq(created.status, 201, 'created');
  const dead = await operator.request(`/api/v1/voice/transcribe?endpointId=${created.body.endpoint.id}`, { method: 'POST', raw: audio(), contentType: 'audio/webm' });
  eq(dead.status, 502, 'a dead host is a bad gateway');
  eq(dead.body.code, 'unreachable', 'named as unreachable');
});

await check('a disabled endpoint is never chosen, and naming it is refused', async () => {
  const off = await owner.request(`/api/v1/voice/endpoints/${endpointId}`, { method: 'PATCH', body: { enabled: false } });
  eq(off.status, 200, 'disabled');
  eq(off.body.endpoint.enabled, false, 'and stored as disabled');
  const res = await operator.request('/api/v1/voice/transcribe', { method: 'POST', raw: audio(), contentType: 'audio/webm' });
  // The dead-host endpoint is still enabled, so auto-selection picks *that* row rather than guessing.
  eq([502, 409].includes(res.status), true, `nothing was transcribed (${res.status})`);
  const named = await operator.request(`/api/v1/voice/transcribe?endpointId=${endpointId}`, { method: 'POST', raw: audio(), contentType: 'audio/webm' });
  eq(named.status, 409, 'naming a disabled endpoint is a conflict');
  eq(named.body.code, 'no-endpoint', 'and says there is no usable endpoint');
  await owner.request(`/api/v1/voice/endpoints/${endpointId}`, { method: 'PATCH', body: { enabled: true } });
});

await check('transcription is rate limited per principal', async () => {
  let sawLimit = false;
  for (let i = 0; i < 24; i += 1) {
    const res = await operator.request('/api/v1/voice/transcribe', { method: 'POST', raw: audio(), contentType: 'audio/webm' });
    if (res.status === 429) { sawLimit = true; break; }
  }
  eq(sawLimit, true, 'a burst is throttled rather than run unbounded');
});

await check('capabilities name the engines, their licences and what is offerable', async () => {
  const body = (await watcher.request('/api/v1/voice')).body;
  ok(Array.isArray(body.engines) && body.engines.length >= 4, 'the catalogue is present');
  const whisper = body.engines.find((e) => e.id === 'whisper.cpp');
  eq(whisper.licence.spdx, 'MIT', 'whisper.cpp is MIT');
  eq(whisper.licence.verified, true, 'and that licence was read from upstream, not remembered');
  ok(/api\.github\.com/.test(whisper.licence.verifiedVia), 'with the source of the verification');
  const piper = body.engines.find((e) => e.id === 'piper');
  eq(piper.offerable, false, 'Piper is not offerable as an endpoint: it ships a CLI, not a server');
  eq(body.limits.audioBytes, 6 * 1024 * 1024, 'the limits are reported so the client can apply the same ones');
  eq(body.allowRemoteHosts, false, 'remote hosts are off unless the deployment says otherwise');
});

await check('an endpoint can be removed, and its audit trail stays', async () => {
  const removed = await owner.request(`/api/v1/voice/endpoints/${endpointId}`, { method: 'DELETE' });
  eq(removed.status, 200, 'deleted');
  eq((await owner.request('/api/v1/voice/endpoints')).body.endpoints.some((e) => e.id === endpointId), false, 'it is gone from the list');
  const audits = dbm.db.prepare("SELECT * FROM audit_log WHERE event LIKE 'voice.%'").all();
  ok(audits.some((a) => a.event === 'voice.endpoint.delete'), 'the deletion is audited');
  ok(audits.some((a) => a.event === 'voice.endpoint.create'), 'and so is the creation');
});

console.log(`\nVOICE STT: ${results.filter((r) => r.startsWith('PASS')).length} passed, ${failures} failed`);
const code = failures ? 1 : 0;
try { speech.close(); } catch { /* ignore */ }
try { gateway.server.closeAllConnections?.(); gateway.server.close(); } catch { /* ignore */ }
await new Promise((r) => setTimeout(r, 150));
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(code);
