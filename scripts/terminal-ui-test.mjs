/* Terminal screen — happy-dom, real modules, stubbed gateway.
 * Run: npm run test:terminal:ui
 *
 * What is asserted (and what it protects):
 *   • with no gateway the screen says so and disables the prompt — it never pretends to be a shell;
 *   • a process command is POSTed and its output arrives from the stream, in order, into the right lane
 *     (stdout vs stderr), with the exit code on the run bar;
 *   • a failure shows the exit code and is not dressed up as success;
 *   • Ctrl+C sends SIGINT; Ctrl+L clears; ArrowUp recalls history;
 *   • a destructive command is reported as waiting for approval and nothing is claimed to have run;
 *   • the app commands (help/status/open) still work, locally, and do not touch the network;
 *   • the script chips come from the project's own package.json;
 *   • the stylesheet stays mobile-first, token-only and 44px-targeted;
 *   • the fabricating `deploy` case is gone from the source.
 */
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const css = readFileSync(join(root, 'src/terminal.css'), 'utf8');
const src = readFileSync(join(root, 'src/terminal.js'), 'utf8');

const results = [];
let failures = 0;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); } catch (error) { failures += 1; results.push(`FAIL ${name}: ${error.message}`); }
}
const assert = (cond, message) => { if (!cond) throw new Error(message); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); };
const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

