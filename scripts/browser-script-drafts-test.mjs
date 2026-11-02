/* Browser-script drafts — a conversation writes a script, an approval runs it.
 * Run: npm run test:scripts
 *
 * The assertions that matter:
 *   • with no model, asking for a script is refused and creates nothing;
 *   • a real reply becomes a script draft whose state comes from the canonical validator, not the model;
 *   • the plain-language preview is derived from the steps, so the model's own prose cannot soften what a
 *     step does — and a `type` step never previews the text it types;
 *   • a reply that is not JSON creates **no** draft and says so, while the call is still metered;
 *   • `file:` / `javascript:` urls, an unknown action and a missing operand are refused — and the executor
 *     refuses the same things, so the draft is never stricter than the run it predicts;
 *   • with no browser engine the draft is `blocked` and cannot be submitted at all, because activation
 *     here *is* the run;
 *   • submitting creates a real approvals row (`browser.script.run`) whose evidence is the preview;
 *   • running is refused before approval, refused for the decider, refused without `browser:run`, and
 *     allowed for a different principal — which queues exactly one real task through createTask;
 *   • the draft reports the task's live state, and a run that fails is reported as failed;
 *   • a retried run is a 409 and queues no second task; a denied gate never runs;
 *   • nothing is created before an approval: no task, no evidence, no artefact.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = Number(process.env.MMM_TEST_PORT || 8898);
const DATA_DIR = `/tmp/mmm-scripts-${process.pid}`;
rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;
process.env.MMM_QUIET = '1';
process.env.MMM_SECRET = 'test-secret-material-that-is-long-enough-1234';
process.env.MMM_BROWSER_ALLOW_SIM = '1';   // the scripted driver is allowed — tests only
// Pin the engine so the suite proves the same thing on every host: a developer machine with Chromium in
// /tmp must not silently swap in the real driver and turn "simulated" assertions into environment checks.
process.env.MMM_BROWSER_CHROMIUM_PATH = '/nonexistent/mmm-test-chromium';
process.env.MMM_BROWSER_DISABLE = '1';     // no background ticker: the test drives every tick
process.env.MMM_BOOTSTRAP_EMAIL = 'owner@scripts.local';
process.env.MMM_BOOTSTRAP_PASSWORD = 'OwnerPassw0rd!2026';

/* ---------- a real provider whose reply the test controls ---------- */
const received = [];
let modelReply = '{}';
const provider = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    received.push({ url: req.url, body: JSON.parse(body || '{}') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'test-model',
      choices: [{ index: 0, message: { role: 'assistant', content: modelReply } }],
      usage: { prompt_tokens: 320, completion_tokens: 140, total_tokens: 460 },
    }));
  });
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
const providerBase = `http://127.0.0.1:${provider.address().port}/v1`;

const results = [];
let failures = 0;
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); };
const assert = (cond, m) => { if (!cond) throw new Error(m); };
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); console.log(`PASS ${name}`); }
  catch (e) { failures += 1; results.push(`FAIL ${name}: ${e.message}`); console.log(`FAIL ${name}: ${e.message}`); }
}

const { createGateway } = await import('../apps/gateway/server.js');
const authMod = await import('../apps/gateway/src/auth.js');
const dbm = await import('../apps/gateway/src/db.js');
const { runner } = await import('../apps/gateway/src/browser/index.js');
const draftsMod = await import('../apps/gateway/src/browserScriptDrafts.js');
let gateway;
const BASE = `http://127.0.0.1:${PORT}`;
async function start() {
  gateway = createGateway();
  await new Promise((r) => gateway.server.listen(PORT, '127.0.0.1', r));
}
await start();

