/* ============ Self-Improvement — the visibility surface for autonomous code evolution ============
 * Every agent can inspect its authorised code and propose a change. Whether it may write, test, stage
 * or deploy is decided by its autonomy level, and shown here in the same words the gateway uses.
 *
 * Honest contract:
 *   • with no gateway this screen explains that the cycle runs on the gateway and offers no controls;
 *   • "Review required" / "Blocked" / "Tests failed" are shown as they are — a candidate is never
 *     dressed up as production-ready;
 *   • the diff, the test output, the reviewer findings and the audit trail are the gateway's, verbatim;
 *   • controls appear only when the signed-in principal actually holds the permission for them.
 *
 * Mobile: one column, native <details> for each cycle step, readable change summaries instead of a
 * desktop code editor, and ≥44px targets throughout.
 */
import { api, ApiError, isApiMode } from './api.js';
import { esc, icon } from './core.js';
import { can, isAuthenticated } from './auth.js';
import { toast, on } from './shell.js';
import { views } from './views1.js';
import './evolution.css';

const POLL_MS = 8000;

const cache = {
  caps: null,
  agents: [],
  agentId: '',
  policy: null,
  experiments: [],
  selectedId: '',
  detail: null,
  versions: null,
  observations: [],
  error: '',
  loadedAt: 0,
};

const STATUS_TONE = {
  proposed: '', workspace_ready: '', modified: '', testing: 'warn', test_failed: 'bad',
  review_required: 'warn', reviewed: 'warn', compared: 'warn', staged: 'warn', approved: 'ok',
  deployed: 'ok', rolled_back: 'bad', rejected: 'bad', cancelled: '', blocked: 'bad',
};

const TERMINAL = ['deployed', 'rolled_back', 'rejected', 'cancelled', 'blocked'];

/** The ten stages of the cycle, in the order the specification defines them. */
const STAGES = [
  { key: 'observe', label: 'Observe', statuses: ['proposed', 'workspace_ready', 'modified', 'testing', 'test_failed', 'review_required', 'reviewed', 'compared', 'staged', 'approved', 'deployed'] },
  { key: 'diagnose', label: 'Diagnose', statuses: ['workspace_ready', 'modified', 'testing', 'test_failed', 'review_required', 'reviewed', 'compared', 'staged', 'approved', 'deployed'] },
  { key: 'plan', label: 'Plan', statuses: ['workspace_ready', 'modified', 'testing', 'test_failed', 'review_required', 'reviewed', 'compared', 'staged', 'approved', 'deployed'] },
  { key: 'workspace', label: 'Working copy', statuses: ['workspace_ready', 'modified', 'testing', 'test_failed', 'review_required', 'reviewed', 'compared', 'staged', 'approved', 'deployed'] },
  { key: 'modify', label: 'Rewrite', statuses: ['modified', 'testing', 'test_failed', 'review_required', 'reviewed', 'compared', 'staged', 'approved', 'deployed'] },
  { key: 'test', label: 'Test', statuses: ['review_required', 'reviewed', 'compared', 'staged', 'approved', 'deployed'] },
  { key: 'review', label: 'Peer review', statuses: ['reviewed', 'compared', 'staged', 'approved', 'deployed'] },
  { key: 'compare', label: 'Compare', statuses: ['compared', 'staged', 'approved', 'deployed'] },
  { key: 'promote', label: 'Promote', statuses: ['staged', 'approved', 'deployed'] },
  { key: 'monitor', label: 'Monitor', statuses: ['deployed', 'rolled_back'] },
];

const ageLabel = (ms) => {
  const s = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};
