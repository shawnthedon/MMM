/* Copilot swarm-plan drafts in the panel — a plan card with a state, a gate, and no shortcuts.
 * Run: npm run test:plans:ui
 *
 * What is asserted (and what it protects):
 *   • a question about swarms stays a question;
 *   • "draft a plan that …" produces a PLAN card, and does not also produce an agent draft;
 *   • "create a swarm of agents that …" is a plan, not one agent — the plan intent is checked first;
 *   • the card shows the server's state, the validator's findings, and that saving starts nothing;
 *   • Submit is offered only when the row says so, and it goes to the real gate;
 *   • Save-as-a-plan is offered only to a role that holds swarm:write, never to the Reviewer who decides;
 *   • a refusal is rendered verbatim and the card does not advance;
 *   • a reload rebuilds the plan card from the gateway's row (payload.draftKind), not from nothing.
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
const convo = await import('../src/copilot/conversation.js');

const q = (sel) => win.document.querySelector('#copilot-panel')?.querySelector(sel) || null;
const card = () => q('.cp-plan');
const cardText = () => text(card());

const GW = 'http://plans.test';
const PLAN = {
  v: 1,
  name: 'Weekly Brief',
  objective: 'Research this week’s AI news and draft a one-page brief.',
  teamId: null,
  channel: 'app',
  topology: 'Hierarchical',
  budgetCap: 6,
  nodes: [{ id: 'n1', label: 'planner' }, { id: 'n2', label: 'writer' }],
};
const FINDINGS = [
  { id: 'p1', field: 'execution', severity: 'blocked', title: 'Nothing executes this plan', detail: 'No scheduler and no worker exist in this build.' },
  { id: 'p2', field: 'budgetCap', severity: 'warning', title: 'Budget cap is zero', detail: 'The plan is saved with a cap of zero.' },
];

const state = { role: 'Owner', calls: [], response: null };
function planRow(over = {}) {
  return {
    id: 'pd-1', kind: 'swarm-plan', state: 'ready-for-review', stateLabel: 'Ready for review', source: 'copilot',
    plan: PLAN, findings: FINDINGS, approvalId: null, swarmId: null, modelCallId: 9,
    createdAt: 1, updatedAt: 2, canSubmit: true, canRun: false,
    ...over,
  };
}

const PERMS = {
  Owner: ['read', 'copilot:read', 'copilot:write', 'agent:write', 'swarm:write', 'approval:request', 'approval:decide'],
  Operator: ['read', 'copilot:read', 'copilot:write', 'swarm:write'],
  Reviewer: ['read', 'copilot:read', 'approval:request', 'approval:decide'],
};

function stubGateway(overrides = {}) {
  state.calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(GW, '');
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    state.calls.push({ path, method, body });
    const json = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/v1/auth/session') {
      return json(200, { principal: { id: 'pr-1', name: 'Owner', role: state.role }, permissions: PERMS[state.role] || PERMS.Owner, csrfToken: 'csrf' });
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
        runtime: { configured: true, providerId: 'pv-anthropic', providerName: 'Anthropic', model: 'test-model', reason: '', code: 'ready', streaming: false, costBasis: 'estimated', note: 'Cost is estimated.' },
      });
    }
    if (path === '/api/v1/copilot/plans' && method === 'GET') return json(200, { drafts: [planRow()] });
    if (path === '/api/v1/copilot/plans' && method === 'POST') {
      if (overrides.planStatus) return json(overrides.planStatus, { error: overrides.error || 'refused', code: 'error' });
      const user = { id: 'r-1', role: 'user', text: body.text, ts: Date.now(), modelCallId: null, payload: {} };
      const reply = {
        id: 'r-2', role: 'assistant', text: 'I drafted the plan “Weekly Brief”. State: Ready for review. Saving it stores a planned swarm and starts nothing.',
        ts: Date.now() + 1, modelCallId: 9,
        payload: { model: 'test-model', promptTokens: 280, completionTokens: 80, costUsd: 0.002, latencyMs: 500, callId: 9, draftId: 'pd-1', draftKind: 'swarm-plan' },
      };
      return json(201, { draft: planRow(overrides.createdRow || {}), usage: reply.payload, userMessage: user, reply });
    }
    if (/\/api\/v1\/copilot\/plans\/[^/]+\/submit$/.test(path) && method === 'POST') {
      if (overrides.submitStatus) return json(overrides.submitStatus, { error: overrides.submitError || 'refused', code: 'conflict' });
      return json(200, planRow({ state: 'awaiting-approval', stateLabel: 'Awaiting approval', canSubmit: false, approvalId: 'ap-9' }));
    }
    if (/\/api\/v1\/copilot\/plans\/[^/]+\/activate$/.test(path) && method === 'POST') {
      if (overrides.saveStatus) return json(overrides.saveStatus, { error: overrides.saveError || 'refused', code: 'conflict' });
      return json(201, { draft: planRow({ state: 'active', stateLabel: 'Active', canSubmit: false, swarmId: 'sw-weekly-brief' }), swarm: { id: 'sw-weekly-brief', status: 'planned', executed: false } });
    }
    if (/\/api\/v1\/copilot\/plans\/[^/]+\/archive$/.test(path) && method === 'POST') {
      return json(200, { draft: planRow({ state: 'archived', stateLabel: 'Archived' }) });
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
  await sleep(320);
}

/* ---------- 1. a question is not a plan ---------- */
await check('a question about swarms stays a question, and asks for no plan', async () => {
  await openWith();
  eq(panel.copilotState().source, 'live', 'the panel is live');
  await say('How do swarms work here?');
  const planCalls = state.calls.filter((c) => c.path === '/api/v1/copilot/plans' && c.method === 'POST');
  eq(planCalls.length, 0, 'no plan was drafted');
  eq(panel.copilotState().messages > 0, true, 'the turn still happened, as a conversation');
  await panel.closeCopilot();
});

