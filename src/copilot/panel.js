/* ============ Copilot panel: FAB target, floating panel, cards, holographic empty state ============
 * Master spec §2 / §3. One panel instance, mounted outside the routed view so navigation never
 * destroys a draft. All rendering is escaped string HTML; no stored text is trusted as markup.
 */
import '../copilot.css';
import { getState, setState, esc, icon, now, uid } from '../core.js';
import { toast, actions as shellActions } from '../shell.js';
import { MODES, SUGGESTIONS, handle, runProposal, cancelProposal, proposalExpired, resolveMode, modeMeta } from './orchestrator.js';
import { getRuntime, probeGateway, subscribeRuntime, runtimeLabel } from './runtime.js';
import { getAuth, isAuthenticated, subscribeAuth } from '../auth.js';
import { isApiMode } from '../api.js';
import { saveWorking, getWorking, memorySummary, exportMemory, redact } from './memory.js';
import { knowledgeStats } from './knowledge.js';
import { STATUS_LABEL } from './capabilities.js';
import { holoStageIn, copilotModeIn, copilotOut, fabPulse, motionEnabled, toastIn } from '../motion.js';
import { sfx } from '../sound.js';

const session = {
  open: false,
  mode: 'ask',
  route: 'home',
  history: [],
  draft: '',
  pending: false,
  details: false,
  minimized: false,
  advanced: false,
  listening: false,
  voiceStatus: '',
  lastSent: '',
};

let layer = null;
let panel = null;
let workEl = null;
let pendingTimer = null;
let draftTimer = null;
let runtimeUnsub = null;
let runtimeUnsubAuth = null;

function matchesNarrow() {
  try {
    return Boolean(globalThis.matchMedia?.('(max-width: 899px)')?.matches);
  } catch {
    return false;
  }
}

const ROUTE_LABEL = {
  home: 'Command Deck', agents: 'Agents', teams: 'Teams & Swarms', tasks: 'Kanban', chat: 'Chat',
  skills: 'Skills', models: 'Models', plugins: 'Plugins', telegram: 'Telegram', analytics: 'Analytics',
  artifacts: 'Files', terminal: 'Terminal', settings: 'Settings',
};

const STATUS_LABEL_CARD = {
  verified: 'verified', observed: 'observed', inferred: 'inferred', unknown: 'unknown',
  ok: 'ok', failed: 'failed', blocked: 'blocked', warn: 'warning', info: 'info', bad: 'blocked',
};

function tone(status) {
  if (['verified', 'ok', 'available', 'reachable'].includes(status)) return 'ok';
  if (['observed', 'info', 'demo', 'checking'].includes(status)) return 'info';
  if (['inferred', 'warn', 'unconfigured', 'unverified', 'cancelled'].includes(status)) return 'warn';
  return 'bad';
}

const badge = (status) =>
  `<span class="cp-badge ${tone(status)}" title="status: ${esc(status)}">${esc(STATUS_LABEL_CARD[status] || STATUS_LABEL[status] || status)}</span>`;

/** Escape first, then allow the tiny inline markup Copilot emits. */
function md(text) {
  return esc(redact(text).text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code class="code">$1</code>')
    .replace(/\n/g, '<br>');
}

function rowsOf(card) {
  return typeof card.rows === 'function' ? card.rows() : card.rows || [];
}

function currentRoute() {
  try {
    const raw = (globalThis.location?.hash || '').replace(/^#\/?/, '');
    const route = raw.split('/')[0];
    return ROUTE_LABEL[route] ? route : 'home';
  } catch {
    return 'home';
  }
}

/* ---------- message helpers ---------- */
function pushMessage(msg) {
  const message = { id: msg.id || uid('cp-msg'), ts: now(), ...msg };
  session.history.push(message);
  return message;
}

function findMessage(id) {
  return session.history.find((m) => m.id === id) || null;
}

/* ---------- panel skeleton ---------- */
function panelHTML() {
  const voiceSupported = Boolean(recognitionCtor());
  return `
    <div class="cp-scrim" data-cp="dismiss" aria-hidden="true"></div>
    <section class="cp-panel" role="dialog" aria-modal="true" aria-label="Advanced Copilot" tabindex="-1"
             data-blank="true" data-mode="${esc(session.mode)}" data-min="false" data-view="stage" id="copilot-panel">
      <div class="cp-holo" aria-hidden="true">
        <img class="cp-holo-image" data-holo="image" src="./media/hologram.jpg" alt="" decoding="async" draggable="false">
        <span class="cp-holo-veil"></span>
        <span class="cp-holo-ring r1" data-holo="ring"></span>
        <span class="cp-holo-ring r2" data-holo="ring"></span>
        <span class="cp-holo-ring r3" data-holo="ring"></span>
        <span class="cp-holo-grid"></span>
        <span class="cp-holo-scan" data-holo="scan"></span>
        <span class="cp-blob b1"></span><span class="cp-blob b2"></span>
      </div>

      <header class="cp-head">
        <div class="cp-mark" aria-hidden="true">${icon('spark', 18)}</div>
        <div class="grow">
          <button class="cp-title" id="copilot-title" data-cp="toggle-advanced" aria-expanded="false"
                  aria-controls="cp-body" aria-label="Advanced Copilot — show or hide the controls">
            <span class="cp-title-text">Advanced Copilot</span>
            <span class="cp-title-hint" id="cp-title-hint">Tap to show controls</span>
          </button>
          <div class="cp-runtime" id="cp-runtime"></div>
        </div>
        <button class="cp-icon" data-cp="details" aria-label="Details, references and memory" aria-expanded="false">${icon('doc', 18)}</button>
        <button class="cp-icon" data-cp="close" aria-label="Close Advanced Copilot">${icon('x', 18)}</button>
      </header>

      <div class="cp-voice-dock" id="cp-voice-dock">
        <button class="cp-mic" data-cp="voice" data-holo="mic" aria-pressed="false"
                aria-label="${voiceSupported ? 'Speak to Copilot' : 'Voice capture is unavailable in this browser'}">
          <span class="cp-mic-halo" aria-hidden="true"></span>
          <span class="cp-mic-ico" aria-hidden="true">${icon('mic', 30)}</span>
          <span class="cp-mic-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
        </button>
        <div class="cp-stage-caption" data-holo="caption">
          <strong>${session.voiceStatus ? 'Voice input' : 'Tap and speak'}</strong>
          <span id="cp-voice-status" role="status" aria-live="polite">${esc(session.voiceStatus || voiceStatusText())}</span>
        </div>
        <button class="cp-stage-link" data-cp="toggle-advanced">Or type instead ${icon('right', 14)}</button>
      </div>

      <div class="cp-body" id="cp-body">
        <div class="cp-modes" id="cp-modes" role="tablist" aria-label="Copilot mode"></div>
        <div class="cp-context" id="cp-context"></div>
        <div class="cp-work" id="copilot-work" aria-live="polite" aria-busy="false"></div>
        <div class="cp-details" id="cp-details" hidden></div>
        <div class="cp-tray" id="cp-tray" aria-label="Quick actions"></div>
        <form class="cp-composer" id="cp-form" novalidate>
          <textarea class="cp-input" id="copilot-input" rows="1" maxlength="2000"
                    aria-label="Message Copilot" placeholder="Ask about this screen…"></textarea>
          <button class="cp-voice" type="button" data-cp="voice" aria-label="${voiceSupported ? 'Speak to Copilot' : 'Voice capture is unavailable in this browser'}">${icon('mic', 18)}</button>
          <button class="cp-send" type="submit" aria-label="Send message">${icon('send', 18)}</button>
        </form>
      </div>
    </section>`;
}

/* ---------- voice capture ----------
 * Speech *input* has one honest caveat: every browser recogniser sends audio to a network service.
 * So it is opt-in per browser, stated before it is used, refused offline, and never pretended when
 * the API is missing. Text-to-speech (Voice Studio) is separate and always on-device.
 */
function recognitionCtor() {
  try {
    return globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;
  } catch {
    return null;
  }
}

const voiceConsent = () => {
  try {
    return getState()?.settings?.voice?.networkRecognitionConsent === true;
  } catch {
    return false;
  }
};

function voiceStatusText() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'Offline: voice capture needs a connection, so type instead.';
  }
  if (!recognitionCtor()) {
    return 'Voice capture is unavailable here — this browser has no speech recogniser. Type, or open Voice Studio to hear replies.';
  }
  if (!voiceConsent()) {
    return 'Voice input uses your browser’s speech service, which sends audio to the network. Tap the mic to review and allow it.';
  }
  return 'Ready — tap the mic and speak. Audio goes to your browser’s speech service.';
}

