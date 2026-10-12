/* ============ Working Terminal — swarm CLI shell ============ */
import { getState, setState, esc, icon, logEvent, pendingApprovals, fmtMoney, now, uid } from './core.js';
import { toast, on } from './shell.js';
import { views } from './views1.js';

const BANNER = [
  { kind: 'dim', text: 'SwarmOS shell v0.1.0-proto · self-hosted gateway · SQLite WAL' },
  { kind: 'dim', text: "Type `help` for commands. Try: status · agents · swarm ls · approve ap-1" },
];

function push(line) {
  setState((s) => { s.terminalLines.push(line); }, 'term');
}

function pushMany(lines) {
  setState((s) => { s.terminalLines.push(...lines); }, 'term');
}

const HELP = [
  'Available commands:',
  '  help                  this list',
  '  status                gateway & fleet summary',
  '  agents | swarms | tasks | skills | models | plugins | spend',
  '  ls | cat <path>       artifact filesystem',
  '  run <agent>           start an agent',
  '  approve <id> | deny <id>     resolve an approval gate',
  '  deploy <objective>    deploy a research swarm',
  '  open <module>         navigate the app (agents, analytics…)',
  '  theme <dark|light>    switch theme',
  '  copilot <msg>         ask the in-app copilot',
  '  whoami | date | echo <text> | history | clear | reset-demo',
];

