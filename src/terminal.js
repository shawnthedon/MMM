/* ============ Terminal — a real shell on the gateway, not a simulation ============
 * The browser cannot execute anything. Every process command typed here is POSTed to the gateway,
 * spawned there, and streamed back over `text/event-stream`; this file is the view and the session
 * bookkeeping, nothing more.
 *
 * Two kinds of command live in this prompt, and the screen tells them apart:
 *   • **App commands** (`help`, `status`, `agents`, `open`, `theme`, …) run in the browser against
 *     state the app already has. They never claim to be shell commands.
 *   • **Process commands** (`node …`, `npm …`, `npx …`) run as real child processes on the gateway.
 *
 * What was removed here, on purpose: `deploy` used to fabricate a swarm with six invented nodes and
 * `run` flipped an agent's status flag. Both now say what they would call and that it is not
 * implemented — a command that cannot act prints why, instead of inventing a result.
 */
import { getState, setState, esc, icon, logEvent, pendingApprovals, fmtMoney, now } from './core.js';
import { toast, on } from './shell.js';
import { views } from './views1.js';
import { api, isApiMode, streamUrl, ApiError } from './api.js';
import './terminal.css';

const BANNER = [
  { kind: 'dim', text: 'MMM terminal · real processes on the gateway · one command at a time' },
  { kind: 'dim', text: 'Type `help` for app commands. Anything else must be node, npm or npx.' },
];

/* ---------- client-side session model ----------
 * Kept out of the app state: this is view-local and must never be persisted to localStorage, because
 * a transcript can hold anything a process printed.
 */
const term = {
  ready: false,
  loading: false,
  error: null,
  capability: null,
  sessions: [],
  activeId: null,
  lines: [],
  runs: [], // known runs in this session, newest last
  activeRun: null, // { id, status, command }
  cwd: '.',
  project: null,
  history: [],
  historyIndex: -1,
  stream: null,
  seq: 0,
};

const sessionApi = () => term.sessions.find((s) => s.id === term.activeId) || null;

function pushLine(kind, text) {
  if (!text) return;
  term.lines.push({ kind, text });
  // A terminal is a scrollback, not a log store: keep the last 4000 lines.
  if (term.lines.length > 4000) term.lines.splice(0, term.lines.length - 4000);
  appendToScreen(kind, text);
}

function pushMany(lines) {
  for (const line of lines) pushLine(line.kind, line.text);
}

function resetLines() {
  term.lines = BANNER.slice();
}

/* ---------- rendering ---------- */

const lineHTML = (line) => `<div class="ln ${line.kind || ''}">${esc(line.text)}</div>`;

function screenEl() {
  return document.getElementById('term-screen');
}

function appendToScreen(kind, text) {
  const screen = screenEl();
  if (!screen) return;
  // Streamed chunks arrive without trailing newlines of their own in the middle of a line, so a
  // chunk is appended to the current node when it is a continuation of the same stream.
  const last = screen.lastElementChild;
  if (last && last.dataset.stream === kind && !last.dataset.closed) {
    last.textContent += text;
    const parts = last.textContent.split('\n');
    if (parts.length > 1) {
      last.textContent = parts[0];
      last.dataset.closed = '1';
      for (const part of parts.slice(1)) appendToScreen(kind, part);
    }
  } else {
    const div = document.createElement('div');
    div.className = `ln ${kind || ''}`;
    div.dataset.stream = kind || '';
    div.textContent = text;
    const parts = text.split('\n');
    if (parts.length > 1) {
      div.textContent = parts[0];
      div.dataset.closed = '1';
      screen.appendChild(div);
      for (const part of parts.slice(1)) appendToScreen(kind, part);
    } else {
      screen.appendChild(div);
    }
  }
  screen.scrollTop = screen.scrollHeight;
}