function paintVoiceStatus() {
  const el = panel?.querySelector('#cp-voice-status');
  if (el) el.textContent = session.voiceStatus || voiceStatusText();
  const mic = panel?.querySelector('.cp-mic');
  if (mic) {
    mic.dataset.state = session.listening ? 'listening' : 'idle';
    mic.setAttribute('aria-pressed', String(session.listening));
  }
}

function showVoiceConsent() {
  const dock = panel?.querySelector('#cp-voice-dock');
  if (!dock || dock.querySelector('.cp-consent')) return;
  const card = document.createElement('div');
  card.className = 'cp-consent';
  card.innerHTML = `
    <div class="cp-consent-title">${icon('shield', 15)} Allow voice input?</div>
    <p>Your browser's speech service receives the audio. Nothing else is sent, and nothing is stored
       here beyond this choice. Turn it off again from Settings → Voice &amp; speech.</p>
    <div class="row" style="gap:8px">
      <button class="btn sm grow" data-cp="voice-consent-deny">Not now</button>
      <button class="btn sm grow primary" data-cp="voice-consent-allow">Allow voice input</button>
    </div>`;
  dock.appendChild(card);
  toastIn(card);
}

function clearVoiceConsent() {
  panel?.querySelector('.cp-consent')?.remove();
}

function stopListening(reason = '') {
  session.listening = false;
  try { session.recognition?.stop?.(); } catch { /* already stopped */ }
  session.recognition = null;
  if (reason) session.voiceStatus = reason;
  paintVoiceStatus();
  sfx.listen(false);
}

function startListening() {
  const Ctor = recognitionCtor();
  if (!Ctor) { session.voiceStatus = voiceStatusText(); paintVoiceStatus(); sfx.warn(); return; }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    session.voiceStatus = 'Offline: voice capture needs a connection. Type instead.';
    paintVoiceStatus();
    sfx.warn();
    return;
  }
  if (!voiceConsent()) { showVoiceConsent(); return; }
  let recognition;
  try {
    recognition = new Ctor();
  } catch {
    session.voiceStatus = 'This browser refused to start voice capture.';
    paintVoiceStatus();
    sfx.bad();
    return;
  }
  recognition.lang = (getState()?.settings?.voice?.lang || (typeof navigator !== 'undefined' && navigator.language) || 'en-US');
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;
  session.recognition = recognition;
  session.listening = true;
  session.voiceStatus = 'Listening… speak now.';
  paintVoiceStatus();
  sfx.listen(true);

  recognition.onresult = (event) => {
    const transcript = [...(event.results || [])].map((r) => r[0]?.transcript || '').join(' ').trim();
    session.voiceStatus = transcript ? `“${transcript}”` : 'Listening…';
    paintVoiceStatus();
    const final = [...(event.results || [])].some((r) => r.isFinal);
    if (final && transcript) {
      stopListening(`Heard “${transcript}”.`);
      showAdvanced(true);
      const input = panel?.querySelector('#copilot-input');
      if (input) input.value = transcript;
      send(transcript);
    }
  };
  recognition.onerror = (event) => {
    const code = event?.error || 'unknown';
    const message = {
      'not-allowed': 'Microphone permission was refused by the browser.',
      'service-not-allowed': 'The browser blocked its speech service.',
      network: 'The speech service could not be reached (audio is processed online).',
      'no-speech': 'No speech was detected. Tap the mic and try again.',
      aborted: 'Voice capture stopped.',
      'audio-capture': 'No microphone was found on this device.',
    }[code] || `Voice capture failed (${code}).`;
    stopListening(message);
    sfx.bad();
  };
  recognition.onend = () => {
    if (session.listening) stopListening('Voice capture ended.');
  };
  try {
    recognition.start();
  } catch {
    stopListening('This browser refused to start voice capture.');
    sfx.bad();
  }
}

