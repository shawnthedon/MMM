/* ============ Views: Skills, Models, Plugins, Chat, Telegram, Analytics, Artifacts, Settings ============ */
import {
  getState, setState, esc, icon, avatar, uid, now, fmtTime, fmtMoney, logEvent,
  pendingApprovals, getAgent, avatarColor,
} from './core.js';
import { openSheet, toast, confirmModal, on, applyTheme, closeAllSheets } from './shell.js';
import { sparkline } from './views1.js';
import { views } from './views1.js';

/* ================= SKILLS HUB ================= */
views.skills = {
  title: 'Skills Hub',
  render() {
    const s = getState();
    const tab = window.__skillsTab || 'installed';
    const lists = {
      installed: s.skills.filter((k) => k.status !== 'pending'),
      marketplace: s.skills.filter((k) => k.origin === 'marketplace'),
      mine: s.skills.filter((k) => k.origin === 'user'),
      synthesized: s.skills.filter((k) => k.status === 'pending'),
    };
    return `
      <div class="page-head row between">
        <div><h1>Skills Hub</h1><div class="sub">OpenClaw skills · versioned · eval-gated</div></div>
        <button class="btn primary sm" data-act="new-skill">${icon('plus', 16)} New</button>
      </div>
      <div class="tabs">
        ${[['installed', 'Installed'], ['marketplace', 'Marketplace'], ['mine', 'Mine'], ['synthesized', `Synthesized (${lists.synthesized.length})`]]
          .map(([id, l]) => `<button class="${tab === id ? 'active' : ''}" data-act="skills-tab" data-tab="${id}">${l}</button>`).join('')}
      </div>
      ${lists[tab].length ? lists[tab].map((k) => `
        <button class="list-card" data-act="open-skill" data-id="${k.id}" style="width:100%;text-align:left">
          <div class="avatar" style="background:${k.origin === 'agent' ? 'color-mix(in srgb, var(--warning) 25%, var(--elevated))' : 'var(--elevated)'};color:${k.origin === 'agent' ? 'var(--warning)' : 'var(--brand)'}">${icon('skill', 18)}</div>
          <div class="grow">
            <div class="row" style="gap:6px"><span class="strong small mono">${esc(k.name)}</span><span class="chip tiny">v${esc(k.version)}</span></div>
            <div class="tiny muted ellipsis">${esc(k.desc)}</div>
            <div class="row" style="gap:6px;margin-top:5px">
              <span class="chip tiny ${k.origin === 'agent' ? 'warn' : k.origin === 'user' ? 'brand' : ''}">${k.origin === 'agent' ? '⚗ agent-synthesized' : k.origin}</span>
              <span class="chip tiny ok">${Math.round(k.success * 100)}% · ${k.invokes} runs</span>
            </div>
          </div>
          ${k.status === 'pending' ? '<span class="chip tiny warn">review</span>' : icon('right', 16)}
        </button>`).join('') : `
        <div class="empty"><div class="e-ico">✦</div><div>Nothing here yet.</div></div>`}
      ${tab === 'synthesized' ? `
        <div class="banner warn" style="margin-top:14px">${icon('shield', 16)}
          <div>Agent-synthesized skills <strong>never auto-activate</strong> under policy “${esc(s.settings.selfImprove)}”. Approve after reviewing evals.</div>
        </div>` : ''}`;
  },
};

on('skills-tab', (el, ds) => { window.__skillsTab = ds.tab; import('./main.js').then((m) => m.rerender()); });