function statusChip() {
  if (!term.ready) return '<span class="chip tiny" data-term-state="offline">gateway not configured</span>';
  if (term.loading) return '<span class="chip tiny" data-term-state="loading">connecting…</span>';
  if (term.activeRun && isRunning(term.activeRun.status)) {
    return `<span class="chip tiny warn" data-term-state="running"><span class="pulse-dot live"></span>running</span>`;
  }
  if (term.error) return `<span class="chip tiny bad" data-term-state="error">gateway error</span>`;
  return '<span class="chip tiny ok" data-term-state="ready"><span class="pulse-dot live"></span>ready</span>';
}

const isRunning = (status) => status === 'running' || status === 'queued';

const STATUS_LABEL = {
  running: 'running', queued: 'queued', completed: 'completed', failed: 'failed',
  cancelled: 'stopped', timed_out: 'timed out', refused: 'refused',
  awaiting_approval: 'waiting for approval', blocked: 'blocked',
};

function cwdHTML() {
  const session = sessionApi();
  const project = term.project;
  const scripts = project?.scripts || [];
  return `
    <div class="term-project" data-term-cwd>
      <div class="term-cwd">
        <span class="term-cwd-label">cwd</span>
        <code class="term-cwd-path" title="${esc(session?.cwdPath || '')}">${esc(term.cwd === '.' ? '~/' : `~/` + esc(term.cwd))}</code>
        ${session?.workspaceName ? `<span class="tiny muted">· ${esc(session.workspaceName)}</span>` : ''}
      </div>
      ${project
        ? `<div class="term-project-meta">
             <span class="chip tiny">${esc(project.name || 'package.json')}${project.version ? `@${esc(project.version)}` : ''}</span>
             ${scripts.length
               ? scripts.slice(0, 6).map((s) => `<button class="chip tiny" data-act="term-script" data-name="${esc(s)}">npm run ${esc(s)}</button>`).join('')
               : '<span class="tiny muted">package.json has no scripts</span>'}
             ${project.hasNodeModules ? '<span class="chip tiny ok">node_modules</span>' : ''}
           </div>`
        : `<div class="term-project-meta tiny muted" data-term-noproject>No package.json here — <button class="linkish" data-act="term-key" data-k="npm init -y">npm init -y</button> to start one.</div>`}
    </div>`;
}

function runBarHTML() {
  if (!term.activeRun) return '';
  const label = STATUS_LABEL[term.activeRun.status] || term.activeRun.status;
  const running = isRunning(term.activeRun.status);
  return `
    <div class="term-runbar" data-term-runbar data-status="${esc(term.activeRun.status)}">
      <div class="term-runbar-main">
        <span class="term-runbar-state ${running ? 'is-running' : ''}">${running ? '<span class="pulse-dot live"></span>' : ''}${esc(label)}</span>
        <code class="term-runbar-cmd">${esc(term.activeRun.command || '')}</code>
        ${term.activeRun.exitCode !== null && term.activeRun.exitCode !== undefined ? `<span class="chip tiny ${term.activeRun.exitCode === 0 ? 'ok' : 'bad'}">exit ${esc(String(term.activeRun.exitCode))}</span>` : ''}
      </div>
      ${running
        ? `<button class="btn sm" data-act="term-interrupt" data-id="${esc(term.activeRun.id)}">${icon('stop', 13)} Stop</button>`
        : term.activeRun.approvalId
          ? `<span class="tiny muted">gate ${esc(term.activeRun.approvalId)} — approve it in Approvals</span>`
          : ''}
    </div>`;
}

function quickKeys() {
  const keys = ['help', 'clear'];
  const session = sessionApi();
  if (session?.project?.scripts?.includes('build')) keys.push('npm run build');
  if (session?.project?.scripts?.includes('test')) keys.push('npm run test');
  if (session?.project?.scripts?.includes('dev')) keys.push('npm run dev');
  keys.push('node --version', 'npm --version');
  return keys;
}

