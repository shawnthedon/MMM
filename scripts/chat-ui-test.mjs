/* Chat — the transcript is real, and nothing pretends to answer.
 * Run: npm run test:chat:ui
 *
 * What is asserted (and what it protects):
 *   • the canned replies are gone from the source, not merely hidden;
 *   • the screen states, from state, that no model runtime exists — in demo and in gateway mode;
 *   • a send posts exactly the text that was typed and no reply appears afterwards, however long
 *     the test waits;
 *   • a failed write keeps the text in the box and adds no message;
 *   • opening a thread with unread messages marks it read through the gateway;
 *   • a new conversation is created on the gateway and its first message stored;
 *   • a gateway that serves no transcript is reported as such instead of showing demo rows as live.
 */
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const viewsSrc = readFileSync(join(root, 'src/views2.js'), 'utf8');

const results = [];
let failures = 0;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); console.log(`PASS ${name}`); } catch (error) { failures += 1; results.push(`FAIL ${name}: ${error.message}`); console.log(`FAIL ${name}: ${error.message}`); }
}
const assert = (cond, message) => { if (!cond) throw new Error(message); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); };
const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

/* ---------- 1. the lie is deleted, not hidden ---------- */
await check('no canned reply survives in the source', () => {
  assert(!/simulateReply/.test(viewsSrc), 'simulateReply must be deleted, not gated');
  assert(!/Estimated cost: \$0\.42/.test(viewsSrc), 'the invented cost is gone');
  assert(!/Good call — dispatching as a task/.test(viewsSrc), 'the canned sentences are gone');
});

/* ---------- 2. harness ---------- */
const win = new Window({ url: 'http://localhost:5173/#/chat' });
for (const k of ['document', 'navigator', 'location', 'localStorage', 'history', 'HTMLElement',
  'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame', 'Blob']) {
  const value = win[k] ?? win;
  try { Object.defineProperty(globalThis, k, { value, configurable: true, writable: true }); } catch { try { globalThis[k] = value; } catch {} }
}
globalThis.window = win;
globalThis.document = win.document;
globalThis.localStorage = win.localStorage;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
win.matchMedia = globalThis.matchMedia;
win.document.body.innerHTML = '<div id="app"><div id="view"></div><div id="sheet-root"></div><div id="toast-root"></div></div>';
globalThis.fetch = async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });

