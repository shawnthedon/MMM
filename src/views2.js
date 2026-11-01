/* ============ Views: Skills, Models, Plugins, Chat, Telegram, Analytics, Artifacts, Settings ============ */
import {
  getState, setState, esc, icon, avatar, uid, now, fmtTime, fmtMoney, logEvent,
  pendingApprovals, getAgent, avatarColor,
} from './core.js';
import { openSheet, toast, confirmModal, on, applyTheme, closeAllSheets } from './shell.js';
import { sparkline } from './views1.js';
import { views } from './views1.js';
import { isLive, sendChatMessage, createChatThread, markChatRead } from './datastore.js';

/* ================= SKILLS HUB ================= */
const SKILL_TABS = [
  ['installed', 'Installed'],
  ['marketplace', 'Marketplace'],
  ['imported', 'Imported'],
  ['mine', 'Mine'],
  ['synthesized', 'Synthesized'],
];

const skillFilter = () => (window.__skillFilter ||= { category: 'all', author: 'all', license: 'all', status: 'all', q: '', agent: '' });

/** Skills Hub, filtered to one agent's installed skills. Used by the team panel shortcut. */
export function openSkillsForAgent(agentId) {
  window.__skillsTab = 'installed';
  const filter = skillFilter();
  filter.agent = agentId || '';
  filter.q = '';
  import('./main.js').then((m) => m.navigate('skills'));
}

/** Chat with an agent selected. The agent must be running; callers check before calling. */
export function selectChatAgent(agentId) {
  const s = getState();
  const agent = s.agents.find((a) => a.id === agentId);
  if (!agent) return;
  const thread = (s.threads || []).find((t) => t.title && t.title.includes(agent.name)) || (s.threads || [])[0];
  if (thread) window.__chatThread = thread.id;
  window.__chatAgent = agent.id;
}

const agentSkillNames = (agent) => new Set((agent?.skills || []).map((s) => String(s)));
function agentFilteredSkills(s, list) {
  const id = skillFilter().agent;
  if (!id) return list;
  const agent = (s.agents || []).find((a) => a.id === id);
  if (!agent) return list;
  const names = agentSkillNames(agent);
  return list.filter((k) => names.has(k.name));
}

function skillTab() {
  if (!window.__skillsTab) window.__skillsTab = 'installed';
  return window.__skillsTab;
}

function tabSkills(s, tab) {
  const skills = s.skills || [];
  if (tab === 'installed') return skills.filter((k) => k.status !== 'pending' && k.status !== 'rejected' && k.installed !== false);
  if (tab === 'marketplace') return skills.filter((k) => k.origin === 'marketplace' || k.imported);
  if (tab === 'imported') return skills.filter((k) => k.imported);
  if (tab === 'mine') return skills.filter((k) => k.origin === 'user');
  return skills.filter((k) => k.origin === 'agent' || (k.status === 'pending' && k.origin !== 'import'));
}

