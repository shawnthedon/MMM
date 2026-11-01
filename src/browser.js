/* ============ Agent Browser — the visibility surface ============
 * A long-running autonomous browser is only acceptable if you can watch it work, see what it actually
 * observed, and stop it. That is what this screen is: objective, site, last verified milestone, time
 * since meaningful progress, recovery attempts, the current blocker, the timeline and the evidence.
 *
 * Honest contract:
 *   • with no gateway this screen says so and offers no controls (nothing is simulated here);
 *   • with no browser engine on the gateway it says which driver is missing and why — it never
 *     pretends a task is running;
 *   • the simulated driver is labelled “Simulated” on every task that used it;
 *   • “Completed” is only ever shown when the gateway verified the task's success criteria;
 *   • a task waiting for a person says what it needs, and offers the one honest action (resume/assist).
 */
import { isApiMode } from './api.js';
import { api, ApiError } from './api.js';
import { esc, icon } from './core.js';
import { openSheet, toast, on } from './shell.js';
import { views } from './views1.js';
import './browser.css';

const POLL_MS = 5000;

const cache = {
  caps: null,
  tasks: [],
  detail: null,
  selectedId: '',
  error: '',
  loadedAt: 0,
  busy: '',
};

const STATUS_TONE = {
  completed: 'ok',
  failed: 'bad',
  blocked: 'bad',
  timed_out: 'bad',
  waiting_for_user: 'warn',
  recovering: 'warn',
  running: 'brand',
  queued: '',
  paused: '',
  cancelled: '',
};

const LABEL = {
  queued: 'Queued', running: 'Running', recovering: 'Recovering', waiting_for_user: 'Needs you',
  paused: 'Paused', completed: 'Completed', failed: 'Failed', blocked: 'Blocked',
  cancelled: 'Stopped', timed_out: 'Timed out',
};

const TERMINAL = ['completed', 'failed', 'blocked', 'cancelled', 'timed_out'];

