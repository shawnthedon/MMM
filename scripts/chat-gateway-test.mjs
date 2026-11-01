/* Chat persistence — real gateway, real HTTP, throwaway DATA_DIR.
 * Run: npm run test:chat
 *
 * The contract under test:
 *   • threads and messages are stored on the gateway and survive a restart of the process;
 *   • a message is written exactly once, in order, and the reply to the write contains no answer;
 *   • a request body cannot claim an agent spoke — only a runtime may do that, and there is none;
 *   • `unread` is a server-owned counter, cleared only by an explicit read mark;
 *   • writes are permissioned, validated and audited without storing message text.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'mmm-chat-'));
process.env.DATA_DIR = DATA_DIR;
process.env.MMM_QUIET = '1';
process.env.MMM_BOOTSTRAP_EMAIL = 'owner@test.local';
process.env.MMM_BOOTSTRAP_PASSWORD = 'OwnerPassw0rd!2026';
delete process.env.NODE_ENV;
process.env.NODE_ENV = 'test';

const { createGateway } = await import('../apps/gateway/server.js');
const { db } = await import('../apps/gateway/src/db.js');
const auth = await import('../apps/gateway/src/auth.js');

const gateway = createGateway();
await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${gateway.server.address().port}`;

const results = [];
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    results.push(`FAIL ${name}: ${error.message}`);
  }
}
const assert = (cond, message) => { if (!cond) throw new Error(message); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); };

const CSRF_COOKIE = auth.CSRF_HEADER;
function client(ip = '10.7.0.1') {
  const jar = {};
  return {
    jar,
    async request(path, { method = 'GET', body, csrf = false } = {}) {
      const headers = { 'x-forwarded-for': ip };
      const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) headers.cookie = cookie;
      if (csrf && jar[CSRF_COOKIE]) headers[auth.CSRF_HEADER] = jar[CSRF_COOKIE];
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      for (const raw of res.headers.getSetCookie?.() || []) {
        const [pair] = raw.split(';');
        const idx = pair.indexOf('=');
        const name = pair.slice(0, idx).trim();
        const value = decodeURIComponent(pair.slice(idx + 1).trim());
        if (value === '' || /Max-Age=0/i.test(raw)) delete jar[name];
        else jar[name] = value;
      }
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      return { status: res.status, body: json, text };
    },
    async login(email, password) {
      const res = await this.request('/api/v1/auth/login', { method: 'POST', body: { email, password } });
      if (res.status === 200) jar[CSRF_COOKIE] = res.body.csrfToken;
      return res;
    },
  };
}

const owner = client('10.7.0.1');
const observer = client('10.7.0.2');

eq((await owner.login('owner@test.local', 'OwnerPassw0rd!2026')).status, 200, 'owner login');
const created = await owner.request('/api/v1/principals', {
  method: 'POST', csrf: true,
  body: { email: 'observer@test.local', password: 'TempPassw0rd!9', name: 'Observer User', role: 'Observer' },
});
eq(created.status, 201, 'create observer');
eq((await observer.login('observer@test.local', 'TempPassw0rd!9')).status, 200, 'observer login');

const seeded = await owner.request('/api/v1/dev/seed', { method: 'POST', csrf: true, body: {} });
eq(seeded.status, 200, `seed (${seeded.text})`);

const threadsOf = async (c = owner) => {
  const res = await c.request('/api/v1/threads');
  eq(res.status, 200, `GET /threads (${res.text})`);
  return res.body;
};
const threadById = async (id, c = owner) => {
  const res = await c.request(`/api/v1/threads/${id}`);
  eq(res.status, 200, `GET /threads/${id} (${res.text})`);
  return res.body.thread;
};

/* ---------- 1. the seeded transcript is served, not re-invented ---------- */
await check('threads and messages come from the database, in order', async () => {
  const { threads } = await threadsOf();
  assert(threads.length >= 3, `the seeded transcript should be served, got ${threads.length} threads`);
  const first = threads[0];
  assert(first.messages.length >= 1, 'a thread with no messages is not a conversation');
  for (const thread of threads) {
    const ts = thread.messages.map((m) => m.ts);
    assert(ts.every((v, i) => i === 0 || ts[i - 1] <= v), `${thread.title}: messages must read oldest → newest`);
    eq(thread.messageCount, thread.messages.length, `${thread.title}: count matches what is served`);
    for (const m of thread.messages) {
      assert(typeof m.text === 'string' && m.text.length > 0, 'every message has text');
      assert(['me', 'agent', 'system'].includes(m.from), `unknown sender ${m.from}`);
    }
  }
});

await check('the API states that no model runtime is configured', async () => {
  const { runtime } = await threadsOf();
  eq(runtime.configured, false, 'this gateway has no model runtime');
  eq(runtime.generatesReplies, false, 'and it must not claim to generate replies');
  assert(/no reply is generated/i.test(runtime.note), `the note must say so plainly, got “${runtime.note}”`);
});