/* ---------- 1. stylesheet contract ---------- */
await check('the stylesheet is mobile-first, token-only and clears 44px', () => {
  assert(!/@media[^{]*max-width/.test(css), 'no max-width media queries — the layout widens, it does not shrink');
  assert(/@media \(min-width: 900px\)/.test(css), 'the wide layout is a min-width enhancement');
  assert(!/#[0-9a-f]{3,8}\b/i.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'no hard-coded colours — tokens only');
  assert(/min-height: 44px/.test(css), 'touch targets are 44px');
  assert(/overflow-wrap: anywhere/.test(css), 'long output and paths must wrap, never clip');
  assert(!/max-height: *\d+px/.test(css.split('.term {')[1]?.split('}')[0] || ''), 'the output pane is not height-capped');
});

/* ---------- 2. the lie is gone ---------- */
await check('the fabricating commands are gone from the source', () => {
  assert(!/Math\.random/.test(src), 'no invented output');
  assert(!/s\.swarms\.unshift/.test(src), 'deploy no longer fabricates a swarm');
  assert(/not implemented/i.test(src), 'and it says so instead');
  assert(!/'MMM shell v0\.1/.test(src), 'the old fake banner is gone');
});

/* ---------- 3. harness ---------- */
const win = new Window({ url: 'http://localhost:5173/#/terminal' });
for (const k of ['document', 'navigator', 'location', 'localStorage', 'history', 'HTMLElement',
  'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame', 'Blob']) {
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

/* A stand-in for EventSource: the gateway pushes chunks; the test decides when. */
const streams = [];
class FakeEventSource {
  constructor(url) { this.url = url; this.listeners = {}; this.closed = false; streams.push(this); }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  close() { this.closed = true; }
  emit(name, data) { for (const fn of this.listeners[name] || []) fn({ data: JSON.stringify(data) }); }
}
const realEventSource = globalThis.EventSource;
globalThis.EventSource = FakeEventSource;

globalThis.fetch = async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });

await import('../src/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(150);
const nav = await import('../src/main.js');
const api = await import('../src/api.js');
const auth = await import('../src/auth.js');
const term = await import('../src/terminal.js');

const view = () => win.document.getElementById('view');
const q = (sel) => view().querySelector(sel);

async function openTerminal() {
  nav.navigate('terminal');
  await sleep(80);
}

/* ---------- 4. no gateway ---------- */
await check('with no gateway the screen refuses to pretend', async () => {
  term.resetTerminalForTests();
  api.setGatewayUrl('');
  await openTerminal();
  const notice = q('[data-term-notice="no-gateway"]');
  assert(notice, 'a notice must be rendered');
  assert(/no gateway configured/i.test(text(notice)), `the notice names the reason (got “${text(notice)}”)`);
  assert(/will not pretend/i.test(text(notice)), 'and promises not to fake it');
  assert(q('#term-input').disabled, 'the prompt is disabled — there is nothing to execute with');
  eq(q('[data-term-state]').dataset.termState, 'offline', 'the status chip says offline');
  // Typing app commands still works offline: they are browser-side by definition.
  term.execCommand('help');
  await sleep(50);
  assert(/App commands/.test(text(q('#term-screen'))), 'help still works without a gateway');
});

/* ---------- 5. gateway stub ---------- */
const GW = 'http://term.test';
let calls = [];
let behaviour = {};
function stubGateway(overrides = {}) {
  behaviour = {
    execStatus: 202,
    runStatus: 'running',
    stream: true,
    project: { name: 'demo-app', version: '1.2.0', scripts: ['build', 'test', 'dev', 'greet'], hasLockfile: true, hasNodeModules: false },
    ...overrides,
  };
  calls = [];
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(GW, '');
    const method = init.method || 'GET';
    calls.push({ path, method, body: init.body ? JSON.parse(init.body) : null });
    if (path === '/api/v1/auth/session') {
      return json(200, { principal: { id: 'pr-1', name: 'Owner', role: 'Owner' }, permissions: ['read', 'terminal:read', 'terminal:run', 'terminal:signal'], csrfToken: 'csrf' });
    }
    if (path === '/api/v1/terminal') {
      return json(200, {
        policy: { shell: false, executables: ['node', 'npm', 'npx'], isolation: 'process', notEnforced: ['network isolation'] },
        runtime: { node: 'v22.0.0', npm: '10.9.8', npmSource: 'probed' },
        roots: [{ id: 'data-0', path: '/tmp/workspaces', isRepo: false }],
        workspaces: [{ id: 'ws-default', name: 'default' }],
      });
    }
    if (path === '/api/v1/terminal/sessions' && method === 'GET') {
      return json(200, { sessions: [{ id: 'ts-1', workspaceName: 'default', cwd: '.', cwdPath: '/tmp/workspaces/default', project: behaviour.project, status: 'open' }] });
    }
    if (path === '/api/v1/terminal/sessions' && method === 'POST') {
      return json(201, { session: { id: 'ts-1', workspaceName: 'default', cwd: '.', cwdPath: '/tmp/workspaces/default', project: behaviour.project, status: 'open' } });
    }
    if (/^\/api\/v1\/terminal\/sessions\/[^/]+$/.test(path)) {
      return json(200, { session: { id: 'ts-1', cwd: '.', cwdPath: '/tmp/workspaces/default', project: behaviour.project } });
    }
    if (/\/exec$/.test(path) && method === 'POST') {
      if (behaviour.execStatus === 200) return json(200, { refused: true, reason: '“rm” is not an allowed executable. This terminal runs node, npm, npx only.' });
      if (behaviour.execStatus === 409) return json(409, { error: 'a command is already running in this session' });
      if (behaviour.runStatus === 'awaiting_approval') {
        return json(202, { run: { id: 'tr-gate', status: 'awaiting_approval', command: 'npm ci', approvalId: 'ap-9', destructive: true } });
      }
      return json(202, { run: { id: 'tr-1', status: 'running', command: 'node --version' } });
    }
    if (/\/api\/v1\/terminal\/runs\/[^/]+$/.test(path)) {
      // A poll must agree with the stream — a real gateway has one truth, so a stub that contradicted
      // itself would be testing the harness, not the client.
      const final = behaviour.final || { status: 'completed', code: 0 };
      return json(200, { run: { id: 'tr-1', status: final.status, exitCode: final.code, command: 'node --version', live: false } });
    }
    if (/\/signal$/.test(path)) return json(200, { runId: 'tr-1', signal: 'SIGINT' });
    if (path.startsWith('/api/v1/terminal/history')) return json(200, { history: [{ command: 'node --version' }] });
    if (path === '/api/v1/agents') return json(200, []);
    if (path === '/api/v1/tasks' || path === '/api/v1/approvals' || path.startsWith('/api/v1/events')) return json(200, []);
    if (path === '/api/v1/teams') return json(200, { teams: [] });
    return json(404, { error: 'not found' });
  };
}

/** A session already open, a project detected, and the screen rendered. */
async function withSession() {
  api.setGatewayUrl(GW);
  stubGateway();
  await auth.refreshSession({ silent: true });
  term.resetTerminalForTests();
  globalThis.EventSource = FakeEventSource;
  streams.length = 0;
  await openTerminal();
  await sleep(220);
}

await check('a gateway session shows the working directory and the project’s real scripts', async () => {
  await withSession();
  const meta = q('[data-term-cwd]');
  assert(meta, 'the cwd block must render');
  assert(/~\//.test(text(meta)), `the working directory is shown (got “${text(meta)}”)`);
  assert(/demo-app/.test(text(meta)), 'the detected package name is shown');
  const chips = [...view().querySelectorAll('[data-act="term-script"]')].map((b) => b.dataset.name);
  assert(chips.includes('build') && chips.includes('dev'), `script chips come from package.json (got ${chips.join(',')})`);
  eq(q('[data-term-state]').dataset.termState, 'ready', 'the status chip says ready');
  assert(/node v22\.0\.0/.test(text(q('#term-screen'))), 'the banner reports the host runtime it was told about');
  assert(/npm 10\.9\.8/.test(text(q('#term-screen'))), 'and the npm it actually runs, when the gateway could read it');
});

await check('a typed command is POSTed, streamed back, and shows its exit code', async () => {
  await withSession();
  const input = q('#term-input');
  input.value = 'node --version';
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(150);

  const exec = calls.find((c) => /\/exec$/.test(c.path) && c.method === 'POST');
  assert(exec, 'the command must be sent to the gateway');
  eq(exec.body.command, 'node --version', 'exactly what was typed');
  eq(input.value, '', 'the prompt is cleared');
  assert(streams.length === 1, 'one stream is opened for the run');
  assert(/\/api\/v1\/terminal\/runs\/tr-1\/stream$/.test(streams[0].url), `the stream URL (got ${streams[0].url})`);

  streams[0].emit('run', { id: 'tr-1', command: 'node --version', status: 'running' });
  streams[0].emit('chunk', { seq: 1, stream: 'out', text: 'v22.0.0\n' });
  streams[0].emit('chunk', { seq: 2, stream: 'err', text: 'a warning\n' });
  streams[0].emit('exit', { status: 'completed', code: 0, signal: null });
  await sleep(120);

  const lines = [...view().querySelectorAll('#term-screen .ln')];
  assert(lines.some((l) => l.classList.contains('out') && /v22\.0\.0/.test(l.textContent)), 'stdout lands in an out line');
  assert(lines.some((l) => l.classList.contains('err') && /a warning/.test(l.textContent)), 'stderr lands in an err line, not merged');
  const bar = q('[data-term-runbar]');
  assert(bar, 'the run bar must render');
  eq(bar.dataset.status, 'completed', 'the run bar reports the status it was given');
  assert(/exit 0/.test(text(bar)), `and the exit code (got “${text(bar)}”)`);
  assert(streams[0].closed, 'the stream is closed when the run ends');
});

await check('a failing command is reported as failed, with its code', async () => {
  await withSession();
  behaviour.final = { status: 'failed', code: 7 };
  const input = q('#term-input');
  input.value = 'node -e "process.exit(7)"';
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(150);
  streams[0].emit('exit', { status: 'failed', code: 7, signal: null });
  await sleep(120);
  const bar = q('[data-term-runbar]');
  eq(bar.dataset.status, 'failed', 'the bar says failed');
  assert(/exit 7/.test(text(bar)), `the code is shown (got “${text(bar)}”)`);
  assert(/the command failed/.test(text(q('#term-screen'))), 'and the transcript says so plainly');
});

await check('a refused command shows the gateway’s reason and opens no stream', async () => {
  api.setGatewayUrl(GW);
  stubGateway({ execStatus: 200 });
  await auth.refreshSession({ silent: true });
  term.resetTerminalForTests();
  streams.length = 0;
  await openTerminal();
  await sleep(200);
  term.execCommand('rm -rf /');
  await sleep(150);
  eq(streams.length, 0, 'nothing is streamed — nothing ran');
  const screen = text(q('#term-screen'));
  assert(/not an allowed executable/.test(screen), `the refusal is shown (got “${screen.slice(-200)}”)`);
});

await check('a destructive command says it is waiting for approval and claims nothing ran', async () => {
  api.setGatewayUrl(GW);
  stubGateway({ runStatus: 'awaiting_approval' });
  await auth.refreshSession({ silent: true });
  term.resetTerminalForTests();
  streams.length = 0;
  await openTerminal();
  await sleep(200);
  term.execCommand('npm ci');
  await sleep(150);
  eq(streams.length, 0, 'no stream: the command has not run');
  const screen = text(q('#term-screen'));
  assert(/gate ap-9/.test(screen), `the gate is named (got “${screen.slice(-200)}”)`);
  assert(/only if someone else allows it/.test(screen), 'and separation of duties is stated');
  const bar = q('[data-term-runbar]');
  eq(bar.dataset.status, 'awaiting_approval', 'the bar shows the waiting state');
  assert(/approve it in Approvals/.test(text(bar)), 'and tells the person where to go');
});

await check('Ctrl+C sends SIGINT, and Ctrl+L clears the scrollback', async () => {
  api.setGatewayUrl(GW);
  stubGateway();
  await auth.refreshSession({ silent: true });
  term.resetTerminalForTests();
  streams.length = 0;
  await openTerminal();
  await sleep(200);

  const input = q('#term-input');
  input.value = 'npm run dev';
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(150);
  calls = [];
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }));
  await sleep(120);
  const signal = calls.find((c) => /\/signal$/.test(c.path));
  assert(signal, 'Ctrl+C must reach the gateway');
  eq(signal.body.signal, 'SIGINT', 'as SIGINT');
  assert(/SIGINT/.test(text(q('#term-screen'))), 'and the transcript says what was sent');

  const before = view().querySelectorAll('#term-screen .ln').length;
  assert(before > 2, 'there is something to clear');
  q('#term-input').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true }));
  await sleep(80);
  assert(view().querySelectorAll('#term-screen .ln').length < before, 'Ctrl+L clears the scrollback');
});

