/* ============ File management panel ============
 * The screen the Settings button opens. It is a *view of the gateway's disk*, not a picture of one:
 *
 *   • every list, size and usage number comes from `GET /api/v1/files/*`, and nothing is rendered as a
 *     file unless the gateway returned it;
 *   • with no gateway the screen says so and offers no controls, because there is no disk it could reach;
 *   • a download is streamed here, chunk by chunk, so pause stops a real socket and resume asks for the
 *     remaining bytes with `Range:` — the progress bar is bytes that arrived, not a timer;
 *   • delete moves a file to the location's trash and the toast says "moved to trash", not "deleted".
 *
 * Three tabs: Browse (the tree), Downloads (the transfer manager), Storage (the enrolled roots).
 */
import { esc, icon, fmtTime } from './core.js';
import { openSheet, on, closeAllSheets, toast } from './shell.js';
import { views } from './views1.js';
import { api, isApiMode, ApiError, gatewayUrl } from './api.js';
import './files.css';

const CHUNK = 256 * 1024;

const st = {
  tab: 'browse',
  locations: [],
  locationId: '',
  path: '',
  entries: [],
  parent: null,
  loading: false,
  error: '',
  notice: '',
  usage: [],
  downloads: [],
  ready: false,
  busy: '',
  menuFor: null,
  uploads: [],
};

/* ---------- formatting ---------- */

const bytes = (n) => {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
  return `${(v / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const speedText = (bytesPerSecond) => {
  const v = Number(bytesPerSecond) || 0;
  if (v <= 0) return '—';
  return `${bytes(v)}/s`;
};

const etaText = (secs) => {
  if (!Number.isFinite(secs) || secs <= 0) return '—';
  if (secs < 60) return `${Math.ceil(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
  return `${Math.floor(secs / 3600)}h ${Math.round((secs % 3600) / 60)}m`;
};

const kb = (text) => (Number(text) || 0) / 1024;

/* ---------- the transfer engine ----------
 * One record per download on the gateway; the bytes live here. `runs` holds the live controllers so a
 * pause can abort the socket immediately instead of waiting for the next chunk.
 */
const runs = new Map(); // id -> { controller, chunks, bytes, startedAt, lastSample }

function sample(run) {
  const at = performance.now();
  const dt = (at - run.lastSample.at) / 1000;
  if (dt < 0.25) return run.speed;
  const delta = run.bytes - run.lastSample.bytes;
  const instant = delta / dt;
  run.speed = run.speed ? run.speed * 0.6 + instant * 0.4 : instant;
  run.lastSample = { at, bytes: run.bytes };
  return run.speed;
}

function paintRow(id) {
  const run = runs.get(id);
  const row = document.querySelector(`[data-dl="${CSS.escape(id)}"]`);
  const record = st.downloads.find((d) => d.id === id);
  if (!row || !record) return;
  const done = run ? run.bytes : record.bytesDone;
  const total = record.bytesTotal || 0;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const fill = row.querySelector('[data-dl-fill]');
  if (fill) fill.style.width = `${pct}%`;
  const meta = row.querySelector('[data-dl-meta]');
  if (meta) {
    const speed = run && record.status === 'running' ? sample(run) : 0;
    const remaining = total ? (total - done) / (speed || 1) : 0;
    const parts = [`${bytes(done)} of ${total ? bytes(total) : 'unknown'}`, `${pct}%`];
    if (record.status === 'running') parts.push(speedText(speed), `ETA ${etaText(remaining)}`);
    if (record.status === 'paused') parts.push('paused — resume continues from the bytes already received');
    if (record.status === 'failed' && record.error) parts.push(record.error);
    meta.textContent = parts.join(' · ');
  }
  row.dataset.status = record.status;
}

async function patchDownload(id, body) {
  const out = await api.updateDownload(id, body);
  const idx = st.downloads.findIndex((d) => d.id === id);
  if (idx >= 0) st.downloads[idx] = out.body.download;
  paintRow(id);
  return out.body.download;
}

async function runDownload(id) {
  const record = st.downloads.find((d) => d.id === id);
  if (!record) return;
  const run = runs.get(id) || { controller: null, chunks: [], bytes: 0, speed: 0, lastSample: { at: performance.now(), bytes: 0 } };
  runs.set(id, run);
  const controller = new AbortController();
  run.controller = controller;
  const startAt = record.bytesDone || 0;
  run.bytes = startAt;
  run.chunks = run.chunks.slice(0, 0);
  run.lastSample = { at: performance.now(), bytes: startAt };
  st.downloads[st.downloads.findIndex((d) => d.id === id)].status = 'running';
  paintRow(id);
  try {
    await patchDownload(id, { status: 'running', bytesDone: startAt });
    const url = `${gatewayUrl() === '/' ? '' : gatewayUrl()}/api/v1/files/download?location=${encodeURIComponent(record.locationId)}&path=${encodeURIComponent(record.path)}`;
    const res = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
      headers: startAt > 0 ? { Range: `bytes=${startAt}-` } : {},
    });
    if (res.status === 401 || res.status === 403) throw new Error(`the gateway refused the download (${res.status})`);
    if (res.status === 416) throw new Error('the file changed on the server, so the resume point is no longer valid');
    if (!res.ok && res.status !== 206) throw new Error(`the gateway answered ${res.status}`);
    const reader = res.body.getReader();
    let lastSave = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      run.chunks.push(value);
      run.bytes += value.length;
      paintRow(id);
      if (performance.now() - lastSave > 900) {
        lastSave = performance.now();
        // Progress is saved, not decorated: if the tab dies here, the record says where to resume.
        patchDownload(id, { status: 'running', bytesDone: run.bytes }).catch(() => {});
      }
    }
    const finished = await patchDownload(id, { status: 'completed', bytesDone: run.bytes });
    runs.delete(id);
    paintRow(finished.id);
    st.notice = `${record.filename} downloaded — ${bytes(finished.bytesDone)}. Press Save to write it to this device.`;
    refreshDownloads();
    import('./main.js').then((m) => m.rerender()).catch(() => {});
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    if (aborted) {
      // Pause is the only thing that aborts; it records the byte count so a resume is a Range request.
      await patchDownload(id, { status: 'paused', bytesDone: run.bytes }).catch(() => {});
      runs.delete(id);
      paintRow(id);
      return;
    }
    await patchDownload(id, { status: 'failed', bytesDone: run.bytes, error: String(error?.message || error).slice(0, 200) }).catch(() => {});
    runs.delete(id);
    paintRow(id);
  }
}

