/* Mobile-first / responsive audit.
 * Run: npm run test:responsive
 *
 * CSS media queries cannot be evaluated in happy-dom (no layout engine), so this suite checks the
 * things that actually regress:
 *   • every stylesheet is authored mobile-first — no `max-width` breakpoints at all;
 *   • the viewport allows pinch zoom (no user-scalable=no) and declares width=device-width;
 *   • inputs are 16px so iOS does not zoom the page on focus;
 *   • the Comms gateway grid is one column by default and only splits at a min-width;
 *   • no fixed pixel width in the Comms stylesheet can exceed a 320px viewport;
 *   • touch targets: switches expose a ≥44px hit area, and the Comms tile switch is its own
 *     button rather than an element nested inside the tile button (which would fire both actions);
 *   • stacked-by-default rows (kv, log, tabs) are declared before their wider-screen overrides.
 */
import { Window } from 'happy-dom';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const cssFiles = readdirSync(join(root, 'src')).filter((f) => f.endsWith('.css'));
const css = Object.fromEntries(cssFiles.map((f) => [f, readFileSync(join(root, 'src', f), 'utf8')]));
const html = readFileSync(join(root, 'index.html'), 'utf8');

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
 * 1. Stylesheets are authored mobile first
 * =======================================================================================*/
await check('no stylesheet uses a desktop-first max-width breakpoint', () => {
  const offenders = [];
  for (const [file, text] of Object.entries(css)) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (/@media[^{]*max-width/.test(line)) offenders.push(`${file}:${i + 1} ${line.trim()}`);
    });
  }
  eq(offenders.length, 0, `desktop-first media queries found:\n${offenders.join('\n')}`);
});

await check('every media query is a min-width feature query or a preference query', () => {
  const offenders = [];
  for (const [file, text] of Object.entries(css)) {
    const matches = text.match(/@media[^{]+/g) || [];
    matches.forEach((m) => {
      const q = m.replace('@media', '').trim();
      if (/^\(min-width: \d+px\)$/.test(q)) return;
      if (/^\(prefers-reduced-motion: reduce\)$/.test(q)) return;
      offenders.push(`${file}: ${q}`);
    });
  }
  eq(offenders.length, 0, `unexpected media queries:\n${offenders.join('\n')}`);
});

await check('the viewport meta allows zoom and declares a responsive width', () => {
  const meta = html.match(/<meta[\s\S]*?name="viewport"[\s\S]*?content="([^"]+)"/);
  assert(meta, 'viewport meta missing');
  const content = meta[1];
  assert(/width=device-width/.test(content), 'width=device-width missing');
  assert(/initial-scale=1/.test(content), 'initial-scale missing');
  assert(!/user-scalable\s*=\s*no/.test(content), 'user-scalable=no blocks pinch zoom (WCAG 1.4.4)');
  assert(!/maximum-scale\s*=\s*1(\.0)?\b/.test(content), 'maximum-scale=1 blocks pinch zoom');
  assert(/viewport-fit=cover/.test(content), 'notch safe-area support missing');
});

/* =========================================================================================
 * 2. Global base styles that keep phones usable
 * =======================================================================================*/
await check('form controls use a 16px base size (no iOS zoom-on-focus)', () => {
  const rule = css['styles.css'].match(/\.input, select\.input, textarea\.input \{[\s\S]*?\}/);
  assert(rule, 'input rule missing');
  assert(/font-size:\s*16px/.test(rule[0]), `inputs must be 16px, got ${rule[0].match(/font-size:[^;]+/)?.[0]}`);
});

await check('rows stack by default and align only from 480px up', () => {
  const s = css['styles.css'];
  const kvBase = s.match(/\.kv \{[^}]*\}/);
  assert(kvBase, '.kv base rule missing');
  assert(/flex-direction:\s*column/.test(kvBase[0]), '.kv should stack by default');
  const kvWide = s.match(/@media \(min-width: 480px\) \{\s*\.kv \{[^}]*\}/);
  assert(kvWide && /flex-direction:\s*row/.test(kvWide[0]), '.kv should become a row at 480px');
  assert(/\.kv\.inline[^{]*\{[^}]*flex-direction:\s*row/.test(s), 'switch rows must stay on one line');
});

