/* ============ Copilot orchestrator ============
 * Deterministic intent handling over live app state + the grounded knowledge pack.
 * No model is called (see capabilities.llm), so nothing here may imply generative reasoning.
 *
 * Contract with the panel:
 *   handle(text, ctx) -> { text, card?, episode? }
 *   card = { type: 'answer'|'proposal'|'result'|'knowledge'|'diagnostic'|'capability'|'activity', ... }
 *   runProposal(card, ctx) -> assistant message (and records episodic evidence)
 */
import { getState, setState, logEvent, now, uid, pendingApprovals } from '../core.js';
import { api, ApiError, isApiMode } from '../api.js';
import { getAuth, isAuthenticated, can as canDo, role as currentRole } from '../auth.js';
import { searchKnowledge, knowledgeStats, describeScreen, getEntry } from './knowledge.js';
import { pushEpisode, listEpisodes, memorySummary, clearMemory, getPreferences } from './memory.js';
import { getRuntime, probeGateway } from './runtime.js';
import { getCapability, STATUS_LABEL } from './capabilities.js';
import { inspectJsonl } from './jsonlInspection.js';
import { scheduleRefresh, isLive, getStatus } from '../datastore.js';

/* ---------- modes ---------- */
export const MODES = [
  { id: 'ask', label: 'Ask', icon: 'chat', hint: 'Explain the app, this screen, settings and behaviour' },
  { id: 'operate', label: 'Operate', icon: 'spark', hint: 'Propose and run app actions into your confirmation' },
  { id: 'build', label: 'Build', icon: 'robot', hint: 'Inspect agents, teams and prompts; propose new definitions' },
  { id: 'knowledge', label: 'Knowledge', icon: 'doc', hint: 'Search the versioned, source-linked knowledge pack' },
  { id: 'training', label: 'Training', icon: 'cpu', hint: 'Dataset checks — the training backend is not available' },
  { id: 'voice', label: 'Voice', icon: 'mic', hint: 'Device speech works; cloning and Qwen2.5-Omni are blocked' },
  { id: 'activity', label: 'Activity', icon: 'chart', hint: 'Recent Copilot actions, events and approvals' },
];

const ALIASES = { act: 'operate', analyze: 'activity', analysis: 'activity', explain: 'ask', search: 'knowledge', kb: 'knowledge' };

export function resolveMode(id) {
  const key = String(id || '').toLowerCase();
  if (MODES.some((m) => m.id === key)) return key;
  if (ALIASES[key]) return ALIASES[key];
  return getPreferences().defaultMode || 'ask';
}

export const modeMeta = (id) => MODES.find((m) => m.id === resolveMode(id)) || MODES[0];

/* ---------- helpers ---------- */
const REF_STATE = (label) => ({ label, ref: 'browser demo store (observed)', status: 'observed' });

/** True when a gateway session is live and the caller may act through the API. */
export const apiReady = () => isApiMode() && isAuthenticated();

const apiRef = (label, ref = 'gateway /api/v1') => ({ label, ref, status: 'verified' });

/**
 * Prefer the gateway when it is connected: it is the authoritative store. Falls back to the
 * local demo mirror and says so, rather than silently mixing the two.
 */
async function liveData() {
  if (!apiReady()) {
    return { source: 'local', reason: isApiMode() ? 'not signed in to the gateway' : 'no gateway configured' };
  }
  try {
    const [summary, agents, tasks, approvals] = await Promise.all([
      api.summary(), api.agents(), api.tasks(), api.approvals(),
    ]);
    return {
      source: 'gateway',
      summary: summary.body,
      agents: agents.body,
      tasks: tasks.body.map((t) => ({ ...t, column: t.column_name || t.column })),
      approvals: approvals.body,
    };
  } catch (err) {
    return { source: 'local', reason: `gateway error: ${err?.message || err}` };
  }
}

const sourceLine = (data) =>
  data.source === 'gateway'
    ? 'Source: gateway (authoritative, RBAC-checked).'
    : `Source: local demo store — ${data.reason}.`;

function refsFrom(results) {
  const out = [];
  results.forEach((r) => r.sources.forEach((s) => out.push({ ...s, status: r.status })));
  return out.slice(0, 6);
}

const answer = (text, { refs = [], confidence = 'verified', title = 'Answer', capability = null } = {}) => ({
  type: 'answer',
  title,
  text,
  refs,
  confidence,
  capability,
});

const una = (text, extra = {}) => answer(text, { confidence: 'unknown', title: 'Not enough evidence', ...extra });

function knowledgeCard(query, results, kstats = knowledgeStats()) {
  return {
    type: 'knowledge',
    query,
    results,
    stats: kstats,
    text:
      results.length
        ? `Found ${results.length} knowledge entr${results.length === 1 ? 'y' : 'ies'} for “${query}”. Each result carries its verification status, version and source files.`
        : `No knowledge entry matches “${query}”. I will not invent one — try different terms, or open Knowledge mode to browse the pack (${kstats.total} entries).`,
  };
}

/* ---------- deterministic app-state answers (observed) ---------- */
async function liveStatusAnswer() {
  const rt = getRuntime();
  const data = await liveData();
  const auth = getAuth();
  if (data.source === 'gateway') {
    const sum = data.summary || {};
    return answer(
      [
        `Agents: ${sum.running ?? '?'} running / ${sum.agents ?? '?'} total.`,
        `Swarm plans: ${sum.swarms ?? 0} saved · ${sum.swarmsExecuted ?? 0} ever executed · Teams: ${sum.teams ?? '?'}.`,
        `Tasks: ${sum.tasks ?? '?'} · Approvals pending: ${sum.approvalsPending ?? '?'}.`,
        `Principals active: ${sum.principals ?? '?'}.`,
        `Signed in as ${auth.principal?.name} (${auth.principal?.role}) via ${auth.principal?.via}.`,
        `Gateway ${rt.gateway.url} · ${rt.gateway.detail}.`,
      ].join('\n'),
      {
        title: 'Live status (gateway)',
        confidence: 'observed',
        refs: [apiRef('GET /api/v1/summary')],
      }
    );
  }
  const s = getState();
  const pend = pendingApprovals().length;
  const running = s.agents.filter((a) => a.status === 'running').length;
  const spend = s.agents.reduce((a, x) => a + (x.costToday || 0), 0);
  return answer(
    [
      `Agents: ${running} running / ${s.agents.length} total (seeded demo state).`,
      `Swarms: ${s.swarms.filter((w) => w.status === 'live').length} live of ${s.swarms.length}.`,
      `Approvals: ${pend} pending.`,
      `Spend today: $${spend.toFixed(2)} — demo figures, not metered usage.`,
      `Gateway: ${rt.gateway.status} (${rt.gateway.detail}) at ${rt.gateway.url}. ${sourceLine(data)}`,
    ].join('\n'),
    {
      title: 'Live status (demo store)',
      confidence: 'observed',
      refs: [REF_STATE('agents/swarms/approvals'), { label: 'src/core.js — store', ref: 'src/core.js', status: 'verified' }],
    }
  );
}

function agentListAnswer(agents = null, data = null) {
  const list = agents || getState().agents;
  if (!list.length) return una('No agents exist in this store yet. Operate mode can propose one.');
  return answer(
    list.map((a) => `${a.name} — ${a.framework} · ${a.model} · trust ${a.trust} · status ${a.status}`).join('\n') +
      (data ? `\n\n${sourceLine(data)}` : ''),
    {
      title: `Agents (${list.length})`,
      confidence: 'observed',
      refs: data?.source === 'gateway' ? [apiRef('GET /api/v1/agents')] : [REF_STATE('agent list'), { label: 'src/core.js — agents', ref: 'src/core.js', status: 'verified' }],
    }
  );
}

