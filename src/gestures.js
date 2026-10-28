/* ============ Swipe cards ============
 * Agent cards answer to gestures:
 *   swipe left            → run the agent
 *   swipe right           → stop the agent
 *   swipe left and hold   → arm delete, then ask for confirmation
 *
 * The gesture layer is additive: the card is still a plain button that opens the agent, and the
 * same three actions exist as buttons on the agent's own screen, so nothing is gesture-only.
 * Decisions live in `resolveSwipe()` — pure, so they are unit-tested without a pointer device.
 */

export const SWIPE = {
  /** Horizontal travel that commits a swipe. */
  commit: 72,
  /** Left travel needed before a hold can arm the destructive action. */
  armDistance: 96,
  /** How long the finger must stay put in the armed zone. */
  armHoldMs: 620,
  /** Movement below this is a tap, not a drag. */
  slop: 8,
  /** Maximum visual travel of the card. */
  maxTravel: 132,
};

/**
 * Decide what a gesture means.
 * @param {{dx:number, dy:number, heldMs:number, released:boolean}} input
 * @returns {{kind:'none'|'pending'|'run'|'stop'|'arm'|'cancel', progress:number, travel:number}}
 */
export function resolveSwipe({ dx = 0, dy = 0, heldMs = 0, released = false, armedMs = 0 } = {}) {
  const travel = Math.max(-SWIPE.maxTravel, Math.min(SWIPE.maxTravel, dx));
  const horizontal = Math.abs(dx) > SWIPE.slop && Math.abs(dx) > Math.abs(dy);
  if (!horizontal) return { kind: 'none', progress: 0, travel: 0 };
  // Left and held: destructive intent, which always needs a confirmation dialog.
  if (dx <= -SWIPE.armDistance && heldMs >= SWIPE.armHoldMs) return { kind: 'arm', progress: 1, travel };
  if (!released) {
    return { kind: 'pending', progress: Math.min(1, Math.abs(dx) / SWIPE.commit), travel };
  }
  if (dx <= -SWIPE.commit) return { kind: 'run', progress: 1, travel };
  if (dx >= SWIPE.commit) return { kind: 'stop', progress: 1, travel };
  return { kind: 'cancel', progress: 0, travel };
}

const seen = new WeakSet();

/** Attach drag behaviour to every `[data-swipe-card]` inside `root` that is not already wired. */
export function enhanceSwipeCards(root = typeof document !== 'undefined' ? document : null) {
  if (!root?.querySelectorAll) return 0;
  let count = 0;
  root.querySelectorAll('[data-swipe-card]').forEach((card) => {
    if (seen.has(card)) return;
    seen.add(card);
    wire(card);
    count += 1;
  });
  return count;
}

function wire(card) {
  const surface = card.querySelector('.swipe-surface') || card;
  const underLeft = card.querySelector('[data-side="left"]');
  const underRight = card.querySelector('[data-side="right"]');
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let dy = 0;
  let dragging = false;
  let holdTimer = null;
  let armed = false;
  let pointerId = null;

  const paint = (value) => {
    surface.style.transform = value === 0 ? '' : `translateX(${value}px)`;
    surface.style.transition = dragging ? 'none' : 'transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1)';
    const left = value < 0;
    if (underLeft) underLeft.style.opacity = left ? String(Math.min(1, Math.abs(value) / SWIPE.commit)) : '0';
    if (underRight) underRight.style.opacity = !left && value > 0 ? String(Math.min(1, value / SWIPE.commit)) : '0';
    card.dataset.swipeState = armed ? 'armed' : left ? 'left' : value > 0 ? 'right' : 'idle';
  };

  const reset = () => {
    dragging = false;
    armed = false;
    dx = 0;
    dy = 0;
    clearTimeout(holdTimer);
    holdTimer = null;
    paint(0);
    card.dataset.swipeState = 'idle';
  };

  const commit = (action) => {
    card.dispatchEvent(new CustomEvent('swipe-command', {
      bubbles: true,
      detail: { action, id: card.dataset.swipeId, name: card.dataset.swipeName || '' },
    }));
  };

  const onDown = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    if (event.target.closest('[data-no-swipe]')) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    dx = 0;
    dy = 0;
    dragging = true;
    armed = false;
    paint(0);
    try { card.setPointerCapture?.(pointerId); } catch { /* older pointer implementations */ }
  };

  const scheduleArm = () => {
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      if (!dragging) return;
      const verdict = resolveSwipe({ dx, dy, heldMs: SWIPE.armHoldMs, released: false });
      if (verdict.kind === 'arm') {
        armed = true;
        paint(verdict.travel);
        card.dispatchEvent(new CustomEvent('swipe-armed', { bubbles: true, detail: { id: card.dataset.swipeId } }));
        if (typeof navigator !== 'undefined' && navigator.vibrate) { try { navigator.vibrate(18); } catch { /* unsupported */ } }
      }
    }, SWIPE.armHoldMs);
  };

  const onMove = (event) => {
    if (!dragging) return;
    dx = event.clientX - startX;
    dy = event.clientY - startY;
    if (Math.abs(dx) > SWIPE.slop && Math.abs(dx) > Math.abs(dy)) {
      // Take over the gesture: stop the page from scrolling under the card.
      if (event.cancelable) event.preventDefault();
      window.__suppressClick = true;
      const verdict = resolveSwipe({ dx, dy, heldMs: 0, released: false });
      paint(verdict.travel);
      if (dx <= -SWIPE.armDistance) scheduleArm();
      else { clearTimeout(holdTimer); holdTimer = null; }
    }
  };

  const finish = (event, cancelled = false) => {
    if (!dragging) return;
    clearTimeout(holdTimer);
    holdTimer = null;
    const moved = Math.abs(dx) > SWIPE.slop;
    const verdict = armed
      ? { kind: 'arm' }
      : resolveSwipe({ dx, dy, heldMs: 0, released: true });
    dragging = false;
    try { card.releasePointerCapture?.(pointerId); } catch { /* ignore */ }
    pointerId = null;
    if (!cancelled && verdict.kind === 'run') { commit('run'); }
    else if (!cancelled && verdict.kind === 'stop') { commit('stop'); }
    else if (!cancelled && verdict.kind === 'arm') { commit('arm'); }
    if (moved) {
      // A completed swipe must not also open the agent when the pointer is released.
      window.__suppressClick = true;
      setTimeout(() => { window.__suppressClick = false; }, 60);
    }
    reset();
    void event;
  };

  card.addEventListener('pointerdown', onDown);
  card.addEventListener('pointermove', onMove);
  card.addEventListener('pointerup', (event) => finish(event));
  card.addEventListener('pointercancel', (event) => finish(event, true));
  card.addEventListener('pointerleave', () => { if (!dragging) return; /* keep capture-driven drags alive */ });
  card.addEventListener('contextmenu', (event) => { if (dragging) event.preventDefault(); });
  // Keyboard parity: the same commands are reachable without a pointer.
  card.addEventListener('keydown', (event) => {
    if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); commit('run'); }
    if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); commit('stop'); }
    if (event.altKey && (event.key === 'Backspace' || event.key === 'Delete')) { event.preventDefault(); commit('arm'); }
  });
}

export const swipeInternals = { SWIPE, resolveSwipe };
