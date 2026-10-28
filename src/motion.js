/* ============ Motion ============
 * One place for every animation in the app, driven by anime.js (v4). Components ask this module
 * for motion; they never call the animation library directly, so:
 *   - `prefers-reduced-motion` and the in-app setting are honoured in exactly one place,
 *   - a missing DOM/animation environment never breaks a screen (every call is guarded),
 *   - exit animations never keep stale UI alive: the live node is removed and a decorative
 *     duplicate plays the exit, so a dead panel cannot be clicked or read by a screen reader.
 */
import { getState } from './core.js';

/* anime.js is loaded asynchronously so a partial DOM shim (tests, embedded webviews, an old
 * browser) can never break the app at import time. Until it is ready every helper degrades to
 * "apply the end state", which is exactly the reduced-motion behaviour. */
let anime = null;
let loading = null;

function ensureFrameGlobals() {
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
  }
  if (typeof globalThis.cancelAnimationFrame !== 'function') {
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  }
}

/** Load the animation engine once. Safe to call repeatedly. */
export async function initMotion() {
  if (anime) return anime;
  if (loading) return loading;
  ensureFrameGlobals();
  loading = import('animejs')
    .then((mod) => { anime = mod; return mod; })
    .catch(() => null);
  return loading;
}

export const isMotionReady = () => Boolean(anime);
const animate = (...args) => anime.animate(...args);
const createTimeline = (...args) => anime.createTimeline(...args);
const stagger = (...args) => anime.stagger(...args);

const canAnimate = () => typeof document !== 'undefined' && typeof document.createElement === 'function';

/** The OS preference. Tests stub `matchMedia`, so this never throws. */
export function prefersReducedMotion() {
  try {
    return Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  } catch {
    return false;
  }
}

/** `settings.motion`: 'system' (default) follows the OS, 'reduced' forces off, 'full' forces on. */
export function motionEnabled() {
  const choice = getState?.()?.settings?.motion || 'system';
  if (choice === 'reduced') return false;
  if (choice === 'full') return true;
  return !prefersReducedMotion();
}

const DUR = {
  fast: 160,
  base: 240,
  slow: 420,
  cinematic: 760,
};