/* ---------- 2. a write is stored once and answered with nothing ---------- */
await check('sending a message stores exactly one row and returns no reply', async () => {
  const { threads } = await threadsOf();
  const target = threads[0];
  const before = target.messageCount;
  const res = await owner.request(`/api/v1/threads/${target.id}/messages`, {
    method: 'POST', csrf: true, body: { text: 'Please summarise the vendor crawl.' },
  });
  eq(res.status, 201, `POST message (${res.text})`);
  eq(res.body.message.text, 'Please summarise the vendor crawl.', 'the stored text is what was sent');
  eq(res.body.message.from, 'me', 'the sender is the signed-in principal');
  eq(res.body.runtime.configured, false, 'the write response repeats the runtime fact');
  assert(!('reply' in res.body) && !('answer' in res.body), 'the write response must not carry an invented reply');

  const after = await threadById(target.id);
  eq(after.messageCount, before + 1, 'exactly one message was appended — nothing else appeared');
  eq(after.messages.at(-1).text, 'Please summarise the vendor crawl.', 'the new message is last');
});

await check('a retried write with the same clientId stores one message', async () => {
  const { threads } = await threadsOf();
  const target = threads[0];
  const before = (await threadById(target.id)).messageCount;
  const key = `retry-${Date.now()}`;
  const first = await owner.request(`/api/v1/threads/${target.id}/messages`, { method: 'POST', csrf: true, body: { text: 'send once', clientId: key } });
  eq(first.status, 201, `first write (${first.text})`);
  eq(first.body.duplicate, false, 'the first write is new');
  const second = await owner.request(`/api/v1/threads/${target.id}/messages`, { method: 'POST', csrf: true, body: { text: 'send once', clientId: key } });
  eq(second.status, 200, 'the retry is accepted but recognised');
  eq(second.body.duplicate, true, 'and reported as a duplicate');
  eq(second.body.message.id, first.body.message.id, 'the same row comes back');
  eq((await threadById(target.id)).messageCount, before + 1, 'the transcript holds one message, not two');
});

await check('a request body cannot claim an agent said something', async () => {
  const { threads } = await threadsOf();
  const target = threads[0];
  const before = (await threadById(target.id)).messageCount;
  const res = await owner.request(`/api/v1/threads/${target.id}/messages`, {
    method: 'POST', csrf: true,
    body: { text: 'The deploy passed every check.', from: 'agent' },
  });
  eq(res.status, 400, 'an agent message without a runtime must be refused');
  assert(/runtime/i.test(res.body.error), `the refusal must name the reason, got “${res.body.error}”`);
  eq((await threadById(target.id)).messageCount, before, 'a refused write changes nothing');
});

await check('an empty message is refused instead of stored', async () => {
  const { threads } = await threadsOf();
  const target = threads[0];
  const before = (await threadById(target.id)).messageCount;
  eq((await owner.request(`/api/v1/threads/${target.id}/messages`, { method: 'POST', csrf: true, body: { text: '   ' } })).status, 400, 'blank text');
  eq((await owner.request(`/api/v1/threads/${target.id}/messages`, { method: 'POST', csrf: true, body: {} })).status, 400, 'missing text');
  eq((await threadById(target.id)).messageCount, before, 'nothing was stored');
});

await check('a long message is capped, not silently truncated into a half sentence', async () => {
  const { threads } = await threadsOf();
  const target = threads[0];
  const long = `${'x'.repeat(9000)}`;
  const res = await owner.request(`/api/v1/threads/${target.id}/messages`, { method: 'POST', csrf: true, body: { text: long } });
  eq(res.status, 201, 'a long message is still accepted');
  eq(res.body.message.text.length, 8000, 'the stored length is the documented cap');
});

/* ---------- 3. threads ---------- */
await check('a new thread is persisted and starts empty', async () => {
  const res = await owner.request('/api/v1/threads', { method: 'POST', csrf: true, body: { title: 'Nightly triage' } });
  eq(res.status, 201, `POST /threads (${res.text})`);
  eq(res.body.thread.title, 'Nightly triage', 'the title is stored');
  eq(res.body.thread.messageCount, 0, 'a new thread has no messages');
  eq(res.body.runtime.configured, false, 'creating a thread does not imply a runtime');
  const again = await threadById(res.body.thread.id);
  eq(again.title, 'Nightly triage', 'it is readable straight away');
});

await check('a thread without a title is refused', async () => {
  eq((await owner.request('/api/v1/threads', { method: 'POST', csrf: true, body: { title: '  ' } })).status, 400, 'blank title');
});

await check('an unknown thread is a 404, not an empty conversation', async () => {
  eq((await owner.request('/api/v1/threads/th-nope')).status, 404, 'GET unknown thread');
  eq((await owner.request('/api/v1/threads/th-nope/messages', { method: 'POST', csrf: true, body: { text: 'hi' } })).status, 404, 'POST into unknown thread');
});