export function execCommand(raw) {
  const line = raw.trim();
  if (!line) return;
  push({ kind: 'cmd', text: `❯ ${line}` });
  const [cmd, ...rest] = line.split(/\s+/);
  const arg = rest.join(' ');
  const s = getState();

  switch (cmd.toLowerCase()) {
    case 'help':
      pushMany(HELP.map((t) => ({ kind: 'dim', text: t })));
      break;
    case 'status': {
      pushMany([
        { kind: 'ok', text: `gateway   ${s.gateway.status} · v${s.gateway.version} · sqlite ${s.gateway.sqlite}` },
        { kind: '', text: `agents    ${s.agents.filter((a) => a.status === 'running').length} running / ${s.agents.length}` },
        { kind: '', text: `swarms    ${s.swarms.filter((w) => w.status === 'live').length} live` },
        { kind: '', text: `approvals ${pendingApprovals().length} pending` },
        { kind: '', text: `spend     ${fmtMoney(s.agents.reduce((a, x) => a + x.costToday, 0))} today` },
      ]);
      break;
    }
    case 'agents':
      pushMany(s.agents.map((a) => ({ kind: '', text: `${a.id.padEnd(14)} ${a.name.padEnd(16)} ${a.status.padEnd(8)} trust ${a.trust}  ${a.model}` })));
      break;
    case 'swarms':
      pushMany((s.swarms.length ? s.swarms : []).map((w) => ({ kind: '', text: `${w.name.padEnd(22)} ${w.status.padEnd(9)} ${String(Math.round(w.progress * 100)).padStart(3)}%  ${fmtMoney(w.budget.spent)}/${fmtMoney(w.budget.cap)}` })) || [{ kind: 'dim', text: 'no swarms' }]);
      break;
    case 'tasks':
      pushMany(s.tasks.map((t) => ({ kind: '', text: `[${t.column.padEnd(6)}] ${t.title}` })));
      break;
    case 'skills':
      pushMany(s.skills.map((k) => ({ kind: k.status === 'pending' ? 'dim' : '', text: `${k.name.padEnd(28)} v${k.version.padEnd(7)} ${k.status}${k.status === 'pending' ? '  ← needs review' : ''}` })));
      break;
    case 'models':
      pushMany(s.providers.filter((p) => p.status === 'on').map((p) => ({ kind: '', text: `${p.name.padEnd(16)} ${p.models.join(', ')}` })));
      break;
    case 'plugins':
      pushMany(s.plugins.map((p) => ({ kind: p.installed ? 'ok' : 'dim', text: `${p.name.padEnd(12)} ${p.installed ? 'installed' : 'available'} · ${p.callsToday} calls today` })));
      break;
    case 'spend':
      pushMany([
        ...s.agents.map((a) => ({ kind: '', text: `${a.name.padEnd(16)} ${fmtMoney(a.costToday)}` })),
        { kind: 'ok', text: `TOTAL          ${fmtMoney(s.agents.reduce((a, x) => a + x.costToday, 0))}` },
      ]);
      break;
    case 'ls':
      pushMany(s.files.map((f) => ({ kind: '', text: `${f.type.padEnd(5)} ${String(Math.round(f.size / 1024)).padStart(5)}KB  ${f.path}` })));
      break;
    case 'cat': {
      const f = s.files.find((x) => x.path.endsWith(arg) || x.path === arg);
      if (!f) push({ kind: 'err', text: `cat: ${arg}: no such file` });
      else pushMany(f.content.split('\n').map((t) => ({ kind: '', text: t })));
      break;
    }
    case 'run': {
      const a = s.agents.find((x) => x.name.toLowerCase().includes(arg.toLowerCase()) && arg);
      if (!a) push({ kind: 'err', text: `run: agent "${arg}" not found` });
      else {
        setState((st) => {
          const x = st.agents.find((y) => y.id === a.id);
          x.status = 'running'; x.lastActive = now();
          logEvent('agent', `${x.name} started from terminal`);
        }, 'term-run');
        push({ kind: 'ok', text: `▶ ${a.name} started · model ${a.model}` });
      }
      break;
    }
    case 'approve':
    case 'deny': {
      const ap = s.approvals.find((x) => x.id === arg);
      if (!ap) { push({ kind: 'err', text: `no approval "${arg}"` }); break; }
      if (ap.status !== 'pending') { push({ kind: 'dim', text: `${ap.id} already ${ap.status}` }); break; }
      setState((st) => {
        const x = st.approvals.find((y) => y.id === arg);
        x.status = cmd === 'approve' ? 'allowed' : 'denied';
        logEvent('approval', `${x.action} ${x.status} via terminal`);
      }, 'term-approve');
      push({ kind: 'ok', text: `${arg} ${cmd === 'approve' ? 'allowed — released to ' + ap.principal : 'denied — principal notified'}` });
      break;
    }
    case 'deploy': {
      if (!arg) { push({ kind: 'err', text: 'deploy: missing objective' }); break; }
      setState((st) => {
        st.swarms.unshift({
          id: uid('sw'), teamId: 'tm-research', name: arg.toLowerCase().replace(/[^a-z0-9]+/g, '-').split('-').slice(0, 3).join('-'),
          objective: arg, status: 'live', progress: 0.02, budget: { cap: 8, spent: 0.08 }, startedAt: now(), channel: 'terminal',
          nodes: [
            { id: 'n1', label: 'planner', agent: 'ag-researcher', status: 'running', spent: 0.08, elapsed: '0:02' },
            { id: 'n2', label: 'research-a', agent: 'ag-researcher', status: 'queued', spent: 0, elapsed: '—' },
            { id: 'n3', label: 'research-b', agent: 'ag-content', status: 'queued', spent: 0, elapsed: '—' },
            { id: 'n4', label: 'analyze', agent: 'ag-analyst', status: 'queued', spent: 0, elapsed: '—' },
            { id: 'n5', label: 'writer', agent: 'ag-content', status: 'queued', spent: 0, elapsed: '—' },
            { id: 'n6', label: 'assembler', agent: 'ag-researcher', status: 'queued', spent: 0, elapsed: '—' },
          ],
        });
        logEvent('swarm', `Swarm deployed via terminal · ${arg.slice(0, 50)}`);
      }, 'term-deploy');
      push({ kind: 'ok', text: `🚀 swarm live · objective: ${arg}` });
      break;
    }
    case 'open': {
      const map = { agents: 'agents', teams: 'teams', swarms: 'teams', tasks: 'tasks', chat: 'chat', skills: 'skills', models: 'models', plugins: 'plugins', telegram: 'telegram', analytics: 'analytics', files: 'artifacts', artifacts: 'artifacts', settings: 'settings', home: 'home' };
      if (map[arg]) {
        push({ kind: 'dim', text: `→ navigating to ${map[arg]}` });
        import('./main.js').then((m) => m.navigate(map[arg]));
      } else push({ kind: 'err', text: `open: unknown module "${arg}"` });
      break;
    }
    case 'theme':
      if (arg === 'dark' || arg === 'light') {
        setState((st) => { st.settings.theme = arg; }, 'term-theme');
        import('./shell.js').then((m) => m.applyTheme());
        push({ kind: 'ok', text: `theme → ${arg}` });
      } else push({ kind: 'err', text: 'theme: use `theme dark` or `theme light`' });
      break;
    case 'copilot':
      if (!arg) { push({ kind: 'err', text: 'copilot: missing message' }); break; }
      import('./copilot.js').then((m) => {
        m.copilotSay(`(from terminal) ${arg}`);
        push({ kind: 'dim', text: 'opening copilot… see dock' });
        setTimeout(() => m.openCopilot(), 400);
        setTimeout(() => window.__copilotChip?.(arg), 700);
      });
      break;
    case 'whoami':
      push({ kind: '', text: 'maya@swarmlab · role Owner · via app session' });
      break;
    case 'date':
      push({ kind: '', text: new Date().toString() });
      break;
    case 'echo':
      push({ kind: '', text: arg });
      break;
    case 'history':
      pushMany((getState().terminalLines.filter((l) => l.kind === 'cmd')).slice(-15).map((l) => ({ kind: 'dim', text: l.text })));
      break;
    case 'clear':
      setState((st) => { st.terminalLines = BANNER.slice(); }, 'term-clear');
      break;
    case 'reset-demo':
      push({ kind: 'dim', text: 'use Settings → Reset demo data (guarded action)' });
      break;
    default:
      push({ kind: 'err', text: `command not found: ${cmd} — try \`help\`` });
  }
}

