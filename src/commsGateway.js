/* ============ Comms over the gateway ============
 * When a gateway is connected and the signed-in principal can read comms, the gateway owns the
 * channels: credentials are stored there encrypted, the browser receives masked values only, and
 * delivery/queueing happens server-side where the secrets are.
 *
 * The demo path in `comms.js` (credentials in the browser store) stays available when no gateway is
 * configured — the panel always states which of the two it is using.
 */
import { api, ApiError, isApiMode } from './api.js';
import { isAuthenticated, can, getAuthVersion } from './auth.js';
import { getState, setState, setProvenance, isLive } from './core.js';
import { CHANNELS, CHANNEL_IDS, defaultComms, maskSecret } from './commsChannels.js';

export const canReadGatewayComms = () => isApiMode() && isAuthenticated() && can('comms:read');
export const canWriteGatewayComms = () => isApiMode() && isAuthenticated() && can('comms:write');
export const commsIsGateway = () => isLive('comms');
let generation = 0;
let demoSnapshot = null;
const clone = (value) => JSON.parse(JSON.stringify(value));
export const demoCommsForPersistence = () => demoSnapshot ? clone(demoSnapshot) : defaultComms();

export const gatewayCommsState = () => getState().commsGateway || { status: 'unknown', note: '', settings: null, stats: null, keySource: null, error: null, at: null };

function writeGatewayState(patch) {
  setState((s) => { s.commsGateway = { ...(s.commsGateway || {}), ...patch }; }, 'comms-gateway');
}

/**
 * Adopt the gateway's channel records. Configuration arrives masked (`••••last4`), so a secret is
 * never written into localStorage even indirectly, and statuses are the server's, not ours.
 */
export async function refreshComms({ silent = false } = {}) {
  if (!canReadGatewayComms()) {
    releaseComms();
    return { ok: false, error: 'No gateway session with comms:read.' };
  }
  const version = getAuthVersion();
  const current = ++generation;
  if (!silent) writeGatewayState({ status: 'loading', error: null });
  try {
    const out = await api.comms();
    if (current !== generation || version !== getAuthVersion() || !canReadGatewayComms()) return { ok: false, error: 'Session changed.' };
    if (!demoSnapshot) demoSnapshot = clone(getState().comms || defaultComms());
    const body = out.body || {};
    setProvenance({ comms: 'gateway' });
    setState((s) => {
      const base = defaultComms();
      const channels = { ...base.channels };
      for (const ch of body.channels || []) {
        const prev = channels[ch.id] || { routing: { copilot: true, agents: [] } };
        channels[ch.id] = {
          ...prev,
          enabled: Boolean(ch.enabled),
          config: ch.config || {},
          verifiedAt: ch.verifiedAt || null,
          lastTest: ch.lastTest || null,
          routing: ch.routing || prev.routing,
          status: ch.status,
          missing: ch.missing || [],
          missingInbound: ch.missingInbound || [],
        };
      }
      s.comms = {
        ...base,
        channels,
        commands: { ...base.commands, ...(body.settings?.commands || {}) },
        quietHours: body.settings?.quietHours || '',
        rateLimitPerMin: body.settings?.rateLimitPerMin ?? base.rateLimitPerMin,
      };
      s.commsGateway = {
        status: 'live',
        note: body.note || '',
        requestedBy: body.requestedBy || '',
        settings: body.settings || null,
        stats: body.stats || null,
        recent: body.recent || [],
        encryption: body.encryption || null,
        keySource: body.encryption?.keySource || null,
        error: null,
        at: Date.now(),
      };
    }, 'comms:adopt');
    return { ok: true, channels: body.channels?.length || 0 };
  } catch (err) {
    if (current !== generation || version !== getAuthVersion() || !canReadGatewayComms()) return { ok: false, error: 'Session changed.' };
    releaseComms();
    const denied = err instanceof ApiError && err.forbidden;
    const message = denied
      ? `Your role cannot read comms on this gateway (comms:read).`
      : `Could not load comms from the gateway: ${err.message}`;
    writeGatewayState({ status: denied ? 'denied' : 'error', error: message });
    return { ok: false, error: message, forbidden: denied };
  }
}

/** Drop gateway-owned comms state so a stale status can never masquerade as live. */
export function releaseComms() {
  generation += 1;
  const wasGateway = isLive('comms');
  const snapshot = demoSnapshot;
  demoSnapshot = null;
  setProvenance({ comms: 'demo' });
  if (!wasGateway && !snapshot && !getState().commsGateway) return;
  setState((s) => {
    s.commsGateway = { status: 'demo', note: 'No gateway session.', settings: null, stats: null, recent: [], encryption: null, error: null, at: Date.now() };
    if (snapshot) s.comms = snapshot;
    else if (wasGateway) s.comms = defaultComms();
  }, 'comms:release');
}