/* ---------- static-ish regions ---------- */
function paintRuntime() {
  if (!panel) return;
  const rt = getRuntime();
  const el = panel.querySelector('#cp-runtime');
  if (el) {
    const auth = getAuth();
    const who = isApiMode()
      ? isAuthenticated()
        ? ` · ${auth.principal.role} (${auth.principal.name})`
        : ` · ${auth.status}`
      : ' · demo, unenforced';
    el.innerHTML = `<span class="cp-dot ${rt.gateway.status === 'reachable' ? 'ok' : rt.gateway.status === 'checking' ? 'run' : 'warn'}"></span>${esc(runtimeLabel(rt) + who)}`;
  }
  const ctxEl = panel.querySelector('#cp-context');
  if (ctxEl) ctxEl.innerHTML = contextHTML();
}

function contextHTML() {
  const s = getState();
  const pend = s.approvals.filter((a) => a.status === 'pending').length;
  const rt = getRuntime();
  return `
    <span class="cp-chip" title="Current screen">${icon('board', 13)}${esc(ROUTE_LABEL[session.route] || session.route)}</span>
    <button class="cp-chip ${pend ? 'warn' : ''}" data-cp="ask-approvals" title="Pending approval gates">${icon('shield', 13)}${pend} pending</button>
    <button class="cp-chip ${rt.gateway.status === 'reachable' ? 'ok' : ''}" data-cp="refresh-runtime" title="Probe the gateway health endpoint">${icon('plug', 13)}${esc(rt.gateway.status)}</button>
    <span class="cp-chip ghost" title="Workspace scope">${esc(s.settings.workspaceName)}</span>`;
}

function paintModes() {
  if (!panel) return;
  const el = panel.querySelector('#cp-modes');
  if (!el) return;
  el.innerHTML = MODES.map((m) => {
    const active = m.id === session.mode;
    const blocked = m.id === 'training' || m.id === 'voice';
    return `<button class="cp-mode ${active ? 'active' : ''}" role="tab" aria-selected="${active}"
              data-cp="mode" data-mode="${m.id}" title="${esc(m.hint)}">
              ${icon(m.icon, 15)}<span>${esc(m.label)}</span>${blocked ? '<i class="cp-mode-flag" aria-hidden="true"></i>' : ''}
            </button>`;
  }).join('');
}

function paintTray() {
  if (!panel) return;
  const el = panel.querySelector('#cp-tray');
  if (!el) return;
  // Each tray action declares the mode it belongs to, so a chip never fires an intent the
  // active mode cannot handle.
  const actions = [
    ['explain this screen', 'Explain screen', 'ask'],
    ['diagnose', 'Diagnose', 'operate'],
    ['status', 'Status', 'ask'],
    ['pending approvals', 'Approvals', 'ask'],
    ['create agent Nova', 'New agent', 'operate'],
  ];
  el.innerHTML =
    `<div class="cp-tray-row">${actions
      .map(
        ([q, label, mode]) =>
          `<button class="cp-chip" data-cp="suggest" data-q="${esc(q)}" data-mode="${mode}">${esc(label)}</button>`
      )
      .join('')}
      <button class="cp-chip" data-cp="quick-create">${icon('plus', 13)}Quick create</button></div>`;
}

function paintDetails() {
  if (!panel) return;
  const el = panel.querySelector('#cp-details');
  const btn = panel.querySelector('[data-cp="details"]');
  if (!el) return;
  el.hidden = !session.details;
  if (btn) btn.setAttribute('aria-expanded', String(session.details));
  if (!session.details) return;
  const rt = getRuntime();
  const mem = memorySummary();
  const ks = knowledgeStats();
  el.innerHTML = `
    <div class="cp-detail-grid">
      <div><span class="k">Gateway</span><span>${esc(rt.gateway.status)} · ${esc(rt.gateway.url)}</span></div>
      <div><span class="k">Checked</span><span>${rt.gateway.checkedAt ? new Date(rt.gateway.checkedAt).toLocaleTimeString() : 'never'}</span></div>
      <div><span class="k">Store</span><span>${esc(rt.store.detail)}</span></div>
      <div><span class="k">Knowledge</span><span>${ks.total} entries · ${ks.sources} sources · ${esc(ks.version)}</span></div>
      <div><span class="k">Memory</span><span>${mem.episodes}/${mem.cap} episodes · ${esc(mem.storage)}</span></div>
      <div><span class="k">Mode</span><span>${esc(modeMeta(session.mode).label)} — selection is not authorisation</span></div>
    </div>
    <div class="cp-detail-actions">
      <button class="cp-chip" data-cp="refresh-runtime">${icon('plug', 13)}Re-probe gateway</button>
      <button class="cp-chip" data-cp="export-memory">${icon('download', 13)}Export memory</button>
      <button class="cp-chip" data-cp="clear-memory">${icon('trash', 13)}Clear memory</button>
    </div>
    <p class="cp-note">Copilot never stores credentials. Secret-like strings are redacted before anything is written.</p>`;
}

/* ---------- cards ---------- */
function refsHTML(refs = []) {
  if (!refs.length) return '';
  return `<div class="cp-refs"><div class="cp-refs-title">Sources</div>${refs
    .map((r) => `<div class="cp-ref">${badge(r.status || 'unknown')}<span class="cp-ref-label">${esc(r.label)}</span><code>${esc(r.ref)}</code></div>`)
    .join('')}</div>`;
}