export function pauseDownload(id) {
  const run = runs.get(id);
  if (run?.controller) run.controller.abort();
}

export async function resumeDownload(id) {
  await runDownload(id);
}

export async function cancelDownload(id) {
  const run = runs.get(id);
  if (run?.controller) run.controller.abort();
  runs.delete(id);
  await patchDownload(id, { status: 'cancelled' });
}

export async function retryDownload(id) {
  await patchDownload(id, { status: 'queued', bytesDone: 0, error: '', attempt: true });
  await runDownload(id);
}

export async function forgetDownload(id) {
  await api.deleteDownload(id);
  st.downloads = st.downloads.filter((d) => d.id !== id);
  runs.delete(id);
  import('./main.js').then((m) => m.rerender()).catch(() => {});
}

/** Assemble what arrived into a file the device can keep. */
export function saveDownload(id) {
  const run = runs.get(id);
  const record = st.downloads.find((d) => d.id === id);
  if (!record) return;
  if (!run || !run.chunks.length) {
    toast('Nothing saved yet', 'warn');
    return;
  }
  const blob = new Blob(run.chunks, { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = record.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ---------- loading ---------- */

async function loadLocations() {
  const out = await api.fileLocations();
  st.locations = out.body.locations || [];
  if (!st.locationId && st.locations.length) st.locationId = st.locations[0].id;
}

async function loadTree({ quiet = false } = {}) {
  if (!st.locationId) return;
  if (!quiet) st.loading = true;
  try {
    const out = await api.fileList(st.locationId, st.path);
    st.entries = out.body.entries || [];
    st.parent = out.body.parent;
    st.error = '';
  } catch (error) {
    st.entries = [];
    st.error = error?.message || 'the directory could not be read';
  } finally {
    st.loading = false;
    st.ready = true;
  }
}

async function loadUsage() {
  const out = await api.fileUsage();
  st.usage = out.body.usage || [];
}

async function refreshDownloads() {
  const out = await api.downloads();
  st.downloads = out.body.downloads || [];
}

export async function loadAll() {
  if (!isApiMode()) return;
  try {
    await loadLocations();
    await Promise.all([loadTree(), loadUsage(), refreshDownloads()]);
    st.error = '';
  } catch (error) {
    st.error = `The gateway could not be read: ${error?.message || error}`;
  }
}

/* ---------- pieces of the screen ---------- */

const entryIcon = (entry) => {
  if (entry.type === 'dir') return icon('folder', 18);
  if (entry.type === 'link') return icon('link', 18);
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(entry.extension)) return icon('chart', 18);
  return icon('file', 18);
};

const tabBar = () => `
  <div class="fm-tabs" role="tablist" aria-label="File manager sections">
    ${[['browse', 'Browse', 'folder'], ['downloads', 'Downloads', 'download'], ['storage', 'Storage', 'archive']]
      .map(([id, label, ico]) => `<button class="fm-tab ${st.tab === id ? 'active' : ''}" role="tab" aria-selected="${st.tab === id}"
        data-act="fm-tab" data-tab="${id}">${icon(ico, 15)}<span>${label}</span></button>`)
      .join('')}
  </div>`;

function locationChips() {
  if (!st.locations.length) return '';
  return `<div class="fm-locs scroll-x" role="group" aria-label="Storage locations">
    ${st.locations
      .map(
        (l) => `<button class="chip ${l.id === st.locationId ? 'brand' : ''}" data-act="fm-loc" data-id="${esc(l.id)}">
          ${icon(l.kind === 'web' ? 'globe' : 'folder', 12)} ${esc(l.label)}
        </button>`
      )
      .join('')}
  </div>`;
}

const crumb = () => {
  const parts = String(st.path || '').split('/').filter(Boolean);
  const bits = [`<button class="fm-crumb" data-act="fm-cd" data-path="">${esc(st.locations.find((l) => l.id === st.locationId)?.label || 'root')}</button>`];
  let acc = '';
  parts.forEach((p) => {
    acc = acc ? `${acc}/${p}` : p;
    bits.push(`<span class="fm-crumb-sep">/</span><button class="fm-crumb" data-act="fm-cd" data-path="${esc(acc)}">${esc(p)}</button>`);
  });
  return `<div class="fm-crumbs scrolly">${bits.join('')}</div>`;
};

function entryRow(entry) {
  const sub = entry.type === 'dir' ? 'folder' : entry.type === 'link' ? 'link' : bytes(entry.size);
  const safe = entry.type === 'link' && entry.linkTargetOutside;
  return `<div class="fm-row ${safe ? 'unsafe' : ''}" data-act="${entry.type === 'dir' && !safe ? 'fm-open' : 'fm-menu'}"
      data-path="${esc(entry.path)}" data-type="${esc(entry.type)}" role="button" tabindex="0"
      aria-label="${esc(entry.name)}${entry.type === 'dir' ? ', folder' : ''}">
    <span class="fm-ico ${entry.type}">${entryIcon(entry)}</span>
    <span class="fm-main">
      <span class="fm-name">${esc(entry.name)}</span>
      <span class="fm-sub">${esc(sub)} · ${esc(fmtTime(entry.modifiedAt))}${safe ? ' · points outside this location — not opened' : ''}</span>
    </span>
    <span class="fm-more" aria-hidden="true">${icon('more', 16)}</span>
  </div>`;
}

function browseTab() {
  if (!st.locations.length) {
    return `<div class="banner warn">${icon('shield', 16)}<div><strong>No storage location is enrolled.</strong>
      An Owner can add one in the Storage tab. Until then there is no directory this screen may read.</div></div>`;
  }
  if (st.loading && !st.ready) return `<div class="fm-empty"><span class="cp-dot run"></span> Reading ${esc(st.path || 'the root')}…</div>`;
  if (st.error) return `<div class="banner bad">${icon('x', 16)}<div>${esc(st.error)}</div></div>`;
  const rows = st.entries.length
    ? st.entries.map(entryRow).join('')
    : `<div class="fm-empty">${icon('folder', 22)}<div>This folder is empty on the gateway.</div>
       <div class="tiny muted">${esc(st.path ? `/${st.path}` : 'root')} · nothing to list</div></div>`;
  return `
    ${crumb()}
    ${st.notice ? `<div class="banner info" role="status">${icon('check', 15)}<div>${esc(st.notice)}</div></div>` : ''}
    <div class="fm-actions">
      <button class="btn sm" data-act="fm-newdir">${icon('plus', 14)} New folder</button>
      <button class="btn sm" data-act="fm-upload">${icon('download', 14)} Upload</button>
      ${st.path ? `<button class="btn sm" data-act="fm-up">${icon('undo', 14)} Up</button>` : ''}
    </div>
    <div class="fm-list" data-fm-list>${rows}</div>
    <div class="tiny muted fm-hint">Long-press a file (or right-click) for actions. Folders open on tap.</div>`;
}

function downloadRow(d) {
  const done = d.bytesDone || 0;
  const total = d.bytesTotal || 0;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const live = d.status === 'running';
  return `<div class="fm-dl" data-dl="${esc(d.id)}" data-status="${esc(d.status)}">
    <div class="fm-dl-head">
      <span class="fm-ico file">${icon('file', 16)}</span>
      <span class="fm-main"><span class="fm-name">${esc(d.filename)}</span>
      <span class="fm-sub" data-dl-meta>${esc(bytes(done))} of ${total ? esc(bytes(total)) : 'unknown'} · ${pct}%</span></span>
      <span class="fm-badge ${esc(d.status)}">${esc(d.status)}</span>
    </div>
    <div class="fm-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${esc(d.filename)} progress">
      <i data-dl-fill style="width:${pct}%"></i>
    </div>
    <div class="fm-dl-tools">
      ${live
        ? `<button class="fm-tool" data-act="fm-dl-pause" data-id="${esc(d.id)}" aria-label="Pause">${icon('pause', 14)}</button>`
        : ['paused', 'failed', 'queued'].includes(d.status)
          ? `<button class="fm-tool" data-act="fm-dl-resume" data-id="${esc(d.id)}" aria-label="Resume">${icon('play', 14)}</button>`
          : ''}
      ${live || d.status === 'paused' ? `<button class="fm-tool" data-act="fm-dl-cancel" data-id="${esc(d.id)}" aria-label="Stop">${icon('stop', 14)}</button>` : ''}
      ${['failed', 'cancelled'].includes(d.status) ? `<button class="fm-tool" data-act="fm-dl-retry" data-id="${esc(d.id)}" aria-label="Retry">${icon('undo', 14)}</button>` : ''}
      ${d.status === 'completed' ? `<button class="fm-tool" data-act="fm-dl-save" data-id="${esc(d.id)}" aria-label="Save to device">${icon('download', 14)}</button>` : ''}
      <button class="fm-tool" data-act="fm-dl-menu" data-id="${esc(d.id)}" aria-label="More actions">${icon('more', 14)}</button>
    </div>
  </div>`;
}

function downloadsTab() {
  if (!st.downloads.length) {
    return `<div class="fm-empty">${icon('download', 22)}<div>No downloads yet.</div>
      <div class="tiny muted">Long-press a file in Browse and choose “Download”.</div></div>`;
  }
  return `<div class="fm-dls">${st.downloads.map(downloadRow).join('')}</div>
    <div class="tiny muted fm-hint">Progress is saved on the gateway, so a resume continues from the bytes already received.
      Pausing stops the request; the file is written to this device only when you press Save.</div>`;
}

const KIND_PURPOSE = {
  downloads: 'Where a download is written',
  artifacts: 'Where uploads and Copilot artifacts go',
  web: 'Where an agent publishes pages',
  custom: 'A root you enrolled yourself',
};

function storageTab() {
  if (!st.usage.length) {
    return `<div class="fm-empty">${icon('archive', 22)}<div>Nothing measured yet.</div></div>`;
  }
  const rows = st.usage
    .map((u) => {
      const loc = st.locations.find((l) => l.id === u.location) || {};
      return `<div class="fm-loc-card">
        <div class="row between">
          <div><div class="strong">${esc(u.label)}</div>
            <div class="tiny muted mono ellipsis">${esc(u.rootPath)}</div></div>
          <span class="fm-badge ${loc.granted ? 'ok' : 'paused'}">${loc.granted ? 'enrolled' : 'withdrawn'}</span>
        </div>
        <div class="fm-bar slim" role="img" aria-label="${esc(bytes(u.bytes))} used"><i style="width:100%"></i></div>
        <div class="tiny muted">${esc(bytes(u.bytes))} · ${u.files} files · ${u.dirs} folders${u.truncated ? ' · scan cut short' : ''}</div>
        <div class="tiny muted">${esc(KIND_PURPOSE[loc.kind] || '')}${loc.purpose ? ` · writes on purpose: ${esc(loc.purpose)}` : ' · no feature writes here implicitly'}</div>
      </div>`;
    })
    .join('');
  return `<div class="fm-locs-stack">${rows}</div>
    <div class="card" style="margin-top:12px">
      <div class="strong small">Add a location</div>
      <div class="tiny muted">An Owner can enrol any absolute directory on the gateway host. Every path in this
        screen is resolved inside one of these roots, so a root is the boundary — not a suggestion.</div>
      <button class="btn sm" style="margin-top:10px" data-act="fm-add-location">${icon('plus', 14)} Enrol a directory</button>
    </div>`;
}

/* ---------- the view ---------- */

views.files = {
  title: 'Files',
  persistent: true,
  render() {
    if (!isApiMode()) {
      return `<div class="page-head"><h1>Files</h1><div class="sub">File management</div></div>
        <div class="banner warn">${icon('shield', 16)}<div><strong>No gateway is connected.</strong>
          File management reads and writes real directories on a gateway host. This build has nowhere to look,
          so it shows no files rather than a sample tree. Connect a gateway in Settings.</div></div>`;
    }
    return `
      <div class="page-head"><h1>Files</h1>
        <div class="sub">${st.locations.length} storage ${st.locations.length === 1 ? 'location' : 'locations'} · ${esc(st.path || 'root')}</div>
      </div>
      ${tabBar()}
      ${st.tab === 'browse' ? locationChips() : ''}
      ${st.tab === 'browse' ? browseTab() : st.tab === 'downloads' ? downloadsTab() : storageTab()}`;
  },
  mount() {
    if (!isApiMode()) return;
    loadAll()
      .then(() => import('./main.js').then((m) => m.rerender()))
      .catch(() => {});
    wireLongPress();
  },
};

let pressTimer = null;
function wireLongPress() {
  const list = document.querySelector('[data-fm-list]');
  if (!list || list.dataset.wired === '1') return;
  list.dataset.wired = '1';
  list.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('.fm-row');
    if (!row) return;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      pressTimer = null;
      if (navigator.vibrate) navigator.vibrate(12);
      openEntryMenu(row.dataset.path, row.dataset.type, row.querySelector('.fm-name')?.textContent || '');
    }, 500);
  });
  ['pointerup', 'pointercancel', 'pointerleave', 'scroll'].forEach((evt) =>
    list.addEventListener(evt, () => clearTimeout(pressTimer), { passive: true })
  );
  list.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.fm-row');
    if (!row) return;
    e.preventDefault();
    openEntryMenu(row.dataset.path, row.dataset.type, row.querySelector('.fm-name')?.textContent || '');
  });
}

