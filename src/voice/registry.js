/* ============ Voice model & runtime registry ============
 * The single source of truth for "which speech models does this build know about, what can they
 * actually do here, and where would inference run?".
 *
 * Honesty rules:
 *   • `verification: 'runtime-probe'`  → the adapter measures this device at runtime.
 *   • `verification: 'advertised'`     → upstream documentation claims it; nothing here has run it.
 *   • `verification: 'contract-only'`  → we implement the client contract; no engine was executed.
 * A model is never shown as installed unless an install record exists. Nothing in this file
 * downloads, executes or simulates a model.
 */

export const ROLES = [
  { id: 'all', label: 'All roles' },
  { id: 'conversation', label: 'Conversational AI' },
  { id: 'stt', label: 'Speech recognition' },
  { id: 'tts', label: 'Speech generation' },
  { id: 'streaming', label: 'Streaming speech' },
  { id: 'multimodal', label: 'Multimodal input' },
];

export const ADAPTERS = {
  'browser-speech': {
    id: 'browser-speech',
    label: 'Browser / OS speech engine',
    where: 'on-device',
    transport: 'Web Speech API (speechSynthesis)',
    streaming: 'sentence',
    // Chromium's SpeechRecognition service is network-backed; speechSynthesis voices report
    // `localService` individually, which is why the adapter measures them at runtime.
    sttLocal: false,
    needsEndpoint: false,
  },
  'local-tts-server': {
    id: 'local-tts-server',
    label: 'Local TTS host (HTTP)',
    where: 'local-host',
    transport: 'POST /v1/audio/speech · GET /health',
    streaming: 'chunked-response',
    sttLocal: true,
    needsEndpoint: true,
  },
  'local-stt-server': {
    id: 'local-stt-server',
    label: 'Local STT host (HTTP)',
    where: 'local-host',
    transport: 'POST /v1/audio/transcriptions',
    streaming: 'none',
    sttLocal: true,
    needsEndpoint: true,
  },
  'qwen-omni-host': {
    id: 'qwen-omni-host',
    label: 'Qwen2.5-Omni host (Transformers)',
    where: 'local-host',
    transport: 'Operator-run Python service (no adapter in this build)',
    streaming: 'advertised',
    sttLocal: true,
    needsEndpoint: true,
  },
};