await check('multi-column grids and the tab strip only widen on larger screens', () => {
  const s = css['styles.css'];
  const grid3 = s.match(/\.grid-3 \{[^}]*\}/);
  assert(grid3 && /repeat\(2, 1fr\)/.test(grid3[0]), '.grid-3 must be 2 columns by default');
  assert(/@media \(min-width: 520px\) \{ \.grid-3 \{ grid-template-columns: repeat\(3, 1fr\); \} \}/.test(s), 'grid-3 should reach 3 columns at 520px');
  const tabs = s.match(/\.tabs button \{[^}]*\}/);
  assert(tabs && /flex:\s*0 0 auto/.test(tabs[0]), 'tabs must scroll instead of squeezing on phones');
  assert(/@media \(min-width: 560px\) \{ \.tabs button \{ flex: 1;/.test(s), 'tabs should share width on wide screens');
});

await check('switches expose a touch target larger than their visual pill', () => {
  const s = css['styles.css'];
  assert(/\.switch::before \{[^}]*inset:\s*-8px -6px/.test(s), 'switch hit area not expanded');
  const commsCss = css['comms.css'];
  const hit = commsCss.match(/\.switch-hit \{[^}]*\}/);
  assert(hit, '.switch-hit rule missing');
  assert(/min-height:\s*44px/.test(hit[0]) && /min-width:\s*44px/.test(hit[0]), `switch hit area must be ≥44px, got ${hit[0]}`);
});

