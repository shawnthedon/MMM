/* Agent Browser screen tests — the visibility surface must be honest and mobile-first.
 * Run: npm run test:browser-ui
 *
 * What is verified:
 *   1. the panel never renders a start button when the gateway cannot run a task;
 *   2. an unconfigured engine is reported with the driver reasons, not a fake session;
 *   3. a real task shows its status, simulated/real label, time since meaningful progress,
 *      recovery counters, blocker and evidence;
 *   4. "Completed" only appears for a completed task, and a waiting task offers the honest action;
 *   5. the stylesheet stays mobile-first (no max-width queries, 44px targets).
 */
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const css = readFileSync(join(root, 'src/browser.css'), 'utf8');

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

/* ---------- 1. CSS ---------- */
await check('the screen is mobile-first: no max-width queries, one column at 320px, 44px targets', () => {
  assert(!/@media\s*\(max-width/.test(css), 'browser.css must not use max-width media queries');
  const grid = css.match(/\.bx-grid \{[^}]*\}/);
  assert(grid, '.bx-grid rule missing');
  assert(/grid-template-columns:\s*1fr/.test(grid[0]), 'the base layout must be a single column');
  assert(/@media \(min-width: 900px\)/.test(css), 'the two-column layout must be a min-width enhancement');
  const buttons = css.match(/\.bx-controls \.btn \{[^}]*\}/);
  assert(buttons && /min-height:\s*44px/.test(buttons[0]), 'task controls need 44px touch targets');
  assert(/\.bx-task \{[^}]*min-height:\s*44px/.test(css), 'task tiles need 44px touch targets');
  assert(!/#[0-9a-fA-F]{3,6}\b/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'no hard-coded hex colours — tokens only');
  assert(/overflow-wrap:\s*anywhere/.test(css), 'long URLs and objectives must wrap, never clip');
});