function swarmListAnswer() {
  const s = getState();
  if (!s.swarms.length) return una('No swarm instances exist yet.');
  return answer(
    s.swarms
      .map((w) => `${w.name} — ${w.status} · ${Math.round((w.progress || 0) * 100)}% · budget cap $${w.budget?.cap ?? 0} · not executed`)
      .join('\n') + '\n\nThese are plans. Nothing in this repo schedules or executes a swarm, and the gateway does not persist one.',
    { title: 'Swarm instances', confidence: 'observed', refs: [REF_STATE('swarm list'), { label: 'src/views1.js — swarm records', ref: 'src/views1.js', status: 'verified' }] }
  );
}

function taskListAnswer(tasks = null, data = null) {
  const list = tasks || getState().tasks;
  const open = list.filter((t) => (t.column || t.column_name) !== 'done');
  if (!open.length) return answer('Every Kanban card is in Done.', { confidence: 'observed', title: 'Tasks' });
  return answer(
    open.slice(0, 12).map((t) => `[${t.column || t.column_name}] ${t.title} → ${t.assignee || 'unassigned'}`).join('\n') +
      (data ? `\n\n${sourceLine(data)}` : ''),
    {
      title: `Open tasks (${open.length})`,
      confidence: 'observed',
      refs: data?.source === 'gateway' ? [apiRef('GET /api/v1/tasks')] : [REF_STATE('kanban')],
    }
  );
}

function approvalsAnswer(approvals = null, data = null) {
  const list = (approvals || getState().approvals).filter((a) => a.status === 'pending');
  if (!list.length) return answer('No approval gates are pending.', { confidence: 'observed', title: 'Approvals' });
  const role = currentRole();
  const canDecide = canDo('approval:decide');
  return answer(
    list.map((a) => `${a.id} — ${a.action} on ${a.target} · risk ${a.risk} · requested by ${a.principal}`).join('\n') +
      (data?.source === 'gateway'
        ? `\n\nDecisions are enforced by the gateway: ${canDecide ? `your role (${role}) may decide gates, subject to separation of duties.` : `your role (${role}) may not decide gates — ask a Reviewer or Admin.`}`
        : '\n\nDemo store: the gateway is not connected, so nothing here is enforced.'),
    {
      title: `${list.length} pending approval(s)`,
      confidence: 'observed',
      refs: data?.source === 'gateway'
        ? [apiRef('GET /api/v1/approvals'), { label: 'apps/gateway/src/rbac.js — canDecideApproval', ref: 'apps/gateway/src/rbac.js', status: 'verified' }]
        : [REF_STATE('approval gates'), { label: 'docs/copilot/PHASE0_DISCOVERY.md — enforcement', ref: 'docs/copilot/PHASE0_DISCOVERY.md', status: 'verified' }],
    }
  );
}

function spendAnswer() {
  const s = getState();
  const total = s.agents.reduce((a, x) => a + (x.costToday || 0), 0);
  const top = [...s.agents].sort((a, b) => (b.costToday || 0) - (a.costToday || 0))[0];
  return answer(
    `Spend today $${total.toFixed(2)} across ${s.agents.length} agents. Top spender: ${top ? `${top.name} ($${(top.costToday || 0).toFixed(2)})` : 'none'}. These are seeded figures — the model gateway does not make real calls, so nothing is metered.`,
    { title: 'Spend (demo)', confidence: 'observed', refs: [REF_STATE('agent cost fields'), { label: 'docs/PROGRESS.md — Phase 6 model gateway ⬜', ref: 'docs/PROGRESS.md', status: 'verified' }] }
  );
}

/* ---------- diagnostics ---------- */
export async function runDiagnostics() {
  const s = getState();
  const rt = getRuntime();
  const checks = [];
  checks.push({
    label: 'Browser connectivity',
    status: rt.online ? 'ok' : 'warn',
    detail: rt.online ? 'navigator.onLine is true' : 'offline — cached or in-memory data may be stale',
  });
  let raw = null;
  try {
    raw = globalThis.localStorage?.getItem('mmm-state-v1') || null;
  } catch {
    raw = null;
  }
  checks.push({
    label: 'App store',
    status: raw ? 'ok' : 'warn',
    detail: raw
      ? `mmm-state-v1 present · ${(raw.length / 1024).toFixed(1)} KB · rev ${s.rev}`
      : 'no persisted store yet — seeded fixtures are in memory',
  });
  checks.push({
    label: 'Pending approvals',
    status: pendingApprovals().length ? 'warn' : 'ok',
    detail: `${pendingApprovals().length} waiting on a human decision`,
  });
  let sw = 'unknown';
  try {
    const worker = globalThis.navigator?.serviceWorker;
    sw = worker?.getRegistration ? ((await worker.getRegistration()) ? 'registered' : 'not registered') : 'registration not verified';
  } catch {
    sw = 'unknown';
  }
  checks.push({ label: 'Service worker', status: sw === 'registered' ? 'ok' : 'info', detail: sw });

  const gw = await probeGateway();
  checks.push({
    label: 'Gateway /healthz',
    status: gw.status === 'reachable' ? 'ok' : 'warn',
    detail: `${gw.status} · ${gw.detail} · ${gw.url}`,
  });

  const failed = checks.filter((c) => c.status === 'warn').length;
  return {
    type: 'diagnostic',
    checks,
    verdict:
      `${failed === 0 ? 'No warnings in these limited checks.' : `${failed} check(s) need attention.`} ` +
      `Data sync: ${getStatus().status}. Health alone does not prove authorisation, execution or fresh data.`,
    refs: [{ label: 'src/copilot/runtime.js', ref: 'src/copilot/runtime.js', status: 'verified' }],
  };
}

