/* ============ Views: Home, Agents, Teams & Swarms, Kanban ============ */
import {
  getState, setState, esc, icon, avatar, uid, now, fmtTime, fmtMoney, trustColor, trustTier,
  logEvent, pendingApprovals, getAgent, commit, initials, avatarColor,
} from './core.js';
import { openSheet, toast, confirmModal, on, actions } from './shell.js';

export const views = {};

/* ================= HOME ================= */
views.home = {
  title: 'Command Deck',
  render() {
    const s = getState();
    const spend = s.agents.reduce((a, x) => a + x.costToday, 0);
    const running = s.agents.filter((a) => a.status === 'running').length;
    const pend = pendingApprovals();
    const live = s.swarms.filter((w) => w.status === 'live');
    const spark = s.usage.map((u) => u.cost);
    return `
      <div class="page-head">
        <h1>Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, Maya</h1>
        <div class="sub">Gateway ${esc(s.gateway.status)} · v${esc(s.gateway.version)} · SQLite ${esc(s.gateway.sqlite)}</div>
      </div>

      ${pend.length ? `
        <div class="banner warn">
          ${icon('shield', 18)}
          <div class="grow"><strong>${pend.length} approval${pend.length > 1 ? 's' : ''}</strong> need you · ${esc(pend[0].action)}</div>
          <button class="btn sm" data-act="notifications">Review</button>
        </div>` : ''}

      <div class="grid-2">
        <div class="stat"><div class="k">Spend today</div><div class="v">${fmtMoney(spend)}</div><div class="d">budget posture: green</div></div>
        <div class="stat"><div class="k">Agents</div><div class="v">${running}<span class="muted" style="font-size:14px">/${s.agents.length}</span></div><div class="d">running now</div></div>
        <div class="stat"><div class="k">Live swarms</div><div class="v">${live.length}</div><div class="d">${s.tasks.filter((t) => t.column === 'doing').length} tasks in flight</div></div>
        <div class="stat"><div class="k">Fleet trust</div><div class="v">${Math.round(s.agents.reduce((a, x) => a + x.trust, 0) / s.agents.length)}</div><div class="d">avg score</div></div>
      </div>

      <div class="card" style="margin-top:12px">
        <div class="row between"><strong class="small">Spend (24h)</strong><span class="chip tiny">${fmtMoney(spark.reduce((a, b) => a + b, 0))}</span></div>
        ${sparkline(spark)}
      </div>

      <div class="section-title">Live now</div>
      ${live.length ? live.map((w) => `
        <button class="list-card" data-act="open-swarm" data-id="${w.id}" style="width:100%;text-align:left">
          <div class="avatar" style="background:var(--elevated);color:var(--brand)">${icon('swarm', 18)}</div>
          <div class="grow">
            <div class="row"><span class="strong small">${esc(w.name)}</span><span class="pulse-dot live"></span></div>
            <div class="tiny muted ellipsis">${esc(w.objective)}</div>
            <div class="progress" style="margin-top:6px"><i style="width:${Math.round(w.progress * 100)}%"></i></div>
          </div>
          <div class="tiny muted">${Math.round(w.progress * 100)}%</div>
        </button>`).join('') : `
        <div class="empty"><div class="e-ico">⬡</div><div>No live swarms — deploy one in seconds.</div>
        <button class="btn primary" data-act="new-swarm" style="margin-top:12px">Deploy swarm</button></div>`}

      <div class="section-title">Recent activity</div>
      <div class="card">
        ${s.events.slice(0, 6).map((ev, i) => `
          <div class="row" style="padding:7px 0;${i ? 'border-top:1px solid var(--border-soft)' : ''};gap:10px">
            <span class="pulse-dot ${ev.type === 'approval' ? 'warn' : ev.type === 'swarm' ? 'run' : 'idle'}"></span>
            <div class="grow small">${esc(ev.text)}</div>
            <div class="tiny muted">${fmtTime(ev.ts)}</div>
          </div>`).join('')}
      </div>

      <div class="section-title">Quick actions</div>
      <div class="grid-3">
        <button class="btn col" data-act="new-agent" style="height:auto;padding:14px 8px">${icon('robot', 20)}<span class="tiny">New agent</span></button>
        <button class="btn col" data-act="new-swarm" style="height:auto;padding:14px 8px">${icon('swarm', 20)}<span class="tiny">Deploy</span></button>
        <button class="btn col" data-act="nav" data-to="terminal" style="height:auto;padding:14px 8px">${icon('terminal', 20)}<span class="tiny">Terminal</span></button>
      </div>`;
  },
};

