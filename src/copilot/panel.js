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
import * as convo from './conversation.js';
import * as actions from './actions.js';
import * as drafts from './drafts.js';
import * as plans from './plans.js';
import * as scripts from './scripts.js';
import * as voiceInput from './voiceInput.js';
import { captureSupport, startCapture } from '../voice/capture.js';

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
  recording: null,
  voiceCaps: null,
  voiceStatus: '',
  lastSent: '',
  // 'live' (a model answers) vs 'local' (the built-in engine answers); `gatewayState` says why.
  live: 'local',
  gatewayState: 'no-gateway',
  lastError: '',
};

let layer = null;
let panel = null;
let workEl = null;
let pendingTimer = null;
let draftTimer = null;
let runtimeUnsub = null;
let runtimeUnsubAuth = null;
let runtimeUnsubConvo = null;

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
  const voiceSupport = voicePath();
  const voiceSupported = voiceSupport.transport !== 'text';
  const micLabel = voiceSupport.transport === 'local-stt'
    ? 'Record a clip for the speech host on your gateway'
    : 'Speak to Copilot';
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
        <div class="cp-stage-caption" data-holo="caption">
          <strong>${session.voiceStatus ? 'Voice input' : 'Tap and speak'}</strong>
          <span id="cp-voice-status" role="status" aria-live="polite">${esc(session.voiceStatus || voiceStatusText())}</span>
        </div>
        <div class="cp-voice-row">
          <button class="cp-mic" data-cp="voice" data-holo="mic" aria-pressed="false"
                  aria-label="${voiceSupported ? micLabel : 'Voice capture is unavailable in this browser'}">
            <span class="cp-mic-halo" aria-hidden="true"></span>
            <span class="cp-mic-ico" aria-hidden="true">${icon('mic', 20)}</span>
            <span class="cp-mic-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
          </button>
          <button class="cp-stage-link" data-cp="toggle-advanced">Or type instead ${icon('right', 14)}</button>
        </div>
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
          <button class="cp-voice" type="button" data-cp="voice" aria-label="${voiceSupported ? micLabel : 'Voice capture is unavailable in this browser'}">${icon('mic', 18)}</button>
          <button class="cp-send" type="submit" aria-label="Send message">${icon('send', 18)}</button>
        </form>
      </div>
    </section>`;
}

/* ---------- voice capture ----------
 * Three transports, in the order the deployment earns them (see voiceInput.js): a speech host on the
 * operator's own gateway, then the browser recogniser (which is network-backed in every shipping
 * browser), then typing — always available, never gated. Each one states what happens to the audio
 * before it is used, and a failure in the local path is *reported* rather than re-routed to the network
 * one: re-sending a recording somewhere else is the exact thing the consent screen exists to prevent.
 */
function recognitionCtor() {
  try {
    return globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;
  } catch {
    return null;
  }
}

const voiceConsent = (kind = 'network') => {
  try {
    const settings = getState()?.settings?.voice || {};
    return kind === 'local'
      ? settings.localSttConsent === true
      : settings.networkRecognitionConsent === true;
  } catch {
    return false;
  }
};

/** The transport this device can actually use right now, with the sentence that explains it. */
function voicePath() {
  return voiceInput.resolvePath({
    capabilities: session.voiceCaps,
    support: captureSupport(globalThis),
    online: !(typeof navigator !== 'undefined' && navigator.onLine === false),
  });
}

function voiceStatusText() {
  if (session.recording) return `Recording — ${Math.round((session.recording.elapsedMs || 0) / 1000)}s. Tap the mic to stop.`;
  const path = voicePath();
  if (path.transport === 'local-stt') {
    return voiceConsent('local')
      ? 'Ready — tap the mic and speak. Audio goes to the speech host on your gateway and stays on your network.'
      : 'Tap the mic to record a clip for your gateway’s speech host. It stays on your network, and nothing is sent until you allow it.';
  }
  if (path.transport === 'browser-recognition') {
    return path.reason;
  }
  return path.reason || 'Voice input is unavailable here — type instead.';
}

function paintVoiceStatus() {
  const el = panel?.querySelector('#cp-voice-status');
  if (el) el.textContent = session.voiceStatus || voiceStatusText();
  const mic = panel?.querySelector('.cp-mic');
  if (mic) {
    const active = session.listening || Boolean(session.recording);
    mic.dataset.state = active ? 'listening' : 'idle';
    mic.setAttribute('aria-pressed', String(active));
  }
  // A recording has to be discardable without uploading it, so the discard control appears with it and
  // nowhere else — a permanent "cancel" next to a mic that is idle is a control that cannot do anything.
  const dock = panel?.querySelector('#cp-voice-dock');
  const cancel = dock?.querySelector('[data-cp="voice-cancel"]');
  if (session.recording && !cancel && dock) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'btn sm cp-record-cancel';
    chip.dataset.cp = 'voice-cancel';
    chip.textContent = 'Discard recording';
    dock.querySelector('.cp-voice-row')?.appendChild(chip);
  } else if (!session.recording && cancel) {
    cancel.remove();
  }
}

function showVoiceConsent(kind = 'network') {
  const dock = panel?.querySelector('#cp-voice-dock');
  if (!dock || dock.querySelector('.cp-consent')) return;
  const copy = voiceInput.CONSENT_COPY[kind] || voiceInput.CONSENT_COPY.network;
  const card = document.createElement('div');
  card.className = 'cp-consent';
  card.dataset.consent = kind;
  card.innerHTML = `
    <div class="cp-consent-title">${icon('shield', 15)} ${esc(copy.title)}</div>
    <p>${esc(copy.body)} Turn it off again from Settings → Voice &amp; speech.</p>
    <div class="row" style="gap:8px">
      <button class="btn sm grow" data-cp="voice-consent-deny">Not now</button>
      <button class="btn sm grow primary" data-cp="voice-consent-allow">${esc(copy.allow)}</button>
    </div>`;
  dock.appendChild(card);
  toastIn(card);
}

function clearVoiceConsent() {
  panel?.querySelector('.cp-consent')?.remove();
}

/**
 * The mic's front door. Chooses a transport from facts, asks for the consent that transport needs, and only
 * then opens a microphone. When no path exists it says which one is missing and stops — a dead mic button
 * that reports nothing is worse than no mic button.
 */
function startVoiceInput() {
  const path = voicePath();
  if (path.transport === 'text') {
    session.voiceStatus = path.reason;
    paintVoiceStatus();
    sfx.warn();
    return;
  }
  if (path.requiresConsent && !voiceConsent(path.requiresConsent)) {
    showVoiceConsent(path.requiresConsent);
    return;
  }
  if (path.transport === 'local-stt') {
    startRecording();
    return;
  }
  startListening();
}

/**
 * Record one clip for the gateway's speech host. The transcript lands in the composer and is **not sent**:
 * a whole-clip transcript arrives without any interim feedback, so the person reading it is the check. The
 * browser-recogniser path keeps its own behaviour (a final transcript sends immediately) because there the
 * person has watched the words appear as they spoke.
 */
async function startRecording() {
  session.voiceStatus = 'Opening the microphone…';
  paintVoiceStatus();
  let handle;
  try {
    handle = await startCapture({
      maxMs: 120000,
      onTick: (elapsed) => {
        if (session.recording) {
          session.recording.elapsedMs = elapsed;
          paintVoiceStatus();
        }
      },
    });
  } catch (error) {
    session.voiceStatus = `${error?.message || 'The microphone could not be opened.'} Typing still works.`;
    paintVoiceStatus();
    sfx.bad();
    return;
  }
  const recording = { handle, elapsedMs: 0, startedAt: Date.now() };
  session.recording = recording;
  session.voiceStatus = 'Recording — tap the mic to stop.';
  paintVoiceStatus();
  sfx.listen(true);

  handle.done
    .then(async (clip) => {
      if (session.recording !== recording) return; // cancelled while recording
      session.recording = null;
      sfx.listen(false);
      session.voiceStatus = `Transcribing ${Math.max(1, Math.round(clip.durationMs / 1000))} s of audio…`;
      paintVoiceStatus();
      const out = await voiceInput.transcribe(clip.blob, { language: getState()?.settings?.voice?.lang || '' });
      session.voiceStatus = voiceInput.transcriptNote(out);
      if (out.ok && !out.empty) {
        showAdvanced(true);
        const input = panel?.querySelector('#copilot-input');
        if (input) {
          input.value = out.text;
          input.focus?.({ preventScroll: true });
        }
      }
      paintVoiceStatus();
      if (!out.ok) sfx.bad();
    })
    .catch((error) => {
      if (session.recording === recording) session.recording = null;
      session.voiceStatus = error?.code === 'cancelled'
        ? 'Recording discarded — nothing was sent.'
        : `${error?.message || 'The recording failed.'} Type instead.`;
      paintVoiceStatus();
      if (error?.code !== 'cancelled') sfx.bad();
    });
}

function stopRecording() {
  if (!session.recording) return;
  session.voiceStatus = 'Finishing the recording…';
  paintVoiceStatus();
  session.recording.handle.stop();
}

function cancelRecording() {
  const recording = session.recording;
  if (!recording) return;
  session.recording = null;
  sfx.listen(false);
  recording.handle.cancel();
  session.voiceStatus = 'Recording discarded — nothing was sent.';
  paintVoiceStatus();
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

/**
 * The mode tabs were the old Copilot's whole interaction model: choose a lens, then get that lens's canned
 * answers. With a live model there is nothing to choose — you just talk — so the row is replaced by a
 * statement of what is answering. Whenever the built-in engine is what replies (no gateway, or a gateway
 * with no model) the tabs stay, because they are the only honest way to reach those answers.
 */
const RUNTIME_TONE = { ready: 'ok', unready: 'warn', loading: 'info', error: 'bad', unavailable: 'warn', 'no-gateway': 'info' };

/** What is answering, in one line. Every chip is a fact from the server or a reason it is absent. */
function runtimeChipsHTML() {
  const st = convo.getState();
  const rt = st.runtime;
  const status = session.gatewayState;
  const label = status === 'ready' ? 'model' : status === 'loading' ? 'connecting' : status === 'error' ? 'unreachable' : status === 'no-gateway' ? 'no gateway' : 'no model';
  const chips = [];
  chips.push(`<span class="cp-chip ${RUNTIME_TONE[status] || 'info'}" data-cp-runtime="${esc(status)}">${icon('spark', 13)}${esc(label)}</span>`);
  if (rt?.providerName) chips.push(`<span class="cp-chip ghost" title="The provider behind this conversation">${esc(rt.providerName)}${rt.model ? ` · ${esc(rt.model)}` : ''}</span>`);
  if (rt?.costBasis === 'estimated' && status === 'ready') chips.push('<span class="cp-chip ghost" title="Cost comes from a price table, not an invoice">cost estimated</span>');
  if (status === 'ready') {
    chips.push(`<button class="cp-chip" data-cp="new-conversation" title="Delete this conversation on the gateway">${icon('trash', 13)}New conversation</button>`);
  }
  if (status !== 'ready') {
    chips.push(`<button class="cp-chip ${status === 'unready' ? 'warn' : ''}" data-cp="open-models" title="Configure a provider key">${icon('model', 13)}Set up a model</button>`);
  }
  return chips.join('');
}

/**
 * Shown above the transcript whenever a gateway is connected but cannot answer with a model. It is the
 * one thing that keeps a deterministic reply from being mistaken for a model reply, so it states both
 * halves: what is answering, and where the conversation is (or is not) stored.
 */
function liveNoticeHTML() {
  const st = convo.getState();
  if (session.live === 'live') return '';
  const state = session.gatewayState;
  const reason = st.runtime?.reason || st.error || '';
  if (state === 'no-gateway') {
    return `<div class="cp-notice info" role="status" data-cp-source="no-gateway">${icon('info', 15)}<div><strong>No gateway is connected.</strong>
      Answers come from the built-in knowledge engine, no model is called, and nothing you type leaves this
      browser. Actions that change state are unavailable until a gateway is configured.</div></div>`;
  }
  if (state === 'loading') {
    return `<div class="cp-notice info" role="status">${icon('info', 15)}<div>Connecting to the gateway conversation…</div></div>`;
  }
  if (state === 'unavailable') {
    return `<div class="cp-notice warn" role="status" data-cp-source="unavailable">${icon('shield', 15)}<div><strong>This gateway has no Copilot conversation route.</strong>
      Answers come from the built-in knowledge engine and no model is called. Nothing you type here leaves
      this browser. Update the gateway to get a stored, model-backed conversation.</div></div>`;
  }
  if (state === 'error') {
    return `<div class="cp-notice bad" role="status" data-cp-source="error">${icon('shield', 15)}<div><strong>The gateway conversation could not be read.</strong>
      ${esc(st.error || 'Unknown error')} Answers fall back to the built-in knowledge engine, no model is
      called, and this conversation stays in this browser.</div></div>`;
  }
  return `<div class="cp-notice warn" role="status" data-cp-source="unready" data-cp-nomodel>${icon('shield', 15)}<div><strong>No model is configured, so nothing here is model-written.</strong>
    ${esc(reason)} Answers below come from the built-in knowledge engine and stay in this browser — no model
    is called and the gateway stores none of this. <button class="cp-inline-link" data-cp="open-models">Install a provider key</button></div></div>`;
}

function paintModes() {
  if (!panel) return;
  const el = panel.querySelector('#cp-modes');
  if (!el) return;
  if (session.live === 'live') {
    el.dataset.live = 'true';
    el.innerHTML = runtimeChipsHTML();
    return;
  }
  el.dataset.live = 'false';
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

/**
 * A proposal from the dispatcher. The card shows what the gateway said about the operation — its state, its
 * risk, the fields it accepts, whether an approval is needed — and offers exactly one button. It never says
 * "done": the result arrives as a separate card from the gateway's own answer.
 */
function actionCardHTML(card, msg) {
  const invalid = card.validation && card.validation.ok === false;
  const rows = [
    ['Operation', card.operation],
    ['State', card.stateLabel || card.state || '—'],
    card.target ? ['Target', card.target] : null,
    card.fields && card.fields.length ? ['Fields', card.fields.join(', ')] : null,
  ].filter(Boolean);
  const gate = card.approvalGate;
  const result = card.result;
  return `<div class="cp-card cp-proposal" data-risk="${esc(card.risk)}" data-action-card>
    <div class="cp-card-head">
      <span class="cp-card-title">${esc(card.title)}</span>
      <span class="cp-badge ${card.risk === 'read-only' ? 'info' : 'warn'}">${esc(card.risk)}</span>
    </div>
    <div class="cp-card-body">${md(
      card.reason ||
        (card.executable
          ? 'The gateway checked this operation against its registry. Nothing has run yet.'
          : 'The gateway will not run this operation.')
    )}</div>
    <div class="cp-rows">
      ${rows
        .map(([k, v]) => `<div class="cp-row"><span class="k">${esc(k)}</span><span class="strong">${esc(v)}</span></div>`)
        .join('')}
    </div>
    ${invalid ? `<div class="cp-warn">${esc(card.validation.message || 'The parameters did not validate on the gateway.')}</div>` : ''}
    <div class="cp-meta-grid">
      ${
        card.effects && card.effects.requiresApproval
          ? '<div><span class="k">Approval</span><span>A different principal must allow this before it runs.</span></div>'
          : ''
      }
      ${
        card.effects && card.effects.audit && card.effects.audit !== 'none'
          ? '<div><span class="k">Audit</span><span>Recorded on the gateway’s hash-chained audit log.</span></div>'
          : ''
      }
    </div>
    ${
      result
        ? `<div class="cp-card-foot"><span class="cp-chip ghost">${result.executed ? 'Ran' : 'Not run'}${result.traceId ? ` · ${esc(result.traceId)}` : ''}</span></div>`
        : gate
          ? `<div class="cp-warn">Gate <strong>${esc(gate.id)}</strong> is open for <code>${esc(gate.target || card.target || card.operation)}</code>. It needs another principal’s decision; when they allow it, run it with that gate.</div>
             <div class="cp-card-foot">
               <button class="btn sm primary" data-cp="runaction" data-msg="${msg.id}" data-approval="${esc(gate.id)}">Run with approval</button>
             </div>`
          : card.runnable
            ? `<div class="cp-card-foot">
                 <button class="btn sm" data-cp="dismissaction" data-msg="${msg.id}">Dismiss</button>
                 <button class="btn sm primary" data-cp="runaction" data-msg="${msg.id}">${esc(card.confirmLabel || 'Confirm & run')}</button>
               </div>`
            : `<div class="cp-card-foot"><span class="cp-badge warn">not runnable</span><span class="cp-note-inline">Nothing was executed.</span></div>`
    }
    <div class="cp-expiry">The parameters are the ones the gateway stored · the result comes from the service</div>
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