/* ---------- dataset inspection (real, limited) ---------- */
export function inspectDataset({ pathPrefix = '' } = {}) {
  const files = getState().files || [];
  const scoped = pathPrefix ? files.filter((f) => f.path.startsWith(pathPrefix)) : files;
  if (!scoped.length) {
    return {
      type: 'diagnostic',
      checks: [{ label: 'Files found', status: 'warn', detail: 'no artifacts match this selection' }],
      verdict: 'Nothing to inspect. Pick a folder or add artifacts in the File Manager.',
    };
  }
  const byType = scoped.reduce((acc, f) => {
    const ext = (f.path.split('.').pop() || 'unknown').toLowerCase();
    acc[ext] = (acc[ext] || 0) + 1;
    return acc;
  }, {});
  const total = scoped.reduce((a, f) => a + (f.size || 0), 0);
  const paths = new Set();
  const dupes = scoped.filter((f) => (paths.has(f.path) ? true : (paths.add(f.path), false)));
  const empty = scoped.filter((f) => !f.size);
  const audio = scoped.filter((f) => /\.(mp3|wav|flac|m4a|ogg|opus)$/i.test(f.path));
  const images = scoped.filter((f) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.path));

  const checks = [
    { label: 'Files', status: 'ok', detail: `${scoped.length} entries · ${(total / 1024).toFixed(1)} KB total` },
    { label: 'Types', status: 'ok', detail: Object.entries(byType).map(([k, v]) => `${k}×${v}`).join(' · ') },
    { label: 'Empty files', status: empty.length ? 'warn' : 'ok', detail: empty.length ? empty.map((f) => f.path).join(', ') : 'none detected' },
    { label: 'Duplicate paths', status: dupes.length ? 'warn' : 'ok', detail: dupes.length ? `${dupes.length} repeated path(s)` : 'none detected' },
  ];
  const jsonl = scoped.filter((f) => /\.jsonl$/i.test(f.path));
  if (jsonl.length) {
    const results = jsonl.slice(0, 10).map((f) => inspectJsonl(f.content));
    const failed = results.filter((r) => !r.ok).length;
    checks.push({ label: 'Inline JSONL syntax', status: failed || jsonl.length > results.length ? 'warn' : 'ok',
      detail: `${results.length} of ${jsonl.length} file(s) inspected; ${failed} invalid, unavailable or over limit. Object syntax only; schema, content and training safety are not verified.` });
  }
  if (audio.length) {
    checks.push({
      label: 'Audio validity',
      status: 'info',
      detail: `${audio.length} audio file(s) — duration, sample rate and corruption cannot be checked without a decoder`,
    });
    checks.push({ label: 'Consent / rights', status: 'info', detail: 'not verifiable here — required before any voice cloning' });
  }
  if (images.length) {
    checks.push({
      label: 'Image dimensions / labels',
      status: 'info',
      detail: `${images.length} image(s) — dimensions and labels were not checked`,
    });
  }
  checks.push({
    label: 'Training readiness',
    status: 'bad',
    detail: 'blocked: no training backend, dataset contract or model registry exists',
  });

  return {
    type: 'diagnostic',
    title: 'Local dataset check',
    checks,
    verdict:
      'Metadata and bounded inline JSONL syntax checks only. This is not a dataset audit and cannot start a training job — the backend is missing. Items marked “info” were not checked.',
    refs: [{ label: 'src/copilot/orchestrator.js — inspectDataset()', ref: 'src/copilot/orchestrator.js', status: 'verified' }],
  };
}

/* ---------- proposals ---------- */
const PROPOSAL_TTL = 5 * 60 * 1000;

function proposal({ title, summary, risk, rows, params, editable = [], effects, permissions, rollback, confirm, execute, mode }) {
  return {
    type: 'proposal',
    id: uid('cp-card'),
    title,
    summary,
    risk,
    rows,
    params,
    editable,
    effects,
    permissions,
    rollback,
    confirm,
    mode,
    createdAt: now(),
    expiresAt: now() + PROPOSAL_TTL,
    armed: false,
    execute,
  };
}

const RISK_LABEL = { 'read-only': 'read-only', reversible: 'reversible', consequential: 'consequential' };
export const riskLabel = (r) => RISK_LABEL[r] || r;

const validName = (v) => /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,40}$/.test(String(v || '').trim());

function createAgentProposal(inputName, mode) {
  const s = getState();
  const name = String(inputName || '').trim().replace(/\s+/g, ' ');
  const params = {
    name: name ? name.replace(/\b\w/g, (c) => c.toUpperCase()) : 'Nova',
    role: 'General-purpose agent',
    framework: 'LangGraph',
    model: 'anthropic/claude-sonnet-4',
    fallback: 'deepseek/deepseek-v3',
    trust: 50,
  };
  const rows = () => [
    ['Name', params.name],
    ['Role', params.role],
    ['Framework', params.framework],
    ['Model', params.model],
    ['Fallback', params.fallback],
    ['Trust seed', `${params.trust} (tier B)`],
    ['Status after create', 'idle (not running)'],
  ];
  return proposal({
    title: 'Create agent',
    summary: apiReady()
      ? 'Creates an agent definition on the gateway. The request is authorised by RBAC and recorded in the hash-chained audit log.'
      : 'A new agent definition will be written to the demo store. Nothing is deployed or started.',
    risk: 'reversible',
    rows: rows(),
    params,
    editable: ['name', 'role'],
    effects: 'Adds one agent to the Agents screen and one event to the feed.',
    permissions: apiReady() ? `Gateway write as ${currentRole()} (agent:write), audited server-side.` : 'Local demo store write only — not enforced.',
    rollback: 'Delete the agent, or clear site data to restore fixtures.',
    confirm: 'Create agent',
    mode,
    execute: async (p) => {
      if (!validName(p.name)) return { status: 'failed', summary: `“${p.name}” is not a valid agent name (2–40 chars, letters/numbers/space . _ -).` };
      if (getState().agents.some((a) => a.name.toLowerCase() === p.name.trim().toLowerCase())) {
        return { status: 'failed', summary: `An agent named ${p.name} already exists. Choose another name.` };
      }

      // Gateway is authoritative when a session exists; the server re-checks the permission.
      if (apiReady()) {
        if (!canDo('agent:write')) {
          return {
            status: 'blocked',
            summary: `Refused locally: your role (${currentRole()}) lacks “agent:write”. The gateway would reject this too.`,
            steps: [{ label: 'Check permission', state: 'blocked', detail: 'agent:write required' }],
          };
        }
        try {
          const created = await api.createAgent({
            name: p.name.trim(),
            role: p.role,
            framework: p.framework,
            model: p.model,
            fallback: p.fallback,
            status: 'idle',
            trust: p.trust,
            prompt: `You are ${p.name}. Be concise, cite sources, ask when unsure.`,
            tools: ['web.search'],
            skills: ['core.citations'],
          });
          const agent = created.body;
          scheduleRefresh(150);
          return {
            status: 'ok',
            summary: `Agent ${agent.name} created on the gateway with status ${agent.status}. It is defined, not running.`,
            steps: [
              { label: 'Validate name', state: 'ok' },
              { label: 'Authorise with gateway RBAC', state: 'ok', detail: `${currentRole()} · agent:write` },
              { label: 'Persist agent', state: 'ok', detail: `id ${agent.id}` },
              { label: 'Write audit entry', state: 'ok', detail: 'hash-chained audit_log' },
            ],
            refs: [apiRef('POST /api/v1/agents'), { label: 'request id', ref: created.requestId || 'n/a', status: 'observed' }],
            verify: `GET /api/v1/agents and confirm ${agent.id} with status idle; run npm run audit:verify.`,
          };
        } catch (err) {
          const denied = err instanceof ApiError && (err.forbidden || err.unauthenticated);
          return {
            status: denied ? 'blocked' : 'failed',
            summary: `Gateway rejected the request: ${err.message}${err.requestId ? ` (request ${err.requestId})` : ''}`,
            steps: [{ label: 'POST /api/v1/agents', state: denied ? 'blocked' : 'failed', detail: err.message }],
          };
        }
      }

      const id = uid('ag');
      setState((st) => {
        st.agents.unshift({
          id,
          name: p.name.trim(),
          role: p.role,
          framework: p.framework,
          model: p.model,
          fallback: p.fallback,
          status: 'idle',
          trust: p.trust,
          autonomy: 2,
          successRate: 0,
          costToday: 0,
          runs: 0,
          lastActive: now(),
          tools: ['web.search'],
          skills: ['core.citations'],
          prompt: `You are ${p.name}. Be concise, cite sources, ask when unsure.`,
          memory: { episodic: 0, semantic: 0, kb: '0 MB' },
        });
        logEvent('agent', `Agent ${p.name} created via Copilot (demo store)`);
      }, 'copilot-create-agent');
      return {
        status: 'ok',
        summary: `Agent ${p.name} created with status idle. It is not running and has no task history.`,
        steps: [
          { label: 'Validate name and uniqueness', state: 'ok' },
          { label: 'Write agent definition to demo store', state: 'ok', detail: `id ${id}` },
          { label: 'Append event to feed', state: 'ok' },
          { label: 'Confirm with runtime', state: 'blocked', detail: 'no runtime — demo store only' },
        ],
        refs: [REF_STATE('agent list after create')],
        verify: 'Open Agents and confirm the new card shows status idle.',
      };
    },
  });
}

