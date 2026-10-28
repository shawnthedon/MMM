/* ============ Voice Studio UI ============
 * Five screens, one honest rule: never show a capability, install or audio result that did not
 * happen. The device engine is real and measured at runtime; every other catalogue entry states that
 * it is not installed and why.
 */
import { getState, setState, esc, icon, fmtTime } from './core.js';
import { views } from './views1.js';
import { openSheet, closeAllSheets, toast, on } from './shell.js';
import { VOICE_MODELS, ROLES, ADAPTERS, filterModels, availabilityFor } from './voice/registry.js';
import { createBrowserSpeechAdapter, createLocalSpeechAdapter, createCloningAdapter, validateLocalEndpoint } from './voice/adapters.js';
import { defaultProfiles, sanitiseProfiles, createClonedProfile, findProfile, PROFILE_STATUS } from './voice/profiles.js';
import { createVoiceStudio, STRATEGIES, DEFAULT_STUDIO_SETTINGS } from './voice/studio.js';
import './voice.css';

let tab = 'tts';
let voices = { count: 0, list: [], error: null };
let adapterStatus = {};
let studio = null;
let lastSnapshot = null;
let saveTimer = null;
let editorFocused = false;

const voiceSettings = () => ({ ...DEFAULT_STUDIO_SETTINGS, ...(getState().settings.voice || {}) });

function saveVoiceSettings(patch) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    setState((state) => {
      state.settings.voice = { ...DEFAULT_STUDIO_SETTINGS, ...(state.settings.voice || {}), ...patch };
    }, 'voice-settings');
  }, 350);
}

function applySettingsNow(patch) {
  setState((state) => {
    state.settings.voice = { ...DEFAULT_STUDIO_SETTINGS, ...(state.settings.voice || {}), ...patch };
  }, 'voice-settings');
}

const profiles = () => sanitiseProfiles(getState().settings.voice?.profiles);
const setProfiles = (list) => setState((state) => {
  state.settings.voice = { ...DEFAULT_STUDIO_SETTINGS, ...(state.settings.voice || {}), profiles: list };
}, 'voice-profiles');

function engineFor(settings) {
  if ((settings.modelId || 'browser-speech') === 'browser-speech') return createBrowserSpeechAdapter();
  return createLocalSpeechAdapter({ endpoint: settings.localEndpoint || '', allowRemote: false });
}

function cloningSupport(settings) {
  return createCloningAdapter({ endpoint: settings.cloningEndpoint || '' }).supports();
}

/** Build (or rebuild) the controller for the current settings. */
function ensureStudio({ force = false } = {}) {
  const settings = voiceSettings();
  if (studio && !force) return studio;
  if (studio) studio.dispose();
  const engine = engineFor(settings);
  studio = createVoiceStudio({
    engine,
    profiles: profiles(),
    cloningSupport: cloningSupport(settings),
    settings,
    persist: (next) => saveVoiceSettings(next),
    onState: (snapshot) => { lastSnapshot = snapshot; paintLive(); },
  });
  return studio;
}

/* ---------- probe helpers ---------- */
export async function refreshAvailability() {
  const settings = voiceSettings();
  const browser = createBrowserSpeechAdapter();
  const local = createLocalSpeechAdapter({ endpoint: settings.localEndpoint || '' });
  const cloning = createCloningAdapter({ endpoint: settings.cloningEndpoint || '' });
  const [browserStatus, localStatus, cloningStatus] = await Promise.all([
    Promise.resolve(browser.checkAvailability()),
    local.checkAvailability(),
    cloning.checkAvailability(),
  ]);
  adapterStatus = { 'browser-speech': browserStatus, 'local-tts-server': localStatus, 'voice-cloning': cloningStatus };
  try {
    voices.list = browser.listVoices();
    voices.count = voices.list.length;
    voices.error = null;
  } catch (error) {
    voices = { count: 0, list: [], error: String(error?.message || error) };
  }
  return { adapterStatus, voices };
}

const chipFor = (tone, text) => `<span class="chip tiny ${tone}">${esc(text)}</span>`;

/* =====================================================================================
 * Screens
 * ===================================================================================*/

