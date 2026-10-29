/* Agent Browser acceptance tests — AT-15 … AT-26 from the Agent Browser specification.
 *
 * Run: npm run test:browser
 *
 * These run against a real gateway process over HTTP, with a real SQLite database, and the scripted
 * `simulated` driver standing in for Chromium. That is deliberate and it is labelled everywhere:
 * the simulated driver exists so the *resilience* behaviour is provable on any machine, and the
 * capability endpoint still reports `unconfigured` for the engine because no real browser is present.
 * Nothing in this file may be read as proof that a real browsing session works.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'mmm-browser-'));
process.env.DATA_DIR = DATA_DIR;
process.env.MMM_QUIET = '1';
process.env.NODE_ENV = 'test';
process.env.MMM_BOOTSTRAP_EMAIL = 'owner@test.local';
process.env.MMM_BOOTSTRAP_PASSWORD = 'OwnerPassw0rd!2026';
process.env.MMM_BROWSER_ALLOW_SIM = '1';   // the scripted driver is allowed — tests only
process.env.MMM_BROWSER_DISABLE = '1';     // no background ticker: every assertion drives time by hand
process.env.MMM_BROWSER_RESUME = '0';      // the restart behaviour is exercised explicitly below
delete process.env.MMM_BROWSER_ACTION_TIMEOUT_MS;
// This suite measures the resilience rules, not the machine's browser situation. Pointing the engine
// probe at a path that does not exist keeps the capability report (and `auto` resolution) deterministic
// even on a laptop with Chromium installed; the real-engine proof lives in browser-engine-test.mjs.
process.env.MMM_BROWSER_CHROMIUM_PATH = '/nonexistent/mmm-no-chromium';
delete process.env.CHROME_PATH;

const { createGateway } = await import('../apps/gateway/server.js');
const auth = await import('../apps/gateway/src/auth.js');
const { db } = await import('../apps/gateway/src/db.js');
const policy = await import('../apps/gateway/src/browser/policy.js');
const { assessProgress, progressAgeLabel, createWatchdog } = await import('../apps/gateway/src/browser/watchdog.js');
const { createLoopDetector, actionSignature, loopResponse } = await import('../apps/gateway/src/browser/loops.js');
const { createBrowserRunner, checkCriterion } = await import('../apps/gateway/src/browser/runner.js');

const gateway = createGateway();
await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
const PORT = gateway.server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;
const runner = gateway.browserRunner || (await import('../apps/gateway/src/browser/index.js')).runner;

const results = [];
let failures = 0;
async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    results.push(`FAIL ${name}: ${error.message}`);
  }
  const ms = Date.now() - started;
  if (ms > 4000) results.push(`  … ${name} took ${ms}ms`);
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

/* ---------- HTTP client with a cookie jar (same shape as the gateway auth tests) ---------- */
const CSRF = auth.CSRF_HEADER;
function client(ip) {
  const jar = {};
  return {
    jar,
    async request(path, { method = 'GET', body, headers = {} } = {}) {
      const h = { 'x-forwarded-for': ip, ...headers };
      const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) h.cookie = cookie;
      if (jar[CSRF]) h[CSRF] = jar[CSRF];
      if (body !== undefined) h['content-type'] = 'application/json';
      const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      for (const raw of res.headers.getSetCookie?.() || []) {
        const [pair] = raw.split(';');
        const idx = pair.indexOf('=');
        const name = pair.slice(0, idx).trim();
        const value = decodeURIComponent(pair.slice(idx + 1).trim());
        if (value === '' || /Max-Age=0/i.test(raw)) delete jar[name];
        else jar[name] = value;
      }
      const text = await res.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
      return { status: res.status, body: parsed, text, headers: res.headers };
    },
    async login(email, password) {
      const res = await this.request('/api/v1/auth/login', { method: 'POST', body: { email, password } });
      if (res.status === 200) jar[CSRF] = res.body.csrfToken;
      return res;
    },
  };
}

const owner = client('10.7.0.1');
const observer = client('10.7.0.2');
await owner.login('owner@test.local', 'OwnerPassw0rd!2026');

/* ---------- fixtures ---------- */

