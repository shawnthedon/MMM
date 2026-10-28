/* Comms gateway tests — real HTTP against a real gateway with a throwaway DATA_DIR.
 * Run: npm run test:comms-gateway
 *
 * What must be true (roadmap §2):
 *   • credentials live server-side, encrypted at rest, and no API response ever echoes a secret;
 *   • saving a config never verifies a channel — only a provider-accepted send does;
 *   • outbound delivery reports exactly what the provider said (2xx vs 4xx vs network failure);
 *   • failures that are retryable are queued with backoff, quiet hours and rate limits are honoured;
 *   • inbound webhooks are signature-gated, replay/dedupe protected, and audited;
 *   • RBAC: comms:read for reads, comms:write to change or send; every call is audited.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'swarmos-comms-'));
process.env.DATA_DIR = DATA_DIR;
process.env.SWARMOS_QUIET = '1';
process.env.SWARMOS_SECRET = 'test-secret-material-for-comms-encryption';
process.env.SWARMOS_COMMS_DISABLE = '1'; // the ticker is driven explicitly by the tests
process.env.SWARMOS_BOOTSTRAP_EMAIL = 'owner@test.local';
process.env.SWARMOS_BOOTSTRAP_PASSWORD = 'OwnerPassw0rd!2026';
process.env.NODE_ENV = 'test';

const { createGateway } = await import('../apps/gateway/server.js');
const auth = await import('../apps/gateway/src/auth.js');
const commsSvc = await import('../apps/gateway/src/comms.js');

const gateway = createGateway();
await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${gateway.server.address().port}`;

const results = [];
let failures = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => results.push(`PASS ${name}`))
    .catch((err) => {
      failures += 1;
      results.push(`FAIL ${name}: ${err.message}`);
    });
}
const assert = (cond, message) => { if (!cond) throw new Error(message); };
const eq = (actual, expected, message) => {
  if (actual !== expected) throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
};

const csrfCookieName = (() => {
  // The CSRF token is delivered as a cookie by the login route; the header name is exported.
  return auth.CSRF_HEADER;
})();

function client(ip = '10.9.0.1') {
  const jar = {};
  return {
    jar,
    async request(path, { method = 'GET', body, headers = {}, csrf = false, raw = null } = {}) {
      const h = { 'x-forwarded-for': ip, ...headers };
      const cookieValue = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookieValue) h.cookie = cookieValue;
      if (csrf) {
        const token = Object.entries(jar).find(([k]) => /csrf/i.test(k))?.[1];
        if (token) h[auth.CSRF_HEADER] = token;
      }
      if (body !== undefined) h['content-type'] = 'application/json';
      const res = await fetch(BASE + path, {
        method,
        headers: h,
        body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      });
      for (const rawCookie of res.headers.getSetCookie?.() || []) {
        const [pair] = rawCookie.split(';');
        const idx = pair.indexOf('=');
        const name = pair.slice(0, idx).trim();
        const value = decodeURIComponent(pair.slice(idx + 1).trim());
        if (value === '' || /Max-Age=0/i.test(rawCookie)) delete jar[name];
        else jar[name] = value;
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      return { status: res.status, body: json, text, headers: res.headers };
    },
    async login(email, password) {
      const res = await this.request('/api/v1/auth/login', { method: 'POST', body: { email, password } });
      // The CSRF token is returned in the login body, not as a cookie, so park it in the jar.
      if (res.body?.csrfToken) jar[auth.CSRF_HEADER] = res.body.csrfToken;
      return res;
    },
  };
}

/* ---------- a controllable provider ---------- */
const providerCalls = [];
let providerReply = { status: 200, body: { ok: true } };
gateway.setFetch(async (url, init) => {
  providerCalls.push({ url, init });
  const reply = typeof providerReply === 'function' ? providerReply(url, init) : providerReply;
  if (reply instanceof Error) throw reply;
  return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
});
const resetProvider = (reply) => { providerCalls.length = 0; providerReply = reply; };

const owner = client();
const observer = client('10.9.0.2');
const operator = client('10.9.0.3');

await owner.login('owner@test.local', 'OwnerPassw0rd!2026');
for (const [cli, email, role] of [[observer, 'observer@test.local', 'Observer'], [operator, 'operator@test.local', 'Operator']]) {
  await owner.request('/api/v1/principals', { method: 'POST', csrf: true, body: { email, password: 'TempPassw0rd!9', name: `${role} User`, role } });
  await cli.login(email, 'TempPassw0rd!9');
}

