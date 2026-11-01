/* ============ MMM API client ============
 * Transport for the gateway. Two modes:
 *   demo — no gateway configured; the app runs on local seeded state (nothing is enforced).
 *   api  — a gateway URL is configured; the app authenticates and enforces through it.
 *
 * Cookies carry the session (HttpOnly, SameSite=Strict), so every request uses
 * `credentials: 'include'`. Mutations additionally send the HMAC CSRF token that the gateway
 * exposes via /api/v1/auth/session. No credential is ever kept in localStorage.
 */

const CONFIG_KEY = 'mmm.gateway';
const CSRF_HEADER = 'x-mmm-csrf';

function envUrl() {
  try {
    return import.meta?.env?.VITE_GATEWAY_URL || '';
  } catch {
    return '';
  }
}

function storedUrl() {
  try {
    return globalThis.localStorage?.getItem(CONFIG_KEY) || '';
  } catch {
    return '';
  }
}

/** '/' means same-origin (Vite dev proxy or a reverse proxy that serves the gateway under /). */
const normalize = (url) => {
  const value = String(url || '').trim();
  if (!value) return '';
  if (value === '/') return '/';
  return value.replace(/\/+$/, '');
};

let config = {
  url: normalize(storedUrl() || envUrl() || ''),
  source: storedUrl() ? 'local' : envUrl() ? 'env' : 'none',
};
let csrfToken = null;
let sessionEpoch = 0;
const activeControllers = new Set();

/** Invalidate outstanding requests and their CSRF token when the identity changes. */
export function invalidateApiSession() {
  sessionEpoch += 1;
  for (const controller of activeControllers) controller.abort();
  csrfToken = null;
}

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'error', body = null, requestId = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.requestId = requestId;
  }

  get unauthenticated() {
    return this.status === 401;
  }

  get forbidden() {
    return this.status === 403;
  }

  get offline() {
    return this.status === 0;
  }
}

export const gatewayUrl = () => config.url;
export const gatewayLabel = () =>
  !config.url ? 'not configured' : config.url === '/' ? `${globalThis.location?.origin || 'same origin'} (proxy)` : config.url;
export const configSource = () => config.source;
export const isApiMode = () => Boolean(config.url);
export const mode = () => (isApiMode() ? 'api' : 'demo');

export function setGatewayUrl(url) {
  const clean = normalize(url);
  config = { url: clean, source: clean ? 'local' : 'none' };
  invalidateApiSession();
  try {
    if (clean) globalThis.localStorage?.setItem(CONFIG_KEY, clean);
    else globalThis.localStorage?.removeItem(CONFIG_KEY);
  } catch {
    /* storage blocked — config stays in memory for this session */
  }
  return config.url;
}

export function setCsrfToken(token) {
  csrfToken = token || null;
}

export const getCsrfToken = () => csrfToken;

/** Raw request helper: no retries, no hidden fallbacks. */
async function request(path, { method = 'GET', body, headers = {}, timeoutMs = 8000, signal } = {}) {
  if (!isApiMode()) {
    throw new ApiError('No gateway configured — the app is running on local demo data.', { status: 0, code: 'no-gateway' });
  }
  const epoch = sessionEpoch;
  const controller = new AbortController();
  activeControllers.add(controller);
  let timedOut = false;
  const abortExternal = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abortExternal, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abortExternal); activeControllers.delete(controller); };
  const finalSignal = controller.signal;

  const h = { Accept: 'application/json', ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) h[CSRF_HEADER] = csrfToken;

  const origin = config.url === '/' ? '' : config.url;
  let res;
  try {
    res = await fetch(`${origin}${path}`, {
      method,
      credentials: 'include',
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: finalSignal,
      cache: 'no-store',
    });
  } catch (err) {
    cleanup();
    const aborted = err?.name === 'AbortError';
    throw new ApiError(
      timedOut ? `Gateway did not answer within ${timeoutMs} ms` : aborted ? 'Gateway request cancelled' : 'Gateway unreachable (network or CORS)',
      { status: 0, code: timedOut ? 'timeout' : aborted ? 'cancelled' : 'network' }
    );
  }

  const requestId = res.headers.get('x-mmm-request-id');
  let text;
  try { text = await res.text(); } catch (err) {
    cleanup();
    throw new ApiError(timedOut ? `Gateway did not answer within ${timeoutMs} ms` : 'Gateway response interrupted',
      { status: 0, code: timedOut ? 'timeout' : 'network' });
  }
  cleanup();
  if (epoch !== sessionEpoch) throw new ApiError('Session changed while the request was in flight.', { code: 'stale-session' });
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text.slice(0, 500) };
    }
  }

  if (!res.ok) {
    if (res.status === 401 && !['/api/v1/auth/login', '/api/v1/auth/session'].includes(path) && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('mmm:unauthenticated', { detail: { path } }));
    }
    const message =
      payload?.error ||
      (res.status === 401 ? 'Not signed in' : res.status === 403 ? 'Not permitted' : `Gateway returned HTTP ${res.status}`);
    throw new ApiError(message, {
      status: res.status,
      body: payload,
      requestId,
      code: res.status === 401 ? 'unauthenticated' : res.status === 403 ? 'forbidden' : 'http',
    });
  }
  return { body: payload, status: res.status, requestId, headers: res.headers };
}

