/* Copilot — the conversation is real, and the panel says which kind it is.
 * Run: npm run test:copilot:ui
 *
 * What is asserted (and what it protects):
 *   • with no gateway the panel says "demo", the mode tabs are still the honest way in, and every
 *     answer is labelled as having called no model;
 *   • with a gateway but no sealed key the panel says so *before* you type, a send is refused with the
 *     server's reason, and no assistant bubble is invented;
 *   • with a live model the reply appears with its provider, tokens, estimated cost and call id, and the
 *     mode tabs are gone — there is nothing to choose when you can just talk;
 *   • the transcript on screen is the gateway's, not this browser's;
 *   • Stop aborts the request instead of leaving a spinner;
 *   • clearing takes two steps and deletes on the server.
 */
import { Window } from 'happy-dom';

const results = [];
let failures = 0;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; results.push(`FAIL ${name}: ${error.message}`); console.log(`FAIL ${name}: ${error.message}`); }
}
const assert = (cond, message) => { if (!cond) throw new Error(message); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); };
const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

const win = new Window({ url: 'http://localhost:5173/#/home' });
for (const k of ['document', 'navigator', 'location', 'localStorage', 'history', 'HTMLElement',
  'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame', 'Blob']) {
  const value = win[k] ?? win;
  try { Object.defineProperty(globalThis, k, { value, configurable: true, writable: true }); } catch { try { globalThis[k] = value; } catch { /* frozen */ } }
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
const api = await import('../src/api.js');
const auth = await import('../src/auth.js');
const core = await import('../src/core.js');
const panel = await import('../src/copilot/panel.js');
const convo = await import('../src/copilot/conversation.js');

// Every query is scoped to the *live* panel: closing animates a decorative clone of the panel into the
// body, and a document-wide query would read the ghost's stale text instead of the app's.
const q = (sel) => win.document.querySelector('#copilot-panel')?.querySelector(sel) || null;
const msgs = () => [...(win.document.querySelector('#copilot-panel')?.querySelectorAll('.cp-msg') || [])].map((el) => ({
  bot: el.classList.contains('bot'),
  text: text(el.querySelector('.cp-bubble')),
  meta: text(el.querySelector('.cp-msg-meta')),
  callId: el.getAttribute('data-call-id'),
  failed: el.classList.contains('failed'),
}));

async function openPanel() {
  panel.openCopilot();
  await sleep(60);
  return q('#copilot-panel');
}
async function closePanel() {
  panel.closeCopilot();
  await sleep(20);
}
async function say(value) {
  const input = q('#copilot-input');
  assert(input, 'the composer exists');
  input.value = value;
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  q('#cp-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(260);
}

/* ---------- 1. no gateway: demo, and it says so ---------- */
await check('without a gateway the panel is local mode and labels every answer', async () => {
  panel.resetCopilotSession();
  await openPanel();
  eq(panel.copilotState().source, 'local', 'the panel reports a local answer source');
  eq(panel.copilotState().gatewayState, 'no-gateway', 'and that there is no gateway');
  eq(q('#cp-modes').dataset.live, 'false', 'mode tabs stay: they are the only honest way in');
  assert(q('#cp-modes [data-cp="mode"]'), 'the tabs are rendered');
  await say('what can you do?');
  await sleep(400);
  const list = msgs();
  const bot = list.filter((m) => m.bot).at(-1);
  assert(bot, 'the deterministic engine answered');
  assert(/no model called/i.test(bot.meta), `the answer says it called no model (got “${bot.meta}”)`);
  assert(!/call #/.test(bot.meta), 'and claims no ledger id');
});

/* ---------- 2. gateway, no key ---------- */
const GW = 'http://copilot.test';
const live = {
  configured: false,
  conversationId: 'cp-1',
  rows: [],
  calls: [],
};
function resetLive() {
  live.configured = false;
  live.conversationId = 'cp-1';
  live.rows = [{ id: 'r-1', role: 'user', text: 'An older question', ts: Date.now() - 5000, modelCallId: null, payload: {} }];
  live.calls = [];
}
const runtimeOff = () => ({
  configured: false,
  providerId: null,
  providerName: '',
  model: '',
  reason: 'No provider has a sealed key on this gateway, so the Copilot cannot answer.',
  code: 'no-model',
  streaming: false,
  costBasis: 'estimated',
  note: 'Replies are refused rather than faked: nothing is sent to a provider until an Owner installs a key.',
});

function stubGateway(overrides = {}) {
  live.calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(GW, '');
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    live.calls.push({ path, method, body });
    const json = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/v1/auth/session') {
      return json(200, { principal: { id: 'pr-1', name: 'Owner', role: 'Owner' }, permissions: ['read', 'copilot:read', 'copilot:write'], csrfToken: 'csrf' });
    }
    if (path === '/api/v1/agents') return json(200, []);
    if (path === '/api/v1/tasks') return json(200, []);
    if (path === '/api/v1/approvals') return json(200, []);
    if (path.startsWith('/api/v1/events')) return json(200, []);
    if (path === '/api/v1/teams') return json(200, { teams: [], unassigned: 0, totalAgents: 0 });
    if (path === '/api/v1/copilot/runtime') return json(200, { runtime: runtimeOff(), model: null, gateway: {} });
    if (path === '/api/v1/copilot' && method === 'GET') {
      if (overrides.listStatus) return json(overrides.listStatus, { error: 'not found' });
      return json(200, {
        conversation: { id: live.conversationId, createdAt: 1, updatedAt: 2 },
        messages: live.rows,
        runtime: live.configured ? runtimeOn() : runtimeOff(),
      });
    }
    if (path === '/api/v1/copilot/messages' && method === 'POST') {
      if (overrides.sendStatus) return json(overrides.sendStatus, { error: overrides.sendError || 'refused', code: overrides.sendCode || 'error', runtime: runtimeOff() });
      if (overrides.hang) return new Promise(() => {});
      if (!live.configured) {
        const row = { id: `r-${live.rows.length + 1}`, role: 'user', text: body.text, ts: Date.now(), modelCallId: null, payload: {} };
        live.rows.push(row);
        return json(409, {
          error: 'No model can answer yet: no provider has a sealed key on this gateway. Nothing was sent to a provider; your message was stored.',
          code: 'no-model',
          runtime: runtimeOff(),
        });
      }
      const user = { id: `r-${live.rows.length + 1}`, role: 'user', text: body.text, ts: Date.now(), modelCallId: null, payload: {} };
      const replyRow = {
        id: `r-${live.rows.length + 2}`, role: 'assistant', text: 'Here is what I can actually do.', ts: Date.now() + 1,
        modelCallId: 42,
        payload: { model: 'test-model', promptTokens: 120, completionTokens: 30, costUsd: 0.0021, costBasis: 'estimated', latencyMs: 640, callId: 42 },
      };
      live.rows.push(user, replyRow);
      return json(200, {
        userMessage: user,
        reply: replyRow,
        usage: { ...replyRow.payload },
        conversation: { id: live.conversationId },
        runtime: runtimeOn(),
      });
    }
    if (path === '/api/v1/copilot' && method === 'DELETE') {
      const cleared = live.rows.length;
      live.rows = [];
      return json(200, { cleared });
    }
    return json(404, { error: 'not found' });
  };
}
function runtimeOn() {
  return {
    configured: true, providerId: 'pv-1', providerName: 'Local provider', model: 'test-model',
    reason: '', code: 'ready', streaming: false, costBasis: 'estimated',
    note: 'Replies come from a real provider through the gateway. Cost is an estimate from a price table.',
  };
}

await check('with a gateway but no key, the panel says so, answers locally, and calls no model', async () => {
  api.setGatewayUrl(GW);
  resetLive();
  stubGateway();
  await auth.refreshSession({ silent: true });
  panel.resetCopilotSession();
  await openPanel();
  await sleep(140);
  eq(panel.copilotState().source, 'local', 'no model answers, so the source is local');
  eq(panel.copilotState().gatewayState, 'unready', 'and the gateway says why');
  eq(q('#cp-modes').dataset.live, 'false', 'the mode tabs stay: the built-in engine is what replies');
  assert(q('#cp-modes [data-cp="mode"]'), 'the tabs are rendered');
  const notice = q('.cp-notice.warn');
  assert(notice, 'a notice explains the situation before anything is said');
  eq(notice.getAttribute('data-cp-source'), 'unready', 'and names the state');
  assert(/no provider has a sealed key/i.test(text(notice)), `it names the cause (got “${text(notice)}”)`);
  assert(/no model is called/i.test(text(notice)), 'and says no model is called');
  assert(/stay in this browser/i.test(text(notice)), 'and where the conversation lives');
  const before = live.calls.length;
  await say('are you there?');
  await sleep(400);
  const bot = msgs().filter((m) => m.bot).at(-1);
  assert(bot, 'the built-in engine answered');
  assert(/no model called/i.test(bot.meta), `and its answer says so (got “${bot.meta}”)`);
  assert(!live.calls.some((c) => c.path === '/api/v1/copilot/messages'), 'nothing was posted for a model that does not exist');
  assert(live.calls.length >= before, 'the gateway was asked for its runtime, not sent a turn');
});

await check('the transcript shown is the gateway’s, not this browser’s', async () => {
  resetLive();
  live.configured = true;
  stubGateway();
  panel.resetCopilotSession();
  await openPanel();
  await sleep(120);
  const list = msgs();
  assert(list.some((m) => m.text.includes('An older question')), 'the stored turn is on screen');
  eq(panel.copilotState().messages, live.rows.length, 'one bubble per stored row');
});

/* ---------- 3. live model ---------- */
await check('a live turn shows provider, tokens, estimated cost and the call id — and no mode tabs', async () => {
  resetLive();
  live.configured = true;
  stubGateway();
  panel.resetCopilotSession();
  await openPanel();
  await sleep(140);
  eq(panel.copilotState().source, 'live', 'the panel is live');
  eq(panel.copilotState().gatewayState, 'ready', 'because a provider with a sealed key resolves');
  assert(!q('.cp-notice.warn'), 'no warning when a model can answer');
  eq(q('#cp-modes').dataset.live, 'true', 'the mode row is a runtime statement');
  const chips = text(q('#cp-modes'));
  assert(/test-model/.test(chips), `the model is named (got "${chips}")`);
  assert(/cost estimated/.test(chips), 'and the cost basis is stated');
  await say('what can you actually do?');
  await sleep(200);
  const list = msgs();
  const bot = list.filter((m) => m.bot).at(-1);
  eq(bot.text, 'Here is what I can actually do.', 'the reply is the provider’s text');
  eq(bot.callId, '42', 'the bubble carries the ledger id');
  assert(/120 in \/ 30 out/.test(bot.meta), `tokens are shown (got “${bot.meta}”)`);
  assert(/\$0\.0021 est\./.test(bot.meta), `estimated cost is shown (got “${bot.meta}”)`);
  assert(/call #42/.test(bot.meta), 'and the call id is in the provenance line');
  const post = live.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/copilot/messages');
  eq(post.body.text, 'what can you actually do?', 'exactly the typed text was sent');
  assert(!('mode' in post.body), 'no mode is sent — the server does not take one');
});

await check('the panel never writes an answer the server did not return', async () => {
  resetLive();
  live.configured = true;
  stubGateway({ sendStatus: 502, sendError: 'the provider did not answer', sendCode: 'bad-gateway' });
  panel.resetCopilotSession();
  await openPanel();
  await sleep(140);
  await say('this one fails upstream');
  await sleep(150);
  const bot = msgs().filter((m) => m.bot).at(-1);
  eq(bot.failed, true, 'the failure is marked');
  assert(/the provider did not answer/.test(bot.text), `the server’s words are shown (got “${bot.text}”)`);
  eq(panel.copilotState().modelCallIds.length, 0, 'no call id is claimed');
});

await check('Stop aborts the request instead of leaving a spinner', async () => {
  resetLive();
  live.configured = true;
  stubGateway({ hang: true });
  panel.resetCopilotSession();
  await openPanel();
  await sleep(140);
  const before = panel.copilotState().messages;
  await say('a long one');
  await sleep(80);
  eq(panel.copilotState().pending, true, 'it is waiting');
  eq(panel.copilotState().pendingLabel, 'Waiting for the model…', 'and says what it is waiting for');
  const stop = q('[data-cp="stop"]');
  assert(stop, 'a Stop control is offered');
  stop.dispatchEvent(new win.Event('click', { bubbles: true }));
  await sleep(120);
  eq(panel.copilotState().pending, false, 'the wait is over');
  eq(panel.copilotState().messages, before + 2, 'a stop note is added, and nothing else');
  const bot = msgs().filter((m) => m.bot).at(-1);
  assert(/stopped/i.test(bot.text), `and it says it stopped (got “${bot.text}”)`);
});

await check('clearing takes two steps and deletes on the server', async () => {
  resetLive();
  live.configured = true;
  stubGateway();
  panel.resetCopilotSession();
  await openPanel();
  await sleep(140);
  const clear = q('[data-cp="new-conversation"]');
  assert(clear, 'the control exists on a live conversation');
  clear.dispatchEvent(new win.Event('click', { bubbles: true }));
  await sleep(60);
  assert(!live.calls.some((c) => c.method === 'DELETE'), 'one tap does not delete anything');
  assert(/cannot be undone/i.test(text(q('#copilot-work'))), 'it asks first');
  const confirm = q('[data-cp="new-conversation"]');
  confirm.dispatchEvent(new win.Event('click', { bubbles: true }));
  await sleep(120);
  assert(live.calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/copilot'), 'the second tap deletes on the gateway');
  eq(panel.copilotState().messages, 0, 'and the transcript is empty');
});

await check('a gateway without the Copilot routes is reported, not guessed at', async () => {
  api.setGatewayUrl(GW);
  resetLive();
  stubGateway({ listStatus: 404 });
  panel.resetCopilotSession();
  await openPanel();
  await sleep(160);
  eq(panel.copilotState().gatewayState, 'unavailable', 'the panel says the route is missing');
  eq(panel.copilotState().source, 'local', 'and falls back to the built-in engine');
  const notice = q('.cp-notice.warn');
  assert(/no Copilot conversation route/i.test(text(notice)), `it says exactly that (got “${text(notice)}”)`);
  await closePanel();
  api.setGatewayUrl('');
  convo.reset();
});

await closePanel();
console.log(`\nCOPILOT UI: ${results.filter((r) => r.startsWith('PASS')).length} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
