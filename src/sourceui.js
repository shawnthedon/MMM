/* ============ Data-source indicators ============
 * Every screen must be able to say where its rows came from. This module renders the compact
 * top-bar chip and the explanatory sheet, driven entirely by datastore provenance.
 */
import { esc, icon } from './core.js';
import { isApiMode } from './api.js';
import { getAuth, isAuthenticated } from './auth.js';
import { getStatus, refresh, sourceExplanation, GATEWAY_SLICES, LOCAL_SLICES } from './datastore.js';
import { openSheet, toast } from './shell.js';

const SLICE_LABEL = {
  agents: 'Agents',
  tasks: 'Tasks',
  approvals: 'Approvals',
  events: 'Event feed',
  swarms: 'Swarms',
  teams: 'Teams',
  usage: 'Usage & spend',
};

export function sourceChipHTML() {
  const st = getStatus();
  if (!isApiMode()) {
    return `<span class="chip tiny warn" title="No gateway configured — seeded demo data">demo</span>`;
  }
  if (st.status === 'live') {
    return `<span class="chip tiny ok" title="Loaded from ${esc(st.url)}">${st.ws === 'open' ? 'live' : 'synced'}</span>`;
  }
  if (st.status === 'loading') return `<span class="chip tiny" title="Loading from the gateway">syncing…</span>`;
  if (st.liveSlices.length) {
    // Rows on screen are still the gateway's, just not fresh. Say "stale", never "demo".
    return `<span class="chip tiny warn" title="${esc(st.error || 'last refresh failed')}">stale gateway</span>`;
  }
  if (st.status === 'degraded' || st.status === 'error') {
    return `<span class="chip tiny bad" title="${esc(st.error || 'gateway unavailable')}">demo · offline</span>`;
  }
  return `<span class="chip tiny" title="Not signed in">demo</span>`;
}

/** Strip shown under the top bar when the app is signed in but not showing server data. */
export function sourceNoteHTML() {
  const st = getStatus();
  if (!isApiMode()) return '';
  if (st.status === 'live' || st.status === 'loading') return '';
  const auth = getAuth();
  if (!isAuthenticated()) return '';
  const message = st.liveSlices.length
    ? `${st.error || 'Refresh failed'} — showing the last gateway rows (fetched ${st.at ? new Date(st.at).toLocaleTimeString() : 'earlier'}), which are now stale.`
    : st.status === 'error' || st.status === 'degraded'
      ? `${st.error || 'Gateway unavailable'} — showing seeded demo data, not the gateway's.`
      : 'Gateway data has not loaded yet — showing seeded demo data.';
  return `
    <div class="source-note" id="source-note">
      ${icon('shield', 14)}
      <span class="grow">${esc(message)}</span>
      <button class="btn sm" data-act="data-refresh">Retry</button>
    </div>`;
}

/** Inline chip for a single module screen: says exactly where those rows came from. */
export function sourceTagHTML(slice) {
  const info = sourceExplanation(slice);
  const live = info.source === 'gateway';
  return `<span class="chip tiny ${live && info.label === 'live gateway' ? 'ok' : 'warn'}" title="${esc(info.detail)}">${esc(info.label)}</span>`;
}

/**
 * Strip above a module's rows when they are *not* the gateway's. Returns '' when the screen is
 * showing real server data, so a live screen never carries demo disclaimers.
 */
export function sourceBannerHTML(slice) {
  const info = sourceExplanation(slice);
  if (info.source === 'gateway') return '';
  const st = getStatus();
  const retry = isApiMode() && isAuthenticated() && ['degraded', 'error'].includes(st.status);
  return `
    <div class="source-note" style="margin-bottom:10px">
      ${icon('shield', 14)}
      <span class="grow">${esc(info.detail)}</span>
      ${retry ? `<button class="btn sm" data-act="data-refresh">Retry</button>` : isApiMode() && !isAuthenticated() ? `<button class="btn sm" data-act="nav" data-to="login">Sign in</button>` : ''}
    </div>`;
}

function sliceRow(slice) {
  const info = sourceExplanation(slice);
  const isGateway = info.source === 'gateway';
  return `
    <div class="kv">
      <span class="k">${esc(SLICE_LABEL[slice] || slice)}</span>
      <span class="row" style="gap:6px">
        <span class="chip tiny ${isGateway ? 'ok' : 'warn'}">${esc(info.label)}</span>
      </span>
    </div>`;
}

export function openSourceSheet() {
  const st = getStatus();
  const auth = getAuth();
  const wsLabel = { off: 'not connected', connecting: 'connecting…', open: 'open', reconnecting: 'reconnecting', refused: 'refused' }[st.ws] || st.ws;
  openSheet({
    title: 'Where this data comes from',
    body: `
      <div class="card">
        <div class="row between">
          <div class="row">
            <div class="avatar" style="background:var(--elevated);color:var(--brand)">${icon('plug', 18)}</div>
            <div>
              <div class="strong small">${esc(isApiMode() ? st.url : 'No gateway configured')}</div>
              <div class="tiny muted">${esc(
                isAuthenticated()
                  ? `${auth.principal.name} · ${auth.principal.role}`
                  : isApiMode()
                    ? 'not signed in'
                    : 'demo mode — nothing is enforced'
              )}</div>
            </div>
          </div>
          <span class="chip tiny ${st.status === 'live' ? 'ok' : st.status === 'loading' ? '' : 'warn'}">${esc(st.status)}</span>
        </div>
        <div class="kv" style="margin-top:8px"><span class="k">Live stream</span><span class="strong">${esc(wsLabel)}</span></div>
        <div class="kv"><span class="k">Last sync</span><span class="strong">${st.at ? new Date(st.at).toLocaleTimeString() : 'never'}</span></div>
        <div class="kv"><span class="k">Last live update</span><span class="strong">${st.lastEventAt ? new Date(st.lastEventAt).toLocaleTimeString() : '—'}</span></div>
        ${st.error ? `<div class="tiny" style="color:var(--danger);margin-top:8px">${esc(st.error)}</div>` : ''}
      </div>

      <div class="section-title">Gateway-backed</div>
      <div class="card">${GATEWAY_SLICES.map(sliceRow).join('')}</div>

      <div class="section-title">Local only (no server store yet)</div>
      <div class="card">${LOCAL_SLICES.map(sliceRow).join('')}</div>

      <p class="tiny muted" style="margin-top:10px">
        Gateway rows are never written to this browser's storage, and demo rows are never merged with
        them: if a refresh fails, the screen falls back to demo data and says so.
      </p>`,
    foot: `
      <button class="btn grow" data-act="data-refresh">${icon('undo', 15)} Refresh now</button>
      <button class="btn grow" data-act="nav" data-to="login">Account</button>`,
  });
}

/** Registered by the shell: refresh action shared by the note and the sheet. */
export async function refreshNow() {
  if (!isApiMode()) {
    toast('No gateway configured — using demo data', 'warn');
    return;
  }
  const out = await refresh();
  toast(out.ok ? 'Synced from the gateway' : out.error || 'Refresh failed — demo data kept', out.ok ? 'ok' : 'bad');
  const { rerender } = await import('./main.js');
  rerender();
}
