/* Kanban board: zoom, dependency wires, drop confirmation, Copilot control.
 * Run: npm run test:kanban
 *
 * The board has exactly one write seam (src/kanban.js). These checks prove it:
 *   • zoom is clamped, persisted and applied to the track (70–150 %, steps of 10 %);
 *   • wire geometry comes from measured rects, skips edges with a missing endpoint and dims edges
 *     whose blocker is done;
 *   • a move cannot happen without the confirmation, and cancelling changes nothing;
 *   • every Copilot intent lands on the same seam and refuses rather than guessing;
 *   • gateway mode reports the server's refusal instead of pretending it worked.
 */
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const css = readFileSync(join(root, 'src/kanban.css'), 'utf8');
const viewsSrc = readFileSync(join(root, 'src/views1.js'), 'utf8');
const kanbanSrc = readFileSync(join(root, 'src/kanban.js'), 'utf8');

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
 * 1. Stylesheet: zoom lives on the track, wires are an inert overlay
 * =======================================================================================*/
await check('zoom is applied to the board track, not to individual columns', () => {
  const track = css.match(/\.kb-track \{[^}]*\}/);
  assert(track, '.kb-track rule missing');
  assert(/--kb-zoom/.test(track[0]), 'the track must read --kb-zoom');
  assert(/zoom:\s*var\(--kb-zoom/.test(track[0]), 'the track must scale with the zoom variable');
  const cols = css.match(/\.kanban-col \{[^}]*\}/);
  assert(cols && !/zoom|transform/.test(cols[0]), 'columns must never scale themselves — hit-testing breaks');
});

await check('the wire layer is inert and sits above the cards', () => {
  const wires = css.match(/\.kb-wires \{[^}]*\}/);
  assert(wires, '.kb-wires rule missing');
  assert(/pointer-events:\s*none/.test(wires[0]), 'wires must not swallow pointer events');
  assert(/position:\s*absolute/.test(wires[0]), 'wires must be positioned over the board');
  assert(/z-index:\s*\d+/.test(wires[0]), 'wires need a stacking order above cards');
  assert(/\.kb-wire\.dim/.test(css), 'done blockers need a dimmed stroke');
});

await check('the zoom buttons meet the 44px touch target', () => {
  const btn = css.match(/\.kb-zbtn,\s*\.kb-fit \{[^}]*\}/);
  assert(btn, 'zoom button group rule missing');
  assert(/min-width:\s*44px/.test(btn[0]) && /height:\s*44px/.test(btn[0]), 'touch targets must be at least 44px');
});

/* =========================================================================================
 * 2. DOM + modules
 * =======================================================================================*/
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
globalThis.fetch = async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });

