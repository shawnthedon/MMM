/* ============ Sign-in / account surface ============
 * Honest states: demo (no gateway), unreachable gateway, anonymous, authenticated.
 * Local demo mode is always offered explicitly — it is labelled as unenforced, never disguised.
 */
import { esc, icon } from './core.js';
import { getAuth, login, logout, refreshSession, can, configureGateway, changePassword } from './auth.js';
import { gatewayUrl, gatewayLabel, isApiMode, mode } from './api.js';
import { toast, openSheet, confirmModal } from './shell.js';

/* Survives re-renders so an error is still visible after the view repaints. */
const form = { email: '', error: '', busy: false };

function shell(title, subtitle, body, foot = '') {
  return `
    <div class="page-head">
      <h1>${esc(title)}</h1>
      <div class="sub">${esc(subtitle)}</div>
    </div>
    ${body}
    ${foot}`;
}

function gatewayCard(auth) {
  const reachable = auth.gateway.reachable;
  return `
    <div class="card">
      <div class="row between">
        <div class="row">
          <div class="avatar" style="background:var(--elevated);color:var(--brand)">${icon('shield', 18)}</div>
          <div>
            <div class="strong small">Gateway</div>
            <div class="tiny muted">${esc(isApiMode() ? gatewayLabel() : 'not configured — local demo data')}</div>
          </div>
        </div>
        <span class="chip tiny ${reachable === true ? 'ok' : reachable === false ? 'bad' : 'warn'}">
          ${reachable === true ? 'reachable' : reachable === false ? 'unreachable' : 'unknown'}
        </span>
      </div>
      <div class="kv" style="margin-top:8px"><span class="k">Mode</span><span class="strong">${esc(mode())}</span></div>
      <div class="kv"><span class="k">Enforcement</span><span class="strong">${isApiMode() ? 'server-side (RBAC)' : 'none — demo store only'}</span></div>
      ${auth.error ? `<div class="tiny" style="color:var(--danger);margin-top:8px">${esc(auth.error)}</div>` : ''}
      <div class="row" style="gap:8px;margin-top:10px">
        <button class="btn sm grow" data-act="auth-gateway">${icon('gear', 14)} Configure gateway</button>
        <button class="btn sm grow" data-act="auth-refresh">${icon('undo', 14)} Re-check</button>
      </div>
    </div>`;
}

function loginCard(auth) {
  return `
    <div class="card">
      <div class="strong small" style="margin-bottom:10px">Sign in</div>
      <form id="login-form" autocomplete="on">
        <div class="field">
          <label for="login-email">Email</label>
          <input class="input" id="login-email" name="email" type="email" autocomplete="username" required
                 inputmode="email" placeholder="you@example.com" value="${esc(form.email)}" />
        </div>
        <div class="field" style="margin-top:10px">
          <label for="login-password">Password</label>
          <input class="input" id="login-password" name="password" type="password" autocomplete="current-password" required
                 minlength="8" placeholder="••••••••••••" />
        </div>
        <div id="login-error" class="tiny" role="alert" style="color:var(--danger);min-height:16px;margin-top:8px">${esc(form.error)}</div>
        <button class="btn primary block" type="submit" id="login-submit" style="margin-top:4px" ${form.busy ? 'disabled' : ''}>${form.busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <p class="tiny muted" style="margin-top:10px">
        Sessions are an HttpOnly, SameSite=Strict cookie. Passwords are stored as scrypt hashes and
        never leave the gateway. Repeated failures lock the account for a short window.
      </p>
    </div>`;
}

function demoCard() {
  return `
    <div class="card">
      <div class="row between">
        <div class="strong small">Continue without a gateway</div>
        <span class="chip tiny warn">unenforced</span>
      </div>
      <p class="tiny muted" style="margin-top:6px">
        The app runs on seeded demo data in this browser. Agents and swarms are simulated, and
        Copilot actions are not verified or enforced by any server. Nothing you do here is audited.
      </p>
      <button class="btn sm block" data-act="auth-demo" style="margin-top:8px">Use demo data</button>
    </div>`;
}