function noticeHTML() {
  if (!isApiMode()) {
    return `<div class="term-notice" data-term-notice="no-gateway" role="note">
      ${icon('info', 16)}
      <div><strong>No gateway configured.</strong> Real commands run on the gateway host, so this terminal
      has nothing to execute with. Configure a gateway URL in Settings — the app will not pretend to run
      <code>npm</code> in the browser.</div>
    </div>`;
  }
  if (term.error) {
    return `<div class="term-notice bad" data-term-notice="error" role="note">
      ${icon('info', 16)}<div><strong>Gateway error.</strong> ${esc(term.error)}</div></div>`;
  }
  return '';
}

/* ---------- data ---------- */

async function loadCapability() {
  if (!isApiMode()) { term.ready = false; return; }
  try {
    const out = await api.terminal();
    term.capability = out.body;
    term.ready = true;
    term.error = null;
  } catch (error) {
    term.ready = false;
    term.error = error instanceof ApiError && error.forbidden
      ? `your role does not include terminal:read (${error.message})`
      : error.message;
  }
}

async function loadSessions() {
  if (!isApiMode()) return;
  try {
    const out = await api.terminalSessions();
    term.sessions = out.body.sessions || [];
    if (!term.sessions.some((s) => s.id === term.activeId)) {
      term.activeId = term.sessions[0]?.id || null;
    }
    if (term.activeId) await adoptSession(term.activeId, { silent: true });
  } catch (error) {
    term.error = error.message;
  }
}

async function adoptSession(id, { silent = false } = {}) {
  const session = term.sessions.find((s) => s.id === id);
  if (!session) return;
  term.activeId = id;
  term.cwd = session.cwd;
  term.project = session.project;
  // A run that was still going when the screen was closed keeps its stream: switching screens must
  // not orphan a process or lose its output.
  if (session.runningRunId && !term.activeRun) {
    attachRun(session.runningRunId, { command: '(resuming)' });
  }
  if (!silent) render();
}

async function loadHistory() {
  if (!isApiMode() || !term.activeId) return;
  try {
    const out = await api.terminalHistory(term.activeId);
    term.history = (out.body.history || []).map((h) => h.command).filter(Boolean);
  } catch { /* history is a convenience, not a contract */ }
}

async function ensureSession() {
  if (!isApiMode()) return null;
  if (term.activeId) return sessionApi();
  const out = await api.createTerminalSession({});
  term.sessions = [out.body.session, ...term.sessions.filter((s) => s.id !== out.body.session.id)];
  await adoptSession(out.body.session.id, { silent: true });
  return out.body.session;
}

/* ---------- execution ---------- */

async function exec(command) {
  const line = String(command || '').trim();
  if (!line) return;
  pushLine('cmd', `❯ ${line}`);
  term.history = [line, ...term.history.filter((h) => h !== line)].slice(0, 100);
  term.historyIndex = -1;

  if (handleAppCommand(line)) return;

  if (!isApiMode()) {
    pushLine('err', 'no gateway is configured, so nothing can be executed — this is not a simulated shell');
    return;
  }

  let session;
  try {
    session = await ensureSession();
  } catch (error) {
    pushLine('err', `could not open a terminal session: ${error.message}`);
    return;
  }
  if (!session) return;

  try {
    const out = await api.terminalExec(session.id, line);
    const body = out.body || {};
    if (body.refused) {
      pushLine('err', `${body.reason}`);
      updateRunBar();
      return;
    }
    const run = body.run;
    if (!run) { pushLine('err', 'the gateway did not return a run'); return; }
    if (run.status === 'awaiting_approval') {
      pushLine('sys', `[mmm] this command is destructive — gate ${run.approvalId} was opened. It will run only if someone else allows it.`);
      term.activeRun = { id: run.id, status: run.status, command: run.command, approvalId: run.approvalId };
      updateRunBar();
      return;
    }
    attachRun(run.id, { command: run.command });
  } catch (error) {
    pushLine('err', error instanceof ApiError && error.forbidden
      ? `refused: ${error.message}`
      : `the gateway could not start that command: ${error.message}`);
  }
}