on('open-skill', (el, ds) => {
  const k = getState().skills.find((x) => x.id === ds.id);
  if (!k) return;
  openSheet({
    title: `<span class="mono">${esc(k.name)}</span>`,
    body: `
      <div class="row wrap" style="margin-bottom:10px">
        <span class="chip tiny">v${esc(k.version)}</span>
        <span class="chip tiny ${k.origin === 'agent' ? 'warn' : 'brand'}">${k.origin === 'agent' ? '⚗ synthesized' : esc(k.origin)}</span>
        <span class="chip tiny ${k.status === 'pending' ? 'warn' : 'ok'}">${esc(k.status)}</span>
      </div>
      <div class="small">${esc(k.desc)}</div>
      <div class="section-title">Manifest</div>
      <pre class="mono" style="background:var(--bg-2);border:1px solid var(--border-soft);border-radius:10px;padding:12px;overflow-x:auto">name: ${esc(k.name)}
version: ${esc(k.version)}
runtime: openclaw-skill/1
tools: [${k.tools.map(esc).join(', ')}]
permissions: [${k.perms.map(esc).join(', ')}]
evals: ${Math.round(k.success * 100)}% pass (${k.invokes} invocations)</pre>
      <div class="section-title">Eval trend</div>
      <div class="card">${sparkline([62, 68, 71, 74, 78, 80, Math.round(k.success * 100)])}</div>
      ${k.status === 'pending' ? `
        <div class="row" style="gap:10px;margin-top:14px">
          <button class="btn grow danger" data-act="skill-reject" data-id="${k.id}">Reject</button>
          <button class="btn grow ok" data-act="skill-approve" data-id="${k.id}">Approve & activate</button>
        </div>` : `
        <div class="row" style="gap:10px;margin-top:14px">
          <button class="btn grow" data-act="skill-add-agent" data-id="${k.id}">Add to agent</button>
          <button class="btn grow danger" data-act="skill-uninstall" data-id="${k.id}">Uninstall</button>
        </div>`}`,
  });
});