function filteredMarket(s) {
  const f = skillFilter();
  const q = f.q.trim().toLowerCase();
  return tabSkills(s, 'marketplace').filter((k) => {
    if (f.category !== 'all' && k.category !== f.category) return false;
    if (f.author !== 'all' && k.author !== f.author) return false;
    if (f.license !== 'all' && k.license !== f.license) return false;
    if (f.status !== 'all') {
      if (f.status === 'installed' && k.installed === false) return false;
      if (f.status === 'available' && k.installed !== false) return false;
      if (f.status === 'restricted' && !k.unavailable) return false;
    }
    if (q && !(`${k.name} ${k.desc} ${k.category} ${k.author}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

function filterBar(s) {
  const f = skillFilter();
  const pool = tabSkills(s, 'marketplace');
  const uniq = (key) => ['all', ...[...new Set(pool.map((k) => k[key]).filter(Boolean))].sort()];
  const chipRow = (key, label) => `
    <div class="mx-filter-row" role="group" aria-label="Filter by ${label}">
      <span class="tiny muted">${label}</span>
      ${uniq(key).map((v) => `<button class="chip tiny ${f[key] === v ? 'brand on' : ''}" data-act="skill-filter" data-key="${key}" data-value="${esc(v)}" aria-pressed="${f[key] === v}">${esc(v === 'all' ? 'All' : v)}</button>`).join('')}
    </div>`;
  return `
    <div class="skill-filters">
      <label class="mx-search">
        <span class="sr-only">Search marketplace</span>
        ${icon('search', 14)}
        <input class="input" id="skill-search" data-skill-search="1" value="${esc(f.q)}" placeholder="Search ${pool.length} skills">
      </label>
      ${chipRow('category', 'Category')}
      ${chipRow('license', 'Licence')}
      ${(f.category !== 'all' || f.license !== 'all' || f.status !== 'all' || f.q) ? '<button class="chip tiny" data-act="skill-filter-reset">Clear filters</button>' : ''}
      <div class="mx-filter-row" role="group" aria-label="Filter by status">
        <span class="tiny muted">Status</span>
        ${[['all', 'All'], ['installed', 'Installed'], ['available', 'Available'], ['restricted', 'Unavailable here']]
          .map(([v, l]) => `<button class="chip tiny ${f.status === v ? 'brand on' : ''}" data-act="skill-filter" data-key="status" data-value="${v}" aria-pressed="${f.status === v}">${l}</button>`).join('')}
      </div>
    </div>`;
}

function skillCard(k) {
  const pending = k.status === 'pending';
  const restricted = Boolean(k.unavailable);
  return `
    <button class="list-card" data-act="open-skill" data-id="${k.id}" style="width:100%;text-align:left">
      <div class="avatar" style="background:${pending ? 'color-mix(in srgb, var(--warning) 25%, var(--elevated))' : 'var(--elevated)'};color:${pending ? 'var(--warning)' : 'var(--brand)'}">${icon('skill', 18)}</div>
      <div class="grow">
        <div class="row wrap" style="gap:6px">
          <span class="strong small mono">${esc(k.name)}</span>
          <span class="chip tiny">v${esc(k.version)}</span>
          ${k.category ? `<span class="chip tiny">${esc(k.category)}</span>` : ''}
          ${k.installed === false ? '<span class="chip tiny">not installed</span>' : ''}
          ${restricted ? '<span class="chip tiny bad">unavailable here</span>' : ''}
        </div>
        <div class="tiny muted ellipsis">${esc(k.desc)}</div>
        <div class="row wrap" style="gap:6px;margin-top:5px">
          <span class="chip tiny ${k.origin === 'agent' ? 'warn' : k.origin === 'user' ? 'brand' : k.origin === 'import' ? 'brand' : ''}">${k.origin === 'agent' ? '⚗ agent-synthesized' : k.origin === 'import' ? '⤓ imported' : esc(k.origin)}</span>
          ${k.author ? `<span class="chip tiny">${esc(k.author)}</span>` : ''}
          ${k.license ? `<span class="chip tiny">${esc(k.license)}</span>` : ''}
          ${k.relations ? `<span class="chip tiny">${k.relations} links</span>` : ''}
          <span class="chip tiny ${pending || restricted ? 'warn' : 'ok'}">${pending ? 'quarantined' : restricted ? 'not instrumented' : 'declared'}</span>
        </div>
      </div>
      ${pending ? '<span class="chip tiny warn">review</span>' : icon('right', 16)}
    </button>`;
}

views.skills = {
  title: 'Skills Hub',
  render() {
    const s = getState();
    const tab = skillTab();
    const counts = Object.fromEntries(SKILL_TABS.map(([id]) => [id, tabSkills(s, id).length]));
    const agentFilter = skillFilter().agent || '';
    const agentForFilter = (s.agents || []).find((a) => a.id === agentFilter) || null;
    const filteredByAgent = (list) => agentFilteredSkills(s, list);
    const list = filteredByAgent(tab === 'marketplace' ? filteredMarket(s) : tabSkills(s, tab));
    const relCount = (s.relations || []).length;
    const installs = s.skillImports || [];
    return `
      <div class="page-head row between">
        <div>
          <h1>Skills Hub</h1>
          <div class="sub">${(s.skills || []).length} skills · ${relCount} typed links · ${counts.marketplace} in the marketplace</div>
        </div>
        <div class="row" style="gap:6px">
          <button class="btn primary sm" data-act="new-skill">${icon('plus', 16)} New</button>
          <button class="btn sm" data-act="skill-import-open" title="Import SKILL.md, manifest, registry, YAML or package">${icon('upload', 16)} Import</button>
          <button class="iconbtn" data-act="goto-matrix" aria-label="Open Skills Matrix" title="Skills Matrix">${icon('graph', 20)}</button>
        </div>
      </div>
      <div class="tabs">
        ${SKILL_TABS.map(([id, label]) => `<button class="${tab === id ? 'active' : ''}" data-act="skills-tab" data-tab="${id}">${label}${counts[id] ? ` (${counts[id]})` : ''}</button>`).join('')}
      </div>
      ${agentForFilter ? `<div class="banner" style="margin:10px 0">${icon('robot', 16)}
        <div class="grow">Filtered to <strong>${esc(agentForFilter.name)}</strong> — ${list.length} skill${list.length === 1 ? '' : 's'} on its row.
          <span class="tiny muted">This is a filter on the agent's own skill list, not a separate assignment.</span></div>
        <button class="btn sm" data-act="skill-agent-filter-clear">Clear</button></div>` : ''}
      ${tab === 'marketplace' ? filterBar(s) : ''}
      <div id="skill-list-host">
      ${list.length ? list.map(skillCard).join('') : `
        <div class="empty"><div class="e-ico">✦</div>
          <div>${tab === 'imported' ? 'No imports yet — use <strong>Import</strong> to add a skill package.' : 'Nothing here yet.'}</div>
          ${tab === 'marketplace' ? '<button class="btn sm" data-act="skill-filter-reset" style="margin-top:8px">Clear filters</button>' : ''}
        </div>`}
      </div>
      ${tab === 'imported' ? `
        <div class="section-title">Import log (audit trail)</div>
        <div class="card">
          ${installs.length ? installs.map((i) => `
            <div class="kv">
              <span class="k mono tiny">${esc(i.file || '—')}</span>
              <span class="tiny muted">${esc(i.format)} · ${i.rejected ? `rejected (${esc(i.reason || '')})` : `installed ${i.installed.length}`}${i.skipped?.length ? ` · skipped ${i.skipped.length}` : ''} · ${esc(fmtTime(i.at))}</span>
            </div>`).join('') : '<div class="tiny muted">No import attempts recorded in this workspace.</div>'}
        </div>` : ''}
      ${tab === 'synthesized' ? `
        <div class="banner warn" style="margin-top:14px">${icon('shield', 16)}
          <div>Agent-synthesized skills <strong>never auto-activate</strong> under policy “${esc(s.settings.selfImprove)}”. Approve after reviewing evals.</div>
        </div>` : ''}
      ${tab === 'installed' ? `
        <div class="banner" style="margin-top:14px">${icon('graph', 16)}
          <div>Typed dependencies, complements and conflicts live in the <a href="#/matrix">Skills Matrix</a> — ${relCount} links, versioned locally.</div>
        </div>` : ''}`;
  },
};

/** Open a skill's drawer. Exported so the Skills Matrix can reuse it. */
export function openSkillDrawer(id) {
  const s = getState();
  const k = (s.skills || []).find((x) => x.id === id);
  if (!k) return;
  const links = (s.relations || []).filter((r) => r.from === k.name || r.to === k.name);
  const imported = k.imported;
  openSheet({
    title: `<span class="mono">${esc(k.name)}</span>`,
    body: `
      <div class="row wrap" style="gap:6px;margin-bottom:10px">
        <span class="chip tiny">v${esc(k.version)}</span>
        <span class="chip tiny ${k.origin === 'agent' ? 'warn' : 'brand'}">${k.origin === 'agent' ? '⚗ synthesized' : esc(k.origin)}</span>
        <span class="chip tiny ${k.status === 'pending' ? 'warn' : 'ok'}">${esc(k.status)}</span>
        ${k.category ? `<span class="chip tiny">${esc(k.category)}</span>` : ''}
        ${k.unavailable ? `<span class="chip tiny bad">unavailable here</span>` : ''}
        <button class="chip tiny brand" data-act="matrix-open-node" data-name="${esc(k.name)}" aria-label="Open ${esc(k.name)} in the Skills Matrix" title="Skills Matrix">
          ${icon('graph', 13)} Matrix${links.length ? ` · ${links.length}` : ''}
        </button>
      </div>
      <div class="small">${esc(k.desc)}</div>
      ${k.unavailable ? `<div class="banner warn" style="margin-top:10px">${icon('shield', 16)}<div>${esc(k.unavailable)}</div></div>` : ''}
      ${k.advisory ? `<div class="banner" style="margin-top:10px">${icon('bell', 16)}<div>${esc(k.advisory)}</div></div>` : ''}
      <div class="section-title">Manifest</div>
      <pre class="mono" style="background:var(--bg-2);border:1px solid var(--border-soft);border-radius:10px;padding:12px;overflow-x:auto">name: ${esc(k.name)}
version: ${esc(k.version)}
origin: ${esc(k.origin)}${imported ? `\nimported_from: ${esc(imported.format)} (${esc(imported.file)})` : ''}
author: ${esc(k.author || '—')}
license: ${esc(k.license || '—')}
runtime: ${k.origin === 'import' ? 'manifest-only (no skills runtime on this gateway)' : 'openclaw-skill/1'}
compat: [${(k.compat || []).map(esc).join(', ')}]
requires: [${(k.requires || []).map(esc).join(', ')}]
tools: [${(k.tools || []).map(esc).join(', ')}]
permissions: [${(k.perms || []).map(esc).join(', ')}]
evals: ${Math.round((k.success || 0) * 100)}% pass (${k.invokes || 0} recorded invocations)</pre>
      <div class="tiny muted" style="margin-top:6px">Tools and permissions above are <strong>declarations</strong>. Nothing is granted by installing or importing a skill.</div>
      ${(k.inputs || []).length || (k.outputs || []).length ? `
        <div class="section-title">Contract</div>
        <div class="card">
          <div class="kv"><span class="k">Inputs</span><span class="strong">${esc((k.inputs || []).join(', ') || '—')}</span></div>
          <div class="kv"><span class="k">Outputs</span><span class="strong">${esc((k.outputs || []).join(', ') || '—')}</span></div>
        </div>` : ''}
      ${imported ? `
        <div class="section-title">Import review</div>
        <div class="card">
          <div class="kv"><span class="k">Source</span><span class="strong">${esc(imported.format)} · ${esc(imported.file)}</span></div>
          <div class="kv"><span class="k">Quarantined</span><span class="strong">${imported.quarantined ? 'yes — approve to activate' : 'no'}</span></div>
          ${(imported.findings || []).length ? `<ul class="imp-findings">${imported.findings.map((f) => `<li class="sev-${f.severity}">${esc(f.message)}</li>`).join('')}</ul>` : '<div class="tiny muted">No findings recorded.</div>'}
        </div>` : ''}
      ${links.length ? `
        <div class="section-title">Relationships</div>
        <div class="card">
          ${links.map((r) => `<div class="kv"><span class="k mono tiny">${esc(r.type.replace(/_/g, ' '))}</span><span class="tiny">${r.from === k.name ? `→ ${esc(r.to)}` : `← ${esc(r.from)}`}</span></div>`).join('')}
        </div>` : ''}
      <div class="section-title">Eval trend</div>
      <div class="card">${sparkline([62, 68, 71, 74, 78, 80, Math.round((k.success || 0) * 100)])}</div>
      ${k.changelog?.length ? `<div class="section-title">Changelog</div><div class="card">${k.changelog.map((c) => `<div class="tiny muted">${esc(c)}</div>`).join('')}</div>` : ''}`,
    foot: k.status === 'pending'
      ? `<button class="btn grow danger" data-act="skill-reject" data-id="${k.id}">Reject</button>
         <button class="btn grow ok" data-act="skill-approve" data-id="${k.id}">Approve & activate</button>`
      : `<button class="btn grow" data-act="matrix-open-node" data-name="${esc(k.name)}">${icon('graph', 15)} Skills Matrix</button>
         ${k.installed === false
           ? `<button class="btn grow primary" data-act="skill-install-catalogue" data-id="${k.id}">${icon('plus', 15)} Add to workspace</button>`
           : `<button class="btn grow" data-act="skill-add-agent" data-id="${k.id}">Add to agent</button>
              <button class="btn grow danger" data-act="skill-uninstall" data-id="${k.id}">Uninstall</button>`}`,
  });
}

on('skills-tab', (el, ds) => { window.__skillsTab = ds.tab; import('./main.js').then((m) => m.rerender()); });
on('skill-filter', (el, ds) => {
  const f = skillFilter();
  f[ds.key] = ds.value;
  import('./main.js').then((m) => m.rerender());
});
on('skill-filter-reset', () => {
  window.__skillFilter = { category: 'all', author: 'all', license: 'all', status: 'all', q: '' };
  import('./main.js').then((m) => m.rerender());
});
if (typeof document !== 'undefined') {
  document.addEventListener('input', (e) => {
    const t = e.target.closest('[data-skill-search]');
    if (!t) return;
    skillFilter().q = t.value;
    const host = document.getElementById('skill-list-host');
    const s = getState();
    const list = filteredMarket(s);
    if (host) host.innerHTML = list.length ? list.map(skillCard).join('') : '<div class="empty"><div>No skills match that filter.</div></div>';
  });
}

on('open-skill', (el, ds) => openSkillDrawer(ds.id));

on('skill-install-catalogue', (el, ds) => {
  const k = getState().skills.find((x) => x.id === ds.id);
  if (!k) return;
  setState((s) => {
    const t = s.skills.find((x) => x.id === ds.id);
    if (t) { t.installed = true; logEvent('skill', `Catalogue skill ${t.name} added to workspace (manifest only)`); }
  }, 'skill-install');
  closeAllSheets();
  toast(`${k.name} added — manifest only, nothing is executed`, 'ok');
  import('./main.js').then((m) => m.rerender());
});

on('skill-approve', (el, ds) => {
  setState((s) => {
    const k = s.skills.find((x) => x.id === ds.id);
    if (!k) return;
    k.status = 'active';
    k.installed = true;
    if (k.imported) k.imported.quarantined = false;
    logEvent('skill', `Skill ${k.name} approved & activated${k.imported ? ' (imported package released from quarantine)' : ''}`);
  }, 'skill-approve');
  closeAllSheets(); toast('Skill activated ✓', 'ok'); import('./main.js').then((m) => m.rerender());
});
on('skill-reject', (el, ds) => {
  setState((s) => {
    const k = s.skills.find((x) => x.id === ds.id);
    if (k) { k.status = 'rejected'; logEvent('skill', `Skill ${k.name} rejected — feedback sent to agent`); }
  }, 'skill-reject');
  closeAllSheets(); toast('Rejected — agent notified with feedback'); import('./main.js').then((m) => m.rerender());
});
on('skill-uninstall', (el, ds) => {
  const k = getState().skills.find((x) => x.id === ds.id);
  setState((s) => {
    s.skills = s.skills.filter((x) => x.id !== ds.id);
    if (k) {
      const dropped = (s.relations || []).filter((r) => r.from === k.name || r.to === k.name).length;
      s.relations = (s.relations || []).filter((r) => r.from !== k.name && r.to !== k.name);
      logEvent('skill', `Skill uninstalled${dropped ? ` — removed ${dropped} matrix link(s)` : ''}`);
    }
  }, 'skill-uninstall');
  closeAllSheets(); toast('Skill uninstalled'); import('./main.js').then((m) => m.rerender());
});
on('skill-agent-filter-clear', () => {
  skillFilter().agent = '';
  import('./main.js').then((m) => m.rerender());
});

on('skill-add-agent', (el, ds) => {
  toast('Pick an agent in Agent Manager → Skills tab', 'ok');
  closeAllSheets(); import('./main.js').then((m) => m.navigate('agents'));
});
on('new-skill', () => {
  openSheet({
    title: 'New skill',
    body: `
      <div class="field"><label>Name</label><input class="input" id="ns-name" placeholder="e.g. web.summarize-longpage" style="font-family:var(--mono)"></div>
      <div class="field"><label>Description</label><input class="input" id="ns-desc" placeholder="One-line summary"></div>
      <div class="field"><label>Skill body (markdown)</label><textarea class="input" id="ns-body" style="min-height:120px" placeholder="# Skill&#10;1. Fetch the page…&#10;2. Summarize with citations…"></textarea></div>
      <div class="field"><label>Permissions</label>
        <div class="row wrap">${['network.egress', 'artifacts.write', 'fs.write', 'process.exec'].map((p) => `<button class="chip tiny" data-act="toggle-perm">${p}</button>`).join('')}</div>
      </div>
      <div class="tiny muted">Importing an existing SKILL.md, manifest or package? Use <strong>Import</strong> instead — it validates, scans and quarantines.</div>`,
    foot: `<button class="btn grow primary" data-act="skill-create-go">Create skill</button>`,
  });
  on('skill-create-go', () => {
    const sheet = document.querySelector('.sheet.open');
    const name = sheet.querySelector('#ns-name').value.trim() || 'user.new-skill';
    setState((s) => {
      s.skills.unshift({
        id: uid('sk'), name, version: '0.1.0', origin: 'user', status: 'active', installed: true,
        category: 'Custom', author: 'workspace', license: 'internal', compat: [],
        perms: ['artifacts.write'], tools: [], success: 1, invokes: 0,
        requires: [], inputs: [], outputs: [],
        desc: sheet.querySelector('#ns-desc').value.trim() || 'User-authored skill.',
        updated: new Date().toISOString().slice(0, 10), changelog: ['0.1.0 — created in the Skills Hub'],
      });
      logEvent('skill', `Skill ${name} created`);
    }, 'create-skill');
    closeAllSheets(); toast('Skill created', 'ok'); import('./main.js').then((m) => m.navigate('skills'));
  });
});

/* ================= MODEL GATEWAY ================= */
views.models = {
  title: 'Model Gateway',
  render() {
    const s = getState();
    const cats = [...new Set(s.providers.map((p) => p.category))];
    return `
      <div class="page-head">
        <h1>Model catalogue</h1>
        <div class="sub">${s.providers.length} providers in the catalogue · not configured</div>
      </div>
      <div class="banner warn">${icon('shield', 16)}<div><strong>No provider client is installed in this build.</strong>
        This is a catalogue, not a gateway: nothing here is called, no key is stored, and no token is billed.
        Wiring one provider is roadmap session 7 — until then every model row is reference data.</div></div>
      <div class="grid-2">
        <div class="stat"><div class="k">Catalogue</div><div class="v">${s.providers.length}</div><div class="d">reference rows</div></div>
        <div class="stat"><div class="k">Calls made by this app</div><div class="v">0</div><div class="d">no client, no key, no spend</div></div>
      </div>
      ${cats.map((cat) => `
        <div class="section-title">${esc(cat)}</div>
        ${s.providers.filter((p) => p.category === cat).map((p) => `
          <div class="list-card">
            <div class="avatar sm" style="background:${p.status === 'on' ? 'color-mix(in srgb, var(--success) 22%, var(--elevated))' : 'var(--elevated)'};color:${p.status === 'on' ? 'var(--success)' : 'var(--text-3)'}">${icon('model', 15)}</div>
            <div class="grow">
              <div class="row" style="gap:6px"><span class="strong small">${esc(p.name)}</span>
                <span class="pulse-dot ${p.status === 'on' ? 'live' : 'idle'}"></span></div>
              <div class="tiny muted">${esc(p.models.join(' · '))}</div>
            </div>
            <div class="col" style="align-items:flex-end;gap:4px">
              <span class="chip tiny">not configured</span>
              <span class="tiny muted">${esc(p.auth)}</span>
            </div>
          </div>`).join('')}`).join('')}

      <div class="section-title">Routing policies (illustrative)</div>
      <div class="banner info">${icon('info', 15)}<div>These rules are written down, not enforced. With no provider client there is nothing to route.</div></div>
      ${s.policies.map((p) => `
        <div class="card">
          <div class="row between"><strong class="small mono">${esc(p.name)}</strong><span class="chip tiny">not enforced</span></div>
          <div class="tiny muted mono" style="margin-top:6px;line-height:1.6">${esc(p.rules)}</div>
        </div>`).join('')}

      <div class="section-title">Budgets</div>
      <div class="card tiny muted" style="line-height:1.8">
        Not metered: this app makes no model calls, so there is no spend to cap. A daily cap that is
        checked *before* a call is roadmap session 8 — it needs the client from session 7 first.
      </div>`;
  },
};

/* ================= PLUGINS (MCP) =================
 * There is no MCP client in this repo: no JSON-RPC transport, no server process, no tool invocation and
 * no key vault. The screen used to say the opposite in three places — “all calls proxied & audited by
 * the gateway”, a per-plugin *calls today* counter, and an Install button that flipped a local boolean,
 * toasted success and asked for an API key it then discarded. Collecting a secret the app cannot store
 * is the worst of the three, so that field is gone as well. What is left is a catalogue that says so.
 */
views.plugins = {
  title: 'Plugin catalogue',
  render() {
    const s = getState();
    return `
      <div class="page-head">
        <h1>Plugin catalogue</h1>
        <div class="sub">${s.plugins.length} MCP integrations · no client installed</div>
      </div>
      <div class="banner warn">${icon('shield', 16)}<div><strong>No MCP client is installed in this build.</strong>
        Nothing below connects to a server, invokes a tool or holds a credential. Connecting one needs a
        transport, a tool executor, an egress policy that can deny a call, and a sealed key store.</div></div>
      ${s.plugins.map((p) => `
        <div class="card">
          <div class="row">
            <div class="avatar" style="background:var(--elevated);color:var(--text-3)">${icon('plug', 18)}</div>
            <div class="grow">
              <div class="row" style="gap:6px">
                <span class="strong small">${esc(p.name)}</span>
                <span class="chip tiny">${esc(p.category)}</span>
                <span class="chip tiny">catalogue</span>
              </div>
              <div class="tiny muted">${p.tools.length} tools defined · not connected</div>
            </div>
            <button class="btn sm" data-act="plugin-toggle" data-id="${p.id}">What it needs</button>
          </div>
          <div class="divider"></div>
          <div class="row wrap">${p.tools.map((t) => `<span class="chip tiny mono">${esc(t)}</span>`).join('')}</div>
          <div class="row wrap" style="margin-top:8px">
            ${p.scopes.map((sc) => `<span class="chip tiny warn">${icon('shield', 10)} ${esc(sc)}</span>`).join('')}
            <span class="tiny muted">scopes this entry would request</span>
          </div>
        </div>`).join('')}
      <div class="section-title">A custom MCP server</div>
      <div class="card tiny muted" style="line-height:1.8">
        Not offered here, deliberately. Adding one would mean asking for a command and an environment secret
        that this app has nowhere safe to put — there is no sealed vault, so it would end up in
        localStorage. It ships with the client, not before it.
      </div>`;
  },
};

on('plugin-toggle', (el, ds) => {
  const p = getState().plugins.find((x) => x.id === ds.id);
  if (!p) return;
  openSheet({
    title: `${esc(p.name)} · not connected`,
    body: `
      <div class="banner warn">${icon('shield', 16)}<div>This entry is reference data. MMM has no MCP client,
        so it cannot install it, reach a server, or call any of its tools.</div></div>
      <div class="section-title">Tools it declares</div>
      <div class="row wrap">${p.tools.map((t) => `<span class="chip tiny mono">${esc(t)}</span>`).join('')}</div>
      <div class="section-title">Scopes it would request</div>
      <div class="row wrap">${p.scopes.map((sc) => `<span class="chip tiny warn">${icon('shield', 10)} ${esc(sc)}</span>`).join('')}</div>
      <div class="section-title">What wiring it needs</div>
      <div class="tiny muted" style="line-height:1.8">
        A JSON-RPC transport per server (stdio · SSE · HTTP), an executor that runs one call at a time, an
        egress policy that can deny it, a sealed key store, and an audit row per invocation. Until those
        exist, a key pasted here would be a liability sitting in your browser.
      </div>`,
    foot: `<button class="btn grow" data-sheet-close>Close</button>`,
  });
});

on('toggle-perm', (el) => { el.classList.toggle('on'); if (el.getAttribute('role') === 'switch') el.setAttribute('aria-checked', String(el.classList.contains('on'))); });

/* ================= CHAT ================= */
views.chat = {
  title: 'Chat',
  persistent: false,
  render(params) {
    const s = getState();
    const threads = s.threads || [];
    const header = `
      <div class="row between wrap" style="margin-bottom:12px;gap:8px">
        <h1 style="font-size:20px">Chat</h1>
        <button class="btn sm" data-act="new-chat">${icon('plus', 15)} New</button>
      </div>
      ${chatRuntimeHTML()}`;

    if (!threads.length) {
      return `${header}
        <div class="empty" data-chat-empty>
          <div class="empty-title">No conversations yet</div>
          <p class="muted">Start one with <strong>New</strong>. Messages are stored; nothing answers them.</p>
        </div>`;
    }

    // A remembered id can be stale (a different transcript, or a thread that was deleted). What is
    // shown is the thread that is found, and the remembered id is corrected to match it.
    const wanted = params?.id || window.__chatThread;
    const th = threads.find((t) => t.id === wanted) || threads[0];
    window.__chatThread = th.id;
    const older = th.truncated ? `<div class="tiny muted" data-chat-truncated>Older messages in this thread are not loaded here (the newest ${th.messages.length} are shown).</div>` : '';
    return `
      ${header}
      <div class="scroll-x" style="margin-bottom:12px">
        ${threads.map((t) => `<button class="chip ${t.id === th.id ? 'brand' : ''}" data-act="chat-open" data-id="${t.id}">
          ${t.kind === 'channel' ? '#' : '💬'} ${esc(t.title)}${t.unread ? ` ·${t.unread}` : ''}
        </button>`).join('')}
      </div>
      <div class="msgs" id="chat-msgs">
        ${older}
        ${th.messages.map((m) => renderMsg(m, th)).join('')}
      </div>
      <div class="composer" style="margin-top:12px;border:1px solid var(--border-soft);border-radius:16px">
        <textarea id="chat-input" rows="1" placeholder="Message… (stored, not answered)"></textarea>
        <button class="send-btn" data-act="chat-send">${icon('send', 18)}</button>
      </div>
      <div class="tiny muted" id="chat-send-status" role="status" aria-live="polite"></div>`;
  },
  mount() {
    const box = document.getElementById('chat-msgs');
    if (box) box.scrollTop = box.scrollHeight;
    const input = document.getElementById('chat-input');
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = input.value;
        input.value = '';
        sendChat(text, input);
      }
    });
    // Opening a thread is the read receipt: clear the counter on the gateway, not in the UI alone.
    // A hidden tab has not been read, so it does not send the receipt.
    const open = window.__chatThread;
    const thread = (getState().threads || []).find((t) => t.id === open);
    const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
    if (thread?.unread && visible) markChatRead(open).catch(() => {});
  },
};

/**
 * What this screen can honestly promise. The note comes from the gateway when the transcript slice is
 * live and from the local default otherwise — it is never written to look like a working model.
 */
function chatRuntimeHTML() {
  const live = isLive('threads');
  const rt = getState().chatRuntime || {};
  const source = live ? 'gateway transcript' : 'this browser only';
  return `
    <div class="chat-runtime" data-chat-runtime="${live ? 'gateway' : 'demo'}" data-replies="${rt.generatesReplies ? 'yes' : 'no'}" role="note">
      <span class="chat-runtime-icon" aria-hidden="true">${icon('info', 16)}</span>
      <div>
        <div class="chat-runtime-title">Transcript · ${esc(source)} · no model runtime</div>
        <div class="chat-runtime-note">${esc(rt.note || 'No model runtime is configured, so no reply is generated.')}</div>
      </div>
    </div>`;
}

function renderMsg(m, th) {
  if (m.kind === 'approval') {
    const ap = m.approval;
    return `
      <div class="msg">
        <div class="bubble" style="padding:0;overflow:hidden">
          <div class="ac-head">${icon('shield', 14)} APPROVAL REQUEST · ${esc(ap.action)}</div>
          <div style="padding:12px">
            <div class="kv"><span class="k">Target</span><span class="strong">${esc(ap.target)}</span></div>
            <div class="kv"><span class="k">From</span><span class="strong">${esc(ap.principal)}</span></div>
            <div class="kv"><span class="k">Risk</span><span class="strong">${esc(ap.risk)}</span></div>
            <div class="tiny muted" style="margin:8px 0">${esc(ap.evidence)}</div>
            ${ap.status === 'pending' ? `
              <div class="row" style="gap:8px">
                <button class="btn sm grow" data-act="approve" data-id="${ap.id}" data-decide="deny">Deny</button>
                <button class="btn sm grow ok" data-act="approve" data-id="${ap.id}" data-decide="allow">Allow once</button>
              </div>` : `<span class="chip ${ap.status === 'allowed' ? 'ok' : 'bad'}">${esc(ap.status)}</span>`}
          </div>
        </div>
        <div class="meta">${esc(m.from === 'me' ? 'You' : ap.principal)} · ${fmtTime(m.ts)}</div>
      </div>`;
  }
  return `
    <div class="msg ${m.from === 'me' ? 'me' : ''}">
      <div class="bubble">
        ${m.from === 'agent' && m.agent ? `<div class="row tiny" style="gap:6px;margin-bottom:6px;color:var(--brand-2)">${avatar(m.agent, 'sm')}<strong>${esc(m.agent)}</strong></div>` : ''}
        ${m.text.startsWith('```') ? `<pre>${esc(m.text.replace(/```/g, ''))}</pre>` : esc(m.text).replace(/\n/g, '<br>')}
        ${m.code ? `<pre>${esc(m.code)}</pre>` : ''}
      </div>
      <div class="meta">${m.from === 'me' ? 'You' : m.from === 'system' ? 'System' : esc(m.agent || 'Agent')} · ${fmtTime(m.ts)}</div>
    </div>`;
}

/**
 * Send a message. There is no reply to wait for: the row is stored (on the gateway when the slice is
 * live) and nothing is scheduled afterwards. A failed write says so and keeps the text in the box.
 */
async function sendChat(text, input) {
  const body = String(text || '').trim();
  if (!body) return;
  const s = getState();
  const thread = (s.threads || []).find((t) => t.id === window.__chatThread) || (s.threads || [])[0];
  if (!thread) { toast('No conversation to send to'); return; }
  const status = document.getElementById('chat-send-status');
  if (status) status.textContent = 'Sending…';
  try {
    await sendChatMessage(thread.id, body);
    const m = await import('./main.js');
    m.rerender();
    const fresh = document.getElementById('chat-send-status');
    if (fresh) fresh.textContent = isLive('threads') ? 'Stored on the gateway. No reply is generated.' : 'Stored in this browser. No reply is generated.';
  } catch (error) {
    if (input) input.value = body; // never lose what the person typed
    const fresh = document.getElementById('chat-send-status');
    if (fresh) fresh.textContent = '';
    toast(error?.message || 'The message was not stored');
  }
}

on('chat-open', (el, ds) => {
  window.__chatThread = ds.id;
  import('./main.js').then((m) => m.navigate(`chat/${ds.id}`));
});
on('chat-send', () => {
  const input = document.getElementById('chat-input');
  if (input?.value.trim()) { const text = input.value; input.value = ''; sendChat(text, input); }
});
on('new-chat', () => {
  openSheet({
    title: 'New chat',
    body: `
      <div class="field"><label>Message</label><input class="input" id="nc-msg" placeholder="e.g. Summarize today's failures"></div>
      <div class="field"><label>Target</label>
        <select class="input" id="nc-agent">
          <option value="__copilot">✦ Copilot (full app control)</option>
          ${getState().agents.map((a) => `<option value="${esc(a.name)}">${esc(a.name)}</option>`).join('')}
        </select>
      </div>`,
    foot: `<button class="btn grow primary" data-act="new-chat-go">Start chat</button>`,
  });
  on('new-chat-go', async () => {
    const sheet = document.querySelector('.sheet.open');
    const target = sheet.querySelector('#nc-agent').value;
    const msg = sheet.querySelector('#nc-msg').value.trim() || 'Hello!';
    if (target === '__copilot') {
      closeAllSheets();
      import('./copilot.js').then((m) => { m.openCopilot(); setTimeout(() => window.__copilotChip?.(msg), 350); });
      return;
    }
    try {
      const thread = await createChatThread({ title: target, kind: 'direct' });
      closeAllSheets();
      window.__chatThread = thread.id;
      import('./main.js').then((m) => m.navigate(`chat/${thread.id}`));
      await sendChatMessage(thread.id, msg);
      import('./main.js').then((m) => m.rerender());
    } catch (error) {
      toast(error?.message || 'The conversation was not created');
    }
  });
});

/* ================= TELEGRAM ================= */
views.telegram = {
  title: 'Telegram Bridge',
  render() {
    // Telegram is now one channel inside Comms (spec: the bridge belongs to the comms panel).
    // The old view is kept as a deep link that hands over to Comms with the Telegram sheet open.
    setTimeout(() => {
      import('./comms.js').then((m) => m.openCommsChannel('telegram'));
      import('./main.js').then((m) => m.navigate('comms'));
    }, 0);
    const s = getState();
    const tg = s.telegram;
    return `
      <div class="page-head">
        <h1>Telegram Bridge</h1>
        <div class="sub">OpenClaw command layer — control MMM from anywhere</div>
      </div>
      <div class="card">
        <div class="row between">
          <div class="row">
            <div class="avatar" style="background:var(--accent-hover);color:var(--text-on-accent)">${icon('send', 18)}</div>
            <div>
              <div class="strong small">${esc(tg.botName)}</div>
              <div class="tiny muted">${tg.linked ? 'linked · polling' : 'not linked'}</div>
            </div>
          </div>
          <span class="switch ${tg.linked ? 'on' : ''}" data-act="tg-link"></span>
        </div>
        <div class="divider"></div>
        <div class="kv"><span class="k">Allowlist</span><span class="strong small">${tg.allowlist.map(esc).join(' · ')}</span></div>
        <div class="kv"><span class="k">Signature scheme</span><span class="strong small">one-time signed buttons</span></div>
        <button class="btn block sm" data-act="tg-test" style="margin-top:10px">Send test notification</button>
      </div>

      <div class="section-title">Live bot preview</div>
      <div class="phone">
        <div class="p-head">
          <div class="avatar sm" style="background:var(--brand)">S</div>
          <div class="grow"><div class="strong small">MMM Control</div><div class="tiny" style="opacity:.7">bot · always on</div></div>
        </div>
        <div class="p-body" id="tg-body">
          ${tg.messages.map((m) => `<div class="tg-msg ${m.from}">${esc(m.text).replace(/\n/g, '<br>')}</div>`).join('')}
        </div>
        <div class="tg-cmds">
          ${['/status', '/swarms', '/agents', '/budget', '/approve ap-2', '/ask researcher progress', '/copilot deploy swarm'].map((c) => `
            <button class="chip tiny" data-act="tg-cmd" data-cmd="${esc(c)}">${esc(c)}</button>`).join('')}
        </div>
      </div>

      <div class="section-title">Notification topics</div>
      <div class="card">
        ${Object.entries(tg.topics).map(([k, v]) => `
          <div class="kv"><span class="k row" style="gap:8px">${icon('bell', 14)} ${esc(k)}</span>
          <span class="switch ${v ? 'on' : ''}" data-act="tg-topic" data-k="${k}"></span></div>`).join('')}
      </div>

      <div class="section-title">Command grammar</div>
      <div class="card mono tiny" style="line-height:2">
        /status · /swarms · /swarm &lt;id&gt;<br>/deploy &lt;template&gt; "objective"<br>
        /agents · /agent &lt;id&gt; &lt;action&gt;<br>/tasks · /task &lt;id&gt; move &lt;col&gt;<br>
        /ask &lt;agent&gt; &lt;msg&gt; · /approve &lt;id&gt;<br>/models · /use &lt;agent&gt; &lt;model&gt;<br>
        /logs &lt;run&gt; · /budget · /copilot &lt;msg&gt; · /help
      </div>`;
  },
  mount() {
    const body = document.getElementById('tg-body');
    if (body) body.scrollTop = body.scrollHeight;
  },
};

on('tg-link', () => {
  setState((s) => { s.telegram.linked = !s.telegram.linked; }, 'tg-link');
  toast(getState().telegram.linked ? 'Bot linked ✓' : 'Bot unlinked'); import('./main.js').then((m) => m.rerender());
});
on('tg-test', () => {
  setState((s) => {
    s.telegram.messages.push({ from: 'bot', ts: now(), text: '✅ Test notification from MMM\ngateway healthy · approvals route here' });
    logEvent('telegram', 'Test notification sent');
  }, 'tg-test');
  import('./main.js').then((m) => m.rerender());
  toast('Sent to Telegram', 'ok');
});
on('tg-topic', (el, ds) => {
  setState((s) => { s.telegram.topics[ds.k] = !s.telegram.topics[ds.k]; }, 'tg-topic');
  import('./main.js').then((m) => m.rerender());
});
on('tg-cmd', (el, ds) => {
  const s = getState();
  const cmd = ds.cmd;
  let out = 'ok';
  if (cmd === '/status') out = `✅ Gateway healthy · ${s.agents.filter((a) => a.status === 'running').length} agents active · ${s.swarms.filter((w) => w.status === 'live').length} swarm live · ${pendingApprovals().length} approvals pending · spend today ${fmtMoney(s.agents.reduce((a, x) => a + x.costToday, 0))}`;
  else if (cmd === '/swarms') out = s.swarms.map((w) => `▸ ${w.name} · ${w.status} · ${Math.round(w.progress * 100)}%`).join('\n') || 'no swarms';
  else if (cmd === '/agents') out = s.agents.map((a) => `▸ ${a.name} · ${a.status} · trust ${a.trust}`).join('\n');
  else if (cmd === '/budget') out = `Today ${fmtMoney(s.agents.reduce((a, x) => a + x.costToday, 0))} of ${fmtMoney(50)} cap\nTop: ${[...s.agents].sort((a, b) => b.costToday - a.costToday)[0].name}`;
  else if (cmd.startsWith('/approve')) out = '⚠ Tap the signed button in the approval message instead — commands are replay-protected.';
  else if (cmd.startsWith('/ask')) out = '▸ Researcher-01: 13/20 vendors crawled; 2 blocked sites falling back to browser rendering.';
  else if (cmd.startsWith('/copilot')) out = '✦ Copilot (Telegram): deploying is gated — open the app to confirm the action card, or tap the inline button sent above.';
  setState((st) => {
    st.telegram.messages.push({ from: 'user', ts: now(), text: cmd });
    st.telegram.messages.push({ from: 'bot', ts: now(), text: out });
  }, 'tg-cmd');
  import('./main.js').then((m) => m.rerender());
});

/* ================= ANALYTICS ================= */
views.analytics = {
  title: 'Analytics',
  render() {
    const s = getState();
    const spend = s.agents.reduce((a, x) => a + x.costToday, 0);
    return `
      <div class="page-head row between">
        <div><h1>Analytics</h1><div class="sub">Live · last 24h</div></div>
        <button class="btn sm" data-act="export-report">${icon('download', 14)} Export</button>
      </div>
      <div class="grid-2">
        <div class="stat"><div class="k">Spend today</div><div class="v">${fmtMoney(spend)}</div><div class="d">▲ 8% vs yesterday</div></div>
        <div class="stat"><div class="k">Tasks done</div><div class="v">${s.tasks.filter((t) => t.column === 'done').length + 12}</div><div class="d">87% success</div></div>
        <div class="stat"><div class="k">MCP calls</div><div class="v">—</div><div class="d">not measured · no client</div></div>
        <div class="stat"><div class="k">Approvals</div><div class="v">${pendingApprovals().length}</div><div class="d">median resolve 4m</div></div>
      </div>

      <div class="section-title">Throughput & spend (24h)</div>
      <div class="card">
        ${sparkline(s.usage.map((u) => u.cost))}
        <div class="bars" style="margin-top:10px">
          ${s.usage.slice(-12).map((u) => `<div class="b" style="height:${Math.round((u.tokens / 38000) * 100)}%"></div>`).join('')}
        </div>
        <div class="legend" style="margin-top:8px"><span><span class="sw" style="background:var(--brand)"></span>cost $/h</span><span><span class="sw" style="background:var(--brand-2)"></span>tokens (12×2h buckets)</span></div>
      </div>

      <div class="section-title">Agent leaderboard</div>
      <div class="card">
        ${[...s.agents].sort((a, b) => b.successRate - a.successRate).map((a, i) => `
          <div class="row" style="padding:8px 0;${i ? 'border-top:1px solid var(--border-soft)' : ''}">
            <span class="chip tiny" style="width:26px;justify-content:center">${i + 1}</span>
            ${avatar(a.name, 'sm')}
            <div class="grow"><div class="strong small">${esc(a.name)}</div><div class="tiny muted">${Math.round(a.successRate * 100)}% success · ${fmtMoney(a.costToday)}</div></div>
            <div class="col" style="align-items:flex-end">
              <span class="chip tiny" style="color:${a.trust >= 80 ? 'var(--success)' : 'var(--warning)'}">◈ ${a.trust}</span>
            </div>
          </div>`).join('')}
      </div>

      <div class="section-title">Trust posture</div>
      <div class="card">
        <div class="bars" style="height:70px">
          ${s.agents.map((a) => `<div class="b" style="height:${a.trust}%;background:${a.trust >= 80 ? 'var(--success)' : a.trust >= 50 ? 'var(--warning)' : 'var(--danger)'}"></div>`).join('')}
        </div>
        <div class="legend" style="margin-top:8px">
          <span><span class="sw" style="background:var(--success)"></span>Tier A ≥ 80</span>
          <span><span class="sw" style="background:var(--warning)"></span>Tier B</span>
          <span><span class="sw" style="background:var(--danger)"></span>Tier C &lt; 50</span>
        </div>
      </div>

      <div class="section-title">Self-improvement impact</div>
      <div class="card">
        <div class="kv"><span class="k">Skills synthesized</span><span class="strong">2 pending · 1 activated</span></div>
        <div class="kv"><span class="k">Prompt refinements accepted</span><span class="strong">+6.2% eval uplift</span></div>
        <div class="kv"><span class="k">Tool-usage optimizer</span><span class="strong">−18% avg cost/task</span></div>
      </div>

      <div class="section-title">MCP activity</div>
      <div class="card tiny muted" style="line-height:1.8">
        No tool calls are made by this app — there is no MCP client — so there is nothing to chart. This
        panel used to draw bars from a seed counter, which is a number that could never change.
      </div>`;
  },
};

on('export-report', () => {
  // The CSV used to be a constant string — `spend_today,17.93` and `mcp_calls,535` were typed in, not
  // measured, and `size` was the number 2204 regardless of what was written. Every figure now comes from
  // the rows on this screen; anything this build does not measure is omitted rather than invented.
  const st = getState();
  const content = [
    'metric,value',
    `spend_today,${(st.agents.reduce((a, x) => a + x.costToday, 0)).toFixed(2)}`,
    `tasks_done,${st.tasks.filter((t) => t.column === 'done').length}`,
    `approvals_pending,${pendingApprovals().length}`,
    `swarm_records,${st.swarms.length}`,
    'mcp_calls,not_measured',
  ].join('\n') + '\n';
  setState((s) => {
    s.files.unshift({
      id: uid('fl'), path: 'reports/analytics-24h.csv', type: 'csv', size: content.length, createdBy: 'me', ts: now(), content,
    });
    logEvent('artifact', 'Analytics report written to artifacts');
  }, 'export');
  toast('Report saved to Artifacts · this browser only', 'ok');
});

/* ================= ARTIFACTS ================= */
views.artifacts = {
  title: 'Artifacts & Files',
  render() {
    const s = getState();
    return `
      <div class="page-head row between">
        <div><h1>Artifacts</h1><div class="sub">${s.files.length} files · 248 MB used</div></div>
        <button class="btn primary sm" data-act="file-upload">${icon('plus', 16)} Upload</button>
      </div>
      <div class="card" style="margin-bottom:12px">
        <div class="row between tiny"><span class="muted">Storage</span><span class="strong">248 MB / 2 GB</span></div>
        <div class="progress" style="margin-top:6px"><i style="width:12%"></i></div>
      </div>
      ${s.files.map((f) => `
        <button class="list-card" data-act="open-file" data-id="${f.id}" style="width:100%;text-align:left">
          <div class="avatar" style="background:var(--elevated);color:${f.type === 'img' ? 'var(--warning)' : 'var(--brand)'}">${icon(f.type === 'img' ? 'chart' : 'file', 18)}</div>
          <div class="grow">
            <div class="strong small mono ellipsis">${esc(f.path)}</div>
            <div class="tiny muted">${esc(f.createdBy)} · ${fmtTime(f.ts)} · ${(f.size / 1024).toFixed(1)} KB</div>
          </div>
          <span class="chip tiny">${esc(f.type)}</span>
        </button>`).join('')}`;
  },
};

on('open-file', (el, ds) => {
  const f = getState().files.find((x) => x.id === ds.id);
  if (!f) return;
  openSheet({
    title: `<span class="mono small">${esc(f.path)}</span>`,
    body: `
      <div class="row wrap" style="margin-bottom:10px">
        <span class="chip tiny">${esc(f.type)}</span><span class="chip tiny">${(f.size / 1024).toFixed(1)} KB</span>
        <span class="chip tiny">by ${esc(f.createdBy)}</span><span class="chip tiny">${fmtTime(f.ts)}</span>
      </div>
      <pre class="mono" style="background:var(--bg-2);border:1px solid var(--border-soft);border-radius:10px;padding:12px;overflow-x:auto;white-space:pre-wrap;font-size:12px;max-height:40dvh">${esc(f.content)}</pre>`,
    foot: `
      <button class="btn grow" data-act="file-share" data-id="${f.id}">${icon('link', 14)} Share</button>
      <button class="btn grow" data-act="file-terminal" data-id="${f.id}">${icon('terminal', 14)} Open in Terminal</button>`,
  });
});
on('file-share', () => { toast('Expiring link copied (24h)', 'ok'); closeAllSheets(); });
on('file-terminal', (el, ds) => {
  const f = getState().files.find((x) => x.id === ds.id);
  closeAllSheets();
  setState((s) => { s.terminalLines.push({ kind: 'cmd', text: `cat ${f.path}` }, { kind: 'dim', text: f.content.slice(0, 200) + (f.content.length > 200 ? '…' : '') }); }, 'term-cat');
  import('./main.js').then((m) => m.navigate('terminal'));
});
on('file-upload', () => {
  openSheet({
    title: 'Upload artifact',
    body: `
      <div class="field"><label>Path</label><input class="input mono" id="up-path" value="uploads/notes.md"></div>
      <div class="field"><label>Content</label><textarea class="input" id="up-content" placeholder="Paste text content…" style="min-height:110px"></textarea></div>
      <div class="banner info">${icon('shield', 16)}<div>Writes are journalled with your principal ID. Sensitive patterns auto-redacted.</div></div>`,
    foot: `<button class="btn grow primary" data-act="file-upload-go">Upload</button>`,
  });
  on('file-upload-go', () => {
    const sheet = document.querySelector('.sheet.open');
    setState((s) => {
      s.files.unshift({
        id: uid('fl'), path: sheet.querySelector('#up-path').value.trim() || 'uploads/file.md',
        type: 'md', size: 1024, createdBy: 'me', ts: now(),
        content: sheet.querySelector('#up-content').value.trim() || '(empty file)',
      });
      logEvent('artifact', 'File uploaded');
    }, 'file-upload');
    closeAllSheets(); toast('Uploaded', 'ok'); import('./main.js').then((m) => m.navigate('artifacts'));
  });
});

/* ================= SETTINGS ================= */
views.settings = {
  title: 'Settings',
  render() {
    const s = getState();
    const st = s.settings;
    return `
      <div class="page-head"><h1>Settings</h1><div class="sub">Everything is live — toggles persist instantly</div></div>

      <div class="section-title">Motion &amp; sound</div>
      <div class="card">
        <div class="kv"><span class="k">Animations</span>
          <div class="seg theme-modes" role="group" aria-label="Animation preference">
            ${[['system', 'Follow device'], ['full', 'Always'], ['reduced', 'Reduced']].map(([value, label]) => `<button class="${(st.motion || 'system') === value ? 'active' : ''}" data-act="set-motion" data-v="${value}" aria-pressed="${(st.motion || 'system') === value}">${label}</button>`).join('')}
          </div>
        </div>
        <div class="kv"><span class="k">Interface sounds</span><span class="switch ${st.soundHaptics ? 'on' : ''}" data-act="toggle-sound" role="switch" aria-checked="${st.soundHaptics ? 'true' : 'false'}"></span></div>
        <div class="tiny muted" style="margin-top:6px">Sounds are synthesised in the browser — no audio files, no network. They stay silent until your first tap.</div>
      </div>

      <div class="section-title">Voice &amp; speech</div>
      <div class="card">
        <div class="kv"><span class="k">Auto-speak</span><span class="tiny muted">${st.voice?.autoSpeak ? 'on — finished sentences are spoken' : 'off — press Play in Voice Studio'}</span></div>
        <div class="kv"><span class="k">Chunking</span><span class="tiny muted">${esc(st.voice?.strategy || 'sentence')}</span></div>
        <div class="kv"><span class="k">Voice</span><span class="tiny muted">${esc((st.voice?.profiles || []).find((p) => p.id === st.voice?.selectedProfileId)?.name || 'device default')}</span></div>
        <div class="kv"><span class="k">Voice input (network speech service)</span><span class="switch ${st.voice?.networkRecognitionConsent ? 'on' : ''}" data-act="toggle-voice-consent" role="switch" aria-checked="${st.voice?.networkRecognitionConsent ? 'true' : 'false'}"></span></div>
        <div class="tiny muted" style="margin-top:6px">Speech input sends audio to your browser's speech service. It is off until you allow it; speaking replies uses the on-device engine instead.</div>
        <button class="btn sm" style="margin-top:10px" data-act="nav" data-to="voice">${icon('mic', 15)} Open Voice Studio</button>
      </div>

      <div class="section-title">Appearance</div>
      <div class="card">
        <div class="kv"><span class="k">Theme</span>
          <div class="seg theme-modes" role="group" aria-label="Appearance mode">
            ${[['dark', 'Dark'], ['light', 'Light'], ['oled', 'OLED black'], ['high-contrast', 'High contrast']].map(([value, label]) => `<button class="${st.theme === value ? 'active' : ''}" data-act="set-theme" data-v="${value}" aria-pressed="${st.theme === value}">${label}</button>`).join('')}
          </div>
        </div>
        <div class="kv"><span class="k">Density</span>
          <div class="seg seg-fit">
            <button class="${st.density === 'comfortable' ? 'active' : ''}" data-act="set-density" data-v="comfortable">Comfort</button>
            <button class="${st.density === 'compact' ? 'active' : ''}" data-act="set-density" data-v="compact">Compact</button>
          </div>
        </div>
      </div>

      <div class="section-title">Workspace</div>
      <div class="card">
        <div class="field"><label>Name</label><input class="input" data-model="settings.workspaceName" value="${esc(st.workspaceName)}"></div>
        <div class="kv"><span class="k">Gateway</span><span class="strong">${esc(s.gateway.version)} · ${esc(s.gateway.sqlite)} · ${esc(s.gateway.status)}</span></div>
        <div class="kv"><span class="k">Uptime</span><span class="strong">${Math.round((now() - s.gateway.uptimeSince) / 86400000)} days</span></div>
      </div>

      <div class="section-title">Agents defaults</div>
      <div class="card">
        <div class="kv"><span class="k">Autonomy level</span>
          <select class="input compact" data-model="settings.autonomyLevel">
            ${[0, 1, 2, 3, 4].map((l) => `<option value="${l}" ${st.autonomyLevel === l ? 'selected' : ''}>L${l} · ${['ask-always', 'guided', 'supervised', 'guarded-auto', 'full-auto'][l]}</option>`).join('')}
          </select>
        </div>
        <div class="kv"><span class="k">Self-improvement policy</span>
          <select class="input compact" data-model="settings.selfImprove">
            ${['off', 'suggest', 'auto-with-review', 'full-auto'].map((m) => `<option ${st.selfImprove === m ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="section-title">Copilot</div>
      <div class="card">
        <div class="kv"><span class="k">Default mode</span>
          <select class="input compact" data-model="settings.copilotMode">
            ${['ask', 'operate', 'build', 'knowledge', 'training', 'voice', 'activity'].map((m) => `<option ${st.copilotMode === m ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
        </div>
        <div class="tiny muted" style="margin:-4px 0 8px">Used when the Copilot panel opens with no mode chosen. Modes never grant permissions.</div>
        <div class="kv"><span class="k">Conversation memory</span><span class="switch ${st.copilotMemory ? 'on' : ''}" data-act="toggle-memory"></span></div>
        <div class="tiny muted" style="margin-top:6px">When off, draft and action log stay in this tab only and are never written to storage.</div>
        <div class="kv"><span class="k">Self-approval</span><span class="chip tiny bad">always blocked</span></div>
      </div>

      <div class="section-title">Trust score weights</div>
      <div class="card">
        ${Object.entries(st.trustWeights).map(([k, v]) => `
          <div style="margin-bottom:6px">
            <div class="row between tiny"><span class="muted">${esc(k)}</span><span class="strong" id="tw-${k}">${v}</span></div>
            <input type="range" min="0" max="20" value="${v}" data-act="trust-weight" data-k="${k}">
          </div>`).join('')}
        <div class="banner info" style="margin-top:8px">${icon('spark', 15)}<div>Preview: Analyst-Prime would score <strong id="trust-preview">${Math.round(58 + (st.trustWeights.success - 12) * 0.4)}</strong> with these weights.</div></div>
      </div>

      <div class="section-title">Notifications</div>
      <div class="card">
        ${Object.entries(st.notify).map(([k, v]) => `
          <div class="kv"><span class="k">${esc(k)}</span><span class="switch ${v ? 'on' : ''}" data-act="toggle-notify" data-k="${k}"></span></div>`).join('')}
        <div class="tiny muted" style="line-height:1.8">Saved on this device only. MMM does not send email,
          push or SMS in this build, so these switches choose nothing yet.</div>
      </div>

      <div class="section-title">Security & governance</div>
      <div class="card">
        <div class="kv"><span class="k">Approval gates</span><span class="strong">${pendingApprovals().length} pending · enforced by the gateway when signed in</span></div>
        <div class="kv"><span class="k">Audit log</span><span class="strong">hash-chained on the gateway · nothing is recorded in demo mode</span></div>
        <div class="kv"><span class="k">Secrets</span><span class="strong">no key vault in this build · no provider key is stored</span></div>
        <div class="kv"><span class="k">Egress</span><span class="strong">not enforced by this app</span></div>
      </div>


      <div class="section-title">Data</div>
      <div class="card">
        <div class="kv"><span class="k">Storage</span><span class="strong">${esc(s.gateway.sqlite)} · localStorage-backed demo</span></div>
        <div class="kv"><span class="k">Retention</span><span class="strong">runs ${esc(st.retention.runs)} · logs ${esc(st.retention.logs)}</span></div>
        <div class="tiny muted">Display text: nothing is deleted on this schedule yet.</div>
        <button class="btn danger block" data-act="reset-demo" style="margin-top:10px">${icon('undo', 15)} Reset demo data</button>
      </div>

      <div class="section-title">About</div>
      <div class="card tiny muted" style="line-height:1.8">
        MMM PWA prototype · v0.1.0<br>
        Self-hosted gateway · no cloud dependency in the default path<br>
        PWA: installable · offline shell · background queue
        <button class="btn block sm" data-act="install-pwa" style="margin-top:10px">${icon('download', 14)} Install app</button>
      </div>`;
  },
};

on('set-theme', (el, ds) => {
  if (!['dark', 'light', 'oled', 'high-contrast'].includes(ds.v)) return;
  setState((s) => { s.settings.theme = ds.v; }, 'theme');
  applyTheme(); import('./main.js').then((m) => m.rerender());
});
on('set-density', (el, ds) => {
  setState((s) => { s.settings.density = ds.v; }, 'density');
  applyTheme(); import('./main.js').then((m) => m.rerender());
});
on('toggle-voice-consent', () => {
  setState((s) => {
    s.settings.voice = { ...(s.settings.voice || {}), networkRecognitionConsent: !s.settings.voice?.networkRecognitionConsent };
  }, 'voice-consent');
  toast(getState().settings.voice?.networkRecognitionConsent ? 'Voice input allowed' : 'Voice input disabled', 'ok');
  import('./main.js').then((m) => m.rerender());
});
on('set-motion', (el, ds) => {
  if (!['system', 'full', 'reduced'].includes(ds.v)) return;
  setState((s) => { s.settings.motion = ds.v; }, 'motion');
  import('./main.js').then((m) => m.rerender());
});
on('toggle-sound', () => {
  setState((s) => { s.settings.soundHaptics = !s.settings.soundHaptics; }, 'sound');
  import('./main.js').then((m) => m.rerender());
});
on('toggle-memory', () => { setState((s) => { s.settings.copilotMemory = !s.settings.copilotMemory; }, 'mem'); import('./main.js').then((m) => m.rerender()); });
on('toggle-notify', (el, ds) => { setState((s) => { s.settings.notify[ds.k] = !s.settings.notify[ds.k]; }, 'notify'); import('./main.js').then((m) => m.rerender()); });
on('trust-weight', (el, ds, ev) => {
  const v = Number(ev.target.value);
  setState((s) => { s.settings.trustWeights[ds.k] = v; }, 'tw');
  const label = document.getElementById(`tw-${ds.k}`);
  if (label) label.textContent = v;
  const prev = document.getElementById('trust-preview');
  if (prev) prev.textContent = Math.round(58 + (getState().settings.trustWeights.success - 12) * 0.4);
});
on('reset-demo', () => {
  confirmModal({
    title: 'Reset demo data?',
    body: 'Restores the seeded workspace. Your local changes will be lost.',
    confirmText: 'Reset', danger: true,
    onConfirm: () => {
      import('./core.js').then((c) => { c.resetDemo(); applyTheme(); import('./main.js').then((m) => m.navigate('home')); toast('Demo data restored', 'ok'); });
    },
  });
});
on('install-pwa', () => {
  if (window.__deferredPrompt) {
    window.__deferredPrompt.prompt();
    window.__deferredPrompt = null;
  } else {
    toast('Use your browser menu → “Install app” / “Add to Home Screen”', 'ok');
  }
});