function overviewHTML() {
  const settings = voiceSettings();
  const snap = lastSnapshot || ensureStudio().snapshot();
  const browserStatus = adapterStatus['browser-speech'];
  const status = browserStatus?.status || 'unknown';
  const tone = status === 'available' ? 'ok' : status === 'no-voices' ? 'warn' : 'bad';
  const location = settings.modelId === 'browser-speech' ? 'on-device (device speech engine)' : 'local host';
  return `
    <div class="vs-hero">
      <div>
        <div class="vs-kicker font-mono">VOICE STUDIO · ${esc(settings.modelId)}</div>
        <h1>Speak, listen, verify<span class="deck-title-dot">.</span></h1>
        <p>Type and hear it read aloud by a voice this device actually has. Model downloads, cloned voices and hosted fallbacks stay blocked until they are real.</p>
      </div>
      <div class="vs-hero-actions">
        <button class="btn primary" data-act="voice-tab" data-tab="tts">${icon('mic', 17)} Open the editor</button>
        <button class="btn" data-act="voice-check">${icon('search', 16)} Re-measure</button>
      </div>
    </div>

    ${settings.selectedProfileId === 'my-cloned-voice' && snap.usingFallback ? `<div class="banner warn" style="margin-bottom:12px">
      ${icon('shield', 16)}<div><strong>“My cloned voice” is unavailable.</strong> ${esc(snap.fallbackReason)}</div></div>` : ''}

    <div class="vs-metric-grid">
      <div class="vs-metric"><div class="vs-metric-k">Engine</div><div class="vs-metric-v">${chipFor(tone, status === 'available' ? 'available' : status)}</div><div class="vs-metric-d">${esc(browserStatus?.detail || 'Measuring…')}</div></div>
      <div class="vs-metric"><div class="vs-metric-k">Installed voices</div><div class="vs-metric-v">${voices.count}</div><div class="vs-metric-d">${voices.list.filter((v) => v.local).length} reporting on-device synthesis</div></div>
      <div class="vs-metric"><div class="vs-metric-k">Execution</div><div class="vs-metric-v vs-metric-v-sm">${esc(location)}</div><div class="vs-metric-d">Local-first · no cloud adapter exists</div></div>
      <div class="vs-metric"><div class="vs-metric-k">Active voice</div><div class="vs-metric-v vs-metric-v-sm">${esc(snap.activeProfile?.name || 'none')}</div><div class="vs-metric-d">${esc(snap.usingFallback ? 'fallback — see above' : 'as selected')}</div></div>
    </div>

    <div class="section-title">What works on this device</div>
    <div class="card">
      ${row('Text-to-speech', status === 'available' ? 'real audio via the OS engine' : 'unavailable', status === 'available' ? 'ok' : 'bad')}
      ${row('Sentence / phrase streaming', 'per-utterance (not word level)', 'ok')}
      ${row('Voice cloning', cloningSupport(settings).supported ? 'engine configured' : 'blocked — no engine', cloningSupport(settings).supported ? 'warn' : 'bad')}
      ${row('Speech recognition', 'not offered — Chromium’s recogniser is network-backed', 'bad')}
      ${row('Qwen2.5-Omni', 'not installed · advertisement only', 'warn')}
      ${row('Playback while offline', status === 'available' && voices.list.some((v) => v.local) ? 'yes for local voices' : 'depends on the voice', 'warn')}
    </div>

    <div class="section-title">Voice profiles</div>
    <div class="card">
      ${profiles().map((profile) => `<div class="kv"><span class="k">${esc(profile.name)}</span><span>${chipFor(profile.status === 'active' ? 'ok' : 'warn', profile.status)} <span class="tiny muted">${esc(profile.kind)}${profile.consent ? ' · consented' : ''}</span></span></div>`).join('')}
      <div class="tiny muted" style="margin-top:8px">Cloned profiles need a configured local engine, explicit consent and reference audio that is never stored in this browser.</div>
    </div>

    <div class="vs-foot">${icon('shield', 15)} <span>Nothing here downloads a model or calls a hosted service. Status comes from live probes in this tab.</span></div>`;
}