export const loginView = {
  render() {
    const auth = getAuth();
    const signedIn = auth.status === 'authenticated';
    const body = `
      ${gatewayCard(auth)}
      ${
        signedIn
          ? accountCard(auth)
          : isApiMode()
            ? loginCard(auth)
            : `<div class="card"><div class="strong small">Run the gateway to sign in</div>
                 <p class="tiny muted" style="margin-top:6px">Start it with <span class="code">npm run dev:gateway</span>, then set the URL below.
                 Until then the app stays in demo mode.</p>
                 <button class="btn sm block" data-act="auth-gateway" style="margin-top:8px">${icon('link', 14)} Connect a gateway</button></div>`
      }
      ${signedIn ? '' : demoCard()}
    `;
    return shell(
      signedIn ? 'Account' : 'Sign in',
      signedIn ? 'Your session, role and what it allows' : 'Identity & access · Layer 1 of governance',
      body
    );
  },
  persistent: true,
  mount() {
    const el = document.getElementById('login-form');
    if (!el) return;
    el.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('login-email').value.trim();
      const password = document.getElementById('login-password').value;
      form.email = email;
      form.error = '';
      form.busy = true;
      const btn = document.getElementById('login-submit');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Signing in…';
      }
      const out = await login({ email, password });
      form.busy = false;
      if (!out.ok) {
        form.error = out.error;
        const errorEl = document.getElementById('login-error');
        if (errorEl) errorEl.textContent = out.error;
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Sign in';
        }
        // Re-render only if the message could not be written into a live node.
        if (!errorEl) {
          const { rerender } = await import('./main.js');
          rerender();
        }
        return;
      }
      form.error = '';
      toast(`Signed in as ${out.auth.principal?.name || email}`, 'ok');
      const { navigate } = await import('./main.js');
      navigate('home');
    });
  },
};

function accountCard(auth) {
  const p = auth.principal || {};
  return `
    <div class="card">
      <div class="row between">
        <div class="row">
          <div class="avatar" style="background:var(--accent-hover);color:var(--text-on-accent)">${esc((p.name || '?').slice(0, 2).toUpperCase())}</div>
          <div>
            <div class="strong small">${esc(p.name || 'Unknown')}</div>
            <div class="tiny muted">${esc(p.email || p.id)} · ${esc(p.type || 'user')}</div>
          </div>
        </div>
        <span class="chip tiny brand">${esc(p.role)}</span>
      </div>
      ${auth.mustChangePassword ? `<div class="banner warn" style="margin-top:10px">Your password is the bootstrap password — change it now.</div>` : ''}
      <div class="section-title" style="margin:12px 2px 6px">Permissions (${auth.permissions.length})</div>
      <div class="row wrap" style="gap:6px">
        ${auth.permissions.map((perm) => `<span class="chip tiny">${esc(perm)}</span>`).join('') || '<span class="tiny muted">none</span>'}
      </div>
      <div class="tiny muted" style="margin-top:8px">
        These are the permissions the gateway reported for this session. The server re-checks every request,
        so hiding a button here is convenience, not security.
      </div>
      <div class="row" style="gap:8px;margin-top:12px">
        <button class="btn sm grow" data-act="auth-password">Change password</button>
        <button class="btn sm grow danger" data-act="auth-logout">Sign out</button>
      </div>
    </div>`;
}

