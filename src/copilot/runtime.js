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

import { gatewayUrl, api } from '../api.js';
import { getStatus } from '../datastore.js';

/** The gateway the app is actually configured to use (falls back to the dev default). */
function defaultUrl() {
  return gatewayUrl() || '';
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
let probeVersion = 0;
export async function probeGateway({ timeoutMs = 1500 } = {}) {
  const version = ++probeVersion;
  const url = defaultUrl();
  if (!url) {
    state = { ...state, gateway: { status: 'unknown', url: '', checkedAt: Date.now(), detail: 'no gateway configured' } };
    emit();
    return getRuntime().gateway;
  }
  state = { ...state, gateway: { status: 'checking', url, checkedAt: null, detail: 'probing /healthz' } };
  emit();
  try {
    const response = await api.health({ timeoutMs });
    if (version !== probeVersion || url !== defaultUrl()) return getRuntime().gateway;
    const body = response.body || {};
    state = { ...state, gateway: { status: body.ok ? 'reachable' : 'unreachable', url, checkedAt: Date.now(),
      detail: body.ok ? `ok · sqlite ${body.db || 'unknown'} · auth ${body.auth?.mode || 'unknown'}` : 'responded without ok flag' } };
  } catch (err) {
    if (version !== probeVersion || url !== defaultUrl()) return getRuntime().gateway;
    state = { ...state, gateway: { status: 'unreachable', url, checkedAt: Date.now(), detail: err.code === 'timeout' ? `no response in ${timeoutMs} ms` : 'network or gateway error' } };
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
  const sync = getStatus();
  const data = sync.status === 'live' ? 'Gateway data' : sync.liveSlices.length ? 'Stale gateway data' : 'Demo data';
  return `${data} · ${gw}${rt.online ? '' : ' · offline'}`;
};