function modelsHTML() {
  const s = getState();
  const ui = s.settings.voiceUi || {};
  const role = ui.roleFilter || 'all';
  const query = ui.query || '';
  const models = filterModels({ role, query, adapterStatus });
  return `
    <div class="page-head"><h1>Model catalogue</h1><div class="sub">Advertised capability is labelled separately from what this build has actually run.</div></div>
    <div class="vs-filter">
      <input class="input" id="vs-model-search" placeholder="Search models, families, licences" value="${esc(query)}" aria-label="Search the voice model catalogue">
      <div class="scroll-x vs-roles" role="group" aria-label="Filter by role">
        ${ROLES.map((entry) => `<button class="chip ${entry.id === role ? 'brand' : ''}" data-act="voice-role" data-role="${entry.id}" aria-pressed="${entry.id === role}">${esc(entry.label)}</button>`).join('')}
      </div>
    </div>
    ${models.length ? models.map((model) => {
      const availability = model.availability || availabilityFor(model);
      const selected = (voiceSettings().modelId || 'browser-speech') === model.id;
      const installTone = model.install === 'built-in' ? 'ok' : model.verification === 'advertised' ? 'warn' : 'bad';
      return `<div class="card vs-model">
        <div class="row between wrap" style="gap:8px">
          <div class="grow">
            <div class="row wrap" style="gap:6px"><strong class="small">${esc(model.name)}</strong>
              ${chipFor(installTone, model.install === 'built-in' ? 'built in' : model.install)}
              ${chipFor(model.verification === 'runtime-probe' ? 'ok' : 'warn', model.verification === 'runtime-probe' ? 'measured here' : model.verification === 'advertised' ? 'advertised upstream' : 'contract only')}
            </div>
            <div class="tiny muted" style="margin-top:4px">${esc(model.family)} · ${esc(model.licence)}</div>
          </div>
          <button class="btn sm ${selected ? '' : 'primary'}" data-act="voice-model" data-id="${esc(model.id)}" ${availability.usable ? '' : 'disabled'} aria-pressed="${selected}">${selected ? 'Selected' : availability.usable ? 'Use this model' : 'Unavailable'}</button>
        </div>
        <div class="vs-model-roles">${model.roles.map((r) => `<span class="chip tiny">${esc(r)}</span>`).join('')}</div>
        <div class="vs-model-status tiny ${availability.usable ? 'ok' : 'muted'}">${esc(availability.reason)}</div>
        <details class="vs-details"><summary>Limitations &amp; requirements</summary>
          <ul class="vs-list">${model.limitations.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
          <div class="tiny muted">Requires: ${model.requires.map(esc).join(' · ')}</div>
          <div class="tiny muted">Source: ${esc(model.source)}</div>
        </details>
      </div>`;
    }).join('') : '<div class="card tiny muted">No model matches that filter.</div>'}
    <div class="section-title">Installation manager</div>
    <div class="card">
      ${row('Model downloads', 'not implemented', 'bad')}
      ${row('Integrity verification', 'not implemented', 'bad')}
      ${row('Partial download / resume', 'not implemented', 'bad')}
      <div class="tiny muted" style="margin-top:8px">This build has no downloader, no checksum store and no artifact directory. The catalogue above is metadata only; no button pretends otherwise.</div>
    </div>
    <div class="section-title">Local host configuration</div>
    <div class="card">
      <div class="field"><label for="vs-endpoint">TTS host endpoint (loopback only)</label>
        <input class="input mono" id="vs-endpoint" placeholder="http://127.0.0.1:8080" value="${esc(voiceSettings().localEndpoint || '')}">
      </div>
      <div class="row wrap" style="gap:8px">
        <button class="btn sm primary" data-act="voice-endpoint-save">Save endpoint</button>
        <button class="btn sm" data-act="voice-check">Test connection</button>
      </div>
      <div class="tiny muted" style="margin-top:8px">Contract: <span class="mono">GET /health</span> then <span class="mono">POST /v1/audio/speech</span> returning <span class="mono">audio/*</span>. Remote endpoints need HTTPS and are disabled here; no engine ships with this build.</div>
    </div>`;
}

function ttsHTML() {
  const settings = voiceSettings();
  const snap = lastSnapshot || ensureStudio().snapshot();
  const activeProfiles = profiles();
  const strategy = settings.strategy || 'sentence';
  return `
    <div class="vs-tts">
      <div class="vs-tts-head">
        <div>
          <div class="vs-kicker font-mono">LIVE TYPE-TO-SPEECH</div>
          <h1 class="vs-tts-title">Voice editor</h1>
        </div>
        <div class="vs-tts-controls">
          <label class="vs-auto"><input type="checkbox" id="vs-autospeak" ${settings.autoSpeak ? 'checked' : ''}> <span>Speak as I type</span></label>
        </div>
      </div>

      <div class="vs-voice-row">
        <label class="tiny muted" for="vs-profile">Voice</label>
        <select class="input" id="vs-profile">
          ${activeProfiles.map((profile) => `<option value="${esc(profile.id)}" ${settings.selectedProfileId === profile.id ? 'selected' : ''}>${esc(profile.name)}${profile.status === 'active' ? '' : ` — ${profile.status}`}</option>`).join('')}
        </select>
        <button class="btn sm" data-act="voice-tab" data-tab="voices">Manage</button>
      </div>
      ${snap.usingFallback ? `<div class="banner warn vs-inline-banner">${icon('shield', 15)}<div>${esc(snap.fallbackReason)}</div></div>` : ''}
      ${snap.status === 'blocked' && snap.error ? `<div class="banner bad vs-inline-banner">${icon('shield', 15)}<div><strong>Speech blocked.</strong> ${esc(snap.error.message)}</div></div>` : ''}

      <textarea id="vs-editor" class="vs-editor" aria-label="Text to speak" placeholder="Hello! Type your message here and MMM will speak it with the selected voice.">${esc(studio?.text || '')}</textarea>
      <div class="vs-editor-meta tiny muted">
        <span id="vs-count">0 characters · 0 words</span>
        <span id="vs-live" role="status" aria-live="polite">Ready</span>
      </div>

      <div class="vs-playback">
        <button class="btn primary" data-act="voice-play">${icon('play', 16)} Play</button>
        <button class="btn" data-act="voice-stop">${icon('stop', 16)} Stop</button>
        <button class="btn" data-act="voice-clear">${icon('trash', 16)} Clear</button>
      </div>

      <div class="section-title">Playback strategy</div>
      <div class="card">
        ${STRATEGIES.map((entry) => `
          <label class="vs-strategy">
            <input type="radio" name="vs-strategy" value="${entry.id}" ${strategy === entry.id ? 'checked' : ''}>
            <span class="grow"><strong class="small">${esc(entry.label)}</strong><span class="tiny muted">${esc(entry.hint)}</span></span>
          </label>`).join('')}
      </div>

      <div class="section-title">Voice settings</div>
      <div class="card">
        <div class="kv inline"><span class="k">Speaking rate</span><span class="row" style="gap:8px"><input type="range" min="0.5" max="2" step="0.05" value="${settings.rate}" id="vs-rate" aria-label="Speaking rate"><span class="tiny muted" id="vs-rate-val">${settings.rate.toFixed(2)}×</span></span></div>
        <div class="kv"><span class="k">Engine</span><span class="tiny muted">${esc(ADAPTERS[VOICE_MODELS.find((m) => m.id === settings.modelId)?.adapter || 'browser-speech']?.label || 'device')}</span></div>
        <div class="kv"><span class="k">Execution location</span><span class="tiny muted">${settings.modelId === 'browser-speech' ? 'on-device' : 'local host'}</span></div>
      </div>
      <div class="vs-foot">${icon('mic', 15)} <span>Streaming is per sentence: the engine returns complete utterances, so word-level playback is not claimed. Editing text cancels audio generated from the old text.</span></div>
    </div>`;
}

function voicesHTML() {
  const settings = voiceSettings();
  const clone = cloningSupport(settings);
  const list = profiles();
  return `
    <div class="page-head"><h1>Voice profiles</h1><div class="sub">Consent-tracked. Reference audio is never stored in this browser.</div></div>
    ${clone.supported ? `<div class="banner info" style="margin-bottom:12px">${icon('shield', 16)}<div>Cloning host configured: ${esc(clone.reason)}</div></div>`
      : `<div class="banner warn" style="margin-bottom:12px">${icon('shield', 16)}<div><strong>Cloning is blocked.</strong> ${esc(clone.reason)} A profile cannot be used without a compatible engine and a recorded consent decision.</div></div>`}
    <div class="card">
      ${list.map((profile) => `<div class="vs-profile">
        <div class="grow">
          <div class="row wrap" style="gap:6px"><strong class="small">${esc(profile.name)}</strong>
            ${chipFor(profile.status === 'active' ? 'ok' : 'warn', profile.status)}
            ${chipFor('', profile.kind)}
          </div>
          <div class="tiny muted" style="margin-top:3px">${profile.consent ? `Consent: ${esc(profile.consent.by)} · ${esc(profile.consent.scope)} · ${esc(profile.consent.at)}` : 'No consent record'}</div>
          ${profile.note ? `<div class="tiny muted">${esc(profile.note)}</div>` : ''}
        </div>
        <div class="row" style="gap:6px">
          ${profile.id === settings.selectedProfileId ? '<span class="chip tiny brand">selected</span>' : `<button class="btn sm" data-act="voice-profile-select" data-id="${esc(profile.id)}">Use</button>`}
          ${profile.kind === 'cloned' && profile.status === 'revoked' ? `<button class="btn sm" data-act="voice-profile-revoke" data-id="${esc(profile.id)}">Restore</button>` : profile.kind === 'cloned' ? `<button class="btn sm danger" data-act="voice-profile-revoke" data-id="${esc(profile.id)}">Revoke</button>` : ''}
          ${profile.kind === 'cloned' && profile.id !== 'my-cloned-voice' ? `<button class="btn sm" data-act="voice-profile-delete" data-id="${esc(profile.id)}" aria-label="Delete ${esc(profile.name)}">${icon('trash', 15)}</button>` : ''}
        </div>
      </div>`).join('')}
    </div>
    <div class="section-title">Create a cloned voice</div>
    <div class="card">
      <div class="tiny muted" style="margin-bottom:10px">Reference audio is validated locally, sent only to a configured local engine, and never persisted by this app. Creating a profile requires an explicit consent decision naming who consented.</div>
      <button class="btn primary" data-act="voice-profile-create" ${clone.supported ? '' : 'disabled'}>${icon('plus', 16)} New cloned voice</button>
      ${clone.supported ? '' : '<div class="tiny muted" style="margin-top:8px">Disabled: no cloning engine is configured.</div>'}
    </div>
    <div class="section-title">Built-in device voices</div>
    <div class="card">
      ${voices.list.length ? voices.list.slice(0, 12).map((voice) => `<div class="kv"><span class="k">${esc(voice.name)}</span><span class="tiny muted">${esc(voice.lang)} · ${voice.local ? 'on-device' : 'network voice'}</span></div>`).join('')
        : '<div class="tiny muted">The engine has not reported any installed voices yet. Open the editor and press Play once, then re-measure.</div>'}
    </div>`;
}

function diagnosticsHTML() {
  const settings = voiceSettings();
  const statuses = Object.entries(adapterStatus);
  return `
    <div class="page-head"><h1>Diagnostics</h1><div class="sub">Measured in this tab. Nothing here is simulated.</div></div>
    <div class="card">
      ${statuses.length ? statuses.map(([id, status]) => `<div class="vs-diag">
        <div class="row between"><strong class="small">${esc(ADAPTERS[id]?.label || id)}</strong>${chipFor(status.status === 'available' ? 'ok' : status.status === 'unconfigured' ? 'warn' : 'bad', status.status)}</div>
        <div class="tiny muted">${esc(status.detail)}</div>
      </div>`).join('') : '<div class="tiny muted">No probe has run yet.</div>'}
      ${adapterStatus['voice-cloning'] ? `<div class="vs-diag"><div class="row between"><strong class="small">Voice cloning</strong>${chipFor(adapterStatus['voice-cloning'].status === 'unconfigured' ? 'warn' : 'ok', adapterStatus['voice-cloning'].status)}</div><div class="tiny muted">${esc(adapterStatus['voice-cloning'].detail)}</div></div>` : ''}
    </div>
    <div class="section-title">Runtime</div>
    <div class="card">
      ${row('Selected model', VOICE_MODELS.find((m) => m.id === settings.modelId)?.name || settings.modelId)}
      ${row('Adapter', ADAPTERS[VOICE_MODELS.find((m) => m.id === settings.modelId)?.adapter]?.label || 'device')}
      ${row('Execution location', settings.modelId === 'browser-speech' ? 'on-device' : 'local host')}
      ${row('Cloud fallback', 'none exists', 'ok')}
      ${row('Speech recognition', 'not implemented', 'bad')}
      ${row('Queue state', lastSnapshot ? `${lastSnapshot.status} · ${lastSnapshot.queued} queued · ${lastSnapshot.spokenChunks} spoken` : 'idle')}
      ${lastSnapshot?.error ? `<div class="local-notes bad" style="margin-top:8px">${esc(lastSnapshot.error.message)}</div>` : ''}
    </div>
    <div class="section-title">Offline behaviour</div>
    <div class="card">
      <div class="tiny muted">Voices that report <span class="mono">localService</span> keep working with the network off. Network-backed voices fail with an explicit error; there is no silent cloud fallback and no hosted provider configured.</div>
      <div class="row wrap" style="gap:8px;margin-top:10px"><button class="btn sm" data-act="voice-check">${icon('search', 15)} Re-measure</button><button class="btn sm" data-act="voice-probe-local">Test local host</button></div>
    </div>`;
}

const row = (label, value, tone = '') => `
  <div class="kv"><span class="k">${esc(label)}</span><span>${tone ? chipFor(tone, value) : `<span class="tiny muted">${esc(value)}</span>`}</span></div>`;

const TABS = [
  { id: 'tts', label: 'Type-to-speech' },
  { id: 'overview', label: 'Overview' },
  { id: 'models', label: 'Models' },
  { id: 'voices', label: 'Voices' },
  { id: 'diagnostics', label: 'Diagnostics' },
];

views.voice = {
  title: 'Voice Studio',
  persistent: true,
  // The editor owns its DOM while the reader is typing or listening: repainting would kill focus,
  // caret position and the audio status line. Mutations below repaint explicitly when needed.
  skipRender: () => editorFocused || ['speaking', 'paused'].includes(lastSnapshot?.status),
  render() {
    const body = tab === 'overview' ? overviewHTML() : tab === 'models' ? modelsHTML() : tab === 'voices' ? voicesHTML() : tab === 'diagnostics' ? diagnosticsHTML() : ttsHTML();
    return `
      <div class="vs">
        <div class="tabs vs-tabs" role="tablist" aria-label="Voice Studio sections">
          ${TABS.map((entry) => `<button role="tab" aria-selected="${tab === entry.id}" class="${tab === entry.id ? 'active' : ''}" data-act="voice-tab" data-tab="${entry.id}">${esc(entry.label)}</button>`).join('')}
        </div>
        ${body}
      </div>`;
  },
  async mount() {
    ensureStudio();
    if (!Object.keys(adapterStatus).length) {
      await refreshAvailability();
      rerenderSafely();
    }
    wireEditor();
  },
};

/** Views cannot import main.js eagerly; rerender via the same dynamic pattern used elsewhere. */
function rerenderSafely() {
  import('./main.js').then((m) => m.rerender()).catch(() => {});
}

function paintLive() {
  const live = document.getElementById('vs-live');
  if (!live) return;
  const snap = lastSnapshot;
  if (!snap) return;
  const copy = snap.status === 'speaking' ? `Speaking · generation ${snap.generation}`
    : snap.status === 'paused' ? 'Paused'
      : snap.status === 'blocked' ? 'Blocked — see the message above'
        : snap.status === 'error' ? 'Error — see below'
          : snap.pendingText ? 'Buffered — waiting for a sentence boundary' : 'Ready';
  live.textContent = copy;
  live.dataset.state = snap.status;
}

function updateCounts() {
  const editor = document.getElementById('vs-editor');
  const count = document.getElementById('vs-count');
  if (!editor || !count) return;
  const text = editor.value;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  count.textContent = `${text.length} characters · ${words} words`;
}

function wireEditor() {
  const editor = document.getElementById('vs-editor');
  if (!editor) return;
  updateCounts();
  paintLive();
  const instance = ensureStudio();
  // Keep module state in sync when returning to the tab.
  if (editor.value !== instance.text) editor.value = instance.text;
  updateCounts();

  editor.addEventListener('focus', () => { editorFocused = true; });
  editor.addEventListener('blur', () => { editorFocused = false; });
  editor.addEventListener('input', () => {
    ensureStudio().setText(editor.value);
    updateCounts();
  });
  editor.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { ensureStudio().stop(); }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { ensureStudio().playNow(); }
  });

  const autospeak = document.getElementById('vs-autospeak');
  autospeak?.addEventListener('change', () => {
    ensureStudio().updateSettings({ autoSpeak: autospeak.checked });
    applySettingsNow({ autoSpeak: autospeak.checked });
    toast(autospeak.checked ? 'Auto-speak on — finished sentences are spoken' : 'Auto-speak off — press Play to speak', 'ok');
  });

  document.querySelectorAll('input[name="vs-strategy"]').forEach((input) => {
    input.addEventListener('change', () => {
      if (!input.checked) return;
      ensureStudio().updateSettings({ strategy: input.value });
      applySettingsNow({ strategy: input.value });
      toast(`Playback strategy: ${STRATEGIES.find((s) => s.id === input.value)?.label}`, 'ok');
    });
  });

  const profileSelect = document.getElementById('vs-profile');
  profileSelect?.addEventListener('change', () => {
    ensureStudio().setProfile(profileSelect.value);
    applySettingsNow({ selectedProfileId: profileSelect.value });
    rerenderSafely();
  });

  const rate = document.getElementById('vs-rate');
  rate?.addEventListener('input', () => {
    const label = document.getElementById('vs-rate-val');
    if (label) label.textContent = `${Number(rate.value).toFixed(2)}×`;
    ensureStudio().updateSettings({ rate: Number(rate.value) });
    saveVoiceSettings({ rate: Number(rate.value) });
  });
}

