/* ============ Microphone capture, with the caveats visible ============
 * A recorded clip is the only honest way to reach a *local* speech host from a browser: the network
 * recogniser streams audio to a vendor service and cannot be pointed anywhere else. So this module does
 * one thing — turn a press into a Blob, or into a reason why it could not — and refuses to pretend.
 *
 * Three rules:
 *   • the microphone is always released, on stop, on cancel, on error and on the duration cap;
 *   • every failure has a name (`permission-denied`, `no-microphone`, `insecure-context`, …) so the panel
 *     can say what happened instead of "voice failed";
 *   • nothing is uploaded from here. This module returns bytes; where they go is the caller's decision and
 *     the caller's responsibility to state.
 */

/** Reasonable, documented container order: Opus in WebM first (Chrome/Firefox), then Ogg, then MP4 (Safari). */
export const MIME_CANDIDATES = Object.freeze([
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
  'audio/wav',
]);

const describe = (error) => {
  const name = error?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return { code: 'permission-denied', message: 'The microphone is blocked. Allow it in the browser’s site settings, then try again.' };
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return { code: 'no-microphone', message: 'No microphone was found on this device.' };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return { code: 'microphone-busy', message: 'The microphone is in use by another app, so it could not be opened.' };
  }
  if (name === 'AbortError') {
    return { code: 'aborted', message: 'The microphone was released before recording started.' };
  }
  return { code: 'capture-failed', message: `The microphone could not be opened (${name || error?.message || 'unknown error'}).` };
};

/**
 * What this environment can do. Called before anything is offered, so the panel never shows a mic that
 * cannot work: a secure context is required by every browser for getUserMedia, and MediaRecorder is a
 * separate feature that can be missing on its own.
 */
export function captureSupport(env = globalThis) {
  const media = env?.navigator?.mediaDevices;
  if (!env?.isSecureContext) {
    return {
      ok: false,
      code: 'insecure-context',
      reason: 'Recording needs a secure origin (https, or localhost). Over plain http the browser will not open a microphone — type instead.',
    };
  }
  if (!media || typeof media.getUserMedia !== 'function') {
    return { ok: false, code: 'no-getusermedia', reason: 'This browser exposes no microphone API, so a clip cannot be recorded — type instead.' };
  }
  if (typeof env.MediaRecorder !== 'function') {
    return { ok: false, code: 'no-mediarecorder', reason: 'This browser can open a microphone but cannot encode a recording (no MediaRecorder) — type instead.' };
  }
  const supported = MIME_CANDIDATES.filter((type) => {
    try { return env.MediaRecorder.isTypeSupported?.(type) !== false; } catch { return false; }
  });
  if (!supported.length) {
    return { ok: false, code: 'no-container', reason: 'This browser cannot encode any audio container a speech host accepts — type instead.' };
  }
  return { ok: true, code: 'ready', reason: 'Ready to record.', mimeTypes: supported };
}

/**
 * Start a recording. Resolves as soon as the microphone is live, so the UI can show "recording" without
 * waiting for the clip; `stop()` finishes it, `cancel()` throws it away.
 *
 * The returned `done` promise resolves `{ blob, mimeType, durationMs, bytes }` on a real recording and
 * rejects with a named code otherwise. The duration cap is enforced here, not by the UI: a forgotten
 * recording must not become an unbounded upload.
 */
export async function startCapture({
  maxMs = 120000,
  env = globalThis,
  onTick = () => {},
  tickMs = 250,
} = {}) {
  const support = captureSupport(env);
  if (!support.ok) {
    const error = new Error(support.reason);
    error.code = support.code;
    throw error;
  }
  let stream;
  try {
    stream = await env.navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (error) {
    const mapped = describe(error);
    const wrapped = new Error(mapped.message);
    wrapped.code = mapped.code;
    throw wrapped;
  }
  const release = () => {
    try { stream.getTracks().forEach((track) => track.stop()); } catch { /* already gone */ }
  };

  const mimeType = support.mimeTypes[0];
  let recorder;
  try {
    recorder = new env.MediaRecorder(stream, { mimeType });
  } catch (error) {
    release();
    const wrapped = new Error(`This browser refused to start recording (${error?.message || 'unknown error'}).`);
    wrapped.code = 'recorder-failed';
    throw wrapped;
  }

  const chunks = [];
  const startedAt = Date.now();
  let settled = false;
  let cancelled = false;
  let timedOut = false;
  let capTimer = null;
  let tickTimer = null;

  const finished = new Promise((resolve, reject) => {
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(capTimer);
      clearInterval(tickTimer);
      release();
      fn(value);
    };

    recorder.ondataavailable = (event) => {
      if (event?.data && event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = (event) => {
      const error = new Error(`Recording failed: ${event?.error?.name || 'unknown error'}.`);
      error.code = 'recording-failed';
      settle(reject, error);
    };
    recorder.onstop = () => {
      const durationMs = Date.now() - startedAt;
      if (cancelled) {
        const error = new Error('Recording cancelled.');
        error.code = 'cancelled';
        settle(reject, error);
        return;
      }
      const blob = new env.Blob(chunks, { type: mimeType });
      if (!blob.size) {
        const error = new Error('The recording was empty — no audio reached the browser.');
        error.code = 'empty-recording';
        settle(reject, error);
        return;
      }
      settle(resolve, { blob, mimeType, durationMs, bytes: blob.size, timedOut });
    };

    tickTimer = setInterval(() => {
      onTick(Math.min(maxMs, Date.now() - startedAt));
    }, tickMs);
    capTimer = setTimeout(() => {
      timedOut = true;
      try { recorder.stop(); } catch { /* already stopping */ }
    }, maxMs);

    try {
      recorder.start(200);
    } catch (error) {
      const wrapped = new Error(`This browser refused to start recording (${error?.message || 'unknown error'}).`);
      wrapped.code = 'recorder-failed';
      settle(reject, wrapped);
    }
  });

  return {
    mimeType,
    startedAt,
    /** Finish the clip and hand it back. */
    stop() {
      try { recorder.state !== 'inactive' && recorder.stop(); } catch { /* already stopped */ }
      return finished;
    },
    /** Throw the clip away and release the microphone without uploading anything. */
    cancel() {
      cancelled = true;
      try { recorder.state !== 'inactive' && recorder.stop(); } catch { /* already stopped */ }
      release();
      clearTimeout(capTimer);
      clearInterval(tickTimer);
      return finished.catch(() => null);
    },
    done: finished,
    /** Exposed for tests and for the UI's elapsed counter. */
    elapsed: () => Date.now() - startedAt,
  };
}
