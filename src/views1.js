/* ============ Views: Home, Agents, Teams & Swarms, Kanban ============ */
import {
  getState, setState, esc, icon, avatar, uid, now, fmtTime, fmtMoney, trustColor, trustTier,
  logEvent, pendingApprovals, getAgent, commit, initials, avatarColor,
  teamOf, teamPosition, teamsWithCounts,
} from './core.js';
import { openSheet, closeAllSheets, toast, confirmModal, on, actions } from './shell.js';
import { sourceTagHTML, sourceBannerHTML } from './sourceui.js';
import {
  isLive, getStatus, createAgent, updateAgent, createTask, updateTask, deleteAgent, runAgent,
  createSwarmPlan, updateSwarmPlan, setSwarmPlanStatus, deleteSwarmPlan, getSwarmsRuntime,
} from './datastore.js';
import { isApiMode } from './api.js';
import { openTeamPanel } from './team-panel.js';
import './agents.css';
import { can } from './auth.js';
import {
  COLUMNS as COLS, ZOOM_MIN, ZOOM_MAX, COLUMN_IDS, columnLabel, boardPrefs, boardStats,
  visibleTasks, wiresEnabled, dependencyEdges, wirePaths, setZoom, zoomBy, fitZoom, toggleWires,
  setFilter, clearFilter, moveTask, assignTask, setPriority, renameTask, linkDeps, unlinkDeps,
  deleteTask,
} from './kanban.js';

/** True when this browser may not write the given slice itself (server owns it, or no session). */
function writeBlocked(slice, label, action) {
  if (!isApiMode()) return false;
  toast(
    isLive(slice)
      ? `${label}: the gateway serves ${slice} but has no endpoint for ${action}. Nothing was changed.`
      : `Sign in to a gateway to ${action}. Nothing was changed.`,
    'bad'
  );
  return true;
}

const permissionDenied = (perm) => isApiMode() && !can(perm);

/**
 * Agent cards are swipeable: left = run, right = stop, left + hold = delete (confirmed).
 * The card inside stays a normal button, so tapping still opens the agent and the same actions
 * also exist as buttons on the agent screen — gestures are an accelerator, not the only route.
 */
function swipeCard(agent, inner, { cls = 'list-card', extra = '' } = {}) {
  const hint = 'Swipe left to run, swipe right to stop, or swipe left and hold to delete.';
  return `<div class="swipe-wrap" data-swipe-card data-swipe-id="${esc(agent.id)}" data-swipe-name="${esc(agent.name)}">
      <div class="swipe-under" data-side="left" aria-hidden="true"><span class="swipe-under-label">${icon('play', 15)} Run</span><span class="swipe-under-note">hold to delete</span></div>
      <div class="swipe-under" data-side="right" aria-hidden="true"><span class="swipe-under-label">${icon('stop', 15)} Stop</span></div>
      <button class="${cls} swipe-surface" data-act="open-agent" data-id="${esc(agent.id)}"
              aria-describedby="swipe-help" style="width:100%;text-align:left" title="${hint}">${inner}</button>
      ${extra}
    </div>`;
}

export const views = {};

/* ================= HOME ================= */
views.home = {
  title: 'Command Deck',
  render() {
    const s = getState();
    const sync = getStatus();
    const spend = s.agents.reduce((sum, agent) => sum + (Number(agent.costToday) || 0), 0);
    const running = s.agents.filter((agent) => agent.status === 'running').length;
    const pending = pendingApprovals();
    const swarms = s.swarms.filter((swarm) => swarm.status === 'live');
    const trust = s.agents.length ? Math.round(s.agents.reduce((sum, agent) => sum + (Number(agent.trust) || 0), 0) / s.agents.length) : 0;
    const gatewayLabel = !isApiMode() ? 'Demo workspace' : sync.status === 'live' ? 'Gateway synced' : `Gateway ${sync.status}`;
    return `
      <div class="deck">
        <div class="deck-heading">
          <div>
            <div class="deck-eyebrow font-mono"><span class="deck-eyebrow-dot"></span> RELAY / WORKSPACE OVERVIEW</div>
            <h1>Command deck<span class="deck-title-dot">.</span></h1>
            <p>Your workspace at a glance. Monitor your agents, activity and work in progress.</p>
          </div>
          <div class="deck-actions">
            <span class="deck-mode"><span class="deck-mode-dot"></span>${esc(gatewayLabel)}</span>
            <button class="btn primary" data-act="new-agent">${icon('plus', 17)} New agent</button>
          </div>
        </div>

        ${pending.length ? `<div class="deck-alert">
          <span class="deck-alert-icon">${icon('shield', 18)}</span>
          <div class="grow"><strong>${pending.length} approval${pending.length === 1 ? '' : 's'} awaiting review</strong><span>${esc(pending[0].action)} · ${isLive('approvals') ? 'Gateway' : 'Demo data'}</span></div>
          <button class="btn sm" data-act="notifications">Review ${icon('right', 15)}</button>
        </div>` : ''}

        <div class="deck-section-heading"><div><div class="deck-kicker">WORKSPACE PULSE</div><h2>Overview</h2></div><span class="deck-caption font-mono">CURRENT SNAPSHOT</span></div>
        <div class="deck-metrics">
          <div class="deck-metric"><div class="deck-metric-top"><span>Agents running</span><span class="deck-metric-icon">${icon('robot', 17)}</span></div><div class="deck-value">${running}<small> / ${s.agents.length}</small></div><div class="deck-metric-foot"><span class="deck-status-dot"></span>${isLive('agents') ? 'Gateway data' : 'Demo data'}</div></div>
          <div class="deck-metric"><div class="deck-metric-top"><span>Tasks in progress</span><span class="deck-metric-icon">${icon('board', 17)}</span></div><div class="deck-value">${s.tasks.filter((task) => task.column === 'doing').length}</div><div class="deck-metric-foot">${isLive('tasks') ? 'Gateway tasks' : 'Demo tasks'}</div></div>
          <div class="deck-metric"><div class="deck-metric-top"><span>Spend today</span><span class="deck-metric-icon">${icon('chart', 17)}</span></div><div class="deck-value">${fmtMoney(spend)}</div><div class="deck-metric-foot">${isLive('agents') ? 'Reported by gateway' : 'Demo figures'}</div></div>
          <div class="deck-metric"><div class="deck-metric-top"><span>Fleet trust</span><span class="deck-metric-icon">${icon('shield', 17)}</span></div><div class="deck-value">${trust}<small> / 100</small></div><div class="deck-metric-foot">Average across agents</div></div>
        </div>

        <div class="deck-section-heading"><div><div class="deck-kicker">YOUR FLEET</div><h2>Agent telemetry</h2></div><button class="deck-link" data-act="nav" data-to="agents">All agents ${icon('right', 15)}</button></div>
        <p class="swipe-hint" id="swipe-help">${icon('left', 12)} Swipe left to run · swipe right to stop · swipe left and hold to delete.</p>
        <div class="deck-agents">
          ${s.agents.slice(0, 3).map((agent) => `
            ${swipeCard(agent, `
              <div class="deck-agent-top">${avatar(agent.name)}<span class="chip tiny ${agent.status === 'running' ? 'ok' : agent.status === 'error' ? 'bad' : agent.status === 'paused' ? 'warn' : ''}">${esc(agent.status)}</span></div>
              <div class="deck-agent-name">${esc(agent.name)}</div><div class="deck-agent-role">${esc(agent.role || 'Agent profile')}</div>
              <div class="deck-agent-divider"></div>
              <div class="deck-agent-meta"><span>${esc(agent.framework)}</span><span>Trust <strong>${esc(agent.trust)}</strong></span></div>`, { cls: 'deck-agent' })}`).join('') || '<div class="deck-empty">No agents in this workspace yet.</div>'}
        </div>

        <div class="deck-lower">
          <section class="deck-panel">
            <div class="deck-panel-head"><div><div class="deck-kicker">PLANS</div><h2>Swarm records</h2></div><button class="deck-link" data-act="nav" data-to="teams">View all ${icon('right', 15)}</button></div>
            <p class="deck-panel-sub">${swarms.length} saved · not executed by anything</p>
            ${swarms.length ? swarms.slice(0, 3).map((swarm) => `<button class="deck-swarm" data-act="open-swarm" data-id="${esc(swarm.id)}">
              <div class="deck-swarm-icon">${icon('swarm', 18)}</div><div class="grow"><div class="deck-swarm-name">${esc(swarm.name)}</div><div class="deck-swarm-desc">${esc(swarm.objective)}</div><div class="progress"><i style="width:${Math.max(0, Math.min(100, Math.round(swarm.progress * 100)))}%"></i></div></div><span class="deck-percent">${Math.round(swarm.progress * 100)}% planned</span>
            </button>`).join('') : '<div class="deck-empty">No swarm records yet.</div>'}
          </section>
          <section class="deck-panel">
            <div class="deck-panel-head"><div><div class="deck-kicker">EVENT STREAM</div><h2>Recent activity</h2></div>${sourceTagHTML('events')}</div>
            <p class="deck-panel-sub">The latest events in your workspace.</p>
            <div class="deck-events">${s.events.slice(0, 4).map((event) => `<div class="deck-event"><span class="deck-event-dot"></span><div class="grow">${esc(event.text)}</div><span class="deck-event-time">${fmtTime(event.ts)}</span></div>`).join('') || '<div class="deck-empty">No recent events.</div>'}</div>
          </section>
        </div>
        <div class="deck-section-heading"><div><div class="deck-kicker">GET STARTED</div><h2>Quick actions</h2></div></div>
        <div class="deck-quick">
          <button data-act="open-designer"><span class="deck-quick-icon">${icon('spark', 19)}</span><span><strong>Design an agent</strong><small>Configure a new profile</small></span>${icon('right', 16)}</button>
          <button data-act="nav" data-to="tasks"><span class="deck-quick-icon">${icon('board', 19)}</span><span><strong>Open tasks</strong><small>See the board</small></span>${icon('right', 16)}</button>
          <button data-act="nav" data-to="terminal"><span class="deck-quick-icon">${icon('terminal', 19)}</span><span><strong>Open terminal</strong><small>Explore the console</small></span>${icon('right', 16)}</button>
        </div>
        <div class="deck-footnote">${icon('shield', 15)} <span>Showing ${esc(gatewayLabel.toLowerCase())}. Swarms and usage remain demo data.</span></div>
      </div>`;
  },
};

