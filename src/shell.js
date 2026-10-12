/* ============ SwarmOS shell: chrome, sheets, toasts, actions ============ */
import { getState, setState, commit, esc, icon, pendingApprovals, logEvent, uid, now } from './core.js';

export const routes = [
  { id: 'home', label: 'Home', icon: 'home', title: 'Command Deck' },
  { id: 'agents', label: 'Agents', icon: 'robot', title: 'Agent Manager' },
  { id: 'teams', label: 'Swarms', icon: 'swarm', title: 'Teams & Swarms' },
  { id: 'tasks', label: 'Tasks', icon: 'board', title: 'Kanban Board' },
  { id: 'chat', label: 'Chat', icon: 'chat', title: 'Chat' },
  { id: 'skills', label: 'Skills', icon: 'skill', title: 'Skills Hub' },
  { id: 'models', label: 'Models', icon: 'model', title: 'Model Gateway' },
  { id: 'plugins', label: 'Plugins', icon: 'plug', title: 'Plugin Marketplace' },
  { id: 'telegram', label: 'Telegram', icon: 'send', title: 'Telegram Bridge' },
  { id: 'analytics', label: 'Analytics', icon: 'chart', title: 'Analytics' },
  { id: 'artifacts', label: 'Files', icon: 'folder', title: 'Artifacts & Files' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal', title: 'Terminal' },
  { id: 'settings', label: 'Settings', icon: 'gear', title: 'Settings' },
];

const TABS = ['home', 'agents', 'tasks', 'chat', '__more'];

export const actions = {};
export function on(name, fn) { actions[name] = fn; }

document.addEventListener('click', (e) => {
  if (window.__suppressClick) return; // just finished a drag
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;
  if (actions[act]) {
    e.preventDefault();
    actions[act](t, t.dataset, e);
  }
});

document.addEventListener('input', (e) => {
  const t = e.target.closest('input[type=range][data-act]');
  if (t && actions[t.dataset.act]) actions[t.dataset.act](t, t.dataset, e);
});

document.addEventListener('change', (e) => {
  const t = e.target.closest('[data-model]');
  if (!t) return;
  const path = t.dataset.model;
  const val = t.type === 'checkbox' ? t.checked : t.value;
  setState((s) => {
    const parts = path.split('.');
    let o = s;
    for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
    o[parts[parts.length - 1]] = val;
  }, `set:${path}`);
  if (path === 'settings.theme') applyTheme();
});

export function applyTheme() {
  const s = getState().settings;
  document.documentElement.setAttribute('data-theme', s.theme);
  document.documentElement.setAttribute('data-density', s.density);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', s.theme === 'dark' ? '#0B0F17' : '#F7F9FC');
}

/* ---------- toasts ---------- */
export function toast(msg, kind = '') {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="grow">${msg}</span>`;
  root.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 3200);
}

/* ---------- sheets ---------- */
let sheetStack = [];
export function openSheet({ title, body, foot = '', wide = false, onClose = null }) {
  const root = document.getElementById('sheet-root');
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.innerHTML = `
    <div class="grab"></div>
    <div class="sheet-head">
      <h3 class="grow">${title}</h3>
      <button class="iconbtn" data-sheet-close aria-label="Close">${icon('x', 20)}</button>
    </div>
    <div class="sheet-body">${body}</div>
    ${foot ? `<div class="sheet-foot">${foot}</div>` : ''}`;
  root.appendChild(scrim);
  root.appendChild(sheet);
  requestAnimationFrame(() => { scrim.classList.add('open'); sheet.classList.add('open'); });
  const close = () => {
    scrim.classList.remove('open');
    sheet.classList.remove('open');
    setTimeout(() => { scrim.remove(); sheet.remove(); }, 260);
    sheetStack = sheetStack.filter((s) => s.sheet !== sheet);
    onClose && onClose();
  };
  sheetStack.push({ sheet, scrim, close });
  scrim.addEventListener('click', close);
  sheet.querySelector('[data-sheet-close]').addEventListener('click', close);
  return { el: sheet, close };
}
export function closeAllSheets() { sheetStack.slice().forEach((s) => s.close()); }

/* ---------- modal confirm ---------- */
export function confirmModal({ title, body, confirmText = 'Confirm', danger = false, onConfirm, requireText = '' }) {
  const root = document.getElementById('sheet-root');
  const scrim = document.createElement('div');
  scrim.className = 'scrim open';
  const wrap = document.createElement('div');
  wrap.className = 'modal-center open';
  wrap.innerHTML = `
    <div class="box">
      <h3>${title}</h3>
      <div class="muted small" style="margin:10px 0 14px">${body}</div>
      ${requireText ? `<div class="field"><label>Type <span class="code">${esc(requireText)}</span> to confirm</label><input class="input" id="confirm-text" placeholder="${esc(requireText)}" autocomplete="off"></div>` : ''}
      <div class="row" style="gap:10px">
        <button class="btn grow" id="confirm-cancel">Cancel</button>
        <button class="btn grow ${danger ? 'danger' : 'primary'}" id="confirm-ok">${esc(confirmText)}</button>
      </div>
    </div>`;
  root.appendChild(scrim);
  root.appendChild(wrap);
  const close = () => { scrim.remove(); wrap.remove(); };
  scrim.addEventListener('click', close);
  wrap.querySelector('#confirm-cancel').addEventListener('click', close);
  wrap.querySelector('#confirm-ok').addEventListener('click', () => {
    if (requireText && wrap.querySelector('#confirm-text').value.trim() !== requireText) {
      toast(`Type “${esc(requireText)}” exactly to confirm`, 'bad');
      return;
    }
    close();
    onConfirm && onConfirm();
  });
}

/* ---------- FAB radial + quick create ---------- */
function quickCreateSheet() {
  openSheet({
    title: 'Quick create',
    body: `
      <div class="col" style="gap:8px">
        ${[
          ['robot', 'New agent', 'Agent profile wizard', 'new-agent'],
          ['swarm', 'Deploy swarm', 'From team template', 'new-swarm'],
          ['board', 'New task', 'Add to Kanban', 'new-task'],
          ['chat', 'New chat', 'Message an agent', 'new-chat'],
          ['skill', 'New skill', 'OpenClaw skill editor', 'new-skill'],
        ].map(([ic, t, d, act]) => `
          <button class="list-card" data-act="${act}" style="width:100%;text-align:left">
            <div class="avatar" style="background:var(--elevated);color:var(--brand)">${icon(ic, 20)}</div>
            <div class="grow"><div class="strong small">${t}</div><div class="tiny muted">${d}</div></div>
            ${icon('right', 16)}
          </button>`).join('')}
      </div>`,
  });
}

/* ---------- More grid ---------- */
function moreSheet(navigate) {
  const items = routes.filter((r) => !TABS.includes(r.id));
  openSheet({
    title: 'All modules',
    body: `<div class="grid-3" style="gap:10px">
      ${items.map((r) => `
        <button class="card col" data-act="nav" data-to="${r.id}" style="align-items:center;gap:8px;padding:16px 8px">
          <div class="avatar" style="background:var(--elevated);color:var(--brand);width:42px;height:42px">${icon(r.icon, 20)}</div>
          <div class="tiny strong">${r.label}</div>
        </button>`).join('')}
    </div>`,
  });
}

/* ---------- notifications ---------- */
function notificationsSheet(navigate) {
  const s = getState();
  const pend = pendingApprovals();
  openSheet({
    title: 'Notifications',
    body: `
      ${pend.length ? `<div class="section-title" style="margin-top:0">Approvals (${pend.length})</div>
      ${pend.map((a) => `
        <div class="card">
          <div class="row between">
            <div class="row">
              <div class="avatar sm" style="background:var(--warning);color:#0b0f17">${icon('shield', 14)}</div>
              <div><div class="strong small">${esc(a.action)}</div><div class="tiny muted">${esc(a.target)} · ${esc(a.principal)}</div></div>
            </div>
            <span class="chip tiny warn">${esc(a.risk)}</span>
          </div>
          <div class="tiny muted" style="margin:8px 0">${esc(a.evidence)}</div>
          <div class="row" style="gap:8px">
            <button class="btn sm grow" data-act="approve" data-id="${a.id}" data-decide="deny">Deny</button>
            <button class="btn sm grow ok" data-act="approve" data-id="${a.id}" data-decide="allow">Allow once</button>
          </div>
        </div>`).join('')}` : ''}
      <div class="section-title">Activity</div>
      ${s.events.slice(0, 10).map((ev) => `
        <div class="row" style="padding:8px 2px;gap:10px">
          <span class="pulse-dot ${ev.type === 'approval' ? 'warn' : ev.type === 'swarm' ? 'run' : 'idle'}"></span>
          <div class="grow"><div class="small">${esc(ev.text)}</div><div class="tiny muted">${new Date(ev.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div></div>
        </div>`).join('')}`,
    foot: `<button class="btn block" data-act="nav" data-to="analytics">Open analytics</button>`,
  });
}

/* ---------- shell render ---------- */
export function renderShell(root) {
  root.innerHTML = `
    <div class="app">
      <header class="topbar">
        <div class="ws">
          <div class="ws-logo">⬡</div>
          <span id="ws-name">${esc(getState().settings.workspaceName)}</span>
          <span class="ws-dot" id="gw-dot"></span>
        </div>
        <div class="title" id="page-title"></div>
        <button class="iconbtn" data-act="notifications" aria-label="Notifications">
          ${icon('bell', 21)}<span class="badge" id="notif-badge">0</span>
        </button>
        <button class="iconbtn" data-act="nav" data-to="settings" aria-label="Settings">${icon('gear', 21)}</button>
      </header>
      <main class="view" id="view"></main>
      <button class="fab" data-act="quick-create" aria-label="Create">${icon('plus', 26)}</button>
      <div class="dock" data-act="copilot-open" role="button" aria-label="Open Copilot">
        <div class="spark">${icon('spark', 16)}</div>
        <div class="dock-text" id="dock-text">✦ Ask Copilot — it can drive the whole app</div>
        <button class="dock-go" data-act="copilot-open">Ask</button>
      </div>
      <nav class="tabbar" id="tabbar">
        ${TABS.map((t) => {
          if (t === '__more') return `
            <button data-act="more"><span class="tab-ico">${icon('grid', 20)}</span>More</button>`;
          const r = routes.find((x) => x.id === t);
          return `<button data-act="nav" data-to="${r.id}" data-tab="${r.id}"><span class="tab-ico">${icon(r.icon, 20)}</span>${r.label}</button>`;
        }).join('')}
      </nav>
    </div>
    <div id="sheet-root"></div>
    <div id="toast-root"></div>`;

  on('nav', (el, ds) => {
    import('./main.js').then((m) => m.navigate(ds.to));
  });
  on('more', () => moreSheet());
  on('quick-create', () => quickCreateSheet());
  on('notifications', () => notificationsSheet());
  on('copilot-open', () => import('./copilot.js').then((m) => m.openCopilot()));
  on('noop', () => {});

  on('approve', (el, ds) => {
    setState((s) => {
      const a = s.approvals.find((x) => x.id === ds.id);
      if (a) {
        a.status = ds.decide === 'allow' ? 'allowed' : 'denied';
        logEvent('approval', `${a.action} ${a.status} by you · ${a.target}`);
      }
    }, 'approve');
    closeAllSheets();
    toast(ds.decide === 'allow' ? '✓ Approved — action released' : 'Denied — principal notified', ds.decide === 'allow' ? 'ok' : '');
    import('./main.js').then((m) => m.rerender());
  });
}

export function refreshChrome(routeId) {
  const s = getState();
  const r = routes.find((x) => x.id === routeId) || routes[0];
  const titleEl = document.getElementById('page-title');
  if (titleEl) titleEl.textContent = r.title;
  const badge = document.getElementById('notif-badge');
  const n = pendingApprovals().length;
  if (badge) {
    badge.textContent = n;
    badge.style.display = n ? 'grid' : 'none';
  }
  const dot = document.getElementById('gw-dot');
  if (dot) dot.className = `ws-dot ${s.gateway.status === 'healthy' ? '' : 'warn'}`;
  document.querySelectorAll('#tabbar button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === routeId || (routeId === 'teams' && b.dataset.tab === 'home' && false));
    if (b.dataset.tab === routeId) b.classList.add('active');
    else b.classList.remove('active');
  });
  // map non-tab routes to nearest tab highlight
  const tabFor = { home: 'home', agents: 'agents', tasks: 'tasks', chat: 'chat' };
  const active = tabFor[routeId];
  if (active) {
    document.querySelectorAll('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === active));
  }
}
