/* Copilot browser-script drafts in the panel — the one card whose approval runs something.
 * Run: npm run test:scripts:ui
 *
 * What is asserted (and what it protects):
 *   • a question about a website stays a question;
 *   • "open https://… and check …" produces a SCRIPT card, and not an agent or a plan;
 *   • the steps come from the gateway's preview — the model's prose cannot add one;
 *   • a step that commits the user is marked as such;
 *   • Submit is offered only when the row says so; Run only with browser:run on a script awaiting approval;
 *   • a refusal is rendered verbatim and the card does not advance;
 *   • a blocked script offers no submit control at all — activation *is* execution;
 *   • after a run the card shows the task's real status, including a failure;
 *   • a reload rebuilds the card from the gateway's row (payload.draftKind), not from the transcript.
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
const scripts = await import('../src/copilot/scripts.js');

const q = (sel) => win.document.querySelector('#copilot-panel')?.querySelector(sel) || null;
const card = () => q('.cp-script');
const cardText = () => text(card());

const GW = 'http://scripts.test';
const SCRIPT = {
  objective: 'Check the Pro plan price',
  entryUrl: 'https://shop.test/pricing',
  steps: [
    { action: 'goto', url: 'https://shop.test/pricing' },
    { action: 'extract', key: 'heading', selector: 'h1' },
  ],
  successCriteria: [{ key: 'heading', kind: 'text', equals: 'Pricing' }],
  limits: { steps: 6, actions: 10 },
  allowActions: ['goto', 'extract'],
};
const PREVIEW = [
  { index: 0, sentence: 'Open https://shop.test/pricing.', sensitive: false },
  { index: 1, sentence: 'Read the heading into “heading”.', sensitive: false },
  { index: 2, sentence: 'Click “Sign in”.', sensitive: true },
];
const FINDINGS = [
  { id: 's1', field: 'step[2]', severity: 'warning', title: 'This step commits the user', detail: 'Clicking “Sign in” may sign you in.' },
];

const state = { role: 'Owner', calls: [], response: null };
function scriptRow(over = {}) {
  return {
    id: 'sc-1', kind: 'browser-script', state: 'ready-for-review', stateLabel: 'Ready for review', source: 'copilot',
    script: SCRIPT, preview: PREVIEW, findings: FINDINGS, approvalId: null, taskId: null, modelCallId: 11,
    createdAt: 1, updatedAt: 2, canSubmit: true, task: null,
    ...over,
  };
}

const PERMS = {
  Owner: ['read', 'copilot:read', 'copilot:write', 'agent:write', 'swarm:write', 'approval:request', 'approval:decide'],
  Operator: ['read', 'copilot:read', 'copilot:write', 'browser:run'],
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
    if (path === '/api/v1/copilot/scripts' && method === 'GET') return json(200, { drafts: [scriptRow(overrides.listRow || {})] });
    if (path === '/api/v1/copilot/scripts' && method === 'POST') {
      if (overrides.scriptStatus) return json(overrides.scriptStatus, { error: overrides.error || 'refused', code: 'error' });
      const user = { id: 'r-1', role: 'user', text: body.text, ts: Date.now(), modelCallId: null, payload: {} };
      const reply = {
        id: 'r-2', role: 'assistant', text: 'I drafted a browser script. State: Ready for review. Nothing has run.',
        ts: Date.now() + 1, modelCallId: 11,
        payload: { model: 'test-model', promptTokens: 280, completionTokens: 80, costUsd: 0.002, latencyMs: 500, callId: 11, draftId: 'sc-1', draftKind: 'browser-script' },
      };
      return json(201, { draft: scriptRow(overrides.createdRow || {}), usage: reply.payload, userMessage: user, reply });
    }
    if (/\/api\/v1\/copilot\/scripts\/[^/]+$/.test(path) && method === 'GET') return json(200, { draft: scriptRow(overrides.getRow || {}) });
    if (/\/api\/v1\/copilot\/scripts\/[^/]+\/submit$/.test(path) && method === 'POST') {
      if (overrides.submitStatus) return json(overrides.submitStatus, { error: overrides.submitError || 'refused', code: 'conflict' });
      return json(200, scriptRow({ state: 'awaiting-approval', stateLabel: 'Awaiting approval', canSubmit: false, approvalId: 'ap-9' }));
    }
    if (/\/api\/v1\/copilot\/scripts\/[^/]+\/activate$/.test(path) && method === 'POST') {
      if (overrides.runStatus) return json(overrides.runStatus, { error: overrides.runError || 'refused', code: 'forbidden' });
      return json(201, {
        draft: scriptRow({
          state: 'active', stateLabel: 'Active', canSubmit: false, approvalId: 'ap-9', taskId: 'bt-7',
          task: { id: 'bt-7', status: 'failed', stepIndex: 2, totalSteps: 3, evidenceCount: 1, outcome: 'criteria-unmet', simulated: true, blocker: 'heading was “Store”' },
        }),
        task: { id: 'bt-7', status: 'queued' },
      });
    }
    if (/\/api\/v1\/copilot\/scripts\/[^/]+\/archive$/.test(path) && method === 'POST') {
      return json(200, { draft: scriptRow({ state: 'archived', stateLabel: 'Archived' }) });
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

/* ---------- 1. a question is not a script ---------- */
await check('a question about a website stays a question, and drafts nothing', async () => {
  await openWith();
  eq(panel.copilotState().source, 'live', 'the panel is live');
  await say('How do I scrape a competitor site?');
  eq(state.calls.filter((c) => c.path === '/api/v1/copilot/scripts' && c.method === 'POST').length, 0, 'no script was drafted');
  eq(panel.copilotState().messages > 0, true, 'the turn still happened, as a conversation');
  await panel.closeCopilot();
});

