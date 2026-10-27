/* ============ Skills Matrix ============
 * The interactive relationship graph for skills (MMMV2 skills spec §6).
 *
 * - Nodes are skills; edges are TYPED relationships. A plain line never implies execution.
 * - Every edit is validated (known endpoints, no duplicate, no cycle for ordered types, no
 *   contradiction with a dependency), saved immediately with a version bump, recorded in the
 *   matrix history for rollback, and logged as an event.
 * - The graph is configuration only. This build emits no runtime telemetry, so the matrix says
 *   "not instrumented" instead of animating invented activity (spec §6.5, §10.3).
 * - A table view is always available (inside a <details>) for keyboard and screen-reader users,
 *   and status is communicated with text/line-style, never colour alone.
 */
import { getState, setState, esc, icon, now, logEvent } from './core.js';
import { on, openSheet, toast, confirmModal } from './shell.js';
import { REL_TYPES, REL_TYPE_IDS } from './skillsData.js';
import { views } from './views1.js';
import './skills.css';

const VIEW = { zoom: 1, filter: new Set(REL_TYPE_IDS), query: '', list: false };
const HISTORY_LIMIT = 20;

/* =========================================================================================
 * Validation + mutation
 * =======================================================================================*/
const hasEdge = (relations, from, to) => relations.some((r) => r.from === from && r.to === to);

/** True when `to` can already reach `from` through ordered (cycle-bearing) relationships. */
function reachable(relations, from, to, seen = new Set()) {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return relations
    .filter((r) => r.from === from && REL_TYPES[r.type]?.cycle)
    .some((r) => reachable(relations, r.to, to, seen));
}