export function sparkline(vals, color = 'url(#sg)') {
  const w = 300, h = 44, max = Math.max(...vals, 0.01), min = Math.min(...vals, 0);
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * w},${h - 4 - ((v - min) / (max - min || 1)) * (h - 10)}`);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="sg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="var(--accent-primary)"/><stop offset="1" stop-color="var(--accent-secondary)"/></linearGradient></defs>
    <polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

/* ================= AGENTS ================= */
views.agents = {
  title: 'Agent Manager',
  render(params) {
    if (params && params.id) return agentDetail(params.id);
    const s = getState();
    const running = s.agents.filter((a) => a.status === 'running').length;
    const teams = teamsWithCounts();
    return `
      <div class="page-head row between">
        <div><h1>Agents</h1><div class="sub">${s.agents.length} profiles · ${running} running · ${teams.length} teams ${sourceTagHTML('agents')}</div></div>
        <div class="row wrap" style="gap:8px">
          <button class="btn sm" data-act="team-panel" data-id="">${icon('team', 16)} Teams</button>
          <button class="btn sm" data-act="open-designer">${icon('spark', 16)} Designer</button>
          <button class="btn primary sm" data-act="new-agent">${icon('plus', 16)} New</button>
        </div>
      </div>
      ${sourceBannerHTML('agents')}
      <div class="scroll-x" style="margin-bottom:12px">
        <span class="chip brand">All</span>${teams.map((t) => `<span class="chip">${esc(t.name)} · ${t.memberCount}</span>`).join('')}
      </div>
      <p class="swipe-hint" id="swipe-help">${icon('left', 12)} Swipe a card left to run · right to stop · left and hold to delete. Every action is also a button on the card and in the agent panel.</p>
      <div class="ag-grid">
        ${s.agents.map((a) => agentCard(a)).join('')}
      </div>`;
  },
};

/** Which card is being edited inline. Editing is local until Save writes. */
let agentEditId = '';

function agentCard(a) {
  if (agentEditId === a.id) return agentEditCard(a);
  const team = teamOf(a);
  const { position, total } = teamPosition(a);
  const chips = [
    a.framework,
    String(a.model).split('/')[1] || a.model,
    ...(a.skills || []).slice(0, 3),
  ];
  const inner = `
    ${avatar(a.name)}
    <div class="grow">
      <div class="row" style="gap:6px">
        <span class="strong small">${esc(a.name)}</span>
        <span class="chip tiny ${a.status === 'running' ? 'ok' : a.status === 'error' ? 'bad' : ''}">${esc(a.status)}</span>
      </div>
      <div class="tiny muted ellipsis">${esc(a.role || 'No role')}</div>
      <div class="tiny muted">${team ? `${esc(team.name)} · ${position} of ${total}` : 'No team'}</div>
      <div class="row wrap" style="gap:4px;margin-top:6px">
        ${chips.map((c, i) => `<span class="chip tiny ${i === 1 ? 'brand' : ''}">${esc(c)}</span>`).join('')}
        ${(a.tools || []).length ? `<span class="chip tiny">${(a.tools || []).length} tools</span>` : ''}
      </div>
    </div>`;
  return `
    <div class="swipe-wrap ag-cell" data-swipe-card data-swipe-id="${esc(a.id)}" data-swipe-name="${esc(a.name)}">
      <div class="swipe-under" data-side="left" aria-hidden="true"><span class="swipe-under-label">${icon('play', 15)} Run</span><span class="swipe-under-note">hold to delete</span></div>
      <div class="swipe-under" data-side="right" aria-hidden="true"><span class="swipe-under-label">${icon('stop', 15)} Stop</span></div>
      <article class="ag-card swipe-surface" data-act="open-agent" data-id="${esc(a.id)}">
        <button class="ag-open" data-act="open-agent" data-id="${esc(a.id)}" aria-label="Open ${esc(a.name)}">
          ${inner}
        </button>
        <div class="ag-foot">
          <button class="btn sm" data-act="agent-edit" data-id="${esc(a.id)}">${icon('doc', 14)} Edit</button>
          <button class="iconbtn ag-x" data-act="agent-delete-x" data-id="${esc(a.id)}" aria-label="Delete ${esc(a.name)}">${icon('x', 18)}</button>
        </div>
      </article>
    </div>`;
}

/** Inline edit of name, role and team with an explicit Save. Nothing is written until it is tapped. */
function agentEditCard(a) {
  const teams = teamsWithCounts();
  return `
    <article class="ag-card ag-card-edit" data-edit-id="${esc(a.id)}">
      <div class="tpm-form" style="margin-top:0">
        <label class="tiny muted" for="ag-name-${esc(a.id)}">Name</label>
        <input class="input" id="ag-name-${esc(a.id)}" value="${esc(a.name)}" maxlength="120">
        <label class="tiny muted" for="ag-role-${esc(a.id)}">Role</label>
        <input class="input" id="ag-role-${esc(a.id)}" value="${esc(a.role || '')}" maxlength="160">
        <label class="tiny muted" for="ag-team-${esc(a.id)}">Team</label>
        <select class="input" id="ag-team-${esc(a.id)}">
          <option value="">No team</option>
          ${teams.map((t) => `<option value="${esc(t.id)}" ${t.id === a.teamId ? 'selected' : ''}>${esc(t.name)} · ${t.memberCount} member${t.memberCount === 1 ? '' : 's'}</option>`).join('')}
        </select>
        <div class="tpm-actions">
          <button class="btn sm primary" data-act="agent-save" data-id="${esc(a.id)}">Save</button>
          <button class="btn sm" data-act="agent-edit-cancel">Cancel</button>
        </div>
        <p class="tiny muted">A failed write leaves this card exactly as the server has it.</p>
      </div>
    </article>`;
}

function agentDetail(id) {
  const a = getAgent(id);
  if (!a) return `<div class="empty">Agent not found</div>`;
  const team = teamOf(a);
  const { position, total: positionTotal } = teamPosition(a);
  return `
    <button class="btn sm" data-act="nav" data-to="agents">${icon('left', 14)} All agents</button>
    <div class="card" style="margin-top:12px">
      <div class="row">
        ${avatar(a.name)}
        <div class="grow">
          <h2 style="font-size:18px">${esc(a.name)}</h2>
          <div class="tiny muted">${esc(a.role)}</div>
        </div>
        <button class="btn sm ${['running','queued'].includes(a.status) ? '' : 'primary'}" data-act="toggle-agent" data-id="${a.id}" ${['running','queued'].includes(a.status) ? 'disabled' : ''}>
          ${a.status === 'running' ? icon('loader-circle', 14) + ' Running' : a.status === 'queued' ? icon('clock', 14) + ' Queued' : icon('play', 14) + ' Run'}
        </button>
      </div>
      <div class="row wrap" style="margin-top:10px;gap:8px">
        <button class="btn sm" data-act="team-panel" data-id="${a.id}" data-team="${esc(a.teamId || '')}">
          ${icon('team', 15)} Team management
        </button>
        <span class="tiny muted">${team ? `${esc(team.name)} · position ${position} of ${positionTotal}` : 'Not in a team'}</span>
      </div>
      <div class="row wrap" style="margin-top:12px">
        <span class="chip tiny">${esc(a.framework)}</span>
        <span class="chip tiny brand">${esc(a.model)}</span>
        <span class="chip tiny">↺ ${esc(a.fallback)}</span>
        <span class="chip tiny" style="color:${trustColor(a.trust)}">◈ trust ${a.trust} · tier ${trustTier(a.trust).toUpperCase()}</span>
      </div>
      <div class="grid-3" style="margin-top:12px">
        <div class="stat"><div class="k">Success</div><div class="v" style="font-size:17px"> ${a.runs > 0 ? Math.round(a.successRate * 100) + '%' : '—'}</div></div>
        <div class="stat"><div class="k">Runs</div><div class="v" style="font-size:17px"> ${a.runs || '—'}</div></div>
        <div class="stat"><div class="k">Cost 24h</div><div class="v" style="font-size:17px">${fmtMoney(a.costToday)}</div></div>
      </div>
    </div>

    <div class="section-title">Brain</div>
    <div class="card">
      <div class="field"><label>System prompt (v7 · human-edited)</label>
        <textarea class="input" data-model="_agentprompt">${esc(a.prompt)}</textarea>
      </div>
      <div class="kv"><span class="k">Behaviour autonomy</span><span class="strong">L${a.autonomy} ${['ask-always', 'guided', 'supervised', 'guarded-auto', 'full-auto'][a.autonomy] || ''}</span></div>
      <div class="tiny muted">Recorded on the definition. It is not enforced by any runtime, and it does not authorise code changes — that is the separate self-modification policy below.</div>
      <div class="kv"><span class="k">Self-improvement</span>
        <button class="btn sm" data-act="nav" data-to="evolution/${a.id}">${icon('spark', 15)} Policy, experiments &amp; rollback</button>
      </div>
      <div class="tiny muted">Autonomy level, authorised scope, diffs, test evidence, reviews and approvals for this agent live on the Self-Improvement panel. The gateway enforces them.</div>
    </div>

    ${(a.tools || []).length ? '<div class="banner warn" style="margin-top:10px">Tool execution is not connected yet. This run can reason and write, but cannot browse or call external tools.</div>' : ''}
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
  // Shortcut into the full Agent Designer, carrying whatever has been typed so far.
  const shortcut = document.createElement('button');
  shortcut.className = 'btn block';
  shortcut.dataset.act = 'wizard-designer';
  shortcut.innerHTML = `${icon('spark', 15)} Open the Agent Designer instead`;
  shortcut.style.cssText = 'margin-top:8px';
  el.querySelector('.sheet-body')?.appendChild(shortcut);
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
  actions['wizard-designer'] = () => {
    const read = (sel, fallback) => {
      const node = el.querySelector(sel);
      return node ? node.value : fallback;
    };
    const snapshot = {
      name: read('#w-name', draft.name),
      role: read('#w-role', draft.role),
      framework: draft.framework,
      model: read('#w-model', draft.model),
      autonomy: Number(read('#w-aut', draft.autonomy)) || draft.autonomy,
      tools: draft.tools,
    };
    close();
    import('./designer.js').then((m) => m.openDesigner({ seed: snapshot }));
  };
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
    if (isApiMode()) {
      if (permissionDenied('agent:write')) {
        toast('Your role cannot create agents on the gateway', 'bad');
        return;
      }
      const next = el.querySelector('[data-act="wiz-next"]');
      if (next) { next.disabled = true; next.textContent = 'Creating…'; }
      createAgent({
        name: draft.name, role: draft.role, framework: draft.framework, model: draft.model,
        autonomy: draft.autonomy, tools: draft.tools, skills: draft.skills,
        prompt: `You are ${draft.name}. ${draft.role}`,
      })
        .then((row) => {
          close();
          toast(`Agent ${esc(row.name)} created on the gateway`, 'ok');
          import('./main.js').then((m) => m.navigate('agents'));
        })
        .catch((err) => {
          if (next) { next.disabled = false; next.textContent = 'Next'; }
          toast(`Gateway refused: ${esc(err.message)}`, 'bad');
        });
      return;
    }
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
/* Current selection on the Teams screen. One source of membership: the agent rows. */
let teamsSel = '';
let teamsMenuFor = '';

