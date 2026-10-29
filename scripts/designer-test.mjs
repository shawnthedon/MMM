/* Agent Designer tests: the guided agent-creation module and its three shortcuts.
 * Run: npm run test:designer
 *
 * The suite checks behaviour that could otherwise rot silently:
 *   • every shortcut really opens the designer (and carries the wizard draft across)
 *   • goal → proposal → template fill the component map
 *   • definition checks are separated from activation checks, and activation is honestly blocked
 *   • capabilities that cannot work are refused at selection time, not offered as toggles
 *   • saving writes an idle definition (demo store, or the gateway with a signed-in session)
 *   • an unsaveable draft never produces a row
 */
import { Window } from 'happy-dom';

const win = new Window({ url: 'http://localhost:5173/#/home' });
for (const k of ['document', 'navigator', 'location', 'localStorage', 'history', 'HTMLElement',
  'Event', 'CustomEvent', 'KeyboardEvent', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  const value = k === 'KeyboardEvent' ? win.KeyboardEvent : win[k] ?? win;
  try {
    Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
  } catch {
    try { globalThis[k] = value; } catch {}
  }
}
globalThis.window = win;
globalThis.document = win.document;
globalThis.localStorage = win.localStorage;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
win.matchMedia = globalThis.matchMedia;
win.document.body.innerHTML = '<div id="app"></div>';

/* ---------- stub gateway (same contract as the real one) ---------- */
const calls = [];
let behaviour = {};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-mmm-request-id': 'req-dsn' } });

const SESSION_BODY = {
  principal: { id: 'user-dsn', name: 'Design Owner', role: 'Owner', type: 'user', via: 'cookie', status: 'active' },
  permissions: ['read', 'summary:read', 'event:read', 'approval:read', 'approval:request', 'approval:decide', 'audit:read',
    'audit:verify', 'agent:write', 'task:write', 'swarm:write', 'principal:read', 'principal:write', 'token:issue',
    'token:revoke:any', 'system:diagnostics', 'dev:seed'],
  csrfToken: 'csrf-dsn',
};

function resetStub(next = {}) {
  behaviour = {
    session: { status: 401, body: { error: 'authentication required' } },
    login: { status: 200, body: SESSION_BODY },
    listAgents: { status: 200, body: [] },
    listTasks: { status: 200, body: [] },
    listApprovals: { status: 200, body: [] },
    events: { status: 200, body: [] },
    createAgent: { status: 201, body: { id: 'ag-gw-dsn', name: 'Server-Named-Agent', status: 'idle', framework: 'LangGraph', model: 'anthropic/claude-sonnet-4', trust: 50, autonomy: 2, tools: '[]', skills: '[]', memory: '{}' } },
    ...next,
  };
}
resetStub();

globalThis.fetch = async (url, options = {}) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '');
  const method = (options.method || 'GET').toUpperCase();
  calls.push({ path, method, headers: options.headers || {}, body: options.body });
  if (path === '/healthz') return json({ ok: true, db: 'sqlite-wal', auth: { mode: 'required' } });
  if (path === '/api/v1/auth/session') return json(behaviour.session.body, behaviour.session.status);
  if (path === '/api/v1/auth/login') return json(behaviour.login.body, behaviour.login.status);
  if (path === '/api/v1/auth/logout') return json({ ok: true });
  if (path === '/api/v1/agents' && method === 'GET') return json(behaviour.listAgents.body, behaviour.listAgents.status);
  if (path === '/api/v1/agents' && method === 'POST') return json(behaviour.createAgent.body, behaviour.createAgent.status);
  if (path === '/api/v1/tasks' && method === 'GET') return json(behaviour.listTasks.body, behaviour.listTasks.status);
  if (path === '/api/v1/approvals' && method === 'GET') return json(behaviour.listApprovals.body, behaviour.listApprovals.status);
  if (path.startsWith('/api/v1/events')) return json(behaviour.events.body, behaviour.events.status);
  return json({ error: 'not found' }, 404);
};