/* ---------- actions ---------- */
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;
  if (!act.startsWith('auth-')) return;
  e.preventDefault();

  if (act === 'auth-gateway') {
    openSheet({
      title: 'Gateway connection',
      body: `
        <div class="field">
          <label for="gw-url">Gateway URL</label>
          <input class="input" id="gw-url" placeholder="http://localhost:8787" value="${esc(gatewayUrl())}" inputmode="url" />
          <div class="tiny muted" style="margin-top:6px">
            Leave empty to stay in demo mode. An HTTPS-hosted app cannot call a plain-HTTP gateway
            (mixed-content blocking), so use HTTPS for any non-local deployment.
          </div>
        </div>
        <button class="btn sm block" id="gw-same-origin" style="margin-top:10px">
          ${icon('link', 14)} Use this origin (dev proxy)
        </button>
        <div class="tiny muted" style="margin-top:6px">
          Uses <span class="code">/api</span> and <span class="code">/healthz</span> on the app’s own origin.
          <span class="code">npm run dev</span> proxies them to a gateway on :8787, which keeps the session
          cookie same-origin.
        </div>
        <div class="row" style="gap:8px;margin-top:12px">
          <button class="btn grow" id="gw-cancel">Cancel</button>
          <button class="btn grow primary" id="gw-save">Save &amp; check</button>
        </div>`,
    });
    const sheet = document.querySelector('.sheet');
    sheet?.querySelector('#gw-cancel')?.addEventListener('click', () => document.querySelector('.scrim')?.click());
    sheet?.querySelector('#gw-same-origin')?.addEventListener('click', async () => {
      document.querySelector('.scrim')?.click();
      const auth = await configureGateway('/');
      toast(auth.status === 'anonymous' ? 'Same-origin gateway — sign in' : `Gateway ${auth.status}`, 'ok');
      const { rerender } = await import('./main.js');
      rerender();
    });
    sheet?.querySelector('#gw-save')?.addEventListener('click', async () => {
      const url = sheet.querySelector('#gw-url').value.trim();
      document.querySelector('.scrim')?.click();
      const auth = await configureGateway(url);
      toast(
        url ? `Gateway ${auth.status === 'authenticated' ? 'connected' : auth.status}` : 'Demo mode',
        auth.status === 'unreachable' ? 'bad' : 'ok'
      );
      const { rerender } = await import('./main.js');
      rerender();
    });
    return;
  }

  if (act === 'auth-refresh') {
    await refreshSession();
    toast('Session re-checked', 'ok');
    const { rerender } = await import('./main.js');
    rerender();
    return;
  }

  if (act === 'auth-demo') {
    await configureGateway('');
    toast('Demo mode — not enforced', 'warn');
    const { navigate } = await import('./main.js');
    navigate('home');
    return;
  }

  if (act === 'auth-logout') {
    confirmModal({
      title: 'Sign out?',
      body: 'The app will clear local session data and attempt to revoke your gateway session. Unsaved Copilot drafts stay in this browser.',
      confirmText: 'Sign out',
      onConfirm: async () => {
        const result = await logout();
        toast(result.logoutConfirmed ? 'Signed out' : 'Local session cleared, but gateway logout could not be confirmed. The server session may still be active.', result.logoutConfirmed ? 'ok' : 'bad');
        const { navigate } = await import('./main.js');
        navigate('login');
      },
    });
    return;
  }

  if (act === 'auth-password') {
    openSheet({
      title: 'Change password',
      body: `
        <div class="field"><label for="pw-current">Current password</label>
          <input class="input" id="pw-current" type="password" autocomplete="current-password" /></div>
        <div class="field" style="margin-top:10px"><label for="pw-new">New password</label>
          <input class="input" id="pw-new" type="password" autocomplete="new-password" minlength="12" />
          <div class="tiny muted" style="margin-top:6px">At least 12 characters with a letter and a number. Other sessions are revoked.</div></div>
        <div id="pw-error" class="tiny" style="color:var(--danger);min-height:16px;margin-top:8px"></div>
        <button class="btn primary block" id="pw-save">Update password</button>`,
    });
    const sheet = document.querySelector('.sheet');
    sheet?.querySelector('#pw-save')?.addEventListener('click', async () => {
      const current = sheet.querySelector('#pw-current').value;
      const next = sheet.querySelector('#pw-new').value;
      const out = await changePassword(current, next);
      if (!out.ok) {
        sheet.querySelector('#pw-error').textContent = out.error;
        return;
      }
      document.querySelector('.scrim')?.click();
      toast('Password updated', 'ok');
    });
  }
});

/** Small badge for the top bar: role when signed in, "demo" otherwise. */
export function identityChipHTML() {
  const auth = getAuth();
  if (auth.status === 'authenticated') {
    return `<span class="chip tiny ok" title="Signed in as ${esc(auth.principal?.name)}">${esc(auth.principal?.role)}</span>`;
  }
  if (!isApiMode()) return `<span class="chip tiny warn" title="No gateway configured — demo data, nothing enforced">demo</span>`;
  if (auth.status === 'unreachable') return `<span class="chip tiny bad" title="${esc(auth.error || 'gateway unreachable')}">offline</span>`;
  return `<span class="chip tiny warn" title="Not signed in">signed out</span>`;
}
