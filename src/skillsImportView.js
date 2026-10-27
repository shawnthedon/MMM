/* ============ Skills Hub import UI ============
 * Two screens in one sheet: the source picker (paste / upload) and the review step (what was found,
 * what it asks for, what it would change). Installation is a separate, explicit click and lands the
 * skills in quarantine (`pending`), exactly like agent-synthesized skills.
 */
import { esc, icon, now } from './core.js';
import { openSheet, toast } from './shell.js';
import { on } from './shell.js';
import { ACCEPT_ATTR, FORMATS, ACCEPTED_EXTENSIONS, analyseImport, installImport, rejectImport, packageToJson, buildPackage } from './skillsImport.js';

let pending = null; // { analysis, text?, filename, bytes? }
let busy = false;

const FORMAT_ROWS = FORMATS.map((f) => `<div class="kv"><span class="k">${esc(f.label)}</span><span class="tiny muted" style="text-align:right">${esc(f.detail)}</span></div>`).join('');

function pickerBody() {
  return `
    <div class="field" style="margin-top:0">
      <label for="imp-text">Paste a skill, manifest or package</label>
      <textarea class="input mono" id="imp-text" rows="8" placeholder="---&#10;name: web.cite-check&#10;description: Verify that every claim has a source&#10;allowed-tools: [web.search]&#10;---&#10;&#10;# Cite check&#10;1. Split the answer into claims…"></textarea>
    </div>
    <div class="field">
      <label for="imp-file">…or upload a file</label>
      <input class="input" type="file" id="imp-file" accept="${ACCEPT_ATTR}">
      <div class="tiny muted" style="margin-top:4px">${esc(ACCEPTED_EXTENSIONS.join(' · '))} — bundled .zip/.skill archives may contain several skills.</div>
    </div>
    <div id="imp-error" class="tiny" style="color:var(--danger)"></div>
    <div class="section-title">Accepted formats</div>
    <div class="card">${FORMAT_ROWS}</div>
    <div class="mx-note" style="margin-top:10px">${icon('shield', 14)}
      <div>Imports are untrusted input: each package is schema-checked, scanned for instruction
      injection, embedded secrets and unsafe paths, then dependency- and permission-reviewed before
      you can install it. Nothing is enabled automatically and no tool or permission is ever granted
      by an import.</div>
    </div>`;
}

function statusChip(status) {
  const map = {
    ready: ['ok', 'ready to install'],
    'needs-deps': ['warn', 'missing dependency'],
    conflict: ['warn', 'version conflict'],
    blocked: ['bad', 'blocked'],
  };
  const [cls, label] = map[status] || ['', status];
  return `<span class="chip tiny ${cls}">${esc(label)}</span>`;
}

function reviewBody(analysis) {
  const rows = (analysis.skills || []).map((r) => {
    const findings = r.findings.filter((f) => f.severity !== 'info');
    const infos = r.findings.filter((f) => f.severity === 'info');
    return `
      <div class="card imp-skill" data-skill="${esc(r.skill.name)}">
        <div class="row between" style="gap:8px">
          <div class="grow">
            <div class="strong small mono">${esc(r.skill.name)} <span class="chip tiny">v${esc(r.skill.version)}</span></div>
            <div class="tiny muted">${esc(r.skill.desc)}</div>
          </div>
          ${statusChip(r.status)}
        </div>
        <div class="row wrap" style="gap:4px;margin-top:6px">
          <span class="chip tiny">${esc(r.skill.category)}</span>
          <span class="chip tiny">${esc(r.skill.license)}</span>
          ${r.skill.requires?.length ? `<span class="chip tiny warn">requires ${esc(r.skill.requires.join(', '))}</span>` : ''}
          ${r.skill.tools?.length ? `<span class="chip tiny">${r.skill.tools.length} tools requested</span>` : ''}
          ${r.skill.perms?.length ? `<span class="chip tiny">${r.skill.perms.length} permissions requested</span>` : ''}
        </div>
        ${findings.length ? `<ul class="imp-findings">
          ${findings.map((f) => `<li class="sev-${f.severity}">${icon(f.severity === 'error' ? 'shield' : 'bell', 12)} <span>${esc(f.message)}</span></li>`).join('')}
        </ul>` : ''}
        ${infos.length ? `<details class="imp-info"><summary>${infos.length} informational note(s)</summary>
          <ul class="imp-findings">${infos.map((f) => `<li>${esc(f.message)}</li>`).join('')}</ul></details>` : ''}
        ${r.status === 'blocked' ? '' : `<label class="imp-skip"><input type="checkbox" data-imp-skip="${esc(r.skill.name)}"> Skip this one</label>`}
      </div>`;
  }).join('');

  const relationRows = (analysis.relations || []).map((r) => `<div class="kv"><span class="k mono tiny">${esc(r.from)} → ${esc(r.to)}</span><span class="tiny muted">${esc(r.type)}</span></div>`).join('');

  return `
    <div class="row wrap" style="gap:6px;margin-bottom:10px">
      <span class="chip tiny brand">${esc(analysis.format)}</span>
      <span class="chip tiny">${(analysis.skills || []).length} skill(s)</span>
      <span class="chip tiny">${(analysis.relations || []).length} relationship(s)</span>
      ${analysis.blocked ? `<span class="chip tiny bad">${analysis.blocked} blocked</span>` : ''}
    </div>
    <div class="tiny muted" style="margin-bottom:8px">Source: ${esc(analysis.file)} — nothing has been installed yet.</div>
    ${analysis.errors?.length ? `<div class="banner bad" style="margin-bottom:10px">${icon('shield', 16)}<div>${analysis.errors.map((e) => esc(e.message)).join('<br>')}</div></div>` : ''}
    ${rows}
    ${relationRows ? `<div class="section-title">Relationships in the package</div><div class="card">${relationRows}</div>` : ''}
    ${(analysis.relationIssues || []).length ? `<div class="section-title">Dropped relationships</div><div class="card">${analysis.relationIssues.map((i) => `<div class="tiny" style="color:var(--warning)">${esc(i.message)}</div>`).join('')}</div>` : ''}
    <p class="tiny muted" style="margin-top:10px">
      Installed skills are quarantined as <strong>pending</strong>: approve them in Skills → Imported after
      reviewing the eval evidence. Tools and permissions stay ungranted — a reviewer assigns them per agent.
    </p>`;
}