await check('the Copilot overlay is full screen by default', () => {
  const s = css['copilot.css'];
  // Full-bleed immersive overlay at every width: inset covers the viewport and the panel is the
  // screen, not a floating card that only becomes large on desktop.
  const base = s.match(/\.cp-panel \{[\s\S]*?\}/);
  assert(base, '.cp-panel base rule missing');
  assert(/inset:\s*0/.test(base[0]), 'the base panel must cover the viewport');
  assert(/height:\s*100dvh/.test(base[0]), 'the base panel must be viewport height');
  assert(/border-radius:\s*0/.test(base[0]), 'an immersive overlay has square corners');
  // Only min-width enhancements are allowed (mobile-first, no max-width layout queries).
  assert(!/@media[^{]*max-width[^{]*\{[^@]*\.cp-panel/.test(s), 'no max-width override may reshape the panel');
});

/* =========================================================================================
 * 3. Comms stylesheet specifics
 * =======================================================================================*/
await check('the Comms gateway grid is single-column by default', () => {
  const c = css['comms.css'];
  const grid = c.match(/\.comms-grid \{[^}]*\}/);
  assert(grid, '.comms-grid missing');
  assert(/grid-template-columns:\s*1fr;/.test(grid[0]), `comms grid must be 1fr by default, got ${grid[0]}`);
  assert(!/grid-template-columns:\s*1fr 1fr/.test(grid[0]), 'two columns must not be the base state');
  assert(/@media \(min-width: 560px\) \{\s*\.comms-grid \{ grid-template-columns: 1fr 1fr;/.test(c), 'two columns belong in a min-width query');
});

await check('no Comms layout width can overflow a 320px viewport', () => {
  const c = css['comms.css'];
  const widths = [...c.matchAll(/(?:^|[;{\s])(?:min-)?width:\s*(\d{3,})px/g)].map((m) => Number(m[1]));
  const tooWide = widths.filter((w) => w > 320);
  eq(tooWide.length, 0, `fixed widths too wide for a 320px phone: ${tooWide.join(', ')}`);
  assert(/\.comms-main \{[^}]*min-width:\s*0/.test(c), 'the tile body needs min-width:0 so text can truncate');
  assert(/-webkit-line-clamp:\s*2/.test(c), 'tile descriptions should clamp instead of growing unbounded');
});

await check('Comms log rows stack on phones and split only when there is room', () => {
  const c = css['comms.css'];
  const base = c.match(/\.comms-log-row \{[^}]*\}/);
  assert(base && /flex-direction:\s*column/.test(base[0]), 'log rows must stack by default');
  assert(/@media \(min-width: 560px\) \{\s*\.comms-grid/.test(c) && c.includes('flex-direction: row;'), 'log rows should go side-by-side at 560px');
});

/* =========================================================================================
 * 4. Comms DOM structure + behaviour at any width
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
const comms = await import('../src/comms.js');
const core = await import('../src/core.js');

const doc = win.document;
const view = () => doc.getElementById('view');
const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
const q = (sel, r = doc) => r.querySelector(sel);
const qa = (sel, r = doc) => [...r.querySelectorAll(sel)];
const sheet = () => [...doc.querySelectorAll('.sheet.open')].pop() || null;

async function fresh() {
  shell.closeAllSheets();
  await sleep(20);
  nav.navigate('comms');
  await sleep(30);
}

await check('Comms markup has no nested interactive elements', async () => {
  await fresh();
  eq(qa('button button', view()).length, 0, 'a button inside a button fires both actions on mobile');
  eq(qa('a a', view()).length, 0, 'nested links');
  eq(qa('[data-act] [data-act]', view()).length, 0, 'nested action targets double-fire taps');
  const tiles = qa('.comms-tile', view());
  eq(tiles.length, 6, 'six tiles');
  tiles.forEach((tile) => {
    assert(q('.comms-main[data-act="comms-open"]', tile), 'tile needs its own settings button');
    const toggle = q('[role="switch"]', tile);
    assert(toggle, 'tile needs a separate enable switch');
    assert(toggle.dataset.act === 'comms-toggle', 'switch must be its own action');
    assert(!q('.comms-main', toggle), 'switch must not contain the settings button');
    assert(toggle.getAttribute('aria-checked') !== null, 'switch needs aria-checked');
    assert(/Enable|Disable/.test(toggle.getAttribute('aria-label')), 'switch needs an accessible name');
  });
});

await check('tapping the enable switch does not open the settings sheet', async () => {
  await fresh();
  comms.saveChannelConfig('telegram', { botToken: '1:abc', chatId: '42' });
  nav.rerender();
  await sleep(30);
  const toggle = q('[data-act="comms-toggle"][data-id="telegram"]', view());
  assert(toggle, 'telegram switch missing');
  const before = core.getState().comms.channels.telegram.enabled;
  click(toggle);
  await sleep(60);
  eq(Boolean(sheet()), false, 'the settings sheet must not open from the switch');
  eq(core.getState().comms.channels.telegram.enabled, !before, 'the switch still toggles the channel');
});

await check('tapping the tile body opens that channel’s settings', async () => {
  await fresh();
  click(q('.comms-main[data-id="whatsapp"]', view()));
  await sleep(60);
  const s = sheet();
  assert(s, 'settings sheet did not open');
  assert(/WhatsApp/.test(s.textContent), 'opened the wrong channel');
  assert(q('[data-cf="accessToken"]', s), 'channel fields rendered');
  shell.closeAllSheets();
});

await check('Comms content wraps instead of forcing a horizontal scroll', async () => {
  await fresh();
  const offenders = qa('[style*="width:"]', view()).filter((el) => {
    const m = el.getAttribute('style').match(/width:\s*(\d+)px/);
    return m && Number(m[1]) > 320;
  });
  eq(offenders.length, 0, 'inline fixed widths wider than a phone screen');
  const html = view().innerHTML;
  assert(!/white-space:\s*nowrap/.test(html), 'inline nowrap text can overflow on phones');
  // Every gateway tile keeps its status and capabilities on wrapped chip rows.
  const tiles = qa('.comms-tile', view());
  tiles.forEach((t, i) => assert(q('.comms-caps', t), `tile ${i} lost its capability chips`));
});

await check('log and inbox rows are structured for narrow screens', async () => {
  await comms.sendTest('browser', { text: 'A deliberately long inbox message that must wrap rather than widen the card.' });
  nav.rerender();
  await sleep(30);
  const inbox = q('.comms-inbox', view());
  assert(inbox, 'inbox row missing');
  assert(inbox.querySelector('.grow'), 'inbox text needs a flexible column');
  const log = q('.comms-log-row', view());
  assert(log, 'log row missing');
  assert(log.querySelector('.comms-log-meta') && log.querySelector('.comms-log-text'), 'log row needs its meta and text separated for stacking');
});

await check('settings controls are fluid instead of pixel-fixed', async () => {
  nav.navigate('settings');
  await sleep(30);
  const offenders = qa('[style*="width:"]', view()).filter((el) => {
    const m = el.getAttribute('style').match(/width:\s*(\d+)px/);
    return m && Number(m[1]) > 200;
  });
  eq(offenders.length, 0, 'settings still uses pixel-fixed control widths');
  assert(q('.input.compact', view()), 'compact inputs missing');
  assert(/@media \(min-width: 480px\) \{\s*\.input\.compact \{/.test(css['styles.css']), 'compact inputs must be fluid by default');
});

console.log(results.join('\n'));
if (failures) {
  console.error(`\n${failures} responsive test(s) failed`);
  process.exit(1);
}
console.log(`\nRESPONSIVE + MOBILE FIRST: ${results.length}/${results.length} PASSED`);
process.exit(0);