export function ageLabel(ms) {
  const s = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m ago` : `${h}h ago`;
}

const stamp = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');

/* ---------- data ---------- */

async function loadCaps() {
  if (!isApiMode()) return null;
  // The api client returns an envelope; the capability report is its body.
  const out = await api.browserCapabilities();
  cache.caps = out.body || null;
  return cache.caps;
}

async function loadTasks() {
  const out = await api.browserTasks(30);
  cache.tasks = out.body?.tasks || [];
  if (cache.selectedId && !cache.tasks.some((t) => t.id === cache.selectedId)) cache.selectedId = '';
  return cache.tasks;
}

async function loadDetail(id) {
  if (!id) {
    cache.detail = null;
    return null;
  }
  const out = await api.browserTask(id);
  cache.detail = out.body || null;
  return cache.detail;
}

async function refresh({ quiet = false } = {}) {
  if (!isApiMode()) { cache.error = ''; return; }
  try {
    await Promise.all([loadCaps(), loadTasks()]);
    if (cache.selectedId) await loadDetail(cache.selectedId);
    cache.error = '';
    cache.loadedAt = Date.now();
  } catch (error) {
    const message = error instanceof ApiError ? error.message : String(error?.message || error);
    cache.error = message;
    if (!quiet) throw error;
  }
}

/** True when this gateway can actually start a task. Nothing else may render a start button. */
function runnable() {
  if (!isApiMode() || !cache.caps) return false;
  return Boolean(cache.caps.engine) || Boolean(cache.caps.simulatedAllowed);
}

/* ---------- painting ---------- */

function paint(root = document, { updateCompose = true } = {}) {
  const banner = root.getElementById?.('bx-status');
  if (banner) banner.innerHTML = statusHTML();
  // The compose form contains live textareas. Replacing its innerHTML during the
  // five-second task poll destroys the focused node and ejects the mobile keyboard
  // cursor. Only rebuild it when explicitly requested (for example, after mount).
  if (updateCompose) {
    const compose = root.getElementById?.('bx-compose');
    if (compose) compose.innerHTML = composeHTML();
  }
  const list = root.getElementById?.('bx-list');
  if (list) list.innerHTML = listHTML();
  const detail = root.getElementById?.('bx-detail');
  if (detail) detail.innerHTML = detailHTML();
}

function statusHTML() {
  if (!isApiMode()) {
    return `<div class="bx-note warn">${icon('shield', 16)}<div><strong>The Agent Browser runs on the gateway.</strong>
      This screen reads real tasks and evidence from the gateway API — there is no local simulation of
      browsing here. <button class="btn sm" data-act="open-settings" style="margin-top:8px">Connect a gateway</button></div></div>`;
  }
  if (cache.error) {
    return `<div class="bx-note bad">${icon('bell', 16)}<div><strong>Gateway not readable:</strong> ${esc(cache.error)}
      <button class="btn sm" data-act="bx-refresh" style="margin-top:8px">${icon('refresh', 14)} Try again</button></div></div>`;
  }
  if (!cache.caps) {
    return `<div class="bx-note">${icon('globe', 16)}<div>Reading driver status from the gateway…</div></div>`;
  }
  const caps = cache.caps;
  if (caps.status === 'available') {
    return `<div class="bx-note ok">${icon('check', 16)}<div><strong>${esc(caps.engine?.label || 'Browser engine')} is ready.</strong>
      A real Chromium on the gateway host. Automation is not disguised: a site may refuse it, and when it does the task stops.</div></div>`;
  }
  const drivers = (caps.drivers || []).map((d) => `
    <li><span class="strong small">${esc(d.label)}</span> <span class="chip tiny ${d.available ? 'ok' : 'warn'}">${d.available ? 'available' : 'unavailable'}</span>
      <div class="tiny muted">${esc(d.reason || (d.available ? '' : 'not configured'))}</div></li>`).join('');
  return `<div class="bx-note warn">${icon('shield', 16)}<div><strong>No browser engine is installed on this gateway.</strong>
    Tasks cannot start until an operator installs one — this panel will not fake a session.
    <ul class="bx-drivers">${drivers}</ul>
    <code class="bx-cmd">npm install puppeteer   # or set MMM_BROWSER_CHROMIUM_PATH</code>
    <div class="tiny muted" style="margin-top:6px">Then restart the gateway and reload this panel.</div></div></div>`;
}

function composeHTML() {
  if (!isApiMode()) return '';
  if (!cache.caps) return '';
  if (!runnable()) return '';
  const drivers = (cache.caps.drivers || []).filter((d) => d.available);
  return `
    <div class="bx-compose-head">
      <div class="strong small">${icon('globe', 15)} New browser task</div>
      <button class="btn sm" data-act="bx-example">${icon('doc', 14)} Load example</button>
    </div>
    <div class="field">
      <label for="bx-objective">Objective</label>
      <textarea class="input" id="bx-objective" rows="2" placeholder="Read the price of the first plan on the pricing page"></textarea>
    </div>
    <div class="field">
      <label for="bx-criteria">Success criteria — one per line, <span class="code">key: check</span></label>
      <textarea class="input" id="bx-criteria" rows="2" placeholder="price: contains:₦4,200"></textarea>
      <div class="tiny muted">Without criteria a finished plan is a <strong>failure</strong>, not a success.</div>
    </div>
    <div class="field">
      <label for="bx-plan">Plan — JSON steps</label>
      <textarea class="input bx-mono" id="bx-plan" rows="5" placeholder='[{"action":"goto","url":"https://example.com/"},{"action":"extract","key":"heading"}]'></textarea>
      <div class="tiny muted">Actions: goto · waitFor · click · type · extract · screenshot · assert · wait. Mark a step
        <span class="code">"sensitive": true</span> if it spends money or commits a change — it is never retried.</div>
    </div>
    <div class="field">
      <label for="bx-driver">Driver</label>
      <select class="input" id="bx-driver">
        ${drivers.map((d) => `<option value="${esc(d.id)}">${esc(d.label)}${d.kind === 'test-only' ? ' — not a real browser' : ''}</option>`).join('')}
      </select>
    </div>
    <button class="btn primary block" data-act="bx-create">${icon('play', 15)} Start task</button>`;
}

function listHTML() {
  if (!isApiMode()) return '';
  if (cache.error) return '<div class="tiny muted">Not readable right now.</div>';
  if (!cache.tasks.length) {
    return `<div class="bx-empty">${icon('globe', 20)}<div class="small strong">No browser tasks yet</div>
      <div class="tiny muted">${runnable() ? 'Describe an objective above and the gateway will run it step by step.' : 'Nothing can run until a browser engine is configured on the gateway.'}</div></div>`;
  }
  return cache.tasks.map((t) => {
    const tone = STATUS_TONE[t.status] ?? '';
    const active = t.id === cache.selectedId;
    const progress = TERMINAL.includes(t.status) ? 'finished' : `last progress ${ageLabel(t.progressAgeMs)}`;
    return `<button class="bx-task ${active ? 'on' : ''}" data-act="bx-select" data-id="${esc(t.id)}"
        aria-label="${esc(`${t.objective} — ${LABEL[t.status] || t.status}`)}">
      <div class="bx-task-top">
        <span class="chip tiny ${tone}">${esc(LABEL[t.status] || t.status)}</span>
        ${t.simulated ? '<span class="chip tiny warn">Simulated</span>' : '<span class="chip tiny">Chromium</span>'}
        <span class="bx-task-time tiny muted">${esc(progress)}</span>
      </div>
      <div class="small strong bx-clamp">${esc(t.objective)}</div>
      <div class="tiny muted bx-clamp">${esc(t.lastMilestone || t.currentUrl || 'Nothing observed yet')}</div>
      <div class="bx-task-foot tiny muted">
        <span>step ${Math.min(t.stepIndex, t.totalSteps)}/${t.totalSteps}</span>
        <span>${t.actionsUsed}/${t.maxActions} actions</span>
        <span>${t.retriesUsed} retries</span>
        ${t.status === 'waiting_for_user' ? '<span class="bx-flag">needs you</span>' : ''}
      </div>
    </button>`;
  }).join('');
}

function detailHTML() {
  const task = cache.detail;
  if (!task) {
    return `<div class="bx-empty"><div class="small strong">Nothing selected</div>
      <div class="tiny muted">Pick a task to see its timeline and the evidence behind every milestone.</div></div>`;
  }
  const tone = STATUS_TONE[task.status] ?? '';
  const finished = TERMINAL.includes(task.status);
  const canPause = ['queued', 'running', 'recovering'].includes(task.status);
  const canResume = ['paused', 'waiting_for_user'].includes(task.status);
  const canAssist = task.status === 'waiting_for_user';

  return `
    <div class="bx-detail-head">
      <span class="chip tiny ${tone}">${esc(LABEL[task.status] || task.status)}</span>
      ${task.simulated ? '<span class="chip tiny warn">Simulated driver</span>' : '<span class="chip tiny">Chromium</span>'}
      <span class="bx-task-time tiny muted">${finished ? `ended ${stamp(task.endedAt)}` : `last progress ${ageLabel(task.progressAgeMs)}`}</span>
    </div>
    <div class="small strong" style="margin:8px 0 4px">${esc(task.objective)}</div>
    <div class="tiny muted break">${esc(task.currentUrl || task.entryUrl || 'no page open yet')}</div>

    ${task.blocker ? `<div class="bx-blocker ${task.status === 'completed' ? 'ok' : task.status === 'waiting_for_user' ? 'warn' : 'bad'}">
      ${icon(task.status === 'completed' ? 'check' : 'shield', 15)}
      <div class="small">${esc(task.blocker)}</div></div>` : ''}

    <div class="bx-facts">
      ${fact('Last verified milestone', task.lastMilestone || 'none yet')}
      ${fact('Last page change', task.lastSuccessAt ? `${stamp(task.lastSuccessAt)} · ${ageLabel(Date.now() - task.lastSuccessAt)}` : 'none yet')}
      ${fact('Checkpoint', `step ${task.checkpoint?.stepIndex ?? 0}${task.checkpoint?.url ? ` · ${shortUrl(task.checkpoint.url)}` : ''}`)}
      ${fact('Recovery attempts', `${task.retriesUsed} of ${task.maxRetries} used · ${task.recoveryLog.length} logged`)}
      ${fact('Failures in a row', `${task.consecutiveFailures} of ${task.maxConsecutiveFailures}`)}
      ${fact('Evidence', `${task.evidence.length} record${task.evidence.length === 1 ? '' : 's'} · ${Math.round((task.evidenceBytes || 0) / 1024)} KB`)}
    </div>

    <div class="bx-controls">
      ${canPause ? `<button class="btn sm" data-act="bx-control" data-id="${esc(task.id)}" data-cmd="pause">${icon('pause', 14)} Pause</button>` : ''}
      ${canResume ? `<button class="btn sm" data-act="bx-control" data-id="${esc(task.id)}" data-cmd="resume">${icon('play', 14)} Resume</button>` : ''}
      ${canAssist ? `<button class="btn sm primary" data-act="bx-control" data-id="${esc(task.id)}" data-cmd="assist">${icon('check', 14)} I've cleared it</button>` : ''}
      ${finished ? '' : `<button class="btn sm" data-act="bx-control" data-id="${esc(task.id)}" data-cmd="stop">${icon('stop', 14)} Stop</button>`}
      <button class="btn sm" data-act="bx-refresh">${icon('refresh', 14)} Refresh</button>
    </div>

    <div class="bx-section">Timeline</div>
    <div class="bx-timeline">
      ${task.timeline.slice().reverse().map(timelineRow).join('') || '<div class="tiny muted">No steps recorded.</div>'}
    </div>

    <div class="bx-section">Evidence</div>
    <div class="bx-evidence">
      ${task.evidence.map((e) => `
        <button class="bx-ev" data-act="bx-evidence" data-id="${esc(task.id)}" data-ev="${esc(e.id)}">
          <span class="chip tiny ${e.kind === 'screenshot' ? 'brand' : ''}">${esc(e.kind)}</span>
          <span class="grow bx-clamp tiny">${esc(e.summary)}</span>
          <span class="tiny muted">${e.bytes ? `${Math.round(e.bytes / 1024) || 1} KB` : '—'}</span>
        </button>`).join('') || '<div class="tiny muted">No evidence yet — nothing has been verified.</div>'}
    </div>`;
}

const shortUrl = (url) => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`.slice(0, 48);
  } catch {
    return String(url || '').slice(0, 48);
  }
};