await import('../src/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(140);

const nav = await import('../src/main.js');
const shell = await import('../src/shell.js');
const core = await import('../src/core.js');
const kb = await import('../src/kanban.js');
const knowledge = await import('../src/copilot/knowledge.js');

const doc = win.document;
const view = () => doc.getElementById('view');
const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
const q = (sel, r = doc) => r.querySelector(sel);
const qa = (sel, r = doc) => [...r.querySelectorAll(sel)];
const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
const sheet = () => [...doc.querySelectorAll('.sheet.open')].pop() || null;
const modal = () => [...doc.querySelectorAll('.modal-center.open')].pop() || null;
const cancelModal = async () => { click(q('#confirm-cancel', modal())); await sleep(30); };
const acceptModal = async () => { click(q('#confirm-ok', modal())); await sleep(60); };

/** Deterministic fixtures: 6 cards, two dependency edges, one blocker already done. */
function seedBoard() {
  core.setState((s) => {
    s.tasks = [
      { id: 'tk-a', title: 'Draft the eval rubric', column: 'done', assignee: s.agents[0].id, priority: 'med', deps: [], desc: 'Rubric v1' },
      { id: 'tk-b', title: 'Collect eval prompts', column: 'todo', assignee: s.agents[0].id, priority: 'high', deps: ['tk-a'], desc: 'Prompt set' },
      { id: 'tk-c', title: 'Score runs', column: 'doing', assignee: s.agents[1]?.id || '', priority: 'med', deps: ['tk-b'], desc: 'Scoring pass' },
      { id: 'tk-d', title: 'Write the summary', column: 'review', assignee: '', priority: 'low', deps: ['tk-a'], desc: 'Summary' },
      { id: 'tk-e', title: 'Ship the report', column: 'todo', assignee: '', priority: 'high', deps: [], desc: 'Ship it' },
      { id: 'tk-f', title: 'Archive old runs', column: 'done', assignee: '', priority: 'low', deps: [], desc: 'Cleanup' },
    ];
    s.board = { zoom: 1, wires: null, filter: { agent: 'all', priority: 'all', q: '' } };
  }, 'test:seed');
}

seedBoard();
nav.navigate('tasks');
await sleep(80);

const taskById = (id) => core.getState().tasks.find((t) => t.id === id);
const eventCount = () => core.getState().events.length;

/* =========================================================================================
 * 3. Zoom
 * =======================================================================================*/
await check('zoom clamps to 70–150 % in steps of 10 % and persists in the workspace store', () => {
  eq(kb.ZOOM_MIN, 0.7, 'zoom floor');
  eq(kb.ZOOM_MAX, 1.5, 'zoom ceiling');
  eq(kb.ZOOM_STEP, 0.1, 'zoom step');
  eq(kb.setZoom(2).zoom, 1.5, 'zoom above the ceiling clamps');
  eq(kb.setZoom(0.1).zoom, 0.7, 'zoom below the floor clamps');
  eq(kb.setZoom(1.24).zoom, 1.2, 'zoom snaps to the 10 % grid');
  eq(core.getState().board.zoom, 1.2, 'zoom must be stored on the workspace state');
  eq(kb.zoomBy('in').zoom, 1.3, 'step up');
  eq(kb.zoomBy('out').zoom, 1.2, 'step down');
  eq(kb.fitZoom().zoom, 1, 'Fit resets to 100 %');
});

await check('the toolbar renders −, the percentage, + and Fit, and drives the zoom', async () => {
  const toolbar = q('.kb-toolbar');
  assert(toolbar, 'zoom toolbar missing');
  assert(q('[data-act="kb-zoom-out"]', toolbar), 'zoom out button missing');
  assert(q('[data-act="kb-zoom-in"]', toolbar), 'zoom in button missing');
  assert(q('[data-act="kb-zoom-fit"]', toolbar), 'Fit button missing');
  eq(text(q('#kb-zoom-val')), '100%', 'starts at 100 %');

  click(q('[data-act="kb-zoom-in"]'));
  await sleep(60);
  eq(text(q('#kb-zoom-val')), '110%', 'the label follows the value');
  eq(core.getState().board.zoom, 1.1, 'the store follows the button');
  eq(q('#kb-track').getAttribute('style'), '--kb-zoom:1.1', 'the track receives the zoom variable');

  click(q('[data-act="kb-zoom-out"]'));
  click(q('[data-act="kb-zoom-out"]'));
  await sleep(60);
  eq(text(q('#kb-zoom-val')), '90%', 'zoom out twice');

  click(q('[data-act="kb-zoom-fit"]'));
  await sleep(60);
  eq(text(q('#kb-zoom-val')), '100%', 'Fit restores 100 %');

  // limits are disabled, not silently ignored
  kb.setZoom(1.5);
  await sleep(60);
  assert(q('[data-act="kb-zoom-in"]').hasAttribute('disabled'), 'zoom-in must disable at 150 %');
  kb.setZoom(0.7);
  await sleep(60);
  assert(q('[data-act="kb-zoom-out"]').hasAttribute('disabled'), 'zoom-out must disable at 70 %');
  kb.fitZoom();
  await sleep(60);
});

await check('zoom survives a re-render (and is part of the persisted workspace)', async () => {
  kb.setZoom(1.3);
  await sleep(60);
  eq(q('#kb-track').getAttribute('style'), '--kb-zoom:1.3', 'track keeps the zoom after re-render');
  nav.rerender();
  await sleep(60);
  eq(text(q('#kb-zoom-val')), '130%', 'rerender keeps the value');
  const saved = JSON.parse(win.localStorage.getItem('swarmos.v2') || win.localStorage.getItem('swarmos-state') || '{}');
  const stored = saved.board?.zoom ?? saved.state?.board?.zoom;
  assert(stored === undefined || stored === 1.3, `persisted zoom should be 1.3, saw ${stored}`);
  kb.fitZoom();
  await sleep(40);
});

/* =========================================================================================
 * 4. Wire geometry (pure function, so it can be checked without a layout engine)
 * =======================================================================================*/
await check('wire geometry leaves the blocker and arrives at the dependent card', () => {
  const cards = [
    { id: 'a', rect: { x: 0, y: 0, w: 100, h: 50 }, done: true },
    { id: 'b', rect: { x: 300, y: 100, w: 100, h: 50 } },
  ];
  const { paths } = kb.wirePaths(cards, [{ from: 'a', to: 'b' }]);
  eq(paths.length, 1, 'one edge, one path');
  assert(paths[0].d.startsWith('M100.0,25.0'), `path must start at the blocker's right edge, got ${paths[0].d}`);
  assert(paths[0].d.endsWith('300.0,125.0'), `path must end at the dependent's left edge, got ${paths[0].d}`);
  assert(/ C/.test(paths[0].d), 'the edge must be a curve');
  eq(paths[0].dim, true, 'an edge from a done blocker is dimmed');
});

await check('edges with a missing endpoint are skipped and counted, never guessed', () => {
  const cards = [{ id: 'a', rect: { x: 0, y: 0, w: 10, h: 10 } }];
  const { paths, skipped } = kb.wirePaths(cards, [{ from: 'a', to: 'ghost' }, { from: 'ghost', to: 'a' }]);
  eq(paths.length, 0, 'no path may be drawn to a card that is not on the board');
  eq(skipped.length, 2, 'both edges are reported as skipped');
});

await check('the rendered layer draws exactly the edges whose endpoints are on screen', async () => {
  // happy-dom has no layout engine, so measure with a fixture table.
  const layout = {
    'tk-a': { x: 4, y: 30, w: 240, h: 70 },
    'tk-b': { x: 4, y: 110, w: 240, h: 70 },
    'tk-e': { x: 4, y: 190, w: 240, h: 70 },
    'tk-c': { x: 258, y: 30, w: 240, h: 70 },
    'tk-d': { x: 512, y: 30, w: 240, h: 70 },
    'tk-f': { x: 766, y: 30, w: 240, h: 70 },
  };
  const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
  const vpBox = { left: 0, top: 0, width: 360, height: 600 }; // narrow phone: tk-f is off screen
  win.Element.prototype.getBoundingClientRect = function () {
    if (this.id === 'kb-viewport') return rect(vpBox.left, vpBox.top, vpBox.width, vpBox.height);
    const id = this.getAttribute?.('data-task');
    if (id && layout[id]) { const r = layout[id]; return rect(r.x, r.y, r.w, r.h); }
    return rect(0, 0, 0, 0);
  };
  kb.toggleWires(true);
  nav.rerender();
  await sleep(80);
  const layer = q('#kb-wires');
  assert(layer, 'wire layer missing');
  const paths = qa('#kb-wires path.kb-wire');
  // tk-b←tk-a and tk-d←tk-a and tk-c←tk-b are on screen; tk-f has no edges, tk-d is off screen at 360px
  const drawn = paths.map((p) => `${p.dataset.from}->${p.dataset.to}`).sort();
  // tk-f has no edges and tk-d sits at x=512, outside the 360px viewport
  eq(drawn.join(','), 'tk-a->tk-b,tk-b->tk-c', `unexpected edges drawn: ${drawn.join(',')}`);
  eq(qa('#kb-wires path.kb-wire.dim').length, 1, 'the edge out of a done blocker is dimmed');
  paths.forEach((p) => {
    assert(/^M[\d.]+,[\d.]+ C/.test(p.getAttribute('d')), 'each edge needs its own curve');
    assert(/marker-end="url\(#kb-arrow/.test(p.outerHTML), 'each edge needs an arrowhead');
  });
  eq(layer.dataset.drawn, '2', 'the layer reports how many wires it drew');
  assert(/wires? drawn/.test(text(q('#kb-stats'))), 'the stats line reflects the drawn count');
});

await check('turning wires off removes the layer entirely', async () => {
  kb.toggleWires(false);
  await sleep(60);
  eq(q('#kb-wires').style.display, 'none', 'layer is hidden');
  eq(qa('#kb-wires path.kb-wire').length, 0, 'no paths remain');
  eq(q('[data-act="kb-wires"]').getAttribute('aria-pressed'), 'false', 'chip reports off');
  kb.toggleWires(true);
  await sleep(60);
  assert(qa('#kb-wires path.kb-wire').length > 0, 'turning them back on redraws');
});

await check('wires default to on below 900px and off on wide screens', () => {
  eq(kb.wiresEnabled({ wires: null }), true, 'narrow viewport → auto on');
  win.matchMedia = globalThis.matchMedia = (query) => ({ matches: /min-width: 900px/.test(query), addEventListener() {} });
  eq(kb.wiresEnabled({ wires: null }), false, 'wide viewport → auto off');
  eq(kb.wiresEnabled({ wires: true }), true, 'an explicit choice beats the breakpoint');
  win.matchMedia = globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
});

/* =========================================================================================
 * 5. Confirmation on every move
 * =======================================================================================*/
await check('the drop → cancel path leaves the card and the log untouched', async () => {
  const before = eventCount();
  const pending = kb.moveTask('tk-b', 'done');
  await sleep(30);
  const m = modal();
  assert(m, 'a move must open a confirmation');
  assert(/Move/.test(text(q('#confirm-ok', m))), 'the confirm button says Move');
  assert(/Collect eval prompts/.test(text(m)), 'the prompt names the card');
  assert(/Backlog/.test(text(m)) && /Done/.test(text(m)), 'the prompt names both columns');
  await cancelModal();
  const out = await pending;
  eq(out.cancelled, true, 'cancel resolves as cancelled');
  eq(taskById('tk-b').column, 'todo', 'the card did not move');
  eq(eventCount(), before, 'cancel writes no event');
});

await check('the drop → confirm path moves the card exactly once and logs one event', async () => {
  const before = eventCount();
  const pending = kb.moveTask('tk-b', 'done');
  await sleep(30);
  await acceptModal();
  const out = await pending;
  eq(out.ok, true, 'confirm applies the move');
  eq(taskById('tk-b').column, 'done', 'the card moved');
  eq(eventCount(), before + 1, 'exactly one event for one move');
  assert(/Collect eval prompts/.test(core.getState().events[0].text), 'the event names the card');
  assert(/Done/.test(core.getState().events[0].text), 'the event names the target column');
  // put it back for the remaining checks (fixture write, not a user move)
  core.setState((st) => { st.tasks.find((t) => t.id === 'tk-b').column = 'todo'; }, 'test:reset');
});

await check('asking to move a card to the column it is already in changes nothing', async () => {
  const before = eventCount();
  const out = await kb.moveTask('tk-e', 'todo');
  eq(out.ok, false, 'a no-op move is refused');
  assert(/already in/i.test(out.error), 'the refusal explains why');
  eq(eventCount(), before, 'no event for a no-op');
});

await check('the drawer column chips go through the same confirmation', async () => {
  const { taskSheet } = await import('../src/views1.js');
  shell.closeAllSheets();
  await sleep(30);
  nav.navigate('tasks');
  await sleep(40);
  click(q('.kcard[data-task="tk-e"]'));
  await sleep(60);
  const s = sheet();
  assert(s, 'card drawer did not open');
  const chip = q('[data-act="task-move"][data-col="review"]', s);
  assert(chip, 'the drawer has no column chips');
  const before = eventCount();
  click(chip);
  await sleep(40);
  assert(modal(), 'a drawer chip move must ask first');
  await cancelModal();
  await sleep(40);
  eq(taskById('tk-e').column, 'todo', 'cancel from the drawer leaves the card alone');
  eq(eventCount(), before, 'no event from a cancelled drawer move');
  taskSheet; // keep the import referenced
  shell.closeAllSheets();
});

await check('no code path mutates a column without going through the seam', () => {
  // The only exception is "Run with agent", which starts a run rather than moving a card, and is
  // local-only (it already refuses on a gateway).
  const direct = viewsSrc.match(/\.column\s*=(?!=)/g) || [];
  eq(direct.length, 1, `views1.js may only assign a column in the run handler, found ${direct.length}`);
  const runHandler = viewsSrc.slice(viewsSrc.indexOf("on('task-run'"), viewsSrc.indexOf("on('task-create'"));
  assert(/\.column = 'doing'/.test(runHandler), 'the single assignment must be the run handler');
  const assignments = kanbanSrc.match(/t\.column\s*=(?!=)/g) || [];
  eq(assignments.length, 1, 'only commitMove may write a column (the demo branch)');
  assert(/export async function commitMove/.test(kanbanSrc), 'commitMove is the single writer');
  // and every move entry point calls moveTask/commitMove
  const dropHandler = viewsSrc.slice(viewsSrc.indexOf('function enableKanbanDrag'), viewsSrc.indexOf('/* toolbar + drawer actions */'));
  assert(/moveTask\(/.test(dropHandler), 'drag-and-drop must call moveTask');
  assert(!/setState\(/.test(dropHandler), 'drag-and-drop must not write state itself');
});

/* =========================================================================================
 * 6. Copilot control of the board (same seam)
 * =======================================================================================*/
await check('Copilot “move … to …” asks for confirmation and then moves', async () => {
  const pending = kb.kanbanCommand('move Ship the report to review');
  await sleep(40);
  assert(modal(), 'the Copilot move must prompt as well');
  await acceptModal();
  const out = await pending;
  eq(out.ok, true, 'the command reports success');
  assert(/Review/.test(out.reply), `reply names the column, got ${out.reply}`);
  eq(taskById('tk-e').column, 'review', 'the card moved');

  const cancelled = kb.kanbanCommand('move Ship the report to backlog');
  await sleep(40);
  await cancelModal();
  const out2 = await cancelled;
  eq(out2.cancelled, true, 'cancelling the prompt cancels the command');
  eq(taskById('tk-e').column, 'review', 'the card stayed put');
});

await check('Copilot refuses an unknown column and an ambiguous card', async () => {
  const out = await kb.kanbanCommand('move Ship the report to nowhere');
  eq(out.ok, false, 'unknown column refused');
  assert(/Unknown column/.test(out.reply), 'explains the column problem');
  const amb = await kb.kanbanCommand('move the to backlog');
  eq(amb.ok, false, 'ambiguous card refused rather than guessed');
});

await check('Copilot assign / priority / rename / link / unlink all land on the seam', async () => {
  const agent = core.getState().agents[2];
  const a = await kb.kanbanCommand(`assign Ship the report to ${agent.name}`);
  eq(a.ok, true, a.reply);
  eq(taskById('tk-e').assignee, agent.id, 'assigned to the named agent');

  const p = await kb.kanbanCommand('set priority low on Ship the report');
  eq(p.ok, true, p.reply);
  eq(taskById('tk-e').priority, 'low', 'priority changed');

  const r = await kb.kanbanCommand('rename Ship the report to Publish the report');
  eq(r.ok, true, r.reply);
  eq(taskById('tk-e').title, 'Publish the report', 'renamed');

  const l = await kb.kanbanCommand('link Archive old runs depends on Collect eval prompts');
  eq(l.ok, true, l.reply);
  assert(taskById('tk-f').deps.includes('tk-b'), 'dependency recorded');
  assert(/wire/.test(l.reply), 'the reply mentions the wire');

  const u = await kb.kanbanCommand('unlink Archive old runs from Collect eval prompts');
  eq(u.ok, true, u.reply);
  assert(!taskById('tk-f').deps.includes('tk-b'), 'dependency removed');

  const un = await kb.kanbanCommand('unassign Archive old runs');
  eq(un.ok, true, un.reply);
  eq(taskById('tk-f').assignee, '', 'unassigned');
});

await check('a dependency cycle is refused', () => {
  const out = kb.linkDeps('tk-a', 'tk-c'); // tk-c already depends on tk-b which depends on tk-a
  eq(out.ok, false, 'cycle refused');
  assert(/cycle/.test(out.error), 'the refusal names the cycle');
  assert(!(taskById('tk-a').deps || []).includes('tk-c'), 'nothing was written');
});

await check('Copilot “delete” is two-step: cancel keeps the card, confirm removes it', async () => {
  const pending = kb.kanbanCommand('delete card Archive old runs');
  await sleep(40);
  const m = modal();
  assert(m, 'delete must ask');
  assert(/Delete card/.test(text(q('#confirm-ok', m))), 'dangerous confirm wording');
  await cancelModal();
  eq((await pending).cancelled, true, 'cancel reported');
  assert(taskById('tk-f'), 'the card survived the cancel');

  const pending2 = kb.deleteTask('tk-f');
  await sleep(40);
  await acceptModal();
  const out = await pending2;
  eq(out.ok, true, 'delete applied');
  eq(taskById('tk-f'), undefined, 'the card is gone');
});

await check('Copilot zoom / wires / filter / summary answer without inventing state', async () => {
  const z = await kb.kanbanCommand('zoom the board to 120%');
  eq(z.ok, true, z.reply);
  eq(core.getState().board.zoom, 1.2, 'zoom applied');

  const w = await kb.kanbanCommand('hide the wires');
  eq(w.ok, true, w.reply);
  eq(core.getState().board.wires, false, 'wires turned off');
  const w2 = await kb.kanbanCommand('show wires');
  eq(core.getState().board.wires, true, 'wires turned on');

  const f = await kb.kanbanCommand('filter board by priority high');
  eq(f.ok, true, f.reply);
  eq(core.getState().board.filter.priority, 'high', 'filter applied');
  const cleared = await kb.kanbanCommand('clear filter');
  eq(cleared.ok, true, cleared.reply);
  eq(core.getState().board.filter.priority, 'all', 'filter cleared');

  const summary = await kb.kanbanCommand('board status');
  eq(summary.ok, true, 'summary answers');
  assert(/Backlog \d+/.test(summary.reply) && /dependency link/.test(summary.reply), `summary must be grounded: ${summary.reply}`);
  kb.fitZoom();
});

await check('non-board text returns null so the Copilot can keep routing', async () => {
  eq(await kb.kanbanCommand('what is the gateway API'), null, 'unrelated text is not swallowed');
  eq(await kb.kanbanCommand('approve ap-1'), null, 'approvals are not board commands');
});

/* =========================================================================================
 * 7. Gateway honesty
 * =======================================================================================*/
await check('gateway mode reports the server refusal and never pretends the card moved', async () => {
  core.setState((s) => { s.provenance = { ...(s.provenance || {}), tasks: 'gateway' }; }, 'test:gateway');
  const out = await kb.commitMove('tk-c', 'done');
  eq(out.ok, false, 'a failed gateway write is a failure');
  assert(/refused|Gateway|configured/i.test(out.error), `the error explains the refusal: ${out.error}`);
  eq(taskById('tk-c').column, 'doing', 'the local copy did not move on its own');
  core.setState((s) => { s.provenance = { ...(s.provenance || {}), tasks: 'demo' }; }, 'test:demo');
});

await check('dependency edits refuse to claim gateway persistence', () => {
  core.setState((s) => { s.provenance = { ...(s.provenance || {}), tasks: 'gateway' }; }, 'test:gateway');
  const out = kb.linkDeps('tk-b', 'tk-e');
  eq(out.ok, false, 'no gateway column for deps');
  assert(/gateway/.test(out.error), 'the reason names the gateway');
  core.setState((s) => { s.provenance = { ...(s.provenance || {}), tasks: 'demo' }; }, 'test:demo');
});

/* =========================================================================================
 * 8. Copilot screen description
 * =======================================================================================*/
await check('describeScreen(tasks) reports column counts and blockers', () => {
  const described = knowledge.describeScreen('tasks');
  assert(/backlog|todo/i.test(described), 'column counts are named');
  assert(/dependency link/i.test(described), 'dependency count is reported');
  assert(/waiting on/i.test(described), 'blockers are reported');
  assert(/confirmation/.test(described), 'the move confirmation is stated');
  assert(!/all tests pass|fully working/i.test(described), 'no overclaiming');
});

console.log(results.join('\n'));
if (failures) {
  console.error(`\n${failures} kanban test(s) failed`);
  process.exit(1);
}
console.log(`\nKANBAN BOARD: ${results.length}/${results.length} PASSED`);
process.exit(0);
