/* ============ Data layer: gateway-backed slices with explicit provenance ============
 * Rule: a screen must never show gateway rows as if they were demo data, or the reverse.
 *
 *   demo      — seeded fixtures persisted in this browser
 *   gateway   — fetched from GET /api/v1/* for the signed-in principal
 *   degraded  — a gateway session exists but the last refresh failed; demo fixtures are shown
 *               and labelled as such (never a stale mix)
 *
 * Only agents / tasks / approvals / events exist on the gateway today. Swarms, teams and usage
 * stay local and are labelled demo, because there is no server-side store for them yet.
 */
import { getState, replaceSlices, setProvenance, getProvenance, isLive, setPersistFilter, resetDemo } from './core.js';
import { api, ApiError, isApiMode, gatewayUrl } from './api.js';
import { getAuth, subscribeAuth, isAuthenticated } from './auth.js';

export const GATEWAY_SLICES = ['agents', 'tasks', 'approvals', 'events'];
export const LOCAL_SLICES = ['swarms', 'teams', 'usage'];

const listeners = new Set();

const sync = {
  status: 'idle', // idle | loading | live | degraded | demo | error
  error: null,
  at: null,
  ws: 'off', // off | connecting | open | reconnecting | refused
  lastEventAt: null,
  requestId: null,
};

let demoSnapshot = null; // pre-gateway slices, restored on sign-out
let refreshTimer = null;
let refreshInFlight = null;

/* ---------- formatting adapters (server columns → app shape) ---------- */
const arr = (value) => (Array.isArray(value) ? value : []);
const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const maybeJson = (value, fallback) => {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
};

export function adaptAgent(row) {
  const memory = maybeJson(row.memory, {}) || {};
  return {
    id: row.id,
    name: row.name || 'Unnamed agent',
    role: row.role || '',
    framework: row.framework || 'unknown',
    model: row.model || 'unknown',
    fallback: row.fallback || '—',
    status: row.status || 'idle',
    trust: num(row.trust, 50),
    autonomy: num(row.autonomy, 2),
    successRate: num(row.success_rate, 0),
    costToday: num(row.cost_today, 0),
    runs: num(row.runs, 0),
    lastActive: num(row.last_active, Date.now()),
    tools: arr(maybeJson(row.tools, [])),
    skills: arr(maybeJson(row.skills, [])),
    prompt: row.prompt || '',
    memory: {
      episodic: num(memory.episodic, 0),
      semantic: num(memory.semantic, 0),
      kb: memory.kb || '0 MB',
    },
    source: 'gateway',
  };
}

export function adaptTask(row) {
  return {
    id: row.id,
    title: row.title || 'Untitled',
    desc: row.description || row.desc || '',
    column: row.column_name || row.column || 'todo',
    assignee: row.assignee || null,
    priority: row.priority || 'med',
    deps: arr(maybeJson(row.deps, [])),
    createdAt: num(row.created_at, Date.now()),
    source: 'gateway',
  };
}

export function adaptApproval(row) {
  return {
    id: row.id,
    action: row.action || '',
    target: row.target || '',
    risk: row.risk || 'medium',
    principal: row.principal || '',
    evidence: row.evidence || '',
    status: row.status || 'pending',
    createdAt: num(row.created_at, Date.now()),
    decidedAt: row.decided_at ?? null,
    decidedBy: row.decider_id || null,
    source: 'gateway',
  };
}

export function adaptEvent(row) {
  return { id: row.id, ts: num(row.ts, Date.now()), type: row.type || 'system', text: row.text || '', source: 'gateway' };
}

const COLUMN_FALLBACK = new Set(['todo', 'doing', 'review', 'done']);
const normaliseColumn = (column) => (COLUMN_FALLBACK.has(column) ? column : 'todo');

/* ---------- snapshot / restore ---------- */
function captureDemo() {
  const s = getState();
  demoSnapshot = {};
  for (const slice of GATEWAY_SLICES) demoSnapshot[slice] = JSON.parse(JSON.stringify(s[slice] ?? []));
  return demoSnapshot;
}