/** Read + stream one run, then leave it in scrollback. */
function attachRun(runId, { command = '' } = {}) {
  closeStream();
  term.seq = 0;
  term.activeRun = { id: runId, status: 'running', command, exitCode: null };
  updateRunBar();

  const source = new EventSource(streamUrl(`/api/v1/terminal/runs/${encodeURIComponent(runId)}/stream`));
  term.stream = source;
  let finished = false;

  source.addEventListener('run', (event) => {
    const run = JSON.parse(event.data);
    if (run.command) term.activeRun.command = run.command;
    updateRunBar();
  });
  source.addEventListener('chunk', (event) => {
    const chunk = JSON.parse(event.data);
    term.seq = chunk.seq ?? term.seq;
    pushLine(chunk.stream === 'err' ? 'err' : chunk.stream === 'sys' ? 'sys' : 'out', chunk.text);
  });
  source.addEventListener('exit', (event) => {
    const data = JSON.parse(event.data);
    finished = true;
    source.close();
    if (term.stream === source) term.stream = null;
    term.activeRun = { ...(term.activeRun || {}), id: runId, status: data.status, exitCode: data.code ?? null };
    // Refresh what the shell can see now: a command may have created package.json or node_modules.
    refreshSessionMeta(runId);
    updateRunBar();
    if (data.status === 'failed') {
      pushLine('dim', `exit ${data.code ?? '?'} — the command failed; the output above is its own`);
    }
  });
  source.addEventListener('error', () => {
    if (finished) return;
    // EventSource retries by itself; after a terminal close it must not spin.
    source.close();
    if (term.stream === source) term.stream = null;
    pushLine('sys', '[mmm] the output stream closed before the process reported an exit');
    updateRunBar();
  });
}

function closeStream() {
  if (term.stream) {
    try { term.stream.close(); } catch { /* already closed */ }
    term.stream = null;
  }
}

async function refreshSessionMeta(runId) {
  if (!term.activeId) return;
  try {
    const [session, run] = await Promise.all([
      api.terminalSession(term.activeId),
      runId ? api.terminalRun(runId) : Promise.resolve({ body: { run: null } }),
    ]);
    term.cwd = session.body.session.cwd;
    term.project = session.body.session.project;
    if (run.body.run) term.activeRun = { ...term.activeRun, ...run.body.run, command: run.body.run.command };
  } catch { /* the meta refresh is cosmetic; the transcript is already correct */ }
  rerenderChrome();
}

async function interrupt() {
  const run = term.activeRun;
  if (!run?.id) return;
  try {
    await api.terminalSignal(run.id, 'SIGINT');
    pushLine('sys', '[mmm] sent SIGINT — waiting for the process to exit');
  } catch (error) {
    pushLine('err', `could not interrupt: ${error.message}`);
  }
}

/* ---------- app commands (browser-side, and labelled as such) ---------- */

const HELP = [
  'App commands — these run in the browser against state the app already has:',
  '  help                     this list',
  '  status                   gateway + fleet summary',
  '  agents | tasks | spend | approvals',
  '  open <module>            navigate the app',
  '  theme <dark|light|system>',
  '  history                  previous commands in this session',
  '  clear                    clear the scrollback (Ctrl+L)',
  '',
  'Process commands — these run as real child processes on the gateway:',
  '  node --version · npm --version · npm init -y · npm install [pkg] · npm install -D <pkg>',
  '  npm run <script> · npm start · npm update · npm audit · npm outdated · npx <pkg>',
  '  npm ci and npm uninstall need an approval from a different person.',
  '',
  'Not a shell: no pipes, redirects, chaining or substitution (a command that needs a shell says so).',
];