/** The team board: left menu with real member counts, active team panel, ⋯ menu, floating new-agent. */
export function teamsBoardHTML() {
  const teams = teamsWithCounts();
  const sel = teamsSel || teams[0]?.id || '';
  const active = teams.find((t) => t.id === sel) || null;
  const loose = getState().agents.filter((a) => !a.teamId);
  return `
    <div class="teams-layout">
      <nav class="teams-menu" aria-label="Teams">
        ${teams.map((t) => `
          <div class="teams-menu-row ${t.id === sel ? 'on' : ''}">
            <button class="teams-menu-main" data-act="teams-select" data-id="${esc(t.id)}" aria-current="${t.id === sel ? 'true' : 'false'}">
              <span class="strong small grow">${esc(t.name)}</span>
              <span class="chip tiny">${t.memberCount} member${t.memberCount === 1 ? '' : 's'}</span>
            </button>
            <button class="iconbtn" data-act="teams-menu" data-id="${esc(t.id)}" aria-haspopup="menu"
              aria-expanded="${teamsMenuFor === t.id}" aria-label="Actions for ${esc(t.name)}">${icon('more', 18)}</button>
            ${teamsMenuFor === t.id ? `
              <div class="tpm-menu-pop" role="menu">
                <button role="menuitem" data-act="teams-view" data-id="${esc(t.id)}">${icon('eye', 15)} View team</button>
                <button role="menuitem" data-act="teams-edit" data-id="${esc(t.id)}">${icon('gear', 15)} Edit team</button>
                <button role="menuitem" class="danger" data-act="teams-delete" data-id="${esc(t.id)}">${icon('trash', 15)} Delete team</button>
              </div>` : ''}
          </div>`).join('')}
        <div class="teams-menu-row">
          <span class="strong small grow muted">No team</span>
          <span class="chip tiny">${loose.length}</span>
        </div>
        <button class="btn sm block" data-act="team-panel" data-id="" style="margin-top:8px">${icon('plus', 14)} New team</button>
      </nav>
      <section class="teams-active" aria-label="Active team">
        ${active ? `
          <div class="row between">
            <div class="grow">
              <div class="strong">${esc(active.name)}</div>
              <div class="tiny muted">${esc(active.topology)} · ${active.memberCount} member${active.memberCount === 1 ? '' : 's'} · ${esc(active.health)}</div>
            </div>
            <button class="btn sm" data-act="team-panel" data-team="${esc(active.id)}" data-id="${esc(active.members[0]?.id || '')}">${icon('team', 14)} Open</button>
          </div>
          <p class="small muted">${esc(active.description || 'No description yet.')}</p>
          <div class="row wrap" style="gap:6px">
            ${active.members.map((m) => `<span class="chip tiny">${esc(m.name)} · ${m.teamPosition || m.position || 0} of ${active.memberCount}</span>`).join('') || '<span class="tiny muted">No agents yet.</span>'}
          </div>
          <button class="btn block primary" style="margin-top:12px" data-act="team-new-agent" data-team="${esc(active.id)}" data-name="${esc(active.name)}">
            ${icon('plus', 15)} New agent in ${esc(active.name)}
          </button>
          <p class="tiny muted">The designer opens with ${esc(active.name)} filled in as an editable suggestion — nothing is created until you save there.</p>` : `
          <div class="empty"><div class="e-ico">◇</div><div>No teams yet. Create one from the team management panel.</div></div>`}
      </section>
    </div>`;
}