/* =========================================================================================
 * 1. Reads and RBAC
 * =======================================================================================*/
await check('comms catalogue requires authentication and comms:read', async () => {
  const anon = await fetch(`${BASE}/api/v1/comms`);
  eq(anon.status, 401, 'anonymous callers are rejected');
  const obs = await observer.request('/api/v1/comms');
  eq(obs.status, 200, 'observer may read the catalogue');
  eq(obs.body.channels.length, 6, 'six channels are catalogued');
  assert(obs.body.encryption.secretsServerSide === true, 'the API states secrets are server-side');
  assert(!/botToken"\s*:\s*"1/.test(obs.text), 'no secret values in the read response');
});

await check('only comms:write roles may change a channel or send', async () => {
  const cfg = { config: { botToken: '123456789:AA-telegram-token-value', chatId: '-1001234567890', webhookSecret: 'hook-secret-1' } };
  eq((await observer.request('/api/v1/comms/telegram', { method: 'PUT', body: cfg, csrf: true })).status, 403, 'observer cannot save');
  eq((await observer.request('/api/v1/comms/telegram/send', { method: 'POST', body: { text: 'hi' }, csrf: true })).status, 403, 'observer cannot send');
  eq((await observer.request('/api/v1/comms/queue', { method: 'POST', body: {}, csrf: true })).status, 403, 'observer cannot run the queue');
  eq((await operator.request('/api/v1/comms/telegram', { method: 'PUT', body: cfg, csrf: true })).status, 200, 'operator may save');
});

/* =========================================================================================
 * 2. Encryption at rest + masking
 * =======================================================================================*/
await check('credentials are stored encrypted and never returned to a client', async () => {
  const raw = commsSvc.readChannel('telegram');
  assert(raw, 'channel row exists');
  const ciphertext = (await import('../apps/gateway/src/db.js')).db
    .prepare('SELECT config_ciphertext FROM comms_channels WHERE channel = ?').get('telegram').config_ciphertext;
  assert(ciphertext.startsWith('v1.'), 'ciphertext is versioned');
  assert(!ciphertext.includes('AA-telegram-token-value'), 'the plaintext token is not in the column');
  eq(raw.config.botToken, '123456789:AA-telegram-token-value', 'the gateway can decrypt it for its own use');

  const view = (await owner.request('/api/v1/comms')).body.channels.find((c) => c.id === 'telegram');
  eq(view.config.botToken, '••••alue', 'the API returns a masked value only');
  eq(view.config.chatId, '-1001234567890', 'non-secret fields stay readable');
  const again = await owner.request('/api/v1/comms');
  assert(!again.text.includes('AA-telegram-token-value'), 'the token never appears in any response body');
  assert(!again.text.includes('hook-secret-1'), 'the webhook secret never appears in any response body');
});

await check('a masked value sent back is ignored instead of overwriting the secret', async () => {
  const res = await owner.request('/api/v1/comms/telegram', {
    method: 'PUT', csrf: true,
    body: { config: { botToken: '••••alue', chatId: '-1001234567890' } },
  });
  eq(res.status, 200, 'masked round-trip accepted');
  eq(commsSvc.readChannel('telegram').config.botToken, '123456789:AA-telegram-token-value', 'the real secret survived');
});

await check('a local key file is only used when SWARMOS_SECRET is absent', () => {
  eq(commsSvc.keySource(), 'env', 'the configured secret is used');
  const sealed = commsSvc.encryptJson({ a: 1 });
  eq(commsSvc.decryptJson(sealed).a, 1, 'round-trip');
  eq(JSON.stringify(commsSvc.decryptJson('v1.bad.bad.bad')), '{}', 'tampered ciphertext yields nothing, never a guess');
});

/* =========================================================================================
 * 3. Saving ≠ verifying
 * =======================================================================================*/
await check('saving credentials leaves the channel unverified', async () => {
  const view = (await owner.request('/api/v1/comms')).body.channels.find((c) => c.id === 'telegram');
  eq(view.status, 'configured_unverified', 'configured but unverified');
  eq(view.verifiedAt, null, 'no verification timestamp');
  eq(view.lastTest, null, 'no test recorded');
});

await check('a channel cannot be enabled with fields missing', async () => {
  const res = await owner.request('/api/v1/comms/slack', { method: 'PUT', csrf: true, body: { config: { botToken: 'xoxb-partial' }, enabled: true } });
  eq(res.status, 400, 'enable refused');
  assert(/missing/i.test(res.body.error), 'the refusal names the missing fields');
});