function openEntryMenu(path, type, name) {
  const isDir = type === 'dir';
  const rows = [
    isDir
      ? `<button class="btn block" data-act="fm-open" data-path="${esc(path)}">${icon('folder', 15)} Open</button>`
      : `<button class="btn block" data-act="fm-download" data-path="${esc(path)}">${icon('download', 15)} Download</button>`,
    `<button class="btn block" data-act="fm-rename" data-path="${esc(path)}">${icon('archive', 15)} Rename / move</button>`,
    `<button class="btn block" data-act="fm-copyto" data-path="${esc(path)}">${icon('copy', 15)} Copy to…</button>`,
    `<button class="btn block" data-act="fm-newdir-in" data-path="${esc(path)}">${icon('plus', 15)} New folder inside</button>`,
    `<button class="btn block danger" data-act="fm-delete" data-path="${esc(path)}">${icon('trash', 15)} Move to trash</button>`,
  ];
  openSheet({
    title: `<span class="mono small">${esc(name)}</span>`,
    body: `<div class="stack">${rows.join('')}</div>
      <div class="tiny muted" style="margin-top:10px">Moving to trash is reversible: the entry goes to
        <span class="mono">.trash/</span> inside this location with a timestamp.</div>`,
  });
}

/* ---------- actions ---------- */