/**
 * Validate a proposed relationship.
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function validateRelationship(from, to, type, relations = getState().relations || []) {
  const errors = [];
  const warnings = [];
  const skills = getState().skills || [];
  if (!from || !to) errors.push('Choose both skills.');
  if (from === to) errors.push('A skill cannot relate to itself.');
  if (!REL_TYPES[type]) errors.push(`Unknown relationship type “${type}”.`);
  const fromSkill = skills.find((s) => s.name === from);
  const toSkill = skills.find((s) => s.name === to);
  if (from && !fromSkill) errors.push(`Unknown skill “${from}”.`);
  if (to && !toSkill) errors.push(`Unknown skill “${to}”.`);
  if (relations.some((r) => r.from === from && r.to === to && r.type === type)) {
    errors.push(`“${from}” already has a “${REL_TYPES[type]?.label || type}” link to “${to}”.`);
  }
  if (!errors.length && REL_TYPES[type].cycle && reachable(relations, to, from)) {
    errors.push(`That would create a ${REL_TYPES[type].label.toLowerCase()} cycle (${to} already reaches ${from}). Cycles are rejected.`);
  }
  if (!errors.length) {
    if (['depends_on', 'composes_with'].includes(type) && hasEdge(relations, from, to)) {
      warnings.push('A link already exists between these skills; two edges may be redundant.');
    }
    if (type === 'conflicts_with' && relations.some((r) => r.from === from && r.to === to && ['depends_on', 'composes_with'].includes(r.type))) {
      warnings.push('These skills also have an execution relationship — one of the two links is probably wrong.');
    }
    if (toSkill?.unavailable) {
      warnings.push(`“${to}” is unavailable here: ${toSkill.unavailable}`);
    }
    if (REL_TYPES[type].cycle && fromSkill && toSkill && fromSkill.requires?.includes(to)) {
      warnings.push('The manifest already declares this dependency; the graph link now matches it.');
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

function snapshot(relations) {
  return JSON.parse(JSON.stringify(relations || []));
}

export function addRelationship(from, to, type, note = '') {
  const s = getState();
  const check = validateRelationship(from, to, type, s.relations || []);
  if (!check.ok) return { ok: false, errors: check.errors, warnings: check.warnings };
  const rel = { id: `rl-${Math.random().toString(36).slice(2, 8)}`, from, to, type, note };
  setState((st) => {
    st.matrixHistory = [...(st.matrixHistory || []), { at: now(), relations: snapshot(st.relations), action: `add ${type}` }].slice(-HISTORY_LIMIT);
    st.relations = [...(st.relations || []), rel];
    st.matrixVersion = (st.matrixVersion || 1) + 1;
    logEvent('skill', `Matrix: ${from} ${REL_TYPES[type].label.toLowerCase()} ${to}`);
  }, 'matrix-add');
  return { ok: true, relation: rel, warnings: check.warnings };
}

export function removeRelationship(id) {
  const s = getState();
  const rel = (s.relations || []).find((r) => r.id === id);
  if (!rel) return { ok: false, errors: ['Relationship not found.'] };
  setState((st) => {
    st.matrixHistory = [...(st.matrixHistory || []), { at: now(), relations: snapshot(st.relations), action: `remove ${rel.type}` }].slice(-HISTORY_LIMIT);
    st.relations = st.relations.filter((r) => r.id !== id);
    st.matrixVersion = (st.matrixVersion || 1) + 1;
    logEvent('skill', `Matrix: removed ${rel.from} ${REL_TYPES[rel.type].label.toLowerCase()} ${rel.to}`);
  }, 'matrix-remove');
  return { ok: true };
}

export function undoMatrix() {
  const s = getState();
  const history = s.matrixHistory || [];
  if (!history.length) return { ok: false, errors: ['Nothing to undo.'] };
  const last = history[history.length - 1];
  setState((st) => {
    st.relations = snapshot(last.relations);
    st.matrixHistory = history.slice(0, -1);
    st.matrixVersion = (st.matrixVersion || 1) + 1;
    logEvent('skill', `Matrix: rolled back to the version before “${last.action}”`);
  }, 'matrix-undo');
  return { ok: true, action: last.action };
}

/** Graph facts used by the header, the banner and the tests. */
export function matrixStats() {
  const s = getState();
  const relations = s.relations || [];
  const skills = s.skills || [];
  const names = new Set(skills.map((k) => k.name));
  const missing = relations.filter((r) => !names.has(r.from) || !names.has(r.to));
  const byType = {};
  relations.forEach((r) => { byType[r.type] = (byType[r.type] || 0) + 1; });
  const conflicts = relations.filter((r) => r.type === 'conflicts_with');
  const cycles = [];
  const walk = (node, stack, path) => {
    relations.filter((r) => r.from === node && REL_TYPES[r.type]?.cycle).forEach((r) => {
      if (stack.has(r.to)) {
        cycles.push([...path, r.to].join(' → '));
        return;
      }
      stack.add(r.to);
      walk(r.to, stack, [...path, r.to]);
      stack.delete(r.to);
    });
  };
  skills.forEach((k) => walk(k.name, new Set([k.name]), [k.name]));
  return {
    skills: skills.length,
    relations: relations.length,
    byType,
    missing: missing.length,
    conflicts: conflicts.length,
    cycles: [...new Set(cycles)],
    version: s.matrixVersion || 1,
    historyDepth: (s.matrixHistory || []).length,
    instrumented: false,
  };
}

/* =========================================================================================
 * Rendering
 * =======================================================================================*/
function layout(skills, width, height) {
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) / 2 - 74;
  const positions = new Map();
  // Stable ordering keeps node positions identical across renders.
  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  sorted.forEach((skill, i) => {
    const angle = (i / Math.max(sorted.length, 1)) * Math.PI * 2 - Math.PI / 2;
    positions.set(skill.name, {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      skill,
    });
  });
  return positions;
}

function shortLabel(name) {
  const parts = String(name).split('.');
  return parts.length > 1 ? parts.slice(-1)[0] : name;
}

