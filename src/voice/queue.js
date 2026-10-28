/* ============ Playback queue with generation-based stale-audio protection ============
 * The rule the specification is strict about: audio belonging to old text must never be heard.
 * A cancellation call alone is not enough, so every item carries the generation it was created
 * in, and the player re-checks the generation *after every await* before continuing.
 *
 * The engine is injected, which keeps this module deterministic and testable without a browser:
 *   engine.speak({ text, voice, rate, pitch, lang, signal, requestId, generation }) → Promise
 *   engine.cancel?({ reason })           → stops whatever the engine is playing
 *   engine.pause?() / engine.resume?()
 */

export const QUEUE_STATUS = { idle: 'idle', speaking: 'speaking', paused: 'paused', error: 'error' };

export function createSpeechQueue({ engine, maxQueued = 32, now = () => Date.now(), onEvent = () => {} } = {}) {
  if (!engine || typeof engine.speak !== 'function') throw new Error('createSpeechQueue requires an engine with speak()');

  let generation = 1;
  let items = [];
  let status = QUEUE_STATUS.idle;
  let draining = false;
  let controller = null;
  let lastError = null;
  let played = 0;
  let sequence = 0;

  const emit = (type, detail = {}) => onEvent({ type, status, generation, queued: items.length, ...detail });

  const setStatus = (next) => {
    if (status === next) return;
    status = next;
    emit('status');
  };

  function abortCurrent() {
    if (controller && !controller.signal.aborted) controller.abort();
    try { (engine.cancelRequest || engine.cancel)?.({ reason: 'queue-abort' }); } catch { /* engine already gone */ }
    controller = null;
  }

  /** Invalidate everything in flight and start a fresh generation. Returns the new id. */
  function invalidate(reason = 'invalidate') {
    generation += 1;
    items = [];
    abortCurrent();
    setStatus(QUEUE_STATUS.idle);
    lastError = null;
    emit('invalidate', { reason });
    return generation;
  }

  function enqueue(chunks, { profile = null, rate = 1, pitch = 1, lang = '', meta = {} } = {}) {
    const list = (Array.isArray(chunks) ? chunks : [chunks]).filter((text) => String(text ?? '').trim());
    const accepted = [];
    for (const text of list) {
      if (items.length >= maxQueued) {
        lastError = { code: 'queue-overflow', message: `Playback queue is full (${maxQueued}); “${String(text).slice(0, 40)}…” was not queued.` };
        emit('overflow', { error: lastError });
        break;
      }
      const item = {
        id: `sp-${++sequence}`,
        generation,
        text: String(text).trim(),
        profile,
        rate,
        pitch,
        lang,
        meta,
        at: now(),
      };
      items.push(item);
      accepted.push(item);
    }
    if (accepted.length) emit('enqueue', { count: accepted.length });
    return accepted;
  }

  /** Start (or continue) the sequential player. Safe to call repeatedly. */
  async function play() {
    if (draining) return;
    draining = true;
    try {
      while (items.length) {
        const item = items[0];
        if (item.generation !== generation) { items.shift(); continue; }
        items.shift();
        controller = new AbortController();
        const signal = controller.signal;
        setStatus(QUEUE_STATUS.speaking);
        emit('chunk-start', { item });
        try {
          await engine.speak({
            text: item.text,
            voice: item.profile,
            rate: item.rate,
            pitch: item.pitch,
            lang: item.lang,
            signal,
            requestId: item.id,
            generation: item.generation,
            meta: item.meta,
          });
          // Late completion from a cancelled/replaced generation must not count or continue.
          if (item.generation !== generation) continue;
          played += 1;
          emit('chunk-end', { item });
        } catch (error) {
          if (item.generation !== generation) continue; // cancelled: silence, not an error
          if (error?.name === 'AbortError') continue;
          lastError = { code: error?.code || 'engine-error', message: error?.message || String(error) };
          setStatus(QUEUE_STATUS.error);
          emit('error', { error: lastError, item });
          // A hard engine failure invalidates the rest of this generation: continuing would hammer a
          // broken engine and speak only fragments of the text.
          items = [];
          break;
        }
      }
    } finally {
      draining = false;
      if (status !== QUEUE_STATUS.error) setStatus(QUEUE_STATUS.idle);
      emit('idle');
    }
  }

  /** Stop playback and discard everything queued. */
  function stop(reason = 'stop') {
    generation += 1;
    items = [];
    abortCurrent();
    setStatus(QUEUE_STATUS.idle);
    emit('stop', { reason });
  }

  function pause() {
    if (status !== QUEUE_STATUS.speaking) return false;
    try { engine.pause?.(); } catch { /* unsupported */ }
    setStatus(QUEUE_STATUS.paused);
    return true;
  }

  function resume() {
    if (status !== QUEUE_STATUS.paused) return false;
    try { engine.resume?.(); } catch { /* unsupported */ }
    setStatus(QUEUE_STATUS.speaking);
    void play();
    return true;
  }

  const snapshot = () => ({
    generation,
    status,
    queued: items.map((item) => ({ id: item.id, text: item.text, generation: item.generation })),
    played,
    lastError,
  });

  return { enqueue, play, stop, pause, resume, invalidate, snapshot, get generation() { return generation; } };
}
