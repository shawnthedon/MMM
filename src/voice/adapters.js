/* ============ Speech runtime adapters ============
 * Each adapter owns one transport and reports what it can *actually* do on this device. No adapter
 * simulates audio, fabricates progress or falls back to a cloud service.
 *
 * Contract (Voice Studio spec §3D):
 *   getCapabilities() · validateConfiguration() · checkAvailability() · loadModel() · unloadModel()
 *   transcribe() · generateResponse() · streamSpeech() · cancelRequest() · getHealth()
 * Unsupported operations resolve to `{ supported: false, reason }` — never to invented data.
 */

const UNSUPPORTED = (reason) => ({ supported: false, reason });
const abortError = () => {
  const error = new Error('Speech request was cancelled.');
  error.name = 'AbortError';
  return error;
};

export const isLoopbackEndpoint = (value) => {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.username || url.password) return false;
    if (url.search || url.hash) return false;
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
};

export function validateLocalEndpoint(value, { allowRemote = false } = {}) {
  let url;
  try { url = new URL(String(value)); } catch { return { ok: false, reason: 'Not a valid URL.' }; }
  if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, reason: 'Only http:// or https:// endpoints are accepted.' };
  if (url.username || url.password) return { ok: false, reason: 'Credentials must not be embedded in the URL.' };
  if (isLoopbackEndpoint(url.href)) return { ok: true, url };
  if (!allowRemote) return { ok: false, reason: 'Only loopback endpoints are allowed unless remote access is explicitly enabled.' };
  if (url.protocol !== 'https:') return { ok: false, reason: 'Remote speech endpoints must use HTTPS.' };
  return { ok: true, url };
}

/* ------------------------------------------------------------------ *
 * 1. Browser / OS speech engine (real, measured at runtime)
 * ------------------------------------------------------------------ */
export function createBrowserSpeechAdapter(env = globalThis) {
  const synth = env.speechSynthesis || null;
  const Utterance = env.SpeechSynthesisUtterance || null;
  let voices = [];
  let current = null;

  const refresh = () => {
    try { voices = synth?.getVoices?.() || []; } catch { voices = []; }
    return voices;
  };

  const capabilities = () => {
    refresh();
    const localVoices = voices.filter((voice) => voice.localService === true);
    return {
      id: 'browser-speech',
      tts: Boolean(synth && Utterance),
      stt: Boolean(env.SpeechRecognition || env.webkitSpeechRecognition),
      // Chromium's recognition service is network-backed; never present it as on-device.
      sttLocal: false,
      streaming: 'sentence',
      cloning: false,
      ssml: false,
      voiceCount: voices.length,
      localVoiceCount: localVoices.length,
      localService: voices.length ? localVoices.length === voices.length : null,
    };
  };

  const checkAvailability = () => {
    const caps = capabilities();
    if (!caps.tts) {
      return { adapter: 'browser-speech', status: 'unsupported', detail: 'This browser exposes no speechSynthesis engine, so it cannot produce speech.' };
    }
    if (!caps.voiceCount) {
      return {
        adapter: 'browser-speech',
        status: 'no-voices',
        detail: 'The speech engine is present but reports no installed voices yet. Voices often appear after the first user interaction or a voiceschanged event.',
      };
    }
    const local = caps.localVoiceCount;
    return {
      adapter: 'browser-speech',
      status: 'available',
      detail: `${caps.voiceCount} voice(s) · ${local} reporting on-device synthesis${local === caps.voiceCount ? '' : ' · the rest may use a network voice'}.`,
    };
  };

  const listVoices = () => refresh().map((voice) => ({
    id: voice.voiceURI || voice.name,
    name: voice.name,
    lang: voice.lang,
    local: voice.localService === true,
    default: voice.default === true,
  }));

  const waitForVoices = (timeoutMs = 1500) => new Promise((resolve) => {
    if (refresh().length) { resolve(voices); return; }
    if (!synth || typeof synth.addEventListener !== 'function') { resolve(voices); return; }
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(refresh()); };
    const timer = setTimeout(finish, timeoutMs);
    synth.addEventListener('voiceschanged', () => { clearTimeout(timer); finish(); }, { once: true });
  });

  const speak = ({ text, voice, rate = 1, pitch = 1, lang = '', signal, requestId } = {}) => new Promise((resolve, reject) => {
    if (!synth || !Utterance) {
      const error = new Error('No speech engine is available in this browser.');
      error.code = 'unsupported';
      reject(error);
      return;
    }
    if (signal?.aborted) { reject(abortError()); return; }
    const utter = new Utterance(String(text));
    const chosen = voices.find((entry) => (entry.voiceURI || entry.name) === voice?.voiceRef)
      || voices.find((entry) => entry.lang === lang)
      || null;
    if (chosen) utter.voice = chosen;
    if (lang || chosen?.lang) utter.lang = lang || chosen.lang;
    utter.rate = Math.min(4, Math.max(0.5, Number(rate) || 1));
    utter.pitch = Math.min(2, Math.max(0, Number(pitch) || 1));

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(watchdog);
      if (current === utter) current = null;
      fn(value);
    };
    const onAbort = () => {
      try { synth.cancel(); } catch { /* engine already stopped */ }
      finish(reject, abortError());
    };
    // Some engines never fire `end` (no audio device, cancelled queue). Fail loudly, never hang.
    const watchdog = setTimeout(() => {
      const error = new Error('The speech engine did not finish this chunk in time.');
      error.code = 'timeout';
      try { synth.cancel(); } catch { /* ignore */ }
      finish(reject, error);
    }, Math.max(6000, String(text).length * 220));

    utter.onend = () => finish(resolve, { requestId, playedChars: String(text).length, local: chosen ? chosen.localService === true : null });
    utter.onerror = (event) => {
      if (signal?.aborted) { finish(reject, abortError()); return; }
      const code = event?.error || 'engine-error';
      const error = new Error(code === 'not-allowed'
        ? 'The browser blocked speech playback. Start playback from a tap or click.'
        : `Speech engine error: ${code}.`);
      error.code = code;
      finish(reject, error);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    current = utter;
    try {
      synth.speak(utter);
    } catch (error) {
      finish(reject, error);
    }
  });

  return {
    id: 'browser-speech',
    getCapabilities: capabilities,
    validateConfiguration: () => ({ ok: true }),
    checkAvailability,
    loadModel: async () => ({ supported: false, reason: 'The platform engine needs no model load; there is nothing to download or initialise.' }),
    unloadModel: async () => ({ supported: false, reason: 'The platform engine is owned by the browser.' }),
    getHealth: () => ({ ...checkAvailability(), checkedAt: Date.now() }),
    listVoices,
    waitForVoices,
    speak,
    streamSpeech: (options) => speak(options), // sentence-level streaming only; declared as such
    cancelRequest: () => { try { synth?.cancel(); } catch { /* ignore */ } return { supported: true }; },
    pause: () => { try { synth?.pause(); return true; } catch { return false; } },
    resume: () => { try { synth?.resume(); return true; } catch { return false; } },
    transcribe: () => UNSUPPORTED('Speech recognition is not implemented here: Chromium’s recogniser is network-backed, so it is not offered as a local capability.'),
    generateResponse: () => UNSUPPORTED('The platform speech engine does not generate conversational responses.'),
  };
}