/**
 * Where the result came from, said by the field that records it rather than by how risky the action
 * looked. A handler that reached the gateway says so; one that only wrote this browser's demo store
 * says that; one that did not say gets the honest third answer. Nothing here is inferred from risk.
 */
function provenanceHTML(card) {
  const provenance = card?.provenance;
  const succeeded = card?.status === 'ok';
  if (provenance === 'demo-store' && succeeded) {
    return '<div class="cp-warn soft">Demo store only — this browser\'s fixtures changed. No gateway call, no model call, no spend.</div>';
  }
  if (provenance === 'gateway' && succeeded) {
    return '<div class="cp-note-inline">Confirmed by the gateway, which answered the request this card reports.</div>';
  }
  // A success that names no origin is not a success yet: say so rather than let the badge stand alone.
  if (succeeded && !provenance) {
    return '<div class="cp-warn soft">No service confirmed this. Treat it as unconfirmed until you can verify it.</div>';
  }
  return '';
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
    ${provenanceHTML(card)}
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

/* ---------- agent drafts ----------
 * A draft card is not a chat bubble with buttons: it is a definition with a state. It shows the state in
 * the canonical words, the findings that produced it, what activation would and would not do, and only
 * the actions the state and the reader's permissions allow.
 */
const DRAFT_TONE = {
  draft: 'info', 'needs-information': 'warn', 'needs-setup': 'warn', invalid: 'bad', blocked: 'bad',
  'ready-for-review': 'ok', 'awaiting-approval': 'info', active: 'ok', archived: 'info',
};

function draftCardHTML(card) {
  const d = card.draft || {};
  const spec = d.spec || {};
  const findings = Array.isArray(d.findings) ? d.findings : [];
  const sevTone = { error: 'bad', setup: 'warn', warning: 'warn', info: 'info', blocked: 'bad' };
  const actions = typeof card.actions === 'function' ? card.actions() : card.actions || [];
  return `<div class="cp-card cp-draft" data-draft-id="${esc(d.id || '')}" data-draft-state="${esc(d.state || '')}">
    <div class="cp-card-head">
      <span class="cp-card-title">${esc(spec.name || 'Untitled agent')}</span>
      <span class="cp-badge ${DRAFT_TONE[d.state] || 'info'}" data-draft-label>${esc(d.stateLabel || d.state || 'draft')}</span>
    </div>
    <div class="cp-card-body">
      ${spec.role ? `<div class="small">${esc(spec.role)}</div>` : ''}
      ${spec.goal ? `<div class="tiny muted">${esc(spec.goal)}</div>` : ''}
      <div class="cp-draft-meta tiny muted">
        ${spec.framework ? `<span>${esc(spec.framework)}</span>` : ''}
        ${spec.model ? `<span>${esc(spec.model)}</span>` : ''}
        ${spec.autonomy ? `<span>L${esc(String(spec.autonomy))} autonomy</span>` : ''}
        ${d.agentId ? `<span>agent ${esc(d.agentId)}</span>` : ''}
      </div>
      ${
        findings.length
          ? `<div class="cp-section">What the validator says</div>${findings
              .slice(0, 6)
              .map((f) => `<div class="cp-draft-finding"><span class="cp-badge ${sevTone[f.severity] || 'info'}">${esc(f.severity)}</span>
                <div class="grow"><div class="small">${esc(f.title)}</div><div class="tiny muted">${esc(f.detail || '')}</div></div></div>`)
              .join('')}`
          : ''
      }
      <div class="cp-draft-note tiny muted">A draft is not an agent: activating stores an idle definition through an
        approval gate, and no runtime in this build can execute it.</div>
      ${card.error ? `<div class="cp-notice bad" role="alert">${icon('shield', 15)}<div>${esc(card.error)}</div></div>` : ''}
      ${card.note ? `<div class="cp-notice info" role="status">${icon('info', 15)}<div>${esc(card.note)}</div></div>` : ''}
      ${
        actions.length
          ? `<div class="cp-draft-actions">${actions
              .map((a) => `<button class="cp-chip ${a.tone === 'primary' ? 'ok' : ''}" data-cp="${esc(a.act)}" data-draft="${esc(d.id || '')}">${esc(a.label)}</button>`)
              .join('')}</div>`
          : `<div class="tiny muted">No action is available to your role in this state.</div>`
      }
    </div>
  </div>`;
}

/* ---------- browser-script drafts ----------
 * The one card whose approval runs something. So it leads with the plain-language preview the *gateway*
 * derived from the steps — never the model's own account of them — and it reports the task's real state
 * once a run exists, including when that state is a failure.
 */
const TASK_TONE = {
  queued: 'info', running: 'info', recovering: 'warn', waiting_for_user: 'warn', paused: 'warn',
  completed: 'ok', failed: 'bad', blocked: 'bad', cancelled: 'info', timed_out: 'bad',
};

function scriptCardHTML(card) {
  const d = card.draft || {};
  const script = d.script || {};
  const findings = Array.isArray(d.findings) ? d.findings : [];
  const preview = Array.isArray(d.preview) ? d.preview : [];
  const sevTone = { error: 'bad', setup: 'warn', warning: 'warn', info: 'info', blocked: 'bad' };
  const actions = typeof card.actions === 'function' ? card.actions() : card.actions || [];
  const task = d.task;
  return `<div class="cp-card cp-script cp-draft" data-script-id="${esc(d.id || '')}" data-script-state="${esc(d.state || '')}">
    <div class="cp-card-head">
      <span class="cp-card-title">${esc(script.objective ? script.objective.slice(0, 60) : 'Untitled script')}</span>
      <span class="cp-badge ${DRAFT_TONE[d.state] || 'info'}" data-script-label>${esc(d.stateLabel || d.state || 'draft')}</span>
    </div>
    <div class="cp-card-body">
      ${script.entryUrl ? `<div class="tiny muted cp-script-url">${esc(script.entryUrl)}</div>` : ''}
      ${
        preview.length
          ? `<div class="cp-section">What it would do</div>
             <ol class="cp-script-steps">${preview
               .slice(0, 10)
               .map((p) => `<li class="cp-script-step${p.sensitive ? ' sensitive' : ''}">${esc(p.sentence)}${
                 p.sensitive ? ' <span class="cp-badge warn">commits you</span>' : ''
               }</li>`)
               .join('')}</ol>
             ${preview.length > 10 ? `<div class="tiny muted">…and ${preview.length - 10} more step(s)</div>` : ''}`
          : ''
      }
      ${
        task
          ? `<div class="cp-script-task tiny">
               <span class="cp-badge ${TASK_TONE[task.status] || 'info'}" data-task-status>${esc(task.status)}</span>
               <span class="muted">step ${esc(String(task.stepIndex))}/${esc(String(task.totalSteps))}${
                 task.evidenceCount ? ` · ${esc(String(task.evidenceCount))} evidence record(s)` : ''
               }${task.simulated ? ' · simulated engine — not a real browser' : ''}</span>
               ${task.outcome ? `<div class="muted">Outcome: ${esc(task.outcome)}</div>` : ''}
               ${task.blocker ? `<div class="muted">Blocker: ${esc(task.blocker)}</div>` : ''}
             </div>`
          : ''
      }
      ${
        findings.length
          ? `<div class="cp-section">What the validator says</div>${findings
              .slice(0, 6)
              .map((f) => `<div class="cp-draft-finding"><span class="cp-badge ${sevTone[f.severity] || 'info'}">${esc(f.severity)}</span>
                <div class="grow"><div class="small">${esc(f.title)}</div><div class="tiny muted">${esc(f.detail || '')}</div></div></div>`)
              .join('')}`
          : ''
      }
      <div class="cp-draft-note tiny muted">Approving this script runs it: a real browser task on the gateway, once,
        and nothing before that. The steps above are generated from the script, not from anything a page said.</div>
      ${card.error ? `<div class="cp-notice bad" role="alert">${icon('shield', 15)}<div>${esc(card.error)}</div></div>` : ''}
      ${card.note ? `<div class="cp-notice info" role="status">${icon('info', 15)}<div>${esc(card.note)}</div></div>` : ''}
      ${
        actions.length
          ? `<div class="cp-draft-actions">${actions
              .map((a) => `<button class="cp-chip ${a.tone === 'primary' ? 'ok' : ''}" data-cp="${esc(a.act)}" data-script="${esc(d.id || '')}">${esc(a.label)}</button>`)
              .join('')}</div>`
          : `<div class="tiny muted">No action is available to your role in this state.</div>`
      }
    </div>
  </div>`;
}

/* ---------- swarm-plan drafts ----------
 * A workflow is a swarm plan, so the card shows what saving it would store — an objective, a node order,
 * a cap — and the same two facts as an agent card: the state it is really in, and that nothing runs.
 */
function planCardHTML(card) {
  const d = card.draft || {};
  const plan = d.plan || {};
  const findings = Array.isArray(d.findings) ? d.findings : [];
  const sevTone = { error: 'bad', setup: 'warn', warning: 'warn', info: 'info', blocked: 'bad' };
  const actions = typeof card.actions === 'function' ? card.actions() : card.actions || [];
  const nodeCount = Array.isArray(plan.nodes) ? plan.nodes.length : 0;
  return `<div class="cp-card cp-plan cp-draft" data-plan-id="${esc(d.id || '')}" data-plan-state="${esc(d.state || '')}">
    <div class="cp-card-head">
      <span class="cp-card-title">${esc(plan.name || 'Untitled plan')}</span>
      <span class="cp-badge ${DRAFT_TONE[d.state] || 'info'}" data-plan-label>${esc(d.stateLabel || d.state || 'draft')}</span>
    </div>
    <div class="cp-card-body">
      ${plan.objective ? `<div class="small">${esc(plan.objective)}</div>` : ''}
      <div class="cp-plan-meta tiny muted">
        <span>${esc(String(nodeCount || 'default'))} ${nodeCount === 1 ? 'node' : 'nodes'}</span>
        <span>cap ${esc(String(plan.budgetCap))}</span>
        ${plan.channel ? `<span>${esc(plan.channel)}</span>` : ''}
        ${plan.teamId ? `<span>team ${esc(plan.teamId)}</span>` : ''}
        ${d.swarmId ? `<span>swarm ${esc(d.swarmId)}</span>` : ''}
      </div>
      ${
        nodeCount
          ? `<div class="cp-plan-nodes tiny muted">${plan.nodes
              .slice(0, 8)
              .map((n) => `<span class="cp-plan-node">${esc(n.label || n.id)}</span>`)
              .join(' → ')}</div>`
          : ''
      }
      ${
        findings.length
          ? `<div class="cp-section">What the validator says</div>${findings
              .slice(0, 6)
              .map((f) => `<div class="cp-draft-finding"><span class="cp-badge ${sevTone[f.severity] || 'info'}">${esc(f.severity)}</span>
                <div class="grow"><div class="small">${esc(f.title)}</div><div class="tiny muted">${esc(f.detail || '')}</div></div></div>`)
              .join('')}`
          : ''
      }
      <div class="cp-draft-note tiny muted">Saving this plan stores a swarm row with status “planned”, no progress and
        no spend. No scheduler or worker exists in this build, so nothing starts it.</div>
      ${card.error ? `<div class="cp-notice bad" role="alert">${icon('shield', 15)}<div>${esc(card.error)}</div></div>` : ''}
      ${card.note ? `<div class="cp-notice info" role="status">${icon('info', 15)}<div>${esc(card.note)}</div></div>` : ''}
      ${
        actions.length
          ? `<div class="cp-draft-actions">${actions
              .map((a) => `<button class="cp-chip ${a.tone === 'primary' ? 'ok' : ''}" data-cp="${esc(a.act)}" data-plan="${esc(d.id || '')}">${esc(a.label)}</button>`)
              .join('')}</div>`
          : `<div class="tiny muted">No action is available to your role in this state.</div>`
      }
    </div>
  </div>`;
}

/**
 * The sentence that asks for a draft. Deliberately narrow: "make the tests pass" must not silently turn
 * into a definition, and a question ("how do agents work?") must stay a question.
 */
/**
 * The sentence that asks the browser to go and look. Checked before the other two: "open the pricing page
 * and tell me the Pro price" contains no draft word at all, and "build an agent that checks a page" must
 * still be an agent — so this pattern requires a browsing verb *and* a site or page to act on.
 */
function wantsScript(text) {
  const lc = String(text || '').toLowerCase();
  if (/\b(how do|what is|what are|why|explain|tell me about|should i|can i|does)\b/.test(lc)) return false;
  const browseVerb = /\b(open|visit|go to|navigate|browse|scrape|check|read|click|fill|log ?in|sign ?in|search|look up|find on)\b/.test(lc);
  const aPlace = /(https?:\/\/\S+|\b[a-z0-9-]+\.(com|org|net|io|dev|app|test|local)\b|\b(web)?site\b|\bweb ?page\b|\bpricing page\b|\bhomepage\b|\bdashboard\b)/.test(lc);
  return browseVerb && aPlace;
}

/**
 * The sentence that asks for a workflow. A workflow in this build *is* a swarm plan, so this is the
 * sibling of `wantsDraft`: checked first, because "build a plan for the research team" contains no
 * word that would make it an agent, but "create a swarm of agents" contains both and must not silently
 * become one agent.
 */
function wantsPlan(text) {
  const lc = String(text || '').toLowerCase();
  if (/\b(how do|what is|what are|why|explain|tell me about|should i|can i|does)\b/.test(lc)) return false;
  return /\b(create|design|make|build|draft|add|set up|new|write|plan|orchestrate)\b[^.!?]{0,40}\b(plan|workflow|swarm|pipeline)\b/.test(lc);
}

function wantsDraft(text) {
  const lc = String(text || '').toLowerCase();
  // "how do agents work?" is a question; "create an agent that triages" is a request. The guard comes
  // first because the request pattern is broad by design.
  if (/\b(how do|what is|what are|why|explain|tell me about|should i|can i|does)\b/.test(lc)) return false;
  return /\b(create|design|make|build|draft|add|set up|new)\b[^.!?]{0,28}\b(agent|assistant|bot|worker|copilot)\b/.test(lc);
}

function cardHTML(card, msg) {
  if (!card) return '';
  switch (card.type) {
    case 'answer': return answerCardHTML(card);
    case 'knowledge': return knowledgeCardHTML(card);
    case 'proposal': return proposalCardHTML(card, msg);
    case 'action': return actionCardHTML(card, msg);
    case 'result': return resultCardHTML(card);
    case 'diagnostic': return diagnosticCardHTML(card);
    case 'capability': return capabilityCardHTML(card);
    case 'activity': return activityCardHTML(card);
    case 'draft': return draftCardHTML(card);
    case 'plan': return planCardHTML(card);
    case 'script': return scriptCardHTML(card);
    default: return `<div class="cp-card"><div class="cp-card-body">${md(card.text || '')}</div></div>`;
  }
}

const fmtUsd = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  if (n === 0) return '$0.00';
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
};

