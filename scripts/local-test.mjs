/* Local AI preflight + All-modules grid tests.
 * Run: npm run test:local
 *
 * Two things are verified here:
 *   1. the More panel renders its modules four per row with identical tile geometry, including the
 *      new "Local" entry;
 *   2. the Local screen does what the on-device AI specification's phase-1 gate asks — measure the
 *      platform honestly and claim nothing else. No model, no download, no inference, no cloud
 *      fallback may be implied anywhere in the markup.
 */
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const styles = readFileSync(join(root, 'src/styles.css'), 'utf8');

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

/* =========================================================================================
 * 1. CSS: four per row, identical geometry
 * =======================================================================================*/
await check('the module grid is four columns at every width, including 320px phones', () => {
  const grid = styles.match(/\.mod-grid \{[^}]*\}/);
  assert(grid, '.mod-grid rule missing');
  assert(/grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/.test(grid[0]), `expected four equal columns, got ${grid[0]}`);
  const wide = styles.match(/@media \(min-width: \d+px\) \{[^}]*\.mod-grid[^}]*\}/g) || [];
  const changes = wide.filter((w) => /grid-template-columns/.test(w));
  eq(changes.length, 0, 'no breakpoint may change the column count — it is four everywhere');
});

await check('tiles share one fixed geometry so nothing drifts out of alignment', () => {
  const tile = styles.match(/\.mod-tile \{[^}]*\}/);
  assert(tile, '.mod-tile rule missing');
  assert(/height:\s*\d+px/.test(tile[0]), 'tiles need a fixed height');
  assert(/align-items:\s*center/.test(tile[0]), 'tile content must be centred horizontally');
  const ico = styles.match(/\.mod-ico \{[^}]*\}/);
  assert(ico, '.mod-ico rule missing');
  assert(/width:\s*38px/.test(ico[0]) && /height:\s*38px/.test(ico[0]), 'icon badge must be a fixed 38px square');
  assert(/flex:\s*none/.test(ico[0]), 'icon badge must not shrink or grow');
  const label = styles.match(/\.mod-label \{[^}]*\}/);
  assert(label, '.mod-label rule missing');
  assert(/-webkit-line-clamp:\s*2/.test(label[0]), 'labels must clamp to two lines');
  assert(/min-height:\s*2\.5em/.test(label[0]), 'two label lines must be reserved so heights match');
});

await check('the old 3-column module grid is no longer used by the More panel', () => {
  const shell = readFileSync(join(root, 'src/shell.js'), 'utf8');
  const more = shell.slice(shell.indexOf('function moreSheet'), shell.indexOf('function notificationsSheet'));
  assert(!/grid-3/.test(more), 'the More panel still uses the old grid-3 container');
  assert(/mod-grid/.test(more), 'the More panel must use mod-grid');
  assert(!/style="align-items:center;gap:8px;padding:16px 8px"/.test(more), 'per-tile inline layout must be gone');
  assert(!/class="avatar"/.test(more), 'tiles should use the dedicated mod-ico badge, not avatars');
});

/* =========================================================================================
 * 2. DOM: More panel + Local entry
 * =======================================================================================*/
const win = new Window({ url: 'http://localhost:5173/#/home' });
for (const k of ['document', 'navigator', 'location', 'localStorage', 'history', 'HTMLElement',
  'Event', 'CustomEvent', 'KeyboardEvent', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame', 'Blob']) {
  const value = win[k] ?? win;
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
win.document.body.innerHTML = '<div id="app"><div id="view"></div><div id="sheet-root"></div><div id="toast-root"></div></div>';
globalThis.fetch = async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });

