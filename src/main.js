/* ============ MMM boot: router, simulation, PWA ============ */
import './styles.css';
import './kanban.css';
import { getState, setState, subscribe, logEvent, now, uid, fmtMoney, commit, esc, pendingApprovals } from './core.js';
import { renderShell, refreshChrome, applyTheme, enhanceSwitches, toast, closeAllSheets } from './shell.js';
import { views } from './views1.js';
import './views2.js';
import { loginView } from './authview.js';
import { getAuth, getAuthVersion, refreshSession, subscribeAuth } from './auth.js';
import { isApiMode } from './api.js';
import { initDataSync, isLive as sliceIsLive } from './datastore.js';

views.login = loginView;
import './terminal.js';
import './files.js';
import './copilot.js';
import './designer.js';
import './skillsMatrix.js';
import './skillsImportView.js';
import './comms.js';
import './browser.js';
import './evolution.js';
import './local.js';
import './voice.js';
import { refreshComms, releaseComms, canReadGatewayComms } from './commsGateway.js';
import { pageIn, initMotion } from './motion.js';
import { enhanceSwipeCards } from './gestures.js';
import { routes } from './shell.js';

let currentRoute = 'home';
let currentParams = {};
let previousRoute = 'home';
/** Identity of the view currently in the DOM, so a re-render can tell navigation from an update. */
let renderedKey = null;

/* ---------- scroll continuity ----------
 * State changes (gateway syncs, toasts that update data) re-render the
 * whole view. Rendering must never move the reader: a re-render keeps the page and every inner
 * scroller where they were, and only a real navigation returns to the top. */
const SCROLL_IDLE_MS = 450;
const MAX_RENDER_DEFERRAL_MS = 2500;
let lastScrollAt = 0;
let deferTimer = null;
let deferStartedAt = 0;

/** Inner scrollers worth preserving by name, in addition to the window and #view. */
const SCROLLERS = [
  { selector: '#kb-viewport', property: 'scrollLeft' },
  { selector: '.kanban-cards', property: 'scrollTop', keyAttr: 'data-drop' },
  { selector: '.sheet-body', property: 'scrollTop' },
];

export function routeKey(route = currentRoute, params = currentParams) {
  return params && params.id ? `${route}/${params.id}` : route;
}

function captureScroll(viewEl) {
  const containers = [];
  for (const { selector, property, keyAttr } of SCROLLERS) {
    document.querySelectorAll(selector).forEach((el, index) => {
      const offset = el[property] || 0;
      if (!offset) return;
      containers.push({ property, value: offset, selector, keyAttr, key: keyAttr ? el.getAttribute(keyAttr) : null, index });
    });
  }
  return { page: window.scrollY || 0, view: viewEl.scrollTop || 0, containers };
}

function restoreScroll(saved, viewEl) {
  for (const item of saved.containers) {
    const candidates = [...document.querySelectorAll(item.selector)];
    const el = item.keyAttr ? candidates.find((node) => node.getAttribute(item.keyAttr) === item.key) : candidates[item.index];
    if (el) el[item.property] = item.value;
  }
  if (viewEl.scrollTop !== saved.view) viewEl.scrollTop = saved.view;
  if ((window.scrollY || 0) !== saved.page) window.scrollTo(0, saved.page);
}

function isScrolling() {
  return lastScrollAt > 0 && Date.now() - lastScrollAt < SCROLL_IDLE_MS;
}

/** Coalesce a render until the reader stops scrolling, with a bounded wait so data never starves. */
function renderWhenIdle() {
  const startedAt = Date.now();
  if (!deferStartedAt) deferStartedAt = startedAt;
  if (startedAt - deferStartedAt >= MAX_RENDER_DEFERRAL_MS) {
    deferStartedAt = 0;
    if (deferTimer) clearTimeout(deferTimer);
    deferTimer = null;
    rerender();
    return;
  }
  if (deferTimer) return;
  deferTimer = setTimeout(() => {
    deferTimer = null;
    if (isScrolling()) { renderWhenIdle(); return; }
    deferStartedAt = 0;
    rerender();
  }, SCROLL_IDLE_MS);
}

function noteScroll() {
  lastScrollAt = Date.now();
}

window.addEventListener('scroll', noteScroll, { passive: true });
document.addEventListener('scroll', noteScroll, { passive: true, capture: true });

export function navigate(path) {
  const [route, id] = String(path).split('/');
  const target = views[route] ? route : 'home';
  const hash = `#/${target}${id ? '/' + id : ''}`;
  if (location.hash !== hash) location.hash = hash;
  parseHash();
  rerender({ resetScroll: true });
  closeAllSheets();
}

/**
 * Re-render the current view.
 * `resetScroll` is for navigation only; every other re-render preserves the reader's position.
 */