views.terminal = {
  title: 'Terminal',
  render() {
    const s = getState();
    const lines = s.terminalLines.length ? s.terminalLines : BANNER;
    return `
      <div class="term-wrap">
        <div class="row between" style="margin-bottom:8px">
          <div class="row" style="gap:8px">
            <h1 style="font-size:18px">Terminal</h1>
            <span class="chip tiny ok"><span class="pulse-dot live"></span>gateway session</span>
          </div>
          <button class="btn sm" data-act="term-clear-btn">${icon('undo', 13)} clear</button>
        </div>
        <div class="term" id="term-screen">
          ${lines.map((l) => `<div class="ln ${l.kind || ''}">${esc(l.text)}</div>`).join('')}
        </div>
        <div class="term-keys">
          ${['help', 'status', 'agents', 'swarms', 'tasks', 'spend', 'ls', 'clear'].map((k) => `
            <button data-act="term-key" data-k="${k}">${k}</button>`).join('')}
          <button data-act="term-key" data-k="approve ap-1">approve ap-1</button>
          <button data-act="term-key" data-k="deploy audit plugins">deploy…</button>
        </div>
        <div class="term-input-row" style="border:1px solid var(--border-soft);border-radius:12px;padding:10px 12px">
          <span class="p">❯</span>
          <input id="term-input" placeholder="type a command…" autocomplete="off" autocapitalize="off" spellcheck="false">
          <button class="send-btn" style="width:36px;height:36px;border-radius:11px" data-act="term-run-btn">${icon('send', 15)}</button>
        </div>
      </div>`;
  },
  mount() {
    const screen = document.getElementById('term-screen');
    if (screen) screen.scrollTop = screen.scrollHeight;
    const input = document.getElementById('term-input');
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        execCommand(input.value);
        input.value = '';
        // re-render terminal output imperatively to keep focus
        const s = getState();
        screen.innerHTML = s.terminalLines.map((l) => `<div class="ln ${l.kind || ''}">${esc(l.text)}</div>`).join('');
        screen.scrollTop = screen.scrollHeight;
      }
    });
    input?.focus({ preventScroll: true });
  },
  persistent: true,
};

on('term-run-btn', () => {
  const input = document.getElementById('term-input');
  if (input?.value.trim()) {
    execCommand(input.value);
    input.value = '';
    const screen = document.getElementById('term-screen');
    const s = getState();
    if (screen) {
      screen.innerHTML = s.terminalLines.map((l) => `<div class="ln ${l.kind || ''}">${esc(l.text)}</div>`).join('');
      screen.scrollTop = screen.scrollHeight;
    }
  }
});
on('term-key', (el, ds) => {
  execCommand(ds.k);
  const screen = document.getElementById('term-screen');
  const s = getState();
  if (screen) {
    screen.innerHTML = s.terminalLines.map((l) => `<div class="ln ${l.kind || ''}">${esc(l.text)}</div>`).join('');
    screen.scrollTop = screen.scrollHeight;
  }
});
on('term-clear-btn', () => {
  setState((st) => { st.terminalLines = BANNER.slice(); }, 'term-clear');
  import('./main.js').then((m) => m.rerender());
});