/** The provenance line under a live reply: model, tokens, estimated cost, and the ledger id. */
function liveMeta(m) {
  if (m.failed) return 'Copilot · not answered';
  const u = m.usage || {};
  const bits = [];
  if (u.model) bits.push(esc(String(u.model)));
  if (u.promptTokens || u.completionTokens) bits.push(`${Number(u.promptTokens) || 0} in / ${Number(u.completionTokens) || 0} out`);
  if (Number.isFinite(Number(u.costUsd))) bits.push(`${fmtUsd(u.costUsd)} est.`);
  if (Number.isFinite(Number(u.latencyMs))) bits.push(`${Number(u.latencyMs)} ms`);
  if (m.modelCallId) bits.push(`call #${esc(String(m.modelCallId))}`);
  return bits.length ? `Copilot · ${bits.join(' · ')}` : 'Copilot';
}

function messageHTML(m) {
  if (m.role === 'user') {
    return `<div class="cp-msg me"><div class="cp-bubble">${md(m.text)}</div>
      <div class="cp-msg-meta">You · ${new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div></div>`;
  }
  const speakable = [m.text, m.card?.text, m.card?.title].filter(Boolean).join(' ').slice(0, 2000);
  // A live reply states where it came from and what it cost. A demo reply states that it is one.
  const metaLabel = m.live
    ? liveMeta(m)
    : `Copilot · ${esc(modeMeta(m.mode || session.mode).label)} mode · demo answer, no model called`;
  return `<div class="cp-msg bot${m.failed ? ' failed' : ''}"${m.modelCallId ? ` data-call-id="${esc(String(m.modelCallId))}"` : ''}>
    <div class="cp-bubble">${m.text && !m.card ? md(m.text) : ''}${cardHTML(m.card, m)}</div>
    <div class="cp-msg-meta">
      <span class="cp-msg-meta-text">${metaLabel} · ${new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
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
    <p class="cp-empty-foot">Grounded in ${ks.total} reviewed knowledge entries · ${esc(ks.version)}<br>${session.live === 'live'
      ? 'Answers come from the model configured on the gateway. Every reply shows its call id and estimated cost.'
      : 'Deterministic answers, no model call. Runtime is labelled in the header.'}</p>
  </div>`;
}

