/* ============ SwarmOS API client ============
 * Transport for the gateway. Two modes:
 *   demo — no gateway configured; the app runs on local seeded state (nothing is enforced).
 *   api  — a gateway URL is configured; the app authenticates and enforces through it.
 *
 * Cookies carry the session (HttpOnly, SameSite=Strict), so every request uses
 * `credentials: 'include'`. Mutations additionally send the HMAC CSRF token that the gateway
 * exposes via /api/v1/auth/session. No credential is ever kept in localStorage.
 */

const CONFIG_KEY = 'swarmos.gateway';
const CSRF_HEADER = 'x-swarmos-csrf';

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
  csrfToken = null;
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
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), timeoutMs);
  const finalSignal = signal || controller?.signal;

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
    clearTimeout(timer);
    const aborted = err?.name === 'AbortError';
    throw new ApiError(
      aborted ? `Gateway did not answer within ${timeoutMs} ms` : 'Gateway unreachable (network or CORS)',
      { status: 0, code: aborted ? 'timeout' : 'network' }
    );
  }
  clearTimeout(timer);

  const requestId = res.headers.get('x-swarmos-request-id');
  const text = await res.text().catch(() => '');
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text.slice(0, 500) };
    }
  }

  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('swarmos:unauthenticated', { detail: { path } }));
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
    if (out.body?.csrfToken) setCsrfToken(out.body.csrfToken);
    return out.body;
  },
  login: async (email, password) => {
    const out = await request('/api/v1/auth/login', { method: 'POST', body: { email, password } });
    if (out.body?.csrfToken) setCsrfToken(out.body.csrfToken);
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
  tasks: () => request('/api/v1/tasks'),
  createTask: (body) => request('/api/v1/tasks', { method: 'POST', body }),
  updateTask: (id, body) => request(`/api/v1/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  approvals: () => request('/api/v1/approvals'),
  requestApproval: (body) => request('/api/v1/approvals', { method: 'POST', body }),
  decideApproval: (id, decision) =>
    request(`/api/v1/approvals/${encodeURIComponent(id)}/${decision === 'deny' ? 'deny' : 'allow'}`, { method: 'POST' }),
  events: (cursor = 0) => request(`/api/v1/events?cursor=${Number(cursor) || 0}`),
  audit: (limit = 50) => request(`/api/v1/audit?limit=${Number(limit) || 50}`),
  verifyAudit: () => request('/api/v1/audit/verify'),
};

export { request as rawRequest };