/* ---------- actions ---------- */
on('voice-tab', (el, ds) => {
  tab = ds.tab || 'tts';
  rerenderSafely();
});

on('voice-check', async () => {
  await refreshAvailability();
  rerenderSafely();
  const status = adapterStatus['browser-speech']?.status;
  toast(`Speech engine: ${status}`, status === 'available' ? 'ok' : 'warn');
});

on('voice-model', (el, ds) => {
  const model = VOICE_MODELS.find((entry) => entry.id === ds.id);
  if (!model) return;
  const availability = availabilityFor(model, adapterStatus);
  if (!availability.usable) { toast(availability.reason, 'bad'); return; }
  applySettingsNow({ modelId: ds.id });
  ensureStudio({ force: true });
  toast(`${model.name} selected`, 'ok');
  rerenderSafely();
});

on('voice-role', (el, ds) => {
  setState((state) => {
    state.settings.voiceUi = { ...(state.settings.voiceUi || {}), roleFilter: ds.role };
  }, 'voice-role');
});

on('voice-play', () => {
  const instance = ensureStudio();
  instance.playNow();
});

on('voice-stop', () => { ensureStudio().stop(); });

on('voice-clear', () => {
  ensureStudio().clear();
  const editor = document.getElementById('vs-editor');
  if (editor) { editor.value = ''; editor.focus({ preventScroll: true }); }
  updateCounts();
  paintLive();
});

