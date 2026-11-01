/* ============ Copilot conversation — the live model path ============
 * One place owns "is the Copilot answering with a model right now", and it asks the gateway rather than
 * guessing. Three states matter and the UI must render them differently:
 *
 *   demo     — no gateway configured. The deterministic engine still answers, and every answer says so.
 *   unready  — a gateway session, but no provider key sealed (or the chosen provider has none). Sends
 *              reach the server and come back refused; nothing is fabricated.
 *   ready    — a real provider. Each turn is a metered model call; the reply carries the call id, the
 *              token counts and an estimated cost, and it is persisted on the gateway.
 *
 * Nothing in this module writes a message the server did not return. That is the whole point: the local
 * transcript is a mirror of rows, not a place where answers are invented.
 */
import { api, isApiMode, ApiError } from '../api.js';
import { isAuthenticated } from '../auth.js';

const state = {
  status: 'idle', // idle | loading | ready | unready | unavailable | error
  conversationId: null,
  runtime: null,
  error: null,
  at: null,
  busy: false,
};

let controller = null;
let inFlight = null;
const listeners = new Set();
let loadedFor = '';

function emit() {
  const snapshot = getState();
  listeners.forEach((fn) => {
    try { fn(snapshot); } catch { /* a broken listener must not break the transcript */ }
  });
}

export function getState() {
  return { ...state, runtime: state.runtime ? { ...state.runtime } : null };
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** A live conversation needs a gateway *and* a session: the transcript is a server row. */
export const available = () => isApiMode() && isAuthenticated();

/** Everything the panel needs to decide what to show. Never throws. */
export async function load({ silent = false } = {}) {
  if (!available()) {
    Object.assign(state, { status: 'demo', conversationId: null, runtime: null, error: null, busy: false });
    emit();
    return { ok: false, reason: 'no-gateway' };
  }
  if (!silent) Object.assign(state, { status: state.runtime ? state.status : 'loading' });
  try {
    const out = await api.copilot();
    const messages = Array.isArray(out.body?.messages) ? out.body.messages : [];
    Object.assign(state, {
      status: out.body?.runtime?.configured ? 'ready' : 'unready',
      conversationId: out.body?.conversation?.id || null,
      runtime: out.body?.runtime || null,
      error: null,
      at: Date.now(),
      busy: false,
    });
    loadedFor = state.conversationId || '';
    emit();
    return { ok: true, messages, runtime: state.runtime };
  } catch (error) {
    // A gateway without the Copilot routes (404) is not a failure of the app — the Copilot just has no
    // server conversation, and says so rather than pretending to be live.
    const missing = error instanceof ApiError && (error.status === 404 || error.status === 0);
    Object.assign(state, {
      status: missing ? 'unavailable' : 'error',
      runtime: null,
      conversationId: null,
      error: error?.message || 'could not load the conversation',
      busy: false,
      at: Date.now(),
    });
    emit();
    return { ok: false, error: state.error };
  }
}

export const conversationKey = () => state.conversationId || loadedFor || '';

/**
 * One turn. Resolves to `{ ok, user, reply, usage, error }` and never invents a reply: on failure the
 * caller gets the server's own reason and the knowledge that nothing was stored for it.
 */
export async function sendTurn({ text, route = '', clientId = '' } = {}) {
  if (!available()) return { ok: false, reason: 'demo', error: 'No gateway is connected, so no model can answer.' };
  if (inFlight) return { ok: false, reason: 'busy', error: 'A reply is already on its way.' };
  const body = String(text || '').trim();
  if (!body) return { ok: false, reason: 'empty', error: 'Type something first.' };

  controller = new AbortController();
  state.busy = true;
  emit();
  inFlight = api
    .copilotSend({ text: body, route, clientId }, { signal: controller.signal })
    .then((out) => {
      const runtime = out.body?.runtime || state.runtime;
      if (runtime) Object.assign(state, { runtime, status: runtime.configured ? 'ready' : 'unready' });
      if (out.body?.conversation?.id) state.conversationId = out.body.conversation.id;
      Object.assign(state, { at: Date.now(), busy: false, error: null });
      emit();
      return { ok: true, user: out.body?.userMessage || null, reply: out.body?.reply || null, usage: out.body?.usage || null, duplicate: Boolean(out.body?.duplicate) };
    })
    .catch((error) => {
      const cancelled = error instanceof ApiError && error.code === 'cancelled';
      const noModel = error instanceof ApiError && error.status === 409;
      Object.assign(state, {
        busy: false,
        error: cancelled ? '' : (error?.message || 'the reply failed'),
        // A 409 means "there is no model to answer with" — that is a runtime state, not a transient error.
        status: error?.body?.runtime ? (error.body.runtime.configured ? 'ready' : 'unready') : state.status,
        runtime: error?.body?.runtime || state.runtime,
        at: Date.now(),
      });
      emit();
      return { ok: false, cancelled, reason: noModel ? 'no-model' : 'error', error: cancelled ? '' : (error?.message || 'the reply failed'), status: error?.status || 0 };
    })
    .finally(() => {
      controller = null;
      inFlight = null;
      state.busy = false;
      emit();
    });
  return inFlight;
}

/** Stop waiting. The request is aborted; nothing already stored on the gateway is removed. */
export function abort() {
  if (!controller) return false;
  try { controller.abort(); } catch { /* already gone */ }
  Object.assign(state, { busy: false });
  emit();
  return true;
}

export const isBusy = () => state.busy;

/** Start over on the server. Returns how many turns were deleted, or an error. */
export async function clearConversation() {
  if (!available()) return { ok: false, cleared: 0, error: 'No gateway is connected.' };
  try {
    const out = await api.copilotClear();
    Object.assign(state, { at: Date.now(), error: null });
    emit();
    return { ok: true, cleared: Number(out.body?.cleared) || 0 };
  } catch (error) {
    return { ok: false, cleared: 0, error: error?.message || 'The conversation was not cleared.' };
  }
}

/** Point the Copilot at a provider. Owner-only server-side; the UI only offers it to those who can. */
export async function chooseModel({ providerId = '', model = '' } = {}) {
  try {
    const out = await api.setCopilotModel({ providerId, model });
    Object.assign(state, {
      runtime: out.body?.runtime || state.runtime,
      status: out.body?.runtime?.configured ? 'ready' : 'unready',
      error: null,
      at: Date.now(),
    });
    emit();
    return { ok: true, runtime: state.runtime };
  } catch (error) {
    return { ok: false, error: error?.message || 'the model was not changed' };
  }
}

/** Turn a server message row into the panel's message shape. */
export function toPanelMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    role: row.role === 'user' ? 'user' : 'copilot',
    text: row.text || '',
    ts: row.ts || Date.now(),
    live: true,
    modelCallId: row.modelCallId ?? null,
    usage: row.payload && typeof row.payload === 'object' ? row.payload : null,
  };
}

export function reset() {
  Object.assign(state, { status: 'idle', conversationId: null, runtime: null, error: null, at: null, busy: false });
  loadedFor = '';
  emit();
}