function safe(fn, fallback = null) {
  if (!anime || !canAnimate() || !motionEnabled()) return fallback;
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Set final styles immediately when motion is off, so reduced-motion users get the end state. */
function settle(el, styles) {
  if (!el?.style) return;
  Object.assign(el.style, styles);
}

/**
 * Remove animation leftovers (inline opacity/transform) so a page or card that was mid-animation
 * when motion was disabled can never stay half-transparent.
 */
export function resetInline(el, props = ['opacity', 'transform']) {
  if (!el?.style) return;
  props.forEach((prop) => { el.style[prop] = ''; });
}

/* ------------------------------------------------------------------ *
 * Page transitions
 * ------------------------------------------------------------------ */
/** Enter animation for a routed view. Runs after `innerHTML` is replaced. */
export function pageIn(el, { direction = 'forward' } = {}) {
  if (!el) return null;
  if (!motionEnabled() || !anime) { resetInline(el); return null; }
  return safe(() => {
    const from = direction === 'back' ? { opacity: 0, translateY: 10 } : { opacity: 0, translateY: 14 };
    return animate(el, {
      opacity: [from.opacity, 1],
      translateY: [from.translateY, 0],
      duration: DUR.base,
      ease: 'outQuad',
    });
  });
}

/** Header/title swap: a small slide so the route change is legible without motion sickness. */
export function titleSwap(el) {
  if (!el) return null;
  if (!motionEnabled() || !anime) { resetInline(el); return null; }
  return safe(() => animate(el, {
    opacity: [0.2, 1],
    translateY: [-6, 0],
    duration: DUR.fast,
    ease: 'outQuad',
  }));
}

/* ------------------------------------------------------------------ *
 * Overlays: sheets, modals, toasts
 * ------------------------------------------------------------------ */
/** Bottom sheet + its scrim. Inline styles are set before the first frame to avoid a flash. */
export function sheetIn(sheet, scrim) {
  if (!sheet) return null;
  if (!motionEnabled() || !anime) {
    settle(scrim, { opacity: '1' });
    settle(sheet, { transform: 'translateY(0%)' });
    return null;
  }
  sheet.style.transform = 'translateY(102%)';
  sheet.style.opacity = '1';
  if (scrim) scrim.style.opacity = '0';
  return safe(() => {
    const tl = createTimeline({ defaults: { ease: 'outQuad' } });
    if (scrim) tl.add(scrim, { opacity: [0, 1], duration: DUR.fast }, 0);
    tl.add(sheet, {
      translateY: ['102%', '0%'],
      duration: DUR.base + 60,
      ease: 'outQuint',
    }, 0);
    return tl;
  });
}

export function modalIn(box, scrim) {
  if (!box) return null;
  if (!motionEnabled() || !anime) {
    settle(scrim, { opacity: '1' });
    settle(box, { opacity: '1', transform: 'scale(1)' });
    return null;
  }
  box.style.opacity = '0';
  box.style.transform = 'scale(0.94) translateY(8px)';
  if (scrim) scrim.style.opacity = '0';
  return safe(() => {
    const tl = createTimeline({ defaults: { ease: 'outQuad' } });
    if (scrim) tl.add(scrim, { opacity: [0, 1], duration: DUR.fast }, 0);
    tl.add(box, { opacity: [0, 1], scale: [0.94, 1], translateY: [8, 0], duration: DUR.base }, 0);
    return tl;
  });
}

export function toastIn(el) {
  if (!el) return null;
  if (!motionEnabled() || !anime) { settle(el, { opacity: '1', transform: 'none' }); return null; }
  el.style.opacity = '0';
  el.style.transform = 'translateY(-12px) scale(0.98)';
  return safe(() => animate(el, {
    opacity: [0, 1],
    translateY: [-12, 0],
    scale: [0.98, 1],
    duration: DUR.base,
    ease: 'outQuad',
  }));
}

export function toastOut(el, done) {
  if (!el) return null;
  if (!motionEnabled() || !anime) { settle(el, { opacity: '0' }); done?.(); return null; }
  return safe(() => animate(el, {
    opacity: [1, 0],
    translateY: [0, -10],
    scale: [1, 0.98],
    duration: DUR.fast,
    ease: 'inQuad',
    onComplete: () => done?.(),
  }), (() => { done?.(); return null; })());
}

/**
 * Play an exit animation on a *copy* of a node that is about to leave the DOM.
 * The original is removed by the caller immediately, so no stale UI stays interactive.
 */
export function ghostExit(el, { y = 28, scale = 1, fadeOnly = false, duration = DUR.base } = {}) {
  if (!el || !motionEnabled() || !anime) return null;
  return safe(() => {
    let ghost;
    try {
      ghost = el.cloneNode(true);
    } catch {
      return null;
    }
    if (!ghost.style) return null;
    ghost.removeAttribute('id');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.classList.add('motion-ghost');
    [...ghost.querySelectorAll('[id]')].forEach((node) => node.removeAttribute('id'));
    [...ghost.querySelectorAll('input, textarea, select, button, a')].forEach((node) => {
      node.setAttribute('tabindex', '-1');
      node.setAttribute('aria-hidden', 'true');
    });
    ghost.style.pointerEvents = 'none';
    // A ghost must never be mistaken for live UI: it loses `open` (so queries and CSS treat it as
    // closed) and is forced back into its visible position before the exit animation starts.
    ghost.classList.remove('open');
    let exitY = y;
    if (ghost.classList.contains('sheet')) {
      ghost.style.transform = 'translateY(0%)';
      exitY = Math.max(220, Math.round(ghost.getBoundingClientRect?.().height || 0) || 320);
    } else if (ghost.classList.contains('modal-center')) {
      const box = ghost.querySelector('.box');
      if (box) { box.style.opacity = '1'; box.style.transform = 'scale(1)'; }
    }
    (el.parentElement || document.body).appendChild(ghost);
    return animate(ghost, {
      opacity: [1, 0],
      translateY: fadeOnly ? [0, 0] : [0, exitY],
      scale: fadeOnly ? [1, 1] : [1, scale],
      duration,
      ease: 'inQuad',
      onComplete: () => ghost.remove(),
    });
  });
}

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */
/** Press feedback: a tiny scale bounce. The ripple is pure CSS, toggled by class. */
export function press(el) {
  if (!el || !motionEnabled() || !anime) return null;
  return safe(() => animate(el, {
    scale: [1, 0.96, 1],
    duration: 220,
    ease: 'outQuad',
  }));
}

export function popIn(el, { delay = 0, duration = DUR.base } = {}) {
  if (!el) return null;
  if (!motionEnabled() || !anime) { settle(el, { opacity: '1', transform: 'none' }); return null; }
  return safe(() => animate(el, {
    opacity: [0, 1],
    scale: [0.94, 1],
    translateY: [8, 0],
    delay,
    duration,
    ease: 'outBack(1.4)',
  }));
}

/** Stagger a list of nodes in (advanced Copilot surfaces, card grids). */
export function staggerIn(nodes, { delay = 24, duration = DUR.base, from = 'first' } = {}) {
  const list = [...(nodes || [])];
  if (!list.length) return null;
  if (!motionEnabled() || !anime) { list.forEach((node) => settle(node, { opacity: '1', transform: 'none' })); return null; }
  return safe(() => animate(list, {
    opacity: [0, 1],
    translateY: [10, 0],
    delay: stagger(delay, { from }),
    duration,
    ease: 'outQuad',
  }));
}

/** Count/figure emphasis used by the deck metrics after data updates. */
export function pulse(el) {
  if (!el) return null;
  if (!motionEnabled() || !anime) return null;
  return safe(() => animate(el, { scale: [1, 1.04, 1], duration: 380, ease: 'inOutQuad' }));
}

/* ------------------------------------------------------------------ *
 * Copilot: immersive stage
 * ------------------------------------------------------------------ */
export function holoStageIn(panel) {
  if (!panel) return null;
  const image = panel.querySelector('[data-holo="image"]');
  const rings = panel.querySelectorAll('[data-holo="ring"]');
  const scan = panel.querySelector('[data-holo="scan"]');
  const mic = panel.querySelector('[data-holo="mic"]');
  const caption = panel.querySelector('[data-holo="caption"]');
  if (!motionEnabled() || !anime) {
    [image, scan, mic, caption, ...rings].forEach((node) => resetInline(node));
    return null;
  }
  if (image) { image.style.opacity = '0'; image.style.transform = 'scale(1.12)'; }
  if (scan) { scan.style.opacity = '0'; }
  if (mic) { mic.style.opacity = '0'; mic.style.transform = 'scale(0.6)'; }
  if (caption) { caption.style.opacity = '0'; }
  rings.forEach((ring) => { ring.style.opacity = '0'; ring.style.transform = 'scale(0.86)'; });
  return safe(() => {
    const tl = createTimeline({ defaults: { ease: 'outQuad' } });
    // 1. the screen is blank, then the hologram resolves out of the dark
    if (image) tl.add(image, { opacity: [0, 0.92], scale: [1.12, 1], duration: DUR.cinematic, ease: 'outQuint' }, 120);
    // 2. concentric rings draw outward
    if (rings.length) tl.add(rings, { opacity: [0, 1], scale: [0.86, 1], delay: stagger(90), duration: DUR.slow }, 260);
    // 3. scan sweep + mic affordance
    if (scan) tl.add(scan, { opacity: [0, 1], duration: DUR.slow }, 420);
    if (mic) tl.add(mic, { opacity: [0, 1], scale: [0.6, 1], duration: 520, ease: 'outBack(1.7)' }, 520);
    if (caption) tl.add(caption, { opacity: [0, 1], duration: DUR.base }, 720);
    return tl;
  });
}

/** Stage ⇄ advanced. `show` reveals the full control surface over the hologram. */
export function copilotModeIn(panel, show) {
  if (!panel) return null;
  const body = panel.querySelector('.cp-body');
  const image = panel.querySelector('[data-holo="image"]');
  const dock = panel.querySelector('.cp-voice-dock');
  if (!body) return null;
  if (!motionEnabled() || !anime) {
    settle(body, { opacity: show ? '1' : '0', transform: 'none' });
    if (dock) dock.style.display = show ? 'none' : '';
    return null;
  }
  const blocks = body.querySelectorAll('.cp-modes, .cp-context, .cp-work, .cp-tray, .cp-composer');
  return safe(() => {
    const tl = createTimeline({ defaults: { ease: 'outQuad' } });
    if (show) {
      if (dock) tl.add(dock, { opacity: [1, 0], translateY: [0, 18], duration: DUR.fast }, 0);
      tl.add(body, { opacity: [0.2, 1], duration: DUR.base }, 60);
      if (blocks.length) tl.add(blocks, { opacity: [0, 1], translateY: [12, 0], delay: stagger(40), duration: DUR.base }, 60);
      if (image) tl.add(image, { opacity: [0.92, 0.32], scale: [1, 1.03], duration: DUR.slow }, 0);
    } else {
      if (body) tl.add(body, { opacity: [1, 0], duration: DUR.fast }, 0);
      if (image) tl.add(image, { opacity: [0.32, 0.92], scale: [1.03, 1], duration: DUR.slow }, 0);
      if (dock) tl.add(dock, { opacity: [0, 1], translateY: [18, 0], duration: DUR.base }, 40);
    }
    return tl;
  });
}

/** Closing the immersive overlay: collapse toward the launcher, then vanish. */
export function copilotOut(layer) {
  if (!layer || !motionEnabled() || !anime) return null;
  const panel = layer.querySelector('.cp-panel');
  const scrim = layer.querySelector('.cp-scrim');
  if (!panel) return null;
  return safe(() => {
    const tl = createTimeline({ defaults: { ease: 'inQuad' } });
    if (scrim) tl.add(scrim, { opacity: [1, 0], duration: DUR.base }, 0);
    tl.add(panel, {
      opacity: [1, 0],
      scale: [1, 0.94],
      translateY: [0, 24],
      duration: DUR.base + 40,
      onComplete: () => layer.remove(),
    }, 0);
    return tl;
  });
}

/** The launcher itself: a spring pulse when the Copilot is summoned. */
export function fabPulse(fab) {
  if (!fab) return null;
  if (!motionEnabled() || !anime) { resetInline(fab); return null; }
  return safe(() => animate(fab, { scale: [1, 1.12, 1], duration: 420, ease: 'outQuad' }));
}

export { DUR };