on('fm-tab', (el, ds) => {
  st.tab = ds.tab;
  st.notice = '';
  import('./main.js').then((m) => m.rerender());
});

on('fm-loc', (el, ds) => {
  st.locationId = ds.id;
  st.path = '';
  st.entries = [];
  st.ready = false;
  loadTree().then(() => import('./main.js').then((m) => m.rerender()));
});

on('fm-cd', (el, ds) => {
  st.path = ds.path || '';
  st.notice = '';
  loadTree().then(() => import('./main.js').then((m) => m.rerender()));
});

on('fm-up', () => {
  st.path = st.parent === null || st.parent === undefined ? '' : st.parent;
  st.notice = '';
  loadTree().then(() => import('./main.js').then((m) => m.rerender()));
});

on('fm-open', (el, ds) => {
  st.path = ds.path || '';
  st.notice = '';
  loadTree().then(() => import('./main.js').then((m) => m.rerender()));
});

on('fm-menu', (el, ds) => {
  const row = el.closest('.fm-row');
  openEntryMenu(ds.path, ds.type, row?.querySelector('.fm-name')?.textContent || '');
});

on('fm-newdir', () => promptFolder(''));
on('fm-newdir-in', (el, ds) => {
  closeAllSheets();
  promptFolder(ds.path);
});

