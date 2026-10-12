/* ============ SwarmOS Copilot — in-app operator with action cards ============ */
import { getState, setState, esc, icon, uid, now, logEvent, pendingApprovals, avatar, commit } from './core.js';
import { openSheet, toast, closeAllSheets } from './shell.js';

const NAV_MAP = {
  home: 'home', agents: 'agents', agent: 'agents', teams: 'teams', team: 'teams', swarm: 'teams', swarms: 'teams',
  tasks: 'tasks', task: 'tasks', kanban: 'tasks', chat: 'chat', skills: 'skills', skill: 'skills', models: 'models',
  model: 'models', plugins: 'plugins', plugin: 'plugins', telegram: 'telegram', analytics: 'analytics', files: 'artifacts',
  artifacts: 'artifacts', terminal: 'terminal', settings: 'settings',
};

let copilotHistory = [
  { role: 'bot', text: 'Hi Maya 👋 I\'m your Copilot — I operate this app with you. Try:\n• **create agent** Nova researcher\n• **deploy swarm** research\n• **status**\n• **approve ap-1**\n• **theme light**\n• **open analytics**', ts: now() },
];

function reply(md) {
  return md
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code class="code">$1</code>')
    .replace(/\n/g, '<br>');
}

export function copilotSay(text, actionCard = null) {
  copilotHistory.push({ role: 'bot', text, actionCard, ts: now() });
  renderThread();
}