function handleAppCommand(line) {
  const [cmd, ...rest] = line.split(/\s+/);
  const arg = rest.join(' ');
  const s = getState();
  switch (cmd.toLowerCase()) {
    case 'help':
      pushMany(HELP.map((t) => ({ kind: t.startsWith('  ') ? 'dim' : 'ok', text: t })));
      return true;
    case 'status': {
      const gw = term.capability?.policy;
      pushMany([
        { kind: 'ok', text: `gateway   ${isApiMode() ? 'configured' : 'not configured'}` },
        { kind: '', text: `agents    ${s.agents.filter((a) => a.status === 'running').length} running / ${s.agents.length}` },
        { kind: '', text: `approvals ${pendingApprovals().length} pending` },
        { kind: '', text: `spend     ${fmtMoney(s.agents.reduce((a, x) => a + x.costToday, 0))} today` },
        { kind: '', text: `terminal  ${term.ready ? `node ${term.capability?.runtime?.node || 'unknown'} · ${gw ? gw.executables.join('/') : 'no policy'}` : 'unavailable'}` },
      ]);
      return true;
    }
    case 'agents':
      pushMany(s.agents.map((a) => ({ kind: '', text: `${a.id.padEnd(14)} ${a.name.padEnd(16)} ${a.status.padEnd(8)} trust ${a.trust}` })));
      return true;
    case 'tasks':
      pushMany(s.tasks.map((t) => ({ kind: '', text: `[${t.column.padEnd(6)}] ${t.title}` })));
      return true;
    case 'approvals':
      pushMany(pendingApprovals().length
        ? pendingApprovals().map((a) => ({ kind: '', text: `${a.id}  ${a.action} · ${a.target} · ${a.risk} risk` }))
        : [{ kind: 'dim', text: 'no pending approvals' }]);
      return true;
    case 'spend':
      pushMany([
        ...s.agents.map((a) => ({ kind: '', text: `${a.name.padEnd(16)} ${fmtMoney(a.costToday)}` })),
        { kind: 'ok', text: `TOTAL            ${fmtMoney(s.agents.reduce((a, x) => a + x.costToday, 0))}` },
      ]);
      return true;
    case 'open': {
      const map = { agents: 'agents', teams: 'teams', swarms: 'teams', tasks: 'tasks', chat: 'chat', skills: 'skills', models: 'models', plugins: 'plugins', analytics: 'analytics', files: 'artifacts', artifacts: 'artifacts', settings: 'settings', home: 'home', approvals: 'approvals' };
      if (map[arg]) {
        pushLine('dim', `→ navigating to ${map[arg]}`);
        import('./main.js').then((m) => m.navigate(map[arg]));
      } else pushLine('err', `open: unknown module “${arg}”`);
      return true;
    }
    case 'theme':
      if (['dark', 'light', 'system', 'contrast'].includes(arg)) {
        setState((st) => { st.settings.theme = arg; }, 'term-theme');
        import('./shell.js').then((m) => m.applyTheme());
        pushLine('ok', `theme → ${arg}`);
      } else pushLine('err', 'theme: use `theme dark` or `theme light`');
      return true;
    case 'history':
      pushMany(term.history.slice(0, 15).map((h) => ({ kind: 'dim', text: h })));
      return true;
    case 'clear':
      resetLines();
      render();
      return true;
    case 'run':
    case 'deploy':
      // These used to fabricate an agent state change and a six-node swarm. A command that cannot act
      // must say so — and name the route it would need.
      pushLine('err', cmd === 'run'
        ? 'run: starting an agent is not implemented — it needs POST /api/v1/agents/:id/run, which does not exist yet'
        : 'deploy: swarm deployment is not implemented — it needs POST /api/v1/swarms, which does not exist yet');
      return true;
    default:
      return false;
  }
}

/* ---------- chrome updates (cheap, no full re-render) ---------- */

function updateRunBar() {
  const host = document.getElementById('term-runbar-host');
  if (!host) return;
  host.innerHTML = runBarHTML();
}

