/* ============ Kanban board: columns, zoom, dependency wires, commands ============
 * One seam used by three callers — the board UI, the drag-and-drop handler and the Copilot — so a
 * card can only ever move through the same paths:
 *
 *   moveTask(id, column)      opens a confirmation first (unless already confirmed), then commits
 *   assignTask / setPriority / renameTask / linkDeps / unlinkDeps / deleteTask
 *   setZoom / toggleWires / setFilter
 *
 * Zoom sets `--kb-zoom` on the board track and the stylesheet applies `zoom` to it: every card, chip
 * and avatar scales together, the scrollable extent stays correct and pointer hit-testing during a
 * drag stays exact (a `transform: scale()` would clip the scroll area).
 *
 * Wires are dependency edges (`task.deps` holds blocker ids) drawn as an SVG overlay from blocker to
 * dependent. They are configuration, not telemetry: nothing animates and nothing is emitted.
 */
import { getState, setState, esc, icon, logEvent, now, getAgent } from './core.js';
import { openSheet, toast, confirmModal } from './shell.js';
import { isLive, updateTask, createTask } from './datastore.js';
import { isApiMode } from './api.js';
import { can } from './auth.js';

/* ---------- columns ---------- */
export const COLUMNS = [
  { id: 'todo', label: 'Backlog', dot: 'idle' },
  { id: 'doing', label: 'In progress', dot: 'run' },
  { id: 'review', label: 'Review', dot: 'warn' },
  { id: 'done', label: 'Done', dot: 'live' },
];
export const COLUMN_IDS = COLUMNS.map((c) => c.id);
export const columnLabel = (id) => COLUMNS.find((c) => c.id === id)?.label || id;

/** Accepts ids or labels so Copilot text ("move to review", "move to in progress") works. */
export function resolveColumn(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  const direct = COLUMNS.find((c) => c.id === raw);
  if (direct) return direct.id;
  const byLabel = COLUMNS.find((c) => c.label.toLowerCase() === raw || c.label.toLowerCase().startsWith(raw));
  if (byLabel) return byLabel.id;
  if (/^(backlog|todo|to do|queue)$/.test(raw)) return 'todo';
  if (/^(in progress|in-progress|doing|active|wip)$/.test(raw)) return 'doing';
  if (/^(review|in review|qa)$/.test(raw)) return 'review';
  if (/^(done|complete|completed|shipped|closed)$/.test(raw)) return 'done';
  return null;
}

/* ---------- view preferences (persisted in the workspace store) ---------- */
export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 1.5;
export const ZOOM_STEP = 0.1;

const DEFAULT_BOARD = { zoom: 1, wires: null, filter: { agent: 'all', priority: 'all', q: '' } };
export const boardPrefs = () => ({ ...DEFAULT_BOARD, ...(getState().board || {}), filter: { ...DEFAULT_BOARD.filter, ...((getState().board || {}).filter || {}) } });

const clampZoom = (n) => Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(n) || 1)) * 10) / 10;

function writePrefs(patch, reason = 'board') {
  setState((s) => {
    s.board = { ...DEFAULT_BOARD, ...(s.board || {}), ...patch };
    if (patch.filter) s.board.filter = { ...DEFAULT_BOARD.filter, ...(s.board.filter || {}) };
  }, reason);
}

export function setZoom(value) {
  const zoom = clampZoom(value);
  writePrefs({ zoom }, 'board-zoom');
  return { ok: true, zoom };
}

export function zoomBy(direction) {
  const { zoom } = boardPrefs();
  return setZoom(zoom + (direction === 'out' ? -ZOOM_STEP : ZOOM_STEP));
}

export function fitZoom() {
  return setZoom(1);
}

/**
 * Wires default to on for narrow screens (where a horizontal board hides the dependencies) and can
 * be forced either way from the toolbar. `null` means "auto".
 */