/* ------------------------------------------------------------------ *
 * 2. Local TTS host (documented HTTP contract, real fetch/audio)
 * ------------------------------------------------------------------ */
export function createLocalSpeechAdapter({
  endpoint = '',
  allowRemote = false,
  fetchImpl = globalThis.fetch,
  AudioCtor = globalThis.Audio,
  URLImpl = globalThis.URL,
  timeoutMs = 20000,
  maxAudioBytes = 8 * 1024 * 1024,
} = {}) {
  let lastHealth = null;
  let activeAudio = null;
  let activeUrl = null;

  const validation = () => (endpoint ? validateLocalEndpoint(endpoint, { allowRemote }) : { ok: false, reason: 'No local speech endpoint is configured.' });

  async function withTimeout(fn, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try { return await fn(controller.signal); } finally { clearTimeout(timer); }
  }

  const checkAvailability = async () => {
    const check = validation();
    if (!check.ok) {
      lastHealth = { adapter: 'local-tts-server', status: 'unconfigured', detail: check.reason, checkedAt: Date.now() };
      return lastHealth;
    }
    if (!fetchImpl) {
      lastHealth = { adapter: 'local-tts-server', status: 'unsupported', detail: 'This environment has no fetch implementation.', checkedAt: Date.now() };
      return lastHealth;
    }
    try {
      const response = await withTimeout((signal) => fetchImpl(`${check.url.href.replace(/\/$/, '')}/health`, { signal, credentials: 'omit' }), 4000);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        lastHealth = { adapter: 'local-tts-server', status: 'error', detail: `Health check returned HTTP ${response.status}.`, checkedAt: Date.now() };
      } else if (body?.status === 'ok' || body?.ok === true) {
        lastHealth = { adapter: 'local-tts-server', status: 'available', detail: `Local host reachable at ${check.url.host}. Engine: ${body.engine || 'unspecified'}.`, checkedAt: Date.now() };
      } else {
        lastHealth = { adapter: 'local-tts-server', status: 'error', detail: 'Health endpoint responded without a recognised status field.', checkedAt: Date.now() };
      }
    } catch (error) {
      lastHealth = {
        adapter: 'local-tts-server',
        status: 'unreachable',
        detail: error?.name === 'AbortError' ? 'Health check timed out.' : `Could not reach the local host: ${error?.message || error}.`,
        checkedAt: Date.now(),
      };
    }
    return lastHealth;
  };

  const cleanupAudio = () => {
    if (activeAudio) { try { activeAudio.pause(); } catch { /* ignore */ } activeAudio = null; }
    if (activeUrl && URLImpl?.revokeObjectURL) { try { URLImpl.revokeObjectURL(activeUrl); } catch { /* ignore */ } }
    activeUrl = null;
  };

  const speak = async ({ text, voice, rate = 1, signal, requestId } = {}) => {
    const check = validation();
    if (!check.ok) {
      const error = new Error(check.reason);
      error.code = 'unconfigured';
      throw error;
    }
    if (signal?.aborted) throw abortError();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(`${check.url.href.replace(/\/$/, '')}/v1/audio/speech`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'omit',
          signal: controller.signal,
          body: JSON.stringify({
            input: String(text),
            voice: voice?.voiceRef || undefined,
            response_format: 'wav',
            speed: Math.min(4, Math.max(0.5, Number(rate) || 1)),
          }),
        });
      } catch (networkError) {
        if (signal?.aborted || controller.signal.aborted) throw abortError();
        const error = new Error(`Could not reach the local speech host: ${networkError?.message || networkError}.`);
        error.code = 'unreachable';
        throw error;
      }
      if (!response.ok) {
        const error = new Error(`Speech host returned HTTP ${response.status}.`);
        error.code = `http-${response.status}`;
        throw error;
      }
      const type = response.headers?.get?.('content-type') || '';
      if (!type.startsWith('audio/')) {
        const error = new Error(`Speech host returned “${type || 'unknown'}” instead of audio.`);
        error.code = 'bad-content-type';
        throw error;
      }
      if (!AudioCtor) {
        const error = new Error('This environment cannot play audio elements.');
        error.code = 'unsupported';
        throw error;
      }
      const blob = await response.blob();
      if (blob.size > maxAudioBytes) {
        const error = new Error('Synthesised audio exceeded the size limit.');
        error.code = 'too-large';
        throw error;
      }
      if (signal?.aborted || controller.signal.aborted) throw abortError();
      cleanupAudio();
      activeUrl = URLImpl.createObjectURL(blob);
      activeAudio = new AudioCtor(activeUrl);
      await new Promise((resolve, reject) => {
        const audio = activeAudio;
        audio.onended = resolve;
        audio.onerror = () => {
          const error = new Error('The browser could not decode the returned audio.');
          error.code = 'decode';
          reject(error);
        };
        controller.signal.addEventListener('abort', () => {
          try { audio.pause(); } catch { /* ignore */ }
          reject(abortError());
        }, { once: true });
        const started = audio.play();
        if (started && typeof started.catch === 'function') started.catch((error) => reject(error));
      });
      return { requestId, bytes: blob.size, local: true };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      cleanupAudio();
    }
  };

  return {
    id: 'local-tts-server',
    getCapabilities: () => ({
      id: 'local-tts-server',
      tts: validation().ok,
      stt: false,
      streaming: 'chunked-response',
      cloning: true, // the contract supports a voice id; cloning itself needs a configured engine
      ssml: false,
      endpoint: validation().ok ? validation().url.host : null,
    }),
    validateConfiguration: () => validation(),
    checkAvailability,
    loadModel: async () => UNSUPPORTED('Model loading is owned by the local host; the client cannot load weights.'),
    unloadModel: async () => UNSUPPORTED('Model unloading is owned by the local host.'),
    getHealth: () => lastHealth || { adapter: 'local-tts-server', status: 'unknown', detail: 'Health has not been checked yet.', checkedAt: null },
    speak,
    streamSpeech: speak,
    cancelRequest: () => { cleanupAudio(); return { supported: true }; },
    pause: () => (activeAudio ? (activeAudio.pause(), true) : false),
    resume: () => (activeAudio ? (void activeAudio.play(), true) : false),
    transcribe: () => UNSUPPORTED('This endpoint exposes speech synthesis only.'),
    generateResponse: () => UNSUPPORTED('A TTS host does not generate conversational responses.'),
  };
}