on('skill-approve', (el, ds) => {
  setState((s) => {
    const k = s.skills.find((x) => x.id === ds.id);
    if (k) { k.status = 'active'; logEvent('skill', `Skill ${k.name} approved & activated`); }
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
  setState((s) => { s.skills = s.skills.filter((x) => x.id !== ds.id); }, 'skill-uninstall');
  closeAllSheets(); toast('Skill uninstalled'); import('./main.js').then((m) => m.rerender());
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
      </div>`,
    foot: `<button class="btn grow primary" data-act="skill-create-go">Create skill</button>`,
  });
  on('skill-create-go', () => {
    const sheet = document.querySelector('.sheet.open');
    const name = sheet.querySelector('#ns-name').value.trim() || 'user.new-skill';
    setState((s) => {
      s.skills.unshift({
        id: uid('sk'), name, version: '0.1.0', origin: 'user', status: 'active', perms: ['artifacts.write'],
        tools: [], success: 1, invokes: 0, desc: sheet.querySelector('#ns-desc').value.trim() || 'User-authored skill.',
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
        <h1>Model Gateway</h1>
        <div class="sub">26 providers · per-agent overrides · routing policies · budgets</div>
      </div>
      <div class="grid-2">
        <div class="stat"><div class="k">Active providers</div><div class="v">${s.providers.filter((p) => p.status === 'on').length}</div><div class="d">of ${s.providers.length}</div></div>
        <div class="stat"><div class="k">Spend MTD</div><div class="v">${fmtMoney(s.providers.reduce((a, p) => a + p.spendMTD, 0))}</div><div class="d">across all models</div></div>
      </div>
      ${cats.map((cat) => `
        <div class="section-title">${esc(cat)}</div>
        ${s.providers.filter((p) => p.category === cat).map((p) => `
          <div class="list-card">
            <div class="avatar sm" style="background:${p.status === 'on' ? 'color-mix(in srgb, var(--success) 22%, var(--elevated))' : 'var(--elevated)'};color:${p.status === 'on' ? 'var(--success)' : 'var(--text-3)'}">${icon('model', 15)}</div>
            <div class="grow">
              <div class="row" style="gap:6px"><span class="strong small">${esc(p.name)}</span>
                <span class="pulse-dot ${p.status === 'on' ? 'live' : 'idle'}"></span></div>
              <div class="tiny muted">${esc(p.models.join(' · '))} · ${esc(p.auth)}</div>
            </div>
            <div class="col" style="align-items:flex-end;gap:4px">
              <span class="switch ${p.status === 'on' ? 'on' : ''}" data-act="toggle-provider" data-id="${p.id}"></span>
              <span class="tiny muted">${p.latency}ms</span>
            </div>
          </div>`).join('')}`).join('')}

      <div class="section-title">Routing policies</div>
      ${s.policies.map((p) => `
        <div class="card">
          <div class="row between"><strong class="small mono">${esc(p.name)}</strong><span class="chip tiny brand">p${p.priority}</span></div>
          <div class="tiny muted mono" style="margin-top:6px;line-height:1.6">${esc(p.rules)}</div>
        </div>`).join('')}

      <div class="section-title">Budgets</div>
      <div class="card">
        ${[['Workspace daily', 17.93, 50], ['Research Squad', 6.21, 20], ['Per-agent hard cap', 3.19, 8]].map(([k, v, cap]) => `
          <div style="margin-bottom:10px">
            <div class="row between tiny"><span class="muted">${k}</span><span class="strong">${fmtMoney(v)} / ${fmtMoney(cap)}</span></div>
            <div class="progress ${v / cap > 0.8 ? 'warn' : ''}"><i style="width:${Math.min(100, (v / cap) * 100)}%"></i></div>
          </div>`).join('')}
      </div>`;
  },
};

on('toggle-provider', (el, ds) => {
  setState((s) => {
    const p = s.providers.find((x) => x.id === ds.id);
    if (p) { p.status = p.status === 'on' ? 'off' : 'on'; logEvent('model', `Provider ${p.name} ${p.status}`); }
  }, 'toggle-provider');
  import('./main.js').then((m) => m.rerender());
});

/* ================= PLUGINS (MCP) ================= */
views.plugins = {
  title: 'Plugin Marketplace',
  render() {
    const s = getState();
    return `
      <div class="page-head">
        <h1>Plugins</h1>
        <div class="sub">MCP integrations · all calls proxied & audited by the gateway</div>
      </div>
      <div class="banner info">${icon('shield', 16)}<div>Agents never hold raw credentials — the gateway injects <strong>short-lived scoped tokens</strong> per call.</div></div>
      ${s.plugins.map((p) => `
        <div class="card">
          <div class="row">
            <div class="avatar" style="background:${p.installed ? 'color-mix(in srgb, var(--brand) 22%, var(--elevated))' : 'var(--elevated)'};color:var(--brand)">${icon('plug', 18)}</div>
            <div class="grow">
              <div class="row" style="gap:6px">
                <span class="strong small">${esc(p.name)}</span>
                ${p.verified ? `<span class="chip tiny ok">verified</span>` : `<span class="chip tiny warn">unverified</span>`}
                <span class="chip tiny">${esc(p.category)}</span>
              </div>
              <div class="tiny muted">${p.tools.length} tools · ${p.callsToday} calls today</div>
            </div>
            <button class="btn sm ${p.installed ? '' : 'primary'}" data-act="plugin-toggle" data-id="${p.id}">
              ${p.installed ? 'Manage' : 'Install'}
            </button>
          </div>
          ${p.installed ? `
            <div class="divider"></div>
            <div class="row wrap">${p.tools.map((t) => `<span class="chip tiny mono">${esc(t)}</span>`).join('')}</div>
            <div class="row wrap" style="margin-top:8px">
              ${p.scopes.map((sc) => `<span class="chip tiny warn">${icon('shield', 10)} ${esc(sc)}</span>`).join('')}
            </div>` : ''}
        </div>`).join('')}
      <div class="section-title">Custom MCP server</div>
      <button class="btn block" data-act="plugin-custom">＋ Add MCP server (stdio / SSE / HTTP)</button>`;
  },
};

on('plugin-toggle', (el, ds) => {
  const p = getState().plugins.find((x) => x.id === ds.id);
  if (!p) return;
  if (p.installed) {
    openSheet({
      title: `Manage ${esc(p.name)}`,
      body: `
        <div class="section-title" style="margin-top:0">Tool permissions</div>
        ${p.tools.map((t) => `
          <div class="kv"><span class="row mono" style="gap:8px">${esc(t)}</span>
          <span class="switch on" data-act="toggle-perm"></span></div>`).join('')}
        <div class="section-title">Bound agents</div>
        <div class="row wrap">${getState().agents.slice(0, 3).map((a) => `<span class="chip tiny">${esc(a.name)}</span>`).join('')}</div>
        <div class="section-title">Danger zone</div>
        <button class="btn danger block" data-act="plugin-uninstall" data-id="${p.id}">Uninstall plugin</button>`,
    });
  } else {
    openSheet({
      title: `Install ${esc(p.name)}`,
      body: `
        <div class="small">This plugin requests:</div>
        <div class="row wrap" style="margin:10px 0">
          ${p.tools.map((t) => `<span class="chip tiny mono">${esc(t)}</span>`).join('')}
        </div>
        <div class="banner warn">${icon('shield', 16)}<div>Scopes requested: <strong>${p.scopes.map(esc).join(', ')}</strong>. Privileged actions will hit approval gates.</div></div>
        <div class="field"><label>Auth</label><input class="input" type="password" placeholder="Paste API key (sealed in gateway vault)" value=""></div>`,
      foot: `<button class="btn grow primary" data-act="plugin-install-go" data-id="${p.id}">Install plugin</button>`,
    });
    on('plugin-install-go', () => {
      setState((s) => {
        const x = s.plugins.find((y) => y.id === ds.id);
        if (x) x.installed = true;
        logEvent('plugin', `Plugin ${p.name} installed`);
      }, 'plugin-install');
      closeAllSheets(); toast(`${p.name} installed`, 'ok'); import('./main.js').then((m) => m.rerender());
    });
  }
});
on('plugin-uninstall', (el, ds) => {
  setState((s) => {
    const x = s.plugins.find((y) => y.id === ds.id);
    if (x) x.installed = false;
    logEvent('plugin', `Plugin uninstalled`);
  }, 'plugin-uninstall');
  closeAllSheets(); toast('Plugin uninstalled'); import('./main.js').then((m) => m.rerender());
});
on('plugin-custom', () => {
  openSheet({
    title: 'Custom MCP server',
    body: `
      <div class="field"><label>Name</label><input class="input" placeholder="my-internal-tools"></div>
      <div class="field"><label>Transport</label>
        <div class="seg"><button class="active">stdio</button><button>SSE</button><button>HTTP</button></div>
      </div>
      <div class="field"><label>Command / URL</label><input class="input mono" placeholder="npx -y @my/mcp-server"></div>
      <div class="field"><label>Env (sealed)</label><textarea class="input mono" placeholder="API_TOKEN=..."></textarea></div>
      <div class="banner warn">${icon('shield', 16)}<div>Custom servers are flagged <strong>unverified</strong>. Traffic still flows through the egress proxy.</div></div>`,
    foot: `<button class="btn grow primary" data-act="custom-install-go">Add server</button>`,
  });
  on('custom-install-go', () => {
    closeAllSheets();
    toast('Custom MCP server added (health check running)', 'ok');
  });
});
on('toggle-perm', (el) => { el.classList.toggle('on'); });

/* ================= CHAT ================= */
views.chat = {
  title: 'Chat',
  persistent: false,
  render(params) {
    const s = getState();
    const id = params?.id || window.__chatThread || s.threads[0].id;
    window.__chatThread = id;
    const th = s.threads.find((t) => t.id === id) || s.threads[0];
    return `
      <div class="row between" style="margin-bottom:12px">
        <h1 style="font-size:20px">Chat</h1>
        <button class="btn sm" data-act="new-chat">${icon('plus', 15)} New</button>
      </div>
      <div class="scroll-x" style="margin-bottom:12px">
        ${s.threads.map((t) => `<button class="chip ${t.id === th.id ? 'brand' : ''}" data-act="chat-open" data-id="${t.id}">
          ${t.kind === 'channel' ? '#' : '💬'} ${esc(t.title)}${t.unread ? ` ·${t.unread}` : ''}
        </button>`).join('')}
      </div>
      <div class="msgs" id="chat-msgs">
        ${th.messages.map((m) => renderMsg(m, th)).join('')}
      </div>
      <div class="composer" style="margin-top:12px;border:1px solid var(--border-soft);border-radius:16px">
        <textarea id="chat-input" rows="1" placeholder="Message… (@ to mention an agent, / for commands)"></textarea>
        <button class="send-btn" data-act="chat-send">${icon('send', 18)}</button>
      </div>`;
  },
  mount() {
    const box = document.getElementById('chat-msgs');
    if (box) box.scrollTop = box.scrollHeight;
    const input = document.getElementById('chat-input');
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(input.value); input.value = ''; }
    });
  },
};

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

