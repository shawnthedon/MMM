/* ============ Open-source voice: what may be spoken, and to where ============
 * Two things live here, and they are both about not inventing things:
 *
 *   1. The **engine catalogue** — every model MMM is willing to talk to, with the licence read from the
 *      upstream repository rather than copied from a blog post. `verifiedAt` is the date the SPDX id was
 *      read from `api.github.com/repos/<owner>/<repo>/license`; an engine without a verification is
 *      labelled `advertised` and is not offered.
 *   2. The **local speech host contract** — the exact HTTP shapes MMM will call. Two transcription modes
 *      exist because two real things exist: whisper.cpp's own server (`POST /inference`, multipart) and
 *      the OpenAI-shaped `POST /v1/audio/transcriptions` that wrappers such as faster-whisper servers
 *      expose. There is no third "standard", and neither is guessed at run time: the endpoint record
 *      says which one it is.
 *
 * Nothing here decides whether audio *leaves* the machine — that is the endpoint validator's job, and it
 * refuses anything that is not loopback unless a deployment explicitly opts in.
 */

export const SPEECH_MODES = Object.freeze(['whisper.cpp', 'openai']);

/**
 * Transcription endpoint paths per mode. whisper.cpp's own server documents `/inference`; the
 * OpenAI-compatible shape is `/v1/audio/transcriptions`. Both take multipart/form-data with a `file`
 * part, and both answer with JSON carrying `text`.
 */
export const TRANSCRIBE_PATHS = Object.freeze({
  'whisper.cpp': '/inference',
  openai: '/v1/audio/transcriptions',
});

/** Synthesis path for a local TTS host (Voice Studio's existing contract — unchanged by this unit). */
export const SYNTHESIS_PATH = '/v1/audio/speech';

/** Health probe. Optional: a host without one is `unknown`, which is not the same as `unreachable`. */
export const HEALTH_PATH = '/health';

export const VOICE_LIMITS = Object.freeze({
  audioBytes: 6 * 1024 * 1024,   // a 2-minute Opus clip is well under this; a wav dump is not
  durationMs: 120000,
  timeoutMs: 30000,
  endpoints: 12,
  transcriptChars: 2000,
});

/**
 * The catalogue. `server` says what the project itself ships:
 *   'http'    — the project documents an HTTP endpoint MMM can call directly
 *   'cli'     — the project ships a CLI/library; an HTTP wrapper is required and is the operator's
 *   'library' — a library only
 * An engine is only *offerable* as an endpoint when `server === 'http'`; the rest are listed so a person
 * can see what exists, with the truth about what still has to be installed.
 */
export const VOICE_ENGINES = Object.freeze([
  {
    id: 'whisper.cpp',
    label: 'whisper.cpp server',
    roles: ['stt'],
    server: 'http',
    mode: 'whisper.cpp',
    licence: { spdx: 'MIT', name: 'MIT License', path: 'LICENSE', repo: 'ggml-org/whisper.cpp' },
    verified: true,
    verifiedAt: '2026-11-02',
    verifiedVia: 'api.github.com/repos/ggml-org/whisper.cpp/license',
    note: 'Documents POST /inference (multipart `file`, `response_format=json` → {"text": …}). The old ggerganov/whisper.cpp path redirects here.',
  },
  {
    id: 'faster-whisper-server',
    label: 'An OpenAI-compatible wrapper over faster-whisper',
    roles: ['stt'],
    server: 'http',
    mode: 'openai',
    licence: { spdx: 'MIT', name: 'MIT License', path: 'LICENSE', repo: 'SYSTRAN/faster-whisper' },
    verified: true,
    verifiedAt: '2026-11-02',
    verifiedVia: 'api.github.com/repos/SYSTRAN/faster-whisper/license',
    note: 'faster-whisper itself is a Python library; the HTTP surface comes from a wrapper the operator runs. The licence above is the library’s, not any particular wrapper’s.',
  },
  {
    id: 'piper',
    label: 'Piper',
    roles: ['tts'],
    server: 'cli',
    mode: '',
    licence: { spdx: 'MIT', name: 'MIT License', path: 'LICENSE.md', repo: 'rhasspy/piper' },
    verified: true,
    verifiedAt: '2026-11-02',
    verifiedVia: 'api.github.com/repos/rhasspy/piper/license',
    note: 'A CLI/library. A local TTS host must wrap it before MMM can speak through it; Voice Studio already speaks to such a host when one is configured.',
  },
  {
    id: 'kokoro',
    label: 'Kokoro',
    roles: ['tts'],
    server: 'library',
    mode: '',
    licence: { spdx: 'Apache-2.0', name: 'Apache License 2.0', path: 'LICENSE', repo: 'hexgrad/kokoro' },
    verified: true,
    verifiedAt: '2026-11-02',
    verifiedVia: 'api.github.com/repos/hexgrad/kokoro/license',
    note: 'Python package; no server of its own. Weight-level licensing is separate from the code licence and is not verified here.',
  },
  {
    id: 'openvoice',
    label: 'OpenVoice',
    roles: ['tts', 'clone'],
    server: 'library',
    mode: '',
    licence: { spdx: 'MIT', name: 'MIT License', path: 'LICENSE', repo: 'myshell-ai/OpenVoice' },
    verified: false,
    verifiedAt: null,
    verifiedVia: '',
    note: 'Cloning engine reached through Voice Studio’s cloning contract when a host is configured. Licence claim is the project’s own; not re-verified this session.',
  },
  {
    id: 'neutts',
    label: 'NeuTTS Air',
    roles: ['tts', 'clone'],
    server: 'library',
    mode: '',
    licence: { spdx: 'Apache-2.0', name: 'Apache License 2.0', path: 'LICENSE', repo: 'neuphonic/neutts' },
    verified: false,
    verifiedAt: null,
    verifiedVia: '',
    note: 'Other NeuTTS variants differ; weights and demo assets are not covered by the code licence. Not re-verified this session.',
  },
]);