function deploySwarmProposal(objective, mode) {
  const params = {
    objective: String(objective || '').trim() || 'Explore the Q4 agent-framework landscape',
    team: 'Research Squad (3 agents)',
    topology: 'Hierarchical',
    budget: 8,
    gate: 'All writes require approval',
  };
  return proposal({
    title: 'Deploy swarm',
    summary: 'This is a consequential action in the spec’s risk taxonomy, so it needs two confirmations. In this build it saves a swarm *record* — no scheduler reads it, no agent executes and no money is spent.',
    risk: 'consequential',
    rows: () => [
      ['Objective', params.objective],
      ['Team', params.team],
      ['Topology', params.topology],
      ['Budget cap', `$${Number(params.budget).toFixed(2)}`],
      ['Gate', params.gate],
      ['Runtime', 'none — a record is saved, nothing executes'],
    ],
    params,
    editable: ['objective'],
    effects: 'Adds a swarm record to Teams & Swarms, labelled not executed. No ticker advances it; nothing runs.',
    permissions: apiReady()
      ? 'Gateway has no swarm endpoint yet: this instance stays in the browser mirror even when signed in. No provider, tool or budget is invoked.'
      : 'Demo store write. No provider, tool or budget is actually invoked.',
    rollback: 'Delete the record. Nothing was started, so there is nothing to undo.',
    confirm: 'Deploy swarm',
    mode,
    execute: async (p) => {
      if (!String(p.objective || '').trim()) return { status: 'failed', summary: 'An objective is required.' };
      const id = uid('sw');
      const slug = p.objective.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24) || 'swarm';
      setState((st) => {
        st.swarms.unshift({
          id,
          teamId: 'tm-research',
          name: slug,
          objective: p.objective,
          status: 'planned',
          executed: false,
          progress: 0,
          budget: { cap: Number(p.budget) || 8, spent: 0 },
          startedAt: now(),
          channel: 'app',
          simulated: true,
          nodes: [
            { id: 'n1', label: 'planner', agent: 'ag-researcher', status: 'planned', spent: 0, elapsed: '—' },
            { id: 'n2', label: 'research-a', agent: 'ag-researcher', status: 'planned', spent: 0, elapsed: '—' },
            { id: 'n3', label: 'research-b', agent: 'ag-content', status: 'planned', spent: 0, elapsed: '—' },
            { id: 'n4', label: 'assembler', agent: 'ag-analyst', status: 'planned', spent: 0, elapsed: '—' },
          ],
        });
        logEvent('swarm', `Swarm record saved via Copilot — not executed · ${p.objective}`);
      }, 'copilot-deploy');
      return {
        status: 'ok',
        summary: 'Swarm record created with status “planned”. There is no ticker and no worker: the plan will not move.',
        steps: [
          { label: 'Validate objective', state: 'ok' },
          { label: 'Create swarm instance', state: 'ok', detail: `id ${id}` },
          { label: 'Schedule nodes', state: 'blocked', detail: 'no scheduler/runtime — nodes are seeded' },
          { label: 'Persist on gateway', state: 'blocked', detail: apiReady() ? 'POST /swarms/:id/deploy is still planned, not implemented' : 'no gateway session' },
        ],
        refs: [REF_STATE('swarm list'), { label: 'src/core.js — swarm fixtures', ref: 'src/core.js', status: 'verified' }],
        verify: 'Open Teams & Swarms: the record is there, every node says planned, and the banner says not executed.',
      };
    },
  });
}

function createTaskProposal(title, mode) {
  const params = { title: String(title || '').trim() || 'Untitled task', column: 'todo', assignee: 'Auto-route by skill' };
  return proposal({
    title: 'Create Kanban task',
    summary: 'Adds a card to the backlog. Reversible — the card can be moved or deleted.',
    risk: 'reversible',
    rows: () => [
      ['Title', params.title],
      ['Column', params.column],
      ['Assignee', params.assignee],
    ],
    params,
    editable: ['title'],
    effects: 'Adds one card to the Kanban board.',
    permissions: apiReady() ? `Gateway write as ${currentRole()} (task:write).` : 'Demo store write — not enforced.',
    rollback: 'Delete the card.',
    confirm: 'Create task',
    mode,
    execute: async (p) => {
      if (!String(p.title || '').trim()) return { status: 'failed', summary: 'A title is required.' };
      if (apiReady()) {
        if (!canDo('task:write')) {
          return { status: 'blocked', summary: `Refused locally: your role (${currentRole()}) lacks “task:write”.`, steps: [{ label: 'Check permission', state: 'blocked', detail: 'task:write required' }] };
        }
        try {
          const created = await api.createTask({ title: p.title.trim(), column: 'todo', priority: 'med' });
          // Adopt the server's row (never a local guess) so the board matches the gateway.
          scheduleRefresh(150);
          return {
            status: 'ok',
            summary: `Task “${created.body.title}” created on the gateway in ${created.body.column || 'todo'}.`,
            steps: [
              { label: 'Authorise with gateway RBAC', state: 'ok', detail: `${currentRole()} · task:write` },
              { label: 'Persist task', state: 'ok', detail: `id ${created.body.id}` },
            ],
            refs: [apiRef('POST /api/v1/tasks')],
            verify: 'Open Tasks — the gateway list now contains this card.',
          };
        } catch (err) {
          return { status: err?.forbidden ? 'blocked' : 'failed', summary: `Gateway rejected the task: ${err.message}` };
        }
      }
      const id = uid('tk');
      setState((st) => {
        st.tasks.unshift({ id, title: p.title.trim(), column: 'todo', assignee: 'ag-researcher', priority: 'med', deps: [], desc: 'Created via Copilot.' });
        logEvent('task', `Task created via Copilot: ${p.title.trim()}`);
      }, 'copilot-task');
      return {
        status: 'ok',
        summary: `Task “${p.title.trim()}” added to the backlog.`,
        steps: [{ label: 'Create card', state: 'ok', detail: id }, { label: 'Assign', state: 'ok', detail: 'ag-researcher (demo)' }],
        verify: 'Open Tasks and confirm the card in the Todo column.',
      };
    },
  });
}