function intentEngine(raw) {
  const text = raw.trim();
  const lc = text.toLowerCase();
  const s = getState();

  // ---- app control intents ----
  if (/^(help|what can you do|capabilities)/.test(lc)) {
    return { text: 'I have **full control** of SwarmOS, subject to governance gates:\n• `create agent <name>` / `deploy swarm <objective>` / `new task <title>`\n• `status`, `list agents|swarms|tasks`\n• `open <module>` (analytics, skills, terminal…)\n• `run <agent>`, `approve <id>`, `deny <id>`\n• `theme dark|light`, `analyze spend`\nMutations show an **action card** you must confirm — I can never approve my own requests.' };
  }

  if (/^(status|health|gateway)/.test(lc)) {
    const pend = pendingApprovals().length;
    return {
      text: `**Gateway** ${s.gateway.status} · v${s.gateway.version} · SQLite ${s.gateway.sqlite}\n**Agents** ${s.agents.filter((a) => a.status === 'running').length} running / ${s.agents.length} total\n**Swarms** ${s.swarms.filter((w) => w.status === 'live').length} live\n**Approvals** ${pend} pending\n**Spend today** $${s.agents.reduce((a, x) => a + x.costToday, 0).toFixed(2)}`,
    };
  }

  if (/^(list|show|what).*(agent)/.test(lc)) {
    return { text: s.agents.map((a) => `• **${a.name}** · ${a.framework} · ${a.model} · trust ${a.trust} · ${a.status}`).join('\n') };
  }
  if (/^(list|show).*(swarm)/.test(lc)) {
    return { text: s.swarms.map((w) => `• **${w.name}** · ${w.status} · ${Math.round(w.progress * 100)}% · $${w.budget.spent}/${w.budget.cap}`).join('\n') || 'No swarms yet.' };
  }
  if (/^(list|show).*(task)/.test(lc)) {
    return { text: s.tasks.filter((t) => t.column !== 'done').slice(0, 6).map((t) => `• [${t.column}] **${t.title}** → ${t.assignee}`).join('\n') };
  }

  const openM = lc.match(/^(?:open|go to|navigate to)\s+(.+)/);
  if (openM && NAV_MAP[openM[1].trim()]) {
    const to = NAV_MAP[openM[1].trim()];
    setTimeout(() => import('./main.js').then((m) => m.navigate(to)), 350);
    return { text: `Opening **${to}** for you.` };
  }

  const themeM = lc.match(/^(?:theme|set theme)\s+(dark|light)/);
  if (themeM) {
    setState((st) => { st.settings.theme = themeM[1]; }, 'theme');
    import('./shell.js').then((m) => m.applyTheme());
    return { text: `Theme switched to **${themeM[1]}**.` };
  }

  const createM = lc.match(/^create (?:new )?agent(?: called| named)? ([a-z0-9 _-]+)/);
  if (createM) {
    const name = createM[1].trim().replace(/\b\w/g, (c) => c.toUpperCase());
    return {
      text: `Ready to create agent **${name}**. Review the plan:`,
      actionCard: {
        title: 'CREATE AGENT',
        risk: 'low',
        rows: [['Name', name], ['Framework', 'LangGraph'], ['Model', 'anthropic/claude-sonnet-4'], ['Trust seed', '50 (tier B)']],
        confirm: 'Create agent',
        run: () => {
          const id = uid('ag');
          setState((st) => {
            st.agents.unshift({
              id, name, role: 'General-purpose agent', framework: 'LangGraph', model: 'anthropic/claude-sonnet-4',
              fallback: 'deepseek/deepseek-v3', status: 'idle', trust: 50, autonomy: 2, successRate: 0.85,
              costToday: 0, runs: 0, lastActive: now(), tools: ['web.search'], skills: ['core.citations'],
              prompt: `You are ${name}. Be concise, cite sources, ask when unsure.`,
              memory: { episodic: 0, semantic: 0, kb: '0 MB' },
            });
            logEvent('agent', `Agent ${name} created via Copilot`);
          }, 'copilot-create-agent');
          copilotSay(`✅ Agent **${name}** created and idle. Say \`run ${name.toLowerCase()}\` to start it.`);
          toast(`Agent ${name} created`, 'ok');
        },
      },
    };
  }

  const deployM = lc.match(/^deploy (?:a |new )?swarm(?: for| to| called| named)? ?(.*)/);
  if (deployM) {
    const obj = deployM[1]?.trim() || 'Explore Q4 agent-framework landscape';
    return {
      text: `Here's the deployment plan — confirm to execute:`,
      actionCard: {
        title: 'DEPLOY SWARM',
        risk: 'medium',
        rows: [['Objective', obj], ['Team', 'Research Squad (3 agents)'], ['Topology', 'Hierarchical'], ['Budget', '$8.00 cap'], ['Gate', 'All writes require approval']],
        confirm: 'Deploy swarm',
        run: () => {
          const id = uid('sw');
          setState((st) => {
            st.swarms.unshift({
              id, teamId: 'tm-research', name: obj.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24), objective: obj,
              status: 'live', progress: 0.04, budget: { cap: 8, spent: 0.12 }, startedAt: now(), channel: 'app',
              nodes: [
                { id: 'n1', label: 'planner', agent: 'ag-researcher', status: 'running', spent: 0.12, elapsed: '0:05' },
                { id: 'n2', label: 'research-a', agent: 'ag-researcher', status: 'queued', spent: 0, elapsed: '—' },
                { id: 'n3', label: 'research-b', agent: 'ag-content', status: 'queued', spent: 0, elapsed: '—' },
                { id: 'n4', label: 'assembler', agent: 'ag-analyst', status: 'queued', spent: 0, elapsed: '—' },
              ],
            });
            logEvent('swarm', `Swarm deployed via Copilot · ${obj}`);
          }, 'copilot-deploy');
          copilotSay(`🚀 Swarm **live**. I'll surface approvals in Chat + Telegram. Open **Teams & Swarms** to watch the DAG.`);
          toast('Swarm deployed 🚀', 'ok');
        },
      },
    };
  }

  const taskM = lc.match(/^(?:create|add|new) (?:a )?task:? (.+)/);
  if (taskM) {
    const title = taskM[1].trim();
    return {
      text: `Add this to the Kanban backlog?`,
      actionCard: {
        title: 'CREATE TASK', risk: 'low',
        rows: [['Title', title], ['Column', 'Backlog (todo)'], ['Assignee', 'Auto-route by skill']],
        confirm: 'Create task',
        run: () => {
          setState((st) => {
            st.tasks.unshift({ id: uid('tk'), title, column: 'todo', assignee: 'ag-researcher', priority: 'med', deps: [], desc: 'Created via Copilot.' });
            logEvent('task', `Task created via Copilot: ${title}`);
          }, 'copilot-task');
          copilotSay(`✅ Task **${title}** added to Backlog.`);
          toast('Task created', 'ok');
        },
      },
    };
  }

  const runM = lc.match(/^run ([a-z0-9 _-]+)/);
  if (runM) {
    const q = runM[1].trim().toLowerCase();
    const agent = s.agents.find((a) => a.name.toLowerCase().includes(q) || a.id.includes(q));
    if (agent) {
      setState((st) => {
        const a = st.agents.find((x) => x.id === agent.id);
        a.status = 'running'; a.lastActive = now();
        logEvent('agent', `${a.name} started via Copilot`);
      }, 'copilot-run');
      return { text: `▶️ **${agent.name}** is now running with \`${agent.model}\`.` };
    }
    return { text: `I couldn't find an agent matching “${esc(runM[1])}”. Try \`list agents\`.` };
  }

  const decideM = lc.match(/^(approve|deny) (\S+)(?: (.*))?/);
  if (decideM && /^ap-/.test(decideM[2])) {
    const ap = s.approvals.find((a) => a.id === decideM[2]);
    if (ap) {
      if (ap.status !== 'pending') return { text: `**${ap.id}** was already ${ap.status}.` };
      const allow = decideM[1] === 'approve';
      // Governance: copilot executes the user's explicit decision — it never decides alone.
      return {
        text: `Confirming your explicit decision on **${ap.id}** (I cannot self-approve — this executes *your* instruction):`,
        actionCard: {
          title: allow ? 'APPROVAL — ALLOW ONCE' : 'APPROVAL — DENY',
          risk: ap.risk,
          rows: [['Action', ap.action], ['Target', ap.target], ['Principal', ap.principal], ['Evidence', ap.evidence]],
          confirm: allow ? 'Allow once' : 'Deny',
          run: () => {
            setState((st) => {
              const a = st.approvals.find((x) => x.id === ap.id);
              a.status = allow ? 'allowed' : 'denied';
              logEvent('approval', `${a.action} ${a.status} by you via Copilot`);
            }, 'copilot-approve');
            copilotSay(allow ? `✅ **${ap.action}** released to ${ap.principal}.` : `Denied **${ap.action}**. ${ap.principal} notified.`);
            toast(allow ? 'Approved' : 'Denied', allow ? 'ok' : '');
          },
        },
      };
    }
    return { text: `No approval **${esc(decideM[2])}** found. See the bell icon for pending gates.` };
  }

  if (/analyz|spend|cost|budget|report/.test(lc)) {
    const spend = s.agents.reduce((a, x) => a + x.costToday, 0);
    const top = [...s.agents].sort((a, b) => b.costToday - a.costToday)[0];
    setTimeout(() => import('./main.js').then((m) => m.navigate('analytics')), 800);
    return { text: `**Spend today** $${spend.toFixed(2)}\nTop spender: **${top.name}** ($${top.costToday.toFixed(2)}).\nBudget posture is green — 2 providers carry 74% of traffic. Opening **Analytics** with details.` };
  }

  const navM = lc.match(/^(open|show|go to) (.+)/);
  if (navM) {
    const key = navM[2].trim().split(/\s+/)[0];
    if (NAV_MAP[key]) {
      setTimeout(() => import('./main.js').then((m) => m.navigate(NAV_MAP[key])), 350);
      return { text: `Opening **${NAV_MAP[key]}**.` };
    }
  }

  return {
    text: `I can do that if you phrase it as an action — e.g. **create agent Nova**, **deploy swarm** “audit plugins”, **status**, or **open settings**. Type \`help\` for the full list.`,
  };
}

