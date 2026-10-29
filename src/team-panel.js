/* ============ Team management panel ============
 * One surface for "who is in which team, and what is this agent?" Opened from the agent panel, from
 * the Teams screen and from a team's ⋯ menu.
 *
 * Layout: a full-height sheet on a phone; from 900px up it docks to the right at 900px wide, because
 * a member list and an agent's instructions side by side is the only way the position slider and the
 * person it reorders make sense together.
 *
 * Honesty rules that this file keeps:
 *   • membership is read from `agent.teamId` — there is no second member list anywhere;
 *   • deleting a team unassigns its members and the confirmation says so before anything happens;
 *   • a suggestion is only a suggestion: it is applied when its own button is tapped, never on blur,
 *     never on typing, never because the panel re-rendered;
 *   • a write that fails leaves the value on screen exactly as the server still has it;
 *   • instructions are shown in full — the prompt is never clamped or truncated;
 *   • four shortcuts, and Chat is disabled unless the agent is running, with the reason stated.
 */
import {
  esc, icon, getState, getAgent, getTeam, teamMembers, teamOf, teamPosition, teamsWithCounts,
  setState, logEvent, uid, fmtTime,
} from './core.js';
import { isApiMode } from './api.js';
import { can, isAuthenticated } from './auth.js';
import { isLive, updateAgent, createTeam, updateTeam, deleteTeam, reorderTeam } from './datastore.js';
import { toast, confirmModal, on } from './shell.js';
import './team-panel.css';

const panel = {
  open: false,
  agentId: '',
  teamId: '',
  menuOpen: false,
  error: '',
  /* Drafted suggestion text, keyed `${agentId}:${index}`. Typing writes here only. */
  drafts: new Map(),
  /* Set after a successful instructions write on a running agent, so the panel can say what happens next. */
  appliedFrom: '',
};

const LIMITS = { name: 120, role: 160, description: 400, responsibility: 300 };

const canWriteAgents = () => !isApiMode() || (isAuthenticated() && can('agent:write'));
const canWriteTeams = () => !isApiMode() || (isAuthenticated() && can('swarm:write'));
const LIVE = () => isApiMode() && isLive('agents');

function fail(error) {
  const message = error?.message || String(error);
  const denied = error?.status === 403 || /permission|role lacks|forbidden/i.test(message);
  return denied ? `${message} — your role cannot write agents. Nothing was changed.` : `${message}. Nothing was changed.`;
}

/* ---------- reads (one source: the agent rows) ---------- */

const teamsNow = () => teamsWithCounts();
const unassigned = () => getState().agents.filter((a) => !a.teamId);
const agentById = (id) => getAgent(id) || null;
const positionLabel = (agent) => {
  const { position, total } = teamPosition(agent);
  return total ? `${position} of ${total}` : 'not in a team';
};

/** Tool families: `github.pr.create` → `github`. A family is what a person recognises, not a tool id. */
export function toolFamilies(agent) {
  const groups = new Map();
  for (const tool of agent?.tools || []) {
    const family = String(tool).split('.')[0] || String(tool);
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family).push(String(tool));
  }
  return [...groups.entries()].map(([family, tools]) => ({ family, tools, count: tools.length }));
}

/**
 * Responsibilities suggested from what the agent already is: its role words and its skills. These are
 * proposals, held in this panel, and only written when their own button is tapped.
 */
export function suggestResponsibilities(agent) {
  if (!agent) return [];
  const taken = new Set((agent.responsibilities || []).map((r) => String(r).toLowerCase()));
  const out = [];
  const push = (text) => {
    const clean = String(text).trim().slice(0, LIMITS.responsibility);
    if (!clean || taken.has(clean.toLowerCase())) return;
    taken.add(clean.toLowerCase());
    out.push(clean);
  };
  for (const skill of (agent.skills || []).slice(0, 3)) push(`Apply ${String(skill).replace(/[._]/g, ' ')} on every task`);
  const role = String(agent.role || '').toLowerCase();
  if (/research|source|citation/.test(role)) push('Cite a primary source for every claim');
  if (/cod(e|ing)|implement|full-stack/.test(role)) push('Leave a test that fails before the fix');
  if (/secur|pentest|red team/.test(role)) push('Stop at the first step that needs approval');
  if (/infra|incident|sre|ops/.test(role)) push('State blast radius before mitigating');
  if (/content|editorial|pipeline/.test(role)) push('Match house voice and name the reviewer');
  if (/data|analyst|cost/.test(role)) push('State what the data cannot support');
  if (!(agent.responsibilities || []).length) push('Report every failure exactly as it happened');
  return out.slice(0, 4);
}

/* ---------- markup: the team menu ---------- */

