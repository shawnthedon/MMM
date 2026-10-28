/* ============ Sound ============
 * Synthesised interface sound (no audio files to download, no network, nothing to cache).
 * Rules:
 *   - off by default until a user gesture unlocks audio; never blocks a click,
 *   - honours `settings.soundHaptics` (Settings → Motion & sound),
 *   - short, quiet, and disabled by `prefers-reduced-motion` only when the user asks for that,
 *   - every call is guarded: a browser without WebAudio simply stays silent.
 */
import { getState } from './core.js';

const VOLUME = 0.055; // deliberately quiet: interface feedback, not a soundtrack
let ctx = null;
let master = null;
let unlocked = false;

export function soundEnabled() {
  try {
    return getState()?.settings?.soundHaptics !== false;
  } catch {
    return false;
  }
}

function context() {
  if (ctx) return ctx;
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = VOLUME;
    master.connect(ctx.destination);
    return ctx;
  } catch {
    ctx = null;
    return null;
  }
}

/** Browsers start an AudioContext suspended; the first real gesture resumes it. */
export function unlockAudio() {
  const c = context();
  if (!c) return false;
  if (c.state === 'suspended') c.resume?.().catch(() => {});
  unlocked = true;
  return true;
}

export const isAudioUnlocked = () => unlocked;

function tone({ freq = 440, to = null, type = 'sine', dur = 0.12, gain = 1, delay = 0, sweep = 'exp' } = {}) {
  if (!soundEnabled()) return false;
  const c = context();
  if (!c) return false;
  try {
    const start = c.currentTime + delay;
    const osc = c.createOscillator();
    const env = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (to && to !== freq) {
      if (sweep === 'exp') osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), start + dur);
      else osc.frequency.linearRampToValueAtTime(Math.max(1, to), start + dur);
    }
    // Fast attack, exponential decay: reads as a "tick"/"pop" rather than a note.
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), start + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(env);
    env.connect(master);
    osc.start(start);
    osc.stop(start + dur + 0.02);
    return true;
  } catch {
    return false;
  }
}

function noise({ dur = 0.16, gain = 0.5, band = 1200, delay = 0 } = {}) {
  if (!soundEnabled()) return false;
  const c = context();
  if (!c) return false;
  try {
    const length = Math.max(1, Math.floor(c.sampleRate * dur));
    const buffer = c.createBuffer(1, length, c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      // Shaped noise: decaying hiss, filtered below to a soft "swoosh".
      data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2;
    }
    const src = c.createBufferSource();
    src.buffer = buffer;
    const filter = c.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(band, c.currentTime + delay);
    const env = c.createGain();
    env.gain.value = gain;
    src.connect(filter);
    filter.connect(env);
    env.connect(master);
    src.start(c.currentTime + delay);
    return true;
  } catch {
    return false;
  }
}

export const sfx = {
  /** Every button press. Two clicks: a soft body and a bright tip. */
  tap() {
    tone({ freq: 620, to: 520, type: 'triangle', dur: 0.055, gain: 0.5 });
    return tone({ freq: 1240, type: 'sine', dur: 0.035, gain: 0.18, delay: 0.006 });
  },
  /** Popups, sheets and drawers opening. */
  open() {
    tone({ freq: 320, to: 640, type: 'sine', dur: 0.18, gain: 0.5 });
    return tone({ freq: 960, type: 'triangle', dur: 0.09, gain: 0.14, delay: 0.05 });
  },
  /** Closing, dismissing, going back. */
  close() {
    tone({ freq: 560, to: 300, type: 'sine', dur: 0.15, gain: 0.4 });
    return tone({ freq: 280, type: 'triangle', dur: 0.08, gain: 0.12, delay: 0.04 });
  },
  /** Toast / notification ping. */
  toast() { return tone({ freq: 880, to: 1180, type: 'sine', dur: 0.11, gain: 0.32 }); },
  ok() {
    tone({ freq: 660, type: 'sine', dur: 0.1, gain: 0.35 });
    return tone({ freq: 990, type: 'sine', dur: 0.14, gain: 0.3, delay: 0.07 });
  },
  warn() { return tone({ freq: 420, to: 360, type: 'square', dur: 0.12, gain: 0.22 }); },
  bad() {
    tone({ freq: 300, to: 180, type: 'sawtooth', dur: 0.18, gain: 0.2 });
    return tone({ freq: 150, type: 'square', dur: 0.14, gain: 0.12, delay: 0.06 });
  },
  /** Swipe gesture commit (run/stop). */
  swipe() { return noise({ dur: 0.18, gain: 0.35, band: 900 }); },
  /** Held swipe armed for a destructive action. */
  arm() {
    tone({ freq: 180, to: 120, type: 'square', dur: 0.14, gain: 0.3 });
    return tone({ freq: 90, type: 'sine', dur: 0.2, gain: 0.24, delay: 0.03 });
  },
  /** Copilot summon: a rising shimmer. */
  summon() {
    tone({ freq: 240, to: 720, type: 'sine', dur: 0.34, gain: 0.4 });
    tone({ freq: 480, to: 1440, type: 'triangle', dur: 0.28, gain: 0.15, delay: 0.06 });
    return noise({ dur: 0.3, gain: 0.18, band: 2600 });
  },
  /** Microphone listening start/stop. */
  listen(on = true) {
    return on
      ? tone({ freq: 700, to: 1100, type: 'sine', dur: 0.14, gain: 0.3 })
      : tone({ freq: 900, to: 620, type: 'sine', dur: 0.12, gain: 0.26 });
  },
};

/**
 * Global wiring: unlock on the first gesture, click for interactive controls.
 * Bubbles are handled here rather than in each screen, so new components get sound for free.
 */
export function initSound(root = typeof document !== 'undefined' ? document : null) {
  if (!root) return;
  const unlock = () => unlockAudio();
  root.addEventListener('pointerdown', unlock, { once: true, passive: true });
  root.addEventListener('keydown', unlock, { once: true });
  root.addEventListener('click', (event) => {
    const target = event.target?.closest?.(
      'button, [data-act], [data-cp], .switch, .chip, label.vs-auto, input[type="checkbox"], input[type="radio"]'
    );
    if (!target) return;
    if (target.matches?.('input[type="checkbox"], input[type="radio"]')) { sfx.tap(); return; }
    if (target.disabled) return;
    sfx.tap();
  }, { passive: true });
}