const fact = (label, value) => `<div class="bx-fact"><span class="tiny muted">${esc(label)}</span><span class="small strong break">${esc(value)}</span></div>`;

const STEP_TONE = { ok: 'ok', warn: 'warn', bad: 'bad', end: 'ok', info: '' };

function timelineRow(s) {
  return `<div class="bx-row">
    <span class="bx-row-dot ${STEP_TONE[s.status] || ''}" aria-hidden="true"></span>
    <div class="grow">
      <div class="tiny"><span class="strong">${esc(s.kind)}</span> <span class="muted">${esc(stamp(s.ts))}</span>
        ${s.attempt ? `<span class="chip tiny">attempt ${s.attempt}</span>` : ''}
        ${s.duration_ms ? `<span class="tiny muted">${Math.round(s.duration_ms)} ms</span>` : ''}</div>
      <div class="tiny muted break">${esc(s.detail)}</div>
    </div>
  </div>`;
}

/* ---------- polling ---------- */

let timer = null;
function startPolling() {
  stopPolling();
  timer = setInterval(async () => {
    if (!document.getElementById('bx-list')) { stopPolling(); return; }
    await refresh({ quiet: true });
    // Polling updates status/tasks only; leave the compose form DOM untouched
    // so typing and selection remain stable on mobile.
    paint(document, { updateCompose: false });
  }, POLL_MS);
}
function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
}