function menuHTML() {
  const teams = teamsNow();
  const loose = unassigned();
  const active = panel.teamId || '';
  const row = (id, name, count, note) => `
    <button class="tpm-team ${id === active ? 'on' : ''}" data-act="tpm-team" data-id="${esc(id)}"
      aria-current="${id === active ? 'true' : 'false'}">
      <span class="tpm-team-name">${esc(name)}</span>
      <span class="tpm-count" aria-label="${count} member${count === 1 ? '' : 's'}">${count}</span>
      ${note ? `<span class="tpm-team-note tiny muted">${esc(note)}</span>` : ''}
    </button>`;
  return `
    <aside class="tpm-menu" aria-label="Teams">
      <div class="tpm-menu-head">
        <h3>Teams</h3>
        <span class="tiny muted">${teams.length} team${teams.length === 1 ? '' : 's'} · ${getState().agents.length} agents</span>
      </div>
      <nav class="tpm-teams">
        ${teams.map((t) => row(t.id, t.name, t.memberCount, t.health === 'watch' ? 'needs attention' : '')).join('')}
        ${row('unassigned', 'No team', loose.length, 'read from the agent row')}
      </nav>
      <button class="btn block sm" data-act="tpm-new-team" ${canWriteTeams() ? '' : 'disabled'}>${icon('plus', 14)} New team</button>
      <p class="tiny muted tpm-menu-foot">A member count is counted from the agent rows, never stored twice.</p>
    </aside>`;
}

/* ---------- markup: the active team ---------- */

function teamPanelHTML() {
  if (panel.teamId === 'unassigned') {
    const loose = unassigned();
    return `
      <section class="tpm-active" aria-label="Unassigned agents">
        <div class="tpm-active-head">
          <div><h3>No team</h3><div class="tiny muted">${loose.length} agent${loose.length === 1 ? '' : 's'} without a team</div></div>
        </div>
        <p class="small muted">These agents exist outside every team. Put one in a team from its card, or from the Team assignment section on the right.</p>
        <ul class="tpm-members">${loose.map((a) => memberRow(a, false)).join('') || '<li class="tiny muted">Every agent belongs to a team.</li>'}</ul>
      </section>`;
  }
  const team = getTeam(panel.teamId) || teamsNow()[0];
  if (!team) {
    return `<section class="tpm-active"><div class="empty"><div class="e-ico">◇</div>
      <div>No teams yet. A team is a label on agent rows — create one and assign agents to it.</div></div></section>`;
  }
  const members = teamMembers(team.id);
  return `
    <section class="tpm-active" aria-label="Active team">
      <div class="tpm-active-head">
        <div class="grow">
          <h3>${esc(team.name)}</h3>
          <div class="tiny muted">${esc(team.topology)} · ${members.length} member${members.length === 1 ? '' : 's'} · ${esc(team.health)}</div>
        </div>
        <div class="tpm-menu-wrap">
          <button class="iconbtn" data-act="tpm-team-menu" aria-haspopup="menu" aria-expanded="${panel.menuOpen}"
            aria-label="Team actions for ${esc(team.name)}">${icon('more', 20)}</button>
          ${panel.menuOpen ? `
            <div class="tpm-menu-pop" role="menu">
              <button role="menuitem" data-act="tpm-team-view" data-id="${esc(team.id)}">${icon('eye', 15)} View team</button>
              <button role="menuitem" data-act="tpm-team-edit" data-id="${esc(team.id)}">${icon('gear', 15)} Edit team</button>
              <button role="menuitem" class="danger" data-act="tpm-team-delete" data-id="${esc(team.id)}">${icon('trash', 15)} Delete team</button>
            </div>` : ''}
        </div>
      </div>
      <p class="small muted">${esc(team.description || 'No description yet.')}</p>
      <ul class="tpm-members">
        ${members.map((a) => memberRow(a, true)).join('') || '<li class="small muted">No agents in this team yet.</li>'}
      </ul>
      ${canWriteAgents() ? `
        <div class="tpm-add-member">
          <label class="tiny muted" for="tpm-add-agent">Add an agent to ${esc(team.name)}</label>
          <div class="row" style="gap:8px">
            <select class="input" id="tpm-add-agent">
              <option value="">Choose an agent…</option>
              ${getState().agents.filter((a) => a.teamId !== team.id)
                .map((a) => `<option value="${esc(a.id)}">${esc(a.name)}${a.teamId ? ' · currently in another team' : ''}</option>`).join('')}
            </select>
            <button class="btn sm" data-act="tpm-add-member" data-team="${esc(team.id)}">Add</button>
          </div>
          <p class="tiny muted">Adding an agent that already has a team moves it. One team per agent — the row holds one value.</p>
        </div>` : ''}
      <button class="btn block primary tpm-fab" data-act="tpm-new-agent" data-team="${esc(team.id)}" data-name="${esc(team.name)}">
        ${icon('plus', 16)} New agent in ${esc(team.name)}
      </button>
      <p class="tiny muted">Opens the designer with ${esc(team.name)} as a visible, editable suggestion — nothing is created until you save there.</p>
    </section>`;
}

function memberRow(agent, withPosition) {
  const { position, total } = teamPosition(agent);
  return `
    <li class="tpm-member ${agent.id === panel.agentId ? 'on' : ''}">
      <button class="tpm-member-main" data-act="tpm-select-agent" data-id="${esc(agent.id)}">
        <span class="tpm-avatar" aria-hidden="true">${esc((agent.name || '?').slice(0, 1).toUpperCase())}</span>
        <span class="grow">
          <span class="strong small">${esc(agent.name)}</span>
          <span class="tiny muted block">${esc(agent.role || 'no role')}</span>
        </span>
        ${withPosition && total ? `<span class="chip tiny" aria-label="Position ${position} of ${total}">${position} of ${total}</span>` : ''}
        <span class="chip tiny ${agent.status === 'running' ? 'ok' : agent.status === 'error' ? 'bad' : ''}">${esc(agent.status)}</span>
      </button>
      ${canWriteAgents() ? `<button class="iconbtn" data-act="tpm-remove-member" data-id="${esc(agent.id)}"
        aria-label="Remove ${esc(agent.name)} from this team">${icon('x', 16)}</button>` : ''}
    </li>`;
}

