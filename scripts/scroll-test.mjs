/* Scroll continuity contract.
 * Run: npm run test:scroll
 *
 * The 4.2s simulation tick and every gateway sync re-render the whole view. Re-rendering must never
 * move the reader: only navigation returns to the top. These checks drive the real boot/router in
 * happy-dom and assert what `scrollTo` is called with, plus inner-scroller restoration.
 */
import { Window } from 'happy-dom';

const win = new Window({ url: 'http://localhost:5173/' });
const g = globalThis;
for (const k of ['window', 'document', 'navigator', 'location', 'localStorage', 'history', 'HTMLElement', 'Event', 'CustomEvent', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  const value = win[k] ?? win;
  if (value === undefined) continue;
  try { Object.defineProperty(g, k, { value, configurable: true, writable: true }); } catch { try { g[k] = value; } catch {} }
}
g.window = win;
g.document = win.document;
g.navigator = win.navigator;
g.localStorage = win.localStorage;
g.location = win.location;
g.requestAnimationFrame = (fn) => setTimeout(fn, 0);
g.matchMedia = () => ({ matches: false, addEventListener() {} });
win.matchMedia = g.matchMedia;
win.document.body.innerHTML = '<div id="app"></div>';

let pageY = 0;
const scrollCalls = [];
Object.defineProperty(win, 'scrollY', { get: () => pageY, configurable: true });
win.scrollTo = (x, y) => {
  scrollCalls.push(y);
  pageY = typeof y === 'number' ? y : 0;
};

const results = [];
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS ${name}`); } catch (error) { failures += 1; results.push(`FAIL ${name}: ${error.message}`); }
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const eq = (actual, expected, message) => { if (actual !== expected) throw new Error(`${message} (expected ${expected}, got ${actual})`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await import('../src/main.js');
await sleep(120);
const { navigate, rerender } = await import('../src/main.js');
const { setState } = await import('../src/core.js');
const view = () => win.document.getElementById('view');

await check('boot renders the command deck at the top', async () => {
  assert(view().textContent.includes('Command deck'), 'home did not render');
  eq(pageY, 0, 'boot must start at the top');
});

await check('a state-driven re-render keeps the reader where they are', async () => {
  pageY = 900;
  scrollCalls.length = 0;
  rerender();
  eq(pageY, 900, 'a plain re-render reset the page scroll');
  eq(scrollCalls.length, 0, `re-render called scrollTo(${scrollCalls.join(', ')})`);
});

await check('the simulation tick does not snap the page back to the top', async () => {
  pageY = 1200;
  scrollCalls.length = 0;
  setState((state) => { state.usage.push({ ts: Date.now(), cost: 1, tokens: 1 }); }, 'sim');
  await sleep(30);
  eq(pageY, 1200, 'simulation re-render reset the page scroll');
  eq(scrollCalls.filter((value) => value === 0).length, 0, 'simulation re-render scrolled to 0');
});

await check('a non-simulation state change still preserves the position', async () => {
  pageY = 640;
  setState((state) => { state.settings.density = 'compact'; }, 'density');
  await sleep(30);
  eq(pageY, 640, 'state re-render reset the page scroll');
});

await check('navigation resets to the top of the new view', async () => {
  pageY = 1500;
  scrollCalls.length = 0;
  navigate('settings');
  await sleep(30);
  eq(pageY, 0, 'navigating to settings did not start at the top');
  assert(view().textContent.includes('Appearance'), 'settings did not render');
  assert(scrollCalls.includes(0), 'navigation did not request the top');
});

await check('changing the hash route resets, re-rendering the same route does not', async () => {
  pageY = 700;
  rerender();
  eq(pageY, 700, 'same-route re-render reset the scroll');
  win.location.hash = '#/agents';
  await sleep(60);
  eq(pageY, 0, 'hash navigation to agents did not start at the top');
  pageY = 500;
  rerender();
  eq(pageY, 500, 'agents re-render reset the scroll');
});

await check('opening a record (route/id) starts at the top of the record', async () => {
  pageY = 800;
  navigate('agents/ag-coder');
  await sleep(30);
  eq(pageY, 0, 'opening a record did not start at the top');
  pageY = 320;
  rerender();
  eq(pageY, 320, 'record re-render reset the scroll');
});

await check('inner scrollers survive a re-render (kanban board and columns)', async () => {
  navigate('tasks');
  await sleep(60);
  const board = win.document.getElementById('kb-viewport');
  const column = win.document.querySelector('.kanban-cards');
  assert(board && column, 'kanban scrollers are missing');
  board.scrollLeft = 420;
  column.scrollTop = 160;
  rerender();
  eq(win.document.getElementById('kb-viewport').scrollLeft, 420, 'board horizontal position was lost');
  eq(win.document.querySelector('.kanban-cards').scrollTop, 160, 'column vertical position was lost');
});

await check('the view element keeps its own scroll offset too', async () => {
  navigate('home');
  await sleep(60);
  const el = view();
  el.scrollTop = 275;
  pageY = 0;
  rerender();
  eq(el.scrollTop, 275, 'view scrollTop was reset');
});

await check('scroll activity defers a render instead of interrupting the gesture', async () => {
  pageY = 300;
  win.dispatchEvent(new win.Event('scroll'));
  setState((state) => { state.usage.push({ ts: Date.now(), cost: 2, tokens: 2 }); }, 'sim');
  await sleep(30);
  eq(pageY, 300, 'a render during scroll moved the page');
  await sleep(3200); // beyond SCROLL_IDLE_MS + MAX_RENDER_DEFERRAL_MS
  eq(pageY, 300, 'the deferred render moved the page');
});

console.log(results.join('\n'));
console.log(`\nSCROLL CONTINUITY: ${results.length - failures}/${results.length} PASSED`);
process.exit(failures ? 1 : 0);