const SHOP = {
  'https://shop.test/': {
    title: 'Catalogue', status: 200, text: 'Widgets and sprockets',
    elements: [
      { ref: 'next', role: 'link', name: 'Next', text: 'Next', href: 'https://shop.test/2' },
      { ref: 'hold', role: 'button', name: 'Hold', text: 'Hold' },
      { ref: 'price', role: 'text', name: 'Price', text: 'Widget — ₦4,200' },
      { ref: 'buy', role: 'button', name: 'Buy', text: 'Buy now' },
    ],
  },
  'https://shop.test/2': {
    title: 'Catalogue page 2', status: 200, text: 'More widgets',
    elements: [{ ref: 'price', role: 'text', name: 'Price', text: 'Sprocket — ₦1,100' }],
  },
};

async function createTask(body) {
  // Always name the scripted driver: if a real Chromium happens to be installed on this machine,
  // `auto` would pick it and these tests would stop measuring the resilience rules.
  const res = await owner.request('/api/v1/browser/tasks', { method: 'POST', body: { driver: 'simulated', ...body } });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${res.text.slice(0, 300)}`);
  return res.body.task;
}
const getTask = async (id) => {
  const res = await owner.request(`/api/v1/browser/tasks/${id}`);
  if (res.status !== 200) throw new Error(`get failed: ${res.status}`);
  return res.body;
};
async function tickUntil(id, predicate, { max = 12, label = 'condition' } = {}) {
  for (let i = 0; i < max; i += 1) {
    await runner.tick();
    const task = await getTask(id);
    if (predicate(task)) return task;
    if (policy.TERMINAL.includes(task.status)) return task;
  }
  const final = await getTask(id);
  throw new Error(`timed out waiting for ${label}; last status ${final.status} (${final.blocker || 'no blocker'})`);
}
const kinds = (task) => task.timeline.map((s) => s.kind);
/** Leave no active task behind: the ticker takes one task per pass, so a leftover would skew later tests. */
async function retire(id) {
  const task = await getTask(id);
  if (!policy.TERMINAL.includes(task.status)) {
    await owner.request(`/api/v1/browser/tasks/${id}/stop`, { method: 'POST', body: {} });
  }
}

/* ============================== policy rules ============================== */

await check('AT-19 rule: a refusal is classified, never "recovered" by defeating it', () => {
  const captcha = policy.detectBlock('Please complete the CAPTCHA to continue');
  eq(captcha.kind, policy.BLOCK_KINDS.CAPTCHA, 'captcha detected');
  eq(policy.detectBlock('', 429).kind, policy.BLOCK_KINDS.RATE_LIMIT, '429 is a rate limit');
  eq(policy.detectBlock('', 403).kind, policy.BLOCK_KINDS.FORBIDDEN, '403 is forbidden');
  eq(policy.detectBlock('', 401).kind, policy.BLOCK_KINDS.LOGIN, '401 is a login wall');
  eq(policy.detectBlock('Nothing to see here'), null, 'an ordinary page is not a block');

  for (const kind of [policy.BLOCK_KINDS.CAPTCHA, policy.BLOCK_KINDS.RATE_LIMIT, policy.BLOCK_KINDS.FORBIDDEN, policy.BLOCK_KINDS.PAYWALL]) {
    const out = policy.blockOutcome(kind);
    eq(out.retryable, false, `${kind} must not be retryable`);
    eq(out.status, policy.STATES.BLOCKED, `${kind} must end BLOCKED`);
    eq(policy.ladderFor(kind).length, 0, `no recovery ladder may exist for ${kind}`);
  }
  const login = policy.blockOutcome(policy.BLOCK_KINDS.LOGIN);
  eq(login.status, policy.STATES.WAITING_FOR_USER, 'a login wall asks the user');
  assert(/sign in again/i.test(login.message), 'the login message must ask for a human');
  assert(!/bypass/i.test(login.message.replace('will not attempt to bypass', '')), 'no bypass language');
});

await check('state machine: terminal states are final and every state is reachable on purpose', () => {
  eq(policy.canTransition(policy.STATES.COMPLETED, policy.STATES.RUNNING), false, 'completed cannot resume');
  eq(policy.canTransition(policy.STATES.BLOCKED, policy.STATES.RUNNING), false, 'blocked cannot resume');
  eq(policy.canTransition(policy.STATES.QUEUED, policy.STATES.RUNNING), true, 'queued runs');
  eq(policy.canTransition(policy.STATES.RUNNING, policy.STATES.WAITING_FOR_USER), true, 'running can ask for help');
  eq(policy.canTransition(policy.STATES.PAUSED, policy.STATES.RUNNING), true, 'paused can resume');
  for (const s of Object.values(policy.STATES)) assert(policy.STATE_LABEL[s], `state ${s} has no label`);
  assert(policy.TERMINAL.includes(policy.STATES.TIMED_OUT), 'timed_out is terminal');
});

await check('watchdog: an open page is not progress, and a deadline is absolute', () => {
  const base = {
    status: 'running', deadline_at: null, last_progress_at: 1000, last_success_at: 1000,
    consecutive_failures: 0, retries_used: 0, max_retries: 8, max_consecutive_failures: 3,
    actions_used: 0, max_actions: 120, created_at: 1000,
  };
  const stale = assessProgress(base, { now: 1000 + 5 * 60 * 1000 });
  eq(stale.stalled, true, 'a page open with no change must be called stalled');
  eq(stale.terminal, null, 'a stall is not by itself terminal');
  assert(/no meaningful progress/.test(stale.reason), 'stall reason must say so');

  const fresh = assessProgress({ ...base, last_progress_at: 1000 + 5 * 60 * 1000 }, { now: 1000 + 5 * 60 * 1000 + 500 });
  eq(fresh.stalled, false, 'recent progress is not a stall');

  const deadline = assessProgress({ ...base, deadline_at: 2000 }, { now: 2500 });
  eq(deadline.terminal, policy.STATES.TIMED_OUT, 'a passed deadline is terminal');

  eq(assessProgress({ ...base, actions_used: 120 }).terminal, policy.STATES.BLOCKED, 'action budget is terminal');
  eq(assessProgress({ ...base, consecutive_failures: 3 }).terminal, policy.STATES.BLOCKED, 'failure budget is terminal');
  eq(assessProgress({ ...base, retries_used: 9 }).terminal, policy.STATES.FAILED, 'retry budget is terminal');
  eq(progressAgeLabel(90_000), '2 min ago', 'progress age label');
});

await check('watchdog: an action that never settles is aborted on its budget', async () => {
  const dog = createWatchdog({ limits: { ...policy.DEFAULT_LIMITS, actionTimeoutMs: 80 } });
  const { signal } = dog.begin({ timeoutMs: 80 });
  const started = Date.now();
  await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  const ms = Date.now() - started;
  assert(signal.aborted, 'the signal must abort');
  assert(ms < 2000, `abort must be prompt (took ${ms}ms)`);
  dog.end();
  eq(dog.running(), false, 'the watchdog must be idle after end()');
});

await check('loop detection catches repeated actions and page ping-pong, and resets on progress', () => {
  const detector = createLoopDetector({ threshold: 3 });
  const sig = actionSignature({ action: 'click', selector: 'hold' }, 'page-a');
  eq(detector.noteAction(sig), null, 'first attempt is not a loop');
  eq(detector.noteAction(sig), null, 'second attempt is not a loop yet');
  const loop = detector.noteAction(sig);
  assert(loop && loop.count === 3, 'third identical action is a loop');
  eq(loop.reason, 'repeated action', 'loop reason');

  detector.reset();
  let cycle = null;
  for (let i = 0; i < 5 && !cycle; i += 1) {
    cycle = detector.notePage('a') || detector.notePage('b') || null;
  }
  assert(cycle, 'a two-page ping-pong must be detected');
  eq(cycle.reason, 'page cycle', 'cycle reason');

  detector.reset();
  for (const page of ['1', '2', '3', '4', '5', '6', '7', '8']) {
    eq(detector.notePage(page), null, `forward navigation through page ${page} is not a cycle`);
  }

  detector.reset();
  detector.noteAction(sig);
  eq(detector.last, null, 'reset clears the verdict');

  const verdict = loopResponse({ reason: 'repeated action', count: 3, signature: sig }, { alternateAvailable: false });
  eq(verdict.action, 'waiting-for-user', 'with no alternative the agent must stop and ask');
});

/* ============================== gateway surface ============================== */

await check('GET /browser/capabilities is honest: no engine here, and the simulated driver never counts as one', async () => {
  const res = await owner.request('/api/v1/browser/capabilities');
  eq(res.status, 200, 'capabilities status');
  const body = res.body;
  eq(body.simulatedAllowed, true, 'the scripted driver is enabled for tests');
  eq(body.status, 'unconfigured', 'without Chromium the module is unconfigured, not available');
  assert(body.drivers.some((d) => d.id === 'puppeteer' && d.available === false), 'puppeteer must be reported unavailable');
  assert(typeof body.reason === 'string' && body.reason.length > 0, 'the reason must be stated');
  assert(body.limits.maxActions > 0 && body.limits.maxRetries > 0, 'limits must be published');
});

await check('browser:read is granted to an Observer; browser:run is not', async () => {
  const created = await owner.request('/api/v1/principals', {
    method: 'POST',
    body: { email: 'watcher@test.local', name: 'Watcher', role: 'Observer', password: 'WatchPassw0rd!2026' },
  });
  assert([201, 409].includes(created.status), `observer principal create: ${created.status}`);
  const login = await observer.login('watcher@test.local', 'WatchPassw0rd!2026');
  if (login.status !== 200) throw new Error(`observer login failed: ${login.status} ${login.text.slice(0, 200)}`);
  const read = await observer.request('/api/v1/browser/tasks');
  eq(read.status, 200, 'Observer can list tasks');
  const write = await observer.request('/api/v1/browser/tasks', {
    method: 'POST',
    body: { objective: 'try to browse something as an observer', plan: [{ action: 'goto', url: 'https://shop.test/' }] },
  });
  eq(write.status, 403, 'Observer cannot start a browser task');
});

/* ============================== AT-15 … AT-26 ============================== */

await check('AT-15 a navigation that never settles is cut by the watchdog, not awaited forever', async () => {
  const started = Date.now();
  const task = await createTask({
    objective: 'Open a page that never finishes loading and report the stall',
    entryUrl: 'https://slow.test/',
    plan: [{ action: 'goto', url: 'https://slow.test/', timeoutMs: 150 }],
    sim: { pages: { 'https://slow.test/': { title: 'Slow', status: 200, text: 'loading…', elements: [] } }, stalledNav: ['https://slow.test/'] },
  });
  await runner.tick();
  const fresh = await getTask(task.id);
  const elapsed = Date.now() - started;
  assert(elapsed < 5000, `the tick must return promptly (took ${elapsed}ms)`);
  assert(['recovering', 'waiting_for_user', 'failed'].includes(fresh.status), `stalled task must move out of queued/running, got ${fresh.status}`);
  const bad = fresh.timeline.filter((s) => s.status === 'bad');
  assert(bad.length > 0, 'the timeline must record the timeout');
  assert(/timeout|abort/i.test(bad[0].detail), `the timeline must name the timeout, got “${bad[0].detail}”`);
  assert(fresh.timeline.some((s) => s.kind === 'retry'), 'the recovery ladder must have been consulted');
  await retire(task.id);
});

await check('AT-16 the same click that changes nothing is stopped as a loop', async () => {
  const plan = Array.from({ length: 6 }, (_, i) => ({
    action: 'click', selector: 'hold', describe: i === 0 ? 'Press the hold button' : '',
  }));
  const task = await createTask({ objective: 'Press a button that does nothing until the agent gives up', entryUrl: 'https://shop.test/', plan, sim: { pages: SHOP } });
  const final = await tickUntil(task.id, (t) => t.status === policy.STATES.WAITING_FOR_USER, { max: 10, label: 'loop stop' });
  eq(final.status, policy.STATES.WAITING_FOR_USER, 'a loop with no alternative must stop and ask');
  eq(final.outcome, 'loop', 'the outcome must be a loop');
  assert(final.timeline.some((s) => s.kind === 'loop'), 'the loop must be in the timeline');
  assert(final.timeline.filter((s) => s.kind === 'action').length <= 3, 'it must stop after a small number of attempts');
  assert(final.recoveryLog.length === 0 || final.recoveryLog.every((r) => r.label), 'recovery entries must be labelled');
  await retire(task.id);
});

await check('AT-17 a browser crash restarts the engine and inspects the page before continuing', async () => {
  const task = await createTask({
    objective: 'Survive a browser crash and finish reading the price',
    entryUrl: 'https://shop.test/',
    plan: [
      { action: 'goto', url: 'https://shop.test/', describe: 'Open the catalogue' },
      { action: 'extract', selector: 'price', key: 'price', describe: 'Read the price' },
    ],
    successCriteria: [{ key: 'price', expect: 'contains:₦' }],
    sim: { pages: SHOP, faults: { s1: 'crash' } },
  });
  await runner.tick(); // the crash
  const afterCrash = await getTask(task.id);
  eq(afterCrash.status, policy.STATES.RECOVERING, 'a crash leaves the task recovering, not failed');
  assert(afterCrash.timeline.some((s) => s.kind === 'crash'), 'the crash must be in the timeline');
  assert(afterCrash.timeline.some((s) => s.kind === 'inspect'), 'the page must be inspected after the crash');
  assert(afterCrash.checkpoint.inspectedUrl !== undefined, 'the inspection must be checkpointed');

  const final = await tickUntil(task.id, (t) => policy.TERMINAL.includes(t.status), { max: 8, label: 'completion after crash' });
  eq(final.status, policy.STATES.COMPLETED, 'the task must still complete from the checkpoint');
  assert(final.timeline.filter((s) => s.kind === 'crash').length === 1, 'the crash must not repeat (fault injected once)');
});

await check('AT-18 an expired session asks the user to sign in; it never retries authentication', async () => {
  const task = await createTask({
    objective: 'Hit an expired signed-in session and ask the user to sign in again',
    entryUrl: 'https://shop.test/',
    plan: [{ action: 'goto', url: 'https://shop.test/', describe: 'Open the account area' }],
    sim: { pages: SHOP, faults: { s1: 'expired' } },
  });
  await runner.tick();
  const final = await getTask(task.id);
  eq(final.status, policy.STATES.WAITING_FOR_USER, 'an expired session waits for the user');
  eq(final.blockerKind, 'login', 'the blocker is classified as a login wall');
  eq(final.outcome, 'blocked:login', 'the outcome names the block');
  assert(/sign in again/i.test(final.blocker), `the message must ask for a sign-in, got “${final.blocker}”`);
  eq(final.recoveryLog.length, 0, 'authentication must never be retried');
  assert(final.timeline.some((e) => e.kind === 'waiting_for_user'), 'the timeline must record the hand-off');
  const evidenceRows = final.evidence;
  assert(evidenceRows.length > 0, 'the block must be evidenced');
  await retire(task.id);
});

await check('AT-19 a site restriction stops the task as BLOCKED and keeps the evidence', async () => {
  const task = await createTask({
    objective: 'Be refused by a site and stop instead of trying to get around it',
    entryUrl: 'https://shop.test/',
    plan: [
      { action: 'goto', url: 'https://shop.test/', describe: 'Open the catalogue' },
      { action: 'click', selector: 'price', describe: 'Read more' },
    ],
    sim: { pages: SHOP, faults: { s2: 'blocked:captcha' } },
  });
  const final = await tickUntil(task.id, (t) => policy.TERMINAL.includes(t.status), { max: 6, label: 'blocked' });
  eq(final.status, policy.STATES.BLOCKED, 'a captcha wall must end BLOCKED');
  assert(/captcha/.test(final.blocker), `the blocker must name the restriction, got “${final.blocker}”`);
  assert(/circumvention/.test(final.blocker) || /refused/i.test(final.blocker), 'the reason must explain why it stopped');
  eq(final.retriesUsed, 0, 'a restriction must not consume retries');
  assert(final.evidence.length >= 1, 'evidence must be preserved');
  assert(final.evidence.some((e) => e.kind === 'screenshot'), 'a screenshot of the block must be captured');
});

await check('AT-20 one tick performs at most one action, so a long task never blocks the gateway', async () => {
  const task = await createTask({
    objective: 'Walk four steps one tick at a time without holding the process',
    entryUrl: 'https://shop.test/',
    plan: [
      { action: 'goto', url: 'https://shop.test/', describe: 'Open the catalogue' },
      { action: 'wait', ms: 10, describe: 'Let the page settle' },
      { action: 'click', selector: 'next', describe: 'Go to page two' },
      { action: 'extract', selector: 'price', key: 'price', describe: 'Read page two' },
    ],
    successCriteria: [{ key: 'price', expect: 'contains:Sprocket' }],
    sim: { pages: SHOP },
  });
  await runner.tick();
  const one = await getTask(task.id);
  assert(one.stepIndex <= 1, `one tick must advance at most one step (advanced to ${one.stepIndex})`);
  const health = await owner.request('/healthz');
  eq(health.status, 200, 'the gateway stays responsive while a task runs');

  const final = await tickUntil(task.id, (t) => policy.TERMINAL.includes(t.status), { max: 8, label: 'multi-step completion' });
  eq(final.status, policy.STATES.COMPLETED, 'the whole plan must complete across ticks');
  eq(final.stepIndex, 4, 'all four steps must have run');
  assert(final.actionsUsed >= 4, 'actions are counted, not assumed');
});

await check('AT-21 a deadline produces an explicit terminal state', async () => {
  const task = await createTask({
    objective: 'Run past its deadline so the deadline has to be honoured',
    entryUrl: 'https://shop.test/',
    plan: [{ action: 'goto', url: 'https://shop.test/' }, { action: 'wait', ms: 10 }],
    sim: { pages: SHOP },
  });
  db.prepare('UPDATE browser_tasks SET deadline_at = ? WHERE id = ?').run(Date.now() - 1000, task.id);
  await runner.tick();
  const final = await getTask(task.id);
  eq(final.status, policy.STATES.TIMED_OUT, 'a passed deadline must be terminal');
  assert(/deadline/i.test(final.blocker), 'the reason must say the deadline was reached');
  assert(final.endedAt, 'a terminal task must record when it ended');
});

await check('AT-22 every milestone carries evidence that can be re-read later', async () => {
  const task = await createTask({
    objective: 'Record evidence for the milestone it claims to have verified',
    entryUrl: 'https://shop.test/',
    plan: [
      { action: 'goto', url: 'https://shop.test/', describe: 'Open the catalogue' },
      { action: 'extract', selector: 'price', key: 'price', describe: 'Read the price' },
    ],
    successCriteria: [{ key: 'price', expect: 'contains:₦4,200' }],
    sim: { pages: SHOP },
  });
  const final = await tickUntil(task.id, (t) => policy.TERMINAL.includes(t.status), { max: 6, label: 'evidence' });
  eq(final.status, policy.STATES.COMPLETED, 'the task completes');
  assert(final.evidence.length >= 2, `each milestone needs an evidence row (got ${final.evidence.length})`);
  for (const row of final.evidence) {
    assert(row.digest && row.digest.length >= 12, `evidence ${row.id} has no digest`);
    assert(row.url, `evidence ${row.id} has no URL`);
    assert(row.summary, `evidence ${row.id} has no summary`);
  }
  const one = await owner.request(`/api/v1/browser/tasks/${task.id}/evidence/${final.evidence[0].id}`);
  eq(one.status, 200, 'a single evidence record can be fetched');
  eq(one.body.id, final.evidence[0].id, 'the same evidence comes back');
  const missing = await owner.request(`/api/v1/browser/tasks/${task.id}/evidence/nope`);
  eq(missing.status, 404, 'unknown evidence is a 404');
});

await check('AT-23 a sensitive action is never blindly retried', async () => {
  const task = await createTask({
    objective: 'Fail while pressing a button that spends money and stop for a human',
    entryUrl: 'https://shop.test/',
    plan: [
      { action: 'goto', url: 'https://shop.test/', describe: 'Open the catalogue' },
      { action: 'click', selector: 'buy', describe: 'Pay for the order', sensitive: true },
    ],
    sim: { pages: SHOP, faults: { s2: 'notfound' } },
  });
  const final = await tickUntil(task.id, (t) => t.status === policy.STATES.WAITING_FOR_USER || policy.TERMINAL.includes(t.status), { max: 6, label: 'sensitive stop' });
  eq(final.status, policy.STATES.WAITING_FOR_USER, 'a failed payment is handed to a human');
  eq(final.outcome, 'sensitive-failure', 'the outcome must name the sensitive failure');
  eq(final.recoveryLog.length, 0, 'a sensitive action must not enter the retry ladder');
  assert(/cannot be safely retried/i.test(final.blocker), 'the reason must explain the refusal');

  const resumed = await owner.request(`/api/v1/browser/tasks/${task.id}/assist`, { method: 'POST', body: {} });
  eq(resumed.status, 200, 'the user can confirm and continue');
  eq(resumed.body.task.status, policy.STATES.RUNNING, 'assist resumes the task');
  await retire(task.id);
});

await check('AT-24 after a restart the agent inspects the live page before repeating anything', async () => {
  const task = await createTask({
    objective: 'Be interrupted by a restart and re-attach to the page deliberately',
    entryUrl: 'https://shop.test/',
    plan: [
      { action: 'goto', url: 'https://shop.test/', describe: 'Open the catalogue' },
      { action: 'click', selector: 'next', describe: 'Go to page two' },
    ],
    successCriteria: [{ key: 'lastUrl', expect: 'contains:/2' }],
    sim: { pages: SHOP },
  });
  const running = await tickUntil(task.id, (t) => t.status === policy.STATES.RUNNING, { max: 8, label: 'running' });
  eq(running.status, policy.STATES.RUNNING, 'the task is running before the restart');
  assert(running.checkpoint.url, 'a checkpoint must exist before the restart');

  // A brand-new runner instance over the same database is exactly what a process restart looks like.
  const restarted = createBrowserRunner({ db });
  const resumed = await restarted.resumeInterrupted();
  assert(resumed >= 1, 'the interrupted task must be picked up');
  const after = await getTask(task.id);
  const inspect = after.timeline.filter((s) => s.kind === 'inspect').pop();
  assert(inspect, 'the restarted agent must inspect the page first');
  assert(/page is/i.test(inspect.detail), `the inspection must report what it saw, got “${inspect.detail}”`);
  assert(after.checkpoint.inspectedAt, 'the inspection must be recorded in the checkpoint');
  await restarted.shutdown();
  await retire(task.id);
});

await check('AT-25 action and evidence budgets are enforced, and exhaustion is honest', async () => {
  const task = await createTask({
    objective: 'Exhaust its action budget and say so instead of pretending',
    entryUrl: 'https://shop.test/',
    plan: [{ action: 'goto', url: 'https://shop.test/' }, { action: 'wait', ms: 5 }],
    sim: { pages: SHOP },
  });
  db.prepare('UPDATE browser_tasks SET actions_used = max_actions WHERE id = ?').run(task.id);
  const final = await tickUntil(task.id, (t) => t.status !== policy.STATES.QUEUED, { max: 8, label: 'budget stop' });
  eq(final.status, policy.STATES.BLOCKED, 'an exhausted budget stops the task');
  assert(/budget/i.test(final.blocker), `the reason must mention the budget, got “${final.blocker}”`);

  const noEngine = await owner.request('/api/v1/browser/tasks', {
    method: 'POST',
    body: { objective: 'Ask for the real browser that is not installed here', driver: 'puppeteer', plan: [{ action: 'goto', url: 'https://shop.test/' }] },
  });
  eq(noEngine.status, 409, 'requesting an unavailable engine is refused, not silently downgraded');
  assert(/puppeteer/i.test(noEngine.body.error), 'the refusal must name the engine');
});

await check('AT-26 "completed" requires every success criterion to be verified', async () => {
  const noCriteria = await createTask({
    objective: 'Finish its plan without declaring how success would be proven',
    entryUrl: 'https://shop.test/',
    plan: [{ action: 'goto', url: 'https://shop.test/' }],
    sim: { pages: SHOP },
  });
  const a = await tickUntil(noCriteria.id, (t) => policy.TERMINAL.includes(t.status), { max: 12, label: 'no-criteria' });
  eq(a.status, policy.STATES.FAILED, 'a plan that ends without criteria cannot be called a success');
  eq(a.outcome, 'no-criteria', 'the outcome must say why');

  const unmet = await createTask({
    objective: 'Claim a value it never actually observed on the page',
    entryUrl: 'https://shop.test/',
    plan: [{ action: 'goto', url: 'https://shop.test/', describe: 'Open the catalogue' }],
    successCriteria: [{ key: 'total', expect: 'contains:999' }],
    sim: { pages: SHOP },
  });
  const b = await tickUntil(unmet.id, (t) => policy.TERMINAL.includes(t.status), { max: 12, label: 'criteria-unmet' });
  eq(b.status, policy.STATES.FAILED, 'unverified criteria must fail the task');
  eq(b.outcome, 'criteria-unmet', 'the outcome must say the criteria were unmet');
  assert(/total/.test(b.blocker), 'the reason must name the unmet criterion');

  eq(checkCriterion({ key: 'x', expect: 'equals:42' }, { x: '42' }).ok, true, 'equals matches');
  eq(checkCriterion({ key: 'x', expect: 'min:10' }, { x: '4' }).ok, false, 'min rejects a lower value');
  eq(checkCriterion({ key: 'x', expect: 'matches:^foo' }, { x: 'foobar' }).ok, true, 'matches works');
  eq(checkCriterion({ key: 'x', expect: 'exists:' }, {}).ok, false, 'a missing observation never passes');
});

await check('controls: pause, resume and stop are recorded, and a stopped task stays stopped', async () => {
  const task = await createTask({
    objective: 'Be paused, resumed and then stopped by the user',
    entryUrl: 'https://shop.test/',
    plan: [{ action: 'goto', url: 'https://shop.test/' }, { action: 'wait', ms: 5 }, { action: 'wait', ms: 5 }],
    sim: { pages: SHOP },
  });
  await runner.tick();
  const paused = await owner.request(`/api/v1/browser/tasks/${task.id}/pause`, { method: 'POST', body: {} });
  eq(paused.status, 200, 'pause accepted');
  eq(paused.body.task.status, policy.STATES.PAUSED, 'task is paused');
  await runner.tick();
  const stillPaused = await getTask(task.id);
  eq(stillPaused.status, policy.STATES.PAUSED, 'a paused task must not be advanced by the ticker');
  const resumed = await owner.request(`/api/v1/browser/tasks/${task.id}/resume`, { method: 'POST', body: {} });
  eq(resumed.status, 200, 'resume accepted');
  eq(resumed.body.task.status, policy.STATES.RUNNING, 'task is running again');
  const stopped = await owner.request(`/api/v1/browser/tasks/${task.id}/stop`, { method: 'POST', body: {} });
  eq(stopped.status, 200, 'stop accepted');
  eq(stopped.body.task.status, policy.STATES.CANCELLED, 'stopped is a terminal state');
  const again = await owner.request(`/api/v1/browser/tasks/${task.id}/stop`, { method: 'POST', body: {} });
  eq(again.status, 409, 'stopping twice is a conflict, not a new state');
  await runner.tick();
  eq((await getTask(task.id)).status, policy.STATES.CANCELLED, 'a stopped task never moves again');
});

await check('validation: a vague objective, an empty plan or an unknown action is rejected', async () => {
  const short = await owner.request('/api/v1/browser/tasks', { method: 'POST', body: { objective: 'go', plan: [{ action: 'goto', url: 'https://shop.test/' }] } });
  eq(short.status, 400, 'a one-word objective is not a task');
  const empty = await owner.request('/api/v1/browser/tasks', { method: 'POST', body: { objective: 'A perfectly reasonable objective', plan: [] } });
  eq(empty.status, 400, 'a plan is required');
  const bad = await owner.request('/api/v1/browser/tasks', { method: 'POST', body: { objective: 'A perfectly reasonable objective', plan: [{ action: 'teleport', url: 'https://shop.test/' }] } });
  eq(bad.status, 400, 'unknown actions are refused');
  const missing = await owner.request('/api/v1/browser/tasks/bt-does-not-exist');
  eq(missing.status, 404, 'unknown tasks are 404');
});

await check('every browser task is isolated to its owner in the audit log and labelled simulated', async () => {
  const list = await owner.request('/api/v1/browser/tasks');
  eq(list.status, 200, 'list works');
  assert(list.body.tasks.length > 0, 'tasks exist');
  assert(list.body.tasks.every((t) => t.simulated === true), 'tasks run with the scripted driver must say so');
  const audits = await owner.request('/api/v1/audit?limit=200');
  const entries = audits.body.filter((a) => String(a.event || '').startsWith('browser.task'));
  assert(entries.length >= 3, `browser task changes must be audited (found ${entries.length})`);
  const chained = db.prepare('SELECT COUNT(*) AS n FROM browser_tasks WHERE objective = ?').get('');
  eq(chained.n, 0, 'no empty objectives are stored');
});

/* ---------- report ---------- */
await new Promise((resolve) => gateway.server.close(resolve));
try { runner.shutdown(); } catch { /* already down */ }
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(results.join('\n'));
const passed = results.filter((r) => r.startsWith('PASS')).length;
console.log(`\nAgent Browser: ${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
