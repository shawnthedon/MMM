/* ============ Copilot runtime truth: what is actually connected ============
 * The panel must never imply a live runtime it does not have. This module probes the gateway
 * health endpoint (1.5 s abort), records the result and exposes it for the header/context strip.
 */
let state = {
  gateway: { status: 'unknown', url: defaultUrl(), checkedAt: null, detail: 'not probed yet' },
  store: { mode: 'demo', detail: 'browser localStorage (seeded demo data)' },
  online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
};

const listeners = new Set();

function defaultUrl() {
  try {
    const env = import.meta?.env;
    return env?.VITE_GATEWAY_URL || 'http://localhost:8787';
  } catch {
    return 'http://localhost:8787';
  }
}

export function getRuntime() {
  return { ...state, gateway: { ...state.gateway }, store: { ...state.store } };
}

export function subscribeRuntime(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  listeners.forEach((fn) => {
    try {
      fn(getRuntime());
    } catch {
      /* a broken listener must not break the probe */
    }
  });
}

export function setOnline(online) {
  state = { ...state, online: Boolean(online) };
  emit();
}

/** Real fetch with a hard timeout. No canned success: failures are reported as failures. */
export async function probeGateway({ timeoutMs = 1500 } = {}) {
  const url = state.gateway.url;
  state = { ...state, gateway: { ...state.gateway, status: 'checking', detail: 'probing /healthz' } };
  emit();

  if (typeof fetch !== 'function') {
    state = { ...state, gateway: { status: 'unknown', url, checkedAt: Date.now(), detail: 'fetch unavailable in this environment' } };
    emit();
    return getRuntime().gateway;
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/healthz`, {
      method: 'GET',
      signal: controller?.signal,
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    clearTimeout(timer);
    if (!res.ok) {
      state = { ...state, gateway: { status: 'unreachable', url, checkedAt: Date.now(), detail: `HTTP ${res.status}` } };
    } else {
      const body = await res.json().catch(() => ({}));
      state = {
        ...state,
        gateway: {
          status: 'reachable',
          url,
          checkedAt: Date.now(),
          detail: body?.ok ? `ok · sqlite ${body.db || 'unknown'}` : 'responded without ok flag',
        },
      };
    }
  } catch (err) {
    clearTimeout(timer);
    const aborted = err?.name === 'AbortError';
    state = {
      ...state,
      gateway: {
        status: 'unreachable',
        url,
        checkedAt: Date.now(),
        detail: aborted ? `no response in ${timeoutMs} ms` : 'network/CORS error',
      },
    };
  }
  emit();
  return getRuntime().gateway;
}

export const runtimeLabel = (rt = getRuntime()) => {
  const gw =
    rt.gateway.status === 'reachable'
      ? 'gateway reachable'
      : rt.gateway.status === 'checking'
        ? 'checking gateway'
        : rt.gateway.status === 'unreachable'
          ? 'gateway unreachable'
          : 'gateway unprobed';
  return `Demo data · ${gw}${rt.online ? '' : ' · offline'}`;
};