function approvalProposal(match, mode, decision = 'allow') {
  const s = getState();
  const key = String(match || '').trim().toLowerCase();
  const gate = s.approvals.find((a) => a.id.toLowerCase() === key) || s.approvals.find((a) => `${a.action} ${a.target}`.toLowerCase().includes(key));
  if (!gate) return null;
  if (gate.status !== 'pending') {
    return answer(`${gate.id} (${gate.action}) is already ${gate.status}.`, { title: 'Nothing to decide', confidence: 'observed' });
  }
  const params = { id: gate.id, decision };
  return proposal({
    title: `Resolve approval · ${gate.action}`,
    summary: 'You are making an explicit governance decision. Copilot never decides on your behalf and cannot approve requests it raised.',
    risk: 'consequential',
    rows: () => [
      ['Gate', gate.id],
      ['Action', gate.action],
      ['Target', gate.target],
      ['Requested by', gate.principal],
      ['Risk', gate.risk],
      ['Evidence', gate.evidence],
      ['Decision', params.decision === 'allow' ? 'Allow once' : 'Deny'],
      ['Enforcement', apiReady() ? `gateway RBAC (${currentRole()}) + separation of duties` : 'UI-only — no gateway session'],
    ],
    params,
    editable: [],
    effects: params.decision === 'allow' ? 'Releases the action to the requesting principal.' : 'Denies the action and notifies the principal.',
    permissions: apiReady()
      ? `Gateway decides for ${currentRole()} (approval:decide), with separation of duties enforced server-side.`
      : 'UI-only in this build: no gateway session, so the decision is not enforced.',
    rollback: 'A decision cannot be un-made in the audit sense; re-request the gate instead.',
    confirm: params.decision === 'allow' ? 'Allow once' : 'Deny',
    mode,
    execute: async (p) => {
      if (apiReady()) {
        if (!canDo('approval:decide')) {
          return {
            status: 'blocked',
            summary: `Your role (${currentRole()}) cannot decide approval gates. Ask a Reviewer, Admin or Owner.`,
            steps: [{ label: 'Check permission', state: 'blocked', detail: 'approval:decide required' }],
          };
        }
        try {
          const out = await api.decideApproval(p.id, p.decision);
          scheduleRefresh(150);
          return {
            status: 'ok',
            summary: `${out.body.action} ${out.body.status} on the gateway (decider ${out.body.decider_id}). Recorded in the audit chain.`,
            steps: [
              { label: 'Authorise with gateway RBAC', state: 'ok', detail: `${currentRole()} · approval:decide` },
              { label: 'Apply decision', state: 'ok', detail: out.body.status },
              { label: 'Write audit entry', state: 'ok', detail: 'hash-chained audit_log' },
            ],
            refs: [apiRef(`POST /api/v1/approvals/${p.id}/${p.decision}`)],
            verify: 'GET /api/v1/approvals and npm run audit:verify.',
          };
        } catch (err) {
          const denied = err instanceof ApiError && err.forbidden;
          return {
            status: denied ? 'blocked' : 'failed',
            summary: denied
              ? `Gateway refused: ${err.message}. Separation of duties blocks approving your own request.`
              : `Gateway error: ${err.message}`,
            steps: [{ label: 'Decide gate', state: denied ? 'blocked' : 'failed', detail: err.message }],
          };
        }
      }

      const target = getState().approvals.find((a) => a.id === p.id);
      if (!target) return { status: 'failed', summary: 'That gate no longer exists.' };
      if (target.status !== 'pending') return { status: 'failed', summary: `${target.id} was already ${target.status}.` };
      if (target.principal === 'Copilot') return { status: 'blocked', summary: 'Copilot cannot approve its own request.' };
      setState((st) => {
        const a = st.approvals.find((x) => x.id === p.id);
        a.status = p.decision === 'allow' ? 'allowed' : 'denied';
        a.decidedBy = 'you via Copilot';
        a.decidedAt = now();
        logEvent('approval', `${a.action} ${a.status} by you via Copilot · ${a.target}`);
      }, 'copilot-approve');
      return {
        status: p.decision === 'allow' ? 'ok' : 'ok',
        summary: `${target.action} ${p.decision === 'allow' ? 'allowed once' : 'denied'}. Recorded in the app event feed and Copilot episodic memory.`,
        steps: [
          { label: 'Re-check gate is pending', state: 'ok' },
          { label: 'Apply decision', state: 'ok' },
          { label: 'Write to hash-chained audit log', state: 'blocked', detail: 'audit chain is server-side; this decision is browser-only' },
        ],
        refs: [REF_STATE('approval status')],
        verify: 'The bell badge count decreases and the event feed shows the decision.',
      };
    },
  });
}

/* ---------- executors for direct (non-card) actions ---------- */
function runAgentIntent(query) {
  const s = getState();
  const q = String(query || '').trim().toLowerCase();
  const agent = s.agents.find((a) => a.name.toLowerCase().includes(q) || a.id.includes(q));
  if (!agent) return una(`No agent matches “${query}”. Say “list agents” to see the current definitions.`);
  if (isLive('agents')) {
    // No execution runtime exists, and the gateway owns agent rows: flagging an agent "running"
    // here would be a browser-only state change presented as a server fact.
    return {
      status: 'blocked',
      summary: `${agent.name} exists on the gateway, but there is no execution runtime to start it and this build has no run endpoint. Nothing was changed.`,
      steps: [{ label: 'Check runtime', state: 'blocked', detail: 'no scheduler/worker adapters in repo' }],
    };
  }
  setState((st) => {
    const a = st.agents.find((x) => x.id === agent.id);
    a.status = 'running';
    a.lastActive = now();
    logEvent('agent', `${a.name} marked running via Copilot (demo)`);
  }, 'copilot-run');
  return answer(
    `${agent.name} is now marked running with ${agent.model}. This is a demo status change — no agent process, model call or tool execution exists, so do not treat it as evidence of work.`,
    { title: 'Agent status changed (demo)', confidence: 'observed', refs: [REF_STATE('agent status')] }
  );
}

function setThemeIntent(theme) {
  setState((st) => {
    st.settings.theme = theme;
  }, 'theme');
  import('../shell.js').then((m) => m.applyTheme()).catch(() => {});
  return answer(`Theme switched to ${theme}. This is a reversible local setting.`, {
    title: 'Theme updated',
    confidence: 'observed',
    refs: [{ label: 'src/shell.js — applyTheme', ref: 'src/shell.js', status: 'verified' }],
  });
}

const NAV_MAP = {
  home: 'home', agents: 'agents', agent: 'agents', teams: 'teams', team: 'teams', swarm: 'teams', swarms: 'teams',
  tasks: 'tasks', task: 'tasks', kanban: 'tasks', chat: 'chat', skills: 'skills', skill: 'skills', models: 'models',
  model: 'models', plugins: 'plugins', plugin: 'plugins', telegram: 'telegram', analytics: 'analytics', files: 'artifacts',
  artifacts: 'artifacts', terminal: 'terminal', settings: 'settings', voice: 'voice', tts: 'voice',
};

function navigateIntent(word) {
  const target = NAV_MAP[String(word || '').trim().toLowerCase()];
  if (!target) return null;
  setTimeout(() => import('../main.js').then((m) => m.navigate(target)).catch(() => {}), 220);
  const label = { voice: 'Voice Studio' }[target] || target;
  return answer(`Opening ${label}.`, {
    title: 'Navigation',
    confidence: 'observed',
    refs: [{ label: 'src/shell.js — routes', ref: 'src/shell.js', status: 'verified' }],
  });
}

/* ---------- capability cards ---------- */
export function capabilityCard(id, note = '') {
  const cap = getCapability(id);
  if (!cap) return una(`No capability is registered for “${id}”.`);
  return {
    type: 'capability',
    capability: cap,
    note,
    text: `${cap.label}: ${STATUS_LABEL[cap.status] || cap.status}. ${cap.summary}`,
  };
}

/* ---------- activity ---------- */
function activityCard() {
  const s = getState();
  const mem = memorySummary();
  return {
    type: 'activity',
    episodes: listEpisodes(12),
    events: s.events.slice(0, 10),
    approvals: pendingApprovals().slice(0, 5),
    memory: mem,
    text: mem.episodes
      ? `${mem.episodes} Copilot action(s) recorded in this browser (cap ${mem.cap}). ${pendingApprovals().length} approval(s) pending.`
      : 'No Copilot actions recorded yet. Actions you confirm will appear here with their evidence.',
  };
}

