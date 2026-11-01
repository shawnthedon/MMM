/* No fabrications: the ticker is dead and the static claims are gone.
 * Run: npm run test:honesty
 *
 * Each check below is a lie that used to be on screen. This suite fails if one comes back, whether as a
 * literal in a template, a seed field, or a timer that moves numbers no row explains.
 */
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
/** Comments explain what was removed; only code is judged. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const main = code(read('src/main.js'));
const views1 = code(read('src/views1.js'));
const views2 = code(read('src/views2.js'));
const core = code(read('src/core.js'));
const orchestrator = code(read('src/copilot/orchestrator.js'));
const knowledge = code(read('src/copilot/knowledge.js'));

const results = [];
let failures = 0;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); } catch (e) { failures += 1; results.push(`FAIL ${name}: ${e.message}`); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); };

/* ---------- 1. the ticker ---------- */
await check('the simulation ticker is deleted, not paused', () => {
  assert(!/function tick\s*\(/.test(main), 'no tick() function');
  assert(!/setInterval\(\s*tick/.test(main), 'nothing schedules a tick');
  assert(!/st\.usage\.push/.test(main), 'the fake usage curve is gone');
  assert(!/w\.progress = Math\.min/.test(main), 'swarm progress is no longer advanced in the browser');
  assert(!/settings\.simulate/.test(main) && !/settings\.simulate/.test(views2) && !/settings\.simulate/.test(core),
    'and the switch that drove it is gone from main, settings and the seed');
  assert(!/toggle-sim/.test(views2), 'the “Live simulation feed” control is gone');
  assert(!/Math\.random/.test(main), 'main.js contains no Math.random');
});

await check('swarm fixtures are plans, with nothing spent', () => {
  const seed = core.slice(core.indexOf('swarms: ['), core.indexOf('tasks: ['));
  assert(/executed: false/.test(seed), 'the fixture says it was never executed');
  assert(/status: 'planned'/.test(seed), 'and its status is planned');
  assert(!/spent: 0\.\d/.test(seed), 'no non-zero spend in a swarm that never ran');
  assert(!/status: 'done'/.test(seed) && !/status: 'running'/.test(seed), 'no node claims to have run');
});

/* ---------- 2. the swarm screen ---------- */
await check('the swarm screen says nothing executes', () => {
  assert(/No swarm has ever executed anything/.test(views1), 'the list banner states it');
  assert(/not executed/.test(views1), 'rows carry a not-executed label');
  assert(!/est \$\$\{'6\.40'\}/.test(views1) && !/6\.40/.test(views1), 'the $6.40 literal is gone');
  assert(!/swarm-pause/.test(views1) && !/swarm-cancel/.test(views1),
    'no pause/cancel controls for a process that does not exist');
  assert(/'Swarm deployed 🚀'/.test(views1) === false, 'and deploy no longer claims a launch');
  assert(/nothing is executing/.test(views1), 'saving a record says what it did');
});

/* ---------- 3. models ---------- */
await check('the models screen reads the gateway ledger, and invents nothing when there is none', () => {
  const models = views2.slice(views2.indexOf('const liveLedger'), views2.indexOf('views.plugins ='));
  assert(/getModelsLedger/.test(models), 'every figure comes from the ledger');
  assert(/No gateway is connected, so nothing here is callable/.test(models), 'without a gateway it says nothing is callable');
  assert(/estimated/.test(models), 'cost is labelled an estimate, because it comes from a price table');
  assert(!/Spend MTD/.test(models), 'the invented spend tile is gone');
  assert(!/spendMTD/.test(models), 'and the fixture spend figure with it');
  assert(!/toggle-provider/.test(models), 'no switch that pretends to enable a provider');
  assert(!/Workspace daily/.test(models) && !/6\.21/.test(models), 'no typed budget numbers');
  assert(/not enforced/.test(models), 'routing policies are labelled as not enforced');
  assert(/never\s+returned to this browser/.test(models), 'and the key sheet says the key does not come back');
});

/* ---------- 4. plugins ---------- */
await check('the plugins screen does not claim a client it does not have', () => {
  assert(!/all calls proxied & audited by the gateway/.test(views2), 'the proxy claim is gone');
  assert(!/short-lived scoped tokens/.test(views2), 'and the token-injection claim');
  assert(/No MCP client is installed in this build/.test(views2), 'says there is no client');
  const plugins = views2.slice(views2.indexOf('views.plugins'), views2.indexOf('views.chat ='));
  assert(!/callsToday/.test(plugins), 'no call counter from a seed field');
  assert(!/sealed in gateway vault/.test(views2), 'no credential field for a vault that does not exist');
  assert(!/plugin-custom/.test(views2), 'no custom-server sheet that collects a secret');
  assert(!/'Plugin installed'|installed`, 'ok'/.test(views2), 'nothing toasts a successful install');
  assert(/not connected/.test(views2), 'rows say they are not connected');
});

/* ---------- 5. analytics ---------- */
await check('analytics does not chart MCP calls it never made', () => {
  const analytics = views2.slice(views2.indexOf('views.analytics'), views2.indexOf('/* ================= ARTIFACTS'));
  assert(!/callsToday/.test(analytics), 'no call counts');
  assert(!/2 denied by policy/.test(analytics), 'and no invented denial count');
  assert(/not measured/.test(analytics), 'the tile says it is not measured');
});

/* ---------- 6. settings ---------- */
await check('the four static security claims are gone', () => {
  for (const claim of ['4 templates active', 'AEAD-sealed vault', 'default-deny · proxy']) {
    assert(!views2.includes(claim), `“${claim}” must not appear as a claim`);
  }
  assert(/no key vault in this build/.test(views2), 'secrets row tells the truth');
  assert(/not enforced by this app/.test(views2), 'egress row tells the truth');
  assert(/nothing is recorded in demo mode/.test(views2), 'audit row scopes the claim to the gateway');
  assert(!/zero external dependencies/.test(views2), 'no unqualified “zero external dependencies”');
});

/* ---------- 7. the copilot tells the same story ---------- */
await check('the copilot does not describe a ticker that no longer exists', () => {
  for (const stale of [
    'Progress from here is simulated by the demo ticker',
    'the demo ticker advances its nodes and spend',
    'a ticker animates live swarms',
    'Swarm progress is animated by the local ticker',
    'In the current demo runtime the swarm is a seeded/simulated instance — the ticker advances it',
  ]) {
    assert(!orchestrator.includes(stale) && !knowledge.includes(stale), `the copilot still says: “${stale}”`);
  }
  assert(!/status: 'live',\n          progress/.test(orchestrator), 'the copilot deploy does not create a live swarm');
  assert(/executed: false/.test(orchestrator), 'it creates a plan');
});

/* ---------- 8. and it stays that way in the running app ---------- */
const win = new Window({ url: 'http://localhost:5173/#/teams' });
for (const k of ['document', 'navigator', 'location', 'localStorage', 'history', 'HTMLElement', 'Event',
  'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  try { Object.defineProperty(globalThis, k, { value: win[k] ?? win, configurable: true, writable: true }); } catch { /* ignore */ }
}
globalThis.window = win;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
win.matchMedia = globalThis.matchMedia;
win.document.body.innerHTML = '<div id="app"><div id="view"></div><div id="sheet-root"></div><div id="toast-root"></div></div>';
globalThis.fetch = async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });

await import('../src/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(150);
const nav = await import('../src/main.js');
const store = await import('../src/core.js');
const view = () => win.document.getElementById('view');

await check('nothing on the teams screen changes on its own', async () => {
  nav.navigate('teams');
  await sleep(120);
  const before = JSON.stringify(store.getState().swarms);
  await sleep(5000); // longer than the old 4.2 s tick
  eq(JSON.stringify(store.getState().swarms), before, 'the swarm rows are byte-identical five seconds later');
  const text = view().textContent;
  assert(/not executed/.test(text), 'and the screen still says so');
  assert(!/Pause/.test(text) && !/Cancel swarm/.test(text), 'with no pause/cancel controls');
});

await check('the swarm detail screen is a plan, not a live run', async () => {
  nav.navigate('teams/sw-market');
  await sleep(120);
  const text = view().textContent.replace(/\s+/g, ' ');
  assert(/Not executed/.test(text), 'the detail view states it');
  assert(/planned/.test(text), 'nodes read planned');
  assert(/never run/.test(text), 'and the row says it never ran');
  assert(!/\$3\.41|62%/.test(text), 'the fabricated progress and spend are gone');
});

await check('the settings screen no longer claims a vault or an egress proxy', async () => {
  nav.navigate('settings');
  await sleep(120);
  const text = view().textContent;
  for (const claim of ['AEAD-sealed vault', '4 templates active', 'default-deny · proxy']) {
    assert(!text.includes(claim), `“${claim}” must be gone`);
  }
  assert(/no key vault in this build/.test(text), 'and replaced with the truth');
});

await check('the plugins screen holds no credential field and no call count', async () => {
  nav.navigate('plugins');
  await sleep(120);
  eq(view().querySelectorAll('input[type="password"]').length, 0, 'no password input for a vault that does not exist');
  assert(/no client installed/i.test(view().textContent), 'says there is no client');
  assert(!/calls today/.test(view().textContent), 'no call counts');
});

await check('the models screen offers no control that pretends to enable a provider', async () => {
  nav.navigate('models');
  await sleep(120);
  eq(view().querySelectorAll('[data-act="toggle-provider"]').length, 0, 'no provider switch');
  assert(/not configured/.test(view().textContent), 'says not configured');
});

console.log(results.join('\n'));
const passed = results.filter((r) => r.startsWith('PASS')).length;
console.log(`\nHONESTY: ${passed} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