/* ---------- 2. a browsing request becomes a script card ---------- */
await check('“open … and check …” produces a script card, not an agent or a plan', async () => {
  await openWith();
  const sentence = 'Open https://shop.test/pricing and check the heading';
  await say(sentence);
  const call = state.calls.find((c) => c.path === '/api/v1/copilot/scripts' && c.method === 'POST');
  assert(call, 'the script route was called');
  eq(call.body.text, sentence, 'with the sentence that was typed');
  eq(state.calls.filter((c) => c.path === '/api/v1/copilot/drafts' && c.method === 'POST').length, 0, 'no agent draft was requested');
  eq(state.calls.filter((c) => c.path === '/api/v1/copilot/plans' && c.method === 'POST').length, 0, 'no plan was requested');
  assert(card(), 'a script card is rendered');
  eq(card().getAttribute('data-script-state'), 'ready-for-review', 'carrying the row’s state');
  const body = cardText();
  assert(/Check the Pro plan price/.test(body), `the objective is shown (got “${body}”)`);
  assert(/Ready for review/.test(body), 'the canonical state label is shown');
  assert(/https:\/\/shop\.test\/pricing/.test(body), 'and the page it would open');
  assert(/nothing before that/i.test(body), 'the card says approval is what runs it');
});

await check('the steps are the gateway’s preview, and the model’s prose cannot add one', async () => {
  const steps = [...card().querySelectorAll('.cp-script-step')].map((el) => text(el));
  eq(steps.length, PREVIEW.length, 'one line per previewed step');
  assert(/Open https:\/\/shop\.test\/pricing\./.test(steps[0]), `the first step is the gateway’s sentence (got “${steps[0]}”)`);
  assert(/Read the heading into “heading”/.test(steps[1]), 'and so is the second');
  // The model's own sentence mentions nothing about clicking, and it must not leak into the list.
  assert(!steps.some((s) => /I drafted a browser script/.test(s)), 'the model’s prose is not a step');
  eq(card().querySelectorAll('.cp-script-step.sensitive').length, 1, 'exactly the step that commits the user is marked');
  assert(/commits you/.test(cardText()), 'with a word for it, not just a colour');
});

