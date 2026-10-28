/* ============ Authentication state for the PWA ============
 * The gateway is the authority: this module only caches what /auth/session returned so the UI can
 * hide or explain actions. Permission checks here are UX hints; the server re-checks every call.
 */
import { api, ApiError, isApiMode, gatewayUrl, setGatewayUrl, mode, invalidateApiSession, setCsrfToken, getCsrfToken } from './api.js';

const state = {
  status: 'unknown', // unknown | checking | anonymous | authenticated | unreachable | demo
  principal: null,
  permissions: [],
  csrf: null,
  mustChangePassword: false,
  error: null,
  checkedAt: null,
  gateway: { reachable: null, mode: mode(), url: gatewayUrl() },
};

const listeners = new Set();
let authVersion = 0;
let authTurn = 0;
let resumeBlocked = false;
const identity = (s) => s.status === 'authenticated'
  ? JSON.stringify([s.gateway.url, s.principal?.id, [...s.permissions].sort()]) : '';
export const getAuthVersion = () => authVersion;

export function getAuth() {
  return { ...state, principal: state.principal ? { ...state.principal } : null, permissions: [...state.permissions] };
}

export function subscribeAuth(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(patch) {
  const before = identity(state);
  Object.assign(state, patch);
  if (identity(state) !== before) authVersion += 1;
  state.checkedAt = Date.now();
  const snapshot = getAuth();
  listeners.forEach((fn) => {
    try {
      fn(snapshot);
    } catch {
      /* a broken listener must not break auth */
    }
  });
}

export const isAuthenticated = () => state.status === 'authenticated';
export const principal = () => state.principal;
export const role = () => state.principal?.role || null;
export const usesApi = () => isApiMode();

/** Permission check used by UI affordances. Never a security boundary. */
export function can(permission) {
  if (!isAuthenticated()) return false;
  if (state.permissions.includes(permission)) return true;
  return false;
}

/** True when the action must be blocked in the UI because the server would refuse it. */
export function explainDenied(permission) {
  if (!isApiMode()) return null;
  if (state.status === 'unreachable') return 'Gateway unreachable — actions cannot be verified right now.';
  if (!isAuthenticated()) return 'Sign in to perform this action.';
  return `Your role (${state.principal?.role}) lacks the “${permission}” permission.`;
}

/** Probe the gateway and restore the session (cookie-based, so nothing is stored client-side). */
export async function refreshSession({ silent = false } = {}) {
  const turn = ++authTurn;
  if (silent && resumeBlocked) return getAuth();
  if (!isApiMode()) {
    emit({ status: 'demo', principal: null, permissions: [], error: null, gateway: { reachable: true, mode: 'demo', url: '' } });
    return getAuth();
  }
  if (!silent) emit({ status: 'checking', error: null });
  try {
    const session = await api.session();
    if (turn !== authTurn) return getAuth();
    const nextIdentity = identity({ status: 'authenticated', principal: session.principal, permissions: session.permissions || [], gateway: { url: gatewayUrl() } });
    if (identity(state) !== nextIdentity) invalidateApiSession();
    setCsrfToken(session.csrfToken);
    emit({
      status: 'authenticated',
      principal: session.principal,
      permissions: session.permissions || [],
      mustChangePassword: Boolean(session.principal?.must_change_password),
      error: null,
      gateway: { reachable: true, mode: 'api', url: gatewayUrl() },
    });
  } catch (err) {
    if (turn !== authTurn) return getAuth();
    invalidateApiSession();
    if (err instanceof ApiError && err.unauthenticated) {
      emit({ status: 'anonymous', principal: null, permissions: [], error: null, gateway: { reachable: true, mode: 'api', url: gatewayUrl() } });
    } else if (err instanceof ApiError && err.forbidden) {
      emit({ status: 'anonymous', principal: null, permissions: [], error: err.message, gateway: { reachable: true, mode: 'api', url: gatewayUrl() } });
    } else {
      emit({ status: 'unreachable', principal: null, permissions: [], error: err.message, gateway: { reachable: false, mode: 'api', url: gatewayUrl() } });
    }
  }
  return getAuth();
}

export async function login({ email, password }) {
  const turn = ++authTurn;
  resumeBlocked = false;
  invalidateApiSession();
  emit({ status: 'checking', error: null });
  try {
    const out = await api.login(email, password);
    if (turn !== authTurn) return { ok: false, error: 'Session changed during sign-in.' };
    setCsrfToken(out.csrfToken);
    emit({
      status: 'authenticated',
      principal: out.principal,
      permissions: out.permissions || [],
      mustChangePassword: Boolean(out.mustChangePassword),
      error: null,
      gateway: { reachable: true, mode: 'api', url: gatewayUrl() },
    });
    return { ok: true, auth: getAuth() };
  } catch (err) {
    if (turn !== authTurn) return { ok: false, error: 'Session changed during sign-in.' };
    invalidateApiSession();
    const message =
      err instanceof ApiError && err.offline
        ? 'Gateway unreachable — check the URL and that the gateway is running.'
        : err.message || 'Sign-in failed';
    emit({ status: err instanceof ApiError && err.offline ? 'unreachable' : 'anonymous', error: message, principal: null, permissions: [] });
    return { ok: false, error: message, status: err?.status || 0 };
  }
}

export async function logout() {
  ++authTurn;
  resumeBlocked = true;
  const token = getCsrfToken();
  // Abort earlier requests before starting logout, which needs the old CSRF token.
  invalidateApiSession();
  setCsrfToken(token);
  const pending = isApiMode() ? api.logout().then(() => true, () => false) : Promise.resolve(true);
  setCsrfToken(null);
  emit({ status: isApiMode() ? 'anonymous' : 'demo', principal: null, permissions: [], error: null, mustChangePassword: false });
  const logoutConfirmed = await pending;
  return { ...getAuth(), logoutConfirmed };
}

export async function changePassword(currentPassword, newPassword) {
  try {
    await api.changePassword(currentPassword, newPassword);
    emit({ mustChangePassword: false });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || 'Could not change the password' };
  }
}

/** Point the app at a gateway (or back to demo mode with an empty string). */
export async function configureGateway(url) {
  ++authTurn;
  resumeBlocked = false;
  setGatewayUrl(url);
  emit({ status: 'unknown', error: null, gateway: { reachable: null, mode: mode(), url: gatewayUrl() } });
  return refreshSession();
}

/** Session cookie changes are visible to other tabs; re-check when the tab regains focus. */
if (typeof window !== 'undefined') {
  window.addEventListener('swarmos:unauthenticated', () => {
    if (!isAuthenticated()) return;
    ++authTurn;
    invalidateApiSession();
    emit({ status: 'anonymous', principal: null, permissions: [], csrf: null, mustChangePassword: false, error: null });
  });
  window.addEventListener('focus', () => {
    if (isApiMode() && ['authenticated', 'anonymous'].includes(state.status)) refreshSession({ silent: true });
  });
}