/** Catalogue. `install` is the repository's state, not a promise. */
export const VOICE_MODELS = [
  {
    id: 'browser-speech',
    name: 'Device speech engine',
    family: 'Platform · Web Speech API',
    adapter: 'browser-speech',
    roles: ['tts', 'stt'],
    streaming: 'sentence',
    cloning: false,
    languages: 'whatever the OS exposes',
    licence: 'Supplied by the operating system or browser',
    source: 'W3C Web Speech API, as implemented by the host',
    verification: 'runtime-probe',
    install: 'built-in',
    size: '0 MB (no artifact)',
    requires: ['A browser exposing speechSynthesis', 'At least one installed system voice'],
    limitations: [
      'Per-voice `localService` decides whether synthesis stays on the device.',
      'Chromium speech recognition is network-backed, so it is not offered offline.',
      'No voice cloning, no SSML, no word-level timings.',
    ],
  },
  {
    id: 'qwen2.5-omni',
    name: 'Qwen2.5-Omni (3B / 7B)',
    family: 'Qwen · multimodal speech + text',
    adapter: 'qwen-omni-host',
    roles: ['conversation', 'stt', 'tts', 'streaming', 'multimodal'],
    streaming: 'advertised',
    cloning: false,
    languages: 'see upstream model card',
    licence: 'Apache-2.0 declared upstream (re-verify the exact artifact)',
    source: 'https://github.com/QwenLM/Qwen2.5-Omni',
    verification: 'advertised',
    install: 'not-installed',
    size: 'not measured here — multi-GB weights',
    requires: [
      'A GPU/CPU host with enough memory (upstream reports substantial requirements)',
      'Pinned Transformers runtime and model revision',
      'An operator-run inference service exposing a documented HTTP contract',
    ],
    limitations: [
      'Nothing in this repository downloads or runs Qwen2.5-Omni.',
      '3B/7B are candidates, not evidence of mobile compatibility.',
      'Speech-generation support differs between serving stacks; the exact mode must be verified.',
    ],
  },
  {
    id: 'piper',
    name: 'Piper (local TTS host)',
    family: 'Piper · neural TTS',
    adapter: 'local-tts-server',
    roles: ['tts', 'streaming'],
    streaming: 'chunked-response',
    cloning: false,
    languages: 'per voice model',
    licence: 'MIT declared upstream (re-verify voices)',
    source: 'Operator-hosted Piper HTTP service',
    verification: 'contract-only',
    install: 'not-installed',
    size: 'per voice model',
    requires: ['A reachable loopback/host endpoint', 'A pinned voice model and licence review'],
    limitations: ['No engine was executed here.', 'Voice quality and latency are unmeasured.'],
  },
  {
    id: 'openvoice-v2',
    name: 'OpenVoice V2 (cloning candidate)',
    family: 'MyShell · voice cloning',
    adapter: 'local-tts-server',
    roles: ['tts'],
    streaming: 'none',
    cloning: true,
    languages: 'EN/ES/FR/ZH/JA/KO advertised upstream',
    licence: 'MIT declared upstream for V1/V2 (re-verify code and weights)',
    source: 'https://github.com/myshell-ai/OpenVoice',
    verification: 'contract-only',
    install: 'not-installed',
    size: 'not measured here',
    requires: ['Local host runtime', 'Explicit consent record per voice', 'Reference-audio validation'],
    limitations: [
      'Cloning is blocked until an engine is configured and consented.',
      'No mobile execution evidence; latency and memory unmeasured.',
    ],
  },
  {
    id: 'neutts-air',
    name: 'NeuTTS-Air (on-device candidate)',
    family: 'Neuphonic · on-device TTS/cloning',
    adapter: 'local-tts-server',
    roles: ['tts'],
    streaming: 'none',
    cloning: true,
    languages: 'see upstream model card',
    licence: 'Apache-2.0 for NeuTTS-Air; Nano/2E use a different licence (verify per artifact)',
    source: 'https://github.com/neuphonic/neutts',
    verification: 'contract-only',
    install: 'not-installed',
    size: 'per GGUF variant',
    requires: ['Local host runtime', 'Codec + model licence review', 'Consent record'],
    limitations: ['Not installed or executed here.', 'Mobile resource use is unverified.'],
  },
  {
    id: 'whisper-cpp',
    name: 'whisper.cpp (local STT host)',
    family: 'whisper.cpp · speech recognition',
    adapter: 'local-stt-server',
    roles: ['stt'],
    streaming: 'none',
    cloning: false,
    languages: 'per model',
    licence: 'MIT declared upstream (re-verify weights)',
    source: 'Operator-hosted whisper.cpp server',
    verification: 'contract-only',
    install: 'not-installed',
    size: 'per model',
    requires: ['Local endpoint', 'Pinned model artifact'],
    limitations: ['No transcription was run here.'],
  },
];

export const getModel = (id) => VOICE_MODELS.find((model) => model.id === id) || null;

/** Capability check that never guesses: a role is supported only when it is declared for the model. */
export function supports(modelId, capability) {
  const model = getModel(modelId);
  return Boolean(model && model.roles.includes(capability));
}

export function filterModels({ role = 'all', query = '', adapterStatus = {} } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  return VOICE_MODELS.filter((model) => {
    if (role !== 'all' && !model.roles.includes(role)) return false;
    if (!needle) return true;
    return `${model.name} ${model.family} ${model.roles.join(' ')} ${model.licence}`
      .toLowerCase()
      .includes(needle);
  }).map((model) => ({ ...model, availability: availabilityFor(model, adapterStatus) }));
}

export function availabilityFor(model, adapterStatus = {}) {
  const status = adapterStatus[model.adapter];
  if (model.install === 'built-in' || model.adapter === 'browser-speech') {
    if (!status) return { usable: false, reason: 'Capability probe has not run yet in this tab.' };
    if (status.status === 'available') return { usable: true, reason: status.detail };
    return { usable: false, reason: status.detail };
  }
  if (!status) return { usable: false, reason: 'No adapter is configured for this model in this build.' };
  if (status.status === 'available') return { usable: true, reason: status.detail };
  return { usable: false, reason: status.detail };
}

/**
 * Local-first routing. The result states where inference would run and why. It never selects a
 * hosted provider: this build has no cloud speech adapter at all.
 */
export function routeRequest({ modelId, capability, adapterStatus = {} }) {
  const model = getModel(modelId);
  if (!model) return { ok: false, location: 'none', reason: `Unknown model “${modelId}”.` };
  if (!model.roles.includes(capability)) {
    return { ok: false, location: 'none', reason: `${model.name} does not declare ${capability}.` };
  }
  const availability = availabilityFor(model, adapterStatus);
  if (!availability.usable) return { ok: false, location: ADAPTERS[model.adapter]?.where || 'none', reason: availability.reason };
  return {
    ok: true,
    location: ADAPTERS[model.adapter]?.where || 'unknown',
    reason: `${model.name} via ${ADAPTERS[model.adapter]?.label || model.adapter}.`,
    model,
    adapter: ADAPTERS[model.adapter],
  };
}