function answerCardHTML(card) {
  return `<div class="cp-card">
    <div class="cp-card-head">
      <span class="cp-card-title">${esc(card.title || 'Answer')}</span>
      ${badge(card.confidence || 'unknown')}
    </div>
    <div class="cp-card-body">${md(card.text)}</div>
    ${refsHTML(card.refs)}
  </div>`;
}

function knowledgeCardHTML(card) {
  const results = card.results || [];
  return `<div class="cp-card">
    <div class="cp-card-head">
      <span class="cp-card-title">Knowledge · “${esc(card.query)}”</span>
      <span class="cp-badge info">${results.length} hit${results.length === 1 ? '' : 's'}</span>
    </div>
    <div class="cp-card-body">${md(card.text)}</div>
    ${results
      .map(
        (r) => `<div class="cp-kb">
          <div class="cp-kb-head"><span class="cp-kb-title">${esc(r.title)}</span>${badge(r.status)}</div>
          <div class="cp-kb-excerpt">${md(r.excerpt)}</div>
          <div class="cp-kb-meta">${esc(r.module)} · ${esc(r.type)} · updated ${esc(r.updated)} · ${esc(r.version)}</div>
          ${refsHTML(r.sources.map((s) => ({ ...s, status: r.status })))}
        </div>`
      )
      .join('')}
    <p class="cp-note">${
      results.length
        ? 'Every result is a static, reviewed entry. Nothing here is generated, so citations are real file paths.'
        : 'No entry matched. Copilot refuses to fabricate an answer — rephrase or browse the pack.'
    }</p>
  </div>`;
}

function proposalCardHTML(card, msg) {
  const expired = proposalExpired(card);
  const done = card.resolved;
  const rows = rowsOf(card);
  const editable = card.editable || [];
  const risky = card.risk === 'consequential';
  const armNeeded = risky && !card.armed;
  return `<div class="cp-card cp-proposal" data-risk="${esc(card.risk)}">
    <div class="cp-card-head">
      <span class="cp-card-title">${esc(card.title)}</span>
      <span class="cp-badge ${risky ? 'warn' : 'info'}">${esc(card.risk)}</span>
    </div>
    <div class="cp-card-body">${md(card.summary || '')}</div>
    <div class="cp-rows">
      ${rows
        .map(([k, v]) => {
          const field = editable.find((f) => f.toLowerCase() === String(k).toLowerCase());
          return field && card.editing && !done && !expired
            ? `<label class="cp-row edit"><span class="k">${esc(k)}</span>
                 <input class="input cp-param" data-cp="param" data-msg="${msg.id}" data-field="${esc(field)}" value="${esc(card.params?.[field] ?? v)}" /></label>`
            : `<div class="cp-row"><span class="k">${esc(k)}</span><span class="strong">${esc(v)}</span></div>`;
        })
        .join('')}
    </div>
    <div class="cp-meta-grid">
      ${card.effects ? `<div><span class="k">Effects</span><span>${esc(card.effects)}</span></div>` : ''}
      ${card.permissions ? `<div><span class="k">Permissions</span><span>${esc(card.permissions)}</span></div>` : ''}
      ${card.rollback ? `<div><span class="k">Rollback</span><span>${esc(card.rollback)}</span></div>` : ''}
    </div>
    ${
      risky && card.armed && !done
        ? `<div class="cp-warn">Second confirmation required. This is a consequential action: check the target and effects above. It runs against <strong>demo state</strong>, not a live runtime.</div>`
        : ''
    }
    ${
      done
        ? `<div class="cp-card-foot"><span class="cp-chip ghost">${done === 'confirmed' ? 'Executed' : done === 'cancelled' ? 'Cancelled' : 'Expired'}</span></div>`
        : expired
          ? `<div class="cp-card-foot"><span class="cp-badge warn">expired</span><span class="cp-note-inline">Ask again to review current values.</span></div>`
          : `<div class="cp-card-foot">
              <button class="btn sm" data-cp="cancel" data-msg="${msg.id}">Cancel</button>
              ${editable.length && !card.editing ? `<button class="btn sm" data-cp="edit" data-msg="${msg.id}">Edit</button>` : ''}
              ${card.editing ? `<button class="btn sm" data-cp="review" data-msg="${msg.id}">Review</button>` : ''}
              ${
                armNeeded
                  ? `<button class="btn sm primary" data-cp="arm" data-msg="${msg.id}">Review &amp; approve</button>`
                  : `<button class="btn sm primary" data-cp="confirm" data-msg="${msg.id}">${esc(card.confirm || 'Confirm')}</button>`
              }
            </div>`
    }
    <div class="cp-expiry">Valid for 5 minutes · bound to the values shown · ${risky ? 'two-step' : 'single-step'} confirmation</div>
  </div>`;
}

function resultCardHTML(card) {
  const icons = { ok: icon('check', 14), failed: icon('x', 14), blocked: icon('shield', 14), cancelled: icon('x', 14) };
  return `<div class="cp-card cp-result" data-status="${esc(card.status)}">
    <div class="cp-card-head">
      <span class="cp-card-title">${esc(card.title)}</span>
      ${badge(card.status)}
    </div>
    <div class="cp-card-body">${md(card.summary || '')}</div>
    ${
      (card.steps || []).length
        ? `<ol class="cp-steps">${card.steps
            .map(
              (s) => `<li class="cp-step ${esc(s.state)}"><span class="cp-step-ico">${icons[s.state] || icon('check', 14)}</span>
                <span class="grow">${esc(s.label)}${s.detail ? `<span class="cp-step-detail">${esc(s.detail)}</span>` : ''}</span>
                <span class="cp-badge ${tone(s.state)}">${esc(s.state === 'blocked' ? 'blocked' : s.state)}</span></li>`
            )
            .join('')}</ol>`
        : ''
    }
    ${card.verify ? `<div class="cp-verify">${icon('check', 13)}<span><strong>How to verify:</strong> ${esc(card.verify)}</span></div>` : ''}
    ${card.simulated ? `<div class="cp-warn soft">Simulated runtime — no gateway call, no model call, no spend.</div>` : ''}
    ${refsHTML(card.refs)}
  </div>`;
}