function simulateReply(thId) {
  const agentName = getState().threads.find((t) => t.id === thId)?.title.replace(/^[#💬]\s*/, '') || 'Agent';
  setTimeout(() => {
    const replies = [
      `On it. I'll fold that into the current run and report back with artifacts.`,
      `Good call — dispatching as a task with a review gate. Estimated cost: $0.42.`,
      `Done — wrote the output to artifacts/. Want me to push a summary to the Telegram digest?`,
      `Noted. I'm raising a follow-up question to the planner node before proceeding.`,
    ];
    setState((st) => {
      const th = st.threads.find((t) => t.id === thId);
      if (th) th.messages.push({ id: uid('m'), from: 'agent', agent: agentName, text: replies[Math.floor(Math.random() * replies.length)], ts: now() });
    }, 'chat-reply');
    import('./main.js').then((m) => m.rerender());
  }, 900 + Math.random() * 900);
}

function sendChat(text) {
  if (!text.trim()) return;
  const s = getState();
  const thId = window.__chatThread || s.threads[0].id;
  setState((st) => {
    const th = st.threads.find((t) => t.id === thId);
    if (th) { th.messages.push({ id: uid('m'), from: 'me', text, ts: now() }); th.unread = 0; }
  }, 'chat-send');
  import('./main.js').then((m) => m.rerender());
  simulateReply(thId);
}

on('chat-open', (el, ds) => {
  window.__chatThread = ds.id;
  import('./main.js').then((m) => m.navigate(`chat/${ds.id}`));
});
on('chat-send', () => {
  const input = document.getElementById('chat-input');
  if (input?.value.trim()) { sendChat(input.value); input.value = ''; }
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
  on('new-chat-go', () => {
    const sheet = document.querySelector('.sheet.open');
    const target = sheet.querySelector('#nc-agent').value;
    const msg = sheet.querySelector('#nc-msg').value.trim() || 'Hello!';
    if (target === '__copilot') {
      closeAllSheets();
      import('./copilot.js').then((m) => { m.openCopilot(); setTimeout(() => window.__copilotChip?.(msg), 350); });
      return;
    }
    const id = uid('th');
    setState((s) => {
      s.threads.unshift({ id, kind: 'direct', title: target, unread: 0, messages: [{ id: uid('m'), from: 'me', text: msg, ts: now() }] });
    }, 'new-chat');
    closeAllSheets();
    window.__chatThread = id;
    import('./main.js').then((m) => m.navigate(`chat/${id}`));
    simulateReply(id);
  });
});

/* ================= TELEGRAM ================= */
views.telegram = {
  title: 'Telegram Bridge',
  render() {
    const s = getState();
    const tg = s.telegram;
    return `
      <div class="page-head">
        <h1>Telegram Bridge</h1>
        <div class="sub">OpenClaw command layer — control SwarmOS from anywhere</div>
      </div>
      <div class="card">
        <div class="row between">
          <div class="row">
            <div class="avatar" style="background:var(--brand);color:#fff">${icon('send', 18)}</div>
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
          <div class="grow"><div class="strong small">SwarmOS Control</div><div class="tiny" style="opacity:.7">bot · always on</div></div>
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
    s.telegram.messages.push({ from: 'bot', ts: now(), text: '✅ Test notification from SwarmOS\ngateway healthy · approvals route here' });
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
        <div class="stat"><div class="k">MCP calls</div><div class="v">${s.plugins.reduce((a, p) => a + p.callsToday, 0)}</div><div class="d">2 denied by policy</div></div>
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
      <div class="card">
        ${s.plugins.filter((p) => p.installed).map((p) => `
          <div class="row between" style="padding:6px 0">
            <span class="small">${esc(p.name)}</span>
            <div class="progress" style="width:120px"><i style="width:${Math.min(100, p.callsToday / 4)}%"></i></div>
            <span class="tiny muted" style="width:52px;text-align:right">${p.callsToday}</span>
          </div>`).join('')}
      </div>`;
  },
};

on('export-report', () => {
  toast('Report exported → artifacts/reports/analytics-24h.csv', 'ok');
  setState((s) => {
    s.files.unshift({
      id: uid('fl'), path: 'reports/analytics-24h.csv', type: 'csv', size: 2204, createdBy: 'me', ts: now(),
      content: 'metric,value\nspend_today,17.93\nmcp_calls,535\napprovals_pending,2\n',
    });
    logEvent('artifact', 'Analytics report exported');
  }, 'export');
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

      <div class="section-title">Appearance</div>
      <div class="card">
        <div class="kv"><span class="k">Theme</span>
          <div class="seg" style="width:150px">
            <button class="${st.theme === 'dark' ? 'active' : ''}" data-act="set-theme" data-v="dark">Dark</button>
            <button class="${st.theme === 'light' ? 'active' : ''}" data-act="set-theme" data-v="light">Light</button>
          </div>
        </div>
        <div class="kv"><span class="k">Density</span>
          <div class="seg" style="width:180px">
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
          <select class="input" data-model="settings.autonomyLevel" style="width:170px">
            ${[0, 1, 2, 3, 4].map((l) => `<option value="${l}" ${st.autonomyLevel === l ? 'selected' : ''}>L${l} · ${['ask-always', 'guided', 'supervised', 'guarded-auto', 'full-auto'][l]}</option>`).join('')}
          </select>
        </div>
        <div class="kv"><span class="k">Self-improvement policy</span>
          <select class="input" data-model="settings.selfImprove" style="width:170px">
            ${['off', 'suggest', 'auto-with-review', 'full-auto'].map((m) => `<option ${st.selfImprove === m ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
        </div>
        <div class="kv"><span class="k">Live simulation feed</span><span class="switch ${st.simulate ? 'on' : ''}" data-act="toggle-sim"></span></div>
      </div>

      <div class="section-title">Copilot</div>
      <div class="card">
        <div class="kv"><span class="k">Default mode</span>
          <select class="input" data-model="settings.copilotMode" style="width:130px">
            ${['ask', 'act', 'build', 'analyze'].map((m) => `<option ${st.copilotMode === m ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
        </div>
        <div class="kv"><span class="k">Conversation memory</span><span class="switch ${st.copilotMemory ? 'on' : ''}" data-act="toggle-memory"></span></div>
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
      </div>

      <div class="section-title">Security & governance</div>
      <div class="card">
        <div class="kv"><span class="k">Approval gates</span><span class="strong">4 templates active</span></div>
        <div class="kv"><span class="k">Audit log</span><span class="strong">hash-chained · append-only</span></div>
        <div class="kv"><span class="k">Secrets</span><span class="strong">AEAD-sealed vault</span></div>
        <div class="kv"><span class="k">Egress</span><span class="strong">default-deny · proxy</span></div>
      </div>

      <div class="section-title">Data</div>
      <div class="card">
        <div class="kv"><span class="k">Storage</span><span class="strong">${esc(s.gateway.sqlite)} · localStorage-backed demo</span></div>
        <div class="kv"><span class="k">Retention</span><span class="strong">runs ${esc(st.retention.runs)} · logs ${esc(st.retention.logs)}</span></div>
        <button class="btn danger block" data-act="reset-demo" style="margin-top:10px">${icon('undo', 15)} Reset demo data</button>
      </div>

      <div class="section-title">About</div>
      <div class="card tiny muted" style="line-height:1.8">
        SwarmOS PWA prototype · v0.1.0<br>
        Self-hosted gateway · zero external dependencies<br>
        PWA: installable · offline shell · background queue
        <button class="btn block sm" data-act="install-pwa" style="margin-top:10px">${icon('download', 14)} Install app</button>
      </div>`;
  },
};

on('set-theme', (el, ds) => {
  setState((s) => { s.settings.theme = ds.v; }, 'theme');
  applyTheme(); import('./main.js').then((m) => m.rerender());
});
on('set-density', (el, ds) => {
  setState((s) => { s.settings.density = ds.v; }, 'density');
  applyTheme(); import('./main.js').then((m) => m.rerender());
});
on('toggle-sim', () => { setState((s) => { s.settings.simulate = !s.settings.simulate; }, 'sim'); import('./main.js').then((m) => m.rerender()); });
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