/* ---------- 4. unread ---------- */
await check('unread is a stored counter and only an explicit read mark clears it', async () => {
  const { threads } = await threadsOf();
  const target = threads.find((t) => t.unread > 0) || threads[0];
  // A system message raises the counter; the reader's own message does not.
  await owner.request(`/api/v1/threads/${target.id}/messages`, { method: 'POST', csrf: true, body: { text: 'read me', from: 'system' } });
  const raised = await threadById(target.id);
  eq(raised.unread, target.unread + 1, 'a message from someone else raises unread');

  const cleared = await owner.request(`/api/v1/threads/${target.id}/read`, { method: 'POST', csrf: true, body: {} });
  eq(cleared.status, 200, 'POST read');
  eq(cleared.body.cleared, target.unread + 1, 'the response says how many were cleared');
  eq((await threadById(target.id)).unread, 0, 'reading is explicit and idempotent');
  eq((await owner.request(`/api/v1/threads/${target.id}/read`, { method: 'POST', csrf: true, body: {} })).body.cleared, 0, 'a second read clears nothing');
});

/* ---------- 5. permissions ---------- */
await check('reading chat needs chat:read and writing needs chat:write', async () => {
  eq((await observer.request('/api/v1/threads')).status, 200, 'an Observer may read the transcript');
  const { threads } = await threadsOf();
  const target = threads[0];
  eq((await observer.request(`/api/v1/threads/${target.id}/messages`, { method: 'POST', csrf: true, body: { text: 'hi' } })).status, 403, 'an Observer may not write');
  eq((await observer.request('/api/v1/threads', { method: 'POST', csrf: true, body: { title: 'Observer thread' } })).status, 403, 'an Observer may not open a thread');
  eq((await observer.request(`/api/v1/threads/${target.id}`, { method: 'DELETE', csrf: true })).status, 403, 'an Observer may not delete a thread');
});

await check('a write without a CSRF token is refused', async () => {
  const { threads } = await threadsOf();
  const res = await owner.request(`/api/v1/threads/${threads[0].id}/messages`, { method: 'POST', body: { text: 'no csrf' } });
  eq(res.status, 403, 'mutations require the CSRF token');
});

/* ---------- 6. audit and privacy ---------- */
await check('messages are audited without their text', async () => {
  const row = db.prepare("SELECT * FROM audit_log WHERE event='chat.message' ORDER BY seq DESC LIMIT 1").get();
  assert(row, 'storing a message must be audited');
  assert(!/summarise the vendor crawl/i.test(row.args_redacted), 'the audit trail must not store message text');
  assert(/length/.test(row.args_redacted), 'it records the length instead');
});

await check('deleting a thread removes its messages and says how many', async () => {
  const created = await owner.request('/api/v1/threads', { method: 'POST', csrf: true, body: { title: 'Temporary' } });
  const id = created.body.thread.id;
  await owner.request(`/api/v1/threads/${id}/messages`, { method: 'POST', csrf: true, body: { text: 'one' } });
  await owner.request(`/api/v1/threads/${id}/messages`, { method: 'POST', csrf: true, body: { text: 'two' } });
  const del = await owner.request(`/api/v1/threads/${id}`, { method: 'DELETE', csrf: true });
  eq(del.status, 200, `DELETE (${del.text})`);
  eq(del.body.messagesDeleted, 2, 'the response counts the messages that went with it');
  eq((await owner.request(`/api/v1/threads/${id}`)).status, 404, 'the thread is gone');
  eq(db.prepare('SELECT COUNT(*) n FROM messages WHERE thread_id=?').get(id).n, 0, 'no orphan messages are left behind');
});

/* ---------- 7. persistence across a restart ---------- */
await check('the transcript survives a gateway restart', async () => {
  const { threads } = await threadsOf();
  const target = threads[0];
  const marker = `restart-marker-${Date.now()}`;
  await owner.request(`/api/v1/threads/${target.id}/messages`, { method: 'POST', csrf: true, body: { text: marker } });

  // Same DATA_DIR, fresh process state: close the listener and build a second gateway.
  await new Promise((resolve) => gateway.server.close(resolve));
  const { createGateway: createAgain } = await import('../apps/gateway/server.js');
  const second = createAgain();
  await new Promise((resolve) => second.server.listen(0, '127.0.0.1', resolve));
  const port = second.server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/api/v1/threads/${target.id}`, {
    headers: { cookie: Object.entries(owner.jar).map(([k, v]) => `${k}=${v}`).join('; ') },
  });
  const body = await res.json();
  eq(res.status, 200, `GET after restart (${JSON.stringify(body).slice(0, 120)})`);
  assert(body.thread.messages.some((m) => m.text === marker), 'the message written before the restart is still there');
  assert(body.thread.messages.every((m) => m.from === 'me' || m.from === 'agent' || m.from === 'system'),
    'and so is every sender');
  await new Promise((resolve) => second.server.close(resolve));
});

console.log(results.join('\n'));
console.log(`\nCHAT PERSISTENCE: ${results.length - failures} passed, ${failures} failed`);
if (failures) process.exitCode = 1;
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
