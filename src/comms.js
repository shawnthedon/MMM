/* ============ Comms — the application communication gateways ============
 * One panel that owns every channel (Telegram, WhatsApp, Discord, Slack, SMS, Browser) plus the
 * switchboard that connects them to the Copilot and to agents.
 *
 * Honest contract:
 *   • saving credentials never marks a channel verified — only a live test that the provider
 *     actually accepted can do that (or, for the browser channel, a real in-app delivery);
 *   • every send goes through `deliver()`, which reports what the provider said;
 *   • inbound commands are only accepted after the adapter verifies the signature.
 * With no credentials and no outbound network the panel still works: it counts as unconfigured and
 * says so instead of pretending a bot is polling.
 */
import { getState, setState, esc, icon, logEvent, now, uid, pendingApprovals, fmtMoney, getAgent } from './core.js';
import { openSheet, toast, on, confirmModal, closeAllSheets } from './shell.js';
import { views } from './views1.js';
import {
  CHANNELS, CHANNEL_STATUS, COMMANDS, channelStatus, getChannel, missingFields, missingInboundFields,
  maskSecret, defaultComms,
} from './commsChannels.js';
import { deliver, capabilities, adapterFor } from './commsAdapters.js';
import './comms.css';

/* ---------- store helpers ---------- */
export const commsState = () => {
  const s = getState();
  if (!s.comms) {
    setState((st) => { st.comms = defaultComms(); }, 'comms-init');
  }
  return getState().comms;
};

const record = (id) => (commsState().channels || {})[id] || { enabled: false, config: {}, routing: { copilot: true, agents: [] } };

const rerender = () => import('./main.js').then((m) => m.rerender()).catch(() => {});

/* =========================================================================================
 * Gateway operations (shared by the UI and the Copilot)
 * =======================================================================================*/
export function saveChannelConfig(id, configPatch) {
  const channel = getChannel(id);
  if (!channel) return { ok: false, error: `Unknown channel “${id}”.` };
  setState((s) => {
    s.comms = s.comms || defaultComms();
    const rec = s.comms.channels[id] || (s.comms.channels[id] = { enabled: false, config: {}, routing: { copilot: true, agents: [] } });
    const next = { ...rec.config };
    Object.entries(configPatch).forEach(([k, v]) => {
      const clean = String(v ?? '').trim();
      if (clean) next[k] = clean;
      else delete next[k];
    });
    rec.config = next;
    rec.verifiedAt = null; // any credential change invalidates the previous verification
    rec.lastTest = null;
    logEvent('comms', `Saved ${channel.label} settings (not verified)`);
  }, 'comms-save');
  return { ok: true, status: channelStatus(id, record(id)) };
}

export function toggleChannel(id, enabled) {
  const rec = record(id);
  const willEnable = enabled === undefined ? !rec.enabled : Boolean(enabled);
  if (willEnable) {
    const missing = missingFields(id, rec.config);
    if (missing.length) {
      return { ok: false, error: `Cannot enable ${getChannel(id)?.label}: missing ${missing.join(', ')}.` };
    }
  }
  setState((s) => {
    s.comms.channels[id].enabled = willEnable;
    logEvent('comms', `${getChannel(id)?.label} ${willEnable ? 'enabled' : 'disabled'}`);
  }, 'comms-toggle');
  return { ok: true, enabled: willEnable };
}

/** Real delivery attempt used by the “Send test” button and by the Copilot. */
export async function sendTest(id, { text = 'SwarmOS test message — gateway reachable.', fetchImpl } = {}) {
  const channel = getChannel(id);
  if (!channel) return { ok: false, error: `Unknown channel “${id}”.` };
  const rec = record(id);
  const result = await deliver(id, rec.config, { text, title: 'SwarmOS' }, fetchImpl ? { fetchImpl } : undefined);
  setState((s) => {
    const r = s.comms.channels[id];
    r.lastTest = {
      at: now(),
      ok: Boolean(result.ok),
      detail: result.ok ? result.detail : result.error,
      reason: result.reason || null,
    };
    if (result.ok) r.verifiedAt = now();
    if (result.ok && id === 'browser') {
      s.comms.inbox = [{ id: uid('msg'), title: 'SwarmOS', text, ts: now(), channel: 'browser', from: 'system' }, ...(s.comms.inbox || [])].slice(0, 50);
    }
    s.comms.log = [{ id: uid('cl'), at: now(), channel: id, direction: 'out', ok: Boolean(result.ok), text: String(text).slice(0, 160), detail: result.ok ? result.detail : result.error }, ...(s.comms.log || [])].slice(0, 60);
    logEvent('comms', `${channel.label} test ${result.ok ? 'delivered' : `failed (${result.reason})`}`);
  }, 'comms-test');
  return result;
}

