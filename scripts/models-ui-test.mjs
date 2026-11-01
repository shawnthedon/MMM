/* Model gateway on screen — happy-dom, real modules, stubbed gateway.
 * Run: npm run test:models:ui
 *
 * The screen used to be a catalogue that could not be wrong because it never claimed anything. Now it
 * claims a lot, so this suite pins the claims down:
 *
 *   • every money figure on screen comes from the gateway ledger, and is labelled *estimated*;
 *   • an unconfigured provider offers no call button, and a configured one shows a hint, never a key;
 *   • installing a key sends it exactly once and never renders it again;
 *   • a refused call (402) says nothing was billed and lands in the ledger as a refusal;
 *   • with no gateway there is no ledger, no key store and no control that pretends otherwise.
 */
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const source = readFileSync(join(root, 'src/views2.js'), 'utf8');
const modelsSource = source.slice(source.indexOf('/* ================= MODEL GATEWAY'), source.indexOf('/* ================= PLUGINS'));

const results = [];
let failures = 0;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (e) { failures += 1; results.push(`FAIL ${name}: ${e.message}`); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); };
const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

/* ---------- 1. the source cannot print a number it invented ---------- */
await check('the screen has no typed-in spend, budget or call count', () => {
  assert(!/Spend MTD/.test(modelsSource), 'no “Spend MTD” tile');
  assert(!/6\.21|Workspace daily/.test(modelsSource), 'no typed budget');
  assert(!/toggle-provider/.test(modelsSource), 'no switch that pretends to enable a provider');
  assert(!/spendMTD/.test(modelsSource), 'no fixture spend figure');
  assert(/getModelsLedger/.test(modelsSource), 'every figure comes from the ledger');
  assert(/estimated/.test(modelsSource), 'and cost is labelled an estimate');
  assert(/never\s+returned to this browser/.test(modelsSource), 'the key sheet says the key does not come back');
});