function promptFolder(parent) {
  openSheet({
    title: 'New folder',
    body: `<div class="field"><label>Name</label><input class="input mono" id="fm-dir-name" placeholder="notes"></div>
      <div class="tiny muted">Inside ${esc(st.path ? `/${st.path}` : 'the root')}${parent ? ` / ${esc(parent)}` : ''}</div>`,
    foot: `<button class="btn grow primary" data-act="fm-newdir-go" data-parent="${esc(parent)}">Create folder</button>`,
  });
}

on('fm-newdir-go', async (el, ds) => {
  const name = document.querySelector('#fm-dir-name')?.value.trim();
  if (!name) return toast('A name is required', 'warn');
  const rel = ds.parent ? `${ds.parent}/${name}` : name;
  try {
    await api.fileMkdir({ locationId: st.locationId, path: rel });
    closeAllSheets();
    toast('Folder created', 'ok');
    await loadTree();
    await loadUsage();
    import('./main.js').then((m) => m.rerender());
  } catch (error) {
    toast(esc(error?.message || 'the folder was not created'), 'bad');
  }
});

on('fm-rename', (el, ds) => {
  closeAllSheets();
  openSheet({
    title: 'Rename or move',
    body: `<div class="field"><label>New path</label><input class="input mono" id="fm-move-to" value="${esc(ds.path)}"></div>
      <div class="tiny muted">Relative to this location. Moving into a folder that does not exist is refused.</div>`,
    foot: `<button class="btn grow primary" data-act="fm-rename-go" data-from="${esc(ds.path)}">Move</button>`,
  });
});