views.teams = {
  title: 'Teams & Swarms',
  render(params) {
    if (params && params.id) return swarmMonitor(params.id);
    const s = getState();
    return `
      <div class="page-head row between">
        <div><h1>Teams & Swarms</h1><div class="sub">Compose teams · swarm records ${sourceTagHTML('swarms')}</div></div>
        <button class="btn primary sm" data-act="new-swarm">${icon('plus', 16)} New plan</button>
      </div>
      <div class="banner warn">${icon('shield', 16)}<div><strong>No swarm has ever executed anything.</strong>
        These are records: no scheduler, worker or agent process reads them, and their progress does not
        advance. The screen used to animate them from a browser timer.</div></div>
      <div class="section-title" style="margin-top:0">Swarm records</div>
      ${s.swarms.map((w) => `
        <button class="list-card" data-act="open-swarm" data-id="${w.id}" style="width:100%;text-align:left">
          <div class="avatar" style="background:${w.status === 'live' ? 'color-mix(in srgb, var(--running) 25%, var(--elevated))' : 'var(--elevated)'};color:var(--brand)">${icon('swarm', 18)}</div>
          <div class="grow">
            <div class="row wrap" style="gap:6px"><span class="strong small">${esc(w.name)}</span>
              <span class="chip tiny">${esc(w.status)}</span>
              <span class="chip tiny warn" data-swarm-executed="no">not executed</span></div>
            <div class="tiny muted ellipsis">${esc(w.objective)}</div>
            <div class="progress" style="margin-top:6px"><i style="width:${Math.round(w.progress * 100)}%"></i></div>
            <div class="row between" style="margin-top:5px">
              <span class="tiny muted">${fmtTime(w.startedAt)} · ${esc(w.channel)}</span>
              <span class="tiny muted">${fmtMoney(w.budget.spent)} / ${fmtMoney(w.budget.cap)}</span>
            </div>
          </div>
        </button>`).join('')}

      <div class="section-title">Teams</div>
      ${teamsBoardHTML()}

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
  const s = getState();
  const w = s.swarms.find((x) => x.id === id);
  if (!w) return `<div class="empty">Swarm not found</div>`;
  const pos = { n1: [70, 18], n2: [70, 110], n3: [210, 110], n4: [70, 202], n5: [210, 202], n6: [140, 294] };
  const edges = [['n1', 'n2'], ['n1', 'n3'], ['n2', 'n4'], ['n2', 'n5'], ['n3', 'n5'], ['n4', 'n6'], ['n5', 'n6']];
  const color = (st) => (st === 'done' ? 'var(--state-success)' : st === 'running' ? 'var(--accent-secondary)' : st === 'error' ? 'var(--state-error)' : 'var(--text-muted)');
  const team = s.teams?.find((t) => t.id === w.teamId);
  const live = isLive('swarms');
  return `
    <button class="btn sm" data-act="nav" data-to="teams">${icon('left', 14)} Swarms</button>
    <div class="card" style="margin-top:12px">
      <div class="row between">
        <div><h2 style="font-size:17px">${esc(w.name)}</h2><div class="tiny muted">${esc(w.objective)}</div></div>
        <span class="chip tiny" data-swarm-status="${esc(w.status)}">${esc(w.status)}</span>
      </div>
      <div class="row between" style="margin-top:10px">
        <span class="tiny muted">saved ${fmtTime(w.startedAt)} · never run</span>
        <span class="tiny strong">${fmtMoney(w.budget.spent)} / ${fmtMoney(w.budget.cap)} cap</span>
      </div>
      <div class="banner warn" style="margin-top:12px">${icon('shield', 16)}<div><strong>Not executed.</strong>
        ${esc(getSwarmsRuntime()?.note || 'No scheduler or worker exists in this build, so a plan has no progress and no spend.')}
        ${live ? '' : 'This plan is stored in this browser only.'}</div></div>

      <div class="row wrap" style="margin-top:12px;gap:8px">
        ${w.status === 'planned' ? `<button class="btn sm grow" data-act="swarm-status" data-id="${w.id}" data-status="cancelled">${icon('stop', 13)} Mark cancelled</button>` : ''}
        ${w.status === 'cancelled' ? `<button class="btn sm grow" data-act="swarm-status" data-id="${w.id}" data-status="planned">${icon('undo', 13)} Re-open plan</button>` : ''}
        ${w.status !== 'archived' ? `<button class="btn sm grow" data-act="swarm-status" data-id="${w.id}" data-status="archived">${icon('archive', 13)} Archive</button>` : ''}
        <button class="btn sm grow danger" data-act="swarm-delete" data-id="${w.id}">${icon('trash', 13)} Delete</button>
      </div>
    </div>

    <div class="section-title">Plan facts</div>
    <div class="card">
      <div class="kv"><span class="k">Team</span><span class="strong">${esc(team?.name || w.teamId || 'none')}</span></div>
      <div class="kv"><span class="k">Planned nodes</span><span class="strong">${(w.nodes || []).length}</span></div>
      <div class="kv"><span class="k">Budget cap</span><span class="strong">${fmtMoney(w.budget.cap)}</span></div>
      <div class="kv"><span class="k">Spent</span><span class="strong">${fmtMoney(0)} — nothing ran</span></div>
      <div class="kv"><span class="k">Channel</span><span class="strong">${esc(w.channel)}</span></div>
      <div class="kv"><span class="k">Saved by</span><span class="strong">${esc(w.createdBy || '—')}</span></div>
      <div class="kv"><span class="k">Source</span><span class="strong">${live ? 'gateway row' : 'this browser (demo)'}</span></div>
    </div>

    <div class="section-title">Dependency graph (planned)</div>
    <div class="dag-wrap"><div class="dag"><svg viewBox="0 0 360 360" width="100%" height="330">
      ${edges.map(([a, b]) => {
        const [x1, y1] = pos[a]; const [x2, y2] = pos[b];
        return `<line class="edge" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--border-default)" stroke-width="2.5"/>`;
      }).join('')}
      ${w.nodes.map((n) => {
        const [x, y] = pos[n.id] || [140, 180];
        return `<g>
          <rect x="${x - 56}" y="${y - 18}" width="112" height="36" rx="10" fill="var(--bg-surface)" stroke="${color(n.status)}" stroke-width="2"/>
          <text x="${x}" y="${y - 2}" text-anchor="middle" fill="var(--text-primary)" font-size="11" font-weight="700">${esc(n.label)}</text>
          <text x="${x}" y="${y + 11}" text-anchor="middle" fill="var(--text-muted)" font-size="8.5">${esc(n.status)} · ${fmtMoney(n.spent)}</text>
        </g>`;
      }).join('')}
    </svg></div></div>

    <div class="section-title">Resource allocation</div>
    <div class="card tiny muted" style="line-height:1.8">
      Nothing is allocated: no runner holds a slot, a token budget or a cost rate for this plan. A scheduler
      would report those numbers; typed-in percentages are not a substitute.
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
    title: 'New swarm plan',
    body: `
      <div class="field"><label>Objective</label>
        <textarea class="input" id="sw-obj" placeholder="e.g. Map the EU AI-agent market…">Explore the Q4 agent-framework landscape and draft a comparison report.</textarea>
      </div>
      <div class="field"><label>Team</label>
        <select class="input" id="sw-team">${teamsWithCounts().map((t) => `<option value="${t.id}" ${t.id === (teamId || 'tm-research') ? 'selected' : ''}>${esc(t.name)} · ${t.memberCount} agents</option>`).join('')}</select>
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
      <div class="banner warn">${icon('shield', 16)}<div><strong>Nothing will run.</strong> This saves a swarm record
        with the plan and the budget you set. There is no scheduler or worker to execute it, and the
        estimate a deploy sheet would show has to be computed from a budget, not typed in.</div></div>`,
    foot: `<button class="btn grow" data-sheet-close>Cancel</button>
           <button class="btn grow grad" data-act="swarm-deploy-go">Save record</button>`,
  });
  on('swarm-deploy-go', async () => {
    const sheet = document.querySelector('.sheet.open');
    const obj = sheet.querySelector('#sw-obj').value.trim();
    const cap = Number(sheet.querySelector('#sw-budget').value) || 8;
    const teamId2 = sheet.querySelector('#sw-team').value;
    const topology = sheet.querySelector('#sw-topo').value;
    if (!obj) { toast('An objective is required', 'bad'); return; }
    const draft = { objective: obj, name: obj.toLowerCase().replace(/[^a-z0-9]+/g, '-').split('-').slice(0, 3).join('-'), teamId: teamId2, budgetCap: cap, topology, channel: 'app' };

    // Gateway mode: the plan is a row, or it is nothing. Demo mode: the same shape, local, labelled demo.
    if (isApiMode()) {
      if (permissionDenied('swarm:write')) { toast('Your role cannot save swarm plans', 'bad'); return; }
      const btn = document.querySelector('[data-act="swarm-deploy-go"]');
      if (btn) btn.setAttribute('disabled', 'disabled');
      try {
        const row = await createSwarmPlan(draft);
        closeAllSheets();
        toast('Plan saved on the gateway — nothing is executing', 'ok');
        import('./main.js').then((m) => m.navigate(`teams/${row.id}`));
      } catch (error) {
        toast(`Gateway refused: ${error.message}`, 'bad');
        if (btn) btn.removeAttribute('disabled');
      }
      return;
    }

    const id = uid('sw');
    setState((st) => {
      st.swarms.unshift({
        id, teamId: teamId2, name: draft.name,
        // `executed: false` is the honest field: nothing read this row, nothing advanced it, and no money
        // was spent — so `status` is 'planned', not 'live', and `spent` is 0 rather than a plausible 0.1.
        objective: obj, status: 'planned', executed: false, progress: 0, budget: { cap, spent: 0 }, startedAt: now(), updatedAt: now(), channel: 'app',
        nodes: [
          { id: 'n1', label: 'planner', agent: 'ag-researcher', status: 'planned', spent: 0, elapsed: '—' },
          { id: 'n2', label: 'research-a', agent: 'ag-researcher', status: 'planned', spent: 0, elapsed: '—' },
          { id: 'n3', label: 'research-b', agent: 'ag-content', status: 'planned', spent: 0, elapsed: '—' },
          { id: 'n4', label: 'analyze', agent: 'ag-analyst', status: 'planned', spent: 0, elapsed: '—' },
          { id: 'n5', label: 'writer', agent: 'ag-content', status: 'planned', spent: 0, elapsed: '—' },
          { id: 'n6', label: 'assembler', agent: 'ag-researcher', status: 'planned', spent: 0, elapsed: '—' },
        ],
      });
      logEvent('swarm', `Swarm plan saved (not executed) · ${obj.slice(0, 60)}`);
    }, 'deploy-swarm');
    closeAllSheets();
    toast('Swarm plan saved in this browser — nothing is executing', 'ok');
    import('./main.js').then((m) => m.navigate(`teams/${id}`));
  });
}