/* ---------- 2. harness ---------- */
const win = new Window({ url: 'http://localhost:5173/#/models' });
for (const k of ['document', 'navigator', 'location', 'localStorage', 'history', 'HTMLElement', 'Event',
  'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  try { Object.defineProperty(globalThis, k, { value: win[k] ?? win, configurable: true, writable: true }); } catch { /* ignore */ }
}
globalThis.window = win;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
win.matchMedia = globalThis.matchMedia;
win.document.body.innerHTML = '<div id="app"><div id="view"></div><div id="sheet-root"></div><div id="toast-root"></div></div>';

const KEY = 'sk-live-DO-NOT-RENDER-9876543210abcdef';
const REPLY = 'A real reply from the stubbed provider.';
const calls = [];
let permissions = ['read', 'model:read', 'model:call', 'model:key'];
let providers;
let budget;
let usage;
let ledger;
let callStatus = 200;
let failKey = null;

const reset = () => {
  providers = [
    {
      id: 'pv-openai', name: 'OpenAI', category: 'Frontier Cloud', auth: 'API key',
      models: ['gpt-4o-mini'], defaultModel: 'gpt-4o-mini', status: 'configured',
      endpoint: 'https://api.openai.com/v1', endpointHost: 'api.openai.com',
      fingerprint: 'a1b2c3d4e5f60718', hint: '••••cdef', configuredAt: Date.now() - 1000, configuredBy: 'user-owner',
      spendMtd: 0.0123, callsMtd: 3, lastCallAt: Date.now() - 500,
    },
    {
      id: 'pv-ollama', name: 'Ollama', category: 'Local/Self-Hosted', auth: 'local URL',
      models: [], defaultModel: '', status: 'unconfigured',
      endpoint: '', endpointHost: '', fingerprint: '', hint: '',
      configuredAt: null, configuredBy: '', spendMtd: 0, callsMtd: 0, lastCallAt: null,
    },
  ];
  budget = { dailyUsd: 5, perCallUsd: 0.5, enforced: true, spentTodayUsd: 0.0123, callsToday: 3, remainingUsd: 4.9877 };
  usage = {
    windowDays: 14,
    days: [{ day: '2026-10-30', usd: 0.0, tokens: 0, calls: 0, blocked: 0, errors: 0 },
      { day: '2026-10-31', usd: 0.0123, tokens: 150, calls: 3, blocked: 0, errors: 0 }],
    byProvider: [{ providerId: 'pv-openai', calls: 3, usd: 0.0123 }],
    totals: { usd: 0.0123, calls: 3, tokens: 150, blocked: 1, errors: 0 },
    today: { usd: 0.0123, calls: 3 },
    budget,
    costBasis: 'estimated',
    runtime: { adapter: 'openai-compatible', streaming: false, configuredCount: 1, keySource: 'env', costBasis: 'estimated', note: 'Cost is estimated from a price table, not an invoice; prompts and replies are never stored.' },
  };
  ledger = [
    { id: 3, ts: Date.now() - 500, principal: 'user-owner', providerId: 'pv-openai', model: 'gpt-4o-mini', purpose: 'models-screen', status: 'ok', error: '', tokens: 150, costUsd: 0.0123, latencyMs: 240 },
    { id: 2, ts: Date.now() - 900, principal: 'user-owner', providerId: 'pv-openai', model: 'gpt-4o-mini', purpose: 'chat', status: 'blocked', error: 'budget-exceeded', tokens: 0, costUsd: 0, latencyMs: 0 },
  ];
  callStatus = 200;
  failKey = null;
};

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const path = String(url).replace('http://gw.test', '');
  const method = init.method || 'GET';
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ path, method, body });
  if (path === '/api/v1/auth/session') {
    return json(200, { principal: { id: 'user-owner', name: 'Owner', role: 'Owner' }, permissions, csrfToken: 'csrf' });
  }
  if (path === '/api/v1/summary') return json(200, { agents: 0, teams: 0, swarms: 0 });
  if (path === '/api/v1/providers' && method === 'GET') {
    return json(200, { providers, budget, runtime: usage.runtime });
  }
  if (/^\/api\/v1\/providers\/[^/]+\/key$/.test(path) && method === 'PUT') {
    if (failKey) return json(failKey.status, { error: failKey.error });
    const row = providers.find((p) => p.id === path.split('/')[4]);
    Object.assign(row, {
      status: 'configured', endpointHost: 'api.example.test', fingerprint: 'ffeeddccbbaa9988', hint: '••••9999',
      defaultModel: body.defaultModel, spendMtd: 0, callsMtd: 0,
    });
    return json(200, { provider: row });
  }
  if (/^\/api\/v1\/providers\/[^/]+\/key$/.test(path) && method === 'DELETE') {
    const row = providers.find((p) => p.id === path.split('/')[4]);
    Object.assign(row, { status: 'unconfigured', endpointHost: '', fingerprint: '', hint: '', endpoint: '' });
    return json(200, { provider: row, cleared: true });
  }
  if (/^\/api\/v1\/providers\/[^/]+\/call$/.test(path) && method === 'POST') {
    if (callStatus !== 200) {
      ledger.unshift({ id: 9, ts: Date.now(), principal: 'user-owner', providerId: 'pv-openai', model: 'gpt-4o-mini', purpose: 'models-screen', status: callStatus === 402 ? 'blocked' : 'error', error: callStatus === 402 ? 'budget-exceeded' : 'http-500', tokens: 0, costUsd: 0, latencyMs: 0 });
      return json(callStatus, { error: callStatus === 402 ? 'today’s model budget is spent (5.00 of 5.00 USD) — nothing was sent' : 'OpenAI answered HTTP 500', code: callStatus === 402 ? 'budget-exceeded' : 'provider-error' });
    }
    ledger.unshift({ id: 10, ts: Date.now(), principal: 'user-owner', providerId: 'pv-openai', model: 'gpt-4o-mini', purpose: 'models-screen', status: 'ok', error: '', tokens: 210, costUsd: 0.0002, latencyMs: 180 });
    usage.today = { usd: 0.0125, calls: 4 };
    return json(200, {
      callId: 10, text: REPLY, model: 'gpt-4o-mini',
      usage: { promptTokens: 180, completionTokens: 30, totalTokens: 210 },
      costUsd: 0.0002, costBasis: 'estimated', latencyMs: 180,
      provider: providers[0], budget,
    });
  }
  if (path === '/api/v1/usage') return json(200, usage);
  if (path.startsWith('/api/v1/model-calls')) return json(200, { calls: ledger, runtime: usage.runtime });
  if (path === '/api/v1/budget' && method === 'PUT') {
    budget = { ...budget, dailyUsd: body.dailyUsd, perCallUsd: body.perCallUsd };
    return json(200, { budget });
  }
  if (path === '/api/v1/agents') return json(200, []);
  if (path === '/api/v1/tasks' || path === '/api/v1/approvals' || path.startsWith('/api/v1/events')) return json(200, []);
  if (path === '/api/v1/teams') return json(200, { teams: [] });
  if (path === '/api/v1/swarms') return json(200, { swarms: [] });
  if (path.startsWith('/api/v1/threads')) return json(200, { threads: [], runtime: {} });
  return json(404, { error: 'not found' });
};