await import('../src/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(140);
const nav = await import('../src/main.js');
const core = await import('../src/core.js');
const api = await import('../src/api.js');
const auth = await import('../src/auth.js');
const store = await import('../src/datastore.js');

const view = () => win.document.getElementById('view');
const state = () => core.getState();
const q = (sel) => view().querySelector(sel);

async function openChat() {
  nav.navigate('chat');
  await sleep(60);
}
const send = async (value) => {
  const input = q('#chat-input');
  assert(input, 'the composer must exist');
  input.value = value;
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(120);
};

/* ---------- 3. demo mode ---------- */
await check('demo mode says the transcript is local and nothing answers it', async () => {
  await openChat();
  const banner = q('[data-chat-runtime]');
  assert(banner, 'the runtime notice must be rendered');
  eq(banner.getAttribute('data-chat-runtime'), 'demo', 'the banner names the source honestly');
  eq(banner.getAttribute('data-replies'), 'no', 'and states that no replies are generated');
  assert(/no model runtime/i.test(text(banner)), `the banner says there is no runtime (got “${text(banner)}”)`);
  assert(/browser/i.test(text(banner)), 'and where the messages actually live');
});

await check('a demo send stores the message once and schedules no reply', async () => {
  await openChat();
  const before = (state().threads[0].messages || []).length;
  await send('hello from the demo');
  const after = (state().threads[0].messages || []).length;
  eq(after, before + 1, 'exactly one message was stored');
  eq(state().threads[0].messages.at(-1).text, 'hello from the demo', 'the stored text is what was typed');
  await sleep(2400); // longer than the old 0.9–1.8 s fake delay
  eq((state().threads[0].messages || []).length, after, 'nothing appeared afterwards: no reply is generated');
  assert(!(state().threads[0].messages || []).some((m) => m.from === 'agent' && m.text === 'hello from the demo'),
    'the message is never echoed back as an agent reply');
});

/* ---------- 4. gateway mode ---------- */
const GW = 'http://chat.test';
// A real transcript the stub appends to, so a refresh after a write reflects the write instead of
// rewinding the screen. `resetGateway()` restores it between cases.
const gatewayThreads = [{
  id: 'th-gw', kind: 'direct', title: 'Researcher-01', unread: 2, createdAt: 1,
  messageCount: 1, truncated: false,
  messages: [{ id: 'm-1', from: 'agent', agent: 'Researcher-01', text: 'The crawl finished: 20/20 vendors.', kind: 'text', payload: {}, ts: 2 }],
}];
const resetGateway = () => {
  gatewayThreads.splice(0, gatewayThreads.length, {
    id: 'th-gw', kind: 'direct', title: 'Researcher-01', unread: 2, createdAt: 1,
    messageCount: 1, truncated: false,
    messages: [{ id: 'm-1', from: 'agent', agent: 'Researcher-01', text: 'The crawl finished: 20/20 vendors.', kind: 'text', payload: {}, ts: 2 }],
  });
};
let calls = [];
let behaviour = {};
function stubGateway(overrides = {}) {
  behaviour = { threadsStatus: 200, sendStatus: 201, readStatus: 200, createStatus: 201, ...overrides };
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(GW, '');
    const method = init.method || 'GET';
    calls.push({ path, method, body: init.body ? JSON.parse(init.body) : null });
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/v1/auth/session') {
      return json(200, { principal: { id: 'pr-1', name: 'Owner', role: 'Owner' }, permissions: ['read', 'chat:read', 'chat:write'], csrfToken: 'csrf' });
    }
    if (path === '/api/v1/agents') return json(200, []);
    if (path === '/api/v1/tasks') return json(200, []);
    if (path === '/api/v1/approvals') return json(200, []);
    if (path.startsWith('/api/v1/events')) return json(200, []);
    if (path === '/api/v1/teams') return json(200, { teams: [], unassigned: 0, totalAgents: 0 });
    if (path === '/api/v1/threads' && method === 'GET') {
      if (behaviour.threadsStatus !== 200) return json(behaviour.threadsStatus, { error: 'not found' });
      return json(200, {
        threads: gatewayThreads.map((t) => ({ ...t, messageCount: t.messages.length })),
        runtime: {
          configured: false, driver: 'none', generatesReplies: false,
          note: 'No model runtime is configured on this gateway. Messages are stored; no reply is generated.',
        },
      });
    }
    if (/^\/api\/v1\/threads\/[^/]+\/messages$/.test(path) && method === 'POST') {
      if (behaviour.sendStatus !== 201) return json(behaviour.sendStatus, { error: 'gateway refused the message' });
      const text = init.body ? JSON.parse(init.body).text : '';
      const thread = gatewayThreads.find((t) => path.includes(t.id));
      if (thread) thread.messages.push({ id: 'm-new', from: 'me', agent: '', text, kind: 'text', payload: {}, ts: Date.now() });
      return json(201, {
        message: { id: 'm-new', from: 'me', agent: '', text, kind: 'text', payload: {}, ts: Date.now() },
        runtime: { configured: false, driver: 'none', generatesReplies: false, note: 'No model runtime is configured on this gateway. Messages are stored; no reply is generated.' },
      });
    }
    if (/^\/api\/v1\/threads\/[^/]+\/read$/.test(path) && method === 'POST') {
      const thread = gatewayThreads[0];
      const cleared = thread.unread;
      thread.unread = 0;
      return json(200, { id: thread.id, unread: 0, cleared });
    }
    if (path === '/api/v1/threads' && method === 'POST') {
      if (behaviour.createStatus !== 201) return json(behaviour.createStatus, { error: 'no title' });
      return json(201, {
        thread: { id: 'th-new', kind: 'direct', title: 'SRE-Bot', unread: 0, createdAt: 3, messages: [], messageCount: 0, truncated: false },
        runtime: { configured: false, generatesReplies: false, driver: 'none', note: 'No model runtime is configured on this gateway. Messages are stored; no reply is generated.' },
      });
    }
    return json(404, { error: 'not found' });
  };
}

await check('a live transcript is adopted with the gateway’s own runtime statement', async () => {
  api.setGatewayUrl(GW);
  resetGateway();
  stubGateway();
  await auth.refreshSession({ silent: true });
  const out = await store.refresh();
  eq(out.ok, true, `refresh failed: ${JSON.stringify(out)}`);
  eq(core.getProvenance().threads, 'gateway', 'threads are gateway-owned');
  eq(state().threads[0].messages[0].text, 'The crawl finished: 20/20 vendors.', 'the server transcript is what is shown');
  eq(state().chatRuntime.configured, false, 'the gateway says it has no model runtime');
  eq(state().chatRuntime.generatesReplies, false, 'and no replies are generated');

  await openChat();
  const banner = q('[data-chat-runtime]');
  eq(banner.getAttribute('data-chat-runtime'), 'gateway', 'the banner says the transcript is on the gateway');
  assert(/gateway transcript/i.test(text(banner)), `the banner names the source (got “${text(banner)}”)`);
  assert(/no reply is generated/i.test(text(banner)), 'the gateway note is shown verbatim');
});