export function sparkline(vals, color = 'url(#sg)') {
  const w = 300, h = 44, max = Math.max(...vals, 0.01), min = Math.min(...vals, 0);
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * w},${h - 4 - ((v - min) / (max - min || 1)) * (h - 10)}`);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="sg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6C8CFF"/><stop offset="1" stop-color="#22D3EE"/></linearGradient></defs>
    <polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

/* ================= AGENTS ================= */
views.agents = {
  title: 'Agent Manager',
  render(params) {
    if (params && params.id) return agentDetail(params.id);
    const s = getState();
    return `
      <div class="page-head row between">
        <div><h1>Agents</h1><div class="sub">${s.agents.length} profiles · ${s.agents.filter((a) => a.status === 'running').length} running</div></div>
        <button class="btn primary sm" data-act="new-agent">${icon('plus', 16)} New</button>
      </div>
      <div class="scroll-x" style="margin-bottom:12px">
        <span class="chip brand">All</span><span class="chip">LangGraph</span><span class="chip">CrewAI</span>
        <span class="chip">Swarmzero</span><span class="chip">AutoPentest</span><span class="chip">A.I.M.A</span>
        <span class="chip">Nautilus</span><span class="chip">OpenAI Swarm</span>
      </div>
      ${s.agents.map((a) => `
        <button class="list-card" data-act="open-agent" data-id="${a.id}" style="width:100%;text-align:left">
          ${avatar(a.name)}
          <div class="grow">
            <div class="row" style="gap:6px"><span class="strong small">${esc(a.name)}</span>
              <span class="pulse-dot ${a.status === 'running' ? 'run' : a.status === 'error' ? 'bad' : a.status === 'paused' ? 'warn' : 'idle'}"></span>
            </div>
            <div class="tiny muted ellipsis">${esc(a.role)}</div>
            <div class="row" style="gap:6px;margin-top:5px">
              <span class="chip tiny">${esc(a.framework)}</span>
              <span class="chip tiny brand">${esc(a.model.split('/')[1] || a.model)}</span>
            </div>
          </div>
          <div class="col" style="align-items:flex-end;gap:6px">
            <span class="chip tiny" style="color:${trustColor(a.trust)}">◈ ${a.trust}</span>
            <div class="trust-bar"><i style="width:${a.trust}%;background:${trustColor(a.trust)}"></i></div>
          </div>
        </button>`).join('')}`;
  },
};

function agentDetail(id) {
  const a = getAgent(id);
  if (!a) return `<div class="empty">Agent not found</div>`;
  return `
    <button class="btn sm" data-act="nav" data-to="agents">${icon('left', 14)} All agents</button>
    <div class="card" style="margin-top:12px">
      <div class="row">
        ${avatar(a.name)}
        <div class="grow">
          <h2 style="font-size:18px">${esc(a.name)}</h2>
          <div class="tiny muted">${esc(a.role)}</div>
        </div>
        <button class="btn sm ${a.status === 'running' ? '' : 'primary'}" data-act="toggle-agent" data-id="${a.id}">
          ${a.status === 'running' ? icon('pause', 14) + ' Pause' : icon('play', 14) + ' Run'}
        </button>
      </div>
      <div class="row wrap" style="margin-top:12px">
        <span class="chip tiny">${esc(a.framework)}</span>
        <span class="chip tiny brand">${esc(a.model)}</span>
        <span class="chip tiny">↺ ${esc(a.fallback)}</span>
        <span class="chip tiny" style="color:${trustColor(a.trust)}">◈ trust ${a.trust} · tier ${trustTier(a.trust).toUpperCase()}</span>
      </div>
      <div class="grid-3" style="margin-top:12px">
        <div class="stat"><div class="k">Success</div><div class="v" style="font-size:17px">${Math.round(a.successRate * 100)}%</div></div>
        <div class="stat"><div class="k">Runs</div><div class="v" style="font-size:17px">${a.runs}</div></div>
        <div class="stat"><div class="k">Cost 24h</div><div class="v" style="font-size:17px">${fmtMoney(a.costToday)}</div></div>
      </div>
    </div>

    <div class="section-title">Brain</div>
    <div class="card">
      <div class="field"><label>System prompt (v7 · human-edited)</label>
        <textarea class="input" data-model="_agentprompt">${esc(a.prompt)}</textarea>
      </div>
      <div class="kv"><span class="k">Autonomy level</span><span class="strong">L${a.autonomy} ${['ask-always', 'guided', 'supervised', 'guarded-auto', 'full-auto'][a.autonomy]}</span></div>
      <div class="kv"><span class="k">Self-improvement</span><span class="strong">${esc(getState().settings.selfImprove)}</span></div>
    </div>

    <div class="section-title">Tools & skills</div>
    <div class="card">
      <div class="row wrap">${a.tools.map((t) => `<span class="chip tiny">${esc(t)}</span>`).join('')}</div>
      <div class="divider"></div>
      <div class="row wrap">${a.skills.map((t) => `<span class="chip tiny ok">${icon('skill', 11)} ${esc(t)}</span>`).join('')}</div>
    </div>

    <div class="section-title">Memory</div>
    <div class="card">
      <div class="kv"><span class="k">Episodic</span><span class="strong">${a.memory.episodic} entries</span></div>
      <div class="kv"><span class="k">Semantic</span><span class="strong">${a.memory.semantic} facts</span></div>
      <div class="kv"><span class="k">Vector store</span><span class="strong">${esc(a.memory.kb)}</span></div>
    </div>

    <div class="row" style="gap:10px;margin-top:16px">
      <button class="btn grow" data-act="clone-agent" data-id="${a.id}">${icon('copy', 15)} Clone</button>
      <button class="btn grow danger" data-act="delete-agent" data-id="${a.id}">${icon('trash', 15)} Delete</button>
    </div>`;
}

/* ---- agent wizard ---- */
export function agentWizard() {
  let step = 0;
  const draft = { name: '', role: '', framework: 'LangGraph', model: 'anthropic/claude-sonnet-4', autonomy: 2, tools: ['web.search'], skills: ['core.citations'] };
  const { el, close } = openSheet({
    title: 'New agent',
    body: `<div id="wiz-body"></div>`,
    foot: `<button class="btn" data-act="wiz-cancel">Cancel</button><button class="btn primary" data-act="wiz-next">Next</button>`,
  });
  const renderStep = () => {
    const b = el.querySelector('#wiz-body');
    const steps = `
      <div class="wizard-steps">${[0, 1, 2, 3].map((i) => `<div class="st ${i <= step ? 'on' : ''}"></div>`).join('')}</div>`;
    if (step === 0) {
      b.innerHTML = steps + `
        <div class="field"><label>Name</label><input class="input" id="w-name" value="${esc(draft.name)}" placeholder="e.g. Nova-Researcher"></div>
        <div class="field"><label>Role</label><input class="input" id="w-role" value="${esc(draft.role)}" placeholder="What is this agent's job?"></div>`;
    } else if (step === 1) {
      b.innerHTML = steps + `
        <div class="field"><label>Framework</label>
          <div class="grid-2" style="gap:8px" id="w-fw">
            ${['Swarmzero', 'AutoPentest', 'A.I.M.A', 'Project Nautilus', 'OpenAI Swarm', 'CrewAI', 'LangGraph'].map((f) => `
              <button class="chip" data-fw="${f}" style="height:38px;justify-content:center;${draft.framework === f ? 'border-color:var(--brand);color:var(--brand)' : ''}">${f}</button>`).join('')}
          </div>
        </div>
        <div class="field"><label>Autonomy level</label>
          <select class="input" id="w-aut">
            ${[0, 1, 2, 3, 4].map((l) => `<option value="${l}" ${draft.autonomy === l ? 'selected' : ''}>L${l} — ${['ask-always', 'guided', 'supervised', 'guarded-auto', 'full-auto'][l]}</option>`).join('')}
          </select>
        </div>`;
    } else if (step === 2) {
      b.innerHTML = steps + `
        <div class="field"><label>Model (any provider)</label>
          <select class="input" id="w-model">
            ${['anthropic/claude-sonnet-4', 'anthropic/claude-opus-4', 'openai/gpt-5', 'openai/o3', 'google/gemini-3-pro', 'xai/grok-3', 'deepseek/deepseek-v3', 'mistral/large-latest', 'ollama/qwen2.5:32b', 'groq/llama-3.3-70b'].map((m) => `<option ${draft.model === m ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Tools</label>
          <div class="row wrap">${['web.search', 'firecrawl.scrape', 'github.pr.create', 'supabase.db.query', 'vercel.deploy', 'airtable.records'].map((t) => `<button class="chip tiny" data-tool="${t}" style="${draft.tools.includes(t) ? 'border-color:var(--success);color:var(--success)' : ''}">${t}</button>`).join('')}</div>
        </div>`;
    } else {
      b.innerHTML = steps + `
        <div class="banner info">${icon('shield', 16)}<div>Trust seeds at <strong>50 (tier B)</strong>. Gates protect all writes. Raise trust via clean runs.</div></div>
        <div class="kv"><span class="k">Name</span><span class="strong">${esc(draft.name || 'Unnamed')}</span></div>
        <div class="kv"><span class="k">Framework</span><span class="strong">${esc(draft.framework)}</span></div>
        <div class="kv"><span class="k">Model</span><span class="strong">${esc(draft.model)}</span></div>
        <div class="kv"><span class="k">Tools</span><span class="strong">${draft.tools.length} bound</span></div>`;
    }
  };
  renderStep();
  el.addEventListener('click', (e) => {
    const fw = e.target.closest('[data-fw]');
    if (fw) { draft.framework = fw.dataset.fw; renderStep(); return; }
    const tl = e.target.closest('[data-tool]');
    if (tl) {
      const t = tl.dataset.tool;
      draft.tools.includes(t) ? (draft.tools = draft.tools.filter((x) => x !== t)) : draft.tools.push(t);
      renderStep();
    }
  });
  actions['wiz-cancel'] = () => close();
  actions['wiz-next'] = () => {
    if (step === 0) {
      draft.name = el.querySelector('#w-name').value.trim() || 'New-Agent';
      draft.role = el.querySelector('#w-role').value.trim() || 'General-purpose agent';
    } else if (step === 1) {
      draft.autonomy = Number(el.querySelector('#w-aut').value);
    } else if (step === 2) {
      draft.model = el.querySelector('#w-model').value;
    }
    if (step < 3) { step++; renderStep(); return; }
    setState((s) => {
      s.agents.unshift({
        id: uid('ag'), name: draft.name, role: draft.role, framework: draft.framework, model: draft.model,
        fallback: 'deepseek/deepseek-v3', status: 'idle', trust: 50, autonomy: draft.autonomy, successRate: 0.85,
        costToday: 0, runs: 0, lastActive: now(), tools: draft.tools, skills: draft.skills,
        prompt: `You are ${draft.name}. ${draft.role}`, memory: { episodic: 0, semantic: 0, kb: '0 MB' },
      });
      logEvent('agent', `Agent ${draft.name} created (wizard)`);
    }, 'wizard-agent');
    close();
    toast(`Agent ${esc(draft.name)} created`, 'ok');
    import('./main.js').then((m) => m.navigate('agents'));
  };
}