function diagnosticCardHTML(card) {
  return `<div class="cp-card">
    <div class="cp-card-head"><span class="cp-card-title">${esc(card.title || 'Diagnostics')}</span><span class="cp-badge info">live checks</span></div>
    <div class="cp-checks">
      ${(card.checks || [])
        .map(
          (c) => `<div class="cp-check"><span class="cp-dot ${tone(c.status)}"></span>
            <div class="grow"><div class="small strong">${esc(c.label)}</div><div class="tiny muted">${esc(c.detail)}</div></div>
            ${badge(c.status)}</div>`
        )
        .join('')}
    </div>
    <div class="cp-card-body">${md(card.verdict || '')}</div>
    ${refsHTML(card.refs)}
  </div>`;
}

function capabilityCardHTML(card) {
  const cap = card.capability || {};
  return `<div class="cp-card cp-capability" data-status="${esc(cap.status)}">
    <div class="cp-card-head"><span class="cp-card-title">${esc(cap.label || 'Capability')}</span>${badge(cap.status || 'unknown')}</div>
    <div class="cp-card-body">${md(card.text || cap.summary || '')}</div>
    ${cap.summary && card.text && card.text !== cap.summary ? `<div class="cp-card-body muted">${md(cap.summary)}</div>` : ''}
    ${cap.detail ? `<details class="cp-acc"><summary>Why this status</summary><div>${md(cap.detail)}</div></details>` : ''}
    ${
      (cap.requirements || []).length
        ? `<details class="cp-acc" open><summary>Required before this can work</summary><ul>${cap.requirements
            .map((r) => `<li>${esc(r)}</li>`)
            .join('')}</ul></details>`
        : ''
    }
    ${cap.evidence ? `<div class="cp-evidence"><span class="k">Evidence</span><code>${esc(cap.evidence)}</code></div>` : ''}
    <p class="cp-note">No job is created and nothing is simulated here. Status comes from the capability registry, not from a request.</p>
  </div>`;
}

function activityCardHTML(card) {
  const mem = card.memory || {};
  const outcomeTone = { ok: 'ok', failed: 'bad', blocked: 'warn', cancelled: 'warn', info: 'info' };
  return `<div class="cp-card">
    <div class="cp-card-head"><span class="cp-card-title">Activity</span><span class="cp-badge info">${mem.episodes ?? 0} recorded</span></div>
    <div class="cp-card-body">${md(card.text)}</div>
    ${
      (card.episodes || []).length
        ? `<div class="cp-section">Copilot actions (this browser)</div>${card.episodes
            .map(
              (e) => `<div class="cp-episode">
                <span class="cp-badge ${outcomeTone[e.outcome] || 'info'}">${esc(e.outcome)}</span>
                <div class="grow"><div class="small">${esc(e.intent || e.summary)}</div>
                  <div class="tiny muted">${new Date(e.ts).toLocaleString()} · ${esc(e.mode)} · ${esc(e.risk)}</div>
                  ${(e.evidence || []).length ? `<div class="tiny muted">evidence: ${esc(e.evidence.join(' · '))}</div>` : ''}
                </div></div>`
            )
            .join('')}`
        : ''
    }
    ${(card.approvals || []).length
      ? `<div class="cp-section">Pending approvals</div>${card.approvals
          .map((a) => `<div class="cp-episode"><span class="cp-badge warn">${esc(a.risk)}</span><div class="grow"><div class="small">${esc(a.action)} · ${esc(a.target)}</div><div class="tiny muted">${esc(a.id)} · from ${esc(a.principal)}</div></div></div>`)
          .join('')}`
      : ''}
    ${(card.events || []).length
      ? `<div class="cp-section">App event feed</div>${card.events
          .map((ev) => `<div class="cp-event"><span class="cp-dot idle"></span><div class="grow"><div class="tiny">${esc(ev.text)}</div><div class="tiny muted">${new Date(ev.ts).toLocaleTimeString()}</div></div></div>`)
          .join('')}`
      : ''}
  </div>`;
}

function cardHTML(card, msg) {
  if (!card) return '';
  switch (card.type) {
    case 'answer': return answerCardHTML(card);
    case 'knowledge': return knowledgeCardHTML(card);
    case 'proposal': return proposalCardHTML(card, msg);
    case 'result': return resultCardHTML(card);
    case 'diagnostic': return diagnosticCardHTML(card);
    case 'capability': return capabilityCardHTML(card);
    case 'activity': return activityCardHTML(card);
    default: return `<div class="cp-card"><div class="cp-card-body">${md(card.text || '')}</div></div>`;
  }
}

function messageHTML(m) {
  if (m.role === 'user') {
    return `<div class="cp-msg me"><div class="cp-bubble">${md(m.text)}</div>
      <div class="cp-msg-meta">You · ${new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div></div>`;
  }
  const speakable = [m.text, m.card?.text, m.card?.title].filter(Boolean).join(' ').slice(0, 2000);
  return `<div class="cp-msg bot">
    <div class="cp-bubble">${m.text && !m.card ? md(m.text) : ''}${cardHTML(m.card, m)}</div>
    <div class="cp-msg-meta">
      <span class="cp-msg-meta-text">Copilot · ${esc(modeMeta(m.mode || session.mode).label)} mode · ${new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      <button class="cp-speak" type="button" data-cp="speak" data-msg="${esc(m.id)}" data-text="${esc(speakable)}" aria-label="Read this reply aloud">${icon('mic', 15)}<span>Speak</span></button>
    </div>
  </div>`;
}