on('fm-rename-go', async (el, ds) => {
  const to = document.querySelector('#fm-move-to')?.value.trim();
  if (!to) return;
  try {
    await api.fileMove({ locationId: st.locationId, from: ds.from, to });
    closeAllSheets();
    toast('Moved', 'ok');
    await loadTree();
    import('./main.js').then((m) => m.rerender());
  } catch (error) {
    toast(esc(error?.message || 'the move was refused'), 'bad');
  }
});

on('fm-copyto', (el, ds) => {
  closeAllSheets();
  openSheet({
    title: 'Copy to',
    body: `<div class="field"><label>Destination path</label><input class="input mono" id="fm-copy-to" value="${esc(ds.path)}.copy"></div>`,
    foot: `<button class="btn grow primary" data-act="fm-copy-go" data-from="${esc(ds.path)}">Copy</button>`,
  });
});

on('fm-copy-go', async (el, ds) => {
  const to = document.querySelector('#fm-copy-to')?.value.trim();
  if (!to) return;
  try {
    await api.fileCopy({ locationId: st.locationId, from: ds.from, to });
    closeAllSheets();
    toast('Copied', 'ok');
    await loadTree();
    await loadUsage();
    import('./main.js').then((m) => m.rerender());
  } catch (error) {
    toast(esc(error?.message || 'the copy was refused'), 'bad');
  }
});