function graphHTML() {
  const s = getState();
  const W = 720;
  const H = 560;
  const query = VIEW.query.toLowerCase();
  let skills = s.skills || [];
  let relations = (s.relations || []).filter((r) => VIEW.filter.has(r.type));
  if (query) {
    const hit = (name) => name.toLowerCase().includes(query);
    const matched = new Set(skills.filter((k) => hit(k.name) || hit(k.category || '') || hit(k.desc || '')).map((k) => k.name));
    relations = relations.filter((r) => matched.has(r.from) || matched.has(r.to));
    relations.forEach((r) => { matched.add(r.from); matched.add(r.to); });
    skills = skills.filter((k) => matched.has(k.name));
  }
  const pos = layout(skills, W, H);
  const edgeHTML = relations.map((r) => {
    const a = pos.get(r.from);
    const b = pos.get(r.to);
    if (!a || !b) return '';
    const type = REL_TYPES[r.type] || REL_TYPES.related_to;
    return `
      <g class="mx-edge ${r.type}">
        <line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"
              stroke="${type.color}" stroke-width="${type.weight}" stroke-dasharray="${type.dash}"
              ${type.marker ? 'marker-end="url(#mx-arrow)"' : ''} />
        <line class="hit" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"
              data-act="matrix-edge" data-id="${esc(r.id)}" tabindex="0" role="button"
              aria-label="${esc(`${r.from} ${type.label} ${r.to}`)}" />
      </g>`;
  }).join('');

  const nodeHTML = [...pos.values()].map(({ x, y, skill }) => {
    const restricted = Boolean(skill.unavailable);
    const pending = skill.status === 'pending';
    const state = restricted ? 'unavailable' : pending ? 'pending' : 'active';
    return `
      <g class="mx-node ${state}" data-act="matrix-node" data-name="${esc(skill.name)}" tabindex="0" role="button"
         aria-label="${esc(`${skill.name}, ${skill.category || 'skill'}, ${state}. Open details.`)}"
         transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">
        <circle r="21" />
        <text class="ico" y="5" text-anchor="middle" aria-hidden="true">${restricted ? '!' : pending ? '?' : '◆'}</text>
        <text class="lbl" y="36" text-anchor="middle">${esc(shortLabel(skill.name))}</text>
      </g>`;
  }).join('');

  return `
    <div class="mx-graph" style="--mx-zoom:${VIEW.zoom}">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Skills relationship graph: ${skills.length} skills, ${relations.length} relationships. A text table of the same data follows below.">
        <defs>
          <marker id="mx-arrow" viewBox="0 0 10 10" refX="26" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="currentColor" />
          </marker>
        </defs>
        <g class="mx-edges">${edgeHTML}</g>
        <g class="mx-nodes">${nodeHTML}</g>
      </svg>
      ${skills.length ? '' : '<div class="mx-empty">No skills match that search.</div>'}
    </div>`;
}

function listHTML() {
  const s = getState();
  const relations = (s.relations || []).filter((r) => VIEW.filter.has(r.type));
  return `
    <details class="mx-list" id="mx-list" ${VIEW.list ? 'open' : ''}>
      <summary>${icon('board', 14)} Table view — ${relations.length} relationship${relations.length === 1 ? '' : 's'} (accessible alternative to the graph)</summary>
      <div class="mx-table" role="table" aria-label="Skill relationships">
        <div class="mx-tr head" role="row">
          <span role="columnheader">From</span><span role="columnheader">Relationship</span><span role="columnheader">To</span><span role="columnheader">Action</span>
        </div>
        ${relations.map((r) => `
          <div class="mx-tr" role="row">
            <span role="cell" class="mono">${esc(r.from)}</span>
            <span role="cell"><span class="mx-type ${r.type}">${esc(REL_TYPES[r.type]?.label || r.type)}</span></span>
            <span role="cell" class="mono">${esc(r.to)}</span>
            <span role="cell"><button class="btn sm" data-act="matrix-remove" data-id="${esc(r.id)}">Remove</button></span>
          </div>`).join('') || '<div class="mx-tr"><span role="cell" class="tiny muted">No relationships selected.</span></div>'}
      </div>
    </details>`;
}

function legendHTML() {
  return `
    <div class="mx-legend" aria-label="Relationship legend">
      ${REL_TYPE_IDS.map((id) => {
        const t = REL_TYPES[id];
        const on2 = VIEW.filter.has(id);
        return `<button class="mx-legend-item ${on2 ? 'on' : ''}" data-act="matrix-filter" data-type="${id}"
                        aria-pressed="${on2}" title="${esc(t.hint)}">
          <svg viewBox="0 0 34 8" aria-hidden="true"><line x1="1" y1="4" x2="33" y2="4" stroke="${t.color}" stroke-width="2" stroke-dasharray="${t.dash}" /></svg>
          <span>${esc(t.label)}</span>
        </button>`;
      }).join('')}
    </div>`;
}

