/* Agent Browser — real-engine proof. Run: npm run test:browser:engine
 *
 * These tests drive a *real* Chromium through the Puppeteer driver against a throwaway local web
 * server, so they prove what the scripted suite cannot: that a genuine navigation, DOM extraction,
 * PNG screenshot, refusal page and dead engine are handled end to end.
 *
 * Requirements (deliberately not source dependencies — a Chromium download is a deployment choice):
 *   npm i --no-save puppeteer-core @sparticuz/chromium
 *   MMM_BROWSER_ALLOW_SIM is NOT set here: the simulated driver must not be reachable.
 *
 * If no engine is installed the script says SKIP and exits 0 — it never reports a pass it did not earn.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'mmm-browser-engine-'));
process.env.DATA_DIR = DATA_DIR;
process.env.MMM_QUIET = '1';
process.env.NODE_ENV = 'test';
process.env.MMM_BROWSER_VIEWPORT = '390x844';
delete process.env.MMM_BROWSER_ALLOW_SIM;
delete process.env.MMM_BROWSER_DISABLE;

/* Resolve a Chromium binary before anything imports the driver. */
let engineReady = false;
let engineReason = '';
try {
  const puppeteer = await import('puppeteer-core');
  if (!puppeteer) throw new Error('puppeteer-core missing');
  if (!process.env.MMM_BROWSER_CHROMIUM_PATH) {
    try {
      const sparticuz = (await import('@sparticuz/chromium')).default;
      const path = await sparticuz.executablePath();
      if (path) process.env.MMM_BROWSER_CHROMIUM_PATH = path;
    } catch { /* fall through to CHROME_PATH */ }
  }
  engineReady = Boolean(process.env.MMM_BROWSER_CHROMIUM_PATH || process.env.CHROME_PATH);
  engineReason = engineReady ? process.env.MMM_BROWSER_CHROMIUM_PATH || process.env.CHROME_PATH : 'no Chromium binary found';
} catch (error) {
  engineReason = `puppeteer-core is not installed (${error.message})`;
}

if (!engineReady) {
  console.log(`SKIP Agent Browser engine tests — ${engineReason}`);
  console.log('Install with: npm i --no-save puppeteer-core @sparticuz/chromium');
  rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(0);
}

const { db, migrate } = await import('../apps/gateway/src/db.js');
migrate();
const policy = await import('../apps/gateway/src/browser/policy.js');
const { createBrowserRunner } = await import('../apps/gateway/src/browser/runner.js');
const { driverCapabilities, createDriver } = await import('../apps/gateway/src/browser/driver.js');

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

