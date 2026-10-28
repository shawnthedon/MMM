/* Copilot interaction tour: drives the real panel through every mode, card and control.
 * Run: npm run test:copilot   (happy-dom, no browser binary required)
 */
import { Window } from 'happy-dom';

const win = new Window({ url: 'http://localhost:5173/' });
for (const k of [
  'window', 'document', 'navigator', 'location', 'localStorage', 'history', 'HTMLElement',
  'Event', 'CustomEvent', 'KeyboardEvent', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame',
]) {
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

const failures = [];
process.on('unhandledRejection', (e) => failures.push(`unhandled rejection: ${e}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (e) {
    results.push(`FAIL ${name}: ${e.message}`);
    failures.push(e);
  }
}

await import('../src/main.js');
await sleep(100);

const copilot = await import('../src/copilot.js');
const { MODES, SUGGESTIONS } = await import('../src/copilot/orchestrator.js');
const panel = () => win.document.getElementById('copilot-panel');
const work = () => panel()?.querySelector('#copilot-work');
const click = (sel) => {
  const el = panel()?.querySelector(sel);
  if (!el) throw new Error(`control not found: ${sel}`);
  el.click();
  return el;
};

await check('details drawer opens, and the title swaps stage ⇄ advanced', async () => {
  copilot.resetCopilotSession();
  copilot.openCopilot();
  // The overlay opens on the immersive stage, so the conversation surface starts hidden.
  if (panel().dataset.view !== 'stage') throw new Error(`expected the stage first, got ${panel().dataset.view}`);
  click('[data-cp="details"]');
  if (panel().querySelector('#cp-details').hidden) throw new Error('details did not open');
  if (!panel().querySelector('#cp-details').textContent.includes('Knowledge')) throw new Error('details content missing');
  // The title is the affordance: it reveals every control, then hides them again.
  const title = panel().querySelector('#copilot-title');
  if (!/Advanced Copilot/.test(title.textContent)) throw new Error('title must read “Advanced Copilot”');
  click('#copilot-title');
  if (panel().dataset.view !== 'advanced') throw new Error('title did not reveal the controls');
  if (title.getAttribute('aria-expanded') !== 'true') throw new Error('title must report its expanded state');
  click('#copilot-title');
  if (panel().dataset.view !== 'stage') throw new Error('title did not return to the stage');
});

await check('every mode answers every suggested prompt without errors', async () => {
  for (const mode of MODES) {
    copilot.resetCopilotSession();
    copilot.openCopilot({ mode: mode.id });
    for (const q of SUGGESTIONS[mode.id] || []) {
      copilot.copilotSend(q);
      await sleep(320);
      const html = work()?.innerHTML || '';
      if (html.length < 60) throw new Error(`empty render for ${mode.id} / “${q}”`);
      if (panel().querySelector('[data-cp="arm"]')) click('[data-cp="arm"]');
      if (panel().querySelector('[data-cp="confirm"]')) {
        click('[data-cp="confirm"]');
        await sleep(20);
      }
      if (panel().querySelector('[data-cp="edit"]')) {
        click('[data-cp="edit"]');
        const input = panel().querySelector('[data-cp="param"]');
        if (!input) throw new Error(`edit mode has no editable field for ${mode.id} / “${q}”`);
        input.value = 'Edited Name';
        input.dispatchEvent(new win.Event('input', { bubbles: true }));
        if (!panel().querySelector('[data-cp="review"]')) throw new Error('edit did not offer a review step');
      }
    }
  }
});

await check('clearing memory is consequential and requires two steps', async () => {
  copilot.resetCopilotSession();
  copilot.openCopilot({ mode: 'activity' });
  copilot.copilotSend('clear memory');
  await sleep(330);
  click('[data-cp="arm"]');
  click('[data-cp="confirm"]');
  await sleep(30);
  if (!work().textContent.includes('cleared')) throw new Error('clear-memory result missing');
});

await check('quick create closes the panel and opens the app sheet', async () => {
  copilot.resetCopilotSession();
  copilot.openCopilot();
  click('[data-cp="quick-create"]');
  await sleep(60);
  if (panel()) throw new Error('panel should close before opening a sheet');
  if (!win.document.querySelector('.sheet')) throw new Error('quick-create sheet missing');
  win.document.querySelector('.sheet [data-sheet-close]')?.click();
  await sleep(300);
});

await check('stop cancels an in-flight reply without side effects', async () => {
  copilot.resetCopilotSession();
  copilot.openCopilot();
  copilot.copilotSend('status');
  click('[data-cp="stop"]');
  await sleep(340);
  if (!work().textContent.includes('Stopped before answering')) throw new Error('stop message missing');
});

await check('launcher state follows the panel', async () => {
  copilot.resetCopilotSession();
  const fab = win.document.querySelector('[data-act="copilot-open"]');
  if (fab.getAttribute('aria-expanded') !== 'false') throw new Error('launcher should be collapsed after close');
  copilot.openCopilot();
  if (fab.getAttribute('aria-expanded') !== 'true') throw new Error('launcher should be expanded while open');
  copilot.closeCopilot();
});

console.log(results.join('\n'));
if (failures.length) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\nCOPILOT TOUR PASSED');
process.exit(0);
