/* Runtime smoke test: boots the real app in happy-dom and renders every view. */
import { Window } from 'happy-dom';

const win = new Window({ url: 'http://localhost:5173/' });
const g = globalThis;
for (const k of ['window', 'document', 'navigator', 'location', 'localStorage', 'history', 'HTMLElement', 'Event', 'CustomEvent', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame', 'fetch', 'matchMedia']) {
  const value = k === 'fetch' || k === 'matchMedia' ? undefined : win[k] ?? win;
  if (value === undefined) continue;
  try {
    Object.defineProperty(g, k, { value, configurable: true, writable: true });
  } catch {
    try { g[k] = value; } catch {}
  }
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
async function check(name, fn) {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (e) {
    results.push(`FAIL ${name}: ${e.message}`);
    errors.push(e);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await import('../src/main.js');
await new Promise((r) => setTimeout(r, 100));

const view = () => win.document.getElementById('view');
const html = () => view()?.innerHTML || '';

check('boot renders shell', () => {
  if (!win.document.querySelector('.topbar')) throw new Error('no topbar');
  if (!win.document.querySelector('.tabbar')) throw new Error('no tabbar');
  if (!html().includes('Good')) throw new Error('home not rendered');
});

check('the header keeps the workspace mark but not the workspace name text', () => {
  const ws = win.document.querySelector('.topbar .ws');
  if (!ws) throw new Error('workspace block missing');
  if (ws.querySelector('#ws-name')) throw new Error('workspace name text still rendered');
  if (/SwarmLab/.test(ws.textContent)) throw new Error('workspace name text still visible');
  if (!ws.querySelector('.ws-logo')) throw new Error('workspace mark removed');
  if (!/SwarmLab workspace/.test(ws.getAttribute('aria-label') || '')) throw new Error('workspace name no longer announced');
});

const { navigate, rerender } = await import('../src/main.js');

const markers = {
  home: 'Quick actions', designer: 'Agent Designer', agents: 'LangGraph', teams: 'Live swarms', tasks: 'Drag a card, then confirm',
  chat: 'chat-input', skills: 'Skills Hub', matrix: 'Skills Matrix', models: 'Model Gateway', plugins: 'Add MCP server',
  comms: 'Comms', local: 'Local AI', telegram: 'Telegram Bridge', analytics: 'Agent leaderboard', artifacts: 'Artifacts',
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

/* ---------- Copilot Phase 1 (FAB, panel, holo, modes, cards, memory) ---------- */
const copilot = await import('../src/copilot.js');
const doc = win.document;
const panelEl = () => doc.getElementById('copilot-panel');

await check('the header carries Chat next to notifications, the tab bar carries Tasks', () => {
  const topbar = doc.querySelector('.topbar');
  const chat = doc.getElementById('chat-btn');
  if (!chat) throw new Error('no Chat action in the header');
  if (chat.getAttribute('data-to') !== 'chat') throw new Error('header Chat does not route to chat');
  if (chat.getAttribute('aria-label') !== 'Chat') throw new Error('header Chat lacks an accessible name');
  if (!chat.querySelector('svg')) throw new Error('header Chat has no icon');
  const bell = [...topbar.querySelectorAll('.iconbtn')].find((b) => b.dataset.act === 'notifications');
  if (!bell) throw new Error('no notifications button');
  if (chat.nextElementSibling !== bell) throw new Error('header Chat is not next to the bell');
  const tabs = [...doc.querySelectorAll('#tabbar [data-tab]')].map((b) => b.dataset.tab);
  if (tabs.includes('chat')) throw new Error('Chat is still a bottom tab');
  if (!tabs.includes('tasks')) throw new Error('Tasks is missing from the bottom bar');
  if (tabs.join(',') !== 'home,agents,tasks') throw new Error(`unexpected tabs: ${tabs.join(',')}`);
  navigate('chat');
  rerender();
  if (!doc.getElementById('chat-btn').classList.contains('active')) throw new Error('header Chat does not highlight on #/chat');
  if (doc.getElementById('chat-btn').getAttribute('aria-current') !== 'page') throw new Error('aria-current not set on #/chat');
  navigate('home');
  rerender();
  if (doc.getElementById('chat-btn').classList.contains('active')) throw new Error('header Chat stays highlighted off #/chat');
});

await check('copilot launcher is the central bottom-nav action', () => {
  const tabbar = doc.getElementById('tabbar');
  if (!tabbar) throw new Error('no tab bar');
  const slots = [...tabbar.children];
  if (slots.length !== 5) throw new Error(`expected 5 nav slots, got ${slots.length}`);
  const fab = tabbar.querySelector('.cp-fab-slot');
  if (!fab) throw new Error('no central Copilot launcher');
  if (slots.indexOf(fab) !== 2) throw new Error('launcher is not in the centre slot');
  if (fab.getAttribute('aria-label') !== 'Open Copilot') throw new Error('launcher lacks an accessible name');
  if (fab.getAttribute('aria-haspopup') !== 'dialog') throw new Error('launcher does not advertise a dialog');
  if (doc.querySelector('.dock')) throw new Error('duplicate dock launcher still present');
  if (doc.querySelector('.fab')) throw new Error('floating + FAB still overlaps the nav');
});

await check('copilot panel opens with a blank canvas + holographic layer', () => {
  copilot.openCopilot();
  const p = panelEl();
  if (!p) throw new Error('panel missing');
  if (p.getAttribute('role') !== 'dialog') throw new Error('panel is not a dialog');
  if (p.dataset.blank !== 'true') throw new Error('blank state not derived as true');
  const holo = p.querySelector('.cp-holo');
  if (!holo) throw new Error('no holographic layer');
  if (holo.getAttribute('aria-hidden') !== 'true') throw new Error('holo layer must be aria-hidden');
  if (p.querySelectorAll('.cp-mode').length !== 7) throw new Error('expected 7 modes');
  if (!p.querySelector('#cp-runtime')?.textContent.includes('Demo data')) throw new Error('runtime status not labelled');
  if (!doc.querySelector('[data-act="copilot-open"]')?.getAttribute('aria-expanded')) throw new Error('launcher not marked expanded');
});

await check('sending a message fades the holographic layer and answers from live state', async () => {
  copilot.copilotSend('status');
  await sleep(420);
  const p = panelEl();
  if (p.dataset.blank !== 'false') throw new Error('holographic layer did not fade (data-blank still true)');
  const text = p.querySelector('#copilot-work').textContent;
  if (!/Agents:/.test(text)) throw new Error('live status answer missing');
  if (!p.querySelector('.cp-badge.ok, .cp-badge.info')) throw new Error('no verification label on the answer');
});

await check('consequential action needs two confirmations and records evidence', async () => {
  copilot.resetCopilotSession();
  copilot.openCopilot();
  copilot.setCopilotMode('operate');
  copilot.copilotSend('deploy swarm audit the plugin registry');
  await sleep(420);
  let p = panelEl();
  const risk = p.querySelector('.cp-proposal')?.dataset.risk;
  if (risk !== 'consequential') throw new Error(`expected consequential risk, got ${risk}`);
  const arm = p.querySelector('[data-cp="arm"]');
  if (!arm) throw new Error('no review step for a consequential action');
  arm.click();
  const confirm = p.querySelector('[data-cp="confirm"]');
  if (!confirm) throw new Error('no second confirmation after arming');
  confirm.click();
  await sleep(30);
  p = panelEl();
  if (!p.querySelector('.cp-result[data-status="ok"]')) throw new Error('no success result card');
  if (!p.textContent.includes('Simulated runtime')) throw new Error('simulated runtime not disclosed');
  const ep = copilot.listEpisodes(1)[0];
  if (!ep || ep.outcome !== 'ok') throw new Error('episodic evidence not recorded');
  if (!ep.evidence.length) throw new Error('episode has no evidence steps');
});

await check('creating an agent mutates state and can be verified', async () => {
  copilot.resetCopilotSession();
  copilot.openCopilot({ mode: 'operate' });
  copilot.copilotSend('create agent PhaseBot');
  await sleep(420);
  const p = panelEl();
  const btn = p.querySelector('[data-cp="confirm"]');
  if (!btn) throw new Error('no confirm button for reversible action');
  btn.click();
  await sleep(30);
  if (!p.textContent.includes('PhaseBot')) throw new Error('result does not mention the new agent');
  if (!doc.body.innerHTML.includes('Copilot') ) throw new Error('panel vanished');
  const { getState } = await import('../src/core.js');
  if (!getState().agents.some((a) => /phasebot/i.test(a.name))) throw new Error('agent not written to state');
});

await check('training mode reports the blocker instead of faking a job', async () => {
  copilot.resetCopilotSession();
  copilot.openCopilot({ mode: 'training' });
  copilot.copilotSend('validate dataset');
  await sleep(420);
  const p = panelEl();
  const text = p.querySelector('#copilot-work').textContent.toLowerCase();
  if (!text.includes('blocked')) throw new Error('missing blocked status');
  if (!text.includes('not a dataset audit')) throw new Error('limitations not stated');
  if (p.textContent.includes('progress') && p.textContent.includes('epoch')) throw new Error('fake training progress detected');
});

await check('unknown question admits missing evidence', async () => {
  copilot.resetCopilotSession();
  copilot.openCopilot({ mode: 'ask' });
  copilot.copilotSend('what is the airspeed velocity of an unladen swallow');
  await sleep(420);
  const text = panelEl().querySelector('#copilot-work').textContent;
  if (!/no grounded answer/i.test(text)) throw new Error('did not admit ignorance');
  if (!/will not guess/i.test(text)) throw new Error('did not refuse to fabricate');
});

await check('knowledge search returns sources and verification status', async () => {
  const hits = copilot.searchKnowledge('gateway authentication');
  if (!hits.length) throw new Error('no knowledge hits');
  if (!hits[0].sources.length) throw new Error('no sources on the top hit');
  if (!hits[0].status) throw new Error('no verification status');
  copilot.resetCopilotSession();
  copilot.openCopilot({ mode: 'knowledge' });
  copilot.copilotSend('gateway authentication');
  await sleep(420);
  const p = panelEl();
  if (!p.querySelector('.cp-kb')) throw new Error('knowledge results not rendered');
  if (!p.textContent.includes('apps/gateway/server.js')) throw new Error('source file reference missing');
});

await check('draft survives closing and reopening the panel', async () => {
  copilot.resetCopilotSession();
  copilot.openCopilot();
  const input = doc.getElementById('copilot-input');
  input.value = 'half-typed thought about approvals';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  await sleep(300);
  copilot.closeCopilot();
  if (panelEl()) throw new Error('panel did not close');
  copilot.openCopilot();
  if (doc.getElementById('copilot-input').value !== 'half-typed thought about approvals') throw new Error('draft lost');
  const fab = doc.querySelector('[data-act="copilot-open"]');
  if (fab.getAttribute('aria-expanded') !== 'true') throw new Error('launcher state not restored');
});

await check('escape closes the panel and memory redacts secrets', () => {
  const p = panelEl();
  p.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  if (panelEl()) throw new Error('Escape did not close the panel');
  copilot.pushEpisode({ mode: 'operate', intent: 'token sk-abcdef1234567890', summary: 'api_key=supersecretvalue', outcome: 'ok' });
  const ep = copilot.listEpisodes(1)[0];
  const raw = JSON.stringify(ep);
  if (raw.includes('sk-abcdef1234567890') || raw.includes('supersecretvalue')) throw new Error('secret leaked into memory');
  if (!raw.includes('[redacted]')) throw new Error('redaction marker missing');
});

await check('legacy copilotSay action cards still execute', () => {
  copilot.resetCopilotSession();
  copilot.openCopilot();
  let ran = false;
  copilot.copilotSay('legacy card check', {
    title: 'LEGACY ACTION',
    risk: 'low',
    rows: [['Name', 'LegacyBot']],
    confirm: 'Run legacy',
    run: () => { ran = true; },
  });
  const btn = panelEl().querySelector('[data-cp="confirm"]');
  if (!btn) throw new Error('legacy confirm button not rendered');
  btn.click();
  if (!ran) throw new Error('legacy run() did not execute');
});

await check('gateway probe reports a truthful status', async () => {
  const gw = await copilot.probeGateway({ timeoutMs: 700 });
  if (!['reachable', 'unreachable', 'unknown'].includes(gw.status)) throw new Error(`unexpected status ${gw.status}`);
  if (gw.status === 'reachable' && !gw.url) throw new Error('reachable without a URL');
  if (gw.status === 'unreachable' && !gw.detail) throw new Error('unreachable without a reason');
});

copilot.resetCopilotSession();

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
