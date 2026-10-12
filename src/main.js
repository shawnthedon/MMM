/* ============ SwarmOS boot: router, simulation, PWA ============ */
import './styles.css';
import { getState, setState, subscribe, logEvent, now, uid, fmtMoney, commit, esc, pendingApprovals } from './core.js';
import { renderShell, refreshChrome, applyTheme, toast, closeAllSheets } from './shell.js';
import { views } from './views1.js';
import './views2.js';
import './terminal.js';
import './copilot.js';

let currentRoute = 'home';
let currentParams = {};

export function navigate(path) {
  const [route, id] = String(path).split('/');
  const target = views[route] ? route : 'home';
  const hash = `#/${target}${id ? '/' + id : ''}`;
  if (location.hash !== hash) location.hash = hash;
  parseHash();
  rerender();
  closeAllSheets();
}

export function rerender() {
  const viewEl = document.getElementById('view');
  if (!viewEl) return;
  const v = views[currentRoute] || views.home;
  viewEl.innerHTML = v.render(currentParams);
  v.mount && v.mount(currentParams);
  refreshChrome(currentRoute);
  if (!v.persistent) viewEl.scrollTop = 0;
  window.scrollTo(0, 0);
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

/* re-render on state change — never clobber focused inputs, terminal, or live drags */
subscribe((state, label) => {
  const v = views[currentRoute];
  if (v?.persistent && label?.startsWith('term')) return; // terminal updates imperatively
  if (window.__dragging) return; // kanban drag in progress
  if (label === 'sim') {
    if (v?.persistent) return;
    const ae = document.activeElement;
    if (ae && ['INPUT', 'TEXTAREA', 'SELECT'].includes(ae.tagName)) return;
  }
  rerender();
});

/* ---------- live simulation ticker ---------- */
function tick() {
  const s = getState();
  if (!s.settings.simulate) return;
  setState((st) => {
    // advance live swarms
    st.swarms.filter((w) => w.status === 'live').forEach((w) => {
      w.progress = Math.min(0.97, w.progress + 0.004 + Math.random() * 0.012);
      w.budget.spent = Math.round((w.budget.spent + 0.01 + Math.random() * 0.05) * 100) / 100;
      const active = w.nodes.find((n) => n.status === 'running');
      if (active) {
        active.spent = Math.round((active.spent + 0.01 + Math.random() * 0.03) * 100) / 100;
        if (Math.random() < 0.06) {
          active.status = 'done';
          const next = w.nodes.find((n) => n.status === 'queued');
          if (next) next.status = 'running';
          logEvent('swarm', `${w.name}: node ${active.label} completed`);
        }
      }
    });
    // usage drift
    if (st.usage.length > 24) st.usage.shift();
    st.usage.push({ ts: now(), cost: 0.4 + Math.random() * 2.4, tokens: Math.floor(8000 + Math.random() * 30000) });
    // occasional event
    if (Math.random() < 0.12) {
      const evs = [
        ['mcp', `firecrawl.scrape called · ${(0.4 + Math.random() * 2).toFixed(1)}s · ok`],
        ['mcp', `github.pr.create called by Coder-07 · gated · ok`],
        ['agent', `Researcher-01 checkpoint saved`],
        ['trust', `SRE-Bot trust +1 → 96 (clean approval streak)`],
        ['model', `fallback invoked · claude-sonnet-4 → deepseek-v3`],
      ];
      const [type, text] = evs[Math.floor(Math.random() * evs.length)];
      logEvent(type, text);
    }
  }, 'sim');
}

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
  renderShell(root);
  applyTheme();
  parseHash();
  rerender();
  registerSW();
  setInterval(tick, 4200);

  // offline banner
  const updateNet = () => {
    const view = document.getElementById('view');
    if (!navigator.onLine) {
      if (!document.getElementById('offline-banner')) {
        const b = document.createElement('div');
        b.id = 'offline-banner';
        b.className = 'banner warn';
        b.style.cssText = 'margin:10px 14px 0;position:sticky;top:calc(env(safe-area-inset-top,0px) + 52px);z-index:30';
        b.innerHTML = `${esc('⚠')} <div>Offline — cached data shown. Queued actions will sync on reconnect.</div>`;
        document.querySelector('.app').insertBefore(b, document.getElementById('view'));
      }
    } else {
      document.getElementById('offline-banner')?.remove();
    }
  };
  window.addEventListener('online', updateNet);
  window.addEventListener('offline', updateNet);
  updateNet();

  // dock hint rotation
  const hints = [
    '✦ Ask Copilot — it can drive the whole app',
    '✦ Try “deploy swarm research”',
    '✦ Try “create agent Nova”',
    '✦ Try “approve ap-1”',
  ];
  let hi = 0;
  setInterval(() => {
    hi = (hi + 1) % hints.length;
    const el = document.getElementById('dock-text');
    if (el) el.textContent = hints[hi];
  }, 6000);
}

boot();
