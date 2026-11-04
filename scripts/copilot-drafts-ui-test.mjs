/* Copilot agent drafts in the panel — a card with a state, an approval gate, and no shortcuts.
 * Run: npm run test:drafts:ui
 *
 * What is asserted (and what it protects):
 *   • "create an agent that …" becomes a draft card with the server's state and findings, not a chat bubble;
 *   • a question about agents is NOT turned into a draft;
 *   • the state shown is the canonical one, and the card says activation cannot run anything;
 *   • Submit is offered only when the row says it can be submitted, and it goes to the gate;
 *   • an awaiting draft offers Activate only to a role that holds agent:write;
 *   • a refusal from the gateway is shown in the card, replacing nothing optimistically;
 *   • the builder opens seeded from the draft, and saving writes back to the same draft.
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
const panel = await import('../src/copilot/panel.js');
const designer = await import('../src/designer.js');
const convo = await import('../src/copilot/conversation.js');

const q = (sel) => win.document.querySelector('#copilot-panel')?.querySelector(sel) || null;
const card = () => q('.cp-draft');
const cardText = () => text(card());

const GW = 'http://drafts.test';
const SPEC = {
  name: 'Ticket Triage', role: 'triages inbound tickets', description: 'Sorts support mail.',
  goal: 'Label and route every inbound ticket within a minute.', framework: 'LangGraph',
  model: 'anthropic/claude-sonnet-4', fallback: 'openai/gpt-5', autonomy: 2, preset: 'review-first',
  limits: { steps: 10, minutes: 5, costUsd: 1 }, gates: { enabled: true, expiry: '30d' },
  skills: [], plugins: [], interaction: ['text'], responsibilities: ['label'],
};
const FINDINGS = [
  { id: 'd1', field: 'framework', severity: 'blocked', title: 'No runtime adapter', detail: 'Nothing here can execute a LangGraph agent.' },
  { id: 'd2', field: 'model', severity: 'setup', title: 'Anthropic has no sealed key', detail: 'An Owner has to install one.' },
];

const state = { role: 'Owner', calls: [], response: null };
function draftRow(over = {}) {
  return {
    id: 'dr-1', state: 'needs-setup', stateLabel: 'Needs setup', source: 'copilot', spec: SPEC, findings: FINDINGS,
    approvalId: null, agentId: null, modelCallId: 7, createdAt: 1, updatedAt: 2, canSubmit: true, canRun: false,
    ...over,
  };
}

function stubGateway(overrides = {}) {
  state.calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(GW, '');
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    state.calls.push({ path, method, body });
    const json = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/v1/auth/session') {
      return json(200, {
        principal: { id: 'pr-1', name: 'Owner', role: state.role },
        permissions: ['read', 'copilot:read', 'copilot:write', 'agent:write', ...(state.role === 'Reviewer' ? ['approval:decide'] : [])],
        csrfToken: 'csrf',
      });
    }
    if (path === '/api/v1/agents') return json(200, []);
    if (path === '/api/v1/tasks') return json(200, []);
    if (path === '/api/v1/approvals') return json(200, []);
    if (path.startsWith('/api/v1/events')) return json(200, []);
    if (path === '/api/v1/teams') return json(200, { teams: [], unassigned: 0, totalAgents: 0 });
    if (path === '/api/v1/copilot' && method === 'GET') {
      return json(200, {
        conversation: { id: 'cp-1', createdAt: 1 },
        messages: [],
        runtime: {
          configured: true, providerId: 'pv-anthropic', providerName: 'Anthropic', model: 'test-model',
          reason: '', code: 'ready', streaming: false, costBasis: 'estimated', note: 'Cost is estimated.',
        },
      });
    }
    if (path === '/api/v1/copilot/drafts' && method === 'GET') return json(200, { drafts: [draftRow()] });
    if (path === '/api/v1/copilot/drafts' && method === 'POST') {
      if (overrides.draftStatus) return json(overrides.draftStatus, { error: overrides.error || 'refused', code: 'error' });
      const user = { id: 'r-1', role: 'user', text: body.text, ts: Date.now(), modelCallId: null, payload: {} };
      const reply = { id: 'r-2', role: 'assistant', text: 'I drafted “Ticket Triage”. State: Needs setup.', ts: Date.now() + 1, modelCallId: 7, payload: { model: 'test-model', promptTokens: 300, completionTokens: 90, costUsd: 0.002, latencyMs: 500, callId: 7 } };
      return json(201, { draft: draftRow(), usage: reply.payload, userMessage: user, reply });
    }
    if (/\/api\/v1\/copilot\/drafts\/[^/]+\/submit$/.test(path) && method === 'POST') {
      if (overrides.submitStatus) return json(overrides.submitStatus, { error: overrides.submitError || 'refused', code: 'conflict' });
      return json(200, draftRow({ state: 'awaiting-approval', stateLabel: 'Awaiting approval', canSubmit: false, approvalId: 'ap-1' }));
    }
    if (/\/api\/v1\/copilot\/drafts\/[^/]+\/activate$/.test(path) && method === 'POST') {
      if (overrides.activateStatus) return json(overrides.activateStatus, { error: overrides.activateError || 'refused', code: 'conflict' });
      return json(201, { draft: draftRow({ state: 'active', stateLabel: 'Active', canSubmit: false, agentId: 'ag-1' }), agent: { id: 'ag-1', name: 'Ticket Triage' } });
    }
    if (/\/api\/v1\/copilot\/drafts\/[^/]+$/.test(path) && method === 'PATCH') {
      return json(200, { draft: draftRow({ state: 'ready-for-review', stateLabel: 'Ready for review' }) });
    }
    return json(404, { error: 'not found' });
  };
}

async function openWith(overrides = {}) {
  api.setGatewayUrl(GW);
  stubGateway(overrides);
  await auth.refreshSession({ silent: true });
  panel.resetCopilotSession();
  panel.openCopilot();
  await sleep(200);
  // go live: the panel derives its source from the conversation state
  q('[data-cp="toggle-advanced"]')?.dispatchEvent(new win.Event('click', { bubbles: true }));
  await sleep(80);
  return q('#copilot-panel');
}
async function say(value) {
  const input = q('#copilot-input');
  assert(input, 'the composer exists');
  input.value = value;
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  q('#cp-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(300);
}

/* ---------- 1. a question is not a draft ---------- */
await check('a question about agents stays a chat turn, not a draft', async () => {
  await openWith();
  eq(panel.copilotState().source, 'live', 'the panel is live');
  await say('How do agents work here?');
  const draftCalls = state.calls.filter((c) => c.path === '/api/v1/copilot/drafts' && c.method === 'POST');
  eq(draftCalls.length, 0, 'no draft was requested');
  await panel.closeCopilot();
});