on('fm-delete', async (el, ds) => {
  closeAllSheets();
  try {
    const out = await api.fileDelete(st.locationId, ds.path);
    toast(`Moved to trash — recoverable at ${esc(out.body.trashed)}`, 'ok');
    await loadTree();
    await loadUsage();
    import('./main.js').then((m) => m.rerender());
  } catch (error) {
    toast(esc(error?.message || 'the entry was not moved'), 'bad');
  }
});

on('fm-upload', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.addEventListener('change', () => {
    const files = [...(input.files || [])];
    files.forEach((f) => uploadFile(f));
  });
  input.click();
});

/**
 * Upload with XHR rather than fetch: only XHR reports upload progress, and an upload bar that cannot move
 * is exactly the kind of decorative control this app is not allowed to have.
 */
function uploadFile(file) {
  const rel = st.path ? `${st.path}/${file.name}` : file.name;
  const id = `up-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = performance.now();
  st.notice = `Uploading ${file.name}…`;
  import('./main.js').then((m) => m.rerender()).catch(() => {});
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `${gatewayUrl() === '/' ? '' : gatewayUrl()}/api/v1/files/upload?location=${encodeURIComponent(st.locationId)}&path=${encodeURIComponent(rel)}`);
  xhr.withCredentials = true;
  xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
  const csrf = document.querySelector('meta[name="mmm-csrf"]')?.content;
  if (csrf) xhr.setRequestHeader('x-mmm-csrf', csrf);
  xhr.upload.onprogress = (evt) => {
    if (!evt.lengthComputable) return;
    const secs = (performance.now() - startedAt) / 1000;
    const bps = secs > 0 ? evt.loaded / secs : 0;
    st.uploads = st.uploads.filter((u) => u.id !== id).concat([{ id, name: file.name, pct: Math.round((evt.loaded / evt.total) * 100), speed: bps }]);
    paintUploads();
  };
  xhr.onload = async () => {
    st.uploads = st.uploads.filter((u) => u.id !== id);
    if (xhr.status >= 200 && xhr.status < 300) {
      let out = {};
      try { out = JSON.parse(xhr.responseText); } catch { /* the status is the evidence */ }
      st.notice = `${file.name} uploaded — the gateway reports ${bytes(out.bytes)} on disk.`;
      toast('Uploaded', 'ok');
      await loadTree();
      await loadUsage();
    } else {
      let message = `the gateway answered ${xhr.status}`;
      try { message = JSON.parse(xhr.responseText).error || message; } catch { /* keep the status */ }
      st.notice = `${file.name} was not uploaded: ${message}`;
      toast(`Upload refused — ${esc(message)}`, 'bad');
    }
    import('./main.js').then((m) => m.rerender()).catch(() => {});
  };
  xhr.onerror = () => {
    st.uploads = st.uploads.filter((u) => u.id !== id);
    st.notice = `${file.name} was not uploaded: the gateway could not be reached.`;
    import('./main.js').then((m) => m.rerender()).catch(() => {});
  };
  xhr.send(file);
}

function paintUploads() {
  const host = document.querySelector('[data-fm-uploads]');
  if (!host) return;
  host.innerHTML = st.uploads
    .map((u) => `<div class="fm-dl"><div class="fm-dl-head"><span class="fm-ico file">${icon('download', 16)}</span>
      <span class="fm-main"><span class="fm-name">${esc(u.name)}</span>
      <span class="fm-sub">${u.pct}% · ${speedText(u.speed)}</span></span></div>
      <div class="fm-bar"><i style="width:${u.pct}%"></i></div></div>`)
    .join('');
}

on('fm-download', async (el, ds) => {
  closeAllSheets();
  try {
    const made = await api.createDownload({ locationId: st.locationId, path: ds.path });
    st.downloads.unshift(made.body.download);
    st.tab = 'downloads';
    st.notice = '';
    import('./main.js').then((m) => m.rerender());
    await runDownload(made.body.download.id);
  } catch (error) {
    toast(esc(error?.message || 'the download was not started'), 'bad');
  }
});

on('fm-dl-pause', (el, ds) => pauseDownload(ds.id));
on('fm-dl-resume', (el, ds) => resumeDownload(ds.id));
on('fm-dl-cancel', (el, ds) => cancelDownload(ds.id));
on('fm-dl-retry', (el, ds) => retryDownload(ds.id));
on('fm-dl-save', (el, ds) => saveDownload(ds.id));
on('fm-dl-forget', async (el, ds) => {
  closeAllSheets();
  await forgetDownload(ds.id);
});

on('fm-dl-menu', (el, ds) => {
  const d = st.downloads.find((x) => x.id === ds.id);
  if (!d) return;
  const running = d.status === 'running';
  openSheet({
    title: `<span class="mono small">${esc(d.filename)}</span>`,
    body: `<div class="stack">
      ${running ? `<button class="btn block" data-act="fm-dl-pause" data-id="${esc(d.id)}">${icon('pause', 15)} Pause</button>` : ''}
      ${['paused', 'failed', 'queued'].includes(d.status) ? `<button class="btn block" data-act="fm-dl-resume" data-id="${esc(d.id)}">${icon('play', 15)} Resume</button>` : ''}
      ${running || d.status === 'paused' ? `<button class="btn block" data-act="fm-dl-cancel" data-id="${esc(d.id)}">${icon('stop', 15)} Stop</button>` : ''}
      ${['failed', 'cancelled'].includes(d.status) ? `<button class="btn block" data-act="fm-dl-retry" data-id="${esc(d.id)}">${icon('undo', 15)} Restart from zero</button>` : ''}
      ${d.status === 'completed' ? `<button class="btn block primary" data-act="fm-dl-save" data-id="${esc(d.id)}">${icon('download', 15)} Save to device</button>` : ''}
      <button class="btn block danger" data-act="fm-dl-forget" data-id="${esc(d.id)}">${icon('trash', 15)} Delete record</button>
    </div>
    <div class="tiny muted" style="margin-top:10px">Deleting the record never deletes the file. ${d.bytesDone}/${d.bytesTotal} bytes recorded${d.attempts ? ` · ${d.attempts} restarts` : ''}.</div>`,
  });
});

on('fm-add-location', () => {
  openSheet({
    title: 'Enrol a directory',
    body: `<div class="field"><label>Label</label><input class="input" id="fm-loc-label" placeholder="Scratch space"></div>
      <div class="field"><label>Absolute path on the gateway host</label><input class="input mono" id="fm-loc-path" placeholder="/srv/files/scratch"></div>
      <div class="field"><label>Kind</label><select class="input" id="fm-loc-kind">
        <option value="custom">custom</option><option value="artifacts">artifacts</option>
        <option value="downloads">downloads</option><option value="web">public web</option></select></div>
      <div class="banner info">${icon('shield', 15)}<div>Enrolling is an Owner act and is audited. The directory is created if it
        does not exist; nothing inside it is touched.</div></div>`,
    foot: `<button class="btn grow primary" data-act="fm-add-location-go">Enrol</button>`,
  });
});

on('fm-add-location-go', async () => {
  const label = document.querySelector('#fm-loc-label')?.value.trim();
  const path = document.querySelector('#fm-loc-path')?.value.trim();
  const kind = document.querySelector('#fm-loc-kind')?.value;
  if (!label || !path) return toast('A label and a path are required', 'warn');
  try {
    await api.createFileLocation({ label, path, kind });
    closeAllSheets();
    toast('Location enrolled', 'ok');
    await loadAll();
    import('./main.js').then((m) => m.rerender());
  } catch (error) {
    toast(esc(error?.message || 'the location was refused'), 'bad');
  }
});

export const fileManagerState = () => ({ ...st });
export { ApiError };