/* ---------- build mode ---------- */
function buildLanding() {
  const s = getState();
  return {
    type: 'answer',
    title: 'Build',
    text: [
      `Definitions in this workspace: ${s.agents.length} agents · ${s.teams.length} teams · ${s.skills.length} skills.`,
      'I can propose a new agent from the reviewed template, or show any existing prompt and its model routing.',
      'Deployment, scheduling and runtime state are not connected — an agent created here is a definition with status idle, never “active”.',
      '',
      'Try: create agent Astra as research analyst · show prompt Researcher-01 · list agents',
    ].join('\n'),
    confidence: 'observed',
    refs: [REF_STATE('agents/teams/skills'), { label: 'docs/copilot/PHASE0_DISCOVERY.md §4', ref: 'docs/copilot/PHASE0_DISCOVERY.md', status: 'verified' }],
  };
}

function showPromptAnswer(query) {
  const s = getState();
  const q = String(query || '').trim().toLowerCase();
  const agent = s.agents.find((a) => a.name.toLowerCase().includes(q) || a.id.includes(q));
  if (!agent) return una(`No agent matches “${query}”.`);
  return answer(
    `${agent.name} · ${agent.framework} · ${agent.model} (fallback ${agent.fallback})\n${agent.prompt}\n\nThis prompt is demo data. There is no prompt-version store, evaluation or deployment gate yet.`,
    {
      title: `Prompt · ${agent.name}`,
      confidence: 'observed',
      refs: [REF_STATE('agent definition'), { label: 'src/core.js — agent prompt field', ref: 'src/core.js', status: 'verified' }],
    }
  );
}

/* ---------- ask mode routing ---------- */
async function askIntent(lc, raw, ctx) {
  if (/^(help|what can you do|capabilities|commands)\b/.test(lc)) {
    return answer(
      [
        'I am deterministic: grounded in a versioned knowledge pack plus live app state. No model is called.',
        '',
        'Ask: “what is the gateway API”, “why are my approvals pending”, “explain this screen”, “is my data live?”',
        'Operate: “create agent Nova”, “deploy swarm <objective>”, “create task <title>”, “move <card> to <column>”, “zoom the board to 120%”, “approve ap-1”, “theme light”',
        'Knowledge: search sources with verification status. Activity: see what you have confirmed here.',
        '',
        'Modes Training, Voice and the SMS/channel integrations report blockers rather than pretending to run.',
      ].join('\n'),
      { title: 'What Copilot can do', confidence: 'verified', refs: [{ label: 'docs/copilot/PHASE0_DISCOVERY.md', ref: 'docs/copilot/PHASE0_DISCOVERY.md', status: 'verified' }] }
    );
  }
  if (/^(status|health|gateway|overview)\b/.test(lc)) return liveStatusAnswer();
  if (/(list|show|what|which).*(agent)/.test(lc)) {
    const data = await liveData();
    return agentListAnswer(data.agents, data);
  }
  if (/(list|show).*(swarm)/.test(lc)) return swarmListAnswer();
  if (/(list|show).*(task|kanban)/.test(lc)) {
    const data = await liveData();
    return taskListAnswer(data.tasks, data);
  }
  if (/(approv|pending).*(gate|approval|pending)|pending approvals/.test(lc)) {
    const data = await liveData();
    return approvalsAnswer(data.approvals, data);
  }
  if (/spend|cost|budget|analy/.test(lc)) return spendAnswer();
  if (/this (screen|page)|where am i|what am i looking at|explain this/.test(lc)) {
    const text = describeScreen(ctx.route);
    const hit = searchKnowledge(`navigation ${ctx.route}`, { limit: 1 });
    return answer(text, { title: `This screen · ${ctx.route}`, confidence: 'observed', refs: [{ label: 'live route', ref: `route:${ctx.route}`, status: 'observed' }, ...refsFrom(hit)] });
  }
  if (/live|real|demo|fake|simulat|actually running/.test(lc)) {
    const auth = getAuth();
    const enforcement =
      isApiMode() && isAuthenticated()
        ? `The gateway is connected and enforcing RBAC for ${auth.principal.name} (${auth.principal.role}); agent/task/approval actions from this panel are checked server-side.`
        : isApiMode()
          ? 'A gateway is configured but you are not signed in, so no call can be authorised.'
          : 'No gateway is configured, so nothing is enforced by a server.';
    return answer(
      [
        'Honest answer: this build is demo data plus a real UI.',
        '• Agents, swarms, tasks, approvals and files are seeded in the browser store. Swarms are plans: no ticker, no worker, nothing executes.',
        `• ${enforcement}`,
        '• No LLM, scheduler, tool, training job, voice engine or SMS connector is invoked.',
        '• Swarm progress is not animated and not persisted; a swarm is a plan with a budget cap.',
        'The panel header always shows the runtime status so this cannot be mistaken for live execution.',
      ].join('\n'),
      {
        title: 'Demo vs live',
        confidence: 'verified',
        refs: [
          { label: 'docs/PROGRESS.md', ref: 'docs/PROGRESS.md', status: 'verified' },
          { label: 'src/copilot/runtime.js', ref: 'src/copilot/runtime.js', status: 'verified' },
        ],
      }
    );
  }
  // Navigation and the singing constraint are answerable from live app state, not the pack.
  const openM = raw.match(/^(?:open|go to|navigate to|show)\s+(.+)/i);
  if (openM) {
    const nav = navigateIntent(openM[1].trim().split(/\s+/)[0]);
    if (nav) return nav;
  }
  if (/\bsing\b/i.test(lc) && /\b(can|does|will|able|why)\b/i.test(lc)) return singingAnswer(raw);

  const results = searchKnowledge(raw, { limit: 3 });
  if (results.length) {
    const card = knowledgeCard(raw, results);
    return { text: card.text, card };
  }
  return una(
    [
      `I have no grounded answer for “${raw}”.`,
      'I will not guess — the knowledge pack has no entry that covers this, and no model is wired to reason about it.',
      'Options: rephrase with concrete terms (gateway, store, approvals, swarm, training, voice, OpenSMS), or open Knowledge mode to browse the pack.',
    ].join('\n'),
    { refs: [{ label: `knowledge pack ${knowledgeStats().version} — no match`, ref: 'src/copilot/knowledge.js', status: 'verified' }] }
  );
}

/**
 * Singing is the one voice request that must never be hedged: browser speech synthesis cannot sing,
 * and no installed engine can. Shared by the voice mode branch and plain questions.
 */
export function singingAnswer(raw) {
  return {
    type: 'answer',
    title: 'Singing request — unsupported',
    confidence: 'verified',
    text: [
      `You asked: “${raw}”.`,
      'Voice Studio can speak typed text through the device speech engine, but no installed engine can sing: browser speech synthesis does not accept pitch curves or melodies, and the candidates in the spec (Local TTS, NeuTTS, OpenVoice) were not verified here for licence, mobile runtime or singing capability.',
      'To deliver this honestly we need: a verified singing-capable component, its licence reviewed, a consent/ownership record for the source voice, protected profile storage, and synthetic-output labelling. None of that exists yet.',
    ].join('\n'),
    refs: [
      { label: 'docs/copilot/PHASE0_DISCOVERY.md §5', ref: 'docs/copilot/PHASE0_DISCOVERY.md', status: 'verified' },
      { label: 'src/copilot/capabilities.js — voice', ref: 'src/copilot/capabilities.js', status: 'verified' },
      { label: 'docs/voice/VOICE_STUDIO.md — capability matrix', ref: 'docs/voice/VOICE_STUDIO.md', status: 'verified' },
    ],
  };
}