export const wiresEnabled = (prefs = boardPrefs()) => {
  if (prefs.wires === true || prefs.wires === false) return prefs.wires;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  const wide = window.matchMedia('(min-width: 900px)');
  return !wide.matches;
};

export function toggleWires(force) {
  const prefs = boardPrefs();
  const next = force === undefined ? !wiresEnabled(prefs) : Boolean(force);
  writePrefs({ wires: next }, 'board-wires');
  return { ok: true, wires: next };
}

export function setFilter(patch) {
  const prefs = boardPrefs();
  writePrefs({ filter: { ...prefs.filter, ...patch } }, 'board-filter');
  return boardPrefs().filter;
}

export const clearFilter = () => { writePrefs({ filter: { ...DEFAULT_BOARD.filter } }, 'board-filter'); return boardPrefs().filter; };

/** Tasks visible under the current filter (the board and the writes both respect it). */
export function visibleTasks(tasks = getState().tasks, filter = boardPrefs().filter) {
  const q = String(filter.q || '').trim().toLowerCase();
  return tasks.filter((t) => {
    if (filter.agent && filter.agent !== 'all' && t.assignee !== filter.agent) return false;
    if (filter.priority && filter.priority !== 'all' && t.priority !== filter.priority) return false;
    if (q && !(`${t.title} ${t.desc || ''}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

/* ---------- task lookup ---------- */
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Find a task from free text. Exact id → exact title → unique substring → unique token overlap.
 * Returns `{ task }` or `{ error }`; ambiguity is an error, never a guess.
 */
export function findTask(text, tasks = getState().tasks) {
  const raw = String(text || '').trim();
  if (!raw) return { error: 'Which card? Give me part of its title.' };
  const byId = tasks.find((t) => t.id.toLowerCase() === raw.toLowerCase());
  if (byId) return { task: byId };
  const q = norm(raw);
  const exact = tasks.filter((t) => norm(t.title) === q);
  if (exact.length === 1) return { task: exact[0] };
  const sub = tasks.filter((t) => norm(t.title).includes(q) || q.includes(norm(t.title)));
  if (sub.length === 1) return { task: sub[0] };
  const tokens = q.split(' ').filter(Boolean);
  const scored = tasks
    .map((t) => ({ t, score: tokens.filter((w) => norm(t.title).includes(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 1) return { task: scored[0].t };
  if (scored.length > 1 && scored[0].score > scored[1].score) return { task: scored[0].t };
  if (/["“”']/.test(raw)) {
    const quoted = raw.replace(/^["“']|["”']$/g, '');
    const hit = tasks.find((t) => norm(t.title) === norm(quoted));
    if (hit) return { task: hit };
  }
  if (!scored.length) return { error: `No card matches “${raw}”.` };
  return { error: `${scored.length} cards match “${raw}” (${scored.slice(0, 3).map((x) => `“${x.t.title}”`).join(', ')}). Be more specific.` };
}

const findAgentByName = (text) => {
  const q = norm(text);
  if (!q) return null;
  const agents = getState().agents;
  return (
    agents.find((a) => norm(a.name) === q)
    || agents.find((a) => norm(a.name).startsWith(q) || q.startsWith(norm(a.name)))
    || agents.find((a) => norm(a.name).includes(q))
    || null
  );
};

/* ---------- write helpers ---------- */
const canWrite = () => !(isApiMode() && !can('task:write'));

/**
 * Commit a column change. Gateway mode patches the server row; demo mode edits the local store.
 * Never reports success it did not get.
 */
export async function commitMove(taskId, column) {
  const col = resolveColumn(column);
  if (!col) return { ok: false, error: `Unknown column “${column}”.` };
  const task = getState().tasks.find((t) => t.id === taskId);
  if (!task) return { ok: false, error: 'Task not found.' };
  if (task.column === col) return { ok: false, error: `“${task.title}” is already in ${columnLabel(col)}.` };
  if (!canWrite()) return { ok: false, error: 'Your role cannot move tasks on this gateway (task:write).' };

  if (isLive('tasks')) {
    try {
      await updateTask(taskId, { column_name: col });
      logEvent('task', `“${task.title}” → ${columnLabel(col)}`);
      return { ok: true, mode: 'gateway', task: getState().tasks.find((t) => t.id === taskId) };
    } catch (err) {
      return { ok: false, error: `Gateway refused: ${err.message}` };
    }
  }
  setState((s) => {
    const t = s.tasks.find((x) => x.id === taskId);
    if (t) t.column = col;
    logEvent('task', `“${t?.title || taskId}” → ${columnLabel(col)}`);
  }, 'kanban-move');
  return { ok: true, mode: 'demo', task: getState().tasks.find((t) => t.id === taskId) };
}

/**
 * Move a card, confirming first. This is the only path the UI and Copilot use, so a drop, a drawer
 * chip and a spoken instruction all pass through the same prompt.
 * @returns {Promise<{ok: boolean, cancelled?: boolean, error?: string}>}
 */
export async function moveTask(taskId, column, { confirm = true } = {}) {
  const col = resolveColumn(column);
  if (!col) return { ok: false, error: `Unknown column “${column}”.` };
  const task = getState().tasks.find((t) => t.id === taskId);
  if (!task) return { ok: false, error: 'Task not found.' };
  if (task.column === col) return { ok: false, error: `“${task.title}” is already in ${columnLabel(col)}.` };

  if (confirm) {
    const answer = await confirmModal({
      title: 'Move this card?',
      body: `Move <strong>“${esc(task.title)}”</strong> from <strong>${esc(columnLabel(task.column))}</strong> to <strong>${esc(columnLabel(col))}</strong>?<br><span class="tiny muted">The change is recorded in the activity log.</span>`,
      confirmText: 'Move card',
    });
    // Cancel, scrim tap or Escape: no state change, no event, the card never left its column.
    if (answer !== 'confirm') return { ok: false, cancelled: true };
  }
  return commitMove(taskId, col);
}

export async function assignTask(taskId, agentNameOrId) {
  const task = getState().tasks.find((t) => t.id === taskId);
  if (!task) return { ok: false, error: 'Task not found.' };
  const raw = String(agentNameOrId || '').trim();
  if (/^(unassigned|nobody|no one|none)$/i.test(raw)) {
    if (isLive('tasks')) {
      if (!canWrite()) return { ok: false, error: 'Your role cannot reassign tasks on this gateway (task:write).' };
      try { await updateTask(taskId, { assignee: '' }); } catch (err) { return { ok: false, error: `Gateway refused: ${err.message}` }; }
    } else {
      setState((s) => { const t = s.tasks.find((x) => x.id === taskId); if (t) t.assignee = ''; logEvent('task', `“${t.title}” unassigned`); }, 'kanban-assign');
    }
    return { ok: true, assignee: '' };
  }
  const agent = getAgent(raw) || findAgentByName(raw);
  if (!agent) return { ok: false, error: `No agent matches “${raw}”.` };
  if (isLive('tasks')) {
    if (!canWrite()) return { ok: false, error: 'Your role cannot reassign tasks on this gateway (task:write).' };
    try {
      await updateTask(taskId, { assignee: agent.id });
    } catch (err) {
      return { ok: false, error: `Gateway refused: ${err.message}` };
    }
  } else {
    setState((s) => {
      const t = s.tasks.find((x) => x.id === taskId);
      if (t) t.assignee = agent.id;
      logEvent('task', `“${t?.title}” assigned to ${agent.name}`);
    }, 'kanban-assign');
  }
  return { ok: true, assignee: agent.id, agent };
}

export async function setPriority(taskId, priority) {
  const p = String(priority || '').toLowerCase();
  const value = /^(high|h|urgent)$/.test(p) ? 'high' : /^(med|medium|m|normal)$/.test(p) ? 'med' : /^(low|l|minor)$/.test(p) ? 'low' : null;
  if (!value) return { ok: false, error: `Priority must be low, med or high (got “${priority}”).` };
  const task = getState().tasks.find((t) => t.id === taskId);
  if (!task) return { ok: false, error: 'Task not found.' };
  if (isLive('tasks')) {
    if (!canWrite()) return { ok: false, error: 'Your role cannot change tasks on this gateway (task:write).' };
    try { await updateTask(taskId, { priority: value }); } catch (err) { return { ok: false, error: `Gateway refused: ${err.message}` }; }
  } else {
    setState((s) => {
      const t = s.tasks.find((x) => x.id === taskId);
      if (t) t.priority = value;
      logEvent('task', `“${t?.title}” priority → ${value}`);
    }, 'kanban-priority');
  }
  return { ok: true, priority: value };
}

export async function renameTask(taskId, title) {
  const next = String(title || '').trim();
  if (!next) return { ok: false, error: 'A title is required.' };
  if (next.length > 120) return { ok: false, error: 'Titles are limited to 120 characters.' };
  const task = getState().tasks.find((t) => t.id === taskId);
  if (!task) return { ok: false, error: 'Task not found.' };
  if (isLive('tasks')) {
    if (!canWrite()) return { ok: false, error: 'Your role cannot rename tasks on this gateway (task:write).' };
    try { await updateTask(taskId, { title: next }); } catch (err) { return { ok: false, error: `Gateway refused: ${err.message}` }; }
  } else {
    setState((s) => {
      const t = s.tasks.find((x) => x.id === taskId);
      if (t) t.title = next;
      logEvent('task', `Card renamed to “${next}”`);
    }, 'kanban-rename');
  }
  return { ok: true, title: next };
}

/** Dependency edges are local board metadata: the gateway has no column for them. */
const depsLocalOnly = () => (isLive('tasks') ? { ok: false, error: 'Dependencies are board metadata; the gateway has no tasks.deps column yet, so nothing was changed.' } : null);

export function linkDeps(taskId, blockerId) {
  const localOnly = depsLocalOnly();
  if (localOnly) return localOnly;
  const task = getState().tasks.find((t) => t.id === taskId);
  const blocker = getState().tasks.find((t) => t.id === blockerId);
  if (!task || !blocker) return { ok: false, error: 'Both cards must exist.' };
  if (task.id === blocker.id) return { ok: false, error: 'A card cannot depend on itself.' };
  const deps = new Set(task.deps || []);
  if (deps.has(blocker.id)) return { ok: false, error: `“${task.title}” already depends on “${blocker.title}”.` };
  // Reject cycles: walk blocker's dependencies for the task.
  const seen = new Set();
  const reaches = (from) => {
    if (from === task.id) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    const t = getState().tasks.find((x) => x.id === from);
    return (t?.deps || []).some(reaches);
  };
  if (reaches(blocker.id)) return { ok: false, error: 'That would create a dependency cycle.' };
  setState((s) => {
    const t = s.tasks.find((x) => x.id === taskId);
    t.deps = [...(t.deps || []), blocker.id];
    logEvent('task', `“${t.title}” now depends on “${blocker.title}”`);
  }, 'kanban-link');
  return { ok: true, deps: getState().tasks.find((t) => t.id === taskId).deps };
}

export function unlinkDeps(taskId, blockerId) {
  const localOnly = depsLocalOnly();
  if (localOnly) return localOnly;
  const task = getState().tasks.find((t) => t.id === taskId);
  if (!task) return { ok: false, error: 'Task not found.' };
  if (!(task.deps || []).includes(blockerId)) return { ok: false, error: 'That dependency does not exist.' };
  setState((s) => {
    const t = s.tasks.find((x) => x.id === taskId);
    t.deps = (t.deps || []).filter((d) => d !== blockerId);
    logEvent('task', `Dependency removed from “${t.title}”`);
  }, 'kanban-unlink');
  return { ok: true, deps: getState().tasks.find((t) => t.id === taskId).deps };
}

/** Destructive: always requires an explicit confirmation (two-step via the modal). */
export async function deleteTask(taskId, { confirm = true } = {}) {
  const task = getState().tasks.find((t) => t.id === taskId);
  if (!task) return { ok: false, error: 'Task not found.' };
  if (isLive('tasks')) {
    return { ok: false, error: 'The gateway has no delete endpoint for tasks; nothing was deleted.' };
  }
  const blockers = getState().tasks.filter((t) => (t.deps || []).includes(taskId));
  const warn = blockers.length
    ? `<br><span class="tiny" style="color:var(--warning)">${blockers.length} card(s) depend on this one: ${esc(blockers.map((b) => b.title).join(', '))}</span>`
    : '';
  const doIt = () => {
    setState((s) => {
      s.tasks = s.tasks.filter((t) => t.id !== taskId);
      s.tasks.forEach((t) => { if (t.deps) t.deps = t.deps.filter((d) => d !== taskId); });
      logEvent('task', `Card “${task.title}” deleted`);
    }, 'kanban-delete');
    return { ok: true };
  };
  if (!confirm) return doIt();
  const answer = await confirmModal({
    title: 'Delete this card?',
    body: `“${esc(task.title)}” will be removed from the board.${warn}`,
    confirmText: 'Delete card',
    danger: true,
  });
  if (answer !== 'confirm') return { ok: false, cancelled: true };
  return doIt();
}

export async function createBoardTask({ title, column = 'todo', assignee, priority = 'med', desc = '' }) {
  const clean = String(title || '').trim();
  if (!clean) return { ok: false, error: 'A title is required.' };
  const col = resolveColumn(column) || 'todo';
  if (isApiMode()) {
    if (!can('task:write')) return { ok: false, error: 'Your role cannot create tasks on this gateway (task:write).' };
    try {
      const row = await createTask({ title: clean, column: col, priority, desc, assignee });
      return { ok: true, task: row, mode: 'gateway' };
    } catch (err) {
      return { ok: false, error: `Gateway refused: ${err.message}` };
    }
  }
  const id = `tk-${Math.random().toString(36).slice(2, 8)}`;
  setState((s) => {
    s.tasks.unshift({ id, title: clean, column: col, assignee: assignee || 'ag-researcher', priority, deps: [], desc: desc || 'Created via Copilot.' });
    logEvent('task', `Task created: ${clean}`);
  }, 'kanban-create');
  return { ok: true, task: getState().tasks.find((t) => t.id === id), mode: 'demo' };
}

/* =========================================================================================
 * Wires: dependency edges drawn between cards
 * =======================================================================================*/
/**
 * Compute edge geometry in board coordinates. Pure, so it can be asserted without a layout engine:
 * @param {Array<{id:string, rect:{x:number,y:number,w:number,h:number}, done?:boolean}>} cards
 * @param {Array<{from:string, to:string}>} edges
 */
export function wirePaths(cards, edges) {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const paths = [];
  const skipped = [];
  edges.forEach(({ from, to }) => {
    const a = byId.get(from);
    const b = byId.get(to);
    if (!a || !b) { skipped.push({ from, to, reason: 'endpoint-offscreen' }); return; }
    // Leave from the right edge of the blocker, arrive at the left edge of the dependent card.
    const x1 = a.rect.x + a.rect.w;
    const y1 = a.rect.y + a.rect.h / 2;
    const x2 = b.rect.x;
    const y2 = b.rect.y + b.rect.h / 2;
    const dx = Math.max(32, Math.abs(x2 - x1) * 0.45);
    paths.push({
      from,
      to,
      d: `M${x1.toFixed(1)},${y1.toFixed(1)} C${(x1 + dx).toFixed(1)},${y1.toFixed(1)} ${(x2 - dx).toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`,
      dim: Boolean(a.done),
      midX: (x1 + x2) / 2,
      midY: (y1 + y2) / 2,
    });
  });
  return { paths, skipped };
}

export function dependencyEdges(tasks = getState().tasks) {
  const edges = [];
  tasks.forEach((t) => (t.deps || []).forEach((d) => edges.push({ from: d, to: t.id })));
  return edges;
}

export const boardStats = () => {
  const tasks = getState().tasks;
  const byColumn = COLUMNS.reduce((acc, c) => ({ ...acc, [c.id]: tasks.filter((t) => t.column === c.id).length }), {});
  const edges = dependencyEdges(tasks);
  const ids = new Set(tasks.map((t) => t.id));
  const dangling = edges.filter((e) => !ids.has(e.from) || !ids.has(e.to));
  const blocked = tasks.filter((t) => (t.deps || []).some((d) => tasks.find((x) => x.id === d)?.column !== 'done'));
  return { total: tasks.length, byColumn, edges: edges.length, dangling: dangling.length, blocked: blocked.length };
};

/* =========================================================================================
 * Copilot seam
 * =======================================================================================*/
const CARD_PATTERNS = [
  /^move\s+(.+?)\s+to\s+(.+)$/i,
  /^move\s+(.+?)\s+(?:into|in)\s+(.+)$/i,
  /^put\s+(.+?)\s+(?:in|into|to)\s+(.+)$/i,
];

/**
 * Parse and execute one board instruction. Returns `null` when the text is not about the board so
 * the Copilot can keep looking, and `{ok, reply, ...}` otherwise.
 */
export async function kanbanCommand(raw) {
  const text = String(raw || '').trim();
  const lower = text.toLowerCase();
  if (!text) return null;

  const boardish = /\b(task|card|board|kanban|backlog|column|wires|blocker|depend|priority)\b/.test(lower);
  const moveMatch = CARD_PATTERNS.map((re) => text.match(re)).find(Boolean);
  const hasMoveVerb = /^(move|put|shift)\b/.test(lower);
  // Verbs that only make sense on a board, so they do not need the word "card" to be recognised.
  const boardVerb = /^(move|put|shift|assign|reassign|unassign|rename|link|unlink)\b/.test(lower);

  /* zoom / wires / filter — available even when the text does not mention "card" */
  const zoomM = lower.match(/zoom(?:\s+the\s+board)?(?:\s+to)?\s+(\d{2,3})\s*%?/);
  if (zoomM) {
    const out = setZoom(Number(zoomM[1]) / 100);
    return { ok: true, action: 'zoom', reply: `Board zoom set to ${Math.round(out.zoom * 100)}%.` };
  }
  if (/^(zoom|scale)\b/.test(lower) && /(in|up)/.test(lower)) {
    const out = zoomBy('in');
    return { ok: true, action: 'zoom', reply: `Board zoom ${Math.round(out.zoom * 100)}%.` };
  }
  if (/^(zoom|scale)\b/.test(lower) && /(out|down)/.test(lower)) {
    const out = zoomBy('out');
    return { ok: true, action: 'zoom', reply: `Board zoom ${Math.round(out.zoom * 100)}%.` };
  }
  if (/\b(wires|connections|dependencies|edges)\b/.test(lower) && /(show|hide|on|off|toggle|turn)/.test(lower)) {
    const show = /show|on|enable/.test(lower) && !/hide|off|disable/.test(lower);
    const out = toggleWires(show);
    return { ok: true, action: 'wires', reply: `Dependency wires ${out.wires ? 'shown' : 'hidden'}.` };
  }
  const filterM = lower.match(/filter\s+(?:the\s+)?board\s+by\s+(agent|priority)\s+(.+)$/);
  if (filterM) {
    const kind = filterM[1];
    const value = filterM[2].trim();
    if (kind === 'priority') {
      const p = /high/.test(value) ? 'high' : /med/.test(value) ? 'med' : /low/.test(value) ? 'low' : null;
      if (!p) return { ok: false, reply: 'Priority filter must be high, med or low.' };
      setFilter({ priority: p });
      return { ok: true, action: 'filter', reply: `Board filtered to ${p} priority cards.` };
    }
    const agent = findAgentByName(value);
    if (!agent) return { ok: false, reply: `No agent matches “${value}”.` };
    setFilter({ agent: agent.id });
    return { ok: true, action: 'filter', reply: `Board filtered to ${agent.name}'s cards.` };
  }
  if (/(clear|reset)\s+(the\s+)?(board\s+)?filter/.test(lower)) {
    clearFilter();
    return { ok: true, action: 'filter', reply: 'Board filter cleared.' };
  }

  if (!boardish && !moveMatch && !boardVerb) return null;

  /* summary */
  if (/^(board|status|summary|what'?s? (on|in) the board)/.test(lower) || /how many (tasks|cards)/.test(lower)) {
    const st = boardStats();
    return {
      ok: true,
      action: 'summary',
      reply: `Board: ${COLUMNS.map((c) => `${c.label} ${st.byColumn[c.id]}`).join(' · ')} · ${st.edges} dependency link(s)${st.blocked ? `, ${st.blocked} card(s) waiting on a blocker` : ''}.`,
    };
  }

  /* move */
  if (moveMatch && (hasMoveVerb || /^move\b/.test(lower))) {
    const [, cardText, colText] = moveMatch;
    const col = resolveColumn(colText);
    if (!col) return { ok: false, reply: `Unknown column “${colText}”. Columns: ${COLUMNS.map((c) => c.label).join(', ')}.` };
    const found = findTask(cardText);
    if (found.error) return { ok: false, reply: found.error };
    const out = await moveTask(found.task.id, col);
    if (out.cancelled) return { ok: false, cancelled: true, reply: 'Move cancelled — the card stayed where it was.' };
    if (!out.ok) return { ok: false, reply: out.error };
    return { ok: true, action: 'move', reply: `“${found.task.title}” moved to ${columnLabel(col)} (${out.mode === 'gateway' ? 'gateway' : 'local board'}).` };
  }

  /* assign */
  const unassignM = text.match(/^unassign\s+(.+)$/i);
  if (unassignM) {
    const found = findTask(unassignM[1]);
    if (found.error) return { ok: false, reply: found.error };
    const out = await assignTask(found.task.id, 'unassigned');
    return out.ok ? { ok: true, action: 'assign', reply: `“${found.task.title}” is now unassigned.` } : { ok: false, reply: out.error };
  }
  const assignM = text.match(/^(?:assign|reassign|give)\s+(.+?)\s+to\s+(.+)$/i) || text.match(/^(?:assign|reassign)\s+(.+)$/i);
  if (assignM) {
    const found = findTask(assignM[1]);
    if (found.error) return { ok: false, reply: found.error };
    const out = await assignTask(found.task.id, assignM[2]);
    if (!out.ok) return { ok: false, reply: out.error };
    return { ok: true, action: 'assign', reply: `“${found.task.title}” assigned to ${out.agent?.name || 'nobody'}.` };
  }

  /* priority */
  const priM = text.match(/(?:set\s+)?priority\s+(low|med|medium|high)\s+(?:on|for|to)\s+(.+)$/i)
    || text.match(/(?:make|set)\s+(.+?)\s+(low|med|medium|high)\s+priority/i);
  if (priM) {
    const isAlt = /priority$/i.test(priM[2] || '');
    const pri = (isAlt ? priM[2] : priM[1]).replace('medium', 'med');
    const cardText = isAlt ? priM[1] : priM[2];
    const found = findTask(cardText);
    if (found.error) return { ok: false, reply: found.error };
    const out = await setPriority(found.task.id, pri);
    return out.ok ? { ok: true, action: 'priority', reply: `“${found.task.title}” is now ${out.priority} priority.` } : { ok: false, reply: out.error };
  }

  /* rename */
  const renameM = text.match(/^rename\s+(.+?)\s+to\s+(.+)$/i);
  if (renameM) {
    const found = findTask(renameM[1]);
    if (found.error) return { ok: false, reply: found.error };
    const out = await renameTask(found.task.id, renameM[2]);
    return out.ok ? { ok: true, action: 'rename', reply: `Card renamed to “${out.title}”.` } : { ok: false, reply: out.error };
  }

  /* link / unlink dependencies */
  const linkM = text.match(/^(?:link|make)\s+(.+?)\s+(?:depends?\s+on|blocked\s+by|after)\s+(.+)$/i);
  if (linkM) {
    const dependent = findTask(linkM[1]);
    const blocker = findTask(linkM[2]);
    if (dependent.error) return { ok: false, reply: dependent.error };
    if (blocker.error) return { ok: false, reply: blocker.error };
    const out = linkDeps(dependent.task.id, blocker.task.id);
    return out.ok
      ? { ok: true, action: 'link', reply: `“${dependent.task.title}” now depends on “${blocker.task.title}” — the wire is drawn on the board.` }
      : { ok: false, reply: out.error };
  }
  const unlinkM = text.match(/^unlink\s+(.+?)\s+(?:from|and)\s+(.+)$/i);
  if (unlinkM) {
    const dependent = findTask(unlinkM[1]);
    const blocker = findTask(unlinkM[2]);
    if (dependent.error || blocker.error) return { ok: false, reply: dependent.error || blocker.error };
    const out = unlinkDeps(dependent.task.id, blocker.task.id);
    return out.ok ? { ok: true, action: 'unlink', reply: `Dependency removed from “${dependent.task.title}”.` } : { ok: false, reply: out.error };
  }

  /* delete (two-step) */
  const deleteM = text.match(/^(?:delete|remove)\s+(?:the\s+)?(?:card|task)?\s*(.+)$/i);
  if (deleteM && /^(delete|remove)\b/.test(lower)) {
    const found = findTask(deleteM[1]);
    if (found.error) return { ok: false, reply: found.error };
    const out = await deleteTask(found.task.id);
    if (out.cancelled) return { ok: false, cancelled: true, reply: 'Delete cancelled — the card is still on the board.' };
    return out.ok ? { ok: true, action: 'delete', reply: `“${found.task.title}” deleted.` } : { ok: false, reply: out.error };
  }

  /* create */
  const createM = text.match(/^(?:create|add|new)\s+(?:a\s+)?(?:card|task)\s*:?\s*(.+)$/i);
  if (createM) {
    const colM = createM[1].match(/\s+in\s+(backlog|todo|in progress|doing|review|done)$/i);
    const title = colM ? createM[1].slice(0, colM.index).trim() : createM[1].trim();
    const out = await createBoardTask({ title, column: colM ? colM[1] : 'todo' });
    return out.ok
      ? { ok: true, action: 'create', reply: `Card “${out.task.title}” added to ${columnLabel(out.task.column)} (${out.mode}).` }
      : { ok: false, reply: out.error };
  }

  if (boardish) {
    return {
      ok: false,
      reply: 'Board actions I can take: “move <card> to <column>” · “assign <card> to <agent>” · “set priority high on <card>” · “rename <card> to <title>” · “link <card> depends on <card>” · “unlink …” · “delete <card>” · “create task <title>” · “zoom the board to 120%” · “show/hide wires” · “filter board by agent <name>” · “board status”.',
    };
  }
  return null;
}

/** Open the board focused on one card (used by Copilot navigation). */
export function openTask(id) {
  const task = getState().tasks.find((t) => t.id === id);
  if (!task) return false;
  openSheet({
    title: esc(task.title),
    body: `
      <div class="row wrap" style="margin-bottom:10px">
        <span class="chip tiny">${esc(columnLabel(task.column))}</span>
        <span class="chip tiny ${task.priority === 'high' ? 'bad' : task.priority === 'med' ? 'warn' : ''}">${esc(task.priority)} priority</span>
      </div>
      <div class="small">${esc(task.desc || '')}</div>`,
  });
  return true;
}

export const kanbanInternals = { clampZoom, norm, DEFAULT_BOARD };