/** Send an operational message to a channel (used by routing). Never fabricates success. */
export async function sendMessage(id, text, opts = {}) {
  const rec = record(id);
  if (!rec.enabled) return { ok: false, reason: 'disabled', error: `${getChannel(id)?.label} is disabled.` };
  const result = await deliver(id, rec.config, { text, title: opts.title || 'SwarmOS' }, opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : undefined);
  setState((s) => {
    s.comms.log = [{ id: uid('cl'), at: now(), channel: id, direction: 'out', ok: Boolean(result.ok), text: String(text).slice(0, 160), detail: result.ok ? result.detail : result.error }, ...(s.comms.log || [])].slice(0, 60);
  }, 'comms-send');
  return result;
}

/** Route an agent's reports to a channel (or detach). Stored as configuration, not a promise. */
export function routeAgent(id, agentId, attach = true) {
  const agent = getAgent(agentId) || getState().agents.find((a) => a.name === agentId);
  if (!agent) return { ok: false, error: `Unknown agent “${agentId}”.` };
  setState((s) => {
    const rec = s.comms.channels[id];
    rec.routing = rec.routing || { copilot: true, agents: [] };
    const set = new Set(rec.routing.agents || []);
    if (attach) set.add(agent.id); else set.delete(agent.id);
    rec.routing.agents = [...set];
    logEvent('comms', `${agent.name} ${attach ? 'routed to' : 'detached from'} ${getChannel(id)?.label}`);
  }, 'comms-route');
  return { ok: true, agents: record(id).routing.agents };
}

export function setCommandAllowed(cmd, allowed) {
  setState((s) => { s.comms.commands[cmd] = Boolean(allowed); }, 'comms-command');
  return { ok: true };
}

/** Which channels would carry a message for this agent right now. */
export function routesFor(agentId = null) {
  const comms = commsState();
  return CHANNELS.filter((c) => {
    const rec = comms.channels[c.id];
    if (!rec?.enabled) return false;
    if (channelStatus(c.id, rec) === 'not_configured') return false;
    if (!agentId) return Boolean(rec.routing?.copilot);
    return (rec.routing?.agents || []).includes(agentId);
  }).map((c) => c.id);
}

/* =========================================================================================
 * Inbound: channel message → Copilot command → reply out of the same channel
 * =======================================================================================*/
/** Deterministic answers from live state; the same command grammar the Telegram bridge shows. */
export function runChannelCommand(text) {
  const s = getState();
  const comms = s.comms || defaultComms();
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, error: 'Empty message.' };
  const cmd = raw.split(/\s+/)[0].toLowerCase();
  const known = COMMANDS.find((c) => c.id === cmd);
  if (!known) {
    return { ok: false, reason: 'unknown_command', reply: `Unknown command “${cmd}”. Known: ${COMMANDS.map((c) => c.id).join(' · ')}` };
  }
  if (!comms.commands?.[cmd]) {
    return { ok: false, reason: 'blocked', reply: `${cmd} is disabled for channels. Enable it in Comms → Command surface.` };
  }
  if (known.gate) {
    return { ok: true, gated: true, reply: `${cmd} is gated: open SwarmOS to confirm — channel commands cannot perform gated actions (replay-protected signed buttons only).` };
  }
  switch (cmd) {
    case '/status':
      return {
        ok: true,
        reply: `Gateway ${s.agents.filter((a) => a.status === 'running').length} agents active · ${pendingApprovals().length} approvals pending · spend today ${fmtMoney(s.agents.reduce((a, x) => a + x.costToday, 0))}`,
      };
    case '/agents':
      return { ok: true, reply: s.agents.map((a) => `▸ ${a.name} · ${a.status} · trust ${a.trust}`).join('\n') || 'no agents' };
    case '/tasks': {
      const counts = s.tasks.reduce((acc, t) => ({ ...acc, [t.column]: (acc[t.column] || 0) + 1 }), {});
      return { ok: true, reply: `Board: ${['todo', 'doing', 'review', 'done'].map((c) => `${c} ${counts[c] || 0}`).join(' · ')}` };
    }
    case '/ask':
      return { ok: true, reply: `Open SwarmOS for a full Copilot answer — channel replies are deterministic summaries only.` };
    default:
      return { ok: true, reply: `${cmd} acknowledged.` };
  }
}