/* ---------- operate mode routing ---------- */
async function operateIntent(lc, raw, ctx) {
  const openM = raw.match(/^(?:open|go to|navigate to|show)\s+(.+)/i);
  if (openM) {
    const nav = navigateIntent(openM[1].trim().split(/\s+/)[0]);
    if (nav) return nav;
  }
  const themeM = lc.match(/^(?:theme|set theme)\s+(dark|light)/);
  if (themeM) return setThemeIntent(themeM[1]);

  const createM = raw.match(/^create (?:a |new )?agent(?: called| named)?\s+(.+)/i) || raw.match(/^new agent\s+(.+)/i);
  if (createM) {
    const [namePart, rolePart] = createM[1].split(/\s+as\s+/i);
    const card = createAgentProposal(namePart.trim(), ctx.mode);
    if (rolePart) card.params.role = rolePart.trim();
    return {
      text: 'Review this definition. It writes a definition to the demo store only — nothing is deployed, started or sent anywhere.',
      card,
    };
  }
  const deployM = raw.match(/^deploy (?:a |new )?swarm(?: for| to| called| named|:)?\s*(.*)/i) || raw.match(/^deploy\s+(.+)/i);
  if (deployM) {
    return {
      text: 'Consequential action: review the plan, then confirm twice. There is no runtime — the card says a record is saved and nothing executes.',
      card: deploySwarmProposal(deployM[1], ctx.mode),
    };
  }
  const taskM = raw.match(/^(?:create|add|new)\s+(?:a\s+)?task:?\s+(.+)/i);
  if (taskM) {
    return { text: 'This adds a card to the Kanban backlog.', card: createTaskProposal(taskM[1], ctx.mode) };
  }
  // Kanban: one seam in src/kanban.js owns moves, assignments, priorities, dependencies, zoom and
  // wires, so the Copilot cannot take a path the board UI does not have. `kanbanCommand` returns
  // null for text that is not about the board, letting the rest of the router continue.
  {
    const kanban = await import('../kanban.js');
    const out = await kanban.kanbanCommand(raw);
    if (out) {
      const declined = out.ok === false;
      return answer(out.reply, {
        title: declined ? 'Board action not applied' : 'Board updated',
        confidence: declined ? 'observed' : 'verified',
        refs: [{ label: 'src/kanban.js — board command seam', ref: 'src/kanban.js', status: 'verified' }],
      });
    }
  }

  const decideM = raw.match(/^(approve|deny|allow)\s+(.+)/i);
  if (decideM) {
    const decision = decideM[1].toLowerCase() === 'deny' ? 'deny' : 'allow';
    const gateCard = approvalProposal(decideM[2], ctx.mode, decision);
    if (!gateCard) return una(`No pending gate matches “${decideM[2]}”. Ask “pending approvals” to list them.`);
    if (gateCard.type !== 'proposal') return gateCard;
    return { text: 'This is your governance decision, not mine. Review the evidence, then confirm twice.', card: gateCard };
  }
  const runM = raw.match(/^(?:run|start)\s+(.+)/i);
  if (runM && !/swarm/.test(lc)) return runAgentIntent(runM[1]);
  if (/^(status|health)\b/.test(lc)) return liveStatusAnswer();
  if (/(list|show).*agent/.test(lc)) {
    const data = await liveData();
    return agentListAnswer(data.agents, data);
  }
  if (/(list|show).*swarm/.test(lc)) return swarmListAnswer();
  if (/(list|show).*task/.test(lc)) {
    const data = await liveData();
    return taskListAnswer(data.tasks, data);
  }
  if (/pending|approv/.test(lc)) {
    const data = await liveData();
    return approvalsAnswer(data.approvals, data);
  }
  if (/diagnos|troubleshoot|check/.test(lc)) return { text: 'Running real checks now — no canned results.', card: null, defer: 'diagnose' };

  // Communication gateways: one seam in src/comms.js owns the whole surface.
  if (/\b(comms|channel|channels|gateway|telegram|whatsapp|discord|slack|sms|inbox|broadcast)\b/.test(lc)) {
    const comms = await import('../comms.js');
    const out = comms.commsCommand(raw);
    if (out) {
      if (out.ok === 'async' && out.run) {
        const result = await out.run();
        return answer(
          result.ok
            ? `${out.reply}\nResult: ${result.detail}`
            : `${out.reply}\nResult: failed — ${result.error}`,
          {
            title: result.ok ? 'Channel test accepted' : 'Channel test failed',
            confidence: 'verified',
            refs: [{ label: 'src/commsAdapters.js — adapter + live delivery', ref: 'src/commsAdapters.js', status: 'verified' }],
          }
        );
      }
      return answer(out.reply, {
        title: out.ok === false ? (out.reason === 'needs_credentials' ? 'Credentials required' : 'Comms declined') : 'Comms',
        refs: [{ label: 'src/comms.js — comms command seam', ref: 'src/comms.js', status: 'verified' }],
      });
    }
  }

  return answer(
    [
      `I do not have an authorised action for “${raw}”, and I will not invent one.`,
      'Operate mode actions: create agent <name> [as <role>] · deploy swarm <objective> · create task <title> · move <card> to <column> · assign <card> to <agent> · set priority low|med|high on <card> · rename <card> to <title> · link <card> depends on <card> · zoom the board to <n>% · show|hide wires · approve|deny <gate> · run <agent> · theme dark|light · open <module> · comms status · test <channel> · route <agent> to <channel> · mute|wake <channel>',
      'Anything consequential asks for a two-step confirmation, and every confirmation is written to episodic memory with its evidence.',
    ].join('\n'),
    { title: 'No matching action', confidence: 'verified', refs: [{ label: 'src/copilot/orchestrator.js — operateIntent', ref: 'src/copilot/orchestrator.js', status: 'verified' }] }
  );
}

/* ---------- public entry point ---------- */
/**
 * @param {string} text
 * @param {{mode?:string, route?:string, history?:{role:string,text?:string}[]}} ctx
 * @returns {{text:string, card:object|null, defer?:string, mode:string}}
 */