await import('../src/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(120);
const nav = await import('../src/main.js');
const api = await import('../src/api.js');
const auth = await import('../src/auth.js');
const store = await import('../src/datastore.js');
const core = await import('../src/core.js');

const view = () => win.document.getElementById('view');
const openSheet = () => win.document.querySelector('.sheet.open');
const click = async (selector, ms = 150) => {
  const el = typeof selector === 'string' ? win.document.querySelector(selector) : selector;
  assert(el, `no element for ${selector}`);
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(ms);
};

async function connect() {
  reset();
  calls.length = 0;
  api.setGatewayUrl('http://gw.test');
  await auth.refreshSession({ silent: true });
  await store.refresh({ silent: true });
  nav.navigate('models');
  await sleep(180);
}

/* ---------- 3. the live screen ---------- */
await check('with a gateway the screen shows ledger numbers and live provenance', async () => {
  await connect();
  eq(core.getProvenance().providers, 'gateway', 'the providers slice is owned by the gateway');
  const body = text(view());
  assert(/2 providers · 1 configured/.test(body), `the subtitle counts configured providers (got “${body.slice(0, 160)}”)`);
  assert(/\$0\.01/.test(body) || /\$0\.0123/.test(body), 'spend comes from the ledger');
  assert(/estimated/.test(body), 'and is labelled estimated');
  assert(/of \$5\.00\/day/.test(body), 'the budget on screen is the gateway budget');
  assert(/adapter · openai-compatible/.test(body), 'the adapter is stated');
  assert(/key source · env/.test(body), 'and where the key material came from');
});

await check('a configured provider shows a hint and offers a call; an unconfigured one does not', async () => {
  const rows = [...view().querySelectorAll('.list-card')];
  const openai = rows.find((r) => /OpenAI/.test(text(r)));
  const ollama = rows.find((r) => /Ollama/.test(text(r)));
  assert(openai && ollama, 'both rows rendered');
  assert(/••••cdef/.test(text(openai)), 'the hint identifies the key');
  assert(!new RegExp(KEY).test(text(openai)), 'the key itself is not on screen');
  eq(openai.querySelectorAll('[data-act="provider-call"]').length, 1, 'a configured provider offers a call');
  eq(ollama.querySelectorAll('[data-act="provider-call"]').length, 0, 'an unconfigured provider offers none');
  assert(/not configured/.test(text(ollama)), 'and says so');
});

await check('the ledger is shown, with a refusal at zero cost', async () => {
  const body = text(view());
  assert(/Ledger · 2 recent attempts/.test(body), `the ledger section counts rows (got “${body.slice(0, 200)}”)`);
  assert(/gpt-4o-mini/.test(body), 'the model id from the ledger');
  assert(/refused/.test(body), 'a blocked call is labelled a refusal');
  assert(/no cost/.test(body), 'and carries no cost');
  assert(/\$0\.0123 est\./.test(body), 'a metered call shows its estimated cost');
});

/* ---------- 4. installing a key ---------- */
await check('installing a key sends it once and never renders it', async () => {
  await click('[data-act="provider-key"][data-id="pv-ollama"]');
  const sheet = openSheet();
  assert(sheet, 'the key sheet opened');
  assert(/never\s+returned to this browser/.test(text(sheet)), 'it says the key does not come back');
  sheet.querySelector('#pk-key').value = KEY;
  sheet.querySelector('#pk-url').value = 'https://api.example.test/v1';
  sheet.querySelector('#pk-model').value = 'tiny-model';
  await click('.sheet.open [data-act="provider-key-save"]', 300);
  const put = calls.find((c) => c.method === 'PUT' && /\/key$/.test(c.path));
  assert(put, 'a PUT was sent');
  eq(put.body.apiKey, KEY, 'with the key once');
  eq(put.body.baseUrl, 'https://api.example.test/v1', 'and the endpoint as typed');
  assert(!new RegExp(KEY).test(win.document.body.innerHTML), 'the key is not left anywhere in the DOM');
  await sleep(250);
  const body = text(view());
  assert(/••••9999/.test(body), 'the returned hint is shown instead');
  assert(!new RegExp(KEY).test(body), 'and the key itself never is');
});

await check('a refused key keeps the sheet open and shows the reason', async () => {
  await connect();
  await click('[data-act="provider-key"][data-id="pv-ollama"]');
  failKey = { status: 400, error: 'plain http is only allowed for a loopback endpoint; use https for a remote provider' };
  const sheet = openSheet();
  sheet.querySelector('#pk-key').value = KEY;
  sheet.querySelector('#pk-url').value = 'http://api.example.test/v1';
  await click('.sheet.open [data-act="provider-key-save"]', 300);
  assert(openSheet(), 'the sheet stays open so the entry is not lost');
  assert(/plain http is only allowed/.test(text(win.document.getElementById('toast-root'))), 'the gateway’s reason is shown');
});

/* ---------- 5. a real call ---------- */
await check('a test call posts one request and shows the metered result', async () => {
  await connect();
  await click('[data-act="provider-call"][data-id="pv-openai"]');
  const sheet = openSheet();
  assert(sheet, 'the call sheet opened');
  sheet.querySelector('#pc-prompt').value = 'Say hello';
  await click('.sheet.open [data-act="provider-call-go"]', 400);
  const post = calls.find((c) => c.method === 'POST' && /\/call$/.test(c.path));
  assert(post, 'the call was sent');
  eq(post.body.messages[0].content, 'Say hello', 'with the prompt');
  eq(post.body.purpose, 'models-screen', 'and a purpose for the ledger');
  const body = text(win.document.querySelector('.sheet.open') || view());
  assert(body.includes(REPLY) || /Call #10 is in the ledger/.test(win.document.body.textContent), 'the reply is rendered');
  assert(/estimated/i.test(win.document.body.textContent), 'the cost is labelled estimated');
});

await check('a refused call says nothing was billed and appears in the ledger', async () => {
  await connect();
  callStatus = 402;
  await click('[data-act="provider-call"][data-id="pv-openai"]');
  openSheet().querySelector('#pc-prompt').value = 'spend money';
  await click('.sheet.open [data-act="provider-call-go"]', 400);
  const shown = text(openSheet() || view());
  assert(/budget is spent/.test(shown), `the gateway’s reason is shown (got “${shown.slice(-200)}”)`);
  assert(/Nothing was billed by us/.test(shown), 'and it does not imply a call happened');
  await sleep(250);
  const body = text(view());
  assert(/budget-exceeded/.test(body), 'the refusal is in the ledger with its reason');
});

/* ---------- 6. budget ---------- */
await check('saving the budget writes the caps the gateway enforces', async () => {
  await connect();
  win.document.getElementById('mb-daily').value = '2.5';
  win.document.getElementById('mb-call').value = '0.25';
  await click('[data-act="budget-save"]', 250);
  const put = calls.find((c) => c.method === 'PUT' && c.path === '/api/v1/budget');
  assert(put, 'the budget was sent');
  eq(put.body.dailyUsd, 2.5, 'daily cap');
  eq(put.body.perCallUsd, 0.25, 'per-call cap');
  assert(/Budget saved on the gateway/.test(text(win.document.getElementById('toast-root'))), 'and the screen confirms from the response');
});

/* ---------- 7. roles ---------- */
await check('a role without model:key or model:call sees no key or call controls', async () => {
  permissions = ['read', 'model:read'];
  await connect();
  eq(view().querySelectorAll('[data-act="provider-key"]').length, 0, 'no install control');
  eq(view().querySelectorAll('[data-act="provider-call"]').length, 0, 'no call control');
  eq(view().querySelectorAll('[data-act="budget-save"]').length, 0, 'no budget control');
  assert(/Owner installs keys/.test(text(view())), 'and the screen says who can');
  assert(/Only an Owner can change the budget/.test(text(view())), 'the budget input is explained, not silently dead');
  permissions = ['read', 'model:read', 'model:call', 'model:key'];
});

/* ---------- 8. no gateway ---------- */
await check('without a gateway the screen claims nothing and offers nothing', async () => {
  api.setGatewayUrl('');
  await auth.refreshSession({ silent: true });
  store.releaseGatewayData({ reason: 'signed-out' });
  nav.navigate('models');
  await sleep(180);
  const body = text(view());
  assert(/No gateway is connected, so nothing here is callable/.test(body), `it says there is no gateway (got “${body.slice(0, 200)}”)`);
  eq(view().querySelectorAll('[data-act="provider-key"]').length, 0, 'no install control');
  eq(view().querySelectorAll('[data-act="provider-call"]').length, 0, 'no call control');
  eq(view().querySelectorAll('[data-act="budget-save"]').length, 0, 'no budget control');
  assert(!/estimated in 30 days/.test(body), 'no spend figure');
  assert(/no ledger without a gateway/.test(body), 'and it says why there is no number');
});

console.log(results.join('\n'));
const passed = results.filter((r) => r.startsWith('PASS')).length;
console.log(`\nMODELS UI: ${passed} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