function emptyStateHTML() {
  const ks = knowledgeStats();
  const suggestions = SUGGESTIONS[session.mode] || SUGGESTIONS.ask;
  return `<div class="cp-empty">
    <div class="cp-empty-mark" aria-hidden="true">${icon('spark', 22)}</div>
    <h3 class="cp-empty-title">${esc(modeMeta(session.mode).label)}</h3>
    <p class="cp-empty-sub">${esc(modeMeta(session.mode).hint)}</p>
    <div class="cp-suggests">
      ${suggestions.map((q) => `<button class="cp-chip" data-cp="suggest" data-q="${esc(q)}">${esc(q)}</button>`).join('')}
    </div>
    <p class="cp-empty-foot">Grounded in ${ks.total} reviewed knowledge entries · ${esc(ks.version)}<br>Deterministic answers, no model call. Runtime is labelled in the header.</p>
  </div>`;
}

function paintWork() {
  if (!workEl) return;
  const blank = session.history.length === 0;
  workEl.innerHTML = blank
    ? emptyStateHTML()
    : session.history.map(messageHTML).join('') +
      (session.pending
        ? `<div class="cp-msg bot"><div class="cp-bubble cp-pending"><span class="cp-dot run"></span>Working… <button class="cp-chip" data-cp="stop">Stop</button></div></div>`
        : '');
  const panelEl = panel;
  if (panelEl) {
    panelEl.dataset.blank = String(blank && !session.pending);
    panelEl.querySelector('#copilot-work').setAttribute('aria-busy', String(session.pending));
  }
  if (!blank) workEl.scrollTop = workEl.scrollHeight;
}

function paint() {
  if (!panel) return;
  panel.dataset.mode = session.mode;
  panel.dataset.min = String(session.minimized);
  panel.dataset.view = session.advanced ? 'advanced' : 'stage';
  // The overlay now covers the whole screen at every width, so it is always modal.
  panel.setAttribute('aria-modal', 'true');
  const title = panel.querySelector('#copilot-title');
  if (title) {
    title.setAttribute('aria-expanded', String(session.advanced));
    const hint = panel.querySelector('#cp-title-hint');
    if (hint) hint.textContent = session.advanced ? 'Tap to hide controls' : 'Tap to show controls';
  }
  paintVoiceStatus();
  const textarea = panel.querySelector('#copilot-input');
  if (textarea && textarea.value !== session.draft) textarea.value = session.draft;
  paintRuntime();
  paintModes();
  paintTray();
  paintDetails();
  paintWork();
}

/**
 * Stage ⇄ advanced. The stage is the immersive default (hologram + mic); advanced reveals every
 * control surface. Both directions animate, and the state is announced for screen readers.
 */
export function showAdvanced(next) {
  const value = Boolean(next);
  if (!panel) { session.advanced = value; return value; }
  if (value === session.advanced) return value;
  session.advanced = value;
  panel.dataset.view = value ? 'advanced' : 'stage';
  const title = panel.querySelector('#copilot-title');
  title?.setAttribute('aria-expanded', String(value));
  const hint = panel.querySelector('#cp-title-hint');
  if (hint) hint.textContent = value ? 'Tap to hide controls' : 'Tap to show controls';
  copilotModeIn(panel, value);
  if (value) {
    const input = panel.querySelector('#copilot-input');
    // Focus the composer only for explicit pointer/keyboard intent, never on automatic reveal.
    if (session.focusOnAdvanced && input) {
      input.focus({ preventScroll: true });
      session.focusOnAdvanced = false;
    }
  } else {
    panel.querySelector('#copilot-input')?.blur?.();
  }
  return value;
}

/** Public hook so other screens can open the Copilot directly in the conversation view. */
export const isAdvanced = () => session.advanced;

/* ---------- draft persistence ---------- */
function queueDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => saveWorking({ mode: session.mode, draft: session.draft }), 250);
}

function setDraft(value) {
  session.draft = String(value ?? '');
  queueDraftSave();
}

/* ---------- sending ---------- */
function submit() {
  if (session.pending) return; // Stop first; never silently drop a queued reply
  const input = panel?.querySelector('#copilot-input');
  const text = (input?.value ?? session.draft).trim();
  if (!text) return;
  if (input) input.value = '';
  send(text);
}

export function send(text) {
  const raw = String(text || '').trim();
  if (!raw || session.pending) return;
  session.lastSent = raw;
  session.route = currentRoute();
  pushMessage({ role: 'user', text: raw, mode: session.mode });
  setDraft('');
  session.pending = true;
  if (!session.advanced) showAdvanced(true);
  paint();
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    respond(raw).catch((err) => {
      session.pending = false;
      pushMessage({ role: 'copilot', text: `Copilot failed: ${err?.message || err}`, mode: session.mode });
      paint();
    });
  }, 220);
}

async function respond(raw) {
  let res;
  try {
    res = await handle(raw, { mode: session.mode, route: session.route, history: session.history });
  } catch (err) {
    res = { text: `Copilot failed to handle that: ${err?.message || err}`, card: null, mode: session.mode };
  }
  const finish = (card, text) => {
    session.pending = false;
    pushMessage({ role: 'copilot', text: text ?? res.text, card, mode: res.mode || session.mode });
    paint();
  };
  if (res.defer === 'diagnose') {
    import('./orchestrator.js')
      .then((m) => m.runDiagnostics())
      .then((card) => finish(card, 'Checks completed below — failures are reported as failures.'))
      .catch((err) => finish(null, `Diagnostics failed: ${err?.message || err}`));
    return;
  }
  finish(res.card || null, res.text);
}

function stopPending() {
  clearTimeout(pendingTimer);
  if (!session.pending) return;
  session.pending = false;
  pushMessage({ role: 'copilot', text: 'Stopped before answering. No action was prepared or executed.', mode: session.mode });
  paint();
}

/* ---------- proposal interactions ---------- */
function arm(msgId) {
  const msg = findMessage(msgId);
  if (!msg?.card) return;
  msg.card.armed = true;
  paint();
}