await import('../src/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(140);

const nav = await import('../src/main.js');
const shell = await import('../src/shell.js');
const local = await import('../src/local.js');
const knowledge = await import('../src/copilot/knowledge.js');

const doc = win.document;
const view = () => doc.getElementById('view');
const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
const q = (sel, r = doc) => r.querySelector(sel);
const qa = (sel, r = doc) => [...r.querySelectorAll(sel)];
const sheet = () => [...doc.querySelectorAll('.sheet.open')].pop() || null;
const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

async function openMore() {
  shell.closeAllSheets();
  await sleep(20);
  nav.navigate('home');
  await sleep(20);
  click(q('[data-act="more"]'));
  await sleep(50);
  return sheet();
}

await check('the More panel shows modules as uniform four-per-row tiles', async () => {
  const s = await openMore();
  assert(s, 'All-modules sheet did not open');
  const grid = q('.mod-grid', s);
  assert(grid, 'mod-grid container missing');
  assert(!q('.grid-3', s), 'old grid still present');
  const tiles = qa('.mod-tile', s);
  // The module registry grows as screens ship, so the count is a floor, not a fixed number.
  // The invariant that matters is the layout: four equal columns at every width.
  assert(tiles.length >= 12, `expected at least 12 modules, got ${tiles.length}`);
  assert(/\.mod-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/.test(styles), 'mod-grid must be four equal columns');
  assert(!/\.mod-grid\s*\{[^}]*grid-template-columns:\s*repeat\((?!4)/.test(styles), 'no rule may override the four-column grid');
  tiles.forEach((t) => {
    assert(q('.mod-ico svg', t), 'every tile needs an icon');
    assert(q('.mod-label', t), 'every tile needs a label');
    assert(!t.querySelector('.mod-ico [aria-hidden="false"]'), 'icons should stay decorative');
    assert(!/style="width/.test(t.outerHTML), 'no per-tile inline sizing');
  });
  const labels = tiles.map((t) => text(q('.mod-label', t)));
  assert(labels.includes('Local'), `Local tile missing (got ${labels.join(', ')})`);
  assert(labels.includes('Voice Studio'), `Voice Studio tile missing (got ${labels.join(', ')})`);
  assert(new Set(labels).size === labels.length, 'duplicate module labels');
});

await check('the Local tile is flagged as new and routes to the Local screen', async () => {
  const s = await openMore();
  const tile = qa('.mod-tile', s).find((t) => t.dataset.to === 'local');
  assert(tile, 'Local tile missing');
  assert(q('.mod-badge', tile), 'Local tile needs a “new” badge');
  assert(/new/i.test(text(q('.mod-badge', tile))), 'badge text');
  assert(/new, preflight only/i.test(tile.getAttribute('aria-label') || ''), 'accessible name must state it is preflight only');
  click(tile);
  await sleep(80);
  nav.rerender();
  assert(/Local AI/.test(text(view())), 'Local view did not open');
  eq(shell.routes.find((r) => r.id === 'local')?.title, 'Local AI', 'route registered');
  eq(shell.routes.find((r) => r.id === 'local')?.icon, 'cpu', 'route icon');
});

await check('the Local screen distinguishes the experimental spike from production', async () => {
  nav.navigate('local');
  await sleep(60);
  const html = text(view());
  assert(/Production local AI is not implemented/i.test(html), 'missing the honest banner');
  assert(/experimental runtime spike/i.test(html), 'the spike must be identified as experimental');
  assert(q('a[href="./local-spike.html"]', view()), 'the spike must have a real link');
  assert(/No model is bundled/i.test(html), 'must state no model is bundled');
  assert(/not implemented/i.test(html), 'must state features are not implemented');
  assert(/never/i.test(html) && /Cloud fallback/i.test(html), 'must state there is no cloud fallback');
  // Re-measure plus the Voice Studio deep link are the only controls: both do something real.
  // Anything that would pretend to load or run a model is forbidden.
  const controls = qa('[data-act]', view()).map((el) => el.dataset.act);
  assert(/Re-measure/.test(html), 're-measure control missing');
  assert(controls.every((act) => ['local-rescan', 'nav'].includes(act)), `unexpected control on Local: ${controls.join(', ')}`);
  const navLink = qa('[data-act="nav"]', view())[0];
  eq(navLink?.dataset.to, 'voice', 'the Local screen deep-links to Voice Studio');
  const phases = qa('.local-phase', view());
  eq(phases.length, local.PHASES.length, 'all spec phases listed');
  assert(/this screen/.test(text(phases[0])), 'phase 1 marked as this screen');
  assert(/in progress/.test(text(phases[1])), 'runtime spike is in progress');
  assert(phases.slice(2).every((p) => /not started/.test(text(p))), 'later phases must be not started');
});

await check('candidate presets are labelled unverified with size caveats', async () => {
  const html = text(view());
  ['SmolLM2 135M', 'Qwen2.5 0.5B', 'Llama 3.2 1B', 'DeepSeek-R1-Distill-Qwen-1.5B'].forEach((name) => {
    assert(html.includes(name), `${name} missing from the candidate list`);
  });
  assert(/unverified/i.test(html), 'presets must be labelled unverified');
  assert(/verify licence/i.test(html), 'licence verification must be stated');
  assert(/rough Q4 estimates, not measurements/i.test(html), 'sizes must not be presented as measured');
});

/* =========================================================================================
 * 3. Capability probes + verdicts (pure logic, stubbed platform)
 * =======================================================================================*/
const makeNav = (over = {}) => ({
  storage: {
    estimate: async () => ({ quota: 8 * 1024 ** 3, usage: 1 * 1024 ** 3 }),
    persisted: async () => true,
    getDirectory: async () => ({}),
  },
  deviceMemory: 8,
  hardwareConcurrency: 8,
  ...over,
});
const goodWindow = { isSecureContext: true, crossOriginIsolated: true };
const gpuNav = () => makeNav({
  gpu: { requestAdapter: async () => ({ info: { vendor: 'arm', architecture: 'mali', device: 'Mali-G715' } }) },
});

await check('a capable platform measures clean and is only “ready for a spike”', async () => {
  const caps = await local.detectCapabilities({ navigator: gpuNav(), window: goodWindow });
  eq(caps.wasm, true, 'wasm detected');
  eq(caps.wasmSimd, true, 'simd detected');
  eq(caps.threads, true, 'threads detected under cross-origin isolation');
  eq(caps.webgpuAdapter?.vendor, 'arm', 'adapter info kept');
  eq(caps.opfs, true, 'opfs detected');
  assert(caps.storage.freeBytes === 7 * 1024 ** 3, 'free storage computed from quota − usage');
  eq(caps.persistentStorage, true, 'persistence reported');
  const v = local.assess(caps);
  eq(v.status, 'spike-ready', `verdict (blockers: ${v.blockers.join(' | ')}, cautions: ${v.cautions.join(' | ')})`);
  assert(v.positives.length >= 2, 'positives should be reported too');
  eq(local.STATUS_COPY['spike-ready'].chip, 'ok', 'chip for the good state');
  assert(/not passed/i.test(local.STATUS_COPY['spike-ready'].detail), 'the good state must not imply the gate passed');
});

await check('a browser without WebAssembly is blocked, not “experimental”', async () => {
  const caps = await local.detectCapabilities({ navigator: makeNav({ gpu: undefined }), window: goodWindow });
  const blocked = local.assess({ ...caps, wasm: false, wasmSimd: false });
  eq(blocked.status, 'blocked', 'verdict');
  assert(/WebAssembly is unavailable/.test(blocked.blockers.join(' ')), 'blocker explains why');
  const insecure = local.assess({ ...caps, secureContext: false });
  eq(insecure.status, 'blocked', 'insecure context blocks too');
  assert(/secure context/i.test(insecure.blockers.join(' ')), 'explains HTTPS requirement');
});

await check('a capable-but-limited phone is “constrained”, with actionable cautions', async () => {
  const navLow = makeNav({
    storage: { estimate: async () => ({ quota: 2 * 1024 ** 3, usage: 1.9 * 1024 ** 3 }), persisted: async () => false, getDirectory: async () => ({}) },
    deviceMemory: 2,
    hardwareConcurrency: 4,
  });
  const caps = await local.detectCapabilities({ navigator: navLow, window: { isSecureContext: true, crossOriginIsolated: false } });
  const v = local.assess(caps);
  eq(v.status, 'constrained', 'verdict');
  const all = v.cautions.join(' ');
  assert(/storage headroom/i.test(all), 'low storage must be called out with the measured number');
  assert(/Threads are off/.test(all), 'missing threads explained');
  assert(/RAM/.test(all), 'low memory reported');
  assert(/CPU\/WASM only/.test(all), 'no GPU path stated');
});

await check('missing platform APIs report unknown, never a fake yes', async () => {
  const bare = await local.detectCapabilities({ navigator: {}, window: {} });
  eq(bare.secureContext, null, 'unknown secure context');
  eq(bare.webgpu, false, 'no gpu');
  eq(bare.opfs, false, 'no opfs');
  eq(bare.storage, null, 'no quota');
  assert(bare.storage !== undefined, 'storage key present');
  const v = local.assess(bare);
  assert(v.status !== 'spike-ready', 'an unknown platform must not be called ready');
  assert(/could not be measured/i.test(v.cautions.join(' ')), 'unmeasured storage is stated');
});

await check('the rendered preflight reports the real browser, not a mock', async () => {
  nav.navigate('local');
  await sleep(80);
  const capsEl = q('#local-caps', view());
  assert(capsEl, 'capability host missing');
  const body = text(capsEl);
  assert(/Secure context/.test(body), 'secure context row');
  assert(/WebAssembly/.test(body), 'wasm row');
  assert(/Storage headroom/.test(body), 'storage row');
  assert(/Measured/.test(body), 'measurement timestamp');
  assert(/not a feature/.test(body), 'must state results describe the platform');
  assert(/Measuring/.test(body) === false, 'placeholder replaced after mount');
});

await check('the Copilot can describe the Local screen without overclaiming', async () => {
  const described = knowledge.describeScreen('local');
  assert(/no model is bundled/i.test(described), 'must state no model is bundled');
  assert(/no inference/i.test(described), 'must state no inference');
  const entries = JSON.stringify(knowledge.KNOWLEDGE);
  assert(!/local model is installed/i.test(entries), 'knowledge must not claim installed models');
});

console.log(results.join('\n'));
if (failures) {
  console.error(`\n${failures} local test(s) failed`);
  process.exit(1);
}
console.log(`\nLOCAL AI PREFLIGHT + MODULE GRID: ${results.length}/${results.length} PASSED`);
process.exit(0);
