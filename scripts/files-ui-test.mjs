/* File manager — the panel's own behaviour.
 * Run: npm run test:files:ui
 *
 * What this suite is, and what it is not: it drives the real panel code (rendering, tabs, the long-press
 * menu, the download controls) against a *stubbed transport*. That is deliberate — the transport is the one
 * thing the gateway suite (scripts/files-gateway-test.mjs) already proves end to end against a real
 * filesystem, and repeating it here would only prove the stub. What this suite adds is that the panel
 * cannot invent a file, cannot offer a control it has no route for, and tells the truth when there is no
 * gateway at all.
 */
import { Window } from 'happy-dom';

const results = [];
let failures = 0;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; results.push(`FAIL ${name}: ${error.message}`); console.log(`FAIL ${name}: ${error.message}`); }
}
const assert = (cond, message) => { if (!cond) throw new Error(message); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); };
const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

const win = new Window({ url: 'http://localhost:5173/#/files' });
for (const k of ['document', 'navigator', 'location', 'localStorage', 'history', 'HTMLElement',
  'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'Node', 'Blob',
  'requestAnimationFrame', 'cancelAnimationFrame']) {
  const value = win[k] ?? win;
  try { Object.defineProperty(globalThis, k, { value, configurable: true, writable: true }); } catch { try { globalThis[k] = value; } catch { /* frozen */ } }
}
globalThis.window = win;
globalThis.document = win.document;
globalThis.localStorage = win.localStorage;
globalThis.CSS = win.CSS || { escape: (s) => String(s).replace(/[^\w-]/g, '\\$&') };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
win.matchMedia = globalThis.matchMedia;
win.document.body.innerHTML = '<div id="app"><div id="view"></div><div id="sheet-root"></div><div id="toast-root"></div></div>';

/* ---------- the stub transport: a gateway that answers like the real one ---------- */
const calls = [];
let enabled = false;
const ROOT = '/srv/mmm/files';
const tree = {
  '': [
    { name: 'notes', path: 'notes', type: 'dir', size: 0, modifiedAt: Date.now() - 60000, extension: '' },
    { name: 'report.pdf', path: 'report.pdf', type: 'file', size: 2048, modifiedAt: Date.now() - 90000, extension: 'pdf' },
  ],
  notes: [
    { name: 'today.md', path: 'notes/today.md', type: 'file', size: 41, modifiedAt: Date.now() - 30000, extension: 'md' },
  ],
};
const locations = [
  { id: 'loc-artifacts', label: 'Artifacts', kind: 'artifacts', rootPath: `${ROOT}/artifacts`, purpose: 'uploads', granted: true },
  { id: 'loc-web', label: 'Public web', kind: 'web', rootPath: `${ROOT}/web`, purpose: 'web-deploy', granted: true },
];
let downloads = [];

const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body, headers: new win.Headers({ 'content-type': 'application/json' }) });

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url), 'http://x');
  const p = u.pathname;
  const method = (opts.method || 'GET').toUpperCase();
  calls.push({ m: method, p, q: Object.fromEntries(u.searchParams) });
  if (!enabled) return json(0, { error: 'no gateway' });
  if (p === '/api/v1/files/locations') return json(200, { locations });
  if (p === '/api/v1/files/list') {
    const loc = u.searchParams.get('location');
    const rel = u.searchParams.get('path') || '';
    if (!locations.some((l) => l.id === loc)) return json(404, { error: 'no such storage location', code: 'not-found' });
    const parent = rel ? (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '') : null;
    return json(200, { location: loc, path: rel, parent, entries: tree[rel] || [], truncated: false });
  }
  if (p === '/api/v1/files/usage') return json(200, { usage: locations.map((l) => ({ location: l.id, label: l.label, rootPath: l.rootPath, bytes: 2048, files: 2, dirs: 1, truncated: false })) });
  if (p === '/api/v1/files/downloads' && method === 'GET') return json(200, { downloads });
  if (p === '/api/v1/files/downloads' && method === 'POST') {
    const row = { id: 'dl-1', locationId: 'loc-artifacts', path: 'report.pdf', filename: 'report.pdf', bytesTotal: 2048, bytesDone: 0, status: 'queued', attempts: 0, error: '' };
    downloads = [row];
    return json(201, { download: row });
  }
  if (/^\/api\/v1\/files\/downloads\/[\w-]+$/.test(p) && method === 'PATCH') {
    const body = JSON.parse(opts.body || '{}');
    downloads = downloads.map((d) => (d.id === 'dl-1' ? { ...d, ...body } : d));
    return json(200, { download: downloads[0] });
  }
  if (p === '/api/v1/files/entry' && method === 'DELETE') {
    const path = u.searchParams.get('path');
    tree[''] = tree[''].filter((e) => e.path !== path);
    return json(200, { removed: path, trashed: `.trash/2026__${path}`, recoverable: true });
  }
  if (p === '/api/v1/files/dir' && method === 'POST') {
    const body = JSON.parse(opts.body || '{}');
    return json(201, { entry: { name: body.path, path: body.path, type: 'dir', size: 0, modifiedAt: Date.now(), extension: '' } });
  }
  if (p === '/api/v1/files/download') return json(200, { error: 'binary' });
  return json(404, { error: `unexpected ${method} ${p}` });
};