/**
 * Handle an inbound webhook: verify the signature first, then run the command and reply on the
 * same channel. Returns a structured result so the gateway route can answer the provider.
 */
export async function handleInbound(id, { headers = {}, rawBody = '', json = null, fetchImpl } = {}) {
  const channel = getChannel(id);
  const adapter = adapterFor(id);
  const rec = record(id);
  if (!channel || !adapter) return { ok: false, status: 404, error: 'Unknown channel.' };
  if (!rec.enabled) return { ok: false, status: 403, error: `${channel.label} is disabled.` };

  if (id !== 'browser') {
    const missing = missingInboundFields(id, rec.config);
    if (missing.length) {
      return { ok: false, status: 503, error: `Inbound verification unavailable: ${missing.join(', ')} not configured.` };
    }
    // Twilio signs form-encoded params, so reconstruct them when the caller only passed JSON.
    const formBody = rawBody || (json
      ? Object.entries(json).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
      : '');
    let verified = false;
    try {
      verified = await adapter.verify(headers, formBody, rec.config);
    } catch (err) {
      return { ok: false, status: 500, error: `Verification error: ${err.message}` };
    }
    if (!verified) {
      setState((s) => {
        s.comms.log = [{ id: uid('cl'), at: now(), channel: id, direction: 'in', ok: false, text: 'rejected: bad signature', detail: 'Rejected before parsing.' }, ...(s.comms.log || [])].slice(0, 60);
      }, 'comms-inbound-reject');
      logEvent('comms', `${channel.label} inbound rejected — signature mismatch`);
      return { ok: false, status: 401, error: 'Signature verification failed.' };
    }
  }

  const parsed = adapter.parseInbound(json || (() => { try { return JSON.parse(rawBody); } catch { return null; } })());
  if (!parsed) return { ok: false, status: 400, error: 'No message in payload.' };

  const result = runChannelCommand(parsed.text);
  setState((s) => {
    s.comms.log = [{ id: uid('cl'), at: now(), channel: id, direction: 'in', ok: result.ok, text: parsed.text.slice(0, 160), detail: result.reply || result.error }, ...(s.comms.log || [])].slice(0, 60);
  }, 'comms-inbound');
  return { ok: true, status: 200, parsed, reply: result.reply, gated: Boolean(result.gated) };
}

/* =========================================================================================
 * Copilot seam — one command entry point for the whole comms surface
 * =======================================================================================*/