on('voice-profile-select', (el, ds) => {
  ensureStudio().setProfile(ds.id);
  applySettingsNow({ selectedProfileId: ds.id });
  toast('Voice profile selected', 'ok');
  rerenderSafely();
});

on('voice-profile-revoke', (el, ds) => {
  const list = profiles().map((profile) => profile.id === ds.id
    ? { ...profile, status: profile.status === 'revoked' ? PROFILE_STATUS.active : PROFILE_STATUS.revoked }
    : profile);
  setProfiles(list);
  ensureStudio().onProfilesChanged(list);
  toast('Profile status updated — queued audio was invalidated', 'ok');
});

on('voice-profile-delete', (el, ds) => {
  const list = profiles().filter((profile) => profile.id !== ds.id);
  const settings = voiceSettings();
  if (settings.selectedProfileId === ds.id) applySettingsNow({ selectedProfileId: 'device-default' });
  setProfiles(list);
  ensureStudio().onProfilesChanged(list);
  toast('Voice profile deleted', 'ok');
});

on('voice-profile-create', () => {
  const clone = cloningSupport(voiceSettings());
  if (!clone.supported) { toast(clone.reason, 'bad'); return; }
  openSheet({
    title: 'New cloned voice',
    body: `
      <div class="field"><label for="vpc-name">Profile name</label><input class="input" id="vpc-name" placeholder="Studio narrator"></div>
      <div class="field"><label for="vpc-consent">Consent</label>
        <label class="vs-consent"><input type="checkbox" id="vpc-consent"> I have this person’s explicit permission to synthesise their voice on this device.</label>
      </div>
      <div class="field"><label for="vpc-by">Consent recorded by</label><input class="input" id="vpc-by" placeholder="Your name"></div>
      <div class="banner info">${icon('shield', 16)}<div>Reference audio is sent only to the configured local engine and is never stored by this app.</div></div>`,
    foot: `<button class="btn grow primary" data-act="voice-profile-create-go">Create profile</button>`,
  });
});