function pendingHTML() {
  if (!session.pending) return '';
  const label = session.live === 'live' ? 'Waiting for the model…' : 'Working…';
  return `<div class="cp-msg bot"><div class="cp-bubble cp-pending" data-cp-pending="${esc(session.live)}">
    <span class="cp-dot run"></span>${esc(label)} <button class="cp-chip" data-cp="stop">Stop</button></div></div>`;
}

function paintWork() {
  if (!workEl) return;
  const blank = session.history.length === 0;
  const notice = liveNoticeHTML();
  workEl.innerHTML = notice + (blank ? emptyStateHTML() : session.history.map(messageHTML).join('') + pendingHTML());
  const panelEl = panel;
  if (panelEl) {
    // The holographic empty state belongs to an empty transcript. A status notice is chrome above it, not
    // a message, so a panel that has said nothing is still blank — including when the notice says there is
    // no gateway, which is otherwise the state most deployments start in.
    panelEl.dataset.blank = String(blank && !session.pending);
    panelEl.querySelector('#copilot-work').setAttribute('aria-busy', String(session.pending));
  }
  if (!blank) workEl.scrollTop = workEl.scrollHeight;
}

/**
 * Two questions, kept apart because they have different answers:
 *   source        — where the *reply* comes from (a model, or the built-in engine)
 *   gatewayState  — what the gateway says about models (ready / unready / unavailable / error) and
 *                   `no-gateway` when there is no gateway conversation route to ask at all
 * A gateway without a model is `unready` for conversation but perfectly usable for deterministic
 * answers, and pretending otherwise would remove the Copilot's actions from every older gateway.
 * `unavailable` means the gateway has no Copilot conversation route at all.
 */