/* ================= TEAMS & SWARMS ================= */
views.teams = {
  title: 'Teams & Swarms',
  render(params) {
    if (params && params.id) return swarmMonitor(params.id);
    const s = getState();
    return `
      <div class="page-head row between">
        <div><h1>Teams & Swarms</h1><div class="sub">Compose teams · deploy swarms · watch live</div></div>
        <button class="btn primary sm" data-act="new-swarm">${icon('plus', 16)} Deploy</button>
      </div>
      <div class="section-title" style="margin-top:0">Live swarms</div>
      ${s.swarms.map((w) => `
        <button class="list-card" data-act="open-swarm" data-id="${w.id}" style="width:100%;text-align:left">
          <div class="avatar" style="background:${w.status === 'live' ? 'color-mix(in srgb, var(--running) 25%, var(--elevated))' : 'var(--elevated)'};color:var(--brand)">${icon('swarm', 18)}</div>
          <div class="grow">
            <div class="row"><span class="strong small">${esc(w.name)}</span>
              <span class="chip tiny ${w.status === 'live' ? 'run' : ''}">${esc(w.status)}</span></div>
            <div class="tiny muted ellipsis">${esc(w.objective)}</div>
            <div class="progress" style="margin-top:6px"><i style="width:${Math.round(w.progress * 100)}%"></i></div>
            <div class="row between" style="margin-top:5px">
              <span class="tiny muted">${fmtTime(w.startedAt)} · ${esc(w.channel)}</span>
              <span class="tiny muted">${fmtMoney(w.budget.spent)} / ${fmtMoney(w.budget.cap)}</span>
            </div>
          </div>
        </button>`).join('')}

      <div class="section-title">Teams</div>
      ${s.teams.map((t) => `
        <div class="card">
          <div class="row between">
            <div class="row">
              <div class="avatar" style="background:var(--elevated);color:var(--brand)">${icon('team', 18)}</div>
              <div><div class="strong small">${esc(t.name)}</div><div class="tiny muted">${esc(t.topology)} · ${t.members.length} agents</div></div>
            </div>
            <span class="chip tiny ${t.health === 'good' ? 'ok' : 'warn'}">${esc(t.health)}</span>
          </div>
          <div class="row" style="margin-top:10px">
            ${t.members.map((id) => { const a = getAgent(id); return a ? avatar(a.name, 'sm') : ''; }).join('')}
            <button class="btn sm" data-act="new-swarm" data-team="${t.id}" style="margin-left:auto">${icon('play', 13)} Deploy</button>
          </div>
        </div>`).join('')}

      <div class="section-title">Templates</div>
      <div class="scroll-x">
        ${[['Research Squad', 'Multi-source research & reports'], ['AutoPentest Cell', 'Gated security assessment'], ['Content Pipeline', 'Longform → multi-channel'], ['SRE On-Call', 'Detect, triage, mitigate']].map(([n, d]) => `
          <div class="card" style="min-width:200px">
            <div class="strong small">${n}</div>
            <div class="tiny muted" style="margin:4px 0 10px">${d}</div>
            <button class="btn sm block" data-act="new-swarm">Use template</button>
          </div>`).join('')}
      </div>`;
  },
};