export async function handle(text, ctx = {}) {
  const raw = String(text || '').trim();
  const mode = resolveMode(ctx.mode);
  const route = ctx.route || 'home';
  const lc = raw.toLowerCase();
  const base = { mode, route, raw };

  if (!raw) return { text: 'Give me something to work with — a question, a screen to explain, or an action to prepare.', card: null, mode };

  try {
    let res;
    switch (mode) {
      case 'knowledge': {
        const results = searchKnowledge(raw, { limit: 5 });
        const card = knowledgeCard(raw, results);
        res = { text: card.text, card };
        break;
      }
      case 'training': {
        if (/validat|inspect|dataset|files?|folder|audio|image/.test(lc)) {
          const prefix = raw.match(/(?:in|under|folder|path)\s+([\w./-]+)/i)?.[1] || '';
          res = {
            text: `Checked the File Manager entries${prefix ? ` under ${prefix}` : ''}. Metadata only — the card states exactly what could not be verified.`,
            card: inspectDataset({ pathPrefix: prefix }),
          };
        } else {
          res = {
            text: 'The training backend does not exist in this repository, so there is no job to start. Here is the exact blocker, plus the real dataset check I can run.',
            card: capabilityCard('training'),
          };
        }
        break;
      }
      case 'voice': {
        if (/sing/.test(lc)) {
          res = { text: 'Singing is not supported by this build, and voice cloning does not imply singing.', card: singingAnswer(raw) };
        } else if (/open|studio|editor|read|speak|listen|typing|type/.test(lc)) {
          setTimeout(() => import('../voice.js').then((m) => m.openVoiceTab('tts')).catch(() => {}), 240);
          res = {
            text: 'Opening Voice Studio. The editor speaks what you type with the selected voice; every blocker (cloning, Qwen2.5-Omni, speech input) is labelled there.',
            card: answer(['Open Voice Studio', ...
              'Type in the editor: finished sentences are spoken while you write (sentence strategy), or hold until you press Play with the manual strategy.',
              '“My cloned voice” is the default profile but falls back to the device voice until a cloning engine is configured — the fallback is always stated, never silent.',
              'Use 🔊 on any Copilot reply to hear it read in the same voice.',
            ].join('\n'), { title: 'Opening Voice Studio', refs: [{ label: 'src/voice.js — Voice Studio', ref: 'src/voice.js', status: 'verified' }] }),
          };
        } else {
          res = { text: 'Voice Studio reports its exact status — device speech works, cloning and model installs stay blocked.', card: capabilityCard('voice') };
        }
        break;
      }
      case 'activity': {
        if (/clear|delete|forget/.test(lc)) {
          res = {
            text: 'Consequential: clearing Copilot memory removes the actions recorded in this browser. It cannot be undone.',
            card: proposal({
              title: 'Clear Copilot memory',
              summary: 'Deletes the working draft, preferences and episodic action log stored in this browser.',
              risk: 'consequential',
              rows: () => [
                ['Layers', 'working draft + preferences + episodic log'],
                ['Stored in', 'localStorage (this browser only)'],
                ['Records', String(memorySummary().episodes)],
                ['Server audit', 'not affected (none exists for Copilot actions)'],
              ],
              params: {},
              effects: 'Activity mode will be empty and your draft will be discarded.',
              permissions: 'Browser-local deletion.',
              rollback: 'No — deleted records are gone.',
              confirm: 'Clear memory',
              mode,
              execute: async () => {
                clearMemory();
                return {
                  status: 'ok',
                  summary: 'Copilot memory cleared for this browser.',
                  steps: [
                    { label: 'Remove episodic log', state: 'ok' },
                    { label: 'Remove draft and preferences', state: 'ok' },
                  ],
                  verify: 'Reopen the panel — it starts with an empty conversation and the default mode.',
                };
              },
            }),
          };
        } else {
          const card = activityCard();
          res = { text: card.text, card };
        }
        break;
      }
      case 'build': {
        const promptM = raw.match(/(?:prompt|instruction)s?\s+(?:for|of)\s+(.+)/i) || raw.match(/show prompt\s+(.+)/i);
        const createM = raw.match(/^create (?:a |new )?agent(?: called| named)?\s+(.+)/i);
        if (promptM) {
          res = { text: 'Here is the stored prompt (no evaluation or versioning exists yet).', card: showPromptAnswer(promptM[1]) };
        } else if (createM) {
          const [namePart, rolePart] = createM[1].split(/\s+as\s+/i);
          const card = createAgentProposal(namePart.trim(), mode);
          if (rolePart) card.params.role = rolePart.trim();
          res = { text: 'Review the definition before it is written. Creating a definition is not activation.', card };
        } else if (/(list|show).*agent/.test(lc)) {
          res = { text: 'Current agent definitions:', card: agentListAnswer() };
        } else if (/team/.test(lc)) {
          const s = getState();
          res = {
            text: 'Teams are static definitions; there is no runtime to deploy them to.',
            card: answer(
              s.teams.map((t) => `${t.name} — ${(t.members || []).length} member(s) · ${t.mode || 'sequential'}`).join('\n') || 'No teams defined.',
              { title: 'Teams', confidence: 'observed', refs: [REF_STATE('teams')] }
            ),
          };
        } else {
          const card = buildLanding();
          res = { text: card.text, card };
        }
        break;
      }
      case 'operate':
        res = await operateIntent(lc, raw, base);
        break;
      default:
        res = await askIntent(lc, raw, base);
        break;
    }
    return normalize(res, mode);
  } catch (err) {
    return {
      mode,
      text: `Something failed while handling that: ${String(err && err.message ? err.message : err)}. No action was taken.`,
      card: {
        type: 'answer',
        title: 'Error',
        confidence: 'unknown',
        text: 'The request failed before any mutation. Check the console for the stack trace.',
        refs: [],
      },
      episode: { outcome: 'failed', summary: 'orchestrator error' },
    };
  }
}

/** Cards returned bare by intent helpers become { text, card }. */
function normalize(res, mode) {
  if (!res) return { text: 'No result.', card: null, mode };
  if (res.card || res.type === undefined) return { mode, ...res, card: res.card || null };
  return { mode, text: res.text || '', card: res, defer: res.defer };
}

/* ---------- proposal lifecycle ---------- */
export function proposalExpired(card) {
  return Boolean(card?.expiresAt && Date.now() > card.expiresAt);
}

/** Edit re-arms review: the confirmation is bound to the values shown. */
export function rearmProposal(card) {
  card.armed = false;
  return card;
}

/**
 * Execute a confirmed proposal. The panel calls this; it is exported so tests can drive it.
 * Returns an assistant message with a result card and records episodic evidence.
 */
export async function runProposal(card, { mode = 'operate' } = {}) {
  if (!card || card.type !== 'proposal') return { text: 'No action to run.', card: null };
  if (proposalExpired(card)) {
    const out = {
      text: 'This proposal expired (5-minute limit) or its details changed, so it was not executed.',
      card: { type: 'result', title: card.title, status: 'failed', summary: 'Proposal expired — ask again to review the current values.', steps: [] },
    };
    pushEpisode({ mode, intent: card.title, summary: 'proposal expired before confirmation', outcome: 'failed', risk: card.risk });
    return out;
  }
  let result;
  try {
    result = (await card.execute(card.params)) || { status: 'ok', summary: 'Action completed.' };
  } catch (err) {
    result = { status: 'failed', summary: `Execution error: ${String(err && err.message ? err.message : err)}` };
  }
  const outcome = result.status === 'ok' ? 'ok' : result.status === 'blocked' ? 'blocked' : 'failed';
  pushEpisode({
    mode,
    intent: `${card.title}${card.params?.name ? ` · ${card.params.name}` : ''}${card.params?.objective ? ` · ${card.params.objective}` : ''}${card.params?.id ? ` · ${card.params.id}` : ''}`,
    summary: result.summary,
    outcome,
    risk: card.risk,
    evidence: (result.steps || []).filter((s) => s.state === 'ok').map((s) => s.label),
    refs: result.refs || [],
  });
  return {
    text: result.summary,
    card: {
      type: 'result',
      title: card.title,
      status: result.status,
      summary: result.summary,
      steps: result.steps || [],
      refs: result.refs || [],
      verify: result.verify || '',
      simulated: card.risk === 'consequential',
    },
  };
}

export function cancelProposal(card, { mode = 'operate' } = {}) {
  if (!card) return;
  pushEpisode({ mode, intent: `cancelled · ${card.title}`, summary: 'You cancelled the proposal before it ran.', outcome: 'cancelled', risk: card.risk });
}

/* ---------- suggestions per mode ---------- */
export const SUGGESTIONS = {
  ask: ['explain this screen', 'is this data live?', 'what is the gateway API', 'why are approvals pending'],
  operate: ['status', 'create agent Nova', 'deploy swarm audit plugins', 'approve ap-1'],
  build: ['list agents', 'show prompt Researcher-01', 'create agent Astra as research analyst'],
  knowledge: ['gateway auth', 'training methods', 'OpenSMS requirements', 'secret handling'],
  training: ['inspect dataset', 'what can validation check?'],
  voice: ['can it sing?', 'open voice studio', 'which engines are supported?'],
  activity: ['show recent work', 'pending approvals'],
};

export { searchKnowledge, knowledgeStats, describeScreen, getEntry, getCapability };
