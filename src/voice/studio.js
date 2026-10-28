/* ============ Live type-to-speech controller ============
 * Owns one editor's worth of speech state: generation ids, sentence buffering, the playback queue,
 * the active voice profile and the error surface. Framework-free so the acceptance tests can drive
 * it with a fake engine and prove the stale-audio rules.
 */
import { createSentenceBuffer, segment } from './chunker.js';
import { createSpeechQueue } from './queue.js';
import { resolveActiveProfile } from './profiles.js';

export const STRATEGIES = [
  { id: 'sentence', label: 'Sentence chunks', hint: 'Speak each finished sentence — recommended.' },
  { id: 'phrase', label: 'Short phrase chunks', hint: 'Split at commas too; more, shorter utterances.' },
  { id: 'manual', label: 'Manual playback only', hint: 'Nothing is spoken until you press Play.' },
];

export const DEFAULT_STUDIO_SETTINGS = {
  autoSpeak: true,
  strategy: 'sentence',
  selectedProfileId: 'my-cloned-voice',
  modelId: 'browser-speech',
  rate: 1,
  pitch: 1,
  lang: '',
  idleFlushMs: 900,
  maxChars: 280,
};

const nowDefault = () => Date.now();

/** Split a sentence into shorter phrases for the `phrase` strategy. */
export function phraseSplit(text, maxChars = 90) {
  const parts = String(text)
    .split(/(?<=[,;:])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const out = [];
  for (const part of parts) {
    if (part.length <= maxChars) { out.push(part); continue; }
    out.push(...segment(part, { maxChars, allowIncomplete: true }).filter((chunk) => chunk.complete).map((chunk) => chunk.text));
  }
  return out.length ? out : [String(text).trim()].filter(Boolean);
}

export function createVoiceStudio({
  engine,
  profiles = [],
  cloningSupport = { supported: false, reason: 'No cloning engine is configured.' },
  settings = DEFAULT_STUDIO_SETTINGS,
  persist = null,
  onState = () => {},
  now = nowDefault,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
  queue: injectedQueue = null,
} = {}) {
  if (!engine) throw new Error('createVoiceStudio requires a speech engine');

  let config = { ...DEFAULT_STUDIO_SETTINGS, ...(settings || {}) };
  let text = '';
  let status = 'idle'; // idle | buffering | speaking | paused | error | blocked
  let error = null;
  let spokenChunks = 0;
  let lastSpokenAt = null;
  let flushTimer = null;
  let disposed = false;

  const buffer = createSentenceBuffer({ maxChars: config.maxChars });
  const queue = injectedQueue || createSpeechQueue({
    engine,
    onEvent: (event) => {
      if (event.type === 'chunk-end') { spokenChunks += 1; lastSpokenAt = now(); }
      if (event.type === 'error') { error = event.error; status = 'error'; }
      if (event.type === 'status' && status !== 'error') {
        if (event.status === 'speaking') status = 'speaking';
        else if (event.status === 'paused') status = 'paused';
        else if (event.status === 'idle' && status === 'speaking') status = 'idle';
      }
      publish();
    },
  });

  const adapters = { cloning: cloningSupport, speech: { status: 'available' } };

  function snapshot() {
    const active = resolveActiveProfile({ profiles, requestedId: config.selectedProfileId, adapters });
    return {
      text,
      status,
      error,
      config: { ...config },
      generation: queue.generation,
      queued: queue.snapshot().queued.length,
      spokenChunks,
      lastSpokenAt,
      activeProfile: active.profile,
      requestedProfile: config.selectedProfileId,
      fallbackReason: active.reason,
      usingFallback: active.fallback,
      pendingText: buffer.pendingText(),
    };
  }

  function publish() {
    if (disposed) return;
    onState(snapshot());
  }

  function persistPatch(patch) {
    config = { ...config, ...patch };
    if (typeof persist === 'function') {
      try { persist({ ...config }); } catch { /* persistence is best effort; never break speech */ }
    }
  }

  function clearFlush() {
    if (flushTimer != null) { clearTimer(flushTimer); flushTimer = null; }
  }

  function chunkFor(textValue) {
    if (config.strategy !== 'phrase') return [textValue];
    return phraseSplit(textValue, Math.min(90, config.maxChars));
  }

  function queueChunks(chunks, meta = {}) {
    if (!chunks.length) return 0;
    const active = resolveActiveProfile({ profiles, requestedId: config.selectedProfileId, adapters });
    if (!active.profile) {
      error = { code: 'no-profile', message: active.reason };
      status = 'blocked';
      publish();
      return 0;
    }
    if (active.profile.kind === 'cloned' && !active.profile.consent?.granted) {
      error = { code: 'no-consent', message: `“${active.profile.name}” has no recorded consent.` };
      status = 'blocked';
      publish();
      return 0;
    }
    const accepted = queue.enqueue(chunks, {
      profile: active.profile,
      rate: config.rate,
      pitch: config.pitch,
      lang: config.lang,
      meta,
    });
    if (!accepted.length) { publish(); return 0; }
    error = null;
    if (status !== 'speaking') status = 'buffering';
    void queue.play().then(() => { if (status !== 'error' && status !== 'blocked') status = 'idle'; publish(); });
    publish();
    return accepted.length;
  }

  function scheduleIdleFlush() {
    clearFlush();
    if (!config.autoSpeak || config.strategy === 'manual') return;
    flushTimer = setTimer(() => { flushTimer = null; flush({ reason: 'idle' }); }, Math.max(120, Number(config.idleFlushMs) || 900));
  }

  /** Emit the unfinished remainder (Play, idle flush, or leaving the field). */
  function flush({ reason = 'manual' } = {}) {
    clearFlush();
    const remainder = buffer.flush();
    if (!remainder) { publish(); return 0; }
    return queueChunks(chunkFor(remainder), { reason, final: true });
  }

  /** A material change invalidates every queued and in-flight chunk. */
  function newGeneration({ keepText = true } = {}) {
    clearFlush();
    queue.invalidate('text-or-voice-change');
    buffer.reset();
    // `keepText` only preserves the editor text; the buffer starts from zero so the caller decides
    // what to re-submit in the new generation.
    if (!keepText) text = '';
    status = 'idle';
    if (error?.code !== 'no-profile' && error?.code !== 'no-consent') error = null;
    publish();
    return queue.generation;
  }

  function setText(next) {
    const value = String(next ?? '');
    if (value === text) return snapshot();
    const isAppend = value.startsWith(text);
    const shorter = value.length < text.length;
    text = value;
    if (!isAppend || shorter) {
      // Editing earlier text (or clearing) must invalidate audio generated from the old text.
      newGeneration({ keepText: true });
    }
    const completed = buffer.update(text);
    if (config.autoSpeak && config.strategy !== 'manual' && completed.length) {
      queueChunks(completed.flatMap((chunk) => chunkFor(chunk)), { reason: 'typed' });
    } else if (config.strategy === 'manual') {
      status = completed.length || buffer.isPending() ? 'idle' : status;
    }
    scheduleIdleFlush();
    publish();
    return snapshot();
  }

  function playNow() {
    clearFlush();
    if (config.strategy === 'manual') {
      // Manual mode keeps nothing queued while typing, so Play speaks the whole editor content from
      // the top in a fresh generation. Re-queuing under a new generation is what makes the previous
      // generation's late audio impossible to hear.
      const whole = chunkTextList(text);
      if (!whole.length) { publish(); return snapshot(); }
      newGeneration({ keepText: true });
      queueChunks(whole.flatMap((chunk) => chunkFor(chunk)), { reason: 'play-button', final: true });
      publish();
      return snapshot();
    }
    const remainder = buffer.flush();
    if (remainder) queueChunks(chunkFor(remainder), { reason: 'play-button', final: true });
    else void queue.play();
    publish();
    return snapshot();
  }

  /** Full-text chunking for Play in manual mode (same rules as live typing). */
  function chunkTextList(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return [];
    const base = segment(trimmed, { maxChars: config.maxChars, allowIncomplete: true })
      .map((chunk) => chunk.text.trim())
      .filter(Boolean);
    return config.strategy === 'phrase' ? base.flatMap((chunk) => phraseSplit(chunk, 90)) : base;
  }

  function stop() {
    clearFlush();
    queue.stop('user-stop');
    status = 'idle';
    publish();
  }

  function clear() {
    clearFlush();
    text = '';
    buffer.reset();
    queue.invalidate('cleared');
    status = 'idle';
    error = null;
    publish();
  }

  function pause() {
    if (queue.pause()) { status = 'paused'; publish(); return true; }
    return false;
  }

  function resume() {
    if (queue.resume()) { status = 'speaking'; publish(); return true; }
    return false;
  }

  function setProfile(profileId) {
    persistPatch({ selectedProfileId: profileId });
    newGeneration({ keepText: true });
    // Re-speak what is still in the editor, in the new voice, as a fresh generation.
    if (config.autoSpeak && config.strategy !== 'manual' && text.trim()) {
      const chunks = buffer.update(text).filter(Boolean);
      if (chunks.length) queueChunks(chunks.flatMap((chunk) => chunkFor(chunk)), { reason: 'profile-change' });
    }
    publish();
    return snapshot();
  }

  function updateSettings(patch) {
    const previous = config;
    persistPatch(patch);
    if ('selectedProfileId' in patch && patch.selectedProfileId !== previous.selectedProfileId) {
      return setProfile(patch.selectedProfileId);
    }
    if ('strategy' in patch || 'rate' in patch || 'pitch' in patch || 'maxChars' in patch) {
      // Playback parameters changed: stop old audio rather than mixing two configurations.
      newGeneration({ keepText: true });
    }
    if ('autoSpeak' in patch && patch.autoSpeak && config.strategy !== 'manual') {
      scheduleIdleFlush();
    }
    publish();
    return snapshot();
  }

  /** One-shot speech for Copilot replies and previews. Uses the same profile rules. */
  function speakOnce(value, { profileId = null } = {}) {
    const content = String(value ?? '').trim();
    if (!content) return { ok: false, reason: 'Nothing to speak.' };
    queue.invalidate('one-shot');
    const previous = config.selectedProfileId;
    if (profileId) persistPatch({ selectedProfileId: profileId });
    const chunks = segment(content, { maxChars: config.maxChars, allowIncomplete: true })
      .filter((chunk) => chunk.complete || chunk.text.length < config.maxChars)
      .map((chunk) => chunk.text);
    const accepted = queueChunks(chunks.length ? chunks : [content], { reason: 'one-shot' });
    if (!accepted) { persistPatch({ selectedProfileId: previous }); return { ok: false, reason: snapshot().error?.message || 'Speech could not start.' }; }
    return { ok: true, chunks: accepted, generation: queue.generation };
  }

  /** Revoking or deleting a profile while audio is queued must silence it immediately. */
  function onProfilesChanged(nextProfiles) {
    profiles = nextProfiles;
    const active = resolveActiveProfile({ profiles, requestedId: config.selectedProfileId, adapters });
    if (!active.profile) {
      clearFlush();
      queue.invalidate('profile-unavailable');
      status = 'blocked';
      error = { code: 'no-profile', message: active.reason };
    }
    publish();
  }

  function dispose() {
    disposed = true;
    clearFlush();
    queue.stop('dispose');
    try { engine.cancelRequest?.(); } catch { /* nothing to release */ }
  }

  return {
    setText,
    flush,
    playNow,
    stop,
    clear,
    pause,
    resume,
    setProfile,
    updateSettings,
    speakOnce,
    onProfilesChanged,
    dispose,
    snapshot,
    get text() { return text; },
  };
}