/** Keep gateway rows out of localStorage; the server is their only owner. */
setPersistFilter((state) => {
  if (!demoSnapshot) return state;
  const out = { ...state };
  for (const slice of GATEWAY_SLICES) {
    if (state.provenance?.[slice] === 'gateway') out[slice] = demoSnapshot[slice];
  }
  // Comms channels are gateway-owned when a session holds comms:read: the statuses and masked
  // configuration must not survive in localStorage, where they would later look live.
  if (state.provenance?.comms === 'gateway') {
    out.comms = { ...(state.comms || {}), log: [], channels: undefined };
    delete out.comms.channels;
    out.commsGateway = { status: 'demo', note: 'gateway rows are not persisted', error: null, at: null };
  }
  return out;
});

/* ---------- state notifications ---------- */
function emit() {
  const snapshot = getStatus();
  listeners.forEach((fn) => {
    try {
      fn(snapshot);
    } catch {
      /* a broken listener must not stop a sync */
    }
  });
}

export function getStatus() {
  const provenance = getProvenance();
  return {
    ...sync,
    url: gatewayUrl(),
    provenance,
    liveSlices: GATEWAY_SLICES.filter((slice) => provenance[slice] === 'gateway'),
    demoSlices: [...LOCAL_SLICES].filter((slice) => provenance[slice] !== 'gateway'),
  };
}