on('voice-profile-create-go', () => {
  const sheet = document.querySelector('.sheet.open');
  const name = sheet?.querySelector('#vpc-name')?.value?.trim();
  const consent = sheet?.querySelector('#vpc-consent')?.checked;
  const by = sheet?.querySelector('#vpc-by')?.value?.trim();
  if (!name) { toast('A profile name is required', 'bad'); return; }
  if (!consent || !by) { toast('Explicit consent and the consenting principal are required', 'bad'); return; }
  const outcome = createClonedProfile({ id: `vp-${Date.now().toString(36)}`, name, consent: { granted: true, by }, engine: 'openvoice-v2' });
  if (!outcome.ok) { toast(outcome.reason, 'bad'); return; }
  const list = [...profiles(), outcome.profile];
  setProfiles(list);
  ensureStudio().onProfilesChanged(list);
  closeAllSheets();
  toast('Cloned voice profile created — reference audio was not stored', 'ok');
});

on('voice-endpoint-save', () => {
  const value = document.getElementById('vs-endpoint')?.value?.trim() || '';
  if (value) {
    const check = validateLocalEndpoint(value);
    if (!check.ok) { toast(check.reason, 'bad'); return; }
  }
  applySettingsNow({ localEndpoint: value });
  ensureStudio({ force: true });
  toast(value ? 'Local endpoint saved' : 'Local endpoint cleared', 'ok');
  refreshAvailability().then(rerenderSafely);
});