/* ---------- 3. submit, run ---------- */
await check('Submit is offered because the row says so, and it goes to the real gate', async () => {
  const submit = q('[data-cp="script-submit"]');
  assert(submit, 'the submit control exists');
  eq(submit.getAttribute('data-script'), 'sc-1', 'it is scoped to the script');
  eq(q('[data-cp="script-run"]'), null, 'running is not offered before approval');
  submit.dispatchEvent(new win.Event('click', { bubbles: true }));
  await sleep(250);
  assert(state.calls.some((c) => /\/submit$/.test(c.path)), 'the submit route was called');
  eq(card().getAttribute('data-script-state'), 'awaiting-approval', 'the card shows the new state');
  assert(/Waiting for a decision on the Approvals screen/.test(cardText()), 'the gate is named');
  assert(/Nothing runs until the gate is open/.test(cardText()), 'and that nothing runs yet');
});

await check('Run needs browser:run: an Owner is not offered it, an Operator is', async () => {
  // Owner holds copilot:write but not browser:run — the card must not offer the one act it cannot do.
  eq(q('[data-cp="script-run"]'), null, 'the Owner is not offered the run');
  assert(q('[data-cp="script-open-approvals"]'), 'the Owner is pointed at the gate instead');
  state.role = 'Operator';
  try {
    await openWith({ createdRow: { state: 'awaiting-approval', stateLabel: 'Awaiting approval', canSubmit: false, approvalId: 'ap-9' } });
    await say('Open https://shop.test/pricing and check the heading');
    assert(q('[data-cp="script-run"]'), 'the Operator is offered it');
    assert(/needs an allowed approval/.test(cardText()), 'and the label says what it needs');
    eq(q('[data-cp="script-submit"]'), null, 'and cannot resubmit what is already gated');
  } finally {
    state.role = 'Owner';
    await panel.closeCopilot();
  }
});

await check('running turns the card active and reports the task’s real status — including a failure', async () => {
  state.role = 'Operator';
  try {
    await openWith({ createdRow: { state: 'awaiting-approval', stateLabel: 'Awaiting approval', canSubmit: false, approvalId: 'ap-9' } });
    await say('Open https://shop.test/pricing and check the heading');
    q('[data-cp="script-run"]')?.dispatchEvent(new win.Event('click', { bubbles: true }));
    await sleep(320);
    const call = state.calls.find((c) => /\/activate$/.test(c.path));
    assert(call, 'the run route was called');
    eq(card().getAttribute('data-script-state'), 'active', 'the card is active');
    const body = cardText();
    eq(card().querySelector('[data-task-status]')?.textContent.trim(), 'failed', 'the status is the task’s, and it is a failure');
    assert(/Outcome: criteria-unmet/.test(body), `the outcome is shown verbatim (got “${body}”)`);
    assert(/step 2\/3/.test(body), 'the progress is the task’s');
    assert(/1 evidence record/.test(body), 'the evidence count is the task’s');
    assert(/simulated engine — not a real browser/.test(body), 'and a simulated run says so');
    assert(!/completed|success/i.test(body), 'nothing claims the run succeeded');
  } finally {
    state.role = 'Owner';
    await panel.closeCopilot();
  }
});

await check('a refusal is shown in the card and the state does not advance', async () => {
  state.role = 'Operator';
  try {
    await openWith({
      createdRow: { state: 'awaiting-approval', stateLabel: 'Awaiting approval', canSubmit: false, approvalId: 'ap-9' },
      runStatus: 403, runError: 'the approval for this script was decided by you, and running it as the same principal is refused',
    });
    await say('Open https://shop.test/pricing and check the heading');
    assert(q('[data-cp="script-run"]'), 'the Operator is offered the run');
    q('[data-cp="script-run"]')?.dispatchEvent(new win.Event('click', { bubbles: true }));
    await sleep(320);
    const call = state.calls.find((c) => /\/activate$/.test(c.path));
    assert(call, 'the run route was called');
    const body = cardText();
    assert(/decided by you/.test(body), `the server’s refusal is shown verbatim (got “${body}”)`);
    eq(card().getAttribute('data-script-state'), 'awaiting-approval', 'the state stayed where the server left it');
    eq(card().querySelector('[data-task-status]'), null, 'and no task was invented for it');
    eq(card().querySelector('[role="alert"]') !== null, true, 'the refusal is announced, not just coloured');
  } finally {
    state.role = 'Owner';
    await panel.closeCopilot();
  }
});