function client() {
  const jar = {};
  const api = {
    csrf: null,
    async request(path, { method = 'GET', body } = {}) {
      const headers = {};
      const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookies) headers.cookie = cookies;
      if (method !== 'GET' && api.csrf) headers[authMod.CSRF_HEADER] = api.csrf;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      for (const raw of res.headers.getSetCookie?.() || []) {
        const [pair] = raw.split(';');
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
await owner.login('owner@scripts.local', 'OwnerPassw0rd!2026');

async function makePrincipal(name, role) {
  const email = `${name}@scripts.local`;
  const res = await owner.request('/api/v1/principals', { method: 'POST', body: { name, email, role, password: 'AnotherPassw0rd!2026', type: 'human' } });
  if (![200, 201].includes(res.status)) throw new Error(`create ${name}: ${res.text}`);
  const c = client();
  await c.login(email, 'AnotherPassw0rd!2026');
  return c;
}
const operator = await makePrincipal('operator', 'Operator');
const reviewer = await makePrincipal('reviewer', 'Reviewer');
const watcher = await makePrincipal('watcher', 'Observer');

const GOOD = {
  objective: 'Read the Pro plan price from the pricing page',
  entryUrl: 'https://example.test/pricing',
  successCriteria: [{ key: 'price', expect: 'contains:4200', describe: 'the Pro price' }],
  steps: [
    { action: 'goto', url: 'https://example.test/pricing' },
    { action: 'extract', key: 'price', selector: '#pro .amount', describe: 'the Pro tier price' },
    { action: 'screenshot' },
  ],
};
const taskCount = () => dbm.db.prepare('SELECT COUNT(*) n FROM browser_tasks').get().n;
const evidenceCount = () => dbm.db.prepare('SELECT COUNT(*) n FROM browser_evidence').get().n;

/* ---------- 1. no model ---------- */
await check('with no provider key, asking for a script is refused and creates nothing', async () => {
  const res = await operator.request('/api/v1/copilot/scripts', { method: 'POST', body: { text: 'open example.com and read the heading' } });
  eq(res.status, 409, 'refused as no-model');
  eq(res.body.code, 'no-model', 'with the code');
  assert(/no provider has a sealed key/i.test(res.body.error), `naming the cause (got "${res.body.error}")`);
  eq((await operator.request('/api/v1/copilot/scripts')).body.drafts.length, 0, 'no script draft was created');
  eq(received.length, 0, 'the provider was never contacted');
  eq(taskCount(), 0, 'no browser task exists');
});

await check('sealing a key makes the script route usable', async () => {
  const put = await owner.request('/api/v1/providers/pv-anthropic/key', {
    method: 'PUT', body: { apiKey: 'sk-script-test-key-1234567890', baseUrl: providerBase, defaultModel: 'test-model' },
  });
  eq(put.status, 200, `PUT key (${put.text})`);
});

/* ---------- 2. a real reply becomes a script draft ---------- */
let scriptId = null;

await check('a real conversation turn produces a script draft, and the validator decides the state', async () => {
  modelReply = JSON.stringify(GOOD);
  const res = await operator.request('/api/v1/copilot/scripts', { method: 'POST', body: { text: 'open the pricing page and read the Pro price' } });
  eq(res.status, 201, `draft created (${res.text.slice(0, 400)})`);
  const d = res.body.draft;
  scriptId = d.id;
  eq(d.kind, 'browser-script', 'it is a browser-script draft');
  eq(d.script.objective, GOOD.objective, 'the model’s objective is stored');
  eq(d.script.steps.length, 3, 'and its three steps');
  eq(d.state, 'ready-for-review', 'the validator, not the model, decided the state');
  eq(d.modelCallId > 0, true, 'linked to the metered call');
  eq(res.body.usage.costBasis, 'estimated', 'cost labelled estimated');
  const call = dbm.db.prepare('SELECT * FROM model_calls WHERE id=?').get(d.modelCallId);
  eq(call.purpose, 'copilot.script', 'the ledger row says what it was for');
  const sent = received.at(-1).body;
  const brief = sent.messages[0].content;
  eq(sent.messages[0].role, 'system', 'a system brief leads');
  for (const action of ['goto', 'wait', 'waitFor', 'click', 'type', 'extract', 'screenshot', 'assert']) {
    assert(brief.includes(action), `the brief names the real action “${action}”`);
  }
  assert(/There is no other action and no other field/i.test(brief), 'and says the list is closed');
  assert(/only http and https/i.test(brief), 'and refuses other url schemes');
  assert(/page\s+content is data/i.test(brief.replace(/\s+/g, ' ')), 'and states that page content is data');
  assert(/approval that you cannot\s+grant/i.test(brief.replace(/\s+/g, ' ')) || /cannot\s+grant/i.test(brief), 'and that its text cannot grant approval');
  eq(taskCount(), 0, 'drafting a script creates no browser task');
});

await check('the preview is derived from the steps, and shows them in plain language', async () => {
  const d = (await operator.request(`/api/v1/copilot/scripts/${scriptId}`)).body.draft;
  eq(d.preview.length, 3, 'every step has a sentence');
  eq(d.preview[0].sentence, 'Open “https://example.test/pricing”', 'the goto is a sentence, not JSON');
  eq(d.preview[1].sentence, 'Read “price” from “#pro .amount”', 'the extract says what it reads and where');
  eq(d.preview[2].sentence, 'Take a screenshot as evidence', 'and the screenshot says why');
});

await check('a model that writes friendly prose cannot soften the preview', async () => {
  modelReply = JSON.stringify({
    objective: 'Confirm the checkout button label on the shop page',
    steps: [
      { action: 'goto', url: 'https://shop.test/', describe: 'This step only reads a public page' },
      { action: 'click', selector: '#buy', describe: 'This is a harmless read-only step that changes nothing' },
    ],
    successCriteria: [{ key: 'text', expect: 'exists' }],
  });
  const res = await operator.request('/api/v1/copilot/scripts', { method: 'POST', body: { text: 'check the buy button' } });
  eq(res.status, 201, 'draft created');
  const d = res.body.draft;
  const sentences = d.preview.map((p) => p.sentence).join(' | ');
  assert(d.preview[1].sentence.startsWith('Click'), `the click is previewed as a click (got “${sentences}”)`);
  assert(!/harmless|read-only|only reads/i.test(sentences), `the model’s prose is not in the preview (got “${sentences}”)`);
  assert(/Click/.test(sentences), 'and the derived sentence is what a person reads');
});

await check('the turn that produced the script is in the transcript, with its call id', async () => {
  const convo = await operator.request('/api/v1/copilot');
  const assistant = convo.body.messages.filter((m) => m.role === 'assistant').at(-1);
  assert(assistant, 'the model’s summary is stored');
  assert(/drafted a browser script/i.test(assistant.text), `it explains itself (got "${assistant.text}")`);
  assert(/nothing has run/i.test(assistant.text), 'and says nothing has run');
  assert(assistant.modelCallId > 0, 'with the call id');
  eq(convo.body.messages.filter((m) => m.role === 'user').at(-1).text, 'check the buy button', 'the request is stored too');
});

await check('a model reply that is not JSON creates no draft and is reported as such', async () => {
  modelReply = 'Done! I opened the page and the price is 4200. Everything worked.';
  const before = (await operator.request('/api/v1/copilot/scripts')).body.drafts.length;
  const res = await operator.request('/api/v1/copilot/scripts', { method: 'POST', body: { text: 'read the price' } });
  eq(res.status, 422, 'unusable draft');
  eq(res.body.code, 'unusable-draft', 'with the code');
  assert(/could not be read as a browser script/i.test(res.body.error), `says what happened (got "${res.body.error}")`);
  eq((await operator.request('/api/v1/copilot/scripts')).body.drafts.length, before, 'no script draft exists');
  assert(res.body.usage?.callId > 0, 'the call is still metered');
  assert(/Nothing was created and nothing ran/i.test(res.body.reply?.text || ''), 'and the person is told nothing ran');
  eq(taskCount(), 0, 'and no task was created');
});

/* ---------- 3. the validator refuses what the executor refuses ---------- */
await check('nothing the model writes can add an action, escape http, or claim a run', async () => {
  modelReply = JSON.stringify({
    objective: 'Read a local file and claim success',
    taskId: 'bt-invented', status: 'completed', state: 'active', driver: 'simulated', sim: { pages: {} },
    steps: [
      { action: 'goto', url: 'file:///etc/passwd' },
      { action: 'evaluate', script: 'document.body.innerHTML' },
      { action: 'javascript', url: 'javascript:alert(1)' },
      { action: 'click' },
    ],
  });
  const res = await operator.request('/api/v1/copilot/scripts', { method: 'POST', body: { text: 'read a local file' } });
  eq(res.status, 201, 'the draft is created so the person can see what went wrong');
  const d = res.body.draft;
  eq(d.state, 'invalid', 'and it is invalid');
  eq(d.canSubmit, false, 'so it cannot be submitted');
  eq(d.taskId, null, 'no task id was taken from the model');
  for (const key of ['taskId', 'status', 'state', 'driver', 'sim']) {
    assert(d.dropped.includes(key), `“${key}” is reported as dropped (got ${JSON.stringify(d.dropped)})`);
  }
  const titles = d.findings.map((f) => f.title).join(' | ');
  assert(/cannot open that url/i.test(titles), `the file: url is an error (got "${titles}")`);
  assert(/unknown action/i.test(titles), 'the invented action is an error');
  assert(/nothing to act on/i.test(titles), 'and the selector-less click is an error');
  eq(taskCount(), 0, 'nothing was queued');

  // The executor refuses the same things — otherwise the draft would be stricter than the run.
  const direct = await owner.request('/api/v1/browser/tasks', {
    method: 'POST',
    body: { objective: 'Read a local file and claim success', plan: [{ action: 'goto', url: 'file:///etc/passwd' }] },
  });
  eq(direct.status, 400, 'POST /browser/tasks refuses the same file: step');
  assert(/file:/i.test(direct.body.error), `with the same reason (got "${direct.body.error}")`);
  const badEntry = await owner.request('/api/v1/browser/tasks', {
    method: 'POST', body: { objective: 'Read a local file and claim success', entryUrl: 'file:///etc/passwd', plan: [{ action: 'screenshot' }] },
  });
  eq(badEntry.status, 400, 'and an entryUrl outside http(s)');
});

await check('a sensitive step is flagged, and so is a criterion nothing can produce', async () => {
  modelReply = JSON.stringify({
    objective: 'Buy the cheapest plan on the shop page',
    steps: [
      { action: 'goto', url: 'https://shop.test/' },
      { action: 'click', selector: '#buy-now', sensitive: true, describe: 'buy now' },
      { action: 'extract', key: 'confirmation', selector: '#confirm' },
    ],
    successCriteria: [
      { key: 'confirmation', expect: 'contains:thank you' },
      { key: 'total', expect: 'frobnicate:1' },
    ],
  });
  const res = await operator.request('/api/v1/copilot/scripts', { method: 'POST', body: { text: 'buy the cheapest plan' } });
  eq(res.status, 201, 'draft created');
  const d = res.body.draft;
  const titles = d.findings.map((f) => `${f.severity}:${f.title}`).join(' | ');
  assert(/warning:step 2: commits the operator/i.test(titles), `the sensitive step is flagged (got "${titles}")`);
  assert(/warning:Hero|warning:Nothing produces “total”/i.test(titles) || /Nothing produces “total”/.test(titles), 'a criterion nothing produces is flagged');
  assert(/uses an unknown form/.test(titles), 'and an unknown criterion form is flagged');
  eq(d.state, 'ready-for-review', 'but none of these is an error — the runner accepts them, so the draft must not refuse them');
});

await check('typing into a secret field is refused as a warning, and the preview never prints it', async () => {
  const res = await operator.request('/api/v1/copilot/scripts', {
    method: 'POST',
    body: {
      script: {
        objective: 'Sign in to the dashboard and read the balance',
        successCriteria: [{ key: 'balance', expect: 'exists' }],
        steps: [
          { action: 'goto', url: 'https://app.test/login' },
          { action: 'type', selector: 'input[name=password]', text: 'hunter2-not-a-real-password' },
          { action: 'extract', key: 'balance', selector: '#balance' },
        ],
      },
    },
  });
  eq(res.status, 201, 'draft created');
  const d = res.body.draft;
  assert(d.findings.some((f) => /types into a secret field/i.test(f.title)), 'the secret field is called out');
  const preview = d.preview.map((p) => p.sentence).join(' | ');
  assert(!preview.includes('hunter2'), `the password is never previewed (got “${preview}”)`);
  assert(/Type \d+ characters into/.test(preview), 'it says how much would be typed, not what');
});

/* ---------- 4. no engine: blocked, and not submittable ---------- */
await check('with no browser engine the script is blocked and cannot even be submitted', async () => {
  process.env.MMM_BROWSER_ALLOW_SIM = '';
  await draftsMod.availableEngines({ fresh: true }); // refresh the cache with no engine available
  try {
    const res = await operator.request('/api/v1/copilot/scripts', { method: 'POST', body: { script: GOOD } });
    eq(res.status, 201, 'draft created');
    const d = res.body.draft;
    eq(d.state, 'blocked', 'the validator says blocked');
    eq(d.canSubmit, false, 'and it cannot be submitted — approval would be theatre');
    assert(d.findings.some((f) => f.severity === 'blocked' && /No browser engine/i.test(f.title)), 'naming the cause');
    const submit = await operator.request(`/api/v1/copilot/scripts/${d.id}/submit`, { method: 'POST', body: {} });
    eq(submit.status, 409, 'submitting is refused');
    assert(/blocked/i.test(submit.body.error), `with the reason (got "${submit.body.error}")`);
  } finally {
    process.env.MMM_BROWSER_ALLOW_SIM = '1';
    await draftsMod.availableEngines({ fresh: true });
  }
});

/* ---------- 5. approval ---------- */
let approvalId = null;

await check('submitting a runnable script creates a real approvals row whose evidence is the preview', async () => {
  const res = await operator.request(`/api/v1/copilot/scripts/${scriptId}/submit`, { method: 'POST', body: {} });
  eq(res.status, 200, `submitted (${res.text.slice(0, 300)})`);
  eq(res.body.state, 'awaiting-approval', 'the script waits');
  approvalId = res.body.approvalId;
  assert(approvalId, 'an approval id is returned');
  const approvals = await reviewer.request('/api/v1/approvals');
  const gate = approvals.body.find((a) => a.id === approvalId);
  assert(gate, 'it is on the Approvals screen list');
  eq(gate.action, 'browser.script.run', 'with an action that says it runs');
  eq(gate.risk, 'high', 'and a risk level that matches opening a browser');
  eq(gate.status, 'pending', 'and it is pending');
  eq(gate.target, scriptId, 'targeting the script draft');
  assert(/Open “https:\/\/example\.test\/pricing”/.test(gate.evidence), `the evidence is the preview a person can read (got "${gate.evidence}")`);
  eq(taskCount(), 0, 'submitting created no task');
});

await check('running is refused before the approval is decided', async () => {
  const res = await owner.request(`/api/v1/copilot/scripts/${scriptId}/activate`, { method: 'POST', body: {} });
  eq(res.status, 409, 'still pending');
  assert(/pending/i.test(res.body.error), `says so (got "${res.body.error}")`);
  eq(taskCount(), 0, 'and no task was queued');
});

await check('the requester cannot approve their own script', async () => {
  const res = await operator.request(`/api/v1/approvals/${approvalId}/allow`, { method: 'POST', body: {} });
  eq(res.status, 403, 'self-approval refused');
  eq((await operator.request(`/api/v1/copilot/scripts/${scriptId}`)).body.draft.state, 'awaiting-approval', 'and it still waits');
});

await check('a Reviewer allows it, and a Reviewer can never run a browser task', async () => {
  const allow = await reviewer.request(`/api/v1/approvals/${approvalId}/allow`, { method: 'POST', body: {} });
  eq(allow.status, 200, `allowed (${allow.text})`);
  const res = await reviewer.request(`/api/v1/copilot/scripts/${scriptId}/activate`, { method: 'POST', body: {} });
  eq(res.status, 403, 'the decider holds no browser:run, so deciding and running cannot be one pair of hands');
  eq(taskCount(), 0, 'and nothing was queued');
});

let taskId = null;

await check('a different principal runs it, and exactly one real task is queued', async () => {
  const before = taskCount();
  const res = await owner.request(`/api/v1/copilot/scripts/${scriptId}/activate`, { method: 'POST', body: {} });
  eq(res.status, 201, `queued (${res.text.slice(0, 400)})`);
  const { draft, task } = res.body;
  taskId = task.id;
  eq(draft.state, 'active', 'the draft is active');
  eq(draft.taskId, task.id, 'and points at its task');
  eq(taskCount(), before + 1, 'exactly one task was created');
  eq(task.status, 'queued', 'the task is queued — nothing has opened a page yet');
  eq(task.driver, 'simulated', 'and the task says which driver it will use');
  eq(task.simulated, true, 'including that it is the test driver');
  eq(task.plan.length, 3, 'with the steps the approved script carried');
  const whoami = (await owner.request('/api/v1/auth/session')).body.principal;
  eq(task.ownerId, whoami.id, 'owned by the principal who ran it');
  const steps = dbm.db.prepare('SELECT * FROM browser_steps WHERE task_id=?').all(task.id);
  assert(steps.length >= 1, 'the task has its own timeline');
});

await check('the draft reports the task’s live state rather than a remembered one', async () => {
  const before = (await owner.request(`/api/v1/copilot/scripts/${scriptId}`)).body.draft;
  eq(before.task.status, 'queued', 'queued to begin with');
  eq(before.task.evidenceCount, 0, 'with no evidence yet');
  // The runner is the only thing that may advance a task; the draft just reads it.
  for (let i = 0; i < 8; i += 1) {
    await runner.tick();
    const t = runner.getTask(taskId);
    if (t && ['failed', 'completed', 'blocked', 'timed_out', 'cancelled', 'waiting_for_user'].includes(t.status)) break;
  }
  const after = (await owner.request(`/api/v1/copilot/scripts/${scriptId}`)).body.draft;
  assert(after.task.status !== 'queued', `the status moved with the runner (got "${after.task.status}")`);
  eq(after.state, 'active', 'the draft stays active — its job is done once the task exists');
  const timeline = dbm.db.prepare('SELECT * FROM browser_steps WHERE task_id=?').all(taskId);
  assert(timeline.length >= 2, `the task recorded a timeline of what it tried (got ${timeline.length} rows)`);
  assert(timeline.some((r) => String(r.status) === 'bad'),
    `including the failure it hit, rather than a tidy story of a run that never happened (statuses: ${timeline.map((r) => r.status).join(',')})`);
  // No page was ever configured for the simulated driver here, so the honest report is a failure — and
  // that is what must be shown. A success would have been a lie.
  assert(['failed', 'blocked', 'timed_out', 'waiting_for_user'].includes(after.task.status),
    `an unrunnable fixture is reported as a failed run, not a completed one (got "${after.task.status}")`);
  assert(after.task.outcome, `with an outcome string (got "${after.task.outcome}")`);
});

await check('a second run is a conflict and queues no second task', async () => {
  const before = taskCount();
  const res = await owner.request(`/api/v1/copilot/scripts/${scriptId}/activate`, { method: 'POST', body: {} });
  eq(res.status, 409, 'already run');
  eq(taskCount(), before, 'no duplicate task');
});

await check('an active script draft cannot be edited or archived', async () => {
  eq((await owner.request(`/api/v1/copilot/scripts/${scriptId}`, { method: 'PATCH', body: { script: GOOD } })).status, 409, 'edit refused');
  eq((await owner.request(`/api/v1/copilot/scripts/${scriptId}/archive`, { method: 'POST', body: {} })).status, 409, 'archive refused');
});

/* ---------- 6. a successful run, with the fixture the test driver needs ---------- */
await check('a run that verifies its criteria is reported as completed, with evidence', async () => {
  const script = {
    objective: 'Read the catalogue heading on the test shop',
    entryUrl: 'https://shop.test/',
    successCriteria: [{ key: 'heading', expect: 'contains:Widgets' }],
    steps: [
      { action: 'goto', url: 'https://shop.test/' },
      { action: 'extract', key: 'heading', selector: 'h1' },
      { action: 'assert', expect: 'Widgets appear on the page', selector: 'h1' },
    ],
  };
  const made = await operator.request('/api/v1/copilot/scripts', { method: 'POST', body: { script } });
  eq(made.status, 201, 'draft created');
  const id = made.body.draft.id;
  const sub = await operator.request(`/api/v1/copilot/scripts/${id}/submit`, { method: 'POST', body: {} });
  eq(sub.status, 200, 'submitted');
  eq((await reviewer.request(`/api/v1/approvals/${sub.body.approvalId}/allow`, { method: 'POST', body: {} })).status, 200, 'allowed');
  const run = await owner.request(`/api/v1/copilot/scripts/${id}/activate`, { method: 'POST', body: {} });
  eq(run.status, 201, 'queued');
  const id2 = run.body.task.id;
  // The simulated driver reads its fixture pages from `sim`, which POST /browser/tasks accepts from a
  // caller and a draft deliberately cannot carry. The test writes the same blob directly, because the
  // thing under test is the draft's reporting, not the driver's fixture plumbing.
  dbm.db.prepare('UPDATE browser_tasks SET sim=? WHERE id=?').run(JSON.stringify({
    pages: {
      'https://shop.test/': { title: 'Catalogue', status: 200, text: 'Widgets for sale', elements: [{ ref: 'h1', name: 'h1', role: 'heading', text: 'Widgets' }] },
    },
  }), id2);
  for (let i = 0; i < 10; i += 1) {
    await runner.tick();
    const t = runner.getTask(id2);
    if (t && ['completed', 'failed', 'blocked', 'timed_out', 'cancelled', 'waiting_for_user'].includes(t.status)) break;
  }
  const detail = runner.getTaskDetail(id2);
  eq(detail.status, 'completed', `the run completed (got "${detail.status}" — ${detail.outcome || detail.blocker || ''})`);
  eq(detail.outcome, 'verified', 'and the outcome says the criteria were verified');
  // The observation the criterion was checked against is in the checkpoint — not a sentence claiming it.
  eq(detail.checkpoint?.observations?.heading, 'Widgets', 'the checkpoint holds what was actually read from the page');
  assert(detail.evidence.length > 0, 'evidence was recorded');
  const draft = (await owner.request(`/api/v1/copilot/scripts/${id}`)).body.draft;
  eq(draft.task.status, 'completed', 'the draft reports the completion');
  assert(draft.task.evidenceCount > 0, 'with the evidence count');
});

/* ---------- 7. denial, permission, scope, restart ---------- */
await check('a denied approval never runs a script', async () => {
  const made = await operator.request('/api/v1/copilot/scripts', { method: 'POST', body: { script: { ...GOOD, objective: 'Read the denied pricing page' } } });
  const id = made.body.draft.id;
  const sub = await operator.request(`/api/v1/copilot/scripts/${id}/submit`, { method: 'POST', body: {} });
  eq(sub.status, 200, 'submitted');
  eq((await reviewer.request(`/api/v1/approvals/${sub.body.approvalId}/deny`, { method: 'POST', body: {} })).status, 200, 'denied');
  const before = taskCount();
  const res = await owner.request(`/api/v1/copilot/scripts/${id}/activate`, { method: 'POST', body: {} });
  eq(res.status, 403, 'running refused');
  assert(/denied/i.test(res.body.error), `with the reason (got "${res.body.error}")`);
  eq(taskCount(), before, 'and no task was queued');
});

await check('an Observer cannot create script drafts, and cannot read someone else’s', async () => {
  eq((await watcher.request('/api/v1/copilot/scripts', { method: 'POST', body: { script: GOOD } })).status, 403, 'no copilot:write');
  eq((await watcher.request('/api/v1/copilot/scripts')).body.drafts.length, 0, 'their own list is empty');
  eq((await watcher.request(`/api/v1/copilot/scripts/${scriptId}`)).status, 404, 'another principal’s script draft is not found');
});

await check('when an Owner both decides and tries to run, the gate refuses the same principal', async () => {
  const made = await operator.request('/api/v1/copilot/scripts', { method: 'POST', body: { script: { ...GOOD, objective: 'Read the self-approved page' } } });
  const id = made.body.draft.id;
  const sub = await operator.request(`/api/v1/copilot/scripts/${id}/submit`, { method: 'POST', body: {} });
  eq(sub.status, 200, 'submitted');
  eq((await owner.request(`/api/v1/approvals/${sub.body.approvalId}/allow`, { method: 'POST', body: {} })).status, 200, 'the Owner allowed it');
  const res = await owner.request(`/api/v1/copilot/scripts/${id}/activate`, { method: 'POST', body: {} });
  eq(res.status, 403, 'the same principal cannot run what it approved');
  assert(/decided by you/i.test(res.body.error), `says so (got "${res.body.error}")`);
});

await check('archiving keeps the row and reports it', async () => {
  const made = await operator.request('/api/v1/copilot/scripts', { method: 'POST', body: { script: { ...GOOD, objective: 'Read the archived pricing page' } } });
  const id = made.body.draft.id;
  const res = await operator.request(`/api/v1/copilot/scripts/${id}/archive`, { method: 'POST', body: {} });
  eq(res.status, 200, 'archived');
  eq(res.body.draft.state, 'archived', 'state is archived');
  eq((await operator.request(`/api/v1/copilot/scripts/${id}`)).status, 200, 'the row is still readable');
});

await check('script drafts and the task they became survive a gateway restart', async () => {
  await new Promise((resolve) => { gateway.server.close(resolve); gateway.server.closeAllConnections?.(); });
  await new Promise((r) => setTimeout(r, 150));
  await start();
  await owner.login('owner@scripts.local', 'OwnerPassw0rd!2026');
  const draft = await owner.request(`/api/v1/copilot/scripts/${scriptId}`);
  eq(draft.status, 200, 'the run script draft is still there');
  eq(draft.body.draft.state, 'active', 'still active');
  eq(draft.body.draft.taskId, taskId, 'still pointing at its task');
  eq(draft.body.draft.task.id, taskId, 'and the task snapshot is still readable');
});

/* ---------- report ---------- */
console.log(results.join('\n'));
console.log(`\nBROWSER SCRIPT DRAFTS: ${results.filter((r) => r.startsWith('PASS')).length} passed, ${failures} failed`);
try { gateway.wss?.close(); } catch { /* ignore */ }
await new Promise((r) => gateway.server.close(r));
try { await new Promise((r) => provider.close(r)); } catch { /* already closed */ }
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failures > 0 ? 1 : 0);
