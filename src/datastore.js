/* ============ Data layer: gateway-backed slices with explicit provenance ============
 * Rule: a screen must never show gateway rows as if they were demo data, or the reverse.
 *
 *   demo      — seeded fixtures persisted in this browser
 *   gateway   — fetched from GET /api/v1/* for the signed-in principal
 *   degraded  — a gateway session exists but the last refresh failed; demo fixtures are shown
 *               and labelled as such (never a stale mix)
 *
 * Agents, tasks, approvals, events, teams, threads and swarm *plans* exist on the gateway. Teams are
 * names and topology only: membership is `agents.team_id`, fetched in the same pull, so there is one
 * value to read. A swarm is a saved plan — `executed: false`, no progress, no spend — and the server
 * says so on every row, so the screen never has to infer it. Usage stays local and is labelled demo.
 */
import { getState, replaceSlices, setProvenance, getProvenance, isLive, setPersistFilter, resetDemo, setState, uid, now } from './core.js';
import { api, ApiError, isApiMode, gatewayUrl } from './api.js';
import { getAuth, getAuthVersion, subscribeAuth, isAuthenticated, refreshSession } from './auth.js';
import { demoCommsForPersistence } from './commsGateway.js';

export const GATEWAY_SLICES = ['agents', 'tasks', 'approvals', 'events', 'teams', 'threads', 'swarms', 'providers'];
export const LOCAL_SLICES = ['usage'];

const listeners = new Set();
/* Panels that want their own live refresh (the Self-Improvement cycle) subscribe here instead of
 * polling every second. They still poll slowly as a fallback for when the socket is down. */
const evolutionListeners = new Set();
export function subscribeEvolution(fn) {
  evolutionListeners.add(fn);
  return () => evolutionListeners.delete(fn);
}

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
let syncGeneration = 0;
let ownerVersion = null;
/** Server sentence about swarm plans ("nothing executes one"); null while the slice is demo. */
let swarmsRuntimeNote = null;
export const getSwarmsRuntime = () => swarmsRuntimeNote;

/* The model ledger: every number on the Models screen comes from here, and here is the gateway's own
 * answer to `GET /usage` + `GET /model-calls`. It is null in demo mode, which is the signal the screen
 * uses to say "no ledger" instead of drawing a chart. */
let modelsLedger = null;
export const getModelsLedger = () => modelsLedger;

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
    teamId: row.team_id ?? null,
    teamPosition: num(row.team_position, 0),
    description: row.description || '',
    goal: row.goal || '',
    responsibilities: arr(maybeJson(row.responsibilities, [])),
    approvalGates: maybeJson(row.approval_gates, {}) || {},
    memory: {
      episodic: num(memory.episodic, 0),
      semantic: num(memory.semantic, 0),
      kb: memory.kb || '0 MB',
    },
    source: 'gateway',
  };
}

export function adaptTeam(row) {
  return {
    id: row.id,
    name: row.name || 'Untitled team',
    topology: row.topology || 'Hierarchical',
    health: row.health || 'good',
    description: row.description || '',
    source: 'gateway',
  };
}

/** A swarm row from the gateway. `executed` decides progress and spend, never the stored columns. */
export function adaptSwarm(row) {
  const budget = maybeJson(row.budget, {});
  const nodes = arr(maybeJson(row.nodes, []));
  const executed = Boolean(row.executed);
  return {
    id: row.id,
    teamId: row.teamId || row.team_id || null,
    name: row.name || 'Untitled plan',
    objective: row.objective || '',
    status: row.status || 'planned',
    executed,
    progress: executed ? num(row.progress) : 0,
    budget: { cap: num(budget.cap), spent: executed ? num(budget.spent) : 0 },
    nodes: nodes.map((n) => ({
      id: String(n.id || ''),
      label: String(n.label || ''),
      agent: String(n.agent || ''),
      status: executed ? String(n.status || 'planned') : 'planned',
      spent: executed ? num(n.spent) : 0,
      elapsed: executed ? String(n.elapsed || '—') : '—',
    })),
    channel: row.channel || 'app',
    startedAt: num(row.startedAt ?? row.started_at),
    updatedAt: num(row.updatedAt ?? row.updated_at ?? row.startedAt ?? row.started_at),
    createdBy: row.createdBy || row.created_by || 'system',
    note: row.note || row.run_note || '',
    runtime: row.runtime || null,
    source: 'gateway',
  };
}