/* =========================================================================================
 * 4. Delivery
 * =======================================================================================*/
await check('a disabled channel refuses to send and records the refusal', async () => {
  resetProvider({ status: 200 });
  const res = await owner.request('/api/v1/comms/telegram/send', { method: 'POST', csrf: true, body: { text: 'should not go' } });
  eq(res.status, 409, 'disabled channel is refused');
  eq(res.body.reason, 'disabled', 'the reason is stated');
  eq(providerCalls.length, 0, 'no provider call was attempted');
  const rows = (await owner.request('/api/v1/comms/messages?limit=5')).body.messages;
  eq(rows[0].status, 'failed', 'the refusal is recorded');
});

await check('a provider-accepted send verifies the channel and stores the outcome', async () => {
  await owner.request('/api/v1/comms/telegram', { method: 'PUT', csrf: true, body: { enabled: true } });
  resetProvider({ status: 200, body: { ok: true, result: { message_id: 42 } } });
  const res = await owner.request('/api/v1/comms/telegram/send', { method: 'POST', csrf: true, body: { text: 'Deploy finished' } });
  eq(res.status, 200, 'delivery succeeded');
  eq(res.body.ok, true, 'reported ok');
  eq(providerCalls.length, 1, 'exactly one provider call');
  assert(/api\.telegram\.org\/bot/.test(providerCalls[0].url), `the real Bot API URL was used (${providerCalls[0].url})`);
  assert(!providerCalls[0].url.includes('••••'), 'the decrypted token is used for the call');
  const view = (await owner.request('/api/v1/comms')).body.channels.find((c) => c.id === 'telegram');
  eq(view.status, 'verified', 'a provider-accepted send verifies the channel');
  eq((await owner.request('/api/v1/comms/messages?limit=1')).body.messages[0].status, 'sent', 'the attempt is a sent row');
});

await check('a provider rejection is reported as a failure, never as a success', async () => {
  resetProvider({ status: 400, body: { ok: false, description: 'Bad Request: chat not found' } });
  const res = await owner.request('/api/v1/comms/telegram/send', { method: 'POST', csrf: true, body: { text: 'nope' } });
  eq(res.status, 502, 'a rejected delivery is a 502');
  eq(res.body.ok, false, 'not reported as ok');
  assert(/chat not found/i.test(res.body.error), `provider message is surfaced (${res.body.error})`);
  eq(res.body.queued, false, 'a 4xx is not retried');
  const view = (await owner.request('/api/v1/comms')).body.channels.find((c) => c.id === 'telegram');
  eq(view.lastTest.ok, false, 'the failure is stored');
  eq(view.status, 'failed', 'status reflects the failed test');
});

await check('a network failure is queued for retry with backoff', async () => {
  resetProvider(Object.assign(new Error('connect ECONNREFUSED'), { name: 'FetchError' }));
  const res = await owner.request('/api/v1/comms/telegram/send', { method: 'POST', csrf: true, body: { text: 'retry me' } });
  eq(res.body.ok, false, 'not delivered');
  eq(res.body.queued, true, 'queued for retry');
  const row = (await owner.request('/api/v1/comms/messages?limit=1')).body.messages[0];
  eq(row.status, 'queued', 'the row is queued');
  eq(row.attempts, 1, 'one attempt recorded');
  assert(row.next_attempt_at > Date.now(), 'a future retry time is set');
  eq(commsSvc.backoffMs(1), 30000, 'first retry waits 30s');
  eq(commsSvc.backoffMs(2), 120000, 'second retry waits 2 minutes');
  assert(commsSvc.backoffMs(20) <= 3600000, 'backoff is capped at an hour');
});