export function commsCommand(raw) {
  const text = String(raw || '').trim();
  const lower = text.toLowerCase();
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
  const channelMatch = CHANNELS.find((c) => tokens.includes(c.id) || tokens.includes(c.label.toLowerCase()));

  if (/^(comms|channels?|gateways?)\b/.test(lower) && /status|show|list/.test(lower)) {
    const comms = commsState();
    const rows = CHANNELS.map((c) => `${c.label}: ${CHANNEL_STATUS[channelStatus(c.id, comms.channels[c.id])].label}`);
    return { ok: true, reply: `Comms gateways — ${rows.join(' · ')}.`, action: 'comms-status' };
  }
  if (/^(connect|configure|set up|setup|enable)\b/.test(lower) && channelMatch) {
    return { ok: false, reason: 'needs_credentials', channel: channelMatch.id, reply: `Open Comms → ${channelMatch.label} to enter credentials. I never accept secrets in chat, and saving them does not verify the channel.` };
  }
  if (/(^|\b)test( (message|msg))?( (to|on))?\b/.test(lower) && channelMatch && !/latest|status/.test(lower)) {
    return { ok: 'async', run: () => sendTest(channelMatch.id), channel: channelMatch.id, reply: `Sending a real test to ${channelMatch.label}…` };
  }
  if (/route\b/.test(lower) && channelMatch) {
    const agent = getState().agents.find((a) => lower.includes(a.name.toLowerCase()));
    if (!agent) return { ok: false, reason: 'unknown_agent', reply: 'Name an agent to route, e.g. “route SRE-Bot to telegram”.' };
    const out = routeAgent(channelMatch.id, agent.id, !/detach|stop|remove/.test(lower));
    return { ok: out.ok, reply: out.ok ? `${agent.name} is now routed to ${channelMatch.label} (delivery still requires the channel to be enabled and verified).` : out.error };
  }
  if (/(mute|quiet)/.test(lower) && channelMatch) {
    const out = toggleChannel(channelMatch.id, false);
    return { ok: out.ok, reply: out.ok ? `${channelMatch.label} disabled — no outbound messages will be attempted.` : out.error };
  }
  if (/(wake|unmute|resume)/.test(lower) && channelMatch) {
    const out = toggleChannel(channelMatch.id, true);
    return { ok: out.ok, reply: out.ok ? `${channelMatch.label} enabled.` : out.error };
  }
  if (/inbox/.test(lower)) {
    const inbox = commsState().inbox || [];
    return { ok: true, reply: inbox.length ? `${inbox.length} in-app message(s); latest: “${inbox[0].text}”.` : 'The in-app inbox is empty.' };
  }
  return null;
}

/* =========================================================================================
 * Panel
 * =======================================================================================*/
const statusChip = (id, rec) => {
  const status = channelStatus(id, rec);
  const meta = CHANNEL_STATUS[status];
  return `<span class="chip tiny ${meta.chip}" title="${esc(meta.detail)}">${esc(meta.label)}</span>`;
};

function channelTile(channel) {
  const rec = record(channel.id);
  const status = channelStatus(channel.id, rec);
  const caps = capabilities()[channel.id] || {};
  const capChips = [
    caps.outbound ? 'outbound' : 'no outbound',
    caps.inbound ? 'inbound' : 'no inbound',
    caps.signature ? 'signed' : 'same-origin',
  ];
  // The tile is a container, not a button: the enable switch must be its own control, otherwise a
  // tap on the switch would also open the settings sheet (nested interactive elements).
  return `
    <div class="comms-tile ${rec.enabled ? 'on' : ''}">
      <button class="comms-main" data-act="comms-open" data-id="${channel.id}"
              aria-label="${esc(`${channel.label} settings — ${CHANNEL_STATUS[status].label}`)}">
        <span class="comms-tile-ico" aria-hidden="true">${icon(channel.icon, 20)}</span>
        <span class="comms-body">
          <span class="comms-name">${esc(channel.label)}</span>
          ${statusChip(channel.id, rec)}
          <span class="comms-desc">${esc(channel.summary)}</span>
          <span class="comms-caps">
            ${capChips.map((c) => `<span class="chip tiny">${esc(c)}</span>`).join('')}
            ${rec.verifiedAt ? '<span class="chip tiny ok">verified</span>' : ''}
          </span>
        </span>
        <span class="comms-chev" aria-hidden="true">${icon('right', 16)}</span>
      </button>
      <button class="switch-hit" data-act="comms-toggle" data-id="${channel.id}" role="switch"
              aria-checked="${rec.enabled ? 'true' : 'false'}" aria-label="${esc(`${rec.enabled ? 'Disable' : 'Enable'} ${channel.label}`)}">
        <span class="switch ${rec.enabled ? 'on' : ''}" aria-hidden="true"></span>
      </button>
    </div>`;
}