await check('ArrowUp recalls the previous command', async () => {
  await withSession();
  const input = q('#term-input');
  input.value = 'node --version';
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(120);
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  await sleep(40);
  eq(input.value, 'node --version', 'history is recalled into the prompt');
});

await check('app commands run locally and never touch the network', async () => {
  await withSession();
  calls = [];
  term.execCommand('help');
  term.execCommand('status');
  await sleep(120);
  eq(calls.length, 0, 'no request was made for a browser-side command');
  const screen = text(q('#term-screen'));
  assert(/App commands/.test(screen), 'help lists the app commands');
  assert(/Process commands/.test(screen), 'and says which commands are real processes');
  assert(/npm ci and npm uninstall need an approval/.test(screen), 'and which commands need a second person');
  assert(/gateway\s+configured/.test(screen), 'status reports the gateway state it can see');

  term.execCommand('open agents');
  await sleep(120);
  eq(calls.length, 0, 'navigating is still browser-side');
  assert(!q('#term-screen'), '`open agents` actually navigates — the terminal view is gone');
  eq(term.terminalState().lines.length > 0, true, 'and the scrollback survives the screen switch');
});

await check('a script chip runs npm run for that script', async () => {
  await withSession();
  calls = [];
  const chip = [...view().querySelectorAll('[data-act="term-script"]')].find((b) => b.dataset.name === 'build');
  assert(chip, 'the build chip exists');
  chip.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(150);
  const exec = calls.find((c) => /\/exec$/.test(c.path));
  assert(exec, 'the chip posts a command');
  eq(exec.body.command, 'npm run build', 'exactly the script');
});

globalThis.EventSource = realEventSource;

console.log(results.join('\n'));
const passed = results.filter((r) => r.startsWith('PASS')).length;
console.log(`\nTERMINAL SCREEN: ${passed} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