/* ---------- 2. a request becomes a plan card, not an agent ---------- */
await check('“draft a plan that …” produces a plan card with the server’s state and findings', async () => {
  await openWith();
  await say('Draft a plan that researches the news and writes a brief');
  const call = state.calls.find((c) => c.path === '/api/v1/copilot/plans' && c.method === 'POST');
  assert(call, 'the plan route was called');
  eq(call.body.text, 'Draft a plan that researches the news and writes a brief', 'with the sentence that was typed');
  const agentDrafts = state.calls.filter((c) => c.path === '/api/v1/copilot/drafts' && c.method === 'POST');
  eq(agentDrafts.length, 0, 'and no agent draft was requested');
  assert(card(), 'a plan card is rendered');
  eq(card().getAttribute('data-plan-state'), 'ready-for-review', 'carrying the row’s state');
  const body = cardText();
  assert(/Weekly Brief/.test(body), `the plan’s name is shown (got “${body}”)`);
  assert(/Ready for review/.test(body), 'the canonical state label is shown');
  assert(/2 nodes/.test(body) && /cap 6/.test(body), 'the node count and cap are shown');
  assert(/Nothing executes this plan/.test(body), 'the blocking finding is shown');
  assert(/no scheduler or worker exists/i.test(body), 'and the card says nothing starts it');
  assert(!/running|live progress|completed/i.test(body), 'nothing on the card claims a run');
});

await check('“create a swarm of agents that …” is a plan, not one agent', async () => {
  await openWith();
  await say('Create a swarm of agents that researches a topic');
  assert(state.calls.some((c) => c.path === '/api/v1/copilot/plans' && c.method === 'POST'), 'the plan route was called');
  eq(state.calls.filter((c) => c.path === '/api/v1/copilot/drafts' && c.method === 'POST').length, 0, 'and not the agent draft route');
});

/* ---------- 3. submit, then save ---------- */
await check('Submit is offered because the row says so, and it goes to the real gate', async () => {
  await openWith();
  await say('Draft a plan that researches the news and writes a brief');
  const submit = q('[data-cp="plan-submit"]');
  assert(submit, 'the submit control exists');
  eq(submit.getAttribute('data-plan'), 'pd-1', 'it is scoped to the plan');
  assert(!q('[data-cp="plan-save"]'), 'saving is not offered before approval');
  submit.dispatchEvent(new win.Event('click', { bubbles: true }));
  await sleep(250);
  assert(state.calls.some((c) => /\/submit$/.test(c.path)), 'the submit route was called');
  eq(card().getAttribute('data-plan-state'), 'awaiting-approval', 'the card shows the new state');
  const body = cardText();
  assert(/Waiting for a decision on the Approvals screen/.test(body), `the gate is named (got “${body}”)`);
  assert(/starts nothing/.test(body), 'and the note repeats that nothing starts');
});

await check('saving needs swarm:write: an Owner is offered it, a Reviewer is not', async () => {
  assert(q('[data-cp="plan-save"]'), 'the Owner is offered saving');
  // A Reviewer decides gates and holds neither copilot:write nor swarm:write, so the card they see for a
  // plan that is already waiting must offer the decision and nothing else.
  state.role = 'Reviewer';
  try {
    await openWith({ createdRow: { state: 'awaiting-approval', stateLabel: 'Awaiting approval', canSubmit: false, approvalId: 'ap-9' } });
    await say('Draft a plan that researches the news and writes a brief');
    eq(card()?.getAttribute('data-plan-state'), 'awaiting-approval', 'the Reviewer sees the plan waiting');
    eq(q('[data-cp="plan-save"]'), null, 'and is not offered saving it');
    assert(q('[data-cp="plan-open-approvals"]'), 'but is pointed at the gate they decide');
    eq(q('[data-cp="plan-submit"]'), null, 'and cannot resubmit what is already with them');
  } finally {
    state.role = 'Owner';
    await panel.closeCopilot();
  }
});