await check('the queue delivers due messages and stops retrying at the limit', async () => {
  const db = (await import('../apps/gateway/src/db.js')).db;
  resetProvider({ status: 200, body: { ok: true } });
  db.prepare("UPDATE comms_messages SET next_attempt_at = ? WHERE status = 'queued'").run(Date.now() - 1000);
  const run = await owner.request('/api/v1/comms/queue', { method: 'POST', csrf: true, body: {} });
  eq(run.status, 200, 'queue ran');
  assert(run.body.sent >= 1, `the queued message was delivered (${JSON.stringify(run.body)})`);
  eq(db.prepare("SELECT COUNT(*) AS n FROM comms_messages WHERE status = 'queued'").get().n, 0, 'nothing left queued');

  // A permanently failing message must end as failed, not loop forever.
  await owner.request('/api/v1/comms/settings', { method: 'PUT', csrf: true, body: { retryLimit: 2 } });
  resetProvider(Object.assign(new Error('socket hang up'), { name: 'FetchError' }));
  await owner.request('/api/v1/comms/telegram/send', { method: 'POST', csrf: true, body: { text: 'doomed' } });
  for (let i = 0; i < 4; i += 1) {
    db.prepare("UPDATE comms_messages SET next_attempt_at = ? WHERE status = 'queued'").run(Date.now() - 1000);
    await owner.request('/api/v1/comms/queue', { method: 'POST', csrf: true, body: {} });
  }
  const doomed = db.prepare("SELECT * FROM comms_messages WHERE body_redacted LIKE '%doomed%'").get();
  eq(doomed.status, 'failed', 'retries exhausted');
  eq(doomed.attempts, 2, 'attempts stop at the configured limit');
  await owner.request('/api/v1/comms/settings', { method: 'PUT', csrf: true, body: { retryLimit: 3 } });
});

await check('quiet hours hold messages instead of sending them', async () => {
  const now = new Date();
  const start = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const end = `${String((now.getHours() + 1) % 24).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  await owner.request('/api/v1/comms/settings', { method: 'PUT', csrf: true, body: { quietHours: `${start}-${end}` } });
  resetProvider({ status: 200 });
  const res = await owner.request('/api/v1/comms/telegram/send', { method: 'POST', csrf: true, body: { text: 'held' } });
  eq(res.status, 202, 'accepted but held');
  eq(res.body.reason, 'quiet_hours', 'reason is quiet hours');
  eq(providerCalls.length, 0, 'nothing was sent');
  assert(commsSvc.inQuietHours(`${start}-${end}`) === true, 'the window is detected');
  assert(commsSvc.inQuietHours('') === false, 'no window means no quiet hours');
  await owner.request('/api/v1/comms/settings', { method: 'PUT', csrf: true, body: { quietHours: '' } });
});

await check('the same dedupe key cannot send twice', async () => {
  resetProvider({ status: 200 });
  const first = await owner.request('/api/v1/comms/telegram/send', { method: 'POST', csrf: true, body: { text: 'once', dedupeKey: 'job-123' } });
  eq(first.status, 200, 'first send ok');
  const second = await owner.request('/api/v1/comms/telegram/send', { method: 'POST', csrf: true, body: { text: 'once', dedupeKey: 'job-123' } });
  eq(second.status, 409, 'duplicate refused');
  eq(providerCalls.length, 1, 'only one provider call');
});

await check('stored message bodies are redacted', async () => {
  const saved = commsSvc.recordMessage({ channel: 'telegram', body: 'token 123456789:AAHsecretpart-abcdefghijklmnop and phone +2348012345678', status: 'sent' });
  assert(!saved.body_redacted.includes('AAHsecretpart'), `token redacted (${saved.body_redacted})`);
  assert(!saved.body_redacted.includes('2348012345678'), 'phone number redacted');
  assert(/\[bot-token\]/.test(saved.body_redacted), 'replacement marker present');
});

/* =========================================================================================
 * 5. Inbound webhooks
 * =======================================================================================*/
const signTelegram = (secret) => ({ 'x-telegram-bot-api-secret-token': secret });
const telegramUpdate = { update_id: 1, message: { message_id: 7, text: '/status', chat: { id: 99 }, from: { id: 5, username: 'tester' } } };

await check('an inbound webhook with no signature is rejected and recorded', async () => {
  resetProvider({ status: 200 });
  const res = await fetch(`${BASE}/api/v1/comms/telegram/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(telegramUpdate),
  });
  eq(res.status, 401, 'unsigned inbound is rejected');
  const rows = (await owner.request('/api/v1/comms/messages?direction=in&limit=5')).body.messages;
  eq(rows[0].status, 'rejected', 'the rejection is recorded');
  eq(rows[0].reason, 'signature', 'reason is the signature');
});