function rerenderChrome() {
  const chipHost = document.getElementById('term-status-host');
  if (chipHost) chipHost.innerHTML = statusChip();
  const meta = document.getElementById('term-meta-host');
  if (meta) meta.innerHTML = cwdHTML();
  updateRunBar();
}

/* ---------- the view ---------- */

views.terminal = {
  title: 'Terminal',
  persistent: true,
  render() {
    const session = sessionApi();
    return `
      <div class="term-wrap">
        <div class="row between wrap" style="margin-bottom:8px;gap:8px">
          <div class="row" style="gap:8px;align-items:center">
            <h1 style="font-size:18px">Terminal</h1>
            <span id="term-status-host">${statusChip()}</span>
          </div>
          <div class="row" style="gap:8px">
            <button class="btn sm" data-act="term-new-session" ${isApiMode() && term.ready ? '' : 'disabled'}>${icon('plus', 13)} Session</button>
            <button class="btn sm" data-act="term-clear-btn">${icon('undo', 13)} Clear</button>
          </div>
        </div>

        ${noticeHTML()}

        ${term.sessions.length > 1
          ? `<div class="scroll-x term-sessions" data-term-sessions>
               ${term.sessions.map((s) => `<button class="chip ${s.id === term.activeId ? 'brand' : ''}" data-act="term-session" data-id="${esc(s.id)}">
                 ${icon('terminal', 12)} ${esc(s.workspaceName || 'session')}${s.runningRunId ? ' ·running' : ''}
               </button>`).join('')}
             </div>`
          : ''}

        <div id="term-meta-host">${cwdHTML()}</div>

        <div class="term" id="term-screen" role="log" aria-live="polite" aria-label="Terminal output" tabindex="0">
          ${term.lines.map(lineHTML).join('')}
        </div>

        <div id="term-runbar-host">${runBarHTML()}</div>

        <div class="term-keys" data-term-keys>
          ${quickKeys().map((k) => `<button data-act="term-key" data-k="${esc(k)}">${esc(k)}</button>`).join('')}
        </div>

        <div class="term-input-row" style="border:1px solid var(--border-soft);border-radius:12px;padding:10px 12px">
          <span class="p">❯</span>
          <input id="term-input" placeholder="${isApiMode() ? 'npm install · node --version · help' : 'no gateway configured'}"
                 autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
                 aria-label="Terminal command" ${isApiMode() ? '' : 'disabled'}>
          <button class="send-btn" style="width:44px;height:44px;border-radius:12px" data-act="term-run-btn" aria-label="Run command">${icon('send', 15)}</button>
        </div>
        <div class="tiny muted term-hint" data-term-hint>
          ${session ? `${esc(session.cwdPath || '')} · ${term.capability?.policy?.shell === false ? 'no shell' : ''}` : 'a session opens on your first command'}
          · Ctrl+C stops a running command · Ctrl+L clears
        </div>
      </div>`;
  },
  mount() {
    const screen = screenEl();
    if (screen) screen.scrollTop = screen.scrollHeight;
    const input = document.getElementById('term-input');
    if (!input) return;
    input.focus({ preventScroll: true });

    input.addEventListener('keydown', (event) => {
      if (event.ctrlKey && (event.key === 'c' || event.key === 'C')) {
        // Ctrl+C with a running command interrupts it; with an empty prompt it clears the line,
        // exactly like a shell.
        event.preventDefault();
        if (isRunning(term.activeRun?.status)) interrupt();
        else { input.value = ''; pushLine('dim', '^C'); }
        return;
      }
      if (event.ctrlKey && (event.key === 'l' || event.key === 'L')) {
        event.preventDefault();
        resetLines();
        render();
        document.getElementById('term-input')?.focus();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const value = input.value;
        input.value = '';
        exec(value);
        return;
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        if (!term.history.length) return;
        event.preventDefault();
        const delta = event.key === 'ArrowUp' ? 1 : -1;
        term.historyIndex = Math.min(Math.max(term.historyIndex + delta, -1), term.history.length - 1);
        input.value = term.historyIndex < 0 ? '' : term.history[term.historyIndex] || '';
        // Put the caret at the end, as a shell does.
        requestAnimationFrame(() => input.setSelectionRange(input.value.length, input.value.length));
      }
    });

    // First paint: capability + sessions. Both are reads, so a fresh screen costs nothing.
    if (!term.booted) {
      term.booted = true;
      resetLines();
      render();
      (async () => {
        await loadCapability();
        await loadSessions();
        if (!term.activeId && term.ready) {
          try { await ensureSession(); } catch (error) { term.error = error.message; }
        }
        await loadHistory();
        rerenderChrome();
        injectBanner();
        document.getElementById('term-input')?.focus({ preventScroll: true });
      })();
    }
  },
};