/* ---------- markup: the agent panel ---------- */

function agentPanelHTML() {
  const agent = agentById(panel.agentId);
  if (!agent) {
    return `<section class="tpm-agent"><div class="empty"><div class="e-ico">◈</div>
      <div>Pick an agent on the left to see its identity, team position, responsibilities, instructions,
      capabilities, autonomy and status.</div></div></section>`;
  }
  const team = teamOf(agent);
  const { position, total } = teamPosition(agent);
  const families = toolFamilies(agent);
  const editable = canWriteAgents();
  const running = agent.status === 'running';
  const suggestions = suggestResponsibilities(agent);
  const prompt = String(agent.prompt || '');
  const promptLines = Math.min(24, Math.max(4, prompt.split('\n').length + 2));

  return `
    <section class="tpm-agent" aria-label="Agent ${esc(agent.name)}">
      <header class="tpm-identity">
        <span class="tpm-avatar lg" aria-hidden="true">${esc(agent.name.slice(0, 1).toUpperCase())}</span>
        <div class="grow">
          <h3>${esc(agent.name)}</h3>
          <div class="small muted">${esc(agent.role || 'No role recorded')}</div>
          <p class="small tpm-desc">${esc(agent.description || 'No description yet — say what this agent is for, in one sentence.')}</p>
        </div>
      </header>

      <details class="tpm-section" ${editable ? '' : ''}>
        <summary>Identity <span class="tiny muted">name, role, description</span></summary>
        <div class="tpm-form">
          <label class="tiny muted" for="tpm-name">Name</label>
          <input class="input" id="tpm-name" value="${esc(agent.name)}" maxlength="${LIMITS.name}" ${editable ? '' : 'disabled'}>
          <label class="tiny muted" for="tpm-role">Role</label>
          <input class="input" id="tpm-role" value="${esc(agent.role || '')}" maxlength="${LIMITS.role}" ${editable ? '' : 'disabled'}>
          <label class="tiny muted" for="tpm-description">Description</label>
          <textarea class="input" id="tpm-description" rows="3" maxlength="${LIMITS.description}" ${editable ? '' : 'disabled'}>${esc(agent.description || '')}</textarea>
          <div class="tpm-actions">
            <button class="btn sm primary" data-act="tpm-save-identity" data-id="${esc(agent.id)}" ${editable ? '' : 'disabled'}>Save identity</button>
          </div>
        </div>
      </details>

      <div class="tpm-section is-open">
        <div class="tpm-section-title">Team assignment</div>
        <div class="tpm-form">
          <label class="tiny muted" for="tpm-team-select">Team</label>
          <select class="input" id="tpm-team-select" data-id="${esc(agent.id)}" ${editable ? '' : 'disabled'}>
            <option value="">No team</option>
            ${teamsNow().map((t) => `<option value="${esc(t.id)}" ${t.id === agent.teamId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
          </select>
          <label class="tiny muted" for="tpm-position">Position: <span id="tpm-position-label">${positionLabel(agent)}</span></label>
          <input type="range" id="tpm-position" class="tpm-range" data-id="${esc(agent.id)}"
            min="1" max="${Math.max(1, total)}" step="1" value="${Math.max(1, position)}"
            aria-valuetext="${positionLabel(agent)}" ${editable && total ? '' : 'disabled'}>
          <p class="tiny muted">${total > 1
            ? `Moving the slider reorders this team. ${esc(agent.name)} is ${position} of ${total}.`
            : (total ? 'Alone in this team — position 1 of 1.' : 'Join a team to get a position.')}</p>
        </div>
      </div>

      <div class="tpm-section is-open">
        <div class="tpm-section-title">Responsibilities <span class="tiny muted">${(agent.responsibilities || []).length}</span></div>
        <ul class="tpm-resp">
          ${(agent.responsibilities || []).map((text, index) => `
            <li>
              <span class="grow small">${esc(text)}</span>
              ${editable ? `<button class="iconbtn" data-act="tpm-remove-resp" data-id="${esc(agent.id)}" data-index="${index}"
                aria-label="Remove responsibility: ${esc(text)}">${icon('x', 16)}</button>` : ''}
            </li>`).join('') || '<li class="small muted">No responsibilities recorded.</li>'}
        </ul>
        ${editable ? `
          <div class="tpm-form">
            <label class="tiny muted" for="tpm-resp-new">Add a responsibility</label>
            <div class="row" style="gap:8px">
              <input class="input" id="tpm-resp-new" maxlength="${LIMITS.responsibility}" placeholder="What must this agent always do?">
              <button class="btn sm" data-act="tpm-add-resp" data-id="${esc(agent.id)}">Add</button>
            </div>
          </div>` : ''}
        <div class="tpm-suggest">
          <div class="tpm-section-title">Suggested <span class="tiny muted">editable · applied only when you tap Add</span></div>
          ${suggestions.map((text, index) => `
            <div class="tpm-suggestion">
              <input class="input" data-suggest="${esc(agent.id)}:${index}" value="${esc(draftFor(agent.id, index, text))}"
                aria-label="Suggested responsibility ${index + 1}" maxlength="${LIMITS.responsibility}" ${editable ? '' : 'disabled'}>
              <button class="btn sm" data-act="tpm-apply-suggestion" data-id="${esc(agent.id)}" data-index="${index}"
                ${editable ? '' : 'disabled'}>Add</button>
            </div>`).join('') || '<p class="small muted">Nothing left to suggest from this role and its skills.</p>'}
        </div>
      </div>

      <div class="tpm-section is-open">
        <div class="tpm-section-title">Instructions
          ${running ? '<span class="chip tiny warn">running</span>' : ''}
          ${panel.appliedFrom === agent.id ? '<span class="chip tiny ok">saved · applies from the next message</span>' : ''}
        </div>
        ${running ? `<p class="tpm-note">${icon('bell', 15)} This agent is running. A prompt edit does not change the run in
          flight — <strong>it applies from the next message</strong>.</p>` : ''}
        <div class="tpm-form">
          <label class="tiny muted" for="tpm-goal">Goal</label>
          <input class="input" id="tpm-goal" value="${esc(agent.goal || '')}" maxlength="600" ${editable ? '' : 'disabled'}>
          <label class="tiny muted" for="tpm-prompt">System prompt <span class="tiny muted">shown in full, ${promptLines} lines</span></label>
          <textarea class="input tpm-prompt" id="tpm-prompt" rows="${promptLines}" ${editable ? '' : 'readonly'}>${esc(prompt)}</textarea>
          <p class="tiny muted">The prompt is never truncated here: you are reading every character the agent is given.</p>
          <div class="tpm-actions">
            <button class="btn sm primary" data-act="tpm-save-instructions" data-id="${esc(agent.id)}" ${editable ? '' : 'disabled'}>
              Save instructions
            </button>
          </div>
        </div>
      </div>

      <div class="tpm-section is-open">
        <div class="tpm-section-title">Capabilities</div>
        <div class="tpm-caps">
          ${families.map((f) => `<div class="tpm-cap">
            <span class="chip tiny brand">${esc(f.family)}</span>
            <span class="tiny muted">${f.count} tool${f.count === 1 ? '' : 's'}</span>
            <span class="tiny muted tpm-cap-tools">${esc(f.tools.join(' · '))}</span>
          </div>`).join('') || '<p class="small muted">No tools recorded.</p>'}
        </div>
        <div class="tpm-section-title" style="margin-top:10px">Skills</div>
        <div class="row wrap" style="gap:6px">
          ${(agent.skills || []).map((s) => `<span class="chip tiny ok">${icon('skill', 11)} ${esc(s)}</span>`).join('') || '<span class="small muted">No skills recorded.</span>'}
        </div>
      </div>

      <div class="tpm-section is-open">
        <div class="tpm-section-title">Autonomy</div>
        <div class="tpm-form">
          <label class="tiny muted" for="tpm-behaviour">Behaviour</label>
          <select class="input" id="tpm-behaviour" ${editable ? '' : 'disabled'}>
            ${['Ask before acting', 'Guided', 'Supervised', 'Guarded auto', 'Full auto']
              .map((label, level) => `<option value="${level}" ${Number(agent.autonomy) === level ? 'selected' : ''}>L${level} · ${label}</option>`).join('')}
          </select>
          <div class="tpm-gates">
            <span class="tiny muted">Approval gates</span>
            ${[['beforeToolCall', 'Before every tool call'], ['beforeDeploy', 'Before a deploy'], ['beforeSpend', 'Before spend above the cap']]
              .map(([key, label]) => `<label class="tpm-check">
                <input type="checkbox" data-gate="${key}" ${(agent.approvalGates || {})[key] ? 'checked' : ''} ${editable ? '' : 'disabled'}>
                <span class="small">${label}</span>
              </label>`).join('')}
          </div>
          <div class="tpm-actions">
            <button class="btn sm primary" data-act="tpm-save-autonomy" data-id="${esc(agent.id)}" ${editable ? '' : 'disabled'}>Save autonomy</button>
          </div>
          <p class="tpm-note warn">${icon('shield', 15)} <strong>Orchestration is not implemented.</strong> These values are recorded
            on the agent and enforced only where a gate exists (approvals, self-modification). Nothing schedules this agent,
            starts it on a trigger, or runs a behaviour preset — “Run” sets a status flag.</p>
        </div>
      </div>

      <div class="tpm-section is-open">
        <div class="tpm-section-title">Status</div>
        <div class="tpm-facts">
          <div><span class="tiny muted">Lifecycle</span><span class="chip tiny ${agent.status === 'running' ? 'ok' : agent.status === 'error' ? 'bad' : ''}">${esc(agent.status)}</span></div>
          <div><span class="tiny muted">Runs</span><span class="small">${Number(agent.runs) || 0}</span></div>
          <div><span class="tiny muted">Success</span><span class="small">${Math.round((Number(agent.successRate) || 0) * 100)}%</span></div>
          <div><span class="tiny muted">Last active</span><span class="small">${esc(fmtTime(agent.lastActive))}</span></div>
          <div><span class="tiny muted">Trust</span><span class="small">${Number(agent.trust) || 0}</span></div>
          <div><span class="tiny muted">Model</span><span class="small">${esc(agent.model)}</span></div>
        </div>
        <p class="tiny muted">Runs and success rate are the values on the agent row; nothing recomputes them yet.</p>
      </div>

      <div class="tpm-shortcuts">
        <button class="tpm-shortcut" data-act="tpm-shortcut-skills" data-id="${esc(agent.id)}">
          ${icon('skill', 18)}<span><strong>Skills</strong><small>Skills Hub, filtered to this agent</small></span>
        </button>
        <button class="tpm-shortcut" data-act="tpm-shortcut-tools" data-id="${esc(agent.id)}">
          ${icon('plug', 18)}<span><strong>Tools &amp; MCP</strong><small>Existing plugins screen</small></span>
        </button>
        <button class="tpm-shortcut" data-act="tpm-shortcut-chat" data-id="${esc(agent.id)}" ${running ? '' : 'disabled'}
          title="${running ? 'Open chat with this agent selected' : 'Chat needs a running agent — this one is ' + esc(agent.status)}">
          ${icon('chat', 18)}<span><strong>Chat</strong><small>${running ? 'Selects this agent' : `Disabled · agent is ${esc(agent.status)}`}</small></span>
        </button>
        <button class="tpm-shortcut" data-act="tpm-shortcut-self" data-id="${esc(agent.id)}">
          ${icon('spark', 18)}<span><strong>Self-Improvement</strong><small>Policy, experiments, rollback</small></span>
        </button>
      </div>
      ${team ? `<p class="tiny muted">In ${esc(team.name)} · position ${position} of ${total}.</p>` : '<p class="tiny muted">Not in a team.</p>'}
    </section>`;
}

function draftFor(agentId, index, fallback) {
  const key = `${agentId}:${index}`;
  return panel.drafts.has(key) ? panel.drafts.get(key) : fallback;
}

/* ---------- panel shell ---------- */

function root() {
  return document.getElementById('tpm-root');
}

function bodyHTML() {
  return `
    <div class="tpm-body">
      ${menuHTML()}
      <div class="tpm-main">
        ${teamPanelHTML()}
        ${agentPanelHTML()}
      </div>
    </div>`;
}

function paint() {
  const host = root();
  if (!host) return;
  const scroll = host.querySelector('.tpm-body');
  const keep = scroll ? scroll.scrollTop : 0;
  host.querySelector('.tpm-panel').innerHTML = headHTML() + bodyHTML();
  const next = host.querySelector('.tpm-body');
  if (next) next.scrollTop = keep;
  bindRange();
}

function headHTML() {
  return `
    <header class="tpm-head">
      <div class="grow">
        <h2 id="tpm-title">Team management</h2>
        <div class="tiny muted">Membership is one value on the agent row — every view reads it.</div>
      </div>
      <button class="iconbtn" data-act="tpm-close" aria-label="Close team management">${icon('x', 20)}</button>
    </header>`;
}

/** The position slider is a live label while dragging, a write when released. */
function bindRange() {
  const range = root()?.querySelector('#tpm-position');
  const label = root()?.querySelector('#tpm-position-label');
  if (!range || range.dataset.bound === '1') return;
  range.dataset.bound = '1';
  range.addEventListener('input', () => {
    const value = Number(range.value);
    const agent = agentById(panel.agentId);
    const total = teamPosition(agent).total;
    if (label) label.textContent = `${value} of ${total}`;
    range.setAttribute('aria-valuetext', `${value} of ${total}`);
  });
  range.addEventListener('change', async () => {
    const agent = agentById(panel.agentId);
    const team = teamOf(agent);
    if (!agent || !team) return;
    const value = Math.max(1, Number(range.value));
    const order = teamMembers(team.id).map((m) => m.id).filter((id) => id !== agent.id);
    order.splice(value - 1, 0, agent.id);
    await write(async () => {
      if (LIVE()) await reorderTeam(team.id, order);
      else {
        setState((s) => {
          order.forEach((id, index) => {
            const row = s.agents.find((x) => x.id === id);
            if (row) row.teamPosition = index + 1;
          });
          logEvent('team', `${agent.name} moved to position ${value} of ${order.length} in ${team.name}`);
        }, 'team:reorder');
      }
      toast(`${agent.name} is now ${value} of ${order.length} in ${esc(team.name)}`, 'ok');
    });
  });
}

async function write(fn) {
  try {
    await fn();
    rerenderPanel();
    return true;
  } catch (error) {
    toast(fail(error), 'bad');
    // The server is still the truth: re-read it rather than leaving a hopeful local value on screen.
    if (LIVE()) await import('./datastore.js').then((m) => m.refresh({ silent: true })).catch(() => {});
    rerenderPanel();
    return false;
  }
}

export function rerenderPanel() {
  if (panel.open) paint();
  else import('./main.js').then((m) => m.rerender()).catch(() => {});
}

export function openTeamPanel({ agentId = '', teamId = '', action = '' } = {}) {
  panel.open = true;
  panel.menuOpen = false;
  panel.appliedFrom = '';
  if (agentId) panel.agentId = agentId;
  if (teamId) panel.teamId = teamId;
  else if (!panel.teamId) panel.teamId = agentById(panel.agentId)?.teamId || teamsNow()[0]?.id || 'unassigned';
  if (!agentById(panel.agentId)) panel.agentId = teamMembers(panel.teamId)[0]?.id || '';

  let host = root();
  if (!host) {
    host = document.createElement('div');
    host.id = 'tpm-root';
    document.body.appendChild(host);
  }
  host.innerHTML = `<div class="tpm-scrim" data-act="tpm-close"></div>
    <div class="tpm-panel" role="dialog" aria-modal="true" aria-labelledby="tpm-title" tabindex="-1">
      ${headHTML()}${bodyHTML()}
    </div>`;
  bindRange();
  requestAnimationFrame(() => host.querySelector('.tpm-panel')?.focus());
  document.body.classList.add('tpm-open');
  // `⋯ → Edit` / `⋯ → Delete` from the Teams screen lands here, on the same code the panel uses.
  if (action === 'edit') beginEditTeam(panel.teamId);
  else if (action === 'delete') confirmDeleteTeam(panel.teamId);
  return host;
}

export function closeTeamPanel() {
  const host = root();
  if (host) host.remove();
  document.body.classList.remove('tpm-open');
  panel.open = false;
  panel.menuOpen = false;
}

export const teamPanelState = panel;

/* ---------- actions ---------- */

on('tpm-close', () => closeTeamPanel());

on('tpm-team', (el, ds) => {
  panel.teamId = ds.id;
  panel.menuOpen = false;
  const first = teamMembers(ds.id === 'unassigned' ? '' : ds.id)[0];
  panel.agentId = ds.id === 'unassigned' ? unassigned()[0]?.id || '' : first?.id || '';
  paint();
});

on('tpm-select-agent', (el, ds) => {
  panel.agentId = ds.id;
  const agent = agentById(ds.id);
  if (agent?.teamId) panel.teamId = agent.teamId;
  panel.appliedFrom = '';
  paint();
});

on('tpm-team-menu', () => { panel.menuOpen = !panel.menuOpen; paint(); });

on('tpm-team-view', (el, ds) => {
  panel.teamId = ds.id;
  panel.menuOpen = false;
  paint();
  root()?.querySelector('.tpm-main')?.scrollTo({ top: 0, behavior: 'smooth' });
});

on('tpm-team-edit', (el, ds) => beginEditTeam(ds.id));

export function beginEditTeam(teamId) {
  panel.menuOpen = false;
  panel.teamId = teamId || panel.teamId;
  const team = getTeam(panel.teamId);
  if (!team) return;
  paint();
  const main = root()?.querySelector('.tpm-active');
  if (!main) return;
  main.insertAdjacentHTML('afterbegin', `
    <div class="tpm-inline-edit" id="tpm-team-edit">
      <label class="tiny muted" for="tpm-team-name">Team name</label>
      <input class="input" id="tpm-team-name" value="${esc(team.name)}" maxlength="${LIMITS.name}">
      <label class="tiny muted" for="tpm-team-desc">Description</label>
      <textarea class="input" id="tpm-team-desc" rows="2" maxlength="${LIMITS.description}">${esc(team.description || '')}</textarea>
      <div class="tpm-actions">
        <button class="btn sm primary" data-act="tpm-save-team" data-id="${esc(team.id)}">Save team</button>
        <button class="btn sm" data-act="tpm-team-view" data-id="${esc(team.id)}">Cancel</button>
      </div>
    </div>`);
}

on('tpm-save-team', (el, ds) => write(async () => {
  const name = document.getElementById('tpm-team-name')?.value.trim() || '';
  const description = document.getElementById('tpm-team-desc')?.value ?? '';
  if (!name) throw new Error('a team needs a name');
  if (LIVE()) await updateTeam(ds.id, { name, description });
  else setState((s) => {
    const team = s.teams.find((t) => t.id === ds.id);
    if (team) { team.name = name; team.description = description; }
    logEvent('team', `Team ${name} renamed/edited`);
  }, 'team:update');
  toast(`Saved ${esc(name)}`, 'ok');
}));

on('tpm-team-delete', (el, ds) => confirmDeleteTeam(ds.id));

export function confirmDeleteTeam(teamId) {
  const team = getTeam(teamId);
  if (!team) return;
  const members = teamMembers(teamId);
  panel.menuOpen = false;
  confirmModal({
    title: `Delete ${esc(team.name)}?`,
    body: `<p>The team is removed. <strong>${members.length} agent${members.length === 1 ? '' : 's'} will be unassigned</strong>
      (<span class="code">teamId → null</span>), not deleted and not moved to another team.</p>
      ${members.length ? `<p class="tiny muted">Kept, without a team: ${members.map((m) => esc(m.name)).join(', ')}</p>` : ''}
      <p class="tiny muted">Their prompts, skills, history and audit records are untouched.</p>`,
    confirmText: 'Delete team',
    danger: true,
    requireText: 'DELETE',
    onConfirm: async () => {
      await write(async () => {
        if (LIVE()) {
          const result = await deleteTeam(teamId);
          toast(`${esc(result.name)} deleted · ${result.unassigned.length} agent(s) unassigned, none deleted`, 'ok');
        } else {
          setState((s) => {
            s.agents = s.agents.map((a) => (a.teamId === teamId ? { ...a, teamId: null, teamPosition: 0 } : a));
            s.teams = s.teams.filter((t) => t.id !== teamId);
            logEvent('team', `Team ${team.name} deleted — ${members.length} agent(s) unassigned, none deleted`);
          }, 'team:delete');
          toast(`${esc(team.name)} deleted · ${members.length} agent(s) unassigned, none deleted`, 'ok');
        }
        panel.teamId = teamsNow()[0]?.id || 'unassigned';
        panel.agentId = teamMembers(panel.teamId)[0]?.id || '';
      });
    },
  });
}

on('tpm-new-team', () => {
  const host = root()?.querySelector('.tpm-menu');
  if (!host || root()?.querySelector('#tpm-new-team')) return;
  host.insertAdjacentHTML('beforeend', `
    <div class="tpm-inline-edit" id="tpm-new-team">
      <label class="tiny muted" for="tpm-new-team-name">New team name</label>
      <input class="input" id="tpm-new-team-name" maxlength="${LIMITS.name}" placeholder="e.g. Growth Cell">
      <div class="tpm-actions">
        <button class="btn sm primary" data-act="tpm-create-team">Create team</button>
        <button class="btn sm" data-act="tpm-team-menu">Cancel</button>
      </div>
    </div>`);
});

on('tpm-create-team', () => write(async () => {
  const name = document.getElementById('tpm-new-team-name')?.value.trim() || '';
  if (!name) throw new Error('a team needs a name');
  if (LIVE()) {
    const team = await createTeam({ name });
    panel.teamId = team.id;
  } else {
    const id = uid('tm');
    setState((s) => { s.teams.push({ id, name, topology: 'Hierarchical', health: 'good', description: '' }); logEvent('team', `Team ${name} created`); }, 'team:create');
    panel.teamId = id;
  }
  panel.menuOpen = false;
  toast(`Team ${esc(name)} created`, 'ok');
}));

on('tpm-add-member', (el, ds) => write(async () => {
  const agentId = document.getElementById('tpm-add-agent')?.value || '';
  if (!agentId) throw new Error('choose an agent first');
  if (LIVE()) await updateAgent(agentId, { team_id: ds.team, team_position: null });
  else setState((s) => {
    const agent = s.agents.find((a) => a.id === agentId);
    if (!agent) return;
    const size = s.agents.filter((a) => a.teamId === ds.team).length;
    agent.teamId = ds.team;
    agent.teamPosition = size + 1;
    logEvent('team', `${agent.name} added to a team`);
  }, 'team:add');
  panel.agentId = agentId;
  toast('Agent added to the team', 'ok');
}));

on('tpm-remove-member', (el, ds) => write(async () => {
  const agent = agentById(ds.id);
  if (!agent) throw new Error('agent not found');
  if (LIVE()) await updateAgent(ds.id, { team_id: null });
  else setState((s) => {
    const row = s.agents.find((a) => a.id === ds.id);
    if (row) { row.teamId = null; row.teamPosition = 0; }
    logEvent('team', `${agent.name} removed from its team (unassigned)`);
  }, 'team:remove');
  toast(`${esc(agent.name)} unassigned — the agent still exists`, 'ok');
}));

on('tpm-new-agent', async (el, ds) => {
  /* Carries the team into the designer as a visible, editable suggestion. Nothing is created here. */
  const designer = await import('./designer.js');
  designer.suggestTeam({ id: ds.team, name: ds.name });
  closeTeamPanel();
  const { navigate } = await import('./main.js');
  navigate('designer');
  toast(`Designer opened — ${esc(ds.name)} is a suggestion you can change`, 'ok');
});

/* ---- agent writes ---- */

on('tpm-save-identity', (el, ds) => write(async () => {
  const name = document.getElementById('tpm-name')?.value.trim() || '';
  const role = document.getElementById('tpm-role')?.value.trim() || '';
  const description = document.getElementById('tpm-description')?.value ?? '';
  if (!name) throw new Error('an agent needs a name');
  if (LIVE()) await updateAgent(ds.id, { name: name.slice(0, LIMITS.name), role: role.slice(0, LIMITS.role), description: description.slice(0, LIMITS.description) });
  else setState((s) => {
    const agent = s.agents.find((a) => a.id === ds.id);
    if (agent) { agent.name = name; agent.role = role; agent.description = description; }
    logEvent('agent', `Agent ${name} identity updated`);
  }, 'agent:identity');
  toast('Identity saved', 'ok');
}));

on('tpm-save-instructions', (el, ds) => write(async () => {
  const agent = agentById(ds.id);
  const goal = document.getElementById('tpm-goal')?.value ?? '';
  const prompt = document.getElementById('tpm-prompt')?.value ?? '';
  if (!prompt.trim()) throw new Error('the prompt cannot be empty');
  if (LIVE()) await updateAgent(ds.id, { goal: goal.slice(0, 600), prompt });
  else setState((s) => {
    const row = s.agents.find((a) => a.id === ds.id);
    if (row) { row.goal = goal; row.prompt = prompt; }
    logEvent('agent', `Instructions updated for ${agent?.name || ds.id}`);
  }, 'agent:instructions');
  panel.appliedFrom = ds.id;
  toast(agent?.status === 'running'
    ? 'Saved — this agent is running, so the new prompt applies from the next message'
    : 'Instructions saved', 'ok');
}));

on('tpm-save-autonomy', (el, ds) => write(async () => {
  const behaviour = Number(document.getElementById('tpm-behaviour')?.value || 0);
  const gates = {};
  for (const key of ['beforeToolCall', 'beforeDeploy', 'beforeSpend']) {
    gates[key] = Boolean(root()?.querySelector(`[data-gate="${key}"]`)?.checked);
  }
  if (LIVE()) await updateAgent(ds.id, { autonomy: behaviour, approval_gates: gates });
  else setState((s) => {
    const row = s.agents.find((a) => a.id === ds.id);
    if (row) { row.autonomy = behaviour; row.approvalGates = gates; }
    logEvent('agent', `Autonomy for ${agentById(ds.id)?.name} set to L${behaviour}`);
  }, 'agent:autonomy');
  toast(`Autonomy saved: L${behaviour}. Orchestration is still not implemented.`, 'ok');
}));

on('tpm-add-resp', (el, ds) => write(async () => {
  const input = document.getElementById('tpm-resp-new');
  const text = String(input?.value || '').trim().slice(0, LIMITS.responsibility);
  if (!text) throw new Error('write the responsibility first');
  await saveResponsibilities(ds.id, (list) => [...list, text]);
  toast('Responsibility added', 'ok');
}));

on('tpm-remove-resp', (el, ds) => write(async () => {
  const index = Number(ds.index);
  await saveResponsibilities(ds.id, (list) => list.filter((_, i) => i !== index));
  toast('Responsibility removed', 'ok');
}));

on('tpm-apply-suggestion', (el, ds) => write(async () => {
  const input = root()?.querySelector(`[data-suggest="${ds.id}:${ds.index}"]`);
  const text = String(input?.value || '').trim().slice(0, LIMITS.responsibility);
  if (!text) throw new Error('that suggestion is empty');
  await saveResponsibilities(ds.id, (list) => (list.includes(text) ? list : [...list, text]));
  panel.drafts.delete(`${ds.id}:${ds.index}`);
  toast('Suggestion applied', 'ok');
}));

async function saveResponsibilities(agentId, mutate) {
  const agent = agentById(agentId);
  const next = mutate([...(agent?.responsibilities || [])]).slice(0, 40);
  if (LIVE()) await updateAgent(agentId, { responsibilities: next });
  else setState((s) => {
    const row = s.agents.find((a) => a.id === agentId);
    if (row) row.responsibilities = next;
  }, 'agent:resp');
}

/* Drafts are kept while the panel is open, so a re-render (a poll, a live update) never throws away
 * text the reader typed into a suggestion. Nothing is written until the Add button is tapped. */
document.addEventListener('input', (event) => {
  const input = event.target?.closest?.('[data-suggest]');
  if (!input || !panel.open) return;
  panel.drafts.set(input.dataset.suggest, input.value);
});

/* The two selects apply on change: they are explicit choices, not drafts. */
document.addEventListener('change', async (event) => {
  if (!panel.open) return;
  const select = event.target?.closest?.('#tpm-team-select');
  if (!select) return;
  const agentId = select.dataset.id;
  const teamId = select.value || null;
  await write(async () => {
    if (LIVE()) await updateAgent(agentId, { team_id: teamId });
    else setState((s) => {
      const agent = s.agents.find((a) => a.id === agentId);
      if (!agent) return;
      agent.teamId = teamId;
      agent.teamPosition = teamId ? s.agents.filter((a) => a.teamId === teamId).length + 1 : 0;
      logEvent('team', `${agent.name} ${teamId ? 'assigned to a team' : 'unassigned'}`);
    }, 'agent:team');
    if (teamId) panel.teamId = teamId;
    toast(teamId ? 'Team updated' : 'Agent unassigned from its team', 'ok');
  });
});

/* ---- shortcuts ---- */

on('tpm-shortcut-skills', async (el, ds) => {
  const agent = agentById(ds.id);
  const { openSkillsForAgent } = await import('./views2.js');
  closeTeamPanel();
  openSkillsForAgent(ds.id);
  toast(`Skills Hub filtered to ${esc(agent?.name || 'this agent')}`, 'ok');
});

on('tpm-shortcut-tools', async () => {
  closeTeamPanel();
  const { navigate } = await import('./main.js');
  navigate('plugins');
});

on('tpm-shortcut-chat', async (el, ds) => {
  const agent = agentById(ds.id);
  if (agent?.status !== 'running') { toast('Chat needs a running agent', 'bad'); return; }
  closeTeamPanel();
  const chat = await import('./views2.js');
  chat.selectChatAgent(ds.id);
  const { navigate } = await import('./main.js');
  navigate('chat');
});

on('tpm-shortcut-self', async (el, ds) => {
  closeTeamPanel();
  const { navigate } = await import('./main.js');
  navigate(`evolution/${ds.id}`);
});

/* Keyboard escape closes the panel — it is a modal surface. */
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && panel.open) closeTeamPanel();
});

export const teamPanelInternals = { panel, paint, bodyHTML, agentPanelHTML, teamPanelHTML, menuHTML };