export function adaptMessage(row) {
  let payload = {};
  try { payload = row.payload ? (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) : {}; } catch { payload = {}; }
  return {
    id: row.id,
    from: row.from || row.from_principal || 'me',
    agent: row.agent || '',
    text: row.text ?? row.body ?? '',
    kind: row.kind || 'text',
    payload,
    ts: num(row.ts, Date.now()),
    source: 'gateway',
  };
}

export function adaptThread(row) {
  const messages = arr(row.messages).map(adaptMessage);
  return {
    id: row.id,
    kind: row.kind || 'direct',
    title: row.title || 'Untitled thread',
    unread: num(row.unread, 0),
    createdAt: num(row.createdAt ?? row.created_at, Date.now()),
    messages,
    messageCount: num(row.messageCount, messages.length),
    truncated: Boolean(row.truncated),
    source: 'gateway',
  };
}

/** The gateway's own statement about what chat can do here. Never inferred on the client. */
export function adaptChatRuntime(runtime) {
  if (!runtime || typeof runtime !== 'object') {
    return {
      connected: true, configured: false, generatesReplies: false, driver: 'none',
      note: 'This gateway serves no chat runtime information, so no reply can be expected.',
    };
  }
  return {
    connected: true,
    configured: Boolean(runtime.configured),
    generatesReplies: Boolean(runtime.generatesReplies),
    driver: runtime.driver || 'none',
    note: runtime.note || '',
  };
}