await check('saving turns the card active and says the swarm is only planned', async () => {
  await openWith();
  await say('Draft a plan that researches the news and writes a brief');
  q('[data-cp="plan-submit"]')?.dispatchEvent(new win.Event('click', { bubbles: true }));
  await sleep(250);
  q('[data-cp="plan-save"]')?.dispatchEvent(new win.Event('click', { bubbles: true }));
  await sleep(300);
  const call = state.calls.find((c) => /\/activate$/.test(c.path));
  assert(call, 'the save route was called');
  eq(card().getAttribute('data-plan-state'), 'active', 'the card is active');
  const body = cardText();
  assert(/zero progress and zero spend/.test(body), `and says what was stored (got “${body}”)`);
  assert(/No scheduler in this build can start it/.test(body), 'and that nothing can start it');
  assert(q('[data-cp="plan-open-swarm"]'), 'the swarm can be opened');
});

await check('a refusal is shown in the card and the state does not advance', async () => {
  await openWith({ saveStatus: 409, saveError: 'the approval for this plan is still pending' });
  await say('Draft a plan that researches the news and writes a brief');
  q('[data-cp="plan-submit"]')?.dispatchEvent(new win.Event('click', { bubbles: true }));
  await sleep(250);
  q('[data-cp="plan-save"]')?.dispatchEvent(new win.Event('click', { bubbles: true }));
  await sleep(300);
  const body = cardText();
  assert(/still pending/.test(body), `the server’s refusal is shown verbatim (got “${body}”)`);
  eq(card().getAttribute('data-plan-state'), 'awaiting-approval', 'the state stayed where the server left it');
});

await check('an invalid plan is rendered invalid, with the finding and no submit control', async () => {
  await openWith({
    createdRow: {
      state: 'invalid', stateLabel: 'Invalid', canSubmit: false,
      findings: [{ id: 'p3', field: 'objective', severity: 'error', title: 'No objective', detail: 'The gateway refuses a plan without one.' }],
    },
  });
  await say('Draft a plan that researches the news and writes a brief');
  eq(card()?.getAttribute('data-plan-state'), 'invalid', 'the card shows the server’s state');
  assert(/No objective/.test(cardText()), 'with the finding that caused it');
  assert(/The gateway refuses a plan without one/.test(cardText()), 'in the server’s own words');
  eq(q('[data-cp="plan-submit"]'), null, 'and submission is not offered');
  eq(q('[data-cp="plan-save"]'), null, 'saving is not offered either');
  assert(q('[data-cp="plan-archive"]'), 'only discarding it is — the one act that is safe on an invalid plan');
  await panel.closeCopilot();
});

/* ---------- 4. the reload ---------- */
await check('a reload rebuilds the plan card from the gateway’s row, not from the transcript', async () => {
  const listStub = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/v1/copilot' && (init.method || 'GET') === 'GET') {
      return new Response(JSON.stringify({
        conversation: { id: 'cp-1', createdAt: 1 },
        messages: [
          { id: 'r-1', role: 'user', text: 'Draft a plan that researches the news', ts: 1, modelCallId: null, payload: {} },
          { id: 'r-2', role: 'assistant', text: 'I drafted the plan “Weekly Brief”.', ts: 2, modelCallId: 9, payload: { draftId: 'pd-1', draftKind: 'swarm-plan' } },
        ],
        runtime: { configured: true, providerId: 'pv-anthropic', providerName: 'Anthropic', model: 'test-model', reason: '', code: 'ready', streaming: false, costBasis: 'estimated', note: '' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return listStub(url, init);
  };
  stubGatewayPlansOnly();
  panel.resetCopilotSession();
  panel.openCopilot();
  await sleep(900);
  assert(card(), 'the plan card came back');
  eq(card().getAttribute('data-plan-state'), 'awaiting-approval', 'with the live state from the row');
  assert(/Weekly Brief/.test(cardText()), 'and its name');
  globalThis.fetch = listStub;
  await panel.closeCopilot();
});

function stubGatewayPlansOnly() {
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/v1/copilot/plans' && (init.method || 'GET') === 'GET') {
      return new Response(JSON.stringify({ drafts: [planRow({ state: 'awaiting-approval', stateLabel: 'Awaiting approval', canSubmit: false, approvalId: 'ap-9' })] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (path.startsWith('/api/v1/copilot/drafts')) {
      return new Response(JSON.stringify({ drafts: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return inner(url, init);
  };
}

await check('with no gateway the panel says nothing is drafted rather than faking a plan', async () => {
  api.setGatewayUrl('');
  convo.reset();
  panel.resetCopilotSession();
  panel.openCopilot();
  await sleep(150);
  const st = panel.copilotState();
  eq(st.source, 'local', 'the built-in engine answers');
  eq(st.gatewayState, 'no-gateway', 'and there is no gateway');
  eq(card(), null, 'no plan card exists');
  await panel.closeCopilot();
});

console.log(`\nPLANS UI: ${results.filter((r) => r.startsWith('PASS')).length} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