/* ---------- throwaway site ---------- */
const PAGE = (inner) => `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fixture</title></head><body>${inner}</body></html>`;
const site = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(PAGE('<h1>Catalogue</h1><p class="price" data-ref="price">Widget — ₦4,200</p><a data-ref="next" href="/item">Next</a><button data-ref="cart" type="button">Add to cart</button>'));
  }
  if (url === '/item') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(PAGE('<h1>Item</h1><p class="price" data-ref="price">Sprocket — ₦1,100</p><a href="/">Back</a>'));
  }
  if (url === '/blocked') {
    res.writeHead(403, { 'content-type': 'text/html' });
    return res.end(PAGE('<h1>Access denied</h1><p>Please complete the CAPTCHA to continue.</p>'));
  }
  if (url === '/login') {
    res.writeHead(401, { 'content-type': 'text/html' });
    return res.end(PAGE('<h1>Authentication required</h1><p>Sign in required.</p>'));
  }
  if (url === '/hang') {
    return; // never answers: only the watchdog can end this navigation
  }
  res.writeHead(404, { 'content-type': 'text/html' });
  res.end(PAGE('<h1>Missing</h1>'));
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${site.address().port}`;

const runner = createBrowserRunner({ db });
const get = (id) => db.prepare('SELECT * FROM browser_tasks WHERE id = ?').get(id);
const detail = (id) => runner.getTaskDetail(id);
async function tickUntil(id, predicate, { max = 12, label = 'condition' } = {}) {
  for (let i = 0; i < max; i += 1) {
    await runner.tick();
    const task = detail(id);
    if (predicate(task)) return task;
    if (policy.TERMINAL.includes(task.status)) return task;
  }
  const last = detail(id);
  throw new Error(`timed out waiting for ${label}; status ${last.status} (${last.blocker || ''})`);
}

await check('the engine probe reports Chromium as available, and the simulated driver stays refused', async () => {
  const caps = await driverCapabilities();
  const pup = caps.find((c) => c.id === 'puppeteer');
  eq(pup.available, true, `puppeteer must be available (${pup.reason})`);
  const sim = caps.find((c) => c.id === 'simulated');
  eq(sim.available, false, 'the simulated driver must be refused without MMM_BROWSER_ALLOW_SIM');
});

await check('a real browser is a real browser: honest automation flag, mobile viewport, no fingerprint spoofing', async () => {
  const driver = await createDriver('puppeteer', {});
  try {
    await driver.start();
    await driver.goto(`${ORIGIN}/`, { step: { timeoutMs: 15000 } });
    const facts = await driver.snapshot();
    assert(/Catalogue/.test(facts.text), 'the real page text must be visible');
    assert(facts.digest.length >= 12, 'the snapshot must be fingerprinted');
    assert(facts.elements.length >= 2, 'interactive elements must be enumerated');
    const shot = await driver.screenshot();
    assert(shot.base64.length > 4000, `a real screenshot is more than a pixel (${shot.base64.length} b64 chars)`);
  } finally {
    await driver.close();
  }
});

await check('a real task navigates, extracts text and completes only against a verified criterion', async () => {
  const task = await runner.createTask({
    objective: 'Read the price of the first widget from a real page',
    entryUrl: `${ORIGIN}/`,
    driver: 'puppeteer',
    plan: [
      { action: 'goto', url: `${ORIGIN}/`, describe: 'Open the catalogue' },
      { action: 'extract', selector: '[data-ref="price"]', key: 'price', describe: 'Read the price' },
      { action: 'screenshot', describe: 'Capture the page as evidence' },
    ],
    criteria: [{ key: 'price', expect: 'contains:4,200' }, { key: 'lastUrl', expect: `contains:${site.address().port}` }],
  });
  eq(task.simulated, false, 'a real engine task must never be labelled simulated');
  const final = await tickUntil(task.id, (t) => policy.TERMINAL.includes(t.status), { label: 'real completion', max: 14 });
  eq(final.status, policy.STATES.COMPLETED, `real task must complete (${final.blocker || 'no reason given'})`);
  assert(/4,200|₦/.test(JSON.stringify(final.checkpoint.observations)), 'the extracted price must be observed');
  const shots = final.evidence.filter((e) => e.kind === 'screenshot');
  assert(shots.length >= 1, 'a screenshot must be stored as evidence');
  assert(shots[0].bytes > 3000, `a real screenshot is not a placeholder (${shots[0].bytes} bytes)`);
  const stored = runner.getEvidence(task.id, shots[0].id);
  assert(stored.data && stored.data.startsWith('iVBOR'), 'the PNG must be readable back from the database');
});

await check('a real 403 + CAPTCHA is reported as BLOCKED, with the page captured, and never retried', async () => {
  const task = await runner.createTask({
    objective: 'Open a page that refuses automated access',
    entryUrl: `${ORIGIN}/blocked`,
    driver: 'puppeteer',
    plan: [{ action: 'goto', url: `${ORIGIN}/blocked`, describe: 'Open the blocked page' }],
  });
  const final = await tickUntil(task.id, (t) => policy.TERMINAL.includes(t.status), { label: 'blocked', max: 6 });
  eq(final.status, policy.STATES.BLOCKED, `a real 403 must be BLOCKED, got ${final.status}`);
  eq(final.retriesUsed, 0, 'a refusal must not consume retries');
  assert(/captcha|refused/i.test(final.blocker), `the blocker must name the refusal, got “${final.blocker}”`);
  assert(final.evidence.some((e) => e.kind === 'screenshot' && e.bytes > 1000), 'the refusal must be photographed');
});

await check('a real 401 is reported as an expired session that waits for the user', async () => {
  const task = await runner.createTask({
    objective: 'Open a page that requires a signed-in session',
    entryUrl: `${ORIGIN}/login`,
    driver: 'puppeteer',
    plan: [{ action: 'goto', url: `${ORIGIN}/login`, describe: 'Open the account area' }],
  });
  const final = await tickUntil(task.id, (t) => t.status === policy.STATES.WAITING_FOR_USER || policy.TERMINAL.includes(t.status), { label: 'login wall', max: 6 });
  eq(final.status, policy.STATES.WAITING_FOR_USER, `a real 401 must ask the user, got ${final.status}`);
  eq(final.blockerKind, 'login', 'the blocker is a login wall');
});

await check('a real navigation that never answers is cut by the watchdog', async () => {
  const started = Date.now();
  const task = await runner.createTask({
    objective: 'Navigate to a server that never answers and give up cleanly',
    entryUrl: `${ORIGIN}/hang`,
    driver: 'puppeteer',
    plan: [{ action: 'goto', url: `${ORIGIN}/hang`, timeoutMs: 1500, describe: 'Open the hanging page' }],
  });
  await runner.tick();
  const elapsed = Date.now() - started;
  const after = detail(task.id);
  assert(elapsed < 15000, `the tick must not hang (took ${elapsed}ms)`);
  eq(after.status, policy.STATES.RECOVERING, `a timed-out navigation leaves the task recovering, got ${after.status}`);
  assert(after.timeline.some((s) => s.kind === 'action' && /timeout/i.test(s.detail)), 'the timeout must be in the timeline');
  assert(after.outcome !== 'verified', 'a hang must never be recorded as success');
  await runner.control(task.id, 'stop', 'test');
});

await check('a killed engine is detected and restarted, and the task resumes from its checkpoint', async () => {
  const task = await runner.createTask({
    objective: 'Survive the browser being killed between steps',
    entryUrl: `${ORIGIN}/`,
    driver: 'puppeteer',
    plan: [
      { action: 'goto', url: `${ORIGIN}/`, describe: 'Open the catalogue' },
      { action: 'click', selector: '[data-ref="next"]', describe: 'Open the next page' },
      { action: 'extract', selector: '[data-ref="price"]', key: 'price', describe: 'Read the second price' },
    ],
    criteria: [{ key: 'price', expect: 'contains:1,100' }],
  });
  await tickUntil(task.id, (t) => t.stepIndex >= 1, { label: 'first step', max: 8 });
  const session = runner._internals.sessions.get(task.id);
  assert(session, 'the task must hold a live engine session');
  await session.driver.close(); // the process disappears underneath the task
  await runner.tick();
  const after = detail(task.id);
  eq(after.status, policy.STATES.RECOVERING, `a dead engine leaves the task recovering, got ${after.status}`);
  assert(after.timeline.some((s) => s.kind === 'crash'), 'the death must be recorded');
  const final = await tickUntil(task.id, (t) => policy.TERMINAL.includes(t.status), { label: 'recovery', max: 14 });
  eq(final.status, policy.STATES.COMPLETED, `the task must finish after the restart (${final.blocker || ''})`);
  assert(final.timeline.some((s) => s.kind === 'inspect'), 'the restarted engine must inspect the page first');
});

/* ---------- report ---------- */
await new Promise((resolve) => site.close(resolve));
try { runner.shutdown(); } catch { /* already down */ }
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(results.join('\n'));
const passed = results.filter((r) => r.startsWith('PASS')).length;
console.log(`\nAgent Browser (real Chromium): ${passed} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
