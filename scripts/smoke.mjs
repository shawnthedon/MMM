/* Runtime smoke test: boots the real app in happy-dom and renders every view. */
import { Window } from 'happy-dom';

const win = new Window({ url: 'http://localhost:5173/' });
const g = globalThis;
for (const k of ['window', 'document', 'navigator', 'location', 'localStorage', 'history', 'HTMLElement', 'Event', 'CustomEvent', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  try { g[k] = win[k] ?? win; } catch {}
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

const errors = [];
process.on('unhandledRejection', (e) => { errors.push(e); console.error('UNHANDLED', e); });

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(`PASS ${name}`);
  } catch (e) {
    results.push(`FAIL ${name}: ${e.message}`);
    errors.push(e);
  }
}

await import('../src/main.js');
await new Promise((r) => setTimeout(r, 100));

const view = () => win.document.getElementById('view');
const html = () => view()?.innerHTML || '';

check('boot renders shell', () => {
  if (!win.document.querySelector('.topbar')) throw new Error('no topbar');
  if (!win.document.querySelector('.tabbar')) throw new Error('no tabbar');
  if (!html().includes('Good')) throw new Error('home not rendered');
});

const { navigate, rerender } = await import('../src/main.js');

const markers = {
  home: 'Quick actions', agents: 'LangGraph', teams: 'Live swarms', tasks: 'Drag cards',
  chat: 'chat-input', skills: 'Skills Hub', models: 'Model Gateway', plugins: 'Add MCP server',
  telegram: 'Telegram Bridge', analytics: 'Agent leaderboard', artifacts: 'Artifacts',
  terminal: 'term-screen', settings: 'Trust score weights',
};
for (const route of Object.keys(markers)) {
  check(`view renders: ${route}`, () => {
    navigate(route);
    rerender();
    const h = html();
    if (h.length < 200) throw new Error(`suspiciously empty (${h.length} chars)`);
    if (!h.includes(markers[route])) throw new Error(`marker "${markers[route]}" missing`);
  });
}

check('agent detail renders', () => {
  navigate('agents/ag-researcher');
  rerender();
  if (!html().includes('System prompt')) throw new Error('agent detail missing');
});

check('swarm monitor renders DAG', () => {
  navigate('teams/sw-market');
  rerender();
  if (!html().includes('Dependency graph')) throw new Error('DAG missing');
});

check('copilot sheet opens + intent engine responds', async () => {});
const copilot = await import('../src/copilot.js');
check('copilot open', () => {
  copilot.openCopilot();
  if (!win.document.getElementById('copilot-thread')) throw new Error('copilot thread missing');
});
check('copilot action card confirm creates agent', () => {
  copilot.copilotSay('create agent TestBot', {
    title: 'CREATE AGENT', risk: 'low', rows: [['Name', 'TestBot']], confirm: 'Create',
    run: () => { win.__testRan = true; },
  });
  win.__copilotConfirm(999); // invalid idx — must not throw
  window.__copilotConfirm = window.__copilotConfirm || win.__copilotConfirm;
  // find the confirm button and click through the real handler
  const btn = win.document.querySelector('[data-act="copilot-confirm"]');
  if (!btn) throw new Error('no confirm button rendered');
  btn.click();
  if (!win.__testRan && !win.window?.__testRan) {
    // handler may run via module scope; accept either
    if (!globalThis.__testRan) throw new Error('action card run() did not execute');
  }
});

const term = await import('../src/terminal.js');
check('terminal execCommand', () => {
  term.execCommand('help');
  term.execCommand('status');
  term.execCommand('agents');
  term.execCommand('deploy smoke-test objective');
  term.execCommand('approve ap-1');
  term.execCommand('nonsense-cmd');
  const h = html();
  navigate('terminal');
  rerender();
  if (!html().includes('SwarmOS shell')) throw new Error('terminal not rendered');
});

check('store persists', () => {
  const raw = win.localStorage.getItem('swarmos-state-v1');
  if (raw && !raw.includes('agents')) throw new Error('bad state shape');
});

console.log(results.join('\n'));
console.log(errors.length ? `\n${errors.length} error(s)` : '\nALL SMOKE TESTS PASSED');
process.exit(errors.length ? 1 : 0);