/* ================= KANBAN ================= */
/* Board rendering lives here; every write goes through src/kanban.js so the drawer, the drag and the
 * Copilot share one code path (including the confirmation prompt). */

function kbScroll(fn) {
  const before = document.getElementById('kb-viewport')?.scrollLeft || 0;
  fn();
  const after = document.getElementById('kb-viewport');
  if (after) after.scrollLeft = before;
  drawWires();
}

views.tasks = {
  title: 'Kanban Board',
  render() {
    const s = getState();
    const prefs = boardPrefs();
    const shown = visibleTasks(s.tasks, prefs.filter);
    const st = boardStats();
    const wires = wiresEnabled(prefs);
    const zoomPct = Math.round(prefs.zoom * 100);
    const filtered = prefs.filter.agent !== 'all' || prefs.filter.priority !== 'all';
    const agents = s.agents.filter((a) => a.id && a.name);

    return `
      <div class="page-head row between">
        <div><h1>Tasks</h1><div class="sub">Drag a card, then confirm · tap for detail ${sourceTagHTML('tasks')}</div></div>
        <button class="btn primary sm" data-act="new-task">${icon('plus', 16)} New</button>
      </div>
      ${sourceBannerHTML('tasks')}

      <div class="kb-toolbar">
        <div class="kb-zoom" role="group" aria-label="Board zoom">
          <button class="kb-zbtn" data-act="kb-zoom-out" aria-label="Zoom out" ${prefs.zoom <= ZOOM_MIN + 0.001 ? 'disabled' : ''}>−</button>
          <output class="kb-zval" id="kb-zoom-val" aria-live="polite">${zoomPct}%</output>
          <button class="kb-zbtn" data-act="kb-zoom-in" aria-label="Zoom in" ${prefs.zoom >= ZOOM_MAX - 0.001 ? 'disabled' : ''}>+</button>
          <button class="kb-fit" data-act="kb-zoom-fit" ${prefs.zoom === 1 ? 'disabled' : ''}>Fit</button>
        </div>
        <button class="kb-chip" data-act="kb-wires" aria-pressed="${wires}" title="Show dependency wires">
          ${icon('link', 15)} Wires <span class="kb-chip-n">${st.edges}</span>
        </button>
      </div>

      <div class="kb-filters">
        <label class="kb-filter">
          <span class="sr-only">Filter by agent</span>
          <select class="input compact" id="kb-filter-agent">
            <option value="all">All agents</option>
            ${agents.map((a) => `<option value="${a.id}" ${prefs.filter.agent === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
          </select>
        </label>
        <label class="kb-filter">
          <span class="sr-only">Filter by priority</span>
          <select class="input compact" id="kb-filter-priority">
            <option value="all">All priorities</option>
            ${['high', 'med', 'low'].map((p) => `<option value="${p}" ${prefs.filter.priority === p ? 'selected' : ''}>${p === 'med' ? 'Medium' : p[0].toUpperCase() + p.slice(1)} priority</option>`).join('')}
          </select>
        </label>
        ${filtered ? `<button class="chip tiny" data-act="kb-filter-clear">Clear filter</button>` : ''}
      </div>

      <div class="kb-stats" id="kb-stats">${shown.length} of ${st.total} cards · ${st.blocked} waiting on a blocker · ${wires ? `${st.edges} wire${st.edges === 1 ? '' : 's'}` : 'wires hidden'}</div>

      <div class="kb-board" id="kb-board">
        <div class="kanban kb-viewport ${prefs.zoom === 1 ? '' : 'kb-nosnap'}" id="kb-viewport">
          <div class="kb-track" id="kb-track" style="--kb-zoom:${prefs.zoom}">
            ${COLS.map((c) => {
              const cards = shown.filter((t) => t.column === c.id);
              return `
                <div class="kanban-col" data-col="${c.id}" aria-label="${esc(c.label)} column, ${cards.length} cards">
                  <div class="col-head">
                    <div class="row" style="gap:6px"><span class="pulse-dot ${c.dot}"></span><strong class="small">${c.label}</strong></div>
                    <span class="chip tiny">${cards.length}</span>
                  </div>
                  <div class="kanban-cards" data-drop="${c.id}">
                    ${cards.map((t) => {
                      const blockers = (t.deps || []).map((d) => s.tasks.find((x) => x.id === d)).filter(Boolean);
                      const blocked = blockers.some((b) => b.column !== 'done');
                      return `
                      <div class="kcard ${blocked ? 'blocked' : ''}" data-task="${t.id}" data-act="open-task" data-id="${t.id}" role="button" tabindex="0">
                        <div class="t">${esc(t.title)}</div>
                        <div class="row between" style="margin-top:8px">
                          <div class="row" style="gap:6px">
                            ${avatar(getAgent(t.assignee)?.name || 'Unassigned', 'sm')}
                            <span class="chip tiny ${t.priority === 'high' ? 'bad' : t.priority === 'med' ? 'warn' : ''}">${t.priority}</span>
                          </div>
                          ${blockers.length ? `<span class="kb-deps" title="Depends on ${esc(blockers.map((b) => b.title).join(', '))}">⛓ ${blockers.length}${blocked ? ' · blocked' : ''}</span>` : ''}
                        </div>
                      </div>`;
                    }).join('')}
                    ${cards.length ? '' : '<div class="kb-empty">No cards here</div>'}
                  </div>
                </div>`;
            }).join('')}
          </div>
        </div>
        <svg class="kb-wires" id="kb-wires" aria-hidden="true" focusable="false"></svg>
      </div>

      <div class="banner info" style="margin-top:4px">${icon('board', 16)}<div>Every move asks first — cancel leaves the card where it was. Wires draw <strong>depends-on</strong> links; dimmed means the blocker is already done.</div></div>`;
  },
  mount() {
    const wireLayer = document.getElementById('kb-wires');
    if (wireLayer) wireLayer.style.display = wiresEnabled() ? '' : 'none';
    enableKanbanDrag();
    bindBoardFilters();
    observeBoard();
    requestAnimationFrame(drawWires);
  },
};

/** Measure the rendered cards and draw one curve per dependency edge. */
function drawWires() {
  const layer = document.getElementById('kb-wires');
  const viewport = document.getElementById('kb-viewport');
  if (!layer || !viewport) return;
  if (!wiresEnabled()) { layer.innerHTML = ''; layer.style.display = 'none'; return; }
  layer.style.display = '';

  const vp = viewport.getBoundingClientRect();
  layer.setAttribute('width', String(Math.max(1, Math.round(vp.width))));
  layer.setAttribute('height', String(Math.max(1, Math.round(vp.height))));
  layer.setAttribute('viewBox', `0 0 ${Math.max(1, Math.round(vp.width))} ${Math.max(1, Math.round(vp.height))}`);

  // Coordinates are viewport-relative, so scrolling is already accounted for by the rects.
  const cards = [...document.querySelectorAll('.kcard[data-task]')].map((el) => {
    const r = el.getBoundingClientRect();
    return {
      id: el.dataset.task,
      rect: { x: r.left - vp.left, y: r.top - vp.top, w: r.width, h: r.height },
      onScreen: r.right > vp.left && r.left < vp.right && r.bottom > vp.top && r.top < vp.bottom,
      done: getState().tasks.find((t) => t.id === el.dataset.task)?.column === 'done',
    };
  });
  const visible = cards.filter((c) => c.onScreen);
  const edges = dependencyEdges().filter((e) => visible.some((c) => c.id === e.from) && visible.some((c) => c.id === e.to));
  const { paths } = wirePaths(visible, edges);

  const defs = '<defs><marker id="kb-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="kb-wire-head" d="M0,0 L8,4 L0,8 z"></path></marker>'
    + '<marker id="kb-arrow-dim" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="kb-wire-head dim" d="M0,0 L8,4 L0,8 z"></path></marker></defs>';
  layer.innerHTML = defs + paths.map((p) => `<path class="kb-wire ${p.dim ? 'dim' : ''}" data-from="${p.from}" data-to="${p.to}" d="${p.d}" marker-end="url(#kb-arrow${p.dim ? '-dim' : ''})"></path>`).join('');
  layer.dataset.drawn = String(paths.length);
  const statEl = document.getElementById('kb-stats');
  if (statEl) {
    const st = boardStats();
    const shown = visibleTasks();
    statEl.textContent = `${shown.length} of ${st.total} cards · ${st.blocked} waiting on a blocker · ${paths.length} wire${paths.length === 1 ? '' : 's'} drawn`;
  }
}

let kbObserver = null;
let kbResizeBound = false;
function observeBoard() {
  if (kbObserver || typeof ResizeObserver === 'undefined') return;
  const board = document.getElementById('kb-board');
  if (!board) return;
  kbObserver = new ResizeObserver(() => requestAnimationFrame(drawWires));
  kbObserver.observe(board);
  const track = document.getElementById('kb-track');
  if (track) kbObserver.observe(track);
}

function bindBoardFilters() {
  const agentSel = document.getElementById('kb-filter-agent');
  const priSel = document.getElementById('kb-filter-priority');
  agentSel?.addEventListener('change', (e) => { setFilter({ agent: e.target.value }); });
  priSel?.addEventListener('change', (e) => { setFilter({ priority: e.target.value }); });
  const viewport = document.getElementById('kb-viewport');
  viewport?.addEventListener('scroll', () => requestAnimationFrame(drawWires), { passive: true });
  // One window listener for the life of the page: mount() runs on every re-render.
  if (!kbResizeBound) {
    kbResizeBound = true;
    window.addEventListener('resize', () => requestAnimationFrame(drawWires), { passive: true });
  }
}

function enableKanbanDrag() {
  const board = document.getElementById('kb-board');
  if (!board) return;
  let ghost = null, srcCard = null, taskCol = null;

  board.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, select, .kb-toolbar, .kb-chip')) return;
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
        ghost.style.width = `${card.getBoundingClientRect().width}px`;
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
        // The wires follow the lifted card's column so the board never draws to a stale position.
        drawWires();
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
        window.__dragging = false;
        window.__suppressClick = true;
        setTimeout(() => { window.__suppressClick = false; }, 350);
        drawWires();
        const taskId = card.dataset.task;
        if (under && under.dataset.col !== taskCol?.dataset.col) {
          // Same seam as the drawer chips and the Copilot: confirm, then commit.
          moveTask(taskId, under.dataset.col).then((out) => {
            if (out.cancelled) { toast('Move cancelled — the card stayed put'); return; }
            if (!out.ok) { toast(out.error, 'bad'); return; }
            toast(`Moved to ${columnLabel(out.task?.column || under.dataset.col)}`, 'ok');
            import('./main.js').then((m) => m.rerender());
          });
        }
      }
    };
    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', up);
  });
}

/* toolbar + drawer actions */
on('kb-zoom-in', () => kbScroll(() => zoomBy('in')));
on('kb-zoom-out', () => kbScroll(() => zoomBy('out')));
on('kb-zoom-fit', () => kbScroll(() => fitZoom()));
on('kb-wires', () => kbScroll(() => toggleWires()));
on('kb-filter-clear', () => kbScroll(() => clearFilter()));
on('kb-zoom-set', (el, ds) => kbScroll(() => setZoom(Number(ds.zoom))));

on('kb-unlink', (el, ds) => {
  const out = unlinkDeps(ds.id, ds.blocker);
  toast(out.ok ? 'Dependency removed' : out.error, out.ok ? 'ok' : 'bad');
  if (out.ok) { closeAllSheets(); taskSheet(ds.id); }
});

on('kb-delete', async (el, ds) => {
  const out = await deleteTask(ds.id);
  if (out.cancelled) return;
  if (!out.ok) { toast(out.error, 'bad'); return; }
  closeAllSheets();
  toast('Card deleted', 'ok');
  import('./main.js').then((m) => m.rerender());
});

export function taskSheet(id) {
  const s = getState();
  const t = s.tasks.find((x) => x.id === id);
  if (!t) return;
  const a = getAgent(t.assignee);
  const deps = (t.deps || []).map((d) => s.tasks.find((x) => x.id === d)).filter(Boolean);
  const candidates = s.tasks.filter((x) => x.id !== t.id && !(t.deps || []).includes(x.id));
  openSheet({
    title: esc(t.title),
    body: `
      <div class="row wrap" style="margin-bottom:10px">
        <span class="chip tiny">${esc(columnLabel(t.column))}</span>
        <span class="chip tiny ${t.priority === 'high' ? 'bad' : t.priority === 'med' ? 'warn' : ''}">${esc(t.priority)} priority</span>
        ${deps.length ? `<span class="chip tiny">⛓ ${deps.length} dependenc${deps.length === 1 ? 'y' : 'ies'}</span>` : ''}
      </div>
      <div class="small" style="margin-bottom:12px">${esc(t.desc)}</div>
      <div class="kv"><span class="k">Assignee</span><span class="row" style="gap:6px">${a ? avatar(a.name, 'sm') : ''}<span class="strong small">${esc(a?.name || 'Unassigned')}</span></span></div>
      <div class="field" style="margin-top:12px"><label>Move to</label>
        <div class="row wrap">
          ${COLS.map((c) => `<button class="chip ${t.column === c.id ? 'brand' : ''}" data-act="task-move" data-id="${t.id}" data-col="${c.id}" ${t.column === c.id ? 'aria-current="true"' : ''}>${c.label}</button>`).join('')}
        </div>
        <div class="tiny muted" style="margin-top:6px">Moving asks for confirmation first.</div>
      </div>
      <div class="field"><label for="task-assignee">Reassign</label>
        <select class="input" id="task-assignee">
          <option value="" ${t.assignee ? '' : 'selected'}>Unassigned</option>
          ${s.agents.map((ag) => `<option value="${ag.id}" ${ag.id === t.assignee ? 'selected' : ''}>${esc(ag.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label for="task-priority">Priority</label>
        <select class="input" id="task-priority">
          ${['high', 'med', 'low'].map((p) => `<option value="${p}" ${t.priority === p ? 'selected' : ''}>${p === 'med' ? 'Medium' : p[0].toUpperCase() + p.slice(1)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Depends on</label>
        ${deps.length
          ? `<div class="col" style="gap:6px;margin-bottom:8px">${deps.map((d) => `
              <div class="row between" style="gap:8px">
                <span class="small">${esc(d.title)} <span class="tiny muted">· ${esc(columnLabel(d.column))}</span></span>
                <button class="chip tiny" data-act="kb-unlink" data-id="${t.id}" data-blocker="${d.id}" aria-label="Remove dependency on ${esc(d.title)}">Remove</button>
              </div>`).join('')}</div>`
          : '<div class="tiny muted" style="margin-bottom:8px">No dependencies — this card can start any time.</div>'}
        ${candidates.length ? `
          <label class="tiny muted" for="task-blocker">Link a blocker</label>
          <select class="input" id="task-blocker">
            <option value="">Choose a card…</option>
            ${candidates.map((c) => `<option value="${c.id}">${esc(c.title)}</option>`).join('')}
          </select>` : ''}
      </div>`,
    foot: `<button class="btn grow" data-act="task-run" data-id="${t.id}">${icon('play', 14)} Run with agent</button>
           <button class="btn danger" data-act="kb-delete" data-id="${t.id}" aria-label="Delete card">Delete</button>`,
  });
  const sel = document.querySelector('.sheet.open #task-assignee');
  sel && sel.addEventListener('change', async (e) => {
    const out = await assignTask(id, e.target.value || 'unassigned');
    if (!out.ok) {
      e.target.value = t.assignee || '';
      toast(out.error, 'bad');
      return;
    }
    toast(out.assignee ? `Assigned to ${out.agent.name}` : 'Unassigned', 'ok');
    import('./main.js').then((m) => m.rerender());
  });

  const pri = document.querySelector('.sheet.open #task-priority');
  pri && pri.addEventListener('change', async (e) => {
    const out = await setPriority(id, e.target.value);
    if (!out.ok) { toast(out.error, 'bad'); return; }
    toast(`Priority set to ${out.priority}`, 'ok');
    import('./main.js').then((m) => m.rerender());
  });

  const blocker = document.querySelector('.sheet.open #task-blocker');
  blocker && blocker.addEventListener('change', (e) => {
    if (!e.target.value) return;
    const out = linkDeps(id, e.target.value);
    if (!out.ok) { toast(out.error, 'bad'); e.target.value = ''; return; }
    toast('Dependency linked', 'ok');
    closeAllSheets();
    taskSheet(id);
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
    if (isApiMode()) {
      if (permissionDenied('task:write')) {
        toast('Your role cannot create tasks on the gateway', 'bad');
        return;
      }
      const btn = sheet.querySelector('[data-act="task-create-go"]');
      if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
      createTask({
        title,
        desc: sheet.querySelector('#nt-desc').value.trim(),
        column: sheet.querySelector('#nt-col').value,
        priority: sheet.querySelector('#nt-pri').value,
        assignee: sheet.querySelector('#nt-agent').value,
      })
        .then((row) => {
          import('./shell.js').then((m) => m.closeAllSheets());
          toast(`Task “${row.title}” created on the gateway`, 'ok');
          import('./main.js').then((m) => m.navigate('tasks'));
        })
        .catch((err) => {
          if (btn) { btn.disabled = false; btn.textContent = 'Create task'; }
          toast(`Gateway refused: ${esc(err.message)}`, 'bad');
        });
      return;
    }
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

/* A plan's status is a record label, not process control: planned ⇄ cancelled, then archived. Nothing
 * here starts or stops a process, and the gateway refuses a status that would claim one. */
on('swarm-status', async (el, ds) => {
  const label = { cancelled: 'mark cancelled', planned: 're-open', archived: 'archive' }[ds.status] || ds.status;
  if (isApiMode()) {
    if (permissionDenied('swarm:write')) { toast('Your role cannot change swarm plans', 'bad'); return; }
    el?.setAttribute('disabled', 'disabled');
    try {
      await setSwarmPlanStatus(ds.id, ds.status);
      toast(`Plan ${label}d on the gateway — nothing was running`, 'ok');
      import('./main.js').then((m) => m.rerender());
    } catch (error) {
      toast(`Gateway refused: ${error.message}`, 'bad');
      el?.removeAttribute('disabled');
    }
    return;
  }
  setState((st) => {
    const w = st.swarms.find((x) => x.id === ds.id);
    if (w) { w.status = ds.status; w.updatedAt = now(); }
    logEvent('swarm', `Plan ${label}d (nothing was running)`);
  }, 'swarm-status');
  toast(`Plan ${label}d in this browser`, 'ok');
  import('./main.js').then((m) => m.rerender());
});

on('swarm-delete', (el, ds) => {
  const w = getState().swarms.find((x) => x.id === ds.id);
  confirmModal({
    title: 'Delete this plan?',
    body: `${esc(w?.name || 'This plan')} is a saved plan — nothing ever ran, so nothing is lost but the record.`,
    confirmText: 'Delete plan', danger: true,
    onConfirm: async () => {
      if (isApiMode()) {
        if (permissionDenied('swarm:write')) { toast('Your role cannot delete swarm plans', 'bad'); return; }
        try {
          await deleteSwarmPlan(ds.id);
          toast('Plan deleted on the gateway', 'ok');
          import('./main.js').then((m) => m.navigate('teams'));
        } catch (error) {
          toast(`Gateway refused: ${error.message}`, 'bad');
        }
        return;
      }
      setState((st) => { st.swarms = st.swarms.filter((x) => x.id !== ds.id); logEvent('swarm', 'Plan deleted'); }, 'swarm-delete');
      toast('Plan deleted in this browser', 'ok');
      import('./main.js').then((m) => m.navigate('teams'));
    },
  });
});
on('new-task', () => taskCreateSheet());

on('toggle-agent', async (el, ds) => {
  const a = getAgent(ds.id);
  if (!a) return;
  if (!isApiMode() || !isLive('agents')) {
    toast('Connect and sign in to a live MMM gateway before running agents. Demo mode cannot execute agents.', 'bad');
    return;
  }
  if (permissionDenied('agent:write')) { toast('Your role cannot run agents', 'bad'); return; }
  if (['queued','running'].includes(a.status)) { toast(`${a.name} already has an active run.`); return; }
  el?.setAttribute('disabled', 'disabled');
  try {
    const result = await runAgent(a.id, a.goal || a.role || `Work as ${a.name} and provide a useful result.`);
    toast(`${a.name}: run queued`, 'ok');
  } catch (err) {
    toast(`Run refused: ${esc(err.message)}`, 'bad');
  }
  import('./main.js').then((m) => m.rerender());
});

/* ---------- swipe commands ----------
 * Same authority checks as the buttons: a gesture can never do more than the screen would allow.
 */
async function setAgentState(id, status, source) {
  const a = getAgent(id);
  if (!a) return;
  if (status === 'paused') {
    toast('Run cancellation is not wired yet. This agent has not been stopped.', 'bad');
    return;
  }
  if (!isApiMode() || !isLive('agents')) {
    toast('Connect and sign in to a live MMM gateway before running agents.', 'bad');
    return;
  }
  if (permissionDenied('agent:write')) { toast('Your role cannot run agents', 'bad'); return; }
  if (['queued','running'].includes(a.status)) { toast(`${a.name} already has an active run.`); return; }
  try {
    await runAgent(id, a.goal || a.role || `Work as ${a.name} and provide a useful result.`);
    toast(`${a.name}: run queued · ${source}`, 'ok');
  } catch (err) {
    toast(`Run refused: ${esc(err.message)}`, 'bad');
  }
  import('./main.js').then((m) => m.rerender());
}

document.addEventListener('swipe-command', (event) => {
  const { action, id } = event.detail || {};
  const agent = id ? getAgent(id) : null;
  if (!agent) return;
  if (action === 'run') setAgentState(id, 'running', 'swiped left');
  else if (action === 'stop') setAgentState(id, 'paused', 'swiped right');
  else if (action === 'arm') deleteAgentWithConfirm(id);
});

/**
 * Deleting an agent is confirmed with the consequences that actually apply to this agent: which team
 * it leaves, what is kept (audit, experiments, history) and what stops working (task assignment).
 */
export function deleteAgentWithConfirm(id) {
  const a = getAgent(id);
  if (!a) return;
  if (isApiMode() && permissionDenied('agent:write')) {
    toast('Your role cannot delete agents. Nothing was changed.', 'bad');
    return;
  }
  const team = teamOf(a);
  const assignedTasks = (getState().tasks || []).filter((t) => t.assignee === a.id).length;
  const runs = Number(a.runs) || 0;
  confirmModal({
    title: `Delete ${esc(a.name)}?`,
    body: `<ul class="tiny" style="margin:0 0 8px 16px;padding:0">
        <li>The agent leaves the workspace${team ? ` and is unassigned from <strong>${esc(team.name)}</strong>` : ''}.</li>
        <li>The row is kept as a soft delete, so ${runs} recorded run${runs === 1 ? '' : 's'}, its audit trail and its self-improvement history stay readable.</li>
        <li>${assignedTasks ? `${assignedTasks} task${assignedTasks === 1 ? '' : 's'} currently assigned to it keep their text but lose the live assignee.` : 'No task is currently assigned to it.'}</li>
        <li>Its prompt, skills and capabilities are not copied anywhere else.</li>
      </ul>
      <span class="tiny muted">The team and every other agent are untouched.</span>`,
    confirmText: 'Delete agent', danger: true, requireText: 'DELETE',
    onConfirm: async () => {
      try {
        if (isApiMode()) {
          if (!isLive('agents')) throw new Error('The gateway is not serving agents right now');
          const result = await deleteAgent(id);
          toast(result?.summary || 'Agent deleted', 'ok');
        } else {
          setState((st) => {
            st.agents = st.agents.filter((x) => x.id !== id);
            st.tasks = (st.tasks || []).map((t) => (t.assignee === id ? { ...t, assignee: '' } : t));
            logEvent('agent', `Agent ${a.name} deleted`);
          }, 'del-agent');
          toast('Agent deleted', 'ok');
        }
        const { rerender, navigate } = await import('./main.js');
        if (currentView() === 'agents' && currentParams().id === id) navigate('agents');
        else rerender();
      } catch (error) {
        toast(`${error.message}. Nothing was changed.`, 'bad');
      }
    },
  });
}

function currentView() { return (location.hash.replace(/^#\/?/, '').split('/')[0] || 'home'); }
function currentParams() { const id = location.hash.replace(/^#\/?/, '').split('/')[1]; return id ? { id } : {}; }

on('delete-agent', (el, ds) => deleteAgentWithConfirm(ds.id));
on('agent-delete-x', (el, ds) => deleteAgentWithConfirm(ds.id));

on('agent-edit', (el, ds) => {
  agentEditId = ds.id;
  import('./main.js').then((m) => m.rerender());
});

on('agent-edit-cancel', () => {
  agentEditId = '';
  import('./main.js').then((m) => m.rerender());
});

on('agent-save', async (el, ds) => {
  const agent = getAgent(ds.id);
  if (!agent) return;
  const name = (document.getElementById(`ag-name-${ds.id}`)?.value || '').trim();
  const role = (document.getElementById(`ag-role-${ds.id}`)?.value || '').trim();
  const teamId = document.getElementById(`ag-team-${ds.id}`)?.value || '';
  if (!name) { toast('An agent needs a name. Nothing was changed.', 'bad'); return; }
  if (isApiMode() && permissionDenied('agent:write')) { toast('Your role cannot edit agents. Nothing was changed.', 'bad'); return; }
  el?.setAttribute('disabled', 'disabled');
  try {
    if (isApiMode() && isLive('agents')) {
      const patch = { name, role };
      if (teamId !== (agent.teamId || '')) patch.team_id = teamId || null;
      await updateAgent(ds.id, patch);
    } else {
      setState((s) => {
        const row = s.agents.find((a) => a.id === ds.id);
        if (!row) return;
        row.name = name;
        row.role = role;
        if ((row.teamId || '') !== teamId) {
          row.teamId = teamId || null;
          row.teamPosition = teamId ? s.agents.filter((a) => a.teamId === teamId && a.id !== ds.id).length + 1 : 0;
        }
        logEvent('agent', `Agent ${name} updated inline`);
      }, 'agent:inline-edit');
    }
    agentEditId = '';
    toast('Saved', 'ok');
    import('./main.js').then((m) => m.rerender());
  } catch (error) {
    // The card is re-rendered from state, which the failed write never touched.
    el?.removeAttribute('disabled');
    toast(`${error.message}. The card is unchanged.`, 'bad');
    import('./main.js').then((m) => m.rerender());
  }
});

/* ---- team management entry points ---- */
on('team-panel', (el, ds) => {
  const opts = { agentId: ds.id || '', teamId: ds.team || '' };
  openTeamPanel(opts);
});

on('teams-select', (el, ds) => {
  teamsSel = ds.id;
  teamsMenuFor = '';
  import('./main.js').then((m) => m.rerender());
});

on('teams-menu', (el, ds) => {
  teamsMenuFor = teamsMenuFor === ds.id ? '' : ds.id;
  import('./main.js').then((m) => m.rerender());
});

on('teams-view', (el, ds) => {
  teamsMenuFor = '';
  teamsSel = ds.id;
  openTeamPanel({ teamId: ds.id });
});

on('teams-edit', (el, ds) => {
  teamsMenuFor = '';
  teamsSel = ds.id;
  openTeamPanel({ teamId: ds.id, action: 'edit' });
});

on('teams-delete', (el, ds) => {
  teamsMenuFor = '';
  openTeamPanel({ teamId: ds.id, action: 'delete' });
});

on('team-new-agent', async (el, ds) => {
  const designer = await import('./designer.js');
  designer.suggestTeam({ id: ds.team, name: ds.name });
  const { navigate } = await import('./main.js');
  navigate('designer');
  toast(`Designer opened — ${esc(ds.name)} is a suggestion you can change`, 'ok');
});

on('clone-agent', async (el, ds) => {
  const a = getAgent(ds.id);
  if (!a) return;
  if (isLive('agents')) {
    if (permissionDenied('agent:write')) {
      toast('Your role cannot create agents on the gateway', 'bad');
      return;
    }
    el?.setAttribute('disabled', 'disabled');
    try {
      const row = await createAgent({
        name: `${a.name}-clone`.slice(0, 120),
        role: a.role,
        framework: a.framework,
        model: a.model,
        fallback: a.fallback,
        tools: a.tools,
        skills: a.skills,
        prompt: a.prompt,
      });
      toast(`Cloned as ${esc(row.name)} on the gateway`, 'ok');
    } catch (err) {
      toast(`Gateway refused: ${esc(err.message)}`, 'bad');
    }
    import('./main.js').then((m) => m.rerender());
    return;
  }
  setState((s) => {
    s.agents.unshift({ ...a, id: uid('ag'), name: `${a.name}-clone`, status: 'idle', runs: 0, costToday: 0, trust: 50, lastActive: now() });
    logEvent('agent', `Agent ${a.name} cloned`);
  }, 'clone-agent');
  toast('Agent cloned', 'ok');
  import('./main.js').then((m) => m.navigate('agents'));
});

on('task-move', async (el, ds) => {
  // Drawer chips, drag-and-drop and Copilot all land here (via kanban.moveTask) — same prompt,
  // same single log event, same gateway call.
  const out = await moveTask(ds.id, ds.col);
  if (out.cancelled) { toast('Move cancelled — nothing changed'); return; }
  if (!out.ok) { toast(out.error, 'bad'); return; }
  import('./shell.js').then((m) => m.closeAllSheets());
  toast(`Moved to ${columnLabel(out.task?.column || ds.col)}`, 'ok');
  import('./main.js').then((m) => m.rerender());
});

on('task-run', (el, ds) => {
  const t = getState().tasks.find((x) => x.id === ds.id);
  // Dispatching a task to an agent has no gateway runtime: refuse rather than fake a run.
  if (isLive('tasks')) {
    toast('No gateway run endpoint — a task cannot be dispatched from here yet. Nothing was changed.', 'bad');
    return;
  }
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