on('voice-probe-local', async () => {
  const status = await refreshAvailability().then((result) => result.adapterStatus['local-tts-server']);
  toast(status ? `Local host: ${status.status} — ${status.detail}` : 'No local host configured', status?.status === 'available' ? 'ok' : 'warn');
  rerenderSafely();
});

/* ---------- exported helpers for Copilot/tests ---------- */
export function voiceSummary() {
  const settings = voiceSettings();
  const snap = lastSnapshot;
  return {
    tab,
    engine: adapterStatus['browser-speech']?.status || 'unknown',
    voices: voices.count,
    localVoices: voices.list.filter((voice) => voice.local).length,
    modelId: settings.modelId,
    autoSpeak: settings.autoSpeak,
    strategy: settings.strategy,
    profileCount: profiles().length,
    status: snap?.status || 'idle',
  };
}

/** Speak arbitrary text with the current voice configuration (used by Copilot replies). */
export function speakText(text, { onError } = {}) {
  const instance = ensureStudio();
  const result = instance.speakOnce(text);
  if (!result.ok && onError) onError(result.reason);
  return result;
}

export function openVoiceTab(next = 'tts') {
  tab = next;
  import('./main.js').then((m) => m.navigate('voice')).catch(() => {});
}

export const voiceInternals = { ensureStudio, refreshAvailability, getStudio: () => studio, setTab: (value) => { tab = value; } };