/* ---------- harness ---------- */
const results = [];
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (err) {
    failures += 1;
    results.push(`FAIL ${name}: ${err.message}`);
  }
}
const assert = (cond, message) => { if (!cond) throw new Error(message); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

await import('../src/main.js');
await sleep(150);

const nav = await import('../src/main.js');
const core = await import('../src/core.js');
const auth = await import('../src/auth.js');
const apiMod = await import('../src/api.js');
const data = await import('../src/datastore.js');
const designer = await import('../src/designer.js');
const views1 = await import('../src/views1.js');
const shell = await import('../src/shell.js');
const copilotMod = await import('../src/copilot.js');
const knowledge = await import('../src/copilot/knowledge.js');

const view = () => win.document.getElementById('view');
const doc = win.document;
const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
const q = (sel, root = doc) => root.querySelector(sel);
const qa = (sel, root = doc) => [...root.querySelectorAll(sel)];
const sheet = () => [...doc.querySelectorAll('.sheet.open')].pop() || null;
async function fresh(route = 'home') {
  shell.closeAllSheets();
  await sleep(20);
  nav.navigate(route);
}

function resetDesigner() {
  designer.resetDraft();
  designer.patchDraft({ name: '', goal: '', template: null, assumptions: [], interaction: ['text'], knowledge: [], plugins: [] }, { repaint: false });
}

/* ---------- 1. route + first step ---------- */
await check('the designer is a route with a goal-first first step', async () => {
  nav.navigate('designer');
  const html = view().innerHTML;
  assert(q('[data-designer]'), 'designer root missing');
  assert(/What should your agent do\?/.test(html), 'goal prompt missing');
  assert(qa('[data-act="dsn-template"]').length === 6, `expected 6 templates, got ${qa('[data-act="dsn-template"]').length}`);
  assert(q('[data-act="dsn-propose"]'), 'propose button missing');
  assert(/no model is called/i.test(html), 'the local-proposal limit must be stated');
  eq(shell.routes.find((r) => r.id === 'designer')?.title, 'Agent Designer', 'route registered');
});

/* ---------- 2. the three shortcuts ---------- */
await check('Quick create offers "Design an agent" and it opens the designer', async () => {
  await fresh();
  click(q('[data-act="more"]'));
  await sleep(20);
  const more = sheet();
  assert(more, 'all-modules sheet did not open');
  click(q('[data-act="quick-create"]', more));
  await sleep(20);
  const s = sheet();
  assert(s && /Quick create/.test(text(s)), 'quick create sheet did not open');
  const btn = q('[data-act="open-designer"]', s);
  assert(btn, 'no designer shortcut in quick create');
  assert(/Design an agent/.test(text(btn)), `label (got "${text(btn)}")`);
  assert(/Guided builder/.test(text(btn)), 'quick-create entry should say what it is');
  click(btn);
  await sleep(40);
  nav.rerender();
  assert(q('[data-designer]'), 'designer did not open from quick create');
});

await check('All modules has a designer shortcut and a designer tile', async () => {
  await fresh();
  click(q('[data-act="more"]'));
  await sleep(20);
  const s = sheet();
  assert(s, 'all-modules sheet did not open');
  const shortcut = q('[data-act="open-designer"]', s);
  assert(shortcut, 'no designer shortcut in All modules');
  assert(/Agent Designer/.test(text(shortcut)), 'shortcut label');
  const tile = qa('[data-act="nav"]', s).find((b) => b.dataset.to === 'designer');
  assert(tile, 'no Agent Designer tile in the module grid');
  click(tile);
  await sleep(30);
  nav.rerender();
  assert(q('[data-designer]'), 'designer did not open from the All modules tile');
});

await check('the New-agent flow carries its draft into the designer', async () => {
  await fresh('agents');
  designer.resetDraft();
  click(q('[data-act="new-agent"]'));
  await sleep(20);
  const s = sheet();
  assert(s, 'wizard did not open');
  q('#w-name', s).value = 'Wizard-Seeded-Agent';
  q('#w-role', s).value = 'Watches build failures';
  const jump = q('[data-act="wizard-designer"]', s);
  assert(jump, 'no designer shortcut in the new-agent flow');
  click(jump);
  await sleep(40);
  nav.rerender();
  assert(q('[data-designer]'), 'designer did not open from the wizard');
  const d = designer.getDraft();
  eq(d.name, 'Wizard-Seeded-Agent', 'name carried across');
  eq(d.role, 'Watches build failures', 'role carried across');
  assert(d.goal.includes('Watches build failures'), 'goal seeded from the role');
  assert((d.assumptions || []).some((a) => /New-agent flow/.test(a)), 'assumptions record the hand-off');
  eq(doc.querySelectorAll('.sheet.open').length, 0, 'wizard closed behind the designer');
});

/* ---------- 3. templates + proposal ---------- */
await check('a template fills the component map and states its assumptions', async () => {
  resetDesigner();
  nav.navigate('designer');
  click(q('[data-act="dsn-template"][data-id="research"]'));
  await sleep(30);
  nav.rerender();
  const d = designer.getDraft();
  assert(d.name && d.name !== '', 'template should suggest a unique name');
  assert(/cited briefing/.test(d.goal), 'goal from template');
  eq(d.framework, 'LangGraph', 'framework from template');
  assert(d.skills.includes('firecrawl.deep-research'), 'research skill selected');
  assert(d.plugins.includes('pl-fc'), 'firecrawl connector selected');
  assert(d.assumptions.length >= 3, 'assumptions recorded');
  const html = view().innerHTML;
  assert(/Runtime &amp; framework|Runtime & framework/.test(html), 'component map missing');
  assert(/compat:/.test(html), 'compatibility must be shown per component');
  assert(/Needs setup|Unavailable/.test(html), 'availability must be shown per component');
});

await check('"Propose a configuration" is local, deterministic and marks its assumptions', async () => {
  resetDesigner();
  nav.navigate('designer');
  q('#dsn-goal').value = 'Watch our deployment logs and summarise incidents each morning.';
  click(q('[data-act="dsn-propose"]'));
  await sleep(30);
  nav.rerender();
  const d = designer.getDraft();
  assert(d.skills.includes('sre.triage'), `ops goal should select the triage skill (got ${d.skills.join(',')})`);
  assert(d.plugins.includes('pl-vl'), 'vercel connector');
  eq(d.preset, 'bounded', 'bounded autonomy for monitoring');
  assert(d.assumptions.some((a) => /no model call/i.test(a)), 'must state no model was called');
});

/* ---------- 4. validation: definition vs activation ---------- */
await check('validation separates a saveable definition from a blocked activation', async () => {
  const check2 = designer.validateDraft(designer.getDraft());
  eq(check2.canSave, true, 'the template draft should be saveable');
  eq(check2.canActivate, false, 'activation must never be claimed');
  eq(check2.activation.state, 'blocked', 'activation blocked');
  assert(check2.definition.findings.length > 0, 'definition findings present');
  assert(check2.activation.findings.some((f) => /runtime/i.test(f.title)), 'runtime blocker named');
  assert(check2.activation.findings.some((f) => /credential/i.test(f.title) || /Signed|gateway/i.test(f.title)), 'credential blocker named');
  nav.navigate('designer');
  click(q('[data-act="dsn-step"][data-step="3"]'));
  await sleep(20);
  nav.rerender();
  const html = view().innerHTML;
  assert(/Definition checks/.test(html) && /Activation checks/.test(html), 'both groups must be visible');
  assert(/can be saved/.test(html), 'verdict should say the definition can be saved');
});

await check('capabilities that cannot work are refused, not offered as toggles', async () => {
  await fresh('designer');
  designer.patchDraft({ name: 'Cap-Check-Agent', goal: 'Say hello back to me.' }, { repaint: false });
  click(q('[data-act="dsn-step"][data-step="1"]'));
  await sleep(20);
  nav.rerender();
  click(q('[data-act="dsn-select"][data-node="interaction"]'));
  await sleep(20);
  nav.rerender();
  const voice = q('[data-dsn="interaction"][data-value="voice-in"]');
  assert(voice, 'voice option should be listed (with a reason)');
  eq(voice.disabled, true, 'voice input must be disabled');
  const label = voice.closest('.dsn-check');
  assert(/blocked/i.test(text(label)), 'the option must be labelled blocked');
  assert(/speech-to-text|no microphone|audio pipeline/i.test(text(label)), 'the reason must be stated');
});

await check('the scheduled preset is unavailable with a reason', async () => {
  click(q('[data-act="dsn-step"][data-step="1"]'));
  await sleep(20);
  nav.rerender();
  click(q('[data-act="dsn-select"][data-node="behaviour"]'));
  await sleep(20);
  nav.rerender();
  const opt = [...q('#dsn-preset').options].find((o) => o.value === 'scheduled');
  assert(opt, 'scheduled preset listed');
  eq(opt.disabled, true, 'scheduled preset disabled');
  assert(/unavailable/i.test(opt.textContent), 'disabled option labelled');
});

/* ---------- 5. blocking rules ---------- */
await check('ungated write scopes block saving and name the scope', async () => {
  designer.patchDraft({ gates: false, skills: ['dev.tdd-loop'] }, { repaint: false });
  const check2 = designer.validateDraft(designer.getDraft());
  eq(check2.canSave, false, 'must not be saveable ungated');
  const f = check2.definition.findings.find((x) => x.id === 'def-gates');
  assert(f, 'gate finding missing');
  assert(/fs\.write|process\.exec/.test(f.detail), `scope should be named (got "${f.detail}")`);
  designer.patchDraft({ gates: true }, { repaint: false });
});

await check('a duplicate agent name blocks saving', async () => {
  const existing = core.getState().agents[0].name;
  designer.patchDraft({ name: existing }, { repaint: false });
  const check2 = designer.validateDraft(designer.getDraft());
  eq(check2.canSave, false, 'duplicate name must block');
  assert(check2.definition.findings.some((f) => f.id === 'def-name-dup'), 'duplicate finding missing');
});

/* ---------- 6. saving (demo mode) ---------- */
await check('saving in demo mode writes an idle definition and clears the draft', async () => {
  resetDesigner();
  nav.navigate('designer');
  click(q('[data-act="dsn-template"][data-id="content"]'));
  await sleep(20);
  designer.patchDraft({ name: 'Designer-Demo-Agent' }, { repaint: false });
  const before = core.getState().agents.length;
  const out = await designer.saveDefinition();
  eq(out.ok, true, 'save should succeed');
  eq(out.mode, 'demo', 'demo mode saved locally');
  const s = core.getState();
  eq(s.agents.length, before + 1, 'exactly one agent added');
  const row = s.agents.find((a) => a.name === 'Designer-Demo-Agent');
  assert(row, 'agent row missing');
  eq(row.status, 'idle', 'definition is idle, never running');
  assert(row.prompt.includes('You are Designer-Demo-Agent.'), 'prompt built from the goal');
  assert(!JSON.parse(globalThis.localStorage.getItem('mmm.agentDraft.v1') || 'null'), 'draft cleared after save');
});

await check('an unsaveable draft produces no row and a plain refusal', async () => {
  resetDesigner();
  designer.patchDraft({ name: 'X', goal: '', skills: ['dev.tdd-loop'], gates: false }, { repaint: false });
  const before = core.getState().agents.length;
  const out = await designer.saveDefinition();
  eq(out.ok, false, 'save refused');
  eq(out.reason, 'invalid', 'refused for validation');
  eq(core.getState().agents.length, before, 'no agent row created');
});

/* ---------- 7. gateway save ---------- */
await check('with a signed-in gateway the definition is POSTed and the server copy adopted', async () => {
  resetDesigner();
  resetStub();
  await auth.configureGateway('http://gateway.test');
  await auth.login({ email: 'owner@test.local', password: 'right' });
  const synced = await data.refresh();
  assert(synced.ok, 'gateway sync');
  designer.patchDraft({ name: 'Gateway-Designed-Agent', goal: 'Summarise build failures.', skills: ['core.citations'], plugins: [] }, { repaint: false });
  calls.length = 0;
  const out = await designer.saveDefinition();
  eq(out.ok, true, `save should succeed (${out.error || ''})`);
  eq(out.mode, 'gateway', 'saved on the gateway');
  const post = calls.find((c) => c.path === '/api/v1/agents' && c.method === 'POST');
  assert(post, 'no POST /api/v1/agents');
  eq(post.headers['x-mmm-csrf'], 'csrf-dsn', 'CSRF header');
  const row = core.getState().agents.find((a) => a.id === 'ag-gw-dsn');
  assert(row && row.name === 'Server-Named-Agent', 'server copy adopted');
  assert(!core.getState().agents.some((a) => a.name === 'Gateway-Designed-Agent'), 'the client draft must not linger');
});

await check('without a live agent slice the designer refuses instead of writing locally', async () => {
  resetDesigner();
  resetStub({ session: { status: 200, body: SESSION_BODY }, listAgents: { status: 500, body: { error: 'db locked' } } });
  await auth.refreshSession();
  await data.refresh();
  designer.patchDraft({ name: 'No-Ghost-Agent', goal: 'Do a thing.', skills: [], plugins: [] }, { repaint: false });
  const before = core.getState().agents.length;
  const out = await designer.saveDefinition();
  eq(out.ok, false, 'must refuse');
  assert(/not serving agents/i.test(out.error || ''), `reason should name the sync problem (got "${out.error}")`);
  eq(core.getState().agents.length, before, 'no browser-only row');
});

/* ---------- 8. draft persistence + copilot awareness ---------- */
await check('the draft survives a reload through localStorage', async () => {
  resetDesigner();
  resetStub();
  await auth.configureGateway('');
  designer.patchDraft({ name: 'Persisted-Draft', goal: 'Remember my questions.' }, { repaint: false });
  await sleep(320);
  const raw = JSON.parse(globalThis.localStorage.getItem('mmm.agentDraft.v1') || 'null');
  assert(raw, 'draft not persisted');
  eq(raw.name, 'Persisted-Draft', 'persisted name');
  assert(designer.getDraft().name === 'Persisted-Draft', 'in-memory draft kept');
});

await check('Copilot can describe the designer truthfully', async () => {
  nav.navigate('designer');
  const line = knowledge.describeScreen('designer');
  assert(/Agent Designer/.test(line), 'screen description');
  assert(/activation/i.test(line), 'must state activation state');
  assert(/idle definition only|no runtime/i.test(line), 'must not imply it can run');
  const entry = knowledge.getEntry('ui.agent.designer');
  assert(entry, 'knowledge entry missing');
  assert(/deterministic keyword match/i.test(entry.body), 'must state the proposal is local');
  assert(/no framework adapter/i.test(entry.body), 'must state the runtime limit');
});

await check('the activation action explains blockers instead of pretending to run', async () => {
  await fresh('designer');
  designer.patchDraft({ name: 'Explain-Agent', goal: 'Explain the blockers.' }, { repaint: false });
  click(q('[data-act="dsn-step"][data-step="4"]'));
  await sleep(30);
  nav.rerender();
  const btn = q('[data-act="dsn-explain-activation"]');
  assert(btn, 'explain button missing');
  click(btn);
  await sleep(60);
  const s = sheet();
  assert(s, 'explanation sheet did not open');
  assert(/No runtime adapter/.test(text(s)), 'blockers listed');
  assert(/idle|Save definition instead/i.test(text(s)), 'offers the honest alternative');
});

copilotMod.closeCopilot?.();
designer.resetDraft();
console.log(results.join('\n'));
if (failures) {
  console.error(`\n${failures} designer test(s) failed`);
  process.exit(1);
}
console.log(`\nAGENT DESIGNER: ${results.length}/${results.length} PASSED`);
process.exit(0);