const sessionChanged = () => ({ ok: false, error: 'Session changed; the operation may have reached the gateway. Check its status before retrying.' });

const fail = (err, permission) => {
  if (err instanceof ApiError && err.forbidden) return { ok: false, error: `Gateway refused: your role lacks ${permission}.` };
  return { ok: false, error: `Gateway refused: ${err.message}` };
};

/** Save configuration server-side. Returns only after the gateway accepted it. */
export async function saveChannelOnGateway(id, configPatch, extra = {}) {
  if (!canWriteGatewayComms()) return { ok: false, error: 'Your role cannot change comms on this gateway (comms:write).' };
  const version = getAuthVersion();
  try {
    await api.saveCommsChannel(id, { config: configPatch, ...extra });
    await refreshComms({ silent: true });
    if (version !== getAuthVersion()) return sessionChanged();
    return { ok: true, mode: 'gateway' };
  } catch (err) {
    return fail(err, 'comms:write');
  }
}

export async function clearChannelOnGateway(id) {
  if (!canWriteGatewayComms()) return { ok: false, error: 'Your role cannot change comms on this gateway (comms:write).' };
  const version = getAuthVersion();
  try {
    await api.deleteCommsChannel(id);
    await refreshComms({ silent: true });
    if (version !== getAuthVersion()) return sessionChanged();
    return { ok: true, mode: 'gateway' };
  } catch (err) {
    return fail(err, 'comms:write');
  }
}

/** Ask the gateway to deliver now. The result is the provider's answer, relayed verbatim. */
export async function sendOnGateway(id, text, dedupeKey = null) {
  if (!canWriteGatewayComms()) return { ok: false, error: 'Your role cannot send from this gateway (comms:write).' };
  const version = getAuthVersion();
  try {
    const out = await api.sendComms(id, { text, dedupeKey });
    const body = out.body || {};
    await refreshComms({ silent: true });
    if (version !== getAuthVersion()) return sessionChanged();
    return { ok: true, mode: 'gateway', delivered: Boolean(body.ok), queued: Boolean(body.queued), detail: body.detail, status: body.status, error: body.error };
  } catch (err) {
    // A 502/409/503 from the send route is a real delivery result, not a transport failure.
    const body = err instanceof ApiError ? err.body : null;
    if (body && typeof body === 'object' && 'ok' in body) {
      await refreshComms({ silent: true });
      if (version !== getAuthVersion()) return sessionChanged();
      return { ok: true, mode: 'gateway', delivered: Boolean(body.ok), queued: Boolean(body.queued), detail: body.detail, status: body.status, error: body.error, reason: body.reason };
    }
    return fail(err, 'comms:write');
  }
}

export async function runQueueOnGateway() {
  if (!canWriteGatewayComms()) return { ok: false, error: 'Your role cannot run the queue (comms:write).' };
  const version = getAuthVersion();
  try {
    const out = await api.runCommsQueue();
    await refreshComms({ silent: true });
    if (version !== getAuthVersion()) return sessionChanged();
    return { ok: true, ...(out.body || {}) };
  } catch (err) {
    return fail(err, 'comms:write');
  }
}

export async function saveSettingsOnGateway(patch) {
  if (!canWriteGatewayComms()) return { ok: false, error: 'Your role cannot change comms settings (comms:write).' };
  const version = getAuthVersion();
  try {
    await api.saveCommsSettings(patch);
    await refreshComms({ silent: true });
    if (version !== getAuthVersion()) return sessionChanged();
    return { ok: true };
  } catch (err) {
    return fail(err, 'comms:write');
  }
}

/** One line the panel can print so the storage location is never ambiguous. */
export function commsSourceLabel() {
  const gw = getState().commsGateway || {};
  if (isLive('comms')) {
    const key = gw.encryption?.keySource === 'env' ? 'SWARMOS_SECRET' : gw.keySource === 'file' ? 'a local key file' : 'the server key';
    return {
      kind: 'gateway',
      text: `Credentials are stored encrypted on the gateway (AES-256-GCM, key from ${key}) and never returned to this browser. Delivery and retries run server-side.`,
    };
  }
  if (gw.status === 'denied') return { kind: 'denied', text: gw.error || 'This role cannot read comms on the gateway.' };
  if (isApiMode()) return { kind: 'denied', text: 'Gateway session unavailable or not authorised. Sign in with comms permissions to change or send.' };
  return { kind: 'demo', text: 'Demo mode: no gateway is configured, so credentials stay in this browser and no provider call leaves the device until you test a channel.' };
}

export const CHANNEL_COUNT = CHANNEL_IDS.length;
export { CHANNELS, maskSecret };