/** A provider row from the gateway. `status` is `configured` only when a key is actually sealed. */
export function adaptProvider(row) {
  const status = row?.status === 'configured' ? 'configured' : 'unconfigured';
  return {
    id: row?.id || '',
    name: row?.name || row?.id || '',
    category: row?.category || 'Other',
    auth: row?.auth || 'API key',
    models: arr(row?.models),
    defaultModel: row?.defaultModel || '',
    status,
    endpoint: row?.endpoint || '',
    endpointHost: row?.endpointHost || '',
    fingerprint: row?.fingerprint || '',
    hint: row?.hint || '',
    configuredAt: row?.configuredAt ?? null,
    configuredBy: row?.configuredBy || '',
    spendMtd: num(row?.spendMtd, 0),
    callsMtd: num(row?.callsMtd, 0),
    lastCallAt: row?.lastCallAt ?? null,
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
  demoSnapshot.chatRuntime = JSON.parse(JSON.stringify(s.chatRuntime ?? {}));
  return demoSnapshot;
}

/** Keep gateway rows out of localStorage; the server is their only owner. */
setPersistFilter((state) => {
  const out = { ...state };
  for (const slice of GATEWAY_SLICES) {
    if (state.provenance?.[slice] === 'gateway' && demoSnapshot) out[slice] = demoSnapshot[slice];
  }
  // Comms channels are gateway-owned when a session holds comms:read: the statuses and masked
  // configuration must not survive in localStorage, where they would later look live.
  if (state.provenance?.comms === 'gateway') {
    out.comms = demoCommsForPersistence();
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
  if (st.provenance[slice] === 'gateway') {
    if (st.status === 'error' || st.status === 'degraded') return { source: 'gateway', label: 'stale gateway data', detail: st.error || 'The last gateway refresh failed.' };
    return { source: 'gateway', label: 'live gateway', detail: `${st.url} · refreshed ${st.at ? new Date(st.at).toLocaleTimeString() : '—'}` };
  }
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
  const teams = (data.teams || []).map(adaptTeam);
  // A gateway that predates the chat routes returns no array here. That is a real state, and the
  // screen has to say "this gateway serves no transcript" rather than show demo threads as live.
  const threads = Array.isArray(data.threads) ? data.threads.map(adaptThread) : null;
  const swarms = Array.isArray(data.swarms) ? data.swarms.map(adaptSwarm) : null;
  // A gateway without the model routes returns nothing here; `null` keeps the slice on demo
  // provenance and the screen says it has no ledger.
  const providers = Array.isArray(data.providers) ? data.providers.map(adaptProvider) : null;

  // Set ownership before publishing rows to subscribers or persistence.
  // Slices without a server store stay local and keep their demo provenance.
  setProvenance({
    agents: 'gateway',
    tasks: 'gateway',
    approvals: 'gateway',
    events: 'gateway',
    swarms: swarms ? 'gateway' : 'demo',
    providers: providers ? 'gateway' : 'demo',
    teams: 'gateway',
    threads: threads ? 'gateway' : 'demo',
    usage: 'demo',
  });
  const chatRuntime = threads ? adaptChatRuntime(data.chatRuntime) : getState().chatRuntime;
  swarmsRuntimeNote = swarms ? (data.swarmsRuntime || null) : null;
  modelsLedger = providers
    ? {
      runtime: data.modelsRuntime || null,
      budget: data.modelsBudget || null,
      usage: data.modelsUsage || null,
      calls: Array.isArray(data.modelsCalls) ? data.modelsCalls : [],
      at: Date.now(),
    }
    : null;
  replaceSlices(
    {
      agents, tasks, approvals, events, teams, chatRuntime,
      ...(threads ? { threads } : {}),
      ...(swarms ? { swarms } : {}),
      ...(providers ? { providers } : {}),
    },
    'data:gateway',
  );
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
  return { agents: agents.length, tasks: tasks.length, approvals: approvals.length, events: events.length, teams: teams.length };
}

/** Restore the pre-gateway fixtures and forget gateway rows. */
export function releaseGatewayData({ reason = 'signed-out' } = {}) {
  syncGeneration += 1;
  refreshInFlight = null;
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
  swarmsRuntimeNote = null;
  modelsLedger = null;
  setProvenance({ agents: 'demo', tasks: 'demo', approvals: 'demo', events: 'demo', swarms: 'demo', providers: 'demo', teams: 'demo', threads: 'demo', usage: 'demo' });
  Object.assign(sync, { status: isApiMode() ? 'degraded' : 'demo', error: reason === 'signed-out' ? null : sync.error, at: Date.now(), ws: 'off' });
  emit();
}

export function reloadDemoData() {
  releaseGatewayData({ reason: 'reset' });
  resetDemo();
  emit();
}

async function fetchAll() {
  const [agents, tasks, approvals, events, teams, threads, swarms, providers, modelsUsage, modelsCalls] = await Promise.all([
    api.agents(),
    api.tasks(),
    api.approvals(),
    api.events(0),
    // Teams are only names/topology now: membership is read from the agent rows fetched alongside.
    api.teams().catch(() => ({ body: { teams: [] } })),
    // A gateway without the chat routes must not fail the whole refresh; `threads: null` below
    // keeps the slice on demo provenance and the screen says so.
    api.threads().catch(() => null),
    // A gateway older than the swarm routes returns 404 here. That must not fail the whole refresh, and
    // it must not make demo fixtures look live: `swarms: null` keeps the slice on demo provenance.
    api.swarms().catch(() => null),
    // Same rule for the model routes: absent on an older gateway, and that must not fail the refresh.
    api.providers().catch(() => null),
    api.usage().catch(() => null),
    api.modelCalls(12).catch(() => null),
  ]);
  return {
    agents: agents.body,
    tasks: tasks.body,
    approvals: approvals.body,
    events: events.body,
    teams: teams.body?.teams || [],
    threads: threads?.body?.threads ?? null,
    chatRuntime: threads?.body?.runtime ?? null,
    swarms: Array.isArray(swarms?.body?.swarms) ? swarms.body.swarms : null,
    swarmsRuntime: swarms?.body?.runtime ?? null,
    providers: Array.isArray(providers?.body?.providers) ? providers.body.providers : null,
    modelsRuntime: providers?.body?.runtime ?? null,
    modelsBudget: providers?.body?.budget ?? null,
    modelsUsage: modelsUsage?.body ?? null,
    modelsCalls: Array.isArray(modelsCalls?.body?.calls) ? modelsCalls.body.calls : null,
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
  const version = getAuthVersion();
  const generation = syncGeneration;
  const current = () => generation === syncGeneration && version === getAuthVersion() && isAuthenticated();
  const promise = fetchAll()
    .then((data) => current() ? ({ ok: true, counts: adopt(data, { requestId: data.requestId }) }) : ({ ok: false, reason: 'session-changed' }))
    .catch((err) => {
      if (!current()) return { ok: false, reason: 'session-changed' };
      const unauthenticated = err instanceof ApiError && err.unauthenticated;
      if (err instanceof ApiError && (err.forbidden || err.unauthenticated)) releaseGatewayData({ reason: 'refresh-denied' });
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
      if (refreshInFlight === promise) refreshInFlight = null;
    });
  refreshInFlight = promise;
  return promise;
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
  const version = getAuthVersion();
  const current = () => socket === ws && version === getAuthVersion() && isAuthenticated();

  ws.onopen = () => {
    if (!current()) return;
    reconnectAttempt = 0;
    setWs('open');
    try {
      ws.send(JSON.stringify({ type: 'subscribe', topics: ['agents', 'tasks', 'approvals', 'system', 'evolution', 'chat', 'swarms', 'models'] }));
    } catch {
      /* ignore: the server will just use its default subscription */
    }
    refresh({ silent: true });
  };
  ws.onmessage = (event) => {
    if (!current()) return;
    let msg = null;
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }
    Object.assign(sync, { lastEventAt: Date.now() });
    if (msg?.type === 'hello') {
      if (msg.principal && getAuth().principal && msg.principal.id !== getAuth().principal.id) {
        // Credentials changed underneath us: drop the old view immediately and reauthenticate.
        disconnectLive();
        refreshSession().catch(() => {});
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
    if (msg?.topic === 'evolution') {
      evolutionListeners.forEach((fn) => { try { fn(msg); } catch { /* a panel must not break the socket */ } });
      return;
    }
    if (['agents', 'tasks', 'approvals', 'system', 'chat', 'swarms', 'models'].includes(msg?.topic)) scheduleRefresh();
  };
  ws.onerror = () => {
    /* onclose handles the state machine */
  };
  ws.onclose = (event) => {
    if (socket !== ws) return;
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
      const version = getAuthVersion();
      if (ownerVersion !== null && ownerVersion !== version) releaseGatewayData({ reason: 'identity-changed' });
      ownerVersion = version;
      refresh({ silent: sync.status === 'live' }).then((out) => {
        if (out.ok) connectLive();
      });
    } else {
      ownerVersion = null;
      releaseGatewayData({ reason: auth.status === 'unreachable' ? 'gateway-unreachable' : 'signed-out' });
      if (auth.status === 'unreachable') {
        Object.assign(sync, { status: 'error', error: auth.error || 'gateway unreachable' });
        emit();
      }
    }
  });

  if (isAuthenticated()) {
    ownerVersion = getAuthVersion();
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
  syncGeneration += 1;
  ownerVersion = null;
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

export async function runAgent(id, objective) {
  const out = await api.runAgent(id, objective);
  scheduleRefresh(150);
  return out.body;
}

export async function getAgentRuns(id, limit = 20) {
  const out = await api.agentRuns(id, limit);
  return out.body.runs || [];
}

/* ---------- teams ----------
 * Membership is a column on the agent row, so a member change is an agent write. These helpers exist
 * so callers never build a second, client-side membership list.
 */
export async function createTeam(draft) {
  const out = await api.createTeam(draft);
  if (isLive('teams')) scheduleRefresh(250);
  return out.body;
}

export async function updateTeam(id, patch) {
  const out = await api.updateTeam(id, patch);
  if (isLive('teams')) scheduleRefresh(250);
  return out.body;
}

export async function deleteTeam(id) {
  const out = await api.deleteTeam(id);
  // The server unassigned the members; re-read rather than editing the local copy by hand.
  scheduleRefresh(200);
  return out.body;
}

export async function assignAgentToTeam(agentId, teamId, position = null) {
  const row = await updateAgent(agentId, { team_id: teamId ?? null, team_position: position });
  return row;
}

export async function reorderTeam(teamId, order) {
  const out = await api.reorderTeam(teamId, order);
  scheduleRefresh(200);
  return out.body;
}

/* ---------- swarm plans ----------
 * Nothing here starts anything: these helpers save, edit, re-label and delete a plan. `executed` comes
 * back from the server as `false`, and a client that asked for anything else is refused upstream.
 */
export async function createSwarmPlan(draft) {
  const out = await api.createSwarm(draft);
  const row = adaptSwarm(out.body.swarm);
  if (isLive('swarms')) upsert('swarms', row);
  scheduleRefresh(250);
  return row;
}

export async function updateSwarmPlan(id, patch) {
  const out = await api.updateSwarm(id, patch);
  const row = adaptSwarm(out.body.swarm);
  if (isLive('swarms')) upsert('swarms', row);
  return row;
}

export async function setSwarmPlanStatus(id, status) {
  const out = await api.setSwarmStatus(id, status);
  const row = adaptSwarm(out.body.swarm);
  if (isLive('swarms')) upsert('swarms', row);
  scheduleRefresh(250);
  return row;
}

export async function deleteSwarmPlan(id) {
  const out = await api.deleteSwarm(id);
  replaceSlices({ swarms: (getState().swarms || []).filter((s) => s.id !== id) }, 'data:swarm-delete');
  scheduleRefresh(200);
  return out.body;
}


/* ---------- model gateway ----------
 * A key is written once and never read back: the row that lands in state carries a fingerprint and a
 * four-character hint. A call is metered by the gateway, so the client never invents a cost — it asks
 * for a refresh and shows what the ledger says.
 */
export async function saveProviderKey(id, body) {
  const out = await api.saveProviderKey(id, body);
  if (isLive('providers')) upsert('providers', adaptProvider(out.body.provider));
  scheduleRefresh(200);
  return out.body.provider;
}

export async function clearProviderKey(id) {
  const out = await api.clearProviderKey(id);
  if (isLive('providers')) upsert('providers', adaptProvider(out.body.provider));
  scheduleRefresh(200);
  return out.body;
}

export async function setModelBudget(body) {
  const out = await api.setModelBudget(body);
  scheduleRefresh(150);
  return out.body.budget;
}

/** One real model call. The reply is returned to the caller; the ledger is re-read from the server. */
export async function callProviderModel(id, body) {
  const out = await api.callProviderModel(id, body);
  scheduleRefresh(150);
  return out.body;
}

export async function deleteAgent(id) {
  const out = await api.deleteAgent(id);
  replaceSlices({ agents: (getState().agents || []).filter((a) => a.id !== id) }, 'data:delete');
  scheduleRefresh(200);
  return out.body;
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

/* ---------- chat ----------
 * Chat is a transcript. There is no model runtime, so nothing here waits for or invents a reply:
 * a send stores exactly what was typed, and the slice is re-read from the server afterwards.
 */
export async function sendChatMessage(threadId, text) {
  const body = String(text ?? '').trim();
  if (!body) throw new Error('a message needs text');
  if (!isLive('threads')) {
    // Demo: the transcript lives in this browser, and the runtime banner says exactly that.
    const message = { id: uid('m'), from: 'me', text: body, ts: now() };
    setState((st) => {
      const thread = st.threads.find((t) => t.id === threadId);
      if (thread) { thread.messages.push(message); thread.unread = 0; }
    }, 'chat-send');
    return { message, local: true, runtime: getState().chatRuntime };
  }
  // A stable key per attempt: a retry (double tap, flaky network) cannot become a second message.
  const clientId = globalThis.crypto?.randomUUID?.() || uid('cid');
  const out = await api.sendMessage(threadId, { text: body, clientId });
  const message = adaptMessage(out.body.message);
  // Fold the server's copy into the thread, then let the next refresh settle ordering/counters.
  setState((st) => {
    const thread = st.threads.find((t) => t.id === threadId);
    if (thread) { thread.messages = [...thread.messages, message]; thread.messageCount = (thread.messageCount || 0) + 1; }
  }, 'chat-send');
  if (out.body.runtime) replaceSlices({ chatRuntime: adaptChatRuntime(out.body.runtime) }, 'chat-runtime');
  scheduleRefresh(250);
  return { message, runtime: getState().chatRuntime };
}

export async function createChatThread({ title, kind = 'direct' }) {
  const name = String(title ?? '').trim();
  if (!name) throw new Error('a thread needs a title');
  if (!isLive('threads')) {
    const thread = { id: uid('th'), kind, title: name, unread: 0, createdAt: now(), messages: [], messageCount: 0, truncated: false };
    setState((st) => { st.threads.unshift(thread); }, 'chat-thread');
    return thread;
  }
  const out = await api.createThread({ title: name, kind });
  const thread = adaptThread(out.body.thread);
  setState((st) => { st.threads = [thread, ...st.threads.filter((t) => t.id !== thread.id)]; }, 'chat-thread');
  scheduleRefresh(250);
  return thread;
}

export async function markChatRead(threadId) {
  if (!isLive('threads')) {
    setState((st) => { const t = st.threads.find((x) => x.id === threadId); if (t) t.unread = 0; }, 'chat-read');
    return { cleared: 0, local: true };
  }
  const out = await api.markThreadRead(threadId);
  setState((st) => { const t = st.threads.find((x) => x.id === threadId); if (t) t.unread = 0; }, 'chat-read');
  return out.body;
}

export async function deleteChatThread(threadId) {
  if (!isLive('threads')) {
    setState((st) => { st.threads = st.threads.filter((t) => t.id !== threadId); }, 'chat-thread-delete');
    return { deleted: threadId, local: true };
  }
  const out = await api.deleteThread(threadId);
  setState((st) => { st.threads = st.threads.filter((t) => t.id !== threadId); }, 'chat-thread-delete');
  return out.body;
}