export function subscribeData(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Why a slice is not live, in plain language (used by the UI). */
export function sourceExplanation(slice) {
  const st = getStatus();
  if (st.provenance[slice] === 'gateway') return { source: 'gateway', label: 'live gateway', detail: `${st.url} · refreshed ${st.at ? new Date(st.at).toLocaleTimeString() : '—'}` };
  if (!isApiMode()) return { source: 'demo', label: 'demo data', detail: 'No gateway configured — seeded fixtures in this browser. Nothing is enforced.' };
  if (st.status === 'degraded' || st.status === 'error') {
    return { source: 'demo', label: 'demo data (gateway unavailable)', detail: st.error || 'The last refresh failed, so no gateway rows are shown.' };
  }
  if (!isAuthenticated()) return { source: 'demo', label: 'demo data', detail: 'Not signed in — the gateway cannot authorise a read.' };
  return { source: 'demo', label: 'demo data', detail: 'This slice has no gateway endpoint yet.' };
}

/* ---------- fetch + adopt ---------- */
function adopt(data, { requestId = null } = {}) {
  if (!demoSnapshot) captureDemo();
  const agents = data.agents.map(adaptAgent);
  const tasks = data.tasks.map((row) => {
    const task = adaptTask(row);
    task.column = normaliseColumn(task.column);
    return task;
  });
  const approvals = data.approvals.map(adaptApproval);
  const events = data.events.map(adaptEvent).sort((a, b) => b.ts - a.ts).slice(0, 80);

  replaceSlices({ agents, tasks, approvals, events }, 'data:gateway');
  // Slices without a server store stay local and keep their demo provenance.
  setProvenance({
    agents: 'gateway',
    tasks: 'gateway',
    approvals: 'gateway',
    events: 'gateway',
    swarms: 'demo',
    teams: 'demo',
    usage: 'demo',
  });
  // Reflect the real gateway in the demo `gateway` object so header dots are not lies.
  replaceSlices(
    {
      gateway: {
        ...getState().gateway,
        status: 'healthy',
        live: true,
        upstream: gatewayUrl(),
        version: 'api',
        checkedAt: Date.now(),
      },
    },
    'data:gateway-meta'
  );

  Object.assign(sync, { status: 'live', error: null, at: Date.now(), requestId });
  emit();
  return { agents: agents.length, tasks: tasks.length, approvals: approvals.length, events: events.length };
}

/** Restore the pre-gateway fixtures and forget gateway rows. */
export function releaseGatewayData({ reason = 'signed-out' } = {}) {
  disconnectLive();
  clearTimeout(refreshTimer);
  refreshTimer = null;
  if (demoSnapshot) {
    replaceSlices({
      ...demoSnapshot,
      gateway: { ...getState().gateway, status: 'healthy', live: false, upstream: null, version: '0.1.0-proto' },
    }, 'data:release');
    demoSnapshot = null;
  }
  setProvenance({ agents: 'demo', tasks: 'demo', approvals: 'demo', events: 'demo', swarms: 'demo', teams: 'demo', usage: 'demo' });
  Object.assign(sync, { status: isApiMode() ? 'degraded' : 'demo', error: reason === 'signed-out' ? null : sync.error, at: Date.now(), ws: 'off' });
  emit();
}

export function reloadDemoData() {
  releaseGatewayData({ reason: 'reset' });
  resetDemo();
  emit();
}

async function fetchAll() {
  const [agents, tasks, approvals, events] = await Promise.all([
    api.agents(),
    api.tasks(),
    api.approvals(),
    api.events(0),
  ]);
  return {
    agents: agents.body,
    tasks: tasks.body,
    approvals: approvals.body,
    events: events.body,
    requestId: agents.requestId,
  };
}

/**
 * Pull every gateway slice. Coalesced: concurrent callers share one request.
 * @param {{silent?: boolean}} options
 */
export function refresh(options = {}) {
  if (!isApiMode() || !isAuthenticated()) {
    if (sync.status !== 'demo' && sync.status !== 'degraded') {
      Object.assign(sync, { status: isApiMode() ? 'degraded' : 'demo', error: null });
      emit();
    }
    return Promise.resolve({ ok: false, reason: 'no-session' });
  }
  if (refreshInFlight) return refreshInFlight;
  if (!options.silent) {
    Object.assign(sync, { status: 'loading' });
    emit();
  }
  refreshInFlight = fetchAll()
    .then((data) => ({ ok: true, counts: adopt(data, { requestId: data.requestId }) }))
    .catch((err) => {
      const unauthenticated = err instanceof ApiError && err.unauthenticated;
      Object.assign(sync, {
        status: unauthenticated ? 'degraded' : 'error',
        error: unauthenticated
          ? 'Session expired — sign in again to load gateway data.'
          : err?.message || 'Gateway request failed',
        at: Date.now(),
        ws: sync.ws === 'open' ? 'open' : 'off',
      });
      emit();
      return { ok: false, error: sync.error, status: err?.status || 0 };
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

/** Debounced refresh used by the live stream. */
export function scheduleRefresh(delay = 400) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh({ silent: true }), delay);
}

/* ---------- live stream ---------- */
let socket = null;
let socketUrl = null;
let reconnectAttempt = 0;
let reconnectTimer = null;

function wsEndpoint() {
  const base = gatewayUrl();
  if (!base || base === '/') {
    const loc = globalThis.location;
    if (!loc) return null;
    const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${loc.host}/ws`;
  }
  try {
    const url = new URL(base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function setWs(state) {
  if (sync.ws === state) return;
  Object.assign(sync, { ws: state });
  emit();
}

export function connectLive() {
  if (socket || !isApiMode() || !isAuthenticated()) return;
  const endpoint = wsEndpoint();
  if (!endpoint || typeof WebSocket === 'undefined') {
    setWs('off');
    return;
  }
  socketUrl = endpoint;
  setWs('connecting');
  let ws;
  try {
    ws = new WebSocket(endpoint);
  } catch {
    setWs('reconnecting');
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    reconnectAttempt = 0;
    setWs('open');
    try {
      ws.send(JSON.stringify({ type: 'subscribe', topics: ['agents', 'tasks', 'approvals', 'system'] }));
    } catch {
      /* ignore: the server will just use its default subscription */
    }
    refresh({ silent: true });
  };
  ws.onmessage = (event) => {
    let msg = null;
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }
    Object.assign(sync, { lastEventAt: Date.now() });
    if (msg?.type === 'hello') {
      if (msg.principal && getAuth().principal && msg.principal.id !== getAuth().principal.id) {
        // Credentials changed underneath us; refetch through the HTTP paths instead.
        disconnectLive();
      }
      return;
    }
    if (msg?.type === 'subscribed') {
      if (Array.isArray(msg.refused) && msg.refused.length) {
        Object.assign(sync, { error: `Some live topics were refused: ${msg.refused.join(', ')}` });
        emit();
      }
      return;
    }
    if (['agents', 'tasks', 'approvals', 'system'].includes(msg?.topic)) scheduleRefresh();
  };
  ws.onerror = () => {
    /* onclose handles the state machine */
  };
  ws.onclose = (event) => {
    socket = null;
    if (!isApiMode() || !isAuthenticated()) {
      setWs('off');
      return;
    }
    // 4401/1008: the gateway refused credentials — do not hammer it.
    if (event?.code === 1008 || event?.code === 4401) {
      setWs('refused');
      return;
    }
    setWs('reconnecting');
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  const delay = Math.min(30000, 1000 * 2 ** reconnectAttempt);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    if (isApiMode() && isAuthenticated()) connectLive();
  }, delay);
}

export function disconnectLive() {
  clearTimeout(reconnectTimer);
  reconnectAttempt = 0;
  if (socket) {
    try {
      socket.onclose = null;
      socket.close();
    } catch {
      /* already closed */
    }
    socket = null;
  }
  setWs('off');
}

export const getSocketUrl = () => socketUrl;

/* ---------- lifecycle ---------- */
let started = false;

/**
 * Wire the data layer to the session. Called once at boot; safe to call repeatedly.
 * @param {{force?: boolean}} options
 */
export function initDataSync({ force = false } = {}) {
  if (started && !force) return getStatus();
  started = true;

  subscribeAuth((auth) => {
    if (auth.status === 'authenticated') {
      refresh({ silent: sync.status === 'live' }).then((out) => {
        if (out.ok) connectLive();
      });
    } else {
      releaseGatewayData({ reason: auth.status === 'unreachable' ? 'gateway-unreachable' : 'signed-out' });
      if (auth.status === 'unreachable') {
        Object.assign(sync, { status: 'error', error: auth.error || 'gateway unreachable' });
        emit();
      }
    }
  });

  if (isAuthenticated()) {
    refresh().then((out) => {
      if (out.ok) connectLive();
    });
  } else {
    Object.assign(sync, { status: isApiMode() ? 'degraded' : 'demo' });
    emit();
  }

  // Re-check on tab focus (the session may have expired elsewhere) and on reconnect.
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', () => {
      if (isAuthenticated()) refresh({ silent: true }).then((out) => {
        if (out.ok && !socket) connectLive();
      });
    });
    window.addEventListener('online', () => {
      if (isAuthenticated()) refresh({ silent: true }).then((out) => {
        if (out.ok && !socket) connectLive();
      });
    });
    window.addEventListener('offline', () => {
      Object.assign(sync, { error: 'offline — gateway data may be stale' });
      emit();
    });
  }

  return getStatus();
}

/** Test seam: forget all module state so suites can re-initialise the layer. */
export function __resetDataSync() {
  disconnectLive();
  clearTimeout(refreshTimer);
  clearTimeout(reconnectTimer);
  refreshTimer = null;
  refreshInFlight = null;
  demoSnapshot = null;
  started = false;
  Object.assign(sync, { status: 'idle', error: null, at: null, ws: 'off', lastEventAt: null, requestId: null });
}

export { isLive };

/* ---------- write-through helpers ----------
 * Writes go to the server; the row that lands in state is the server's copy (never a local guess).
 * If the write fails nothing is changed locally, so a "saved" row always exists on the gateway.
 */
function upsert(slice, row) {
  const current = getState()[slice] || [];
  const idx = current.findIndex((x) => x.id === row.id);
  const next = idx >= 0 ? current.map((x) => (x.id === row.id ? row : x)) : [row, ...current];
  replaceSlices({ [slice]: next }, 'data:write');
  return row;
}

export async function createAgent(draft) {
  const out = await api.createAgent(draft);
  const row = adaptAgent(out.body);
  if (isLive('agents')) upsert('agents', row);
  scheduleRefresh(300); // let the server settle ordering/derived fields
  return row;
}

export async function updateAgent(id, patch) {
  const out = await api.updateAgent(id, patch);
  const row = adaptAgent(out.body);
  if (isLive('agents')) upsert('agents', row);
  return row;
}

export async function createTask(draft) {
  const out = await api.createTask(draft);
  const row = adaptTask(out.body);
  row.column = normaliseColumn(row.column);
  if (isLive('tasks')) upsert('tasks', row);
  scheduleRefresh(300);
  return row;
}

export async function updateTask(id, patch) {
  const out = await api.updateTask(id, patch);
  const row = adaptTask(out.body);
  row.column = normaliseColumn(row.column);
  if (isLive('tasks')) upsert('tasks', row);
  return row;
}

export async function decideApproval(id, decision) {
  const out = await api.decideApproval(id, decision);
  const row = adaptApproval(out.body);
  if (isLive('approvals')) upsert('approvals', row);
  scheduleRefresh(300);
  return row;
}

export async function requestApproval(draft) {
  const out = await api.requestApproval(draft);
  const row = adaptApproval(out.body);
  if (isLive('approvals')) upsert('approvals', row);
  scheduleRefresh(300);
  return row;
}