await import('../src/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(150);
const api = await import('../src/api.js');
const files = await import('../src/files.js');
const main = await import('../src/main.js');
const view = () => win.document.getElementById('view');
const sheet = () => win.document.querySelector('.sheet');
const open = async (route = 'files') => { main.navigate(route); await sleep(160); };

await check('with no gateway the screen refuses to show a tree it cannot read', async () => {
  api.setGatewayUrl('');
  await open('files');
  const body = text(view());
  assert(/No gateway is connected/.test(body), 'it says there is no gateway');
  assert(/shows no files rather than a sample tree/.test(body), 'and refuses to draw a sample tree');
  eq(view().querySelectorAll('.fm-row').length, 0, 'no rows are rendered');
  eq(view().querySelectorAll('[data-act="fm-upload"]').length, 0, 'and no upload control');
});

await check('with a gateway the tree is what the gateway returned, with real sizes', async () => {
  enabled = true;
  api.setGatewayUrl('http://gateway.test');
  calls.length = 0;
  await open('files');
  await sleep(220);
  const rows = [...view().querySelectorAll('.fm-row')];
  eq(rows.length, 2, 'two rows, as many as the gateway listed');
  assert(text(rows[0]).includes('notes'), 'the folder is first');
  assert(text(rows[1]).includes('report.pdf'), 'then the file');
  assert(/2\.0 KB/.test(text(rows[1])), 'the size is formatted from bytes');
  assert(calls.some((c) => c.p === '/api/v1/files/list'), 'the list came from the gateway route');
  eq(view().querySelectorAll('.fm-locs .chip').length, 2, 'both storage locations are offered');
});

await check('tapping a folder asks for that folder, and the breadcrumb follows', async () => {
  calls.length = 0;
  const folder = view().querySelector('.fm-row[data-type="dir"]');
  folder.dispatchEvent(new win.Event('click', { bubbles: true }));
  await sleep(200);
  const asked = calls.find((c) => c.p === '/api/v1/files/list' && c.q.path === 'notes');
  assert(asked, 'it asked the gateway for notes/');
  assert(text(view().querySelector('.fm-crumbs')).includes('notes'), 'the breadcrumb names the folder');
  eq(view().querySelectorAll('.fm-row').length, 1, 'and the listing is the new one');
});

await check('a long press opens the context menu, and it offers only routes that exist', async () => {
  await open('files');
  await sleep(180);
  const row = view().querySelector('.fm-row[data-type="file"]');
  row.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 20 }));
  await sleep(650);
  const menu = sheet();
  assert(menu, 'the sheet opened');
  const actions = [...menu.querySelectorAll('[data-act]')].map((el) => el.dataset.act);
  for (const expected of ['fm-download', 'fm-rename', 'fm-copyto', 'fm-delete']) {
    assert(actions.includes(expected), `the menu offers ${expected}`);
  }
  assert(!actions.includes('fm-open'), 'a file is not offered “Open” — it is a download, not a preview');
  assert(/Move to trash/.test(text(menu)), 'and the destructive action is named as a move to trash');
});

await check('a right-click opens the same menu without a 500 ms wait', async () => {
  win.document.querySelector('.sheet')?.remove();
  const row = view().querySelector('.fm-row[data-type="file"]');
  row.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await sleep(30);
  assert(sheet(), 'the menu opened on contextmenu');
  win.document.querySelector('.sheet')?.remove();
});

await check('deleting says it went to the trash, because that is what the gateway did', async () => {
  const row = view().querySelector('.fm-row[data-type="file"]');
  row.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await sleep(30);
  const del = [...sheet().querySelectorAll('[data-act="fm-delete"]')][0];
  del.dispatchEvent(new win.Event('click', { bubbles: true }));
  await sleep(240);
  const toastText = text(win.document.getElementById('toast-root'));
  assert(/Moved to trash/.test(toastText), `the toast says moved to trash, not deleted (got “${toastText}”)`);
  assert(/\.trash\//.test(toastText), 'and names where it can be recovered from');
  assert(!/report\.pdf/.test(text(view().querySelector('.fm-list'))), 'the row is gone from the listing');
});

await check('the download manager shows bytes and controls, and never a running bar it is not holding', async () => {
  downloads = [{ id: 'dl-1', locationId: 'loc-artifacts', path: 'report.pdf', filename: 'report.pdf', bytesTotal: 2048, bytesDone: 1024, status: 'paused', attempts: 1, error: '' }];
  await open('files');
  // The tab is module state; click the tab control the way a person would.
  view().querySelector('[data-act="fm-tab"][data-tab="downloads"]')?.dispatchEvent(new win.Event('click', { bubbles: true }));
  await sleep(220);
  const row = view().querySelector('[data-dl="dl-1"]');
  assert(row, 'the download row is rendered');
  eq(row.dataset.status, 'paused', 'the status is the record’s, not a guess');
  assert(/1\.0 KB of 2\.0 KB/.test(text(row)), 'bytes are shown from the record');
  eq(row.querySelector('[data-dl-fill]').style.width, '50%', 'the bar is the byte count');
  assert(row.querySelector('[data-act="fm-dl-resume"]'), 'a paused transfer offers Resume');
  assert(!row.querySelector('[data-act="fm-dl-pause"]'), 'and not Pause — it is not running');
});

await check('the storage tab measures the roots instead of describing them', async () => {
  view().querySelector('[data-act="fm-tab"][data-tab="storage"]')?.dispatchEvent(new win.Event('click', { bubbles: true }));
  await sleep(220);
  const body = text(view());
  assert(/2\.0 KB/.test(body), 'the usage figure is the measured one');
  assert(/real/i.test(body) === false, 'no invented reassurance is printed');
  assert(/A root is the boundary|boundary/.test(body), 'and it explains what a root means');
  eq(view().querySelectorAll('.fm-loc-card').length, 2, 'one card per location');
});

const passedN = results.filter((r) => r.startsWith('PASS')).length;
console.log(`\nFILES UI: ${passedN} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