/* ---------- view ---------- */

views.browser = {
  title: 'Agent Browser',
  render() {
    const caps = cache.caps;
    const active = caps ? (caps.active || 0) : 0;
    return `
      <div class="page-head">
        <h1>Agent Browser</h1>
        <div class="sub">Autonomous browsing with a watchdog, a bounded retry ladder and evidence —
          ${isApiMode() ? `${active} active · ${cache.tasks.length} recent` : 'gateway required'}</div>
      </div>
      <div id="bx-status">${statusHTML()}</div>
      <div class="card bx-compose" id="bx-compose">${composeHTML()}</div>
      <div class="bx-grid">
        <div class="card bx-list" id="bx-list">${listHTML()}</div>
        <div class="card bx-detail" id="bx-detail">${detailHTML()}</div>
      </div>
      <p class="tiny muted bx-foot">A page that stays open is not progress. Every task is cut by its
        deadline and budgets, a refusal from a site ends it as blocked, and “completed” is only shown
        once the gateway has verified each success criterion against recorded evidence.</p>`;
  },
  async mount() {
    if (!isApiMode()) { paint(); return; }
    await refresh({ quiet: true });
    paint();
    startPolling();
  },
};

/* ---------- actions ---------- */

on('bx-refresh', async () => {
  await refresh({ quiet: true });
  paint();
});

on('bx-select', async (el, ds) => {
  cache.selectedId = cache.selectedId === ds.id ? '' : ds.id;
  if (cache.selectedId) {
    try { await loadDetail(cache.selectedId); } catch (error) { toast(describe(error), 'bad'); }
  } else {
    cache.detail = null;
  }
  paint();
});

on('bx-example', () => {
  const objective = document.getElementById('bx-objective');
  const criteria = document.getElementById('bx-criteria');
  const plan = document.getElementById('bx-plan');
  if (objective) objective.value = 'Open example.com and verify the page heading it shows';
  if (criteria) criteria.value = 'heading: contains:Example Domain';
  if (plan) plan.value = JSON.stringify([
    { action: 'goto', url: 'https://example.com/', describe: 'Open the example page' },
    { action: 'extract', key: 'heading', selector: 'h1', describe: 'Read the heading' },
    { action: 'screenshot', describe: 'Capture the page as evidence' },
  ], null, 2);
});