function showReview(analysis) {
  openSheet({
    title: 'Review import',
    wide: true,
    body: reviewBody(analysis),
    foot: `
      <button class="btn" data-act="skill-import-back">Back</button>
      <button class="btn danger" data-act="skill-import-reject">Reject</button>
      <button class="btn primary grow" data-act="skill-import-install" ${analysis.installable?.length ? '' : 'disabled'}>
        ${icon('check', 15)} Install ${analysis.installable?.length || 0} as pending
      </button>`,
  });
}

export function openImportSheet() {
  pending = null;
  openSheet({
    title: 'Import skills',
    wide: true,
    body: pickerBody(),
    foot: `<button class="btn primary grow" data-act="skill-import-analyse">${icon('search', 15)} Analyse package</button>`,
  });
}

/** Analyse pasted text or a filename+bytes pair and move to the review step. */
export async function analyseAndReview({ text, filename, bytes } = {}) {
  if (busy) return { ok: false, error: 'busy' };
  busy = true;
  try {
    const analysis = await analyseImport({ text, filename, bytes });
    pending = { analysis, text, filename, bytes };
    if (!analysis.ok && !(analysis.skills || []).length) {
      const host = document.getElementById('imp-error');
      const message = analysis.errors[0]?.message || 'Nothing could be read from that input.';
      if (host) host.textContent = message;
      toast(message, 'bad');
      return { ok: false, analysis };
    }
    showReview(analysis);
    return { ok: true, analysis };
  } finally {
    busy = false;
  }
}

export function installPending({ skip = [] } = {}) {
  if (!pending?.analysis) return { ok: false, error: 'No analysed package.' };
  const out = installImport(pending.analysis, { skip });
  if (out.ok) {
    window.__skillsTab = 'imported';
    pending = null;
    import('./shell.js').then((m) => m.closeAllSheets());
    toast(`Installed ${out.installed.length} skill(s) as pending — review before approving`, 'ok');
    import('./main.js').then((m) => m.navigate('skills'));
  }
  return out;
}

export function rejectPending() {
  const out = rejectImport(pending?.analysis);
  pending = null;
  import('./shell.js').then((m) => m.closeAllSheets());
  toast('Import rejected — recorded in the import log');
  return out;
}

export { packageToJson, buildPackage };

/* ---------- actions ---------- */
on('skill-import-open', () => openImportSheet());

on('skill-import-analyse', () => {
  const sheet = document.querySelector('.sheet.open');
  if (!sheet) return;
  const text = sheet.querySelector('#imp-text')?.value || '';
  if (!text.trim()) {
    // A file selected but not yet read is handled by the change listener.
    const err = sheet.querySelector('#imp-error');
    if (err) err.textContent = 'Paste a skill, manifest or package — or choose a file above.';
    toast('Nothing to analyse', 'bad');
    return;
  }
  analyseAndReview({ text, filename: 'pasted-text' });
});

on('skill-import-back', () => openImportSheet());

on('skill-import-install', () => {
  const sheet = document.querySelector('.sheet.open');
  const skip = sheet ? [...sheet.querySelectorAll('[data-imp-skip]:checked')].map((c) => c.dataset.impSkip) : [];
  const out = installPending({ skip });
  if (!out.ok) toast(out.error || 'Could not install', 'bad');
});

on('skill-import-reject', () => rejectPending());

/* File input: read the file, then analyse immediately. */
if (typeof document !== 'undefined') {
  document.addEventListener('change', async (e) => {
    const input = e.target.closest('#imp-file');
    if (!input || !input.files || !input.files.length) return;
    const file = input.files[0];
    const isBinary = /\.(zip|skill)$/i.test(file.name);
    try {
      if (isBinary) {
        const buffer = await file.arrayBuffer();
        await analyseAndReview({ filename: file.name, bytes: new Uint8Array(buffer) });
      } else {
        const text = await file.text();
        await analyseAndReview({ filename: file.name, text });
      }
    } catch (err) {
      toast(`Could not read ${file.name}: ${err.message}`, 'bad');
    }
  });
}

/** Test/seam: what is currently staged for install. */
export const stagedImport = () => (pending ? { format: pending.analysis.format, skills: pending.analysis.skills.map((r) => r.skill.name) } : null);
export const importStamp = () => now();