/* ---------- 2. DOM harness ---------- */
const win = new Window({ url: 'http://localhost:5173/#/home' });
for (const k of ['document', 'navigator', 'location', 'localStorage', 'history', 'HTMLElement',
  'Event', 'CustomEvent', 'KeyboardEvent', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame', 'Blob']) {
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

/* A gateway mock: reply per path, so the screen reads exactly what a real gateway would send. */
let gatewayMode = 'unconfigured';
let fetchCalls = [];
const CAPS_UNAVAILABLE = {
  status: 'unconfigured',
  engine: null,
  simulatedAllowed: false,
  active: 0,
  counts: {},
  limits: { actionTimeoutMs: 20000, maxRetries: 8, maxConsecutiveFailures: 3, maxActions: 120 },
  drivers: [
    { id: 'puppeteer', label: 'Puppeteer / Chromium', kind: 'engine', available: false, reason: 'puppeteer-core is not installed on the gateway host' },
    { id: 'simulated', label: 'Simulated pages (tests only)', kind: 'test-only', available: false, reason: 'test-only driver; set MMM_BROWSER_ALLOW_SIM=1 to enable' },
  ],
  reason: 'puppeteer: not installed',
};
const task = (over = {}) => ({
  id: 'bt-1', objective: 'Read the price of the first plan', status: 'running', driver: 'puppeteer', simulated: false,
  entryUrl: 'https://shop.example/pricing', currentUrl: 'https://shop.example/pricing',
  lastMilestone: 'Opened https://shop.example/pricing — “Pricing”', lastProgressAt: Date.now() - 12_000,
  progressAgeMs: 12_000, lastSuccessAt: Date.now() - 12_000, stepIndex: 1, totalSteps: 3, actionsUsed: 2, maxActions: 120,
  retriesUsed: 1, maxRetries: 8, consecutiveFailures: 0, maxConsecutiveFailures: 3, evidenceBytes: 2048,
  blocker: '', blockerKind: null, outcome: '', checkpoint: { stepIndex: 1, url: 'https://shop.example/pricing' },
  recoveryLog: [{ stepId: 's1', obstacle: 'timeout', attempt: 'settle', label: 'Wait for the expected page state' }],
  timeline: [
    { seq: 1, ts: Date.now() - 20_000, kind: 'created', status: 'info', detail: 'Queued with 3 steps', attempt: 0, duration_ms: 0 },
    { seq: 2, ts: Date.now() - 12_000, kind: 'action', status: 'ok', stepId: 's1', detail: 'Opened https://shop.example/pricing', attempt: 0, duration_ms: 812 },
  ],
  evidence: [
    { id: 'be-1', kind: 'screenshot', label: 's1', summary: 'Opened https://shop.example/pricing — “Pricing”', url: 'https://shop.example/pricing', digest: 'abc123def456', bytes: 2048 },
  ],
  ...over,
});

globalThis.fetch = async (input) => {
  const url = String(typeof input === 'string' ? input : input.url);
  fetchCalls.push(url);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/api/v1/browser/capabilities')) {
    if (gatewayMode === 'down') return json({ error: 'unavailable' }, 503);
    if (gatewayMode === 'unconfigured') return json(CAPS_UNAVAILABLE);
    return json({ ...CAPS_UNAVAILABLE, status: 'available', engine: { id: 'puppeteer', label: 'Puppeteer / Chromium' }, drivers: [{ ...CAPS_UNAVAILABLE.drivers[0], available: true, reason: 'chromium at /usr/bin/chromium' }], active: 1 });
  }
  if (/\/api\/v1\/browser\/tasks\/[^/]+\/evidence\//.test(url)) return json({ id: 'be-1', kind: 'extract', label: 's2', summary: 'Read the price', url: 'https://shop.example/pricing', digest: 'abc123def456', bytes: 40, data: 'Widget — 4,200' });
  if (/\/api\/v1\/browser\/tasks\/[^/]+$/.test(url)) {
    if (gatewayMode === 'running') return json(task());
    if (gatewayMode === 'waiting') return json(task({ status: 'waiting_for_user', blocker: 'The site requires you to sign in again. The agent will not attempt to bypass authentication.', blockerKind: 'login', progressAgeMs: 120_000 }));
    if (gatewayMode === 'done') return json(task({ status: 'completed', simulated: true, driver: 'simulated', blocker: 'All 2 success criteria verified against 2 evidence records', outcome: 'verified', endedAt: Date.now() }));
    if (gatewayMode === 'down') return json({ error: 'unavailable' }, 503);
  }
  if (url.includes('/api/v1/browser/tasks')) {
    if (gatewayMode === 'down') return json({ error: 'unavailable' }, 503);
    if (gatewayMode === 'unconfigured') return json({ tasks: [] });
    if (gatewayMode === 'running') return json({ tasks: [task()] });
    if (gatewayMode === 'waiting') return json({ tasks: [task({ status: 'waiting_for_user', blocker: 'sign in again', blockerKind: 'login' })] });
    if (gatewayMode === 'done') return json({ tasks: [task({ status: 'completed', simulated: true, outcome: 'verified' })] });
  }
  return json({}, 404);
};

await import('../src/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(140);

const nav = await import('../src/main.js');
const api = await import('../src/api.js');
const browserView = await import('../src/browser.js');
const shell = await import('../src/shell.js');
const doc = win.document;
const q = (sel, r = doc) => r.querySelector(sel);
const qa = (sel, r = doc) => [...r.querySelectorAll(sel)];
const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
const click = (el) => el?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

async function openBrowser() {
  shell.closeAllSheets();
  nav.navigate('browser');
  await sleep(120);
  return q('#view');
}

/* ---------- 3. no gateway ---------- */
await check('with no gateway the screen says so and offers no controls', async () => {
  const view = await openBrowser();
  assert(/Agent Browser/.test(text(q('h1', view))), 'screen title missing');
  assert(/runs on the gateway/i.test(text(view)), 'must explain that browsing happens on the gateway');
  eq(q('[data-act="bx-create"]', view), null, 'no start button without a gateway');
  eq(q('[data-act="bx-control"]', view), null, 'no task controls without a gateway');
  assert(!/No browser tasks yet/.test(text(view)), 'must not show an empty task list it cannot know about');
});

/* ---------- 4. gateway, no engine ---------- */
await check('an unconfigured engine is reported with reasons and still shows no start button', async () => {
  api.setGatewayUrl('http://gateway.test');
  const view = await openBrowser();
  const body = text(view);
  assert(/No browser engine is installed/i.test(body), 'must state the engine is missing');
  assert(/puppeteer-core is not installed/i.test(body), 'must quote the real driver reason');
  assert(/test-only driver/i.test(body), 'must explain the simulated driver is test-only');
  assert(/MMM_BROWSER_CHROMIUM_PATH|npm install puppeteer/.test(body), 'must tell the operator how to fix it');
  eq(q('[data-act="bx-create"]', view), null, 'cannot start a task without an engine');
});

/* ---------- 5. a running task ---------- */
await check('a running task shows status, progress age, recovery attempts and evidence', async () => {
  gatewayMode = 'running';
  const view = await openBrowser();
  const tiles = qa('.bx-task', view);
  eq(tiles.length, 1, 'one task tile');
  assert(/Running/.test(text(tiles[0])), 'status label');
  assert(/Chromium/.test(text(tiles[0])), 'a real engine task must be labelled Chromium');
  assert(/last progress 12s ago/.test(text(tiles[0])), `progress age must be shown (${text(tiles[0])})`);
  assert(/1 retries/.test(text(tiles[0])), 'recovery attempts must be counted');
  assert(q('[data-act="bx-create"]', view), 'the start button appears once an engine is available');

  click(tiles[0]);
  await sleep(120);
  const detail = q('#bx-detail', view);
  const body = text(detail);
  assert(/Last verified milestone/.test(body), 'milestone fact missing');
  assert(/Opened https:\/\/shop.example\/pricing/.test(body), 'the verified milestone must be the real one');
  assert(/1 of 8 used/.test(body), 'retry budget usage must be visible');
  assert(qa('[data-act="bx-evidence"]', detail).length === 1, 'evidence records must be listed');
  assert(/Pause/.test(text(q('.bx-controls', detail))), 'a running task can be paused');
  assert(!/Completed/.test(body), 'a running task must never look completed');
  assert(/Timeline/.test(body) && /created/.test(body), 'the timeline must be rendered from real rows');
});

/* ---------- 6. waiting for the user ---------- */
await check('a task waiting for a person says what it needs and offers the honest action', async () => {
  gatewayMode = 'waiting';
  browserView.browserInternals.cache.selectedId = ''; // start from an unselected panel
  const view = await openBrowser();
  click(q('.bx-task', view));
  await sleep(120);
  const detail = q('#bx-detail', view);
  const body = text(detail);
  assert(/Needs you/.test(body), 'the needs-you state must be labelled');
  assert(/will not attempt to bypass authentication/i.test(body), 'the blocker must be quoted verbatim');
  assert(/I've cleared it/.test(body), 'the assist action must be offered');
  assert(/Resume/.test(body), 'resume must be offered');
  assert(/Stop/.test(body), 'a waiting task can still be stopped');
});

/* ---------- 7. completed, simulated ---------- */
await check('a completed task is labelled simulated and only claims what was verified', async () => {
  gatewayMode = 'done';
  browserView.browserInternals.cache.selectedId = '';
  const view = await openBrowser();
  const tile = q('.bx-task', view);
  assert(/Completed/.test(text(tile)), 'completed label');
  assert(/Simulated/.test(text(tile)), 'a scripted run must be labelled Simulated, not Chromium');
  click(tile);
  await sleep(120);
  const detail = q('#bx-detail', view);
  assert(/Simulated driver/.test(text(detail)), 'the detail must repeat the simulated label');
  assert(/success criteria verified/.test(text(detail)), 'the completion reason must be shown');
  eq(q('[data-act="bx-control"][data-cmd="pause"]', detail), null, 'a finished task has no pause control');
  assert(/ended /.test(text(detail)), 'a finished task shows when it ended');
});

/* ---------- 8. gateway errors ---------- */
await check('a gateway that cannot be read says so and never invents tasks', async () => {
  gatewayMode = 'down';
  const view = await openBrowser();
  const body = text(view);
  assert(/Gateway not readable/.test(body), 'the read failure must be named');
  eq(qa('.bx-task', view).length, 0, 'no tasks may be rendered from a failed read');
  assert(/Try again/.test(body), 'the retry is a real control');
});

/* ---------- 9. pure helpers ---------- */
await check('criteria parsing and progress labels are explicit', () => {
  const { ageLabel, parseCriteria } = browserView.browserInternals;
  eq(ageLabel(12_000), '12s ago', 'seconds');
  eq(ageLabel(150_000), '3 min ago', 'minutes');
  eq(ageLabel(3_600_000), '1h ago', 'hours');
  const parsed = parseCriteria('price: contains:4,200\nheading: equals:Pricing\n\n');
  eq(parsed.length, 2, 'blank lines are ignored');
  eq(parsed[0].key, 'price', 'key before the first colon');
  eq(parsed[0].expect, 'contains:4,200', 'the rest of the line is the check');
  let threw = false;
  try { parseCriteria('nonsense'); } catch { threw = true; }
  assert(threw, 'a criterion without “key: check” must be rejected');
});

/* ---------- report ---------- */
console.log(results.join('\n'));
const passed = results.filter((r) => r.startsWith('PASS')).length;
console.log(`\nAgent Browser screen: ${passed} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