/* ---------- 2. a request becomes a draft card ---------- */
await check('“create an agent that …” produces a draft card with the server’s state and findings', async () => {
  await openWith();
  await say('Create an agent that triages inbound tickets');
  const call = state.calls.find((c) => c.path === '/api/v1/copilot/drafts' && c.method === 'POST');
  assert(call, 'the draft route was called');
  eq(call.body.text, 'Create an agent that triages inbound tickets', 'with the sentence that was typed');
  assert(card(), 'a draft card is rendered');
  eq(card().getAttribute('data-draft-state'), 'needs-setup', 'carrying the row’s state');
  const body = cardText();
  assert(/Ticket Triage/.test(body), `the name is shown (got “${body}”)`);
  assert(/Needs setup/.test(body), 'the canonical state label is shown');
  assert(/No runtime adapter/.test(body), 'the blocking finding is shown');
  assert(/cannot be executed|no runtime in this build/i.test(body), 'and the card says running is impossible');
  assert(!/drafted/i.test(text(q('.cp-msg.bot .cp-bubble')) || ''), 'the summary text is not passed off as an agent');
});

await check('Submit is offered because the row says it can be submitted', async () => {
  const submit = q('[data-cp="draft-submit"]');
  assert(submit, 'the submit control exists');
  eq(submit.getAttribute('data-draft'), 'dr-1', 'it is scoped to the draft');
  assert(!q('[data-cp="draft-activate"]'), 'activation is not offered before approval');
});

await check('submitting goes to the gate and the card says who must decide', async () => {
  q('[data-cp="draft-submit"]').dispatchEvent(new win.Event('click', { bubbles: true }));
  await sleep(250);
  const call = state.calls.find((c) => /\/submit$/.test(c.path));
  assert(call, 'the submit route was called');
  eq(card().getAttribute('data-draft-state'), 'awaiting-approval', 'the card shows the new state');
  const body = cardText();
  assert(/Waiting for a decision on the Approvals screen/.test(body), `the gate is named (got “${body}”)`);
  assert(/cannot approve your own draft/.test(body), 'and self-approval is stated, not implied');
});

await check('an awaiting draft offers Activate to a role that holds agent:write', async () => {
  const activate = q('[data-cp="draft-activate"]');
  assert(activate, 'activation is offered');
  activate.dispatchEvent(new win.Event('click', { bubbles: true }));
  await sleep(250);
  const call = state.calls.find((c) => /\/activate$/.test(c.path));
  assert(call, 'the activate route was called');
  eq(card().getAttribute('data-draft-state'), 'active', 'the card is active');
  assert(/idle agent/i.test(cardText()), 'and says an idle definition was created, nothing started');
  assert(q('[data-cp="draft-open-agent"]'), 'the agent can be opened');
});