await check('a signed inbound command runs and the reply is delivered back', async () => {
  resetProvider({ status: 200, body: { ok: true } });
  const res = await fetch(`${BASE}/api/v1/comms/telegram/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signTelegram('hook-secret-1') },
    body: JSON.stringify(telegramUpdate),
  });
  const body = await res.json();
  eq(res.status, 200, 'signed inbound accepted');
  assert(/Gateway/i.test(body.reply), `the command answered from real rows (${body.reply})`);
  eq(body.delivered, true, 'the reply was delivered on the same channel');
  eq(providerCalls.length, 1, 'one provider call for the reply');
  const inbound = (await owner.request('/api/v1/comms/messages?direction=in&limit=1')).body.messages[0];
  eq(inbound.status, 'received', 'inbound mail recorded');
  eq(inbound.body_redacted, '/status', 'only the command text is stored');
});

await check('a replayed webhook is deduped by delivery id', async () => {
  resetProvider({ status: 200 });
  const send = (delivery) => fetch(`${BASE}/api/v1/comms/telegram/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signTelegram('hook-secret-1'), 'x-swarmos-delivery': delivery },
    body: JSON.stringify(telegramUpdate),
  });
  const first = await send('delivery-abc');
  eq(first.status, 200, 'first delivery accepted');
  const second = await send('delivery-abc');
  const body = await second.json();
  eq(body.duplicate, true, 'the replay is reported as a duplicate');
  eq(providerCalls.length, 1, 'no second reply was sent');
});