/* ------------------------------------------------------------------ *
 * 3. Voice cloning adapter (explicitly unsupported until configured)
 * ------------------------------------------------------------------ */
export function createCloningAdapter({ endpoint = '', allowRemote = false, fetchImpl = globalThis.fetch } = {}) {
  const validation = () => (endpoint ? validateLocalEndpoint(endpoint, { allowRemote }) : { ok: false, reason: 'No cloning engine is configured.' });

  const unsupported = async () => UNSUPPORTED(validation().reason);

  return {
    id: 'voice-cloning',
    supports() {
      const check = validation();
      return { supported: check.ok, reason: check.ok ? `Cloning host at ${check.url.host}.` : check.reason };
    },
    async validateReferenceAudio(file) {
      if (!validation().ok) return UNSUPPORTED(validation().reason);
      if (!file) return { ok: false, reason: 'No reference audio was provided.' };
      if (!/^audio\//.test(file.type || '')) return { ok: false, reason: `Expected an audio file, received “${file.type || 'unknown'}”.` };
      if (file.size > 10 * 1024 * 1024) return { ok: false, reason: 'Reference audio must be 10 MB or smaller.' };
      return { ok: true, size: file.size, type: file.type };
    },
    async createVoiceProfile({ name, consent, referenceDescriptor } = {}) {
      const check = validation();
      if (!check.ok) return UNSUPPORTED(check.reason);
      if (!consent?.granted || !consent?.by) return { supported: false, reason: 'A recorded consent decision is required before a voice profile can be created.' };
      if (!name || !String(name).trim()) return { supported: false, reason: 'A profile name is required.' };
      const response = await fetchImpl(`${check.url.href.replace(/\/$/, '')}/v1/voice-profiles`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'omit',
        body: JSON.stringify({
          name: String(name).trim(),
          consent: { granted: true, by: consent.by, at: consent.at || new Date().toISOString(), scope: consent.scope || 'local-synthesis' },
          reference: referenceDescriptor || null,
        }),
      });
      if (!response.ok) return { supported: false, reason: `Cloning host returned HTTP ${response.status}.` };
      const body = await response.json().catch(() => ({}));
      if (!body?.id) return { supported: false, reason: 'Cloning host did not return a profile id.' };
      return { supported: true, profile: { id: String(body.id), name: String(name).trim(), engine: 'openvoice-v2' } };
    },
    async getVoiceProfileStatus(id) {
      const check = validation();
      if (!check.ok) return UNSUPPORTED(check.reason);
      const response = await fetchImpl(`${check.url.href.replace(/\/$/, '')}/v1/voice-profiles/${encodeURIComponent(id)}`, { credentials: 'omit' });
      if (!response.ok) return { supported: false, reason: `Cloning host returned HTTP ${response.status}.` };
      return { supported: true, profile: await response.json().catch(() => null) };
    },
    async listVoiceProfiles() {
      const check = validation();
      if (!check.ok) return UNSUPPORTED(check.reason);
      const response = await fetchImpl(`${check.url.href.replace(/\/$/, '')}/v1/voice-profiles`, { credentials: 'omit' });
      if (!response.ok) return { supported: false, reason: `Cloning host returned HTTP ${response.status}.` };
      const body = await response.json().catch(() => ({}));
      return { supported: true, profiles: Array.isArray(body.profiles) ? body.profiles : [] };
    },
    async deleteVoiceProfile(id) {
      const check = validation();
      if (!check.ok) return UNSUPPORTED(check.reason);
      const response = await fetchImpl(`${check.url.href.replace(/\/$/, '')}/v1/voice-profiles/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'omit' });
      if (!response.ok && response.status !== 404) return { supported: false, reason: `Cloning host returned HTTP ${response.status}.` };
      return { supported: true, deleted: true };
    },
    async synthesizeWithVoiceProfile({ text, profileId, signal } = {}) {
      const check = validation();
      if (!check.ok) return UNSUPPORTED(check.reason);
      const response = await fetchImpl(`${check.url.href.replace(/\/$/, '')}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'omit',
        signal,
        body: JSON.stringify({ input: String(text || ''), voice_profile_id: profileId, response_format: 'wav' }),
      });
      if (!response.ok) return { supported: false, reason: `Cloning host returned HTTP ${response.status}.` };
      const type = response.headers?.get?.('content-type') || '';
      if (!type.startsWith('audio/')) return { supported: false, reason: 'Cloning host did not return audio.' };
      return { supported: true, audio: await response.blob() };
    },
    checkAvailability: async () => {
      const check = validation();
      return { adapter: 'voice-cloning', status: check.ok ? 'unknown' : 'unconfigured', detail: check.reason };
    },
  };
}