/* ---------- endpoints ---------- */
export const api = {
  health: (opts) => request('/healthz', { timeoutMs: 2500, ...opts }),

  session: async () => {
    const out = await request('/api/v1/auth/session');
    return out.body;
  },
  login: async (email, password) => {
    const out = await request('/api/v1/auth/login', { method: 'POST', body: { email, password } });
    return out.body;
  },
  logout: async () => {
    const out = await request('/api/v1/auth/logout', { method: 'POST' });
    setCsrfToken(null);
    return out.body;
  },
  changePassword: (currentPassword, newPassword) =>
    request('/api/v1/auth/password', { method: 'POST', body: { currentPassword, newPassword } }),
  roles: () => request('/api/v1/roles'),

  principals: () => request('/api/v1/principals'),
  createPrincipal: (body) => request('/api/v1/principals', { method: 'POST', body }),
  updatePrincipal: (id, body) => request(`/api/v1/principals/${encodeURIComponent(id)}`, { method: 'PATCH', body }),

  tokens: () => request('/api/v1/tokens'),
  createToken: (body) => request('/api/v1/tokens', { method: 'POST', body }),
  revokeToken: (id) => request(`/api/v1/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  summary: () => request('/api/v1/summary'),
  agents: () => request('/api/v1/agents'),
  createAgent: (body) => request('/api/v1/agents', { method: 'POST', body }),
  updateAgent: (id, body) => request(`/api/v1/agents/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  deleteAgent: (id) => request(`/api/v1/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  tasks: () => request('/api/v1/tasks'),
  createTask: (body) => request('/api/v1/tasks', { method: 'POST', body }),
  updateTask: (id, body) => request(`/api/v1/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  approvals: () => request('/api/v1/approvals'),
  requestApproval: (body) => request('/api/v1/approvals', { method: 'POST', body }),
  decideApproval: (id, decision) =>
    request(`/api/v1/approvals/${encodeURIComponent(id)}/${decision === 'deny' ? 'deny' : 'allow'}`, { method: 'POST' }),
  comms: () => request('/api/v1/comms'),
  saveCommsChannel: (id, body) => request(`/api/v1/comms/${encodeURIComponent(id)}`, { method: 'PUT', body }),
  deleteCommsChannel: (id) => request(`/api/v1/comms/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  sendComms: (id, body) => request(`/api/v1/comms/${encodeURIComponent(id)}/send`, { method: 'POST', body }),
  runCommsQueue: () => request('/api/v1/comms/queue', { method: 'POST', body: {} }),
  saveCommsSettings: (body) => request('/api/v1/comms/settings', { method: 'PUT', body }),
  commsMessages: (params = '') => request(`/api/v1/comms/messages${params}`),
  threads: () => request('/api/v1/threads'),
  thread: (id) => request(`/api/v1/threads/${encodeURIComponent(id)}`),
  createThread: (body) => request('/api/v1/threads', { method: 'POST', body }),
  sendMessage: (id, body) => request(`/api/v1/threads/${encodeURIComponent(id)}/messages`, { method: 'POST', body }),
  markThreadRead: (id) => request(`/api/v1/threads/${encodeURIComponent(id)}/read`, { method: 'POST', body: {} }),
  deleteThread: (id) => request(`/api/v1/threads/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  evolutionCapabilities: () => request('/api/v1/evolution/capabilities'),
  teams: () => request('/api/v1/teams'),
  team: (id) => request(`/api/v1/teams/${encodeURIComponent(id)}`),
  createTeam: (body) => request('/api/v1/teams', { method: 'POST', body }),
  updateTeam: (id, body) => request(`/api/v1/teams/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  deleteTeam: (id) => request(`/api/v1/teams/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  addTeamMember: (id, body) => request(`/api/v1/teams/${encodeURIComponent(id)}/members`, { method: 'POST', body }),
  removeTeamMember: (id, agentId) => request(`/api/v1/teams/${encodeURIComponent(id)}/members/${encodeURIComponent(agentId)}`, { method: 'DELETE' }),
  reorderTeam: (id, order) => request(`/api/v1/teams/${encodeURIComponent(id)}/order`, { method: 'POST', body: { order } }),
  evolutionAgents: () => request('/api/v1/evolution/agents'),
  evolutionPolicy: (agentId) => request(`/api/v1/evolution/agents/${encodeURIComponent(agentId)}/policy`),
  updateEvolutionPolicy: (agentId, body) => request(`/api/v1/evolution/agents/${encodeURIComponent(agentId)}/policy`, { method: 'PATCH', body }),
  evolutionGrants: (agentId) => request(`/api/v1/evolution/agents/${encodeURIComponent(agentId)}/grants`),
  createEvolutionGrant: (body) => request('/api/v1/evolution/grants', { method: 'POST', body }),
  evolutionObservations: (agentId) => request(`/api/v1/evolution/agents/${encodeURIComponent(agentId)}/observations`),
  recordEvolutionObservation: (agentId, body) => request(`/api/v1/evolution/agents/${encodeURIComponent(agentId)}/observations`, { method: 'POST', body }),
  evolutionVersions: (agentId) => request(`/api/v1/evolution/agents/${encodeURIComponent(agentId)}/versions`),
  evolutionHealth: (agentId) => request(`/api/v1/evolution/agents/${encodeURIComponent(agentId)}/health`, { method: 'POST', body: {} }),
  evolutionRollback: (agentId, body) => request(`/api/v1/evolution/agents/${encodeURIComponent(agentId)}/rollback`, { method: 'POST', body }),
  evolutionExperiments: (agentId = '') => request(`/api/v1/evolution/experiments${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`),
  createEvolutionExperiment: (body) => request('/api/v1/evolution/experiments', { method: 'POST', body }),
  evolutionExperiment: (id) => request(`/api/v1/evolution/experiments/${encodeURIComponent(id)}`),
  evolutionFile: (id, path) => request(`/api/v1/evolution/experiments/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`),
  evolutionStep: (id, step, body = {}) => request(`/api/v1/evolution/experiments/${encodeURIComponent(id)}/${step}`, { method: 'POST', body }),
  browserCapabilities: () => request('/api/v1/browser/capabilities'),
  browserTasks: (limit = 30) => request(`/api/v1/browser/tasks?limit=${Number(limit) || 30}`),
  browserTask: (id) => request(`/api/v1/browser/tasks/${encodeURIComponent(id)}`),
  createBrowserTask: (body) => request('/api/v1/browser/tasks', { method: 'POST', body }),
  browserControl: (id, action) => request(`/api/v1/browser/tasks/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} }),
  browserEvidence: (id, evidenceId) =>
    request(`/api/v1/browser/tasks/${encodeURIComponent(id)}/evidence/${encodeURIComponent(evidenceId)}`),
  events: (cursor = 0) => request(`/api/v1/events?cursor=${Number(cursor) || 0}`),
  audit: (limit = 50) => request(`/api/v1/audit?limit=${Number(limit) || 50}`),
  verifyAudit: () => request('/api/v1/audit/verify'),
};

export { request as rawRequest };