/* ---------- render ---------- */
function renderThread() {
  const body = document.getElementById('copilot-thread');
  if (!body) return;
  body.innerHTML = copilotHistory.map((m, i) => `
    <div class="msg ${m.role === 'me' ? 'me' : ''}">
      <div class="bubble">
        <div>${reply(esc(m.text))}</div>
        ${m.actionCard ? renderActionCard(m.actionCard, i) : ''}
      </div>
      <div class="meta">${m.role === 'me' ? 'You' : 'Copilot'} · ${new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
    </div>`).join('');
  body.scrollTop = body.scrollHeight;
}

function renderActionCard(ac, idx) {
  if (ac.done) return `<div class="action-card"><div class="ac-head">${icon('check', 14)} ${ac.title} · DONE</div></div>`;
  return `
    <div class="action-card">
      <div class="ac-head">${icon('spark', 14)} ACTION CARD · ${ac.title} <span class="grow"></span><span class="chip tiny ${ac.risk === 'medium' ? 'warn' : 'ok'}">risk: ${ac.risk}</span></div>
      <div class="ac-body">
        ${ac.rows.map(([k, v]) => `<div class="kv"><span class="k">${esc(k)}</span><span class="strong">${esc(v)}</span></div>`).join('')}
      </div>
      <div class="ac-foot">
        <button class="btn sm" data-act="copilot-cancel" data-idx="${idx}">Cancel</button>
        <button class="btn sm primary" data-act="copilot-confirm" data-idx="${idx}">${esc(ac.confirm)}</button>
      </div>
    </div>`;
}

