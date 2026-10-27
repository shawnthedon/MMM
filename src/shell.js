/* ============ SwarmOS shell: chrome, sheets, toasts, actions ============ */
import { getState, setState, commit, esc, icon, pendingApprovals, logEvent, uid, now } from './core.js';
import { identityChipHTML } from './authview.js';
import { getAuth } from './auth.js';
import { sourceChipHTML, sourceNoteHTML, openSourceSheet, refreshNow } from './sourceui.js';
import { getStatus, isLive } from './datastore.js';
import { api, ApiError, isApiMode } from './api.js';

export const routes = [
  { id: 'home', label: 'Home', icon: 'home', title: 'Command Deck' },
  { id: 'designer', label: 'Agent Designer', icon: 'spark', title: 'Agent Designer' },
  { id: 'agents', label: 'Agents', icon: 'robot', title: 'Agent Manager' },
  { id: 'teams', label: 'Swarms', icon: 'swarm', title: 'Teams & Swarms' },
  { id: 'tasks', label: 'Tasks', icon: 'board', title: 'Kanban Board' },
  { id: 'chat', label: 'Chat', icon: 'chat', title: 'Chat' },
  { id: 'skills', label: 'Skills', icon: 'skill', title: 'Skills Hub' },
  { id: 'models', label: 'Models', icon: 'model', title: 'Model Gateway' },
  { id: 'plugins', label: 'Plugins', icon: 'plug', title: 'Plugin Marketplace' },
  { id: 'comms', label: 'Comms', icon: 'broadcast', title: 'Comms' },
  // Kept as routes for titles/highlighting, but not shown in the All-modules grid (see HIDDEN).
  { id: 'matrix', label: 'Skills Matrix', icon: 'graph', title: 'Skills Matrix' },
  { id: 'analytics', label: 'Analytics', icon: 'chart', title: 'Analytics' },
  { id: 'artifacts', label: 'Files', icon: 'folder', title: 'Artifacts & Files' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal', title: 'Terminal' },
  { id: 'settings', label: 'Settings', icon: 'gear', title: 'Settings' },
  { id: 'login', label: 'Account', icon: 'shield', title: 'Account & Access' },
];

/* Bottom navigation: four module slots with the Copilot launcher in the centre slot.
 * Chat lives in the header (next to notifications) so Tasks keeps a bottom-bar slot. */
const TABS = ['home', 'agents', 'tasks'];

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
          ['spark', 'Design an agent', 'Guided builder → validated definition', 'open-designer'],
          ['robot', 'Quick new agent', 'Short profile wizard', 'new-agent'],
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
  // Chat has its own header button and the Skills Matrix is opened from the Skills Hub, so neither
  // belongs in the module list; Comms replaces the old standalone Telegram entry.
  const HIDDEN = [...TABS, 'chat', 'matrix'];
  const items = routes.filter((r) => !HIDDEN.includes(r.id));
  openSheet({
    title: 'All modules',
    body: `<div class="row" style="gap:8px;margin-bottom:12px">
      <button class="btn grow" data-act="quick-create">${icon('plus', 16)} Quick create</button>
      <button class="btn grow primary" data-act="open-designer">${icon('spark', 16)} Agent Designer</button>
    </div>
    <div class="grid-3" style="gap:10px">
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

/* ---------- bottom navigation with the central Copilot launcher ---------- */
function tabbarHTML() {
  const [a, b, c] = TABS;
  const tab = (id) => {
    const r = routes.find((x) => x.id === id);
    return `<button data-act="nav" data-to="${r.id}" data-tab="${r.id}"><span class="tab-ico">${icon(r.icon, 20)}</span>${r.label}</button>`;
  };
  return `
    ${tab(a)}
    ${tab(b)}
    <button class="cp-fab-slot" data-act="copilot-open" aria-label="Open Copilot" aria-haspopup="dialog" aria-expanded="false" aria-controls="copilot-panel">
      <span class="cp-fab-ico" aria-hidden="true">${icon('spark', 22)}</span>
      <span class="cp-fab-text">Copilot</span>
    </button>
    ${tab(c)}
    <button data-act="more"><span class="tab-ico">${icon('grid', 20)}</span>More</button>`;
}

/* ---------- shell render ---------- */
export function renderShell(root) {
  root.innerHTML = `
    <div class="app">
      <header class="topbar">
        <div class="ws" role="group" aria-label="${esc(getState().settings.workspaceName)} workspace">
          <div class="ws-logo" aria-hidden="true">⬡</div>
          <span class="ws-dot" id="gw-dot"></span>
          <button class="srcc" id="source-chip" data-act="source-info" aria-label="Data source"></button>
        </div>
        <div class="title" id="page-title"></div>
        <button class="identity-btn" id="identity-chip" data-act="nav" data-to="login" aria-label="Account and access"></button>
        <button class="iconbtn" id="chat-btn" data-act="nav" data-to="chat" aria-label="Chat" title="Chat" aria-current="false">${icon('chat', 21)}</button>
        <button class="iconbtn" data-act="notifications" aria-label="Notifications">
          ${icon('bell', 21)}<span class="badge" id="notif-badge">0</span>
        </button>
        <button class="iconbtn" data-act="nav" data-to="settings" aria-label="Settings">${icon('gear', 21)}</button>
      </header>
      <div id="source-note-root"></div>
      <main class="view" id="view"></main>
      <nav class="tabbar" id="tabbar" aria-label="Primary">
        ${tabbarHTML()}
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

  on('source-info', () => openSourceSheet());
  on('data-refresh', () => refreshNow());

  on('approve', async (el, ds) => {
    const decide = ds.decide === 'allow' ? 'allow' : 'deny';
    // Gateway-backed approvals are decided by the server; the local copy is replaced by the
    // authoritative row afterwards so there is never a decision that only exists in the browser.
    if (isLive('approvals')) {
      el?.setAttribute('disabled', 'disabled');
      const perm = getAuth();
      if (!isApiMode() || !perm.permissions.includes('approval:decide')) {
        toast(`Your role (${perm.principal?.role || 'signed out'}) cannot decide approvals`, 'bad');
        return;
      }
      try {
        const out = await api.decideApproval(ds.id, decide);
        closeAllSheets();
        toast(`${out.body.action} ${out.body.status} on the gateway · audit entry written`, out.body.status === 'allowed' ? 'ok' : '');
      } catch (err) {
        const denied = err instanceof ApiError && err.forbidden;
        toast(denied ? `Gateway refused: ${err.message}` : `Could not decide: ${err.message}`, 'bad');
      }
      const { refresh } = await import('./datastore.js');
      await refresh({ silent: true });
      import('./main.js').then((m) => m.rerender());
      return;
    }
    setState((s) => {
      const a = s.approvals.find((x) => x.id === ds.id);
      if (a) {
        a.status = decide === 'allow' ? 'allowed' : 'denied';
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
  const st = getStatus();
  const dot = document.getElementById('gw-dot');
  if (dot) {
    const healthy = isApiMode() ? st.status === 'live' : s.gateway.status === 'healthy';
    dot.className = `ws-dot ${healthy ? '' : 'warn'}`;
    dot.title = isApiMode() ? `gateway: ${st.status}${st.error ? ' — ' + st.error : ''}` : 'demo mode — no gateway configured';
  }
  const srcChip = document.getElementById('source-chip');
  if (srcChip) srcChip.innerHTML = sourceChipHTML();
  const noteRoot = document.getElementById('source-note-root');
  if (noteRoot) {
    const html = sourceNoteHTML();
    const had = noteRoot.querySelector('.source-note');
    if (had || html) noteRoot.innerHTML = html;
  }
  // identity comes from the gateway session, not from demo state
  const chip = document.getElementById('identity-chip');
  if (chip) {
    chip.innerHTML = identityChipHTML();
    const auth = getAuth();
    chip.setAttribute(
      'aria-label',
      auth.status === 'authenticated'
        ? `Account: ${auth.principal?.name}, role ${auth.principal?.role}`
        : 'Account and access — not signed in to a gateway'
    );
  }
  // map the current route onto the nearest tab (the centre slot is the Copilot launcher; Chat is a
  // header action rather than a tab, so it is highlighted on its own button instead)
  const tabFor = { home: 'home', agents: 'agents', tasks: 'tasks' };
  const active = tabFor[routeId] || null;
  document.querySelectorAll('#tabbar [data-tab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === active);
  });
  const chatBtn = document.getElementById('chat-btn');
  if (chatBtn) {
    const onChat = routeId === 'chat';
    chatBtn.classList.toggle('active', onChat);
    chatBtn.setAttribute('aria-current', onChat ? 'page' : 'false');
  }
}