function confirm(msgId) {
  const msg = findMessage(msgId);
  if (!msg?.card) return;
  const card = msg.card;
  if (card.resolved) return;
  if (proposalExpired(card)) {
    card.resolved = 'expired';
    pushMessage({ role: 'copilot', text: 'That proposal expired, so it was not executed.', mode: session.mode });
    paint();
    return;
  }
  if (card.risk === 'consequential' && !card.armed) {
    arm(msgId);
    return;
  }
  card.resolved = 'confirmed';
  pushMessage({ role: 'copilot', text: 'Running the action…', mode: session.mode });
  paint();
  Promise.resolve(runProposal(card, { mode: session.mode }))
    .then((out) => {
      pushMessage({ role: 'copilot', text: out.text, card: out.card, mode: session.mode });
    })
    .catch((err) => {
      pushMessage({ role: 'copilot', text: `Action failed before completing: ${err?.message || err}. No change was confirmed.`, mode: session.mode });
    })
    .finally(() => {
      paint();
      import('../main.js').then((m) => m.rerender()).catch(() => {});
    });
}

function cancel(msgId) {
  const msg = findMessage(msgId);
  if (!msg?.card || msg.card.resolved) return;
  msg.card.resolved = 'cancelled';
  msg.card.armed = false;
  cancelProposal(msg.card, { mode: session.mode });
  pushMessage({ role: 'copilot', text: `Cancelled “${msg.card.title}”. Nothing was executed.`, mode: session.mode });
  paint();
}

function toggleEdit(msgId) {
  const msg = findMessage(msgId);
  if (!msg?.card) return;
  msg.card.editing = !msg.card.editing;
  if (msg.card.editing) msg.card.armed = false;
  paint();
}

/* ---------- modes ---------- */
export function setMode(modeId) {
  const next = resolveMode(modeId);
  if (next === session.mode) return;
  session.mode = next;
  session.details = false;
  saveWorking({ mode: next, draft: session.draft });
  paint();
}