await check('a refusal is shown in the card and changes nothing else', async () => {
  await openWith({ activateStatus: 403, activateError: 'the approval for this draft was decided by you, and activation by the same principal is refused' });
  await say('Create an agent that answers the phone');
  q('[data-cp="draft-submit"]')?.dispatchEvent(new win.Event('click', { bubbles: true }));
  await sleep(200);
  q('[data-cp="draft-activate"]')?.dispatchEvent(new win.Event('click', { bubbles: true }));
  await sleep(250);
  const body = cardText();
  assert(/decided by you/.test(body), `the server’s refusal is shown verbatim (got “${body}”)`);
  eq(card().getAttribute('data-draft-state'), 'awaiting-approval', 'the state did not move past what the server returned');
});

/* ---------- 3. the builder sync ---------- */
await check('opening the builder seeds it from the draft and remembers the draft id', async () => {
  await openWith();
  await say('Create an agent that triages inbound tickets');
  q('[data-cp="draft-open-designer"]').dispatchEvent(new win.Event('click', { bubbles: true }));
  await sleep(400);
  const d = designer.getDraft();
  eq(d.name, 'Ticket Triage', 'the builder is seeded with the draft’s name');
  eq(d.goal, SPEC.goal, 'and its goal');
  eq(d.sourceId, 'dr-1', 'and remembers which draft it is editing');
  assert((d.assumptions || []).some((a) => /Copilot draft/.test(a)), 'and says where the fields came from');
});

await check('saving from the builder writes back to the same draft instead of creating an agent', async () => {
  const before = state.calls.length;
  const out = await designer.saveDefinition();
  await sleep(150);
  const patch = state.calls.slice(before).find((c) => c.method === 'PATCH' && /\/api\/v1\/copilot\/drafts\/dr-1$/.test(c.path));
  assert(patch, 'the draft was patched');
  const agentCreates = state.calls.slice(before).filter((c) => c.path === '/api/v1/agents' && c.method === 'POST');
  eq(agentCreates.length, 0, 'no agent was created behind the gate');
  assert(out.ok, `the save reported success (got ${JSON.stringify(out)})`);
  eq(out.mode, 'draft', 'and says it saved the draft');
});

/* ---------- 4. a role without agent:write is not offered activation ---------- */
await check('a reload rebuilds the draft card from the draft the gateway holds', async () => {
  // The transcript comes back with `draftId` in the message payload; the card is re-attached from
  // GET /copilot/drafts, so a reloaded panel shows the draft as a draft, not as a paragraph of text.
  const listStub = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    // Path only: the test host is `drafts.test`, and matching the full URL made `!includes('/drafts')`
    // silently false — which is exactly the kind of thing this suite exists to catch.
    const path = new URL(String(url)).pathname;
    if (path === '/api/v1/copilot' && (init.method || 'GET') === 'GET') {
      return new Response(JSON.stringify({
        conversation: { id: 'cp-1', createdAt: 1 },
        messages: [
          { id: 'r-1', role: 'user', text: 'Create an agent that triages inbound tickets', ts: 1, modelCallId: null, payload: {} },
          { id: 'r-2', role: 'assistant', text: 'I drafted “Ticket Triage”. State: Needs setup.', ts: 2, modelCallId: 7, payload: { draftId: 'dr-1' } },
        ],
        runtime: { configured: true, providerId: 'pv-anthropic', providerName: 'Anthropic', model: 'test-model', reason: '', code: 'ready', streaming: false, costBasis: 'estimated', note: '' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return listStub(url, init);
  };
  panel.resetCopilotSession();
  panel.openCopilot();
  await sleep(900);
  assert(card(), 'the card came back after the reload');
  eq(card().getAttribute('data-draft-state'), 'needs-setup', 'with the live state, not a remembered one');
  assert(/Ticket Triage/.test(cardText()), 'and its name');
  globalThis.fetch = listStub;
  await panel.closeCopilot();
});

await check('a Reviewer is not offered Activate, because activation needs agent:write', async () => {
  state.role = 'Reviewer';
  await openWith();
  await say('Create an agent that triages inbound tickets');
  eq(panel.copilotState().source, 'live', 'still live');
  eq(q('[data-cp="draft-activate"]'), null, 'no activate control');
  state.role = 'Owner';
  await panel.closeCopilot();
});

await check('with no gateway the panel says there is no draft route rather than faking one', async () => {
  api.setGatewayUrl('');
  convo.reset();
  panel.resetCopilotSession();
  panel.openCopilot();
  await sleep(120);
  const st = panel.copilotState();
  eq(st.source, 'local', 'the built-in engine answers');
  eq(st.gatewayState, 'no-gateway', 'and there is no gateway');
  eq(card(), null, 'no draft card exists');
  await panel.closeCopilot();
});

console.log(`\nDRAFTS UI: ${results.filter((r) => r.startsWith('PASS')).length} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