views.matrix = {
  title: 'Skills Matrix',
  persistent: true,
  render() {
    const s = getState();
    const stats = matrixStats();
    return `
      <div class="page-head row between">
        <div>
          <h1>Skills Matrix</h1>
          <div class="sub">${stats.skills} skills · ${stats.relations} typed links · v${stats.version} · local workspace store</div>
        </div>
        <div class="row" style="gap:6px">
          <button class="iconbtn" data-act="matrix-undo" aria-label="Undo last matrix change" title="Undo last change">${icon('undo', 18)}</button>
          <button class="iconbtn" data-act="matrix-add-open" aria-label="Add a relationship" title="Add relationship">${icon('plus', 18)}</button>
        </div>
      </div>

      <div class="mx-toolbar">
        <div class="row" style="gap:6px">
          <button class="btn sm" data-act="matrix-zoom" data-dir="out" aria-label="Zoom out">−</button>
          <span class="tiny muted" id="mx-zoom">${Math.round(VIEW.zoom * 100)}%</span>
          <button class="btn sm" data-act="matrix-zoom" data-dir="in" aria-label="Zoom in">+</button>
          <button class="btn sm" data-act="matrix-zoom" data-dir="reset">Fit</button>
        </div>
        <label class="mx-search">
          <span class="sr-only">Search skills</span>
          ${icon('search', 14)}
          <input class="input" id="mx-query" data-mx="query" value="${esc(VIEW.query)}" placeholder="Search skills or categories">
        </label>
      </div>

      ${legendHTML()}

      ${stats.cycles.length ? `<div class="banner bad" style="margin-bottom:10px">${icon('shield', 16)}<div><strong>${stats.cycles.length} cycle(s) detected</strong> — ${esc(stats.cycles[0])}. Remove a link to break it.</div></div>` : ''}
      ${stats.conflicts ? `<div class="banner warn" style="margin-bottom:10px">${icon('shield', 16)}<div><strong>${stats.conflicts} conflicting combination(s)</strong> declared. Resolve them before assigning both skills to one agent.</div></div>` : ''}
      ${stats.missing ? `<div class="banner warn" style="margin-bottom:10px">${icon('shield', 16)}<div>${stats.missing} link(s) reference a skill that is no longer installed.</div></div>` : ''}

      <div id="mx-canvas">${graphHTML()}${listHTML()}</div>

      <div class="card" style="margin-top:12px">
        <div class="kv"><span class="k">Store</span><span class="strong">this browser (no skills route on the gateway)</span></div>
        <div class="kv"><span class="k">Version</span><span class="strong">v${stats.version} · ${stats.historyDepth} undoable change(s)</span></div>
        <div class="kv"><span class="k">Runtime overlay</span><span class="strong">not instrumented</span></div>
        <div class="tiny muted" style="margin-top:8px">
          Lines are configuration: “depends on” means A needs B, not that B ran. No skill telemetry exists in this
          build, so the matrix shows no live execution markers instead of animating invented activity.
        </div>
      </div>`;
  },
};

/* =========================================================================================
 * Sheets: node, edge, add-relationship
 * =======================================================================================*/
function relationsOf(name) {
  const s = getState();
  return {
    out: (s.relations || []).filter((r) => r.from === name),
    in: (s.relations || []).filter((r) => r.to === name),
  };
}