function parseCriteria(raw) {
  return String(raw || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf(':');
      if (idx < 1) throw new Error(`Success criterion “${line}” needs the form “key: check”`);
      return { key: line.slice(0, idx).trim(), expect: line.slice(idx + 1).trim() };
    });
}

const describe = (error) => (error instanceof ApiError ? error.body?.hint ? `${error.message} — ${error.body.hint}` : error.message : String(error?.message || error));

on('bx-create', async () => {
  const objective = document.getElementById('bx-objective')?.value?.trim() || '';
  const criteriaRaw = document.getElementById('bx-criteria')?.value || '';
  const planRaw = document.getElementById('bx-plan')?.value || '';
  const driverId = document.getElementById('bx-driver')?.value || 'auto';

  if (objective.length < 10) { toast('Describe the objective in at least 10 characters', 'bad'); return; }
  let plan;
  try {
    plan = JSON.parse(planRaw);
    if (!Array.isArray(plan) || !plan.length) throw new Error('The plan must be a non-empty array of steps');
  } catch (error) {
    toast(`Plan is not valid JSON: ${error.message}`, 'bad');
    return;
  }
  let criteria;
  try {
    criteria = parseCriteria(criteriaRaw);
  } catch (error) {
    toast(error.message, 'bad');
    return;
  }
  if (!criteria.length && !(await confirmNoCriteria())) return;

  cache.busy = 'create';
  try {
    const out = await api.createBrowserTask({ objective, successCriteria: criteria, plan, driver: driverId });
    const task = out.body?.task;
    toast('Task queued — the gateway advances it one action at a time', 'ok');
    cache.selectedId = task?.id || '';
    ['bx-objective', 'bx-criteria', 'bx-plan'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    await refresh({ quiet: true });
    if (cache.selectedId) await loadDetail(cache.selectedId).catch(() => {});
    paint();
  } catch (error) {
    toast(describe(error), 'bad');
  } finally {
    cache.busy = '';
  }
});

function confirmNoCriteria() {
  return new Promise((resolve) => {
    const { close } = openSheet({
      title: 'No success criteria',
      body: `<div class="small muted">Without criteria the gateway cannot verify anything, so a plan that
        finishes will be reported as <strong>failed</strong>. Add at least one criterion to make the task
        provable.</div>`,
      foot: `<div class="row" style="gap:10px"><button class="btn grow" data-decide="cancel">Add criteria</button>
        <button class="btn grow" data-decide="yes">Start anyway</button></div>`,
    });
    const sheet = document.querySelector('.sheet:last-of-type');
    sheet?.querySelectorAll('[data-decide]').forEach((btn) => btn.addEventListener('click', () => {
      close();
      resolve(btn.dataset.decide === 'yes');
    }));
  });
}

on('bx-control', async (el, ds) => {
  const verb = { pause: 'Paused', resume: 'Resumed', stop: 'Stopped', assist: 'Continuing' }[ds.cmd] || 'Updated';
  el.disabled = true;
  try {
    const out = await api.browserControl(ds.id, ds.cmd);
    toast(`${verb}: ${out.body?.task?.status?.replace(/_/g, ' ') || ds.cmd}`, 'ok');
    await refresh({ quiet: true });
    paint();
  } catch (error) {
    toast(describe(error), 'bad');
    el.disabled = false;
  }
});

on('bx-evidence', async (el, ds) => {
  try {
    const out = await api.browserEvidence(ds.id, ds.ev);
    const row = out.body || {};
    const body = row.kind === 'screenshot' && row.data
      ? `<img class="bx-shot" alt="Screenshot captured by the agent" src="data:image/png;base64,${esc(row.data)}">
         <div class="tiny muted" style="margin-top:8px">${esc(row.summary)}</div>`
      : `<pre class="bx-pre">${esc(row.data || row.summary || 'No stored payload')}</pre>`;
    openSheet({
      title: `Evidence · ${row.kind || 'record'}`,
      wide: true,
      body: `${body}
        <div class="bx-facts" style="margin-top:10px">
          ${fact('Captured', stamp(row.ts))}
          ${fact('Page', row.url || '—')}
          ${fact('Digest', row.digest || '—')}
          ${fact('Size', row.bytes ? `${Math.round(row.bytes / 1024) || 1} KB` : 'not stored')}
        </div>`,
    });
  } catch (error) {
    toast(describe(error), 'bad');
  }
});

export const browserInternals = { ageLabel, parseCriteria, cache, refresh, paint };
