/* ============ Which microphone path, and what it costs you ============
 * The Copilot offers three ways to get words in, and they are not interchangeable — one keeps audio on
 * your network, one sends it to a browser vendor, one sends nothing at all. The order below is the rule:
 *
 *   1. **local** — a speech host the operator configured on the gateway (unit 5). Audio goes to that host
 *      over the gateway, is transcribed, and is never stored. This wins when it exists, because it is the
 *      only path where the audio stays inside the deployment.
 *   2. **browser** — the platform recogniser. It is network-backed in every shipping browser, so it is
 *      opt-in and it says so, every time, in its own words.
 *   3. **text** — always available, never gated, and the reason the first two can be refused at all.
 *
 * The one thing this module will not do is fall back *sideways*: if the local host fails after the person
 * spoke, the audio is not quietly re-sent to a vendor recogniser. A failure is reported and the person
 * decides — that is the difference between a fallback and a leak.
 */
import { can, isAuthenticated } from '../auth.js';
import { api, isApiMode } from '../api.js';
import { captureSupport } from '../voice/capture.js';

export const TRANSPORTS = Object.freeze(['local-stt', 'browser-recognition', 'text']);

export const CONSENT_COPY = Object.freeze({
  local: {
    title: 'Allow voice input through your gateway?',
    body: 'The recording is sent to the speech host configured on your gateway, which is on your own network. It is transcribed there, the audio is not stored, and the transcript comes back to this composer for you to read before sending.',
    allow: 'Allow local voice input',
  },
  network: {
    title: 'Allow voice input?',
    body: 'Your browser’s speech service receives the audio. Nothing else is sent, and nothing is stored here beyond this choice.',
    allow: 'Allow voice input',
  },
});

/** Does this browser expose the platform recogniser at all? */
export function recognitionAvailable(env = globalThis) {
  try {
    return Boolean(env.SpeechRecognition || env.webkitSpeechRecognition);
  } catch {
    return false;
  }
}

/**
 * Choose a transport from facts, in the documented order. `capabilities` is the gateway's
 * `GET /api/v1/voice` payload (or null when there is no gateway); `support` is `captureSupport()`.
 */
export function resolvePath({ capabilities = null, support = null, online = true, env = globalThis } = {}) {
  // Offline first: the local host lives behind the gateway, so "no network" means the local path is
  // unreachable too — and a recogniser that cannot reach its service would only fail after recording.
  if (!online) {
    return {
      transport: 'text',
      requiresConsent: null,
      reason: 'Offline: the gateway’s speech host and the browser’s speech service are both unreachable. Type instead.',
      support,
    };
  }
  const localReady = Boolean(capabilities?.localStt) && Boolean(support?.ok);
  if (localReady) {
    return {
      transport: 'local-stt',
      requiresConsent: 'local',
      reason: 'A speech host is configured on your gateway, so the recording is transcribed there and stays on your network.',
      support,
    };
  }
  const localBlocked = Boolean(capabilities?.localStt) && support && !support.ok ? support.reason : '';
  if (recognitionAvailable(env)) {
    return {
      transport: 'browser-recognition',
      requiresConsent: 'network',
      reason: capabilities?.localStt
        ? `${localBlocked || 'Local recording is unavailable in this browser'}, so the browser’s network speech service is the only microphone path.`
        : 'No local speech host is configured, so the browser’s speech service is the only microphone path — it processes audio online.',
      support,
    };
  }
  return {
    transport: 'text',
    requiresConsent: null,
    reason: localBlocked
      ? `Voice input is unavailable: ${localBlocked.replace(/^This browser/, 'this browser')} This browser also has no speech recogniser, so typing is the only way in.`
      : 'Voice input is unavailable in this browser — no speech recogniser, and no local speech host configured. Typing always works.',
    support,
  };
}

/** The gateway's voice capabilities, or null when there is nothing to ask. */
export async function loadCapabilities({ silent = true } = {}) {
  if (!isApiMode() || !isAuthenticated() || !can('voice:read')) {
    return { ok: false, capabilities: null, reason: 'no-gateway' };
  }
  try {
    const out = await api.voiceCapabilities();
    return { ok: true, capabilities: out.body || null };
  } catch (error) {
    return { ok: false, capabilities: null, reason: error?.message || 'voice capabilities could not be read', silent };
  }
}

/**
 * Send one clip to the gateway and come back with text or a reason. Never throws, never invents a
 * transcript: the caller renders `reason` verbatim.
 */
export async function transcribe(blob, { endpointId = '', language = '', signal } = {}) {
  if (!isApiMode() || !isAuthenticated()) {
    return { ok: false, code: 'no-gateway', reason: 'No gateway is connected, so there is no speech host to transcribe with.' };
  }
  if (!can('voice:transcribe')) {
    return { ok: false, code: 'forbidden', reason: 'Your role cannot send audio to the gateway’s speech host.' };
  }
  if (!blob || !blob.size) {
    return { ok: false, code: 'empty-recording', reason: 'The recording was empty, so there was nothing to transcribe.' };
  }
  try {
    const out = await api.voiceTranscribe(blob, { endpointId, language, signal });
    const body = out.body || {};
    return {
      ok: true,
      text: String(body.text || ''),
      empty: Boolean(body.empty),
      engine: body.engine || '',
      endpointLabel: body.endpointLabel || '',
      stayedLocal: body.stayedLocal !== false,
      elapsedMs: body.elapsedMs || 0,
    };
  } catch (error) {
    const body = error?.body || {};
    const status = error?.status || 0;
    const code = body.code || (status === 0 ? 'unreachable' : `http-${status}`);
    return {
      ok: false,
      code,
      reason: error?.message || 'the transcription failed',
      hint: body.hint || '',
      hostStatus: body.hostStatus || null,
      hostless: code === 'no-endpoint',
    };
  }
}

/** What the panel says after a clip came back. Split out so the wording is testable without a DOM. */
export function transcriptNote(result) {
  if (!result?.ok) {
    const hint = result?.hint ? ` ${result.hint}` : '';
    return `Nothing was transcribed: ${result?.reason || 'the speech host did not answer'}.${hint} Typing still works.`;
  }
  if (result.empty) {
    return 'The speech host heard nothing in that clip. Nothing was typed — try again, or type instead.';
  }
  return `Transcribed by ${result.endpointLabel || result.engine || 'the local speech host'}${result.stayedLocal ? ' (audio stayed on your network)' : ''} — review it, then send.`;
}

export const support = captureSupport;