function nodeSheet(name) {
  const s = getState();
  const skill = (s.skills || []).find((k) => k.name === name);
  if (!skill) return;
  const { out, in: incoming } = relationsOf(name);
  const state = skill.unavailable ? 'unavailable' : skill.status === 'pending' ? 'pending review' : skill.status;
  const row = (r, dir) => `
    <div class="mx-rel-row">
      <span class="mx-type ${r.type}">${esc(REL_TYPES[r.type]?.label || r.type)}</span>
      <span class="mono tiny grow">${dir === 'out' ? `→ ${esc(r.to)}` : `← ${esc(r.from)}`}</span>
      <button class="iconbtn sm" data-act="matrix-remove" data-id="${esc(r.id)}" aria-label="Remove relationship">${icon('x', 14)}</button>
    </div>`;
  openSheet({
    title: `<span class="mono">${esc(skill.name)}</span>`,
    body: `
      <div class="row wrap" style="gap:6px;margin-bottom:10px">
        <span class="chip tiny">v${esc(skill.version)}</span>
        <span class="chip tiny">${esc(skill.category || 'skill')}</span>
        <span class="chip tiny ${state === 'active' ? 'ok' : state === 'unavailable' ? 'bad' : 'warn'}">${esc(state)}</span>
        <span class="chip tiny">${esc(skill.origin)}</span>
      </div>
      <div class="small">${esc(skill.desc)}</div>
      ${skill.unavailable ? `<div class="mx-note">${icon('shield', 14)}<div>${esc(skill.unavailable)}</div></div>` : ''}
      <div class="section-title">Manifest</div>
      <div class="card">
        <div class="kv"><span class="k">Author · licence</span><span class="strong">${esc(skill.author || '—')} · ${esc(skill.license || '—')}</span></div>
        <div class="kv"><span class="k">Compatibility</span><span class="strong">${esc((skill.compat || []).join(', ') || 'not declared')}</span></div>
        <div class="kv"><span class="k">Tools requested</span><span class="strong">${esc((skill.tools || []).join(', ') || 'none')}</span></div>
        <div class="kv"><span class="k">Permissions requested</span><span class="strong">${esc((skill.perms || []).join(', ') || 'none')}</span></div>
        <div class="kv"><span class="k">Requires</span><span class="strong">${esc((skill.requires || []).join(', ') || 'none')}</span></div>
        <div class="kv"><span class="k">Inputs → outputs</span><span class="strong">${esc((skill.inputs || []).join(', ') || '—')} → ${esc((skill.outputs || []).join(', ') || '—')}</span></div>
      </div>

      <div class="section-title">Relationships (${out.length + incoming.length})</div>
      <div class="card">
        ${[...out.map((r) => row(r, 'out')), ...incoming.map((r) => row(r, 'in'))].join('') || '<div class="tiny muted">No relationships yet.</div>'}
        <button class="btn sm" style="margin-top:8px" data-act="matrix-add-open" data-from="${esc(name)}">${icon('plus', 14)} Add relationship</button>
      </div>
      <p class="tiny muted" style="margin-top:8px">Links are configuration only. No runtime events exist for this skill, so nothing here claims it has run.</p>`,
    foot: `
      <button class="btn grow" data-act="matrix-export" data-name="${esc(name)}">${icon('download', 15)} Export</button>
      <button class="btn grow primary" data-act="matrix-open-skill" data-id="${esc(skill.id)}">${icon('skill', 15)} Open skill</button>`,
  });
}

function edgeSheet(id) {
  const s = getState();
  const rel = (s.relations || []).find((r) => r.id === id);
  if (!rel) return;
  const t = REL_TYPES[rel.type] || REL_TYPES.related_to;
  openSheet({
    title: `${esc(t.label)}`,
    body: `
      <div class="card">
        <div class="kv"><span class="k">From</span><span class="strong mono">${esc(rel.from)}</span></div>
        <div class="kv"><span class="k">To</span><span class="strong mono">${esc(rel.to)}</span></div>
        <div class="kv"><span class="k">Type</span><span class="strong">${esc(t.label)}</span></div>
        <div class="kv"><span class="k">Direction</span><span class="strong">${t.marker ? 'directed' : 'undirected'}</span></div>
      </div>
      <p class="small" style="margin-top:10px">${esc(t.hint)}</p>
      <p class="tiny muted">Configuration edge only — it does not mean the target ran or will run.</p>`,
    foot: `<button class="btn grow danger" data-act="matrix-remove" data-id="${esc(rel.id)}">${icon('trash', 15)} Remove link</button>`,
  });
}