/* ---------- open / close ---------- */
export function openCopilot({ mode, message } = {}) {
  if (mode) session.mode = resolveMode(mode);
  session.route = currentRoute();
  if (!session.draft) {
    const w = getWorking();
    if (w?.draft) session.draft = w.draft;
    if (!mode && session.history.length === 0) {
      if (w?.mode) session.mode = resolveMode(w.mode);
      else session.mode = resolveMode(getState().settings.copilotMode || 'ask');
    }
  }
  if (session.open && panel) {
    paint();
    if (message) send(message);
    return panel;
  }

  layer = document.createElement('div');
  layer.className = 'cp-layer';
  layer.innerHTML = panelHTML();
  document.body.appendChild(layer);
  panel = layer.querySelector('#copilot-panel');
  workEl = layer.querySelector('#copilot-work');
  session.open = true;

  const input = layer.querySelector('#copilot-input');
  input.value = session.draft;

  layer.addEventListener('click', onClick);
  layer.addEventListener('input', onInput);
  layer.addEventListener('keydown', onKeydown);
  layer.querySelector('#cp-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });

  const fab = document.querySelector('[data-act="copilot-open"]');
  fab?.setAttribute('aria-expanded', 'true');

  runtimeUnsub = () => {
    runtimeUnsubRuntime?.();
    runtimeUnsubAuth?.();
  };
  const runtimeUnsubRuntime = subscribeRuntime(() => paintRuntime());
  const runtimeUnsubAuth = subscribeAuth(() => {
    paintRuntime();
    paintTray();
  });
  paint();
  probeGateway().catch(() => {});
  // The stage always starts closed over a blank screen, then resolves into the hologram.
  session.advanced = false;
  panel.dataset.view = 'stage';
  holoStageIn(panel);
  fabPulse(fab);
  sfx.summon();
  // Move focus into the panel without summoning the mobile keyboard.
  panel.focus({ preventScroll: true });
  if (message) {
    showAdvanced(true);
    send(message);
  }
  return panel;
}

export function closeCopilot() {
  if (!session.open || !layer) return;
  clearTimeout(pendingTimer);
  session.pending = false;
  stopListening('');
  saveWorking({ mode: session.mode, draft: session.draft });
  runtimeUnsub?.();
  runtimeUnsub = null;
  // The live overlay leaves the DOM immediately (nothing stale stays clickable); a decorative copy
  // plays the collapse-toward-the-launcher exit.
  if (motionEnabled()) {
    const ghost = layer.cloneNode(true);
    ghost.classList.add('cp-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.removeAttribute('id');
    [ghost, ...ghost.querySelectorAll('[id]')].forEach((node) => node.removeAttribute('id'));
    [...ghost.querySelectorAll('button, input, textarea, a')].forEach((node) => {
      node.setAttribute('tabindex', '-1');
      node.disabled = true;
    });
    ghost.style.pointerEvents = 'none';
    document.body.appendChild(ghost);
    copilotOut(ghost);
  }
  layer.remove();
  layer = null;
  panel = null;
  workEl = null;
  session.open = false;
  session.advanced = false;
  session.voiceStatus = '';
  session.listening = false;
  sfx.close();
  const fab = document.querySelector('[data-act="copilot-open"]');
  fab?.setAttribute('aria-expanded', 'false');
  fab?.focus?.({ preventScroll: true });
}

export function toggleCopilot(options) {
  if (session.open) closeCopilot();
  else openCopilot(options);
}

export const isCopilotOpen = () => session.open;

/** Test/inspection hook — exposes only UI state, never stored text. */
export function copilotState() {
  return {
    open: session.open,
    mode: session.mode,
    route: session.route,
    messages: session.history.length,
    draft: session.draft,
    pending: session.pending,
    blank: session.history.length === 0,
    view: session.advanced ? 'advanced' : 'stage',
    listening: session.listening,
    cards: session.history.filter((m) => m.card).map((m) => m.card.type),
  };
}

export function resetCopilotSession() {
  closeCopilot();
  session.history = [];
  session.draft = '';
  session.mode = 'ask';
  session.pending = false;
  session.details = false;
  session.minimized = false;
  session.advanced = false;
  session.listening = false;
  session.voiceStatus = '';
  session.recognition = null;
}

/* ---------- events ---------- */
function onClick(e) {
  const t = e.target.closest('[data-cp]');
  if (!t) return;
  const act = t.dataset.cp;
  const msgId = t.dataset.msg;
  switch (act) {
    case 'close':
    case 'dismiss':
      closeCopilot();
      break;
    case 'toggle-advanced':
      // The title is the affordance: it swaps the immersive stage for the full control surface.
      session.focusOnAdvanced = session.advanced === false;
      showAdvanced(!session.advanced);
      sfx.open();
      break;
    case 'voice':
      if (session.listening) stopListening('Voice capture stopped.');
      else startListening();
      break;
    case 'voice-consent-allow': {
      setState((state) => {
        state.settings.voice = { ...(state.settings.voice || {}), networkRecognitionConsent: true };
      }, 'voice-consent');
      clearVoiceConsent();
      toast('Voice input allowed for this browser', 'ok');
      startListening();
      break;
    }
    case 'voice-consent-deny':
      clearVoiceConsent();
      session.voiceStatus = 'Voice input declined. Tap Advanced Copilot to type instead.';
      paintVoiceStatus();
      break;
    case 'details':
      session.details = !session.details;
      paintDetails();
      break;
    case 'mode':
      setMode(t.dataset.mode);
      break;
    case 'suggest':
      openCopilot();
      if (t.dataset.mode && t.dataset.mode !== session.mode) setMode(t.dataset.mode);
      send(t.dataset.q);
      break;
    case 'ask-approvals':
      validateAndSend('pending approvals');
      break;
    case 'refresh-runtime':
      probeGateway().then(() => {
        paintRuntime();
        paintDetails();
      });
      break;
    case 'export-memory': {
      const data = exportMemory();
      try {
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'copilot-memory.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        toast('Copilot memory exported', 'ok');
      } catch {
        toast('Export unavailable in this browser', 'bad');
      }
      break;
    }
    case 'clear-memory':
      setMode('activity');
      validateAndSend('clear memory');
      break;
    case 'quick-create':
      closeCopilot();
      if (typeof shellActions['quick-create'] === 'function') shellActions['quick-create']();
      break;
    case 'stop':
      stopPending();
      break;
    case 'speak': {
      // Real playback through Voice Studio's engine. Failures are announced, never swallowed.
      const text = t.dataset.text || '';
      import('../voice.js')
        .then((voice) => {
          const result = voice.speakText(text, {
            onError: (reason) => toast(reason, 'bad'),
          });
          if (result?.ok) t.dataset.state = 'speaking';
          else toast(result?.reason || 'Speech is unavailable in this browser.', 'warn');
        })
        .catch(() => toast('Voice Studio failed to load, so nothing was spoken.', 'bad'));
      break;
    }
    case 'voice-input': {
      // Speech recognition is deliberately absent: Chromium's recogniser uploads audio to a network
      // service, which would break the no-silent-upload rule. Say so instead of pretending.
      import('../voice.js')
        .then((voice) => {
          voice.openVoiceTab('overview');
          toast('Voice input is not implemented: the only browser recogniser uploads audio to a network service.', 'warn');
        })
        .catch(() => {});
      break;
    }
    case 'arm':
      arm(msgId);
      break;
    case 'confirm':
      confirm(msgId);
      break;
    case 'cancel':
      cancel(msgId);
      break;
    case 'edit':
      toggleEdit(msgId);
      break;
    case 'review':
      toggleEdit(msgId);
      break;
    default:
      break;
  }
}

function validateAndSend(text) {
  send(text);
}

function onInput(e) {
  const t = e.target;
  if (t.id === 'copilot-input') {
    setDraft(t.value);
    return;
  }
  if (t.dataset?.cp === 'param') {
    const msg = findMessage(t.dataset.msg);
    if (msg?.card) {
      // Editing re-arms review: the confirmation is bound to the values shown.
      msg.card.params = { ...msg.card.params, [t.dataset.field]: t.value };
      msg.card.armed = false;
    }
  }
}

function onKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeCopilot();
    return;
  }
  if (e.key === 'Tab') {
    if (!matchesNarrow()) return;
    const focusables = [...panel.querySelectorAll('button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.disabled && el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
    return;
  }
  if (e.target.id === 'copilot-input' && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
}

/* ---------- legacy API (terminal, views, tests) ---------- */
/**
 * Append a Copilot message and, optionally, a legacy action card
 * ({ title, risk, rows, confirm, run }). Kept for src/terminal.js and src/views2.js.
 */
export function copilotSay(text, actionCard = null) {
  let card = null;
  if (actionCard) {
    card = {
      type: 'proposal',
      title: actionCard.title || 'Action',
      summary: 'Legacy action card from another screen. Review before running.',
      risk: actionCard.risk === 'medium' || actionCard.risk === 'high' ? 'consequential' : 'reversible',
      rows: actionCard.rows || [],
      params: {},
      editable: [],
      effects: 'Runs the action handler supplied by the calling screen (demo store).',
      permissions: 'Demo store write.',
      rollback: 'Depends on the action; most are reversible local changes.',
      confirm: actionCard.confirm || 'Confirm',
      createdAt: now(),
      expiresAt: now() + 5 * 60 * 1000,
      armed: false,
      legacy: true,
      execute: () => {
        actionCard.run?.();
        return { status: 'ok', summary: `${actionCard.title || 'Action'} executed.`, steps: [{ label: actionCard.title || 'Action', state: 'ok' }] };
      },
    };
  }
  pushMessage({ role: 'copilot', text, card, mode: session.mode });
  if (session.open) paint();
  return card;
}

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    const next = currentRoute();
    if (next === session.route) return;
    session.route = next;
    if (session.open) paintRuntime();
  });
  window.__copilotSend = () => submit();
  window.__copilotChip = (q) => {
    openCopilot({ message: q });
  };
  window.__copilotConfirm = (idx) => {
    const msg = session.history[idx];
    if (msg?.id) confirm(msg.id);
  };
  window.__copilotCancel = (idx) => {
    const msg = session.history[idx];
    if (msg?.id) cancel(msg.id);
  };
}