function swarmMonitor(id) {
  const w = getState().swarms.find((x) => x.id === id);
  if (!w) return `<div class="empty">Swarm not found</div>`;
  const pos = { n1: [70, 18], n2: [70, 110], n3: [210, 110], n4: [70, 202], n5: [210, 202], n6: [140, 294] };
  const edges = [['n1', 'n2'], ['n1', 'n3'], ['n2', 'n4'], ['n2', 'n5'], ['n3', 'n5'], ['n4', 'n6'], ['n5', 'n6']];
  const color = (st) => (st === 'done' ? '#34D399' : st === 'running' ? '#818CF8' : st === 'error' ? '#F87171' : '#64748F');
  return `
    <button class="btn sm" data-act="nav" data-to="teams">${icon('left', 14)} Swarms</button>
    <div class="card" style="margin-top:12px">
      <div class="row between">
        <div><h2 style="font-size:17px">${esc(w.name)}</h2><div class="tiny muted">${esc(w.objective)}</div></div>
        <span class="chip run"><span class="pulse-dot live"></span>${esc(w.status)}</span>
      </div>
      <div class="row between" style="margin-top:10px">
        <span class="tiny muted">elapsed ${Math.round((now() - w.startedAt) / 60000)}m</span>
        <span class="tiny strong">${fmtMoney(w.budget.spent)} / ${fmtMoney(w.budget.cap)}</span>
      </div>
      <div class="progress" style="margin-top:6px"><i style="width:${Math.round(w.progress * 100)}%"></i></div>
      <div class="row" style="gap:8px;margin-top:12px">
        <button class="btn sm grow" data-act="swarm-pause" data-id="${w.id}">${icon('pause', 13)} Pause</button>
        <button class="btn sm grow" data-act="swarm-cancel" data-id="${w.id}">${icon('stop', 13)} Cancel</button>
      </div>
    </div>

    <div class="section-title">Dependency graph</div>
    <div class="dag-wrap"><div class="dag"><svg viewBox="0 0 360 360" width="100%" height="330">
      ${edges.map(([a, b]) => {
        const [x1, y1] = pos[a]; const [x2, y2] = pos[b];
        return `<line class="edge" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#2E3B55" stroke-width="2.5"/>`;
      }).join('')}
      ${w.nodes.map((n) => {
        const [x, y] = pos[n.id] || [140, 180];
        return `<g>
          <rect x="${x - 56}" y="${y - 18}" width="112" height="36" rx="10" fill="#121826" stroke="${color(n.status)}" stroke-width="2"/>
          <text x="${x}" y="${y - 2}" text-anchor="middle" fill="#EAF0FA" font-size="11" font-weight="700">${esc(n.label)}</text>
          <text x="${x}" y="${y + 11}" text-anchor="middle" fill="#93A1BA" font-size="8.5">${esc(n.status)} · ${fmtMoney(n.spent)}</text>
        </g>`;
      }).join('')}
    </svg></div></div>

    <div class="section-title">Resource allocation</div>
    <div class="card">
      ${[['tokens/s', 78, '60k cap'], ['cost rate', 32, '$6/h cap'], ['plugin quota', 44, '2.2k/5k calls'], ['parallel slots', 66, '4/6 slots']].map(([k, v, c]) => `
        <div style="margin-bottom:10px">
          <div class="row between tiny"><span class="muted">${k}</span><span class="strong">${v}% · ${c}</span></div>
          <div class="progress ${v > 85 ? 'bad' : v > 70 ? 'warn' : ''}"><i style="width:${v}%"></i></div>
        </div>`).join('')}
    </div>

    <div class="section-title">Nodes</div>
    ${w.nodes.map((n) => `
      <div class="list-card">
        <span class="pulse-dot ${n.status === 'running' ? 'run' : n.status === 'done' ? 'live' : 'idle'}"></span>
        <div class="grow"><div class="strong small">${esc(n.label)}</div><div class="tiny muted">${esc(getAgent(n.agent)?.name || n.agent)} · ${esc(n.elapsed)}</div></div>
        <span class="chip tiny">${esc(n.status)}</span>
      </div>`).join('')}`;
}

export function swarmDeploySheet(teamId) {
  const s = getState();
  openSheet({
    title: 'Deploy swarm',
    body: `
      <div class="field"><label>Objective</label>
        <textarea class="input" id="sw-obj" placeholder="e.g. Map the EU AI-agent market…">Explore the Q4 agent-framework landscape and draft a comparison report.</textarea>
      </div>
      <div class="field"><label>Team</label>
        <select class="input" id="sw-team">${s.teams.map((t) => `<option value="${t.id}" ${t.id === (teamId || 'tm-research') ? 'selected' : ''}>${esc(t.name)} · ${t.members.length} agents</option>`).join('')}</select>
      </div>
      <div class="grid-2">
        <div class="field"><label>Topology</label>
          <select class="input" id="sw-topo"><option>Hierarchical</option><option>Peer mesh</option><option>Pipeline</option><option>Debate</option></select>
        </div>
        <div class="field"><label>Budget cap ($)</label><input class="input" id="sw-budget" type="number" value="8" min="1"></div>
      </div>
      <div class="field"><label>Channel</label>
        <div class="seg" id="sw-chan"><button class="active">App</button><button>Telegram</button><button>Both</button></div>
      </div>
      <div class="banner info">${icon('shield', 16)}<div>Gate policy: <strong>all writes require approval</strong> · trust-tier routing enabled</div></div>`,
    foot: `<button class="btn grow" data-sheet-close>Cancel</button>
           <button class="btn grow grad" data-act="swarm-deploy-go">Deploy · est $${'6.40'}</button>`,
  });
  on('swarm-deploy-go', () => {
    const sheet = document.querySelector('.sheet.open');
    const obj = sheet.querySelector('#sw-obj').value.trim() || 'Untitled objective';
    const cap = Number(sheet.querySelector('#sw-budget').value) || 8;
    const teamId2 = sheet.querySelector('#sw-team').value;
    setState((st) => {
      st.swarms.unshift({
        id: uid('sw'), teamId: teamId2, name: obj.toLowerCase().replace(/[^a-z0-9]+/g, '-').split('-').slice(0, 3).join('-'),
        objective: obj, status: 'live', progress: 0.03, budget: { cap, spent: 0.1 }, startedAt: now(), channel: 'app',
        nodes: [
          { id: 'n1', label: 'planner', agent: 'ag-researcher', status: 'running', spent: 0.1, elapsed: '0:04' },
          { id: 'n2', label: 'research-a', agent: 'ag-researcher', status: 'queued', spent: 0, elapsed: '—' },
          { id: 'n3', label: 'research-b', agent: 'ag-content', status: 'queued', spent: 0, elapsed: '—' },
          { id: 'n4', label: 'analyze', agent: 'ag-analyst', status: 'queued', spent: 0, elapsed: '—' },
          { id: 'n5', label: 'writer', agent: 'ag-content', status: 'queued', spent: 0, elapsed: '—' },
          { id: 'n6', label: 'assembler', agent: 'ag-researcher', status: 'queued', spent: 0, elapsed: '—' },
        ],
      });
      logEvent('swarm', `Swarm deployed · ${obj.slice(0, 60)}`);
    }, 'deploy-swarm');
    import('./shell.js').then((m) => m.closeAllSheets());
    toast('Swarm deployed 🚀', 'ok');
    import('./main.js').then((m) => m.navigate('teams'));
  });
}

/* ================= KANBAN ================= */
const COLS = [
  { id: 'todo', label: 'Backlog', dot: 'idle' },
  { id: 'doing', label: 'In progress', dot: 'run' },
  { id: 'review', label: 'Review', dot: 'warn' },
  { id: 'done', label: 'Done', dot: 'live' },
];

views.tasks = {
  title: 'Kanban Board',
  render() {
    const s = getState();
    return `
      <div class="page-head row between">
        <div><h1>Tasks</h1><div class="sub">Drag cards between columns · tap for detail</div></div>
        <button class="btn primary sm" data-act="new-task">${icon('plus', 16)} New</button>
      </div>
      <div class="kanban" id="kanban">
        ${COLS.map((c) => {
          const cards = s.tasks.filter((t) => t.column === c.id);
          return `
            <div class="kanban-col" data-col="${c.id}">
              <div class="col-head">
                <div class="row" style="gap:6px"><span class="pulse-dot ${c.dot}"></span><strong class="small">${c.label}</strong></div>
                <span class="chip tiny">${cards.length}</span>
              </div>
              <div class="kanban-cards" data-drop="${c.id}">
                ${cards.map((t) => `
                  <div class="kcard" data-task="${t.id}" data-act="open-task" data-id="${t.id}">
                    <div class="t">${esc(t.title)}</div>
                    <div class="row between" style="margin-top:8px">
                      <div class="row" style="gap:6px">
                        ${avatar(getAgent(t.assignee)?.name || 'Unassigned', 'sm')}
                        <span class="chip tiny ${t.priority === 'high' ? 'bad' : t.priority === 'med' ? 'warn' : ''}">${t.priority}</span>
                      </div>
                      ${t.deps?.length ? `<span class="tiny muted">⛓ ${t.deps.length}</span>` : ''}
                    </div>
                  </div>`).join('')}
              </div>
            </div>`;
        }).join('')}
      </div>
      <div class="banner info" style="margin-top:4px">${icon('board', 16)}<div>Tip: drag cards with your finger (or mouse). Swipe is disabled on the board — tap a card for actions.</div></div>`;
  },
  mount() {
    enableKanbanDrag();
  },
};

function enableKanbanDrag() {
  const board = document.getElementById('kanban');
  if (!board) return;
  let ghost = null, srcCard = null, taskCol = null;

  board.addEventListener('pointerdown', (e) => {
    const card = e.target.closest('.kcard');
    if (!card) return;
    srcCard = card;
    taskCol = card.closest('.kanban-col');
    const startX = e.clientX, startY = e.clientY;
    let dragging = false;

    const move = (ev) => {
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 8) {
        dragging = true;
        window.__dragging = true;
        ghost = card.cloneNode(true);
        ghost.classList.add('drag-ghost');
        card.classList.add('lifted');
        document.body.appendChild(ghost);
      }
      if (dragging) {
        ev.preventDefault();
        ghost.style.left = ev.clientX + 'px';
        ghost.style.top = ev.clientY + 'px';
        document.querySelectorAll('.kanban-col').forEach((c) => c.classList.remove('drop-hot'));
        ghost.style.display = 'none';
        const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.kanban-col');
        ghost.style.display = '';
        under && under.classList.add('drop-hot');
      }
    };
    const up = (ev) => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      if (dragging) {
        ghost?.remove();
        card.classList.remove('lifted');
        const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.kanban-col');
        document.querySelectorAll('.kanban-col').forEach((c) => c.classList.remove('drop-hot'));
        if (under && under.dataset.col !== taskCol?.dataset.col) {
          const taskId = card.dataset.task;
          setState((s) => {
            const t = s.tasks.find((x) => x.id === taskId);
            if (t) { t.column = under.dataset.col; logEvent('task', `"${t.title}" → ${under.dataset.col}`); }
          }, 'kanban-move');
          toast(`Moved to ${under.querySelector('strong')?.textContent || under.dataset.col}`, 'ok');
          import('./main.js').then((m) => m.rerender());
        }
        window.__suppressClick = true;
        setTimeout(() => { window.__suppressClick = false; window.__dragging = false; }, 350);
      } else {
        // tap → open detail via delegated click handler
      }
    };
    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', up);
  });
}

export function taskSheet(id) {
  const s = getState();
  const t = s.tasks.find((x) => x.id === id);
  if (!t) return;
  const a = getAgent(t.assignee);
  openSheet({
    title: esc(t.title),
    body: `
      <div class="row wrap" style="margin-bottom:10px">
        <span class="chip tiny">${esc(t.column)}</span>
        <span class="chip tiny ${t.priority === 'high' ? 'bad' : 'warn'}">${t.priority} priority</span>
        ${t.deps?.length ? `<span class="chip tiny">⛓ depends on ${t.deps.length}</span>` : ''}
      </div>
      <div class="small" style="margin-bottom:12px">${esc(t.desc)}</div>
      <div class="kv"><span class="k">Assignee</span><span class="row" style="gap:6px">${a ? avatar(a.name, 'sm') : ''}<span class="strong small">${esc(a?.name || 'Unassigned')}</span></span></div>
      <div class="field" style="margin-top:12px"><label>Move to</label>
        <div class="row wrap">
          ${COLS.map((c) => `<button class="chip ${t.column === c.id ? 'brand' : ''}" data-act="task-move" data-id="${t.id}" data-col="${c.id}">${c.label}</button>`).join('')}
        </div>
      </div>
      <div class="field"><label>Reassign</label>
        <select class="input" data-act="noop" id="task-assignee">
          ${s.agents.map((ag) => `<option value="${ag.id}" ${ag.id === t.assignee ? 'selected' : ''}>${esc(ag.name)}</option>`).join('')}
        </select>
      </div>`,
    foot: `<button class="btn grow" data-act="task-run" data-id="${t.id}">${icon('play', 14)} Run with agent</button>`,
  });
  const sel = document.querySelector('.sheet.open #task-assignee');
  sel && sel.addEventListener('change', (e) => {
    setState((st) => { const x = st.tasks.find((y) => y.id === id); if (x) x.assignee = e.target.value; }, 'reassign');
    toast('Reassigned', 'ok');
    import('./main.js').then((m) => m.rerender());
  });
}

export function taskCreateSheet() {
  openSheet({
    title: 'New task',
    body: `
      <div class="field"><label>Title</label><input class="input" id="nt-title" placeholder="What needs doing?"></div>
      <div class="field"><label>Description</label><textarea class="input" id="nt-desc" placeholder="Acceptance criteria, links…"></textarea></div>
      <div class="grid-2">
        <div class="field"><label>Column</label>
          <select class="input" id="nt-col">${COLS.map((c) => `<option value="${c.id}">${c.label}</option>`).join('')}</select>
        </div>
        <div class="field"><label>Priority</label>
          <select class="input" id="nt-pri"><option>high</option><option selected>med</option><option>low</option></select>
        </div>
      </div>
      <div class="field"><label>Assignee</label>
        <select class="input" id="nt-agent">${getState().agents.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>
      </div>`,
    foot: `<button class="btn grow primary" data-act="task-create-go">Create task</button>`,
  });
  on('task-create-go', () => {
    const sheet = document.querySelector('.sheet.open');
    const title = sheet.querySelector('#nt-title').value.trim() || 'Untitled task';
    setState((s) => {
      s.tasks.unshift({
        id: uid('tk'), title, desc: sheet.querySelector('#nt-desc').value.trim() || '—',
        column: sheet.querySelector('#nt-col').value, priority: sheet.querySelector('#nt-pri').value,
        assignee: sheet.querySelector('#nt-agent').value, deps: [],
      });
      logEvent('task', `Task created: ${title}`);
    }, 'create-task');
    import('./shell.js').then((m) => m.closeAllSheets());
    toast('Task created', 'ok');
    import('./main.js').then((m) => m.navigate('tasks'));
  });
}

/* ---- shared agent/task actions ---- */
on('open-agent', (el, ds) => import('./main.js').then((m) => m.navigate(`agents/${ds.id}`)));
on('open-swarm', (el, ds) => import('./main.js').then((m) => m.navigate(`teams/${ds.id}`)));
on('open-task', (el, ds) => taskSheet(ds.id));
on('new-agent', () => agentWizard());
on('new-swarm', (el, ds) => swarmDeploySheet(ds.team));
on('new-task', () => taskCreateSheet());

on('toggle-agent', (el, ds) => {
  setState((s) => {
    const a = s.agents.find((x) => x.id === ds.id);
    if (a) {
      a.status = a.status === 'running' ? 'paused' : 'running';
      a.lastActive = now();
      logEvent('agent', `${a.name} ${a.status}`);
    }
  }, 'toggle-agent');
  toast('Agent state updated', 'ok');
  import('./main.js').then((m) => m.rerender());
});

on('delete-agent', (el, ds) => {
  const a = getAgent(ds.id);
  confirmModal({
    title: `Delete ${esc(a?.name)}?`,
    body: 'Soft-deleted with 30-day restore. Runs and audit logs are preserved.',
    confirmText: 'Delete agent', danger: true, requireText: 'DELETE',
    onConfirm: () => {
      setState((s) => { s.agents = s.agents.filter((x) => x.id !== ds.id); logEvent('agent', `Agent ${a?.name} deleted`); }, 'del-agent');
      toast('Agent deleted', 'ok');
      import('./main.js').then((m) => m.navigate('agents'));
    },
  });
});

on('clone-agent', (el, ds) => {
  const a = getAgent(ds.id);
  if (!a) return;
  setState((s) => {
    s.agents.unshift({ ...a, id: uid('ag'), name: `${a.name}-clone`, status: 'idle', runs: 0, costToday: 0, trust: 50, lastActive: now() });
    logEvent('agent', `Agent ${a.name} cloned`);
  }, 'clone-agent');
  toast('Agent cloned', 'ok');
  import('./main.js').then((m) => m.navigate('agents'));
});

on('task-move', (el, ds) => {
  setState((s) => {
    const t = s.tasks.find((x) => x.id === ds.id);
    if (t) t.column = ds.col;
  }, 'task-move');
  import('./shell.js').then((m) => m.closeAllSheets());
  toast('Moved', 'ok');
  import('./main.js').then((m) => m.rerender());
});

on('task-run', (el, ds) => {
  const t = getState().tasks.find((x) => x.id === ds.id);
  setState((s) => {
    const x = s.tasks.find((y) => y.id === ds.id);
    if (x) x.column = 'doing';
    const ag = s.agents.find((a) => a.id === t?.assignee);
    if (ag) ag.status = 'running';
    logEvent('task', `Run started: ${t?.title}`);
  }, 'task-run');
  import('./shell.js').then((m) => m.closeAllSheets());
  toast('Agent dispatched ▶', 'ok');
  import('./main.js').then((m) => m.rerender());
});

on('swarm-pause', (el, ds) => {
  setState((s) => {
    const w = s.swarms.find((x) => x.id === ds.id);
    if (w) w.status = w.status === 'live' ? 'paused' : 'live';
    logEvent('swarm', `Swarm ${w?.name} ${w?.status}`);
  }, 'swarm-pause');
  toast('Swarm updated', 'ok');
  import('./main.js').then((m) => m.rerender());
});

on('swarm-cancel', (el, ds) => {
  confirmModal({
    title: 'Cancel swarm?',
    body: 'In-flight privileged actions are rolled back through gates. Budget settles at current spend.',
    confirmText: 'Cancel swarm', danger: true,
    onConfirm: () => {
      setState((s) => {
        const w = s.swarms.find((x) => x.id === ds.id);
        if (w) w.status = 'cancelled';
        logEvent('swarm', `Swarm ${w?.name} cancelled`);
      }, 'swarm-cancel');
      toast('Swarm cancelled', 'ok');
      import('./main.js').then((m) => m.navigate('teams'));
    },
  });
});