function deriveSource() {
  const st = convo.getState();
  // `no-gateway` is its own state: it means there is no gateway conversation to ask, which is a
  // different fact from `unready` (a gateway with no provider key) and from fixture *data*. Calling all
  // three "demo" was how a deterministic reply could be mistaken for a model one.
  const gatewayState = convo.available() ? st.status : 'no-gateway';
  return { gatewayState, source: gatewayState === 'ready' ? 'live' : 'local' };
}

function paint() {
  if (!panel) return;
  const { gatewayState, source } = deriveSource();
  session.gatewayState = gatewayState;
  session.live = source;
  panel.dataset.mode = session.mode;
  panel.dataset.source = source;
  panel.dataset.gateway = gatewayState;
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

/**
 * Delete the server-side conversation after asking. Two steps, because losing a transcript by a stray tap
 * is exactly the kind of thing the old panel did ("clear memory" was one tap and irreversible).
 */
function newConversation() {
  if (session.live !== 'live') {
    session.history = [];
    paint();
    return;
  }
  const last = session.history[session.history.length - 1];
  if (last?.confirmClear) {
    convo.clearConversation().then((out) => {
      if (out.ok) {
        session.history = [];
        toast(out.cleared ? `Conversation cleared (${out.cleared} turns deleted)` : 'Conversation was already empty', 'ok');
      } else {
        toast(out.error || 'Could not clear the conversation', 'bad');
      }
      paint();
    });
    return;
  }
  const prompt = { id: uid('cp-msg'), role: 'copilot', text: 'Clear this whole conversation on the gateway? This deletes every turn and cannot be undone.', mode: session.mode, live: true, confirmClear: true };
  session.history.push(prompt);
  paint();
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
  if (!session.advanced) showAdvanced(true);
  if (session.live === 'live' && convo.getState().status === 'ready') {
    sendLive(raw);
    return;
  }
  // No model is answering (no gateway, or a gateway without a usable provider). The built-in engine
  // answers, and every reply it produces says, on its own meta line, that no model was called.
  pushMessage({ role: 'user', text: raw, mode: session.mode });
  setDraft('');
  session.pending = true;
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

let liveSeq = 0;

/**
 * One live turn. The user's message appears immediately (they did say it); the reply appears only when the
 * gateway returns one, carrying the ledger id and the estimated cost of the call that produced it.
 */
async function sendLive(raw) {
  session.pending = true;
  session.lastError = '';
  const localId = `live-${++liveSeq}`;
  pushMessage({ id: localId, role: 'user', text: raw, mode: session.mode, live: true });
  setDraft('');
  paint();
  if (wantsScript(raw)) {
    await sendScriptTurn(raw, localId);
    return;
  }
  if (wantsPlan(raw)) {
    await sendPlanTurn(raw, localId);
    return;
  }
  if (wantsDraft(raw)) {
    await sendDraftTurn(raw, localId);
    return;
  }
  const out = await convo.sendTurn({ text: raw, route: session.route });
  session.pending = false;
  if (out.ok) {
    if (out.reply) {
      const msg = convo.toPanelMessage(out.reply);
      msg.mode = session.mode;
      // Replace the optimistic copy with the server's own row (same text, real id and timestamp).
      if (out.user) {
        const idx = session.history.findIndex((m) => m.id === localId);
        if (idx >= 0) session.history[idx] = { ...convo.toPanelMessage(out.user), mode: session.mode };
      }
      pushMessage(msg);
      // A proposal the gateway checked and stored. It is offered as a confirmation, never as a result.
      if (out.proposal) {
        const actionCard = actions.cardFor(out.proposal, { mode: session.mode });
        if (actionCard) pushMessage({ role: 'copilot', text: '', card: actionCard, mode: session.mode, live: true });
      }
    }
  } else if (out.cancelled) {
    pushMessage({ role: 'copilot', text: 'Stopped. The request was cancelled; nothing further was generated.', mode: session.mode, live: true });
  } else {
    session.lastError = out.error || 'the reply failed';
    pushMessage({
      role: 'copilot',
      text: out.reason === 'no-model'
        ? `${out.error}`
        : `That did not go through: ${out.error}`,
      mode: session.mode,
      live: true,
      failed: true,
    });
    if (out.reason === 'no-model') await convo.load({ silent: true });
  }
  paint();
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

/**
 * A turn that asks for an agent. The model writes JSON, the gateway validates it, and the panel shows the
 * resulting draft as a card — with its real state, its findings, and only the actions that state allows.
 */
async function sendDraftTurn(raw, localId) {
  const out = await drafts.createFromText(raw, { route: session.route });
  session.pending = false;
  if (out.userMessage) {
    const idx = session.history.findIndex((m) => m.id === localId);
    if (idx >= 0) session.history[idx] = { ...convo.toPanelMessage(out.userMessage), mode: session.mode };
  }
  if (out.draft) {
    pushMessage({
      role: 'copilot', text: out.reply?.text || '', mode: session.mode, live: true,
      usage: out.reply?.payload || { draftId: out.draft.id },
      card: { type: 'draft', draft: out.draft, actions: () => draftActions(out.draft) },
    });
  } else if (out.reply?.text) {
    pushMessage({ role: 'copilot', text: out.reply.text, mode: session.mode, live: true });
  } else {
    session.lastError = out.error || 'the draft failed';
    pushMessage({
      role: 'copilot',
      text: out.reason === 'no-model' ? out.error : `That draft did not go through: ${out.error}`,
      mode: session.mode, live: true, failed: true,
    });
    if (out.reason === 'no-model') await convo.load({ silent: true });
  }
  paint();
}

/** The actions offered for a script draft — the row says what is possible, the role says what is offered. */
const scriptActions = (script) => (script ? scripts.actionsFor(script) : []);

/**
 * A turn that asks the browser to go and look. The gateway turns the sentence into a script *draft* — an
 * approval away from running — and the panel renders the preview the gateway derived, never its own.
 */
async function sendScriptTurn(raw, localId) {
  const out = await scripts.createFromText(raw, { route: session.route });
  session.pending = false;
  if (out.userMessage) {
    const idx = session.history.findIndex((m) => m.id === localId);
    if (idx >= 0) session.history[idx] = { ...convo.toPanelMessage(out.userMessage), mode: session.mode };
  }
  if (out.draft) {
    pushMessage({
      role: 'copilot', text: out.reply?.text || '', mode: session.mode, live: true,
      usage: out.reply?.payload || { draftId: out.draft.id, draftKind: 'browser-script' },
      card: { type: 'script', draft: out.draft, actions: () => scriptActions(out.draft) },
    });
  } else if (out.reply?.text) {
    pushMessage({ role: 'copilot', text: out.reply.text, mode: session.mode, live: true });
  } else {
    session.lastError = out.error || 'the script draft failed';
    pushMessage({
      role: 'copilot',
      text: out.reason === 'no-model' ? out.error : `That script did not go through: ${out.error}`,
      mode: session.mode, live: true, failed: true,
    });
    if (out.reason === 'no-model') await convo.load({ silent: true });
  }
  paint();
}

/** The actions offered for a plan draft — the row says what is possible, the role says what is offered. */
const planActions = (plan) => (plan ? plans.actionsFor(plan) : []);

/**
 * A turn that asks for a workflow. Same shape as `sendDraftTurn`, different artefact: the gateway turns
 * the sentence into a swarm plan *draft*, and the panel renders what it validated — never a plan it
 * assembled itself.
 */
async function sendPlanTurn(raw, localId) {
  const out = await plans.createFromText(raw, { route: session.route });
  session.pending = false;
  if (out.userMessage) {
    const idx = session.history.findIndex((m) => m.id === localId);
    if (idx >= 0) session.history[idx] = { ...convo.toPanelMessage(out.userMessage), mode: session.mode };
  }
  if (out.draft) {
    pushMessage({
      role: 'copilot', text: out.reply?.text || '', mode: session.mode, live: true,
      usage: out.reply?.payload || { draftId: out.draft.id, draftKind: 'swarm-plan' },
      card: { type: 'plan', draft: out.draft, actions: () => planActions(out.draft) },
    });
  } else if (out.reply?.text) {
    pushMessage({ role: 'copilot', text: out.reply.text, mode: session.mode, live: true });
  } else {
    session.lastError = out.error || 'the plan draft failed';
    pushMessage({
      role: 'copilot',
      text: out.reason === 'no-model' ? out.error : `That plan did not go through: ${out.error}`,
      mode: session.mode, live: true, failed: true,
    });
    if (out.reason === 'no-model') await convo.load({ silent: true });
  }
  paint();
}

/** The actions the panel offers for a draft. Derived from the row, never from optimistic state. */
function draftActions(draft) {
  if (!draft) return [];
  const list = [];
  const allowed = drafts.actionsFor(draft).map((a) => a.act);
  if (draft.canSubmit && allowed.includes('draft-submit')) list.push({ act: 'draft-submit', label: 'Submit for approval', tone: 'primary' });
  if (draft.state === 'awaiting-approval' && allowed.includes('draft-activate')) {
    list.push({ act: 'draft-activate', label: 'Activate', tone: 'primary' });
    list.push({ act: 'draft-open-approvals', label: 'Review the gate', tone: '' });
  }
  if (allowed.includes('draft-archive')) list.push({ act: 'draft-archive', label: 'Archive', tone: '' });
  if (allowed.includes('draft-open-designer')) list.push({ act: 'draft-open-designer', label: 'Open in the builder', tone: '' });
  if (draft.agentId) list.push({ act: 'draft-open-agent', label: 'Open the agent', tone: '' });
  return list;
}

/**
 * A draft card is not a chat bubble, so it does not come back with the transcript. After a reload the
 * messages still carry `draftId` in their payload, so the cards are re-attached from the drafts the
 * gateway still holds — which is the difference between "the draft exists" and "the draft was a picture".
 */
async function attachDraftCards() {
  let changed = false;
  if (drafts.available()) {
    const out = await drafts.load();
    if (out.ok) {
      const byId = new Map((out.drafts || []).map((d) => [d.id, d]));
      for (const msg of session.history) {
        const id = msg.usage?.draftId;
        if (!id || msg.card?.type === 'draft') continue;
        // A plan or a browser script is a different row in a different table; their cards are rebuilt below.
        if (msg.usage?.draftKind === 'swarm-plan' || msg.usage?.draftKind === 'browser-script') continue;
        const draft = byId.get(id);
        if (!draft) continue;
        msg.card = { type: 'draft', draft, actions: () => draftActions(draft) };
        changed = true;
      }
    }
  }
  if (plans.available()) {
    const out = await plans.load();
    if (out.ok) {
      const byId = new Map((out.plans || []).map((p) => [p.id, p]));
      for (const msg of session.history) {
        if (msg.usage?.draftKind !== 'swarm-plan') continue;
        const id = msg.usage?.draftId;
        if (!id || msg.card?.type === 'plan') continue;
        const plan = byId.get(id);
        if (!plan) continue;
        msg.card = { type: 'plan', draft: plan, actions: () => planActions(plan) };
        changed = true;
      }
    }
  }
  if (scripts.available()) {
    const out = await scripts.load();
    if (out.ok) {
      const byId = new Map((out.scripts || []).map((s) => [s.id, s]));
      for (const msg of session.history) {
        if (msg.usage?.draftKind !== 'browser-script') continue;
        const id = msg.usage?.draftId;
        if (!id || msg.card?.type === 'script') continue;
        const script = byId.get(id);
        if (!script) continue;
        // Re-read the row so the card carries the task's live state after a reload, not the state it had
        // when the turn was written.
        msg.card = { type: 'script', draft: script, actions: () => scriptActions(script) };
        changed = true;
      }
    }
  }
  if (changed) paint();
}

function draftMessage(id) {
  return session.history.find((m) => m.card?.type === 'draft' && m.card.draft?.id === id) || null;
}

function replaceDraftCard(id, draft, extra = {}) {
  const msg = draftMessage(id);
  if (!msg || !draft) return;
  msg.card = { ...msg.card, draft, actions: () => draftActions(draft), ...extra };
  paint();
}

function planMessage(id) {
  return session.history.find((m) => m.card?.type === 'plan' && m.card.draft?.id === id) || null;
}

function replacePlanCard(id, draft, extra = {}) {
  const msg = planMessage(id);
  if (!msg || !draft) return;
  msg.card = { ...msg.card, draft, actions: () => planActions(draft), ...extra };
  paint();
}

function scriptMessage(id) {
  return session.history.find((m) => m.card?.type === 'script' && m.card.draft?.id === id) || null;
}

function replaceScriptCard(id, draft, extra = {}) {
  const msg = scriptMessage(id);
  if (!msg || !draft) return;
  msg.card = { ...msg.card, draft, actions: () => scriptActions(draft), ...extra };
  paint();
}

/**
 * The acts a script card can perform. `script-run` is the only one in the whole panel that starts a real
 * browser task, so its refusal is shown verbatim: if the gateway says the gate is not open, the card says
 * exactly that rather than a friendlier sentence that implies it might have worked.
 */
async function runScriptAction(act, id) {
  if (!id) return;
  const current = scriptMessage(id)?.card.draft || null;
  if (act === 'script-submit') {
    const out = await scripts.submit(id);
    if (!out.ok) return replaceScriptCard(id, out.draft || current, { error: out.error });
    toast('Submitted — a Reviewer who is not you must allow it before anything can run', 'ok');
    return replaceScriptCard(id, out.draft, { error: '', note: 'Waiting for a decision on the Approvals screen. Nothing runs until the gate is open.' });
  }
  if (act === 'script-run') {
    const out = await scripts.run(id);
    if (!out.ok) return replaceScriptCard(id, out.draft || current, { error: out.error });
    toast(`Queued as ${out.task?.id || 'a task'} — the engine reports what it actually does`, 'ok');
    return replaceScriptCard(id, out.draft, {
      error: '',
      note: `Running as ${out.task?.id}. The status above is the gateway's, read live from the task — not a prediction.`,
    });
  }
  if (act === 'script-archive') {
    const out = await scripts.archive(id);
    if (!out.ok) return replaceScriptCard(id, current, { error: out.error });
    return replaceScriptCard(id, out.draft, { error: '', note: 'Archived — the row is kept and still readable.' });
  }
  if (act === 'script-open-approvals') {
    closeCopilot();
    toast('This script is decided on the Approvals screen. A Reviewer who is not you must allow it.', 'info');
    try { shellActions.navigate?.('agents'); } catch { /* the shell owns routing */ }
    return;
  }
  if (act === 'script-open-task' && current?.taskId) {
    closeCopilot();
    try { shellActions.navigate?.(`browser/${current.taskId}`); } catch { /* the shell owns routing */ }
  }
}

/**
 * The four acts a plan card can perform. Each one renders the server's next state or the server's
 * refusal — the card never advances itself, because a card that advances itself is a card that lies when
 * the request fails.
 */
async function runPlanAction(act, id) {
  if (!id) return;
  const current = planMessage(id)?.card.draft || null;
  if (act === 'plan-submit') {
    const out = await plans.submit(id);
    if (!out.ok) return replacePlanCard(id, out.draft || current, { error: out.error });
    toast('Submitted — a Reviewer must allow it before the plan can be saved', 'ok');
    return replacePlanCard(id, out.draft, { error: '', note: 'Waiting for a decision on the Approvals screen. Saving it stores a planned swarm and starts nothing.' });
  }
  if (act === 'plan-save') {
    const out = await plans.save(id);
    if (!out.ok) return replacePlanCard(id, out.draft || current, { error: out.error });
    toast(`Plan saved as ${out.swarm?.id || 'a swarm'} — status planned, nothing was started`, 'ok');
    return replacePlanCard(id, out.draft, { error: '', note: 'Saved: the swarm exists as a plan with zero progress and zero spend. No scheduler in this build can start it.' });
  }
  if (act === 'plan-archive') {
    const out = await plans.archive(id);
    if (!out.ok) return replacePlanCard(id, current, { error: out.error });
    return replacePlanCard(id, out.draft, { error: '', note: 'Archived — the row is kept and still readable.' });
  }
  if (act === 'plan-open-approvals') {
    closeCopilot();
    toast('The gate is on the Approvals screen — a Reviewer decides it there.', 'info');
    try { shellActions.navigate?.('agents'); } catch { /* the shell owns routing */ }
    return;
  }
  if (act === 'plan-open-swarm' && current?.swarmId) {
    closeCopilot();
    try { shellActions.navigate?.(`swarms/${current.swarmId}`); } catch { /* the shell owns routing */ }
  }
}

async function runDraftAction(act, id) {
  if (!id) return;
  const current = draftMessage(id)?.card.draft || null;
  if (act === 'draft-submit') {
    const out = await drafts.submit(id);
    if (!out.ok) return replaceDraftCard(id, out.draft || current, { error: out.error });
    toast('Submitted — a Reviewer must allow it before it can become an agent', 'ok');
    return replaceDraftCard(id, out.draft, { error: '', note: 'Waiting for a decision on the Approvals screen. You cannot approve your own draft.' });
  }
  if (act === 'draft-activate') {
    const out = await drafts.activate(id);
    if (!out.ok) return replaceDraftCard(id, out.draft || current, { error: out.error });
    toast(`Agent ${out.agent?.name || ''} created as an idle definition — nothing was started`, 'ok');
    return replaceDraftCard(id, out.draft, { error: '', note: 'Activated: the definition exists as an idle agent. No runtime in this build can execute it.' });
  }
  if (act === 'draft-archive') {
    const out = await drafts.archive(id);
    if (!out.ok) return replaceDraftCard(id, current, { error: out.error });
    return replaceDraftCard(id, out.draft, { error: '', note: 'Archived — the row is kept and still readable.' });
  }
  if (act === 'draft-open-designer') {
    if (!current) return;
    try {
      const designer = await import('../designer.js');
      designer.openDesigner({ seed: { ...drafts.designerSeed(current), draftId: current.id } });
      closeCopilot();
      toast('Opened in the builder with this draft’s fields. Saving there updates the draft.', 'info');
    } catch (error) {
      toast(`The builder could not be opened: ${error?.message || error}`, 'bad');
    }
    return;
  }
  if (act === 'draft-open-approvals') {
    closeCopilot();
    toast('The gate is on the Approvals screen — a Reviewer decides it there.', 'info');
    try { shellActions.navigate?.('agents'); } catch { /* the shell owns routing */ }
    return;
  }
  if (act === 'draft-open-agent' && current?.agentId) {
    closeCopilot();
    try { shellActions.navigate?.(`agents/${current.agentId}`); } catch { /* the shell owns routing */ }
  }
}

function stopPending() {
  clearTimeout(pendingTimer);
  if (convo.available() && session.pending) {
    const aborted = convo.abort();
    if (aborted) {
      session.pending = false;
      pushMessage({ role: 'copilot', text: 'Stopped. The request was cancelled; nothing further was generated.', mode: session.mode, live: true });
      paint();
      return;
    }
  }
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

/**
 * Run a prepared action. The card holds the gateway's own message id; the parameters never leave the
 * server, so this handler cannot change what will happen — only whether it happens now.
 */
async function runAction(msgId, approvalId = '') {
  const msg = findMessage(msgId);
  const card = msg?.card;
  if (!card || card.type !== 'action' || card.result || card.busy) return;
  if (!actions.available()) {
    pushMessage({ role: 'copilot', text: 'No gateway is connected, so this cannot run.', mode: session.mode, failed: true });
    paint();
    return;
  }
  card.busy = true;
  paint();
  const out = await actions.run(card, { approvalId: approvalId || card.approvalGate?.id || null });
  card.busy = false;
  if (out.code === 'approval-required' && out.approval) {
    card.approvalGate = out.approval;
    pushMessage({ role: 'copilot', text: out.message, mode: session.mode, live: true });
    paint();
    return;
  }
  if (out.code === 'confirmation-required' && card.approvalGate) {
    pushMessage({ role: 'copilot', text: out.message, mode: session.mode, live: true });
    paint();
    return;
  }
  card.result = out;
  pushMessage({ role: 'copilot', text: '', card: actions.resultCard(card, out), mode: session.mode, live: true });
  if (out.reply) pushMessage({ ...convo.toPanelMessage(out.reply), mode: session.mode });
  paint();
  import('../main.js').then((m) => m.rerender()).catch(() => {});
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
    runtimeUnsubConvo?.();
    runtimeUnsubConvo = null;
  };
  const runtimeUnsubRuntime = subscribeRuntime(() => paintRuntime());
  const runtimeUnsubAuth = subscribeAuth(() => {
    paintRuntime();
    paintTray();
  });
  runtimeUnsubConvo = convo.subscribe(() => {
    if (session.open) paint();
  });
  paint();
  probeGateway().catch(() => {});
  // Ask the gateway what speech it can do before the mic is offered, so the button never promises a path
  // this deployment does not have.
  voiceInput.loadCapabilities()
    .then((out) => {
      session.voiceCaps = out.capabilities;
      if (session.open) paintVoiceStatus();
    })
    .catch(() => {});
  if (convo.available()) {
    convo.load()
      .then((out) => {
        if (!session.open) return;
        // The server transcript replaces the local one only when the server is what answers. On a gateway
        // with no model the replies are local, so adopting server rows would show questions without the
        // answers that followed them.
        if (out.ok && convo.getState().status === 'ready') {
          session.history = (out.messages || []).map((row, i) => {
            const msg = convo.toPanelMessage(row);
            msg.mode = session.mode;
            // Keep any richer local card attached to a message the panel itself produced (same order).
            const local = session.history[i];
            if (local?.card && local.text === msg.text) msg.card = local.card;
            return msg;
          });
          paint();
          attachDraftCards().catch(() => {});
        }
        paint();
      })
      .catch(() => paint());
  }
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
    // Where the answers come from — the one thing a test (or a person) must be able to check.
    source: session.live,
    gatewayState: session.gatewayState,
    live: convo.getState().status,
    runtimeConfigured: Boolean(convo.getState().runtime?.configured),
    conversationId: convo.getState().conversationId,
    modelCallIds: session.history.filter((m) => m.modelCallId != null).map((m) => m.modelCallId),
    pendingLabel: session.pending ? (session.live === 'live' ? 'Waiting for the model…' : 'Working…') : '',
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
  session.live = 'local';
  session.gatewayState = 'no-gateway';
  session.lastError = '';
  convo.reset();
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
      else if (session.recording) stopRecording();
      else startVoiceInput();
      break;
    case 'voice-cancel':
      cancelRecording();
      break;
    case 'voice-consent-allow': {
      const kind = panel?.querySelector('.cp-consent')?.dataset.consent === 'local' ? 'local' : 'network';
      setState((state) => {
        state.settings.voice = {
          ...(state.settings.voice || {}),
          ...(kind === 'local' ? { localSttConsent: true } : { networkRecognitionConsent: true }),
        };
      }, 'voice-consent');
      clearVoiceConsent();
      toast(kind === 'local' ? 'Local voice input allowed — audio stays on your network' : 'Voice input allowed for this browser', 'ok');
      startVoiceInput();
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
    case 'new-conversation':
      newConversation();
      break;
    case 'draft-submit':
    case 'draft-activate':
    case 'draft-archive':
    case 'draft-open-designer':
    case 'draft-open-approvals':
    case 'draft-open-agent':
      runDraftAction(act, t.dataset.draft);
      break;
    case 'script-submit':
    case 'script-run':
    case 'script-archive':
    case 'script-open-approvals':
    case 'script-open-task':
      runScriptAction(act, t.dataset.script);
      break;
    case 'plan-submit':
    case 'plan-save':
    case 'plan-archive':
    case 'plan-open-approvals':
    case 'plan-open-swarm':
      runPlanAction(act, t.dataset.plan);
      break;
    case 'open-models': {
      closeCopilot();
      try { shellActions.navigate?.('models'); } catch { /* the shell owns routing */ }
      toast('Install a provider key, then reopen the Copilot', 'info');
      break;
    }
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
    case 'runaction':
      runAction(msgId, t.dataset.approval || '');
      break;
    case 'dismissaction': {
      const m = findMessage(msgId);
      if (m?.card) {
        m.card.result = { executed: false, message: 'dismissed before running' };
        pushMessage({ role: 'copilot', text: 'Dismissed. Nothing was executed.', mode: session.mode, live: true });
        paint();
      }
      break;
    }
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
 * Append a Copilot message. The second argument used to attach a screen-supplied action card whose
 * `execute` called a closure and then *reported* `{ status: 'ok', summary: '… executed.' }` without
 * asking any service what happened. A card that cannot show a service response must not show a result,
 * so that branch is gone: the argument is still accepted (callers keep working) and the reply says
 * plainly that nothing was run. Actions that really execute go through a gateway-verified proposal.
 */
export function copilotSay(text, legacyActionCard = null) {
  const refused = legacyActionCard
    ? '\n\n*A legacy action card was supplied by the calling screen and was not attached or run: that path reported success without a service response, so it has been removed. Anything that changes state has to come back from the gateway as a verified proposal.*'
    : '';
  pushMessage({ role: 'copilot', text: `${text ?? ''}${refused}`, card: null, mode: session.mode });
  if (session.open) paint();
  return null;
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