function addSheet(presetFrom = '') {
  const s = getState();
  const names = (s.skills || []).map((k) => k.name);
  openSheet({
    title: 'Add a relationship',
    body: `
      <div class="field"><label for="mx-from">From skill</label>
        <select class="input" id="mx-from">
          ${names.map((n) => `<option ${presetFrom === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label for="mx-type">Relationship</label>
        <select class="input" id="mx-type">
          ${REL_TYPE_IDS.map((id) => `<option value="${id}">${esc(REL_TYPES[id].label)} — ${esc(REL_TYPES[id].hint)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label for="mx-to">To skill</label>
        <select class="input" id="mx-to">
          ${names.map((n) => `<option>${esc(n)}</option>`).join('')}
        </select>
      </div>
      <div class="mx-note">${icon('shield', 14)}<div>Valid, low-risk links save immediately with a version bump and can be undone. Cycles, duplicates and self-links are rejected; permission expansion is never caused by a link.</div></div>
      <div id="mx-add-error" class="tiny" style="color:var(--danger);margin-top:8px"></div>`,
    foot: `<button class="btn grow primary" data-act="matrix-add-go">${icon('link', 15)} Add link</button>`,
  });
}

/* =========================================================================================
 * Actions
 * =======================================================================================*/
const rerender = () => import('./main.js').then((m) => m.rerender()).catch(() => {});

/* Shortcuts used by the Skills Hub: the header icon and the one inside every skill drawer. */
on('goto-matrix', () => {
  import('./shell.js').then((m) => m.closeAllSheets());
  import('./main.js').then((m) => m.navigate('matrix'));
});
on('matrix-open-node', (el, ds) => {
  import('./shell.js').then((m) => m.closeAllSheets());
  import('./main.js').then((m) => {
    m.navigate('matrix');
    setTimeout(() => nodeSheet(ds.name), 80);
  });
});

on('matrix-node', (el, ds) => nodeSheet(ds.name));
on('matrix-edge', (el, ds) => edgeSheet(ds.id));
on('matrix-open-skill', (el, ds) => {
  import('./shell.js').then((m) => {
    m.closeAllSheets();
    import('./views2.js').then((v) => v.openSkillDrawer?.(ds.id));
  });
});
on('matrix-add-open', (el, ds) => addSheet(ds.from || ''));
on('matrix-add-go', () => {
  const sheet = document.querySelector('.sheet.open');
  if (!sheet) return;
  const from = sheet.querySelector('#mx-from').value;
  const to = sheet.querySelector('#mx-to').value;
  const type = sheet.querySelector('#mx-type').value;
  const out = addRelationship(from, to, type);
  if (!out.ok) {
    const box = sheet.querySelector('#mx-add-error');
    if (box) box.textContent = out.errors.join(' ');
    toast(out.errors[0], 'bad');
    return;
  }
  import('./shell.js').then((m) => m.closeAllSheets());
  toast(out.warnings.length ? out.warnings[0] : 'Link saved (version bumped)', out.warnings.length ? 'warn' : 'ok');
  rerender();
});
on('matrix-remove', (el, ds) => {
  const out = removeRelationship(ds.id);
  if (!out.ok) return;
  import('./shell.js').then((m) => m.closeAllSheets());
  toast('Link removed — undo available in the matrix', 'ok');
  rerender();
});
on('matrix-undo', () => {
  const out = undoMatrix();
  toast(out.ok ? `Rolled back “${out.action}”` : out.errors[0], out.ok ? 'ok' : 'bad');
  rerender();
});
on('matrix-zoom', (el, ds) => {
  if (ds.dir === 'reset') VIEW.zoom = 1;
  else if (ds.dir === 'in') VIEW.zoom = Math.min(2, Math.round((VIEW.zoom + 0.15) * 100) / 100);
  else VIEW.zoom = Math.max(0.6, Math.round((VIEW.zoom - 0.15) * 100) / 100);
  rerender();
});
on('matrix-filter', (el, ds) => {
  if (VIEW.filter.has(ds.type)) VIEW.filter.delete(ds.type);
  else VIEW.filter.add(ds.type);
  rerender();
});
on('matrix-export', (el, ds) => {
  import('./skillsImport.js').then((m) => {
    const pkg = m.buildPackage([ds.name]);
    const json = m.packageToJson(pkg);
    try {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${String(ds.name).replace(/[^a-z0-9._-]+/gi, '_')}.skill.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast(`Exported ${ds.name} (${pkg.relations.length} links, no secrets)`, 'ok');
    } catch {
      toast('Export unavailable in this browser', 'bad');
    }
  });
});

if (typeof document !== 'undefined') {
  document.addEventListener('input', (e) => {
    const t = e.target.closest('[data-mx="query"]');
    if (!t) return;
    VIEW.query = t.value;
    const canvas = document.getElementById('mx-canvas');
    if (canvas) canvas.innerHTML = graphHTML() + listHTML(); // the input sits outside the canvas, so focus and caret survive
  });
}