await check('sending writes once through the gateway and still produces no reply', async () => {
  resetGateway();
  await store.refresh();
  await openChat();
  const before = state().threads[0].messages.length;
  calls = [];
  await send('stored on the gateway');
  const post = calls.find((c) => c.method === 'POST' && c.path === '/api/v1/threads/th-gw/messages');
  assert(post, 'the message must be sent to the gateway');
  eq(post.body.text, 'stored on the gateway', 'exactly the typed text is sent');
  eq(state().threads[0].messages.length, before + 1, 'one message was folded into the thread');
  eq(state().threads[0].messages.at(-1).from, 'me', 'it is the reader’s message, not an agent’s');
  await sleep(2400);
  eq(state().threads[0].messages.length, before + 1, 'no reply arrived afterwards — none is generated');
  assert(!calls.some((c) => /\/messages$/.test(c.path) && c.method === 'POST' && c !== post), 'the screen never re-posts to fake a reply');
});

await check('a failed write leaves the transcript unchanged and keeps the text', async () => {
  resetGateway();
  stubGateway({ sendStatus: 500 });
  await store.refresh();
  await openChat();
  const before = state().threads[0].messages.length;
  await send('this one will fail');
  eq(state().threads[0].messages.length, before, 'nothing was added locally');
  const input = q('#chat-input');
  eq(input.value, 'this one will fail', 'the text is still in the box so it is not lost');
  const toastRoot = win.document.getElementById('toast-root');
  assert(/refused the message|not stored/i.test(text(toastRoot) || ''), `the failure is stated, got “${text(toastRoot)}”`);
});

await check('opening a thread marks it read through the gateway', async () => {
  // Leave the chat route first: a re-render on the chat screen is itself a read receipt, and this
  // case is about the receipt that fires when the reader *arrives* at the thread.
  nav.navigate('home');
  await sleep(60);
  resetGateway();
  stubGateway();
  await store.refresh();
  eq(state().threads[0].unread, 2, 'the thread starts unread');
  calls = [];
  await openChat();
  await sleep(200);
  const read = calls.find((c) => c.method === 'POST' && c.path === '/api/v1/threads/th-gw/read');
  assert(read, 'the read receipt must go to the gateway, not just the local copy');
  eq(state().threads[0].unread, 0, 'the counter is cleared');
});

await check('a new conversation is created on the gateway and its first message stored', async () => {
  stubGateway();
  await store.refresh();
  await openChat();
  calls = [];
  const created = await store.createChatThread({ title: 'SRE-Bot' });
  eq(created.title, 'SRE-Bot', 'the created thread is returned');
  const post = calls.find((c) => c.method === 'POST' && c.path === '/api/v1/threads');
  assert(post, 'POST /threads must be issued');
  eq(post.body.title, 'SRE-Bot', 'with the title that was typed');
  assert(state().threads.some((t) => t.id === 'th-new'), 'the new thread is in state');
  const sent = await store.sendChatMessage('th-new', 'first');
  eq(sent.message.text, 'first', 'the stored row is the server’s copy');
});

await check('a gateway without the chat routes is reported, not faked', async () => {
  stubGateway({ threadsStatus: 404 });
  await auth.refreshSession({ silent: true });
  const out = await store.refresh();
  eq(out.ok, true, 'the rest of the refresh still succeeds');
  eq(core.getProvenance().threads, 'demo', 'chat stays on demo provenance');
  await openChat();
  const banner = q('[data-chat-runtime]');
  eq(banner.getAttribute('data-chat-runtime'), 'demo', 'the banner does not claim a gateway transcript');
  eq(banner.getAttribute('data-replies'), 'no', 'and never claims a reply');
});

/* ---------- 5. no fabricated activity anywhere in the view module ---------- */
await check('the view never invents a message from an agent', () => {
  assert(!/from: 'agent'/.test(viewsSrc), 'the view must not author agent messages');
  const start = viewsSrc.indexOf('async function sendChat');
  const end = viewsSrc.indexOf("on('chat-open',");
  const body = viewsSrc.slice(start, end);
  assert(start > 0, 'sendChat must exist');
  assert(!/setTimeout|Math\.random|setInterval/.test(body), 'a send schedules nothing and invents nothing');
});

console.log(`\nCHAT TRANSCRIPT: ${results.length - failures} passed, ${failures} failed`);
// The datastore keeps a live-socket retry timer; exit explicitly like the other UI suites.
process.exit(failures > 0 ? 1 : 0);