/** One honest line about where commands run, printed once when the session comes up. */
function injectBanner() {
  const screen = screenEl();
  if (!screen) return;
  screen.innerHTML = term.lines.map(lineHTML).join('');
  if (!term.ready) {
    if (isApiMode()) pushLine('err', 'the gateway refused terminal access — nothing here will execute');
    return;
  }
  const runtime = term.capability?.runtime || {};
  const session = sessionApi();
  // The toolchain it can actually name. A version the gateway could not read is left out rather than
  // printed as "unknown" beside a working npm; the capability payload carries the reason.
  const toolchain = [`node ${runtime.node || 'unknown'}`];
  if (runtime.npm) toolchain.push(`npm ${runtime.npm}`);
  pushLine('dim', `gateway host · ${toolchain.join(' · ')} · ${session?.cwdPath || 'workspace'} · no shell`);
  if (term.project?.scripts?.length) {
    pushLine('dim', `scripts: ${term.project.scripts.map((s) => `npm run ${s}`).join(' · ')}`);
  }
}

/* ---------- actions ---------- */

function render() {
  const view = document.getElementById('view');
  if (!view) return;
  view.innerHTML = views.terminal.render();
  views.terminal.mount();
}

on('term-run-btn', () => {
  const input = document.getElementById('term-input');
  if (!input?.value.trim()) return;
  const value = input.value;
  input.value = '';
  exec(value);
});

on('term-key', (el, ds) => {
  exec(ds.k);
});

on('term-script', (el, ds) => {
  exec(`npm run ${ds.name}`);
});

on('term-interrupt', () => interrupt());

on('term-clear-btn', () => {
  resetLines();
  render();
});

on('term-new-session', async () => {
  try {
    const out = await api.createTerminalSession({ workspaceId: sessionApi()?.workspaceId || null });
    term.sessions = [out.body.session, ...term.sessions];
    await adoptSession(out.body.session.id, { silent: true });
    term.project = out.body.session.project;
    render();
    pushLine('dim', `new session · ${out.body.session.cwdPath || ''}`);
  } catch (error) {
    toast(error.message || 'could not open a session');
  }
});

on('term-session', async (el, ds) => {
  await adoptSession(ds.id);
});

/** Leaving the screen must not kill the process — only the stream stays open or is re-opened. */
export function detachTerminalStream() {
  closeStream();
}

export function resetTerminalForTests() {
  closeStream();
  Object.assign(term, {
    ready: false, loading: false, error: null, capability: null, sessions: [], activeId: null,
    lines: [], runs: [], activeRun: null, cwd: '.', project: null, history: [], historyIndex: -1,
    seq: 0, booted: false,
  });
  resetLines();
  // The terminal view is `persistent`, so navigating to it again while it is already on screen is a
  // no-op — a reset would otherwise leave the DOM showing the previous test's scrollback.
  if (document.getElementById('term-screen')) render();
}

export const terminalState = () => term;
export { exec as execCommand };