export function rerender({ resetScroll = false } = {}) {
  const viewEl = document.getElementById('view');
  if (!viewEl) return;
  const v = views[currentRoute] || views.home;
  const key = routeKey();
  // A different view is navigation even when something else triggered it (hashchange, deep link).
  const navigating = resetScroll || key !== renderedKey;
  const saved = navigating ? null : captureScroll(viewEl);
  viewEl.innerHTML = v.render(currentParams);
  enhanceSwitches(viewEl);
  v.mount && v.mount(currentParams);
  refreshChrome(currentRoute);
  // Gestures are attached to the freshly rendered cards (already-wired nodes are skipped).
  enhanceSwipeCards(viewEl);
  renderedKey = key;
  if (navigating) {
    viewEl.scrollTop = 0;
    window.scrollTo(0, 0);
    const order = routes.map((r) => r.id);
    const direction = order.indexOf(currentRoute) >= order.indexOf(previousRoute) ? 'forward' : 'back';
    pageIn(viewEl, { direction });
    previousRoute = currentRoute;
  } else if (saved) {
    restoreScroll(saved, viewEl);
  }
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [route, id] = raw.split('/');
  currentRoute = views[route] ? route : 'home';
  currentParams = id ? { id } : {};
}

window.addEventListener('hashchange', () => {
  parseHash();
  rerender();
});

/* re-render on state change — never clobber focused inputs, terminal, live drags, or scroll */
subscribe((state, label) => {
  const v = views[currentRoute];
  if (v?.persistent && label?.startsWith('term')) return; // terminal updates imperatively
  if (window.__dragging) return; // kanban drag in progress
  if (typeof v?.skipRender === 'function' && v.skipRender(label)) return; // view owns its DOM right now
  // Replacing the view mid-gesture kills momentum scrolling on touch devices. Wait for the reader
  // to stop; `renderWhenIdle` flushes after SCROLL_IDLE_MS or MAX_RENDER_DEFERRAL_MS.
  if (isScrolling()) { renderWhenIdle(); return; }
  rerender();
});

/** Avoid re-rendering the login form while the user is typing into it. */
function sessionGatePaused() {
  const active = document.activeElement;
  return currentRoute === 'login' && active && ['INPUT', 'TEXTAREA'].includes(active.tagName);
}

/* ---------- no ticker ----------
 * There used to be a 4.2 s `tick()` here. It advanced live swarms by `Math.random()`, drifted a fake
 * usage curve and invented events — every 4 seconds, on every screen. It was the single largest source
 * of numbers in this app that no row could explain. It is deleted rather than paused: a simulation
 * switch is still a simulation. Swarms render their stored row and are labelled `not executed`.
 */

/* ---------- PWA ---------- */
function registerSW() {
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register(new URL('sw.js', document.baseURI), { type: 'classic' }).catch(() => {});
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.__deferredPrompt = e;
  });
}

/* ---------- boot ---------- */
function boot() {
  const root = document.getElementById('app');
  // Animation engine first: it is code-split, and every screen should have it ready by the time
  // the first tap lands.
  initMotion();
  renderShell(root);
  applyTheme();
  parseHash();
  rerender();
  registerSW();

  // Identity first: the gateway is the authority on who is signed in and what they may do.
  refreshSession()
    .then(() => {
      const auth = getAuth();
      // Then data: adopt the server's rows (or keep demo rows and say so).
      initDataSync();
      // Comms is gateway-owned when a session holds comms:read; otherwise the panel keeps its
      // browser-only credentials and says so.
      if (canReadGatewayComms()) refreshComms({ silent: true }).catch(() => {});
      else releaseComms();
      rerender();
      if (isApiMode() && auth.status === 'anonymous' && currentRoute !== 'login') navigate('login');
      else if (isApiMode() && auth.status === 'unreachable' && currentRoute !== 'login') navigate('login');
    })
    .catch(() => {});

  let commsOwnerVersion = null;
  subscribeAuth((auth) => {
    // Follow the session: adopt server-side channels on sign-in, drop them on sign-out so a stale
    // "verified" badge can never survive.
    if (auth?.status === 'authenticated' && canReadGatewayComms()) {
      const version = getAuthVersion();
      if (commsOwnerVersion !== null && commsOwnerVersion !== version) releaseComms();
      commsOwnerVersion = version;
      refreshComms({ silent: true }).catch(() => {});
    } else {
      commsOwnerVersion = null;
      releaseComms();
    }
    refreshChrome(currentRoute);
    // The sign-in view owns its own form state and repaints itself, so a session poll must not
    // clobber what the user is typing.
    if (currentRoute === 'login' || sessionGatePaused()) return;
    rerender();
  });

  // A 401 from any API call drops straight back to the sign-in screen.
  window.addEventListener('mmm:unauthenticated', () => {
    if (currentRoute !== 'login') navigate('login');
  });

  // offline banner
  const updateNet = () => {
    const view = document.getElementById('view');
    if (!navigator.onLine) {
      if (!document.getElementById('offline-banner')) {
        const b = document.createElement('div');
        b.id = 'offline-banner';
        b.className = 'banner warn';
        b.style.cssText = 'margin:10px 14px 0;position:sticky;top:calc(env(safe-area-inset-top,0px) + 52px);z-index:30';
        b.innerHTML = `${esc('⚠')} <div>Offline — gateway data may be unavailable or stale. Retry actions after reconnecting.</div>`;
        document.querySelector('.app').insertBefore(b, document.getElementById('view'));
      }
    } else {
      document.getElementById('offline-banner')?.remove();
    }
  };
  window.addEventListener('online', updateNet);
  window.addEventListener('offline', updateNet);
  updateNet();

  // hint rotation lived in the removed Copilot dock; suggestions now come from the panel.

}

boot();