export const engineById = (id) => VOICE_ENGINES.find((e) => e.id === id) || null;
export const enginesFor = (role) => VOICE_ENGINES.filter((e) => e.roles.includes(role));
/** Engines MMM can point an endpoint at without the operator writing a wrapper. */
export const offerableEngines = (role) => enginesFor(role).filter((e) => e.server === 'http');

/**
 * The endpoint validator. Loopback by default: speech audio is the most sensitive payload this app
 * handles, so an endpoint on another machine has to be switched on deliberately, must be HTTPS, and is
 * reported as remote everywhere it appears.
 */
export function validateVoiceEndpoint(value, { allowRemote = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw) return { ok: false, reason: 'no endpoint url given' };
  let url;
  try { url = new URL(raw); } catch { return { ok: false, reason: `“${raw.slice(0, 60)}” is not a url` }; }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { ok: false, reason: `“${url.protocol}” is not allowed — a speech endpoint must be http or https` };
  }
  if (url.username || url.password) return { ok: false, reason: 'credentials must not be embedded in the url' };
  if (url.search || url.hash) return { ok: false, reason: 'the endpoint url must not carry a query string or fragment' };
  // Pointing at the request path instead of the host root is the single most common misconfiguration, and
  // it fails as a mysterious 404 *after* a recording has been uploaded. Refuse it here, where the message
  // can say what to do.
  const requestPaths = Object.values(TRANSCRIBE_PATHS);
  const tail = url.pathname.replace(/\/+$/, '');
  if (requestPaths.some((p) => tail === p || tail.endsWith(p))) {
    return { ok: false, reason: 'give the host root, not the request path — MMM appends it (for whisper.cpp the call is POST <root>/inference)' };
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (loopback) return { ok: true, url, remote: false };
  if (!allowRemote) {
    return { ok: false, reason: 'only a loopback host is accepted — enable remote speech hosts in the gateway config to use another machine' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'a remote speech host must use https' };
  return { ok: true, url, remote: true };
}

/** Absolute endpoint URL for a path, without a double slash and without dropping a sub-path. */
export function endpointUrl(base, path) {
  const trimmed = String(base || '').replace(/\/+$/, '');
  return `${trimmed}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Audio types a local host is expected to accept. Anything else is refused before it is uploaded. */
export const AUDIO_TYPES = Object.freeze([
  'audio/webm', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mpeg',
  'audio/mp4', 'audio/flac', 'audio/x-flac', 'audio/x-m4a',
]);

export function audioProblem(mimeType, bytes) {
  const type = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (!type) return 'the recording carried no content type';
  if (!AUDIO_TYPES.includes(type)) return `“${type}” is not an audio type a speech host will accept`;
  if (!Number.isFinite(bytes) || bytes <= 0) return 'the recording was empty';
  if (bytes > VOICE_LIMITS.audioBytes) {
    return `the recording is ${Math.round(bytes / 1024)} kB, over the ${Math.round(VOICE_LIMITS.audioBytes / 1024)} kB limit`;
  }
  return '';
}

/**
 * Read a transcription response. Both modes answer with JSON; whisper.cpp returns `{text}` (plus
 * segments), OpenAI-shaped servers return `{text}`. A response without a string `text` is a failure,
 * never an empty transcript — the difference matters, because "nothing was said" and "the host did not
 * answer in the shape we understand" must not look the same to the person who just spoke.
 */
export function readTranscript(payload) {
  const text = typeof payload?.text === 'string' ? payload.text : null;
  if (text === null) return { ok: false, reason: 'the speech host answered without a text field' };
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length > VOICE_LIMITS.transcriptChars) {
    return { ok: false, reason: `the transcript is longer than ${VOICE_LIMITS.transcriptChars} characters` };
  }
  return { ok: true, text: clean, empty: clean.length === 0, language: String(payload?.language || '').slice(0, 16) };
}

/** The catalogue as the API reports it: what exists, what is verified, what can be pointed at today. */
export function engineCatalogue() {
  return VOICE_ENGINES.map((engine) => ({
    id: engine.id,
    label: engine.label,
    roles: [...engine.roles],
    server: engine.server,
    mode: engine.mode,
    offerable: engine.server === 'http',
    note: engine.note,
    licence: { ...engine.licence, verified: engine.verified, verifiedAt: engine.verifiedAt, verifiedVia: engine.verifiedVia },
  }));
}