await check('a gated command refuses to act from a channel', async () => {
  const res = await fetch(`${BASE}/api/v1/comms/telegram/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signTelegram('hook-secret-1') },
    body: JSON.stringify({ update_id: 2, message: { message_id: 8, text: '/approve ap-1', chat: { id: 99 }, from: { id: 5 } } }),
  });
  const body = await res.json();
  eq(res.status, 200, 'the message was accepted');
  assert(/gated/i.test(body.reply), 'a gated action is refused with an explanation');
});

await check('Meta verification handshake echoes the challenge only for the stored token', async () => {
  await owner.request('/api/v1/comms/whatsapp', {
    method: 'PUT', csrf: true,
    body: { config: { accessToken: 'EAAG-test-token-value-1234', phoneNumberId: '1029384756', verifyToken: 'verify-me-123', recipient: '+2348012345678' } },
  });
  const okRes = await fetch(`${BASE}/api/v1/comms/whatsapp/verify?hub.mode=subscribe&hub.verify_token=verify-me-123&hub.challenge=challenge-42`);
  eq(okRes.status, 200, 'correct token passes');
  eq(await okRes.text(), 'challenge-42', 'challenge is echoed as plain text');
  const badRes = await fetch(`${BASE}/api/v1/comms/whatsapp/verify?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge-42`);
  eq(badRes.status, 403, 'wrong token fails');
});

await check('Meta inbound requires a valid X-Hub-Signature-256', async () => {
  await owner.request('/api/v1/comms/whatsapp', { method: 'PUT', csrf: true, body: { enabled: true } });
  const payload = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { messages: [{ from: '2348012345678', id: 'wamid.1', text: { body: '/tasks' } }] } }] }],
  });
  const signature = `sha256=${createHmac('sha256', 'EAAG-test-token-value-1234').update(payload).digest('hex')}`;
  const bad = await fetch(`${BASE}/api/v1/comms/whatsapp/inbound`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' }, body: payload,
  });
  eq(bad.status, 401, 'bad signature refused');
  resetProvider({ status: 200, body: { ok: true } });
  const good = await fetch(`${BASE}/api/v1/comms/whatsapp/inbound`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, body: payload,
  });
  const body = await good.json();
  eq(good.status, 200, 'valid signature accepted');
  assert(/Board/i.test(body.reply), `the /tasks command answered (${body.reply})`);
});

await check('inbound to a disabled channel is refused', async () => {
  await owner.request('/api/v1/comms/whatsapp', { method: 'PUT', csrf: true, body: { enabled: false } });
  const res = await fetch(`${BASE}/api/v1/comms/whatsapp/inbound`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=x' }, body: '{}',
  });
  eq(res.status, 403, 'disabled channel rejects inbound');
});

await check('unknown channels 404 on every comms route', async () => {
  eq((await owner.request('/api/v1/comms/carrier-pigeon', { method: 'PUT', csrf: true, body: { config: {} } })).status, 404, 'unknown channel config');
  eq((await owner.request('/api/v1/comms/carrier-pigeon/send', { method: 'POST', csrf: true, body: { text: 'x' } })).status, 404, 'unknown channel send');
});

/* =========================================================================================
 * 6. Fan-out, audit, settings
 * =======================================================================================*/
await check('a completed task is fanned out to routed channels as queued mail', async () => {
  const db = (await import('../apps/gateway/src/db.js')).db;
  const seeded = await owner.request('/api/v1/dev/seed', { method: 'POST', csrf: true, body: {} });
  eq(seeded.status, 200, 'sample data seeded');
  db.prepare('DELETE FROM comms_messages').run();
  resetProvider({ status: 200 });
  const agents = (await owner.request('/api/v1/agents')).body;
  const agent = agents[0];
  await owner.request(`/api/v1/comms/telegram`, { method: 'PUT', csrf: true, body: { routing: { agents: [agent.id] } } });
  const task = (await owner.request('/api/v1/tasks', { method: 'POST', csrf: true, body: { title: 'Fan-out probe', assignee: agent.id } })).body;
  await owner.request(`/api/v1/tasks/${task.id}`, { method: 'PATCH', csrf: true, body: { column_name: 'done' } });
  const queued = db.prepare("SELECT * FROM comms_messages WHERE status = 'queued' AND direction = 'out'").all();
  assert(queued.length >= 1, 'a message was queued for the routed channel');
  assert(queued.some((q) => /Fan-out probe/.test(q.body_redacted)), 'the queued body names the task');
  const again = await owner.request(`/api/v1/tasks/${task.id}`, { method: 'PATCH', csrf: true, body: { column_name: 'done' } });
  eq(again.status, 200, 'repeat patch accepted');
  eq(db.prepare("SELECT COUNT(*) AS n FROM comms_messages WHERE body_redacted LIKE '%Fan-out probe%'").get().n, 1, 'the dedupe key stops a second fan-out');
});

await check('every comms mutation is in the audit chain, without secrets', async () => {
  const auditRes = await owner.request('/api/v1/audit?limit=200');
  const events = auditRes.body.map((r) => r.event);
  assert(events.includes('comms.channel.save'), 'channel saves are audited');
  assert(events.includes('comms.send'), 'sends are audited');
  assert(events.includes('comms.inbound'), 'inbound calls are audited');
  const text = JSON.stringify(auditRes.body);
  assert(!text.includes('AA-telegram-token-value'), 'no secret in the audit log');
  assert(!text.includes('hook-secret-1'), 'no webhook secret in the audit log');
  eq((await owner.request('/api/v1/audit/verify')).body.ok, true, 'the chain still verifies');
});

await check('settings validate and round-trip', async () => {
  eq((await owner.request('/api/v1/comms/settings', { method: 'PUT', csrf: true, body: { quietHours: '25:00-99:00' } })).status, 400, 'bad quiet hours refused');
  const res = await owner.request('/api/v1/comms/settings', { method: 'PUT', csrf: true, body: { quietHours: '22:00-06:00', rateLimitPerMin: 5, commands: { '/ask': false } } });
  eq(res.status, 200, 'valid settings accepted');
  const cat = await owner.request('/api/v1/comms');
  eq(cat.body.settings.quietHours, '22:00-06:00', 'stored');
  eq(cat.body.settings.rateLimitPerMin, 5, 'stored');
  eq(cat.body.settings.commands['/ask'], false, 'command disabled');
  const blocked = commsSvc.runCommand('/ask');
  eq(blocked.reason, 'blocked', 'a disabled command is refused');
  await owner.request('/api/v1/comms/settings', { method: 'PUT', csrf: true, body: { quietHours: '', rateLimitPerMin: 20, commands: { '/ask': true } } });
});

await check('deleting credentials clears the channel and its verification', async () => {
  const res = await owner.request('/api/v1/comms/telegram', { method: 'DELETE', csrf: true });
  eq(res.status, 200, 'deleted');
  const view = (await owner.request('/api/v1/comms')).body.channels.find((c) => c.id === 'telegram');
  eq(view.status, 'not_configured', 'back to not configured');
  eq(view.enabled, false, 'and disabled');
  eq(view.verifiedAt, null, 'no verification left');
  eq(commsSvc.readChannel('telegram'), null, 'no row remains');
});

/* ---------- report ---------- */
console.log(results.join('\n'));
gateway.server.close();
rmSync(DATA_DIR, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} comms gateway test(s) failed`);
  process.exit(1);
}
console.log(`\nCOMMS GATEWAY (SERVICE + ROUTES): ${results.length}/${results.length} PASSED`);
process.exit(0);