await check('a blocked script offers no submit control — activation is execution', async () => {
  await openWith({
    createdRow: {
      state: 'blocked', stateLabel: 'Blocked', canSubmit: false,
      findings: [{ id: 's9', field: 'engines', severity: 'setup', title: 'No browser engine is available', detail: 'Install a Chromium-compatible engine on the gateway host.' }],
    },
  });
  await say('Open https://shop.test/pricing and check the heading');
  eq(card()?.getAttribute('data-script-state'), 'blocked', 'the card shows the server’s state');
  assert(/No browser engine is available/.test(cardText()), 'with the finding that caused it');
  assert(/Install a Chromium-compatible engine/.test(cardText()), 'in the server’s own words');
  eq(q('[data-cp="script-submit"]'), null, 'submission is not offered');
  eq(q('[data-cp="script-run"]'), null, 'nor running');
  assert(q('[data-cp="script-archive"]'), 'only archiving is — the one act that is safe on a blocked script');
  await panel.closeCopilot();
});

/* ---------- 4. the reload ---------- */
await check('a reload rebuilds the script card from the gateway’s row, not from the transcript', async () => {
  await openWith();
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/v1/copilot' && (init.method || 'GET') === 'GET') {
      return new Response(JSON.stringify({
        conversation: { id: 'cp-1', createdAt: 1 },
        messages: [
          { id: 'r-1', role: 'user', text: 'Open https://shop.test/pricing', ts: 1, modelCallId: null, payload: {} },
          { id: 'r-2', role: 'assistant', text: 'I drafted a browser script.', ts: 2, modelCallId: 11, payload: { draftId: 'sc-1', draftKind: 'browser-script' } },
        ],
        runtime: { configured: true, providerId: 'pv-anthropic', providerName: 'Anthropic', model: 'test-model', reason: '', code: 'ready', streaming: false, costBasis: 'estimated', note: '' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (path === '/api/v1/copilot/drafts' || path === '/api/v1/copilot/plans') {
      return new Response(JSON.stringify({ drafts: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return inner(url, init);
  };
  // The gateway still holds the row, with the live state the transcript never had.
  globalThis.fetch = (() => {
    const outer = globalThis.fetch;
    return async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/v1/copilot/scripts' && (init.method || 'GET') === 'GET') {
        return new Response(JSON.stringify({ drafts: [scriptRow({ state: 'active', stateLabel: 'Active', canSubmit: false, taskId: 'bt-7', task: { id: 'bt-7', status: 'completed', stepIndex: 3, totalSteps: 3, evidenceCount: 2, outcome: 'verified', simulated: false } })] }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return outer(url, init);
    };
  })();
  panel.resetCopilotSession();
  panel.openCopilot();
  await sleep(900);
  assert(card(), 'the script card came back');
  eq(card().getAttribute('data-script-state'), 'active', 'with the live state from the row');
  eq(card().querySelector('[data-task-status]')?.textContent.trim(), 'completed', 'and the task’s live status');
  assert(/Outcome: verified/.test(cardText()), 'and its outcome');
  await panel.closeCopilot();
});

await check('with no gateway the panel says nothing is drafted rather than faking a script', async () => {
  api.setGatewayUrl('');
  convo.reset();
  panel.resetCopilotSession();
  panel.openCopilot();
  await sleep(150);
  const st = panel.copilotState();
  eq(st.source, 'local', 'the built-in engine answers');
  eq(st.gatewayState, 'no-gateway', 'and there is no gateway');
  eq(card(), null, 'no script card exists');
  await panel.closeCopilot();
});

console.log(`\nSCRIPTS UI: ${results.filter((r) => r.startsWith('PASS')).length} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