views.comms = {
  title: 'Comms',
  render() {
    const s = getState();
    const comms = s.comms || defaultComms();
    const verified = CHANNELS.filter((c) => channelStatus(c.id, comms.channels[c.id]) === 'verified').length;
    const enabled = CHANNELS.filter((c) => comms.channels[c.id]?.enabled).length;
    return `
      <div class="page-head row between wrap comms-head">
        <div class="grow">
          <h1>Comms</h1>
          <div class="sub">${CHANNELS.length} gateways · ${enabled} enabled · ${verified} verified · Copilot + agents</div>
        </div>
        <button class="btn sm" data-act="nav" data-to="comms" title="Refresh status">${icon('broadcast', 16)} Status</button>
      </div>

      <div class="banner ${verified ? 'info' : 'warn'}" style="margin-bottom:12px">
        ${icon('shield', 16)}
        <div><strong>Honest state:</strong> a channel is only “verified” after the provider accepted a real
        test. Credentials live in this browser store in this build — the gateway has no comms routes yet,
        so cloud deliveries need outbound network and will fail here with the provider's error.
        ${verified ? '' : 'None of the cloud channels is verified right now.'}</div>
      </div>

      <div class="comms-grid">${CHANNELS.map(channelTile).join('')}</div>

      <div class="section-title">Switchboard</div>
      <div class="card">
        <div class="kv"><span class="k">Command surface</span><span class="strong small">${COMMANDS.filter((c) => comms.commands?.[c.id]).map((c) => c.id).join(' · ') || 'none'}</span></div>
        <div class="kv"><span class="k">Gated over channels</span><span class="strong small">${COMMANDS.filter((c) => c.gate).map((c) => c.id).join(' · ')}</span></div>
        <button class="btn sm block" style="margin-top:8px" data-act="comms-commands">Configure commands</button>
      </div>

      <div class="section-title">Inbox (browser channel)</div>
      <div class="card">
        ${(comms.inbox || []).length
          ? comms.inbox.map((m) => `
            <div class="comms-inbox">
              <span class="pulse-dot live" aria-hidden="true"></span>
              <div class="grow">
                <div class="small break">${esc(m.text)}</div>
                <div class="tiny muted">${esc(m.title)} · ${new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
              </div>
            </div>`).join('')
          : '<div class="tiny muted">No in-app messages yet. The browser channel delivers here — it is the one gateway that works without credentials.</div>'}
        <button class="btn sm block" style="margin-top:8px" data-act="comms-test" data-id="browser">${icon('bell', 14)} Send test to inbox</button>
      </div>

      <div class="section-title">Delivery log</div>
      <div class="card">
        ${(comms.log || []).length
          ? comms.log.slice(0, 12).map((l) => `
            <div class="comms-log-row">
              <span class="comms-log-meta">
                <span class="chip tiny ${l.ok ? 'ok' : 'bad'}">${l.ok ? 'ok' : 'failed'}</span>
                <span class="tiny muted">${esc(l.channel)} · ${esc(l.direction)}</span>
              </span>
              <span class="comms-log-text tiny">${esc(l.text)}</span>
            </div>`).join('')
          : '<div class="tiny muted">Nothing sent or received yet.</div>'}
      </div>`;
  },
};

/* ---------- channel settings sheet ---------- */
function channelSheet(id) {
  const channel = getChannel(id);
  if (!channel) return;
  const rec = record(id);
  const status = channelStatus(id, rec);
  const missing = missingFields(id, rec.config);
  const missingIn = missingInboundFields(id, rec.config);
  const caps = capabilities()[id];
  openSheet({
    title: `${icon(channel.icon, 18)} ${esc(channel.label)}`,
    wide: true,
    body: `
      <div class="row wrap" style="gap:6px;margin-bottom:10px">
        ${statusChip(id, rec)}
        <span class="chip tiny">${esc(channel.kind === 'local' ? 'in-app channel' : 'cloud gateway')}</span>
        <span class="chip tiny">${esc(channel.transport)}</span>
      </div>
      <div class="tiny muted">${esc(channel.summary)}</div>

      <div class="section-title">1 · Connection</div>
      <div class="card">
        ${channel.fields.map((f) => {
          const value = rec.config[f.key];
          const shown = f.secret && value ? maskSecret(value) : (value || '');
          return `<div class="field">
            <label for="cf-${id}-${f.key}">${esc(f.label)} ${f.required === false ? '<span class="tiny muted">(optional)</span>' : ''}${f.scope === 'inbound' ? ' <span class="chip tiny">inbound</span>' : ''}</label>
            <input class="input mono" id="cf-${id}-${f.key}" data-cf="${f.key}" value="${esc(shown)}" placeholder="${esc(f.placeholder)}" autocomplete="off" ${f.secret ? 'data-secret="1"' : ''}>
            <div class="tiny muted" style="margin-top:3px">${esc(f.help)}${f.env?.[f.key] ? ` · env ${esc(f.env[f.key])}` : ''}</div>
          </div>`;
        }).join('')}
        <div class="tiny muted">Saved values are never echoed back: secrets render as ••••last4. Changing any field clears the verification badge.</div>
        ${missing.length ? `<div class="tiny" style="color:var(--warning);margin-top:6px">Still required to send: ${esc(missing.join(', '))}</div>` : ''}
        ${missingIn.length ? `<div class="tiny" style="color:var(--warning);margin-top:4px">Inbound webhooks cannot verify yet: ${esc(missingIn.join(', '))}</div>` : ''}
      </div>

      <div class="section-title">2 · Routing</div>
      <div class="card">
        <div class="kv"><span class="k">Copilot replies</span>
          <span class="switch ${rec.routing?.copilot ? 'on' : ''}" role="switch" aria-checked="${rec.routing?.copilot ? 'true' : 'false'}" data-act="comms-route-copilot" data-id="${id}"></span></div>
        <div class="tiny muted" style="margin:8px 0 6px">Agents routed to this channel:</div>
        ${getState().agents.map((a) => `
          <div class="kv"><span class="k small">${esc(a.name)}</span>
            <span class="switch ${(rec.routing?.agents || []).includes(a.id) ? 'on' : ''}" role="switch" aria-checked="${(rec.routing?.agents || []).includes(a.id)}" data-act="comms-route-agent" data-id="${id}" data-agent="${a.id}"></span></div>`).join('')}
      </div>

      <div class="section-title">3 · Command surface</div>
      <div class="card">
        ${COMMANDS.map((c) => `
          <div class="kv"><span class="k small">${esc(c.id)} <span class="tiny muted">${esc(c.label)}</span>${c.gate ? ' <span class="chip tiny warn">gated</span>' : ''}</span>
            <span class="switch ${getState().comms?.commands?.[c.id] ? 'on' : ''}" role="switch" aria-checked="${getState().comms?.commands?.[c.id] ? 'true' : 'false'}" data-act="comms-set-command" data-cmd="${esc(c.id)}"></span></div>`).join('')}
      </div>

      <div class="section-title">4 · Delivery & safety</div>
      <div class="card">
        <div class="kv"><span class="k">Signature check</span><span class="strong small">${esc(channel.signature)}</span></div>
        <div class="kv"><span class="k">Capabilities</span><span class="strong small">${[caps.outbound && 'outbound', caps.inbound && 'inbound', caps.signature && 'verify', caps.local && 'local'].filter(Boolean).join(' · ')}</span></div>
        <div class="kv"><span class="k">Rate limit</span><span class="strong small">${commsState().rateLimitPerMin || 20}/min per channel</span></div>
        <div class="kv"><span class="k">Token redaction in logs</span><span class="strong small">${commsState().redactLogs ? 'on' : 'off'}</span></div>
        ${rec.lastTest ? `<div class="kv"><span class="k">Last test</span><span class="strong small" style="text-align:right">${rec.lastTest.ok ? 'accepted' : 'failed'} · ${esc(rec.lastTest.detail || '')}</span></div>` : '<div class="tiny muted">No test has run yet.</div>'}
      </div>

      <div class="section-title">5 · Inbound endpoint</div>
      <div class="card mono tiny comms-endpoint">
        POST /api/v1/comms/${id}/inbound<br>
        ${channel.kind === 'local' ? 'same-origin session · no signature' : `signature: ${esc(channel.signature)}`}<br>
        replies are sent back on the same channel
      </div>
      <div class="tiny muted" style="margin-top:6px">These routes are specified, not implemented in the gateway yet — the panel and the adapters are; see docs/comms/channels.md.</div>`,
    foot: `
      <button class="btn" data-act="comms-save" data-id="${id}">${icon('check', 15)} Save</button>
      <button class="btn grow primary" data-act="comms-test" data-id="${id}">${icon('send', 15)} Send test</button>`,
  });
}

/* ---------- command configuration sheet ---------- */
function commandSheet() {
  const comms = commsState();
  openSheet({
    title: 'Channel command surface',
    body: `
      <div class="tiny muted">Commands a channel may run. Gated commands always require an in-app confirmation, whatever the channel.</div>
      ${COMMANDS.map((c) => `
        <div class="kv"><span class="k small">${esc(c.id)} · ${esc(c.label)}${c.gate ? ' <span class="chip tiny warn">gated</span>' : ''}</span>
          <span class="switch ${comms.commands?.[c.id] ? 'on' : ''}" role="switch" aria-checked="${comms.commands?.[c.id] ? 'true' : 'false'}" data-act="comms-set-command" data-cmd="${esc(c.id)}"></span></div>`).join('')}`,
  });
}

/* ---------- actions ---------- */
on('comms-open', (el, ds) => channelSheet(ds.id));
on('comms-save', (el, ds) => {
  const sheet = document.querySelector('.sheet.open');
  if (!sheet) return;
  const patch = {};
  sheet.querySelectorAll('[data-cf]').forEach((input) => {
    if (input.dataset.secret === '1' && /^••••/.test(input.value)) return; // untouched masked secret
    patch[input.dataset.cf] = input.value;
  });
  const out = saveChannelConfig(ds.id, patch);
  if (!out.ok) return toast(out.error, 'bad');
  closeAllSheets();
  toast('Saved — not verified until a live test succeeds', 'warn');
  rerender();
});
on('comms-toggle', (el, ds) => {
  const out = toggleChannel(ds.id);
  if (!out.ok) toast(out.error, 'bad');
  else toast(`${getChannel(ds.id)?.label} ${out.enabled ? 'enabled' : 'disabled'}`, out.enabled ? 'ok' : '');
  rerender();
});
on('comms-test', async (el, ds) => {
  const channel = getChannel(ds.id);
  const btn = el;
  if (btn) { btn.disabled = true; btn.textContent = 'Testing…'; }
  const result = await sendTest(ds.id);
  closeAllSheets();
  toast(
    result.ok ? `${channel?.label}: ${result.detail}` : `${channel?.label} failed — ${result.error}`,
    result.ok ? 'ok' : 'bad'
  );
  rerender();
});
on('comms-route-copilot', (el, ds) => {
  setState((s) => {
    const rec = s.comms.channels[ds.id];
    rec.routing = rec.routing || { copilot: true, agents: [] };
    rec.routing.copilot = !rec.routing.copilot;
  }, 'comms-route-copilot');
  rerender();
});
on('comms-route-agent', (el, ds) => {
  const current = (record(ds.id).routing?.agents || []).includes(ds.agent);
  routeAgent(ds.id, ds.agent, !current);
  rerender();
});
on('comms-set-command', (el, ds) => {
  const current = Boolean(commsState().commands?.[ds.cmd]);
  setCommandAllowed(ds.cmd, !current);
  rerender();
});
on('comms-commands', () => commandSheet());

/** Deep link used by the legacy Telegram route and by Copilot navigation. */
export function openCommsChannel(id) {
  import('./main.js').then((m) => m.navigate('comms')).then(() => setTimeout(() => channelSheet(id), 90));
}

/** Test seams. */
export const commsInternals = { channelSheet, commandSheet, channelTile, statusChip };