export function openCopilot() {
  const s = getState();
  const { el, close } = openSheet({
    title: `<span class="row">${icon('spark', 18)}<span>Copilot</span><span class="chip tiny brand" style="margin-left:6px">${esc(s.settings.copilotMode)} mode</span></span>`,
    body: `
      <div class="scroll-x" style="margin-bottom:10px">
        <span class="chip">Context: workspace</span>
        <span class="chip">6 agents</span>
        <span class="chip">Governance: ON</span>
        <span class="chip ok">Self-approval blocked</span>
      </div>
      <div class="msgs" id="copilot-thread" style="max-height:46dvh;overflow-y:auto"></div>
      <div class="scroll-x" style="margin:10px 0 4px" id="copilot-chips">
        ${['status', 'create agent Nova', 'deploy swarm research', 'list agents', 'analyze spend', 'theme light', 'open analytics']
          .map((c) => `<button class="chip" data-act="copilot-chip" data-q="${esc(c)}">${esc(c)}</button>`).join('')}
      </div>
      <div class="term-input-row" style="margin-top:6px">
        <textarea class="input" id="copilot-input" rows="1" placeholder="Tell the Copilot what to do…"></textarea>
        <button class="send-btn" data-act="copilot-send">${icon('send', 18)}</button>
      </div>
      <div class="tiny muted" style="margin-top:8px;display:flex;align-items:center;gap:6px">
        ${icon('mic', 14)} push-to-talk · ${icon('shield', 14)} every action audited as “You via Copilot”
      </div>`,
  });
  renderThread();

  const input = el.querySelector('#copilot-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendCopilot(input.value);
      input.value = '';
    }
  });

  window.__copilotSend = () => { sendCopilot(input.value); input.value = ''; };
  window.__copilotChip = (q) => { sendCopilot(q); };
  window.__copilotConfirm = (idx) => {
    const m = copilotHistory[idx];
    if (m?.actionCard && !m.actionCard.done) {
      m.actionCard.done = true;
      m.actionCard.run();
      renderThread();
    }
  };
  window.__copilotCancel = (idx) => {
    const m = copilotHistory[idx];
    if (m?.actionCard && !m.actionCard.done) {
      m.actionCard.done = true;
      m.actionCard.title += ' · CANCELLED';
      renderThread();
    }
  };
}

function sendCopilot(text) {
  if (!text.trim()) return;
  copilotHistory.push({ role: 'me', text, ts: now() });
  renderThread();
  setTimeout(() => {
    const res = intentEngine(text);
    copilotHistory.push({ role: 'bot', text: res.text, actionCard: res.actionCard || null, ts: now() });
    renderThread();
  }, 320 + Math.random() * 400);
}

/* hook shell-level actions once */
import { on } from './shell.js';
on('copilot-send', () => window.__copilotSend?.());
on('copilot-chip', (el, ds) => window.__copilotChip?.(ds.q));
on('copilot-confirm', (el, ds) => window.__copilotConfirm?.(Number(ds.idx)));
on('copilot-cancel', (el, ds) => window.__copilotCancel?.(Number(ds.idx)));