const when = (ts) => (ts ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

const fail = (error) => (error instanceof ApiError
  ? error.body?.code === 'approval-required' ? `${error.message} — ask a reviewer to approve it, then a deploy holder to publish it.`
    : error.body?.code === 'level' ? `${error.message}. An Owner can raise the level on this screen.`
      : error.message
  : String(error?.message || error));

/* ---------- data ---------- */

async function refresh({ quiet = false } = {}) {
  if (!isApiMode()) { cache.error = ''; return; }
  try {
    const [caps, agents] = await Promise.all([api.evolutionCapabilities(), api.evolutionAgents()]);
    cache.caps = caps.body;
    cache.agents = agents.body?.agents || [];
    if (!cache.agents.some((a) => a.id === cache.agentId)) cache.agentId = cache.agents[0]?.id || '';
    if (cache.agentId) {
      const [policy, experiments, versions, observations] = await Promise.all([
        api.evolutionPolicy(cache.agentId),
        api.evolutionExperiments(cache.agentId),
        api.evolutionVersions(cache.agentId),
        api.evolutionObservations(cache.agentId),
      ]);
      cache.policy = policy.body;
      cache.experiments = experiments.body?.experiments || [];
      cache.versions = versions.body || { versions: [], active: null };
      cache.observations = observations.body?.observations || [];
      if (cache.selectedId && !cache.experiments.some((e) => e.id === cache.selectedId)) cache.selectedId = '';
      cache.detail = cache.selectedId ? (await api.evolutionExperiment(cache.selectedId)).body : null;
    }
    cache.error = '';
    cache.loadedAt = Date.now();
  } catch (error) {
    /* A failed read must not leave yesterday's experiments looking current. */
    cache.error = fail(error);
    cache.experiments = [];
    cache.detail = null;
    cache.selectedId = '';
    cache.versions = null;
    cache.observations = [];
    cache.policy = null;
    if (!quiet) throw error;
  }
}

/* A control is only offered when the gateway is readable AND the principal holds the permission:
 * a failed read must never leave a button that would act on data the panel could not verify. */
const readable = () => isApiMode() && !cache.error;
const canRun = () => readable() && isAuthenticated() && can('evolution:run');
const canReview = () => readable() && isAuthenticated() && can('evolution:review');
const canApprove = () => readable() && isAuthenticated() && can('evolution:approve');
const canDeploy = () => readable() && isAuthenticated() && can('evolution:deploy');
const canPolicy = () => readable() && isAuthenticated() && can('evolution:policy');
const levelCan = (ability) => Boolean(cache.policy?.capabilities?.[ability]);

/* ---------- markup ---------- */

function bannerHTML() {
  if (!isApiMode()) {
    return `<div class="evo-note warn">${icon('shield', 16)}<div><strong>Self-improvement runs on the gateway.</strong>
      This screen reads real policies, experiments and evidence from the gateway API. Nothing is simulated here.
      <button class="btn sm" data-act="open-settings" style="margin-top:8px">Connect a gateway</button></div></div>`;
  }
  if (!isAuthenticated()) {
    return `<div class="evo-note warn">${icon('shield', 16)}<div><strong>Sign in to inspect agents.</strong>
      Policies, experiments and diffs are only readable with a session.</div></div>`;
  }
  if (cache.error) {
    return `<div class="evo-note bad">${icon('bell', 16)}<div><strong>Gateway not readable:</strong> ${esc(cache.error)}
      <button class="btn sm" data-act="evo-refresh" style="margin-top:8px">${icon('refresh', 14)} Try again</button></div></div>`;
  }
  const active = cache.experiments.filter((e) => !TERMINAL.includes(e.status)).length;
  return `<div class="evo-note ok">${icon('shield', 16)}<div><strong>Every agent has a self-improvement policy.</strong>
    ${esc(cache.caps?.note || '')}
    <div class="tiny muted" style="margin-top:6px">${cache.agents.length} agents · ${active} open experiment${active === 1 ? '' : 's'} for this agent
      · sandbox: ${esc(cache.caps?.sandbox?.label || 'unknown')}</div></div></div>`;
}

function agentTabsHTML() {
  if (!cache.agents.length) return '';
  return `<div class="evo-agents" role="tablist" aria-label="Agents">
    ${cache.agents.map((a) => `
      <button class="evo-agent ${a.id === cache.agentId ? 'on' : ''}" role="tab" aria-selected="${a.id === cache.agentId}"
        data-act="evo-agent" data-id="${esc(a.id)}">
        <span class="evo-agent-name">${esc(a.name || a.id)}</span>
        <span class="evo-agent-level">L${a.policy?.level ?? 1} · ${esc(a.policy?.levelLabel || '')}</span>
        ${a.activeExperiment ? '<span class="evo-dot" aria-label="experiment open"></span>' : ''}
      </button>`).join('')}
    </div>`;
}

function policyHTML() {
  const p = cache.policy;
  if (!p) return '';
  const allowed = Object.entries(p.capabilities || {}).filter(([, v]) => v).map(([k]) => k);
  const denied = Object.entries(p.capabilities || {}).filter(([, v]) => !v).map(([k]) => k);
  const levelOptions = (cache.caps?.levels || []).map((l) => `<option value="${l.id}" ${l.id === p.level ? 'selected' : ''}>L${l.id} · ${esc(l.label)}</option>`).join('');
  return `
    <div class="card evo-policy">
      <div class="evo-policy-head">
        <span class="chip ${p.enabled ? 'ok' : 'bad'}">${p.enabled ? 'Self-modification on' : 'Self-modification off'}</span>
        <span class="chip brand">Level ${p.level} · ${esc(p.levelLabel)}</span>
      </div>
      <p class="small muted" style="margin:8px 0 10px">${esc(p.levelSummary)}</p>
      <div class="evo-facts">
        ${fact('May do', allowed.join(' · ') || 'nothing')}
        ${fact('May not do', denied.join(' · ') || 'nothing')}
        ${fact('Authorised scope', p.scope.join('\n'))}
        ${fact('Reviews required', p.requireReviews ? 'yes, independent' : 'no')}
        ${fact('Health check', p.healthCheck?.command || 'not configured — no automatic rollback')}
        ${fact('Limits', `${p.limits.maxExperimentsPerDay}/day · ${p.limits.maxTestRuns} test runs · ${Math.round(p.limits.maxRuntimeMs / 1000)}s per run`)}
      </div>
      ${canPolicy() ? `
        <details class="evo-step">
          <summary>${icon('gear', 15)} Change authority <span class="tiny muted">Owner only</span></summary>
          <div class="evo-form">
            <label>Autonomy level
              <select id="evo-level" class="input">${levelOptions}</select>
            </label>
            <label class="evo-check"><input type="checkbox" id="evo-confirm"> I understand level 3+ can stage or deploy without my approval</label>
            <label>Health check command
              <input id="evo-health" class="input" value="${esc(p.healthCheck?.command || '')}" placeholder="node agents/…/health.mjs">
            </label>
            <label class="evo-check"><input type="checkbox" id="evo-auto-stage" ${p.allowAutoStage ? 'checked' : ''}> Allow staging without a human</label>
            <label class="evo-check"><input type="checkbox" id="evo-auto-deploy" ${p.allowAutoDeploy ? 'checked' : ''}> Allow automatic deployment of low-risk candidates</label>
            <div class="evo-actions">
              <button class="btn sm primary" data-act="evo-save-policy">Save authority</button>
              <button class="btn sm" data-act="evo-toggle" data-on="${p.enabled ? '1' : '0'}">${p.enabled ? 'Disable' : 'Enable'} self-modification</button>
            </div>
            <p class="tiny muted">Raising a level is logged, and an agent can never change its own policy — the gateway refuses it.</p>
          </div>
        </details>` : `<p class="tiny muted" style="margin-top:8px">Only an Owner can change autonomy. The level above is what the gateway enforces right now.</p>`}
    </div>`;
}

const fact = (label, value) => `<div class="evo-fact"><span class="tiny muted">${esc(label)}</span><span class="small break">${esc(value || '—')}</span></div>`;

function sandboxHTML() {
  const s = cache.caps?.sandbox;
  if (!s) return '';
  return `
    <details class="card evo-step">
      <summary>${icon('cpu', 15)} Sandbox <span class="chip tiny ${s.isolation === 'process' ? 'warn' : 'ok'}">${esc(s.isolation)}</span></summary>
      <p class="small muted">${esc(s.label)}. ${esc(s.recommendation)}</p>
      <div class="evo-section">Enforced</div>
      <ul class="evo-list">${(s.enforced || []).map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
      <div class="evo-section">Not enforced — stated, not hidden</div>
      <ul class="evo-list evo-list-warn">${(s.notEnforced || []).map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
    </details>`;
}

function newExperimentHTML() {
  if (!canRun()) return '';
  return `
    <details class="card evo-step">
      <summary>${icon('plus', 15)} Open an experiment <span class="tiny muted">observe → diagnose → plan</span></summary>
      <div class="evo-form">
        <label>Title <input id="evo-title" class="input" placeholder="Fix the greeting defect"></label>
        <label>Problem (20+ characters) <textarea id="evo-problem" class="input" rows="2" placeholder="greet() returns “hi Ada”; the suite expects “Hello, Ada”"></textarea></label>
        <label>Files in scope, one per line <textarea id="evo-files" class="input evo-mono" rows="2" placeholder="agents/demo-writer/greet.mjs"></textarea></label>
        <button class="btn sm primary" data-act="evo-create">Open experiment</button>
        <p class="tiny muted">Files outside this agent’s authorised scope are refused by the gateway before any work starts.
        Protected components (permissions, audit, sandbox controls) cannot be opened as candidates at all.</p>
      </div>
    </details>`;
}

function observationsHTML() {
  const obs = cache.observations || [];
  return `
    <details class="card evo-step" ${obs.length ? '' : 'open'}>
      <summary>${icon('search', 15)} Observed evidence <span class="tiny muted">${obs.length}</span></summary>
      ${obs.length ? `<ul class="evo-list">${obs.slice(0, 6).map((o) => `
        <li><span class="chip tiny ${o.measured ? 'ok' : 'warn'}">${o.measured ? 'measured' : 'assumption'}</span>
          <span class="small break">${esc(o.detail)}</span>
          <span class="tiny muted">${esc(o.source)} · ${esc(when(o.created_at))}</span></li>`).join('')}</ul>`
        : '<p class="small muted">No observations yet. A diagnosis needs at least one piece of measured evidence — the gateway refuses assumptions.</p>'}
      ${canRun() ? `<div class="evo-form" style="margin-top:10px">
        <label>Record an observation
          <input id="evo-obs-detail" class="input" placeholder="task failed: greet() returned “hi Ada”">
        </label>
        <button class="btn sm" data-act="evo-observe">Record</button>
      </div>` : ''}
    </details>`;
}

function experimentsHTML() {
  if (!cache.experiments.length) {
    return `<div class="card evo-empty">${icon('spark', 20)}<div class="small strong">No experiments yet</div>
      <div class="tiny muted">Open one above. The gateway will keep the baseline untouched and put every change, test run and review in the record.</div></div>`;
  }
  return cache.experiments.map((e) => `
    <button class="evo-exp ${e.id === cache.selectedId ? 'on' : ''}" data-act="evo-select" data-id="${esc(e.id)}"
      aria-label="${esc(`${e.title} — ${e.statusLabel}`)}">
      <div class="evo-exp-top">
        <span class="chip tiny ${STATUS_TONE[e.status] ?? ''}">${esc(e.statusLabel)}</span>
        <span class="chip tiny">L${e.level}</span>
        ${e.risk && e.risk !== 'unknown' ? `<span class="chip tiny ${e.risk === 'low' ? 'ok' : 'warn'}">${esc(e.risk)} risk</span>` : ''}
        <span class="tiny muted evo-exp-time">${esc(ageLabel(Date.now() - e.updatedAt))}</span>
      </div>
      <div class="small strong evo-clamp">${esc(e.title)}</div>
      <div class="tiny muted evo-clamp">${esc(e.blocker || e.problem)}</div>
      <div class="evo-exp-foot tiny muted">
        <span>${e.files.length} file${e.files.length === 1 ? '' : 's'}</span>
        <span>${e.diffLines} diff lines</span>
        <span>${e.testRuns} test run${e.testRuns === 1 ? '' : 's'}</span>
        <span>${e.reviews.length} review${e.reviews.length === 1 ? '' : 's'}</span>
      </div>
    </button>`).join('');
}

function stageBarHTML(e) {
  return `<div class="evo-stages" role="list">
    ${STAGES.map((s) => {
      const done = s.statuses.includes(e.status) && (s.key !== 'promote' || ['staged', 'approved', 'deployed'].includes(e.status));
      const current = (e.status === 'proposed' && s.key === 'observe')
        || (e.status === 'workspace_ready' && s.key === 'workspace')
        || (e.status === 'modified' && s.key === 'modify')
        || (e.status === 'testing' && s.key === 'test')
        || (e.status === 'test_failed' && s.key === 'test')
        || (e.status === 'review_required' && s.key === 'review')
        || (e.status === 'reviewed' && s.key === 'review')
        || (e.status === 'compared' && s.key === 'compare')
        || (['staged', 'approved'].includes(e.status) && s.key === 'promote')
        || (e.status === 'deployed' && s.key === 'monitor');
      return `<span class="evo-stage ${done ? 'done' : ''} ${current ? 'current' : ''}" role="listitem">
        <span class="evo-stage-dot" aria-hidden="true"></span>${esc(s.label)}</span>`;
    }).join('')}
  </div>`;
}

function detailHTML() {
  const e = cache.detail;
  if (!e) {
    return `<div class="card evo-empty"><div class="small strong">Nothing selected</div>
      <div class="tiny muted">Pick an experiment to see its diagnosis, diff, test output, reviews and evidence.</div></div>`;
  }
  const finished = TERMINAL.includes(e.status);
  const tests = e.tests || {};
  const compare = e.compare || {};
  const needsAnnotation = (e.integrity?.findings || []).length > 0;

  return `
    <div class="card evo-detail">
      <div class="evo-exp-top">
        <span class="chip ${STATUS_TONE[e.status] ?? ''}">${esc(e.statusLabel)}</span>
        <span class="chip tiny">L${e.level} · ${esc(e.levelLabel)}</span>
        <span class="tiny muted evo-exp-time">updated ${esc(ageLabel(Date.now() - e.updatedAt))}</span>
      </div>
      <h3 class="evo-title">${esc(e.title)}</h3>
      <p class="small muted">${esc(e.problem)}</p>
      ${stageBarHTML(e)}
      ${e.blocker ? `<div class="evo-blocker">${icon('shield', 15)}<span class="small">${esc(e.blocker)}</span></div>` : ''}

      <div class="evo-actions">
        ${!finished && canRun() && e.status === 'proposed' ? `<button class="btn sm" data-act="evo-step" data-step="workspace">${icon('folder', 14)} Create working copy</button>` : ''}
        ${!finished && canRun() && ['workspace_ready', 'modified', 'test_failed'].includes(e.status) ? `<button class="btn sm" data-act="evo-run-tests">${icon('play', 14)} Run tests</button>` : ''}
        ${!finished && canRun() && ['reviewed', 'review_required', 'test_failed', 'modified'].includes(e.status) ? `<button class="btn sm" data-act="evo-step" data-step="compare">${icon('chart', 14)} Compare</button>` : ''}
        ${!finished && canRun() && ['compared', 'reviewed'].includes(e.status) ? `<button class="btn sm" data-act="evo-step" data-step="request-approval">${icon('bell', 14)} Request approval</button>` : ''}
        ${!finished && canRun() && e.status === 'compared' ? `<button class="btn sm" data-act="evo-step" data-step="stage">${icon('upload', 14)} Stage</button>` : ''}
        ${!finished && canDeploy() && ['approved', 'compared', 'staged'].includes(e.status) ? `<button class="btn sm primary" data-act="evo-deploy" data-id="${esc(e.id)}">${icon('check', 14)} Deploy</button>` : ''}
        ${!finished && canRun() ? `<button class="btn sm" data-act="evo-cancel" data-id="${esc(e.id)}">${icon('stop', 14)} Stop</button>` : ''}
      </div>

      <details class="evo-step" ${e.diagnosis?.problem ? '' : 'open'}>
        <summary>${icon('search', 15)} Diagnosis ${e.diagnosis?.rootCause ? '<span class="chip tiny ok">recorded</span>' : '<span class="chip tiny warn">missing</span>'}</summary>
        ${e.diagnosis?.problem ? `<div class="evo-facts">
          ${fact('Observed problem', e.diagnosis.problem)}
          ${fact('Root cause', e.diagnosis.rootCause)}
          ${fact('Proposed solution', e.diagnosis.solution)}
          ${fact('Evidence', (e.diagnosis.evidence || []).map((v) => `${v.measured ? '✓' : '?'} ${v.detail}`).join('\n'))}
          ${fact('Possible regressions', (e.diagnosis.regressions || []).join('\n'))}
        </div>` : `<div class="evo-form">
          <label>Problem <input id="evo-diag-problem" class="input" placeholder="greet() returns “hi Ada”"></label>
          <label>Evidence (required) <textarea id="evo-diag-evidence" class="input" rows="2" placeholder="node agents/…/greet.test.mjs → 3 failing, exit 1"></textarea></label>
          <label>Root cause <input id="evo-diag-cause" class="input" placeholder="the template says “hi ${'${name}'}”"></label>
          <label>Solution <input id="evo-diag-solution" class="input" placeholder="use “Hello, ${'${name}'}”"></label>
          <button class="btn sm" data-act="evo-diagnose" data-id="${esc(e.id)}">Record diagnosis</button>
          <p class="tiny muted">A diagnosis without measured evidence is refused by the gateway.</p>
        </div>`}
      </details>

      <details class="evo-step" ${e.plan?.outcome ? '' : ''}>
        <summary>${icon('board', 15)} Plan ${e.plan?.outcome ? '<span class="chip tiny ok">recorded</span>' : '<span class="chip tiny warn">missing</span>'}</summary>
        ${e.plan?.outcome ? `<div class="evo-facts">
          ${fact('Intended outcome', e.plan.outcome)}
          ${fact('Files', (e.plan.files || []).join('\n'))}
          ${fact('Tests', (e.plan.tests || []).join('\n'))}
          ${fact('Risks', (e.plan.risks || []).join('\n') || 'none declared')}
          ${fact('Rollback', e.plan.rollback || 'not stated')}
        </div>` : `<div class="evo-form">
          <label>Outcome <input id="evo-plan-outcome" class="input" placeholder="the greeting matches the documented behaviour"></label>
          <label>Files to change <textarea id="evo-plan-files" class="input evo-mono" rows="2"></textarea></label>
          <label>Test command <input id="evo-plan-tests" class="input" placeholder="node agents/…/greet.test.mjs"></label>
          <button class="btn sm" data-act="evo-plan" data-id="${esc(e.id)}">Record plan</button>
        </div>`}
      </details>

      <details class="evo-step" ${e.diff ? '' : 'closed'}>
        <summary>${icon('doc', 15)} Change &amp; diff <span class="tiny muted">${e.files.length} file(s), ${e.diffLines} line(s)</span></summary>
        ${Object.keys(e.changes || {}).length ? `<ul class="evo-list">${Object.entries(e.changes).map(([path, c]) => `
          <li><span class="chip tiny ${c.kind === 'deleted' ? 'bad' : c.kind === 'added' ? 'ok' : ''}">${esc(c.kind)}</span>
            <span class="evo-path break">${esc(path)}</span>
            <span class="tiny muted">+${c.added} −${c.removed}${c.reason ? ` · ${esc(c.reason)}` : ' · no reason recorded'}</span></li>`).join('')}</ul>`
          : '<p class="small muted">No changes yet.</p>'}
        ${e.diff ? `<pre class="evo-diff">${esc(e.diff)}</pre>` : ''}
        ${canRun() && !finished && e.hasWorkspace ? `<div class="evo-form" style="margin-top:10px">
          <label>File path <input id="evo-edit-path" class="input" placeholder="agents/demo-writer/greet.mjs"></label>
          <label>New content <textarea id="evo-edit-content" class="input evo-mono" rows="5"></textarea></label>
          <label>Reason for the change <input id="evo-edit-reason" class="input" placeholder="match the documented greeting"></label>
          <button class="btn sm primary" data-act="evo-edit" data-id="${esc(e.id)}">Save to candidate</button>
          <p class="tiny muted">This writes to the isolated working copy only. The repository is never modified by the gateway.</p>
        </div>` : ''}
      </details>

      <details class="evo-step" ${tests.runs?.length ? '' : ''}>
        <summary>${icon('terminal', 15)} Tests
          ${tests.passed ? '<span class="chip tiny ok">passing</span>' : tests.runs?.length ? '<span class="chip tiny bad">failing</span>' : '<span class="chip tiny">not run</span>'}
          <span class="tiny muted">${e.testRuns} run(s)</span></summary>
        ${tests.runs?.length ? `<ul class="evo-list">${tests.runs.slice().reverse().map((r) => `
          <li><span class="chip tiny ${r.ok ? 'ok' : 'bad'}">${r.ok ? 'pass' : r.timedOut ? 'timeout' : 'fail'}</span>
            <span class="evo-path break">${esc(r.command)}</span>
            <span class="tiny muted">${esc(when(r.at))} · ${Math.round(r.durationMs / 100) / 10}s · exit ${esc(String(r.code ?? '—'))}</span>
            ${r.stdout ? `<pre class="evo-output">${esc(r.stdout.slice(-1200))}</pre>` : ''}
          </li>`).join('')}</ul>` : '<p class="small muted">No test run yet. The gateway refuses a promotion without one.</p>'}
        ${canRun() && !finished ? `<div class="evo-form">
          <label>Command <input id="evo-test-command" class="input" value="${esc(e.plan?.tests?.[0] || '')}" placeholder="node agents/…/greet.test.mjs"></label>
          <button class="btn sm" data-act="evo-run-tests">${icon('play', 14)} Run in sandbox</button>
        </div>` : ''}
        ${(e.integrity?.findings || []).length ? `<div class="evo-blocker warn">${icon('shield', 15)}<span class="small">Test evidence changed:
          ${(e.integrity.findings).map((f) => esc(f.detail)).join(' ')}</span></div>` : ''}
      </details>

      <details class="evo-step">
        <summary>${icon('team', 15)} Peer review <span class="tiny muted">${e.reviews.length}</span>
          ${e.reviews.some((r) => r.verdict !== 'approve') ? '<span class="chip tiny warn">objection</span>' : e.reviews.length ? '<span class="chip tiny ok">approved</span>' : ''}</summary>
        ${e.reviews.length ? `<ul class="evo-list">${e.reviews.map((r) => `
          <li><span class="chip tiny ${r.verdict === 'approve' ? 'ok' : 'warn'}">${esc(r.verdict)}</span>
            <span class="strong small">${esc(r.reviewer)}</span>
            <span class="tiny muted">${esc(when(r.created_at))}${r.independent ? ' · independent' : ' · not independent'}</span>
            ${(r.findings || []).length ? `<ul class="evo-list">${r.findings.map((f) => `<li class="tiny">${esc(f)}</li>`).join('')}</ul>` : ''}</li>`).join('')}</ul>`
          : '<p class="small muted">No review yet. An agent cannot review its own change, and the gateway refuses it.</p>'}
        ${canReview() && !finished ? `<div class="evo-form">
          <label>Reviewer agent <input id="evo-reviewer" class="input" placeholder="demo-reviewer"></label>
          <label>Findings, one per line <textarea id="evo-findings" class="input" rows="2"></textarea></label>
          <div class="evo-actions">
            <button class="btn sm" data-act="evo-review" data-verdict="approve">Approve</button>
            <button class="btn sm" data-act="evo-review" data-verdict="changes-required">Changes required</button>
          </div>
        </div>` : ''}
      </details>

      <details class="evo-step" ${compare.candidateVersion ? '' : ''}>
        <summary>${icon('chart', 15)} Comparison ${compare.candidateVersion ? `<span class="chip tiny ${compare.risk?.level === 'low' ? 'ok' : 'warn'}">${esc(compare.risk?.level || 'unknown')} risk</span>` : ''}</summary>
        ${compare.candidateVersion ? `<div class="evo-facts">
          ${fact('Baseline', e.baseVersion || '—')}
          ${fact('Candidate', compare.candidateVersion)}
          ${fact('Tests', compare.evidence?.testsPassed ? `passing — ${compare.evidence.lastSummary || ''}` : 'no passing run')}
          ${fact('Reviews', `${compare.evidence?.approvals || 0} approve · ${compare.evidence?.objections || 0} object`) }
          ${fact('Diff', `${compare.evidence?.diffFiles || 0} file(s), ${compare.evidence?.diffLines || 0} line(s)`)}
          ${fact('Risk', `${compare.risk?.level || 'unknown'} — ${compare.risk?.reason || ''}`)}
        </div>
        <div class="evo-section">Coverage of the evidence</div>
        <p class="small">${esc(compare.coverage || '')}</p>
        <div class="evo-section">Limitations</div>
        <ul class="evo-list evo-list-warn">${(compare.limitations || []).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '<p class="small muted">Not compared yet.</p>'}
      </details>

      <details class="evo-step">
        <summary>${icon('check', 15)} Approval ${e.approval?.decision ? `<span class="chip tiny ${e.approval.decision === 'approve' ? 'ok' : 'bad'}">${esc(e.approval.decision)}</span>` : e.approval?.pending ? '<span class="chip tiny warn">pending</span>' : ''}</summary>
        ${e.approval?.pending ? `<p class="small">Requested by ${esc(e.approval.requestedBy)} ${esc(when(e.approval.requestedAt))}${(e.approval.blockers || []).length ? ` — open blockers: ${esc((e.approval.blockers || []).join('; '))}` : ''}</p>` : ''}
        ${e.approval?.decision ? `<p class="small">${esc(e.approval.decision)} by ${esc(e.approval.decidedBy)} ${esc(when(e.approval.decidedAt))}${e.approval.note ? ` — ${esc(e.approval.note)}` : ''}</p>`
          : '<p class="small muted">No decision recorded. Deployment stays blocked until the policy is satisfied.</p>'}
        ${canApprove() ? `<div class="evo-actions">
          <button class="btn sm primary" data-act="evo-approve" data-decision="approve">Approve</button>
          <button class="btn sm" data-act="evo-approve" data-decision="reject">Reject</button>
        </div>` : ''}
      </details>

      <details class="evo-step">
        <summary>${icon('hash', 15)} Timeline <span class="tiny muted">${e.events.length}</span></summary>
        <div class="evo-timeline">
          ${e.events.slice().reverse().map((ev) => `<div class="evo-row">
            <span class="evo-dot ${ev.status === 'bad' ? 'bad' : ev.status === 'ok' ? 'ok' : ev.status === 'warn' ? 'warn' : ''}" aria-hidden="true"></span>
            <div class="grow"><div class="tiny"><span class="strong">${esc(ev.stage)}</span> <span class="muted">${esc(when(ev.ts))} · ${esc(ev.actor)}</span></div>
              <div class="tiny muted break">${esc(ev.detail)}</div></div></div>`).join('')}
        </div>
      </details>
    </div>`;
}

function versionsHTML() {
  const v = cache.versions;
  if (!v || !v.versions.length) return '';
  return `
    <details class="card evo-step" ${v.active ? '' : ''}>
      <summary>${icon('graph', 15)} Versions &amp; rollback
        ${v.active ? `<span class="chip tiny ok">${esc(v.active.versionId)} live</span>` : '<span class="chip tiny">nothing deployed</span>'}</summary>
      <ul class="evo-list">${v.versions.map((ver) => `
        <li><span class="chip tiny ${ver.status === 'deployed' ? 'ok' : ver.status === 'rolled_back' ? 'bad' : ''}">${esc(ver.status)}</span>
          <span class="strong small">${esc(ver.id)}</span>
          <span class="tiny muted">${esc(when(ver.created_at))} · ${Object.keys(ver.files || {}).length} file(s)</span>
          <div class="tiny muted break">${esc(ver.evidence?.tests || 'no test evidence')}</div>
          ${Object.keys(ver.health || {}).length ? `<div class="tiny muted">health: ${esc(ver.health.summary || (ver.health.ok ? 'ok' : 'failed'))}</div>` : ''}</li>`).join('')}</ul>
      ${canRun() ? `<div class="evo-actions"><button class="btn sm" data-act="evo-health" data-id="${esc(cache.agentId)}">${icon('shield', 14)} Run health check</button></div>` : ''}
      ${canDeploy() && v.versions.some((x) => x.status !== 'deployed') ? `<div class="evo-actions"><button class="btn sm" data-act="evo-rollback" data-id="${esc(cache.agentId)}">${icon('undo', 14)} Roll back to the previous version</button></div>` : ''}
      <p class="tiny muted">A rollback restores the previous published version and keeps every audit record. Reverting source code does not reverse database migrations or external side effects — those need their own recovery plan.</p>
    </details>`;
}

/* ---------- view ---------- */

views.evolution = {
  title: 'Self-Improvement',
  render(params = {}) {
    if (params?.id && params.id !== cache.agentId && cache.agents.some((a) => a.id === params.id)) {
      cache.agentId = params.id;
      cache.detail = null;
      cache.selectedId = '';
    }
    return `
      <div class="page-head">
        <h1>Self-Improvement</h1>
        <div class="sub">Autonomous code evolution with a sandbox, independent review, approvals and rollback —
          ${cache.agents.length ? `${cache.agents.length} agents` : 'gateway required'}</div>
      </div>
      <div id="evo-status">${bannerHTML()}</div>
      ${agentTabsHTML()}
      <div class="evo-grid">
        <div class="evo-col">
          ${policyHTML()}
          ${observationsHTML()}
          ${newExperimentHTML()}
          ${sandboxHTML()}
          ${versionsHTML()}
        </div>
        <div class="evo-col">
          <div class="evo-section">Experiments</div>
          <div id="evo-list" class="evo-list-wrap">${experimentsHTML()}</div>
          <div id="evo-detail">${detailHTML()}</div>
        </div>
      </div>
      <p class="tiny muted evo-foot">An agent may inspect, diagnose and propose. Writing, testing, reviewing,
        approving, staging and deploying are separate authorities the platform enforces — an agent can never
        grant itself more, approve its own change, or edit the checks that limit it.</p>`;
  },
  async mount() {
    if (!isApiMode()) return;
    await refresh({ quiet: true });
    const { rerender } = await import('./main.js');
    rerender();
    startPolling();
  },
};

/* ---------- polling ---------- */

let timer = null;
function startPolling() {
  stopPolling();
  timer = setInterval(async () => {
    if (!document.getElementById('evo-status')) { stopPolling(); return; }
    await refresh({ quiet: true });
    paint();
  }, POLL_MS);
}
function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Repaint only the data regions, so an open form is never wiped while it is being typed into. */
function paint() {
  const status = document.getElementById('evo-status');
  if (status) status.innerHTML = bannerHTML();
  const list = document.getElementById('evo-list');
  if (list) list.innerHTML = experimentsHTML();
  const detail = document.getElementById('evo-detail');
  if (detail) detail.innerHTML = detailHTML();
}

/* ---------- actions ---------- */

const rerender = () => import('./main.js').then((m) => m.rerender()).catch(() => {});
const val = (id) => document.getElementById(id)?.value ?? '';

async function step(id, name, body = {}) {
  try {
    await api.evolutionStep(id, name, body);
    toast(`Recorded: ${name.replace(/-/g, ' ')}`, 'ok');
    await refresh({ quiet: true });
    await rerender();
  } catch (error) {
    toast(fail(error), 'bad');
  }
}

on('evo-refresh', async () => { await refresh({ quiet: true }); await rerender(); });

on('evo-agent', async (el, ds) => {
  cache.agentId = ds.id;
  cache.selectedId = '';
  cache.detail = null;
  await refresh({ quiet: true });
  await rerender();
});

on('evo-select', async (el, ds) => {
  cache.selectedId = cache.selectedId === ds.id ? '' : ds.id;
  cache.detail = null;
  if (cache.selectedId) {
    try { cache.detail = (await api.evolutionExperiment(cache.selectedId)).body; } catch (error) { toast(fail(error), 'bad'); }
  }
  await rerender();
});

on('evo-save-policy', async () => {
  const level = Number(val('evo-level'));
  const body = {
    level,
    confirmHigher: document.getElementById('evo-confirm')?.checked === true,
    allowAutoStage: document.getElementById('evo-auto-stage')?.checked === true,
    allowAutoDeploy: document.getElementById('evo-auto-deploy')?.checked === true,
  };
  const health = val('evo-health').trim();
  if (health) body.healthCheck = { command: health };
  try {
    const out = await api.updateEvolutionPolicy(cache.agentId, body);
    toast(`Authority now: L${out.body.after.level} · ${out.body.after.levelLabel}`, 'ok');
    await refresh({ quiet: true });
    await rerender();
  } catch (error) {
    toast(fail(error), 'bad');
  }
});

on('evo-toggle', async (el) => {
  const next = el.dataset.on !== '1';
  try {
    await api.updateEvolutionPolicy(cache.agentId, { enabled: next });
    toast(next ? 'Self-modification enabled' : 'Self-modification disabled', 'ok');
    await refresh({ quiet: true });
    await rerender();
  } catch (error) {
    toast(fail(error), 'bad');
  }
});

on('evo-observe', async () => {
  const detail = val('evo-obs-detail').trim();
  if (detail.length < 5) { toast('Describe what was observed (5+ characters)', 'bad'); return; }
  try {
    await api.recordEvolutionObservation(cache.agentId, { source: 'task-failure', detail, measured: true });
    toast('Observation recorded', 'ok');
    await refresh({ quiet: true });
    await rerender();
  } catch (error) {
    toast(fail(error), 'bad');
  }
});

on('evo-create', async () => {
  const files = val('evo-files').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!files.length) { toast('Name at least one file in scope', 'bad'); return; }
  try {
    const out = await api.createEvolutionExperiment({
      agentId: cache.agentId,
      title: val('evo-title').trim(),
      problem: val('evo-problem').trim(),
      files,
    });
    cache.selectedId = out.body.id;
    cache.detail = out.body;
    toast('Experiment opened — the baseline is untouched', 'ok');
    await refresh({ quiet: true });
    await rerender();
  } catch (error) {
    toast(fail(error), 'bad');
  }
});

on('evo-diagnose', async (el, ds) => {
  const evidence = val('evo-diag-evidence').split('\n').map((l) => l.trim()).filter(Boolean).map((detail) => ({ detail, measured: true }));
  if (!evidence.length) { toast('A diagnosis needs evidence — “it feels slow” is not evidence', 'bad'); return; }
  await step(ds.id, 'diagnose', {
    problem: val('evo-diag-problem').trim() || 'the observed problem',
    evidence,
    rootCause: val('evo-diag-cause').trim(),
    solution: val('evo-diag-solution').trim(),
  });
});

on('evo-plan', async (el, ds) => {
  const files = val('evo-plan-files').split('\n').map((l) => l.trim()).filter(Boolean);
  await step(ds.id, 'plan', {
    outcome: val('evo-plan-outcome').trim(),
    files,
    tests: val('evo-plan-tests').trim() ? [val('evo-plan-tests').trim()] : [],
  });
});

on('evo-step', async (el, ds) => step(ds.id, ds.step));

on('evo-run-tests', async () => {
  const id = cache.detail?.id;
  if (!id) return;
  const command = val('evo-test-command').trim() || cache.detail?.plan?.tests?.[0] || '';
  if (!command) { toast('Give the sandbox a command to run', 'bad'); return; }
  try {
    const out = await api.evolutionStep(id, 'test', { command });
    toast(out.body.tests?.passed ? 'Tests passed — the result is recorded' : 'Tests failed — the failure is recorded', out.body.tests?.passed ? 'ok' : 'bad');
    await refresh({ quiet: true });
    await rerender();
  } catch (error) {
    toast(fail(error), 'bad');
  }
});

on('evo-edit', async (el, ds) => {
  const path = val('evo-edit-path').trim();
  const content = val('evo-edit-content');
  const reason = val('evo-edit-reason').trim();
  if (!path) { toast('Give the file path', 'bad'); return; }
  if (!reason) { toast('Every change needs a reason a reviewer can check', 'bad'); return; }
  try {
    await api.evolutionStep(ds.id, 'edit', { path, content, reason });
    toast('Written to the isolated candidate', 'ok');
    await refresh({ quiet: true });
    await rerender();
  } catch (error) {
    toast(fail(error), 'bad');
  }
});

on('evo-review', async (el, ds) => {
  const findings = val('evo-findings').split('\n').map((l) => l.trim()).filter(Boolean);
  try {
    await api.evolutionStep(cache.detail.id, 'review', {
      reviewer: val('evo-reviewer').trim(),
      verdict: ds.verdict,
      findings,
    });
    toast(ds.verdict === 'approve' ? 'Approval recorded' : 'Objection recorded', 'ok');
    await refresh({ quiet: true });
    await rerender();
  } catch (error) {
    toast(fail(error), 'bad');
  }
});

on('evo-approve', async (el, ds) => {
  try {
    await api.evolutionStep(cache.detail.id, 'approve', { decision: ds.decision });
    toast(ds.decision === 'approve' ? 'Approved — deployment is still a separate authority' : 'Rejected', ds.decision === 'approve' ? 'ok' : '');
    await refresh({ quiet: true });
    await rerender();
  } catch (error) {
    toast(fail(error), 'bad');
  }
});

on('evo-deploy', async (el, ds) => {
  try {
    const out = await api.evolutionStep(ds.id, 'deploy');
    toast(`Deployed ${out.body.version?.id || 'candidate'}`, 'ok');
    await refresh({ quiet: true });
    await rerender();
  } catch (error) {
    toast(fail(error), 'bad');
  }
});

on('evo-cancel', async (el, ds) => {
  try {
    await api.evolutionStep(ds.id, 'cancel', { reason: 'stopped from the Self-Improvement panel' });
    toast('Experiment stopped', '');
    await refresh({ quiet: true });
    await rerender();
  } catch (error) {
    toast(fail(error), 'bad');
  }
});

on('evo-health', async () => {
  try {
    const out = await api.evolutionHealth(cache.agentId);
    toast(out.body.rolledBack ? 'Health failed — rolled back automatically' : `Health: ${out.body.ok ? 'passing' : 'failing or unverified'}`, out.body.ok ? 'ok' : 'bad');
    await refresh({ quiet: true });
    await rerender();
  } catch (error) {
    toast(fail(error), 'bad');
  }
});

on('evo-rollback', async () => {
  try {
    const out = await api.evolutionRollback(cache.agentId, { reason: 'manual rollback from the panel' });
    toast(`Rolled back to ${out.body.versionId}`, 'ok');
    await refresh({ quiet: true });
    await rerender();
  } catch (error) {
    toast(fail(error), 'bad');
  }
});

export const evolutionInternals = { cache, refresh, paint, fail, STAGES };
