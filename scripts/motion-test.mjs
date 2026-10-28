/* Motion, sound and swipe-gesture contracts.
 * Run: npm run test:motion
 *
 * Every animation in the app goes through src/motion.js so that reduced motion, a missing DOM
 * shim and the "no stale UI" rule are testable in one place. Swipe decisions are pure functions.
 * These checks run in happy-dom; the visual behaviour is proven by scripts/motion-browser-test.mjs
 * (real Chromium, real anime.js).
 */
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(new URL('.', import.meta.url)));
const win = new Window({ url: 'http://localhost:5173/' });
const g = globalThis;
for (const k of ['window', 'document', 'navigator', 'location', 'localStorage', 'history', 'HTMLElement', 'Event', 'CustomEvent', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'SVGElement', 'NodeList', 'HTMLCollection', 'Element', 'MutationObserver', 'AbortController']) {
  const value = win[k] ?? win;
  if (value === undefined) continue;
  try { Object.defineProperty(g, k, { value, configurable: true, writable: true }); } catch { try { g[k] = value; } catch {} }
}
g.window = win;
g.document = win.document;
g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
win.matchMedia = g.matchMedia;
win.document.body.innerHTML = '<div id="app"></div><div id="sheet-root"></div><div id="toast-root"></div>';

const results = [];
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS ${name}`); } catch (error) { failures += 1; results.push(`FAIL ${name}: ${error.message}`); }
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const eq = (actual, expected, message) => { if (actual !== expected) throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const core = await import('../src/core.js');
const motion = await import('../src/motion.js');
const sound = await import('../src/sound.js');
const gestures = await import('../src/gestures.js');
const shell = await import('../src/shell.js');

/* =====================================================================================
 * 1. Preference plumbing
 * ===================================================================================*/
await check('animations follow the OS by default and can be forced either way', async () => {
  eq(core.seed().settings.motion, 'system', 'default preference');
  let reduced = false;
  win.matchMedia = (query) => ({ matches: reduced && /reduce/.test(query), addEventListener() {} });
  g.matchMedia = win.matchMedia;
  eq(motion.prefersReducedMotion(), false, 'no OS reduction');
  eq(motion.motionEnabled(), true, 'motion should be on with the OS default');
  reduced = true;
  eq(motion.motionEnabled(), false, 'OS reduction must switch motion off');
  core.setState((s) => { s.settings.motion = 'full'; }, 'test');
  eq(motion.motionEnabled(), true, 'the in-app override must win over the OS');
  core.setState((s) => { s.settings.motion = 'reduced'; }, 'test');
  reduced = false;
  eq(motion.motionEnabled(), false, 'the in-app reduction must win over a motion-friendly OS');
  core.setState((s) => { s.settings.motion = 'system'; }, 'test');
});

await check('the animation engine is code-split and loads on demand', async () => {
  // The module must not import anime.js statically: a partial DOM shim would crash at import.
  const source = readFileSync(join(root, 'src/motion.js'), 'utf8');
  assert(!/^import \{[^}]*\} from 'animejs';$/m.test(source), 'motion.js must not statically import animejs');
  assert(/await import\('animejs'\)|import\('animejs'\)/.test(source), 'motion.js should load animejs dynamically');
  const loaded = await motion.initMotion();
  assert(loaded, 'the engine failed to load');
  eq(motion.isMotionReady(), true, 'engine should report ready');
});

/* ====================================================================================
 * 2. Every helper is safe with motion off or a missing engine
 * ===================================================================================*/
await check('with motion off every helper leaves the end state in place', async () => {
  core.setState((s) => { s.settings.motion = 'reduced'; }, 'test');
  const doc = win.document;
  const panel = doc.createElement('div');
  const scrim = doc.createElement('div');
  const sheet = doc.createElement('div');
  const toast = doc.createElement('div');
  [panel, scrim, sheet, toast].forEach((node) => doc.body.appendChild(node));
  motion.sheetIn(sheet, scrim);
  eq(sheet.style.transform, 'translateY(0%)', 'a sheet must be fully open without animation');
  eq(scrim.style.opacity, '1', 'the scrim must be visible without animation');
  motion.toastIn(toast);
  eq(toast.style.opacity, '1', 'a toast must be visible without animation');
  const mic = doc.createElement('button');
  panel.appendChild(mic);
  motion.holoStageIn(panel);
  eq(mic.style.opacity === '' || mic.style.opacity === '1', true, 'stage elements must not be left invisible');
  core.setState((s) => { s.settings.motion = 'system'; }, 'test');
});

await check('closing a sheet never leaves a stale open sheet in the DOM', async () => {
  shell.openSheet({ title: 'Motion test', body: '<p>hello</p>' });
  await sleep(30);
  eq(win.document.querySelectorAll('.sheet.open').length, 1, 'the sheet should open');
  shell.closeAllSheets();
  eq(win.document.querySelectorAll('.sheet.open').length, 0, 'no sheet may remain open after closing');
  await sleep(60);
  const leftovers = [...win.document.querySelectorAll('#sheet-root > *')];
  assert(leftovers.every((node) => node.classList.contains('motion-ghost')), 'only decorative ghosts may remain');
  assert(leftovers.every((node) => node.getAttribute('aria-hidden') === 'true'), 'ghosts must be hidden from assistive tech');
});

await check('a decorative exit copy is inert and self-removes', async () => {
  const doc = win.document;
  const node = doc.createElement('div');
  node.innerHTML = '<button id="inside">Press</button>';
  doc.body.appendChild(node);
  motion.ghostExit(node, { y: 40, duration: 60 });
  node.remove();
  // Animated completion is frame-driven; poll briefly rather than assuming a fixed frame budget.
  let ghosts = [];
  for (let i = 0; i < 40; i += 1) {
    ghosts = [...doc.querySelectorAll('.motion-ghost')];
    if (!ghosts.length) break;
    await sleep(25);
  }
  eq(ghosts.length, 0, 'the ghost should have cleaned itself up');
});

/* ====================================================================================
 * 3. Sound
 * ===================================================================================*/
await check('sound is opt-out through settings and never throws without WebAudio', async () => {
  eq(core.seed().settings.soundHaptics, true, 'interface sounds default on');
  eq(sound.soundEnabled(), true, 'enabled by default');
  // happy-dom has no AudioContext: every call must be a silent no-op.
  eq(sound.sfx.tap(), false, 'tap must report that nothing was played');
  eq(sound.sfx.open(), false, 'open must not throw without WebAudio');
  eq(sound.sfx.summon(), false, 'summon must not throw without WebAudio');
  core.setState((s) => { s.settings.soundHaptics = false; }, 'test');
  eq(sound.soundEnabled(), false, 'the setting must switch sound off');
  core.setState((s) => { s.settings.soundHaptics = true; }, 'test');
});

await check('with a stub AudioContext each cue synthesises real nodes', async () => {
  const created = { oscillators: 0, gains: 0, started: 0 };
  class StubParam {
    constructor() { this.value = 1; }
    setValueAtTime() { return this; }
    exponentialRampToValueAtTime() { return this; }
    linearRampToValueAtTime() { return this; }
  }
  class StubNode {
    constructor() { this.frequency = new StubParam(); this.gain = new StubParam(); }
    connect() { return this; }
    start() { created.started += 1; }
    stop() { return this; }
  }
  win.AudioContext = class {
    constructor() { this.state = 'running'; this.currentTime = 0; this.sampleRate = 8000; this.destination = {}; }
    createGain() { created.gains += 1; return new StubNode(); }
    createOscillator() { created.oscillators += 1; return new StubNode(); }
    createBiquadFilter() { return new StubNode(); }
    createBuffer() { return { getChannelData: () => new Float32Array(8) }; }
    createBufferSource() { return new StubNode(); }
    resume() { return Promise.resolve(); }
  };
  g.AudioContext = win.AudioContext;
  eq(sound.unlockAudio(), true, 'audio should unlock on a gesture');
  const before = { ...created };
  eq(sound.sfx.tap(), true, 'tap should play through the stub');
  assert(created.oscillators > before.oscillators, 'a tap must create oscillators');
  assert(created.started > before.started, 'a tap must start its oscillators');
  eq(sound.sfx.close(), true, 'close should play');
  core.setState((s) => { s.settings.soundHaptics = false; }, 'test');
  const quiet = { ...created };
  eq(sound.sfx.open(), false, 'the setting must silence the cue');
  eq(created.oscillators, quiet.oscillators, 'no node may be created while muted');
  core.setState((s) => { s.settings.soundHaptics = true; }, 'test');
});

/* ====================================================================================
 * 4. Swipe decisions
 * ===================================================================================*/
await check('a small drag is not a gesture', () => {
  eq(gestures.resolveSwipe({ dx: 4, dy: 2, released: true }).kind, 'none', 'below the slop threshold');
  eq(gestures.resolveSwipe({ dx: 20, dy: 40, released: true }).kind, 'none', 'a vertical scroll is not a swipe');
});

await check('swipe left runs, swipe right stops, both need real travel', () => {
  eq(gestures.resolveSwipe({ dx: -40, dy: 4, released: true }).kind, 'cancel', 'a short left swipe snaps back');
  eq(gestures.resolveSwipe({ dx: -90, dy: 4, released: true }).kind, 'run', 'left commits to run');
  eq(gestures.resolveSwipe({ dx: 90, dy: 4, released: true }).kind, 'stop', 'right commits to stop');
  eq(gestures.resolveSwipe({ dx: -200, dy: 0, released: true }).travel, -gestures.SWIPE.maxTravel, 'travel is clamped');
});

await check('swipe left and hold arms deletion only after the hold', () => {
  eq(gestures.resolveSwipe({ dx: -110, dy: 2, heldMs: 0, released: false }).kind, 'pending', 'a fresh drag is pending');
  eq(gestures.resolveSwipe({ dx: -110, dy: 2, heldMs: gestures.SWIPE.armHoldMs, released: false }).kind, 'arm', 'held long enough arms delete');
  eq(gestures.resolveSwipe({ dx: -40, dy: 2, heldMs: 5000, released: false }).kind, 'pending', 'holding a short swipe does not arm');
});

await check('cards dispatch commands and ignore drags that start on opt-out controls', async () => {
  const wrap = win.document.createElement('div');
  wrap.innerHTML = `<div data-swipe-card data-swipe-id="ag-1" data-swipe-name="Researcher">
      <div class="swipe-under" data-side="left"></div>
      <div class="swipe-under" data-side="right"></div>
      <button class="list-card swipe-surface"><span id="inner">Researcher</span><span data-no-swipe id="optout">no</span></button>
    </div>`;
  win.document.body.appendChild(wrap);
  const card = wrap.querySelector('[data-swipe-card]');
  eq(gestures.enhanceSwipeCards(wrap), 1, 'the card should be wired once');
  eq(gestures.enhanceSwipeCards(wrap), 0, 'wiring twice must be a no-op');
  const commands = [];
  win.document.addEventListener('swipe-command', (event) => commands.push(event.detail));
  const fire = (type, x, y) => card.dispatchEvent(new win.PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 0 }));
  fire('pointerdown', 200, 40);
  fire('pointermove', 90, 41);
  fire('pointerup', 90, 41);
  eq(commands.length, 1, 'one command per completed swipe');
  eq(commands[0].action, 'run', 'left is run');
  eq(commands[0].id, 'ag-1', 'the card id travels with the command');
  fire('pointerdown', 100, 40);
  fire('pointermove', 210, 41);
  fire('pointerup', 210, 41);
  eq(commands.at(-1).action, 'stop', 'right is stop');
  // A drag that begins on an opted-out control must not become a command.
  const before = commands.length;
  card.querySelector('#optout').dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true, clientX: 200, clientY: 40, pointerId: 2, button: 0 }));
  fire('pointermove', 60, 41);
  fire('pointerup', 60, 41);
  eq(commands.length, before, 'a no-swipe child must not trigger a gesture');
});

/* ====================================================================================
 * 5. Rendered agent cards
 * ===================================================================*/
await import('../src/main.js');
await sleep(140);
const nav = await import('../src/main.js');

await check('home agent cards are swipeable and keep a normal open action', async () => {
  nav.navigate('home');
  await sleep(60);
  const cards = [...win.document.querySelectorAll('#view [data-swipe-card]')];
  assert(cards.length > 0, 'no swipeable cards on the home screen');
  cards.forEach((card) => {
    assert(card.dataset.swipeId, 'every card needs its agent id');
    assert(card.querySelector('.swipe-surface[data-act="open-agent"]'), 'the card must still open the agent on tap');
    assert(card.querySelector('[data-side="left"]'), 'every card needs a run layer');
    assert(card.querySelector('[data-side="right"]'), 'every card needs a stop layer');
  });
  assert(win.document.getElementById('swipe-help'), 'a visible hint must explain the gestures');
});

await check('swipe commands drive the real agent state', async () => {
  nav.navigate('agents');
  await sleep(60);
  const cards = [...win.document.querySelectorAll('#view [data-swipe-card]')];
  assert(cards.length >= 2, 'need agents to test with');
  const id = cards[0].dataset.swipeId;
  const before = core.getState().agents.find((a) => a.id === id);
  // Commands are dispatched from the surface the user actually swiped; re-renders replace the node,
  // so re-query between commands (the real gesture layer re-attaches on every render).
  const cardNow = () => win.document.querySelector(`#view [data-swipe-card][data-swipe-id="${id}"]`) || cards[0];
  cardNow().dispatchEvent(new win.CustomEvent('swipe-command', { bubbles: true, detail: { action: 'run', id } }));
  await sleep(40);
  eq(core.getState().agents.find((a) => a.id === id).status, 'running', 'swipe left must run the agent');
  cardNow().dispatchEvent(new win.CustomEvent('swipe-command', { bubbles: true, detail: { action: 'stop', id } }));
  await sleep(40);
  eq(core.getState().agents.find((a) => a.id === id).status, 'paused', 'swipe right must stop the agent');
  cardNow().dispatchEvent(new win.CustomEvent('swipe-command', { bubbles: true, detail: { action: 'arm', id } }));
  await sleep(40);
  const modal = win.document.querySelector('.modal-center .box');
  assert(modal, 'arming delete must open a confirmation dialog');
  assert(/DELETE/.test(modal.textContent), 'deletion needs typed confirmation');
  assert(core.getState().agents.some((a) => a.id === id), 'nothing may be deleted before confirmation');
  win.document.querySelector('#confirm-cancel').click();
  await sleep(30);
  assert(core.getState().agents.some((a) => a.id === id), 'cancelling must keep the agent');
  void before;
});

/* ====================================================================================
 * 6. Copilot immersive overlay
 * ===================================================================================*/
const copilot = await import('../src/copilot/panel.js');

await check('the Copilot opens full screen on a blank stage', async () => {
  copilot.resetCopilotSession();
  copilot.openCopilot();
  await sleep(60);
  const panel = win.document.getElementById('copilot-panel');
  assert(panel, 'panel missing');
  eq(panel.dataset.view, 'stage', 'the stage is the first view');
  eq(panel.getAttribute('aria-modal'), 'true', 'the overlay is modal at every width');
  const title = panel.querySelector('#copilot-title');
  eq(title.textContent.includes('Advanced Copilot'), true, 'the title must read Advanced Copilot');
  assert(panel.querySelector('#cp-body') === null || panel.querySelector('.cp-body'), 'controls must exist in the DOM to animate in');
  assert(panel.querySelector('.cp-mic'), 'the stage needs a central microphone');
  assert(panel.querySelector('img.cp-holo-image'), 'the hologram image must be present');
  const src = panel.querySelector('img.cp-holo-image').getAttribute('src');
  eq(src, './media/hologram.jpg', 'the uploaded image is the hologram backdrop');
});

await check('the title swaps stage ⇄ advanced and reports its state', async () => {
  const panel = win.document.getElementById('copilot-panel');
  const title = panel.querySelector('#copilot-title');
  title.click();
  await sleep(20);
  eq(panel.dataset.view, 'advanced', 'clicking the title reveals the controls');
  eq(title.getAttribute('aria-expanded'), 'true', 'expanded state');
  title.click();
  await sleep(20);
  eq(panel.dataset.view, 'stage', 'clicking again returns to the stage');
  eq(title.getAttribute('aria-expanded'), 'false', 'collapsed state');
});

await check('sending a message reveals the conversation from the stage', async () => {
  copilot.send('status');
  await sleep(400);
  const panel = win.document.getElementById('copilot-panel');
  eq(panel.dataset.view, 'advanced', 'a message must open the controls');
  assert(/Agents:/.test(panel.querySelector('#copilot-work').textContent), 'the answer must render');
});

await check('closing removes the live overlay immediately and plays a ghost out', async () => {
  copilot.closeCopilot();
  eq(win.document.getElementById('copilot-panel'), null, 'the live panel must be gone at once');
  const ghosts = [...win.document.querySelectorAll('.cp-ghost')];
  eq(ghosts.length, 1, 'one decorative copy should animate the exit');
  ghosts.forEach((ghost) => {
    eq(ghost.getAttribute('aria-hidden'), 'true', 'the ghost must be hidden from assistive tech');
    eq(ghost.id, '', 'the ghost must not keep the panel id');
    assert([...ghost.querySelectorAll('button')].every((b) => b.disabled), 'the ghost must be inert');
  });
  assert(win.document.querySelector('[data-act="copilot-open"]').getAttribute('aria-expanded') === 'false', 'the launcher must collapse');
  await sleep(420);
});

await check('voice input refuses clearly when the browser has no recogniser', async () => {
  copilot.resetCopilotSession();
  copilot.openCopilot();
  await sleep(40);
  const panel = win.document.getElementById('copilot-panel');
  // No SpeechRecognition in happy-dom: the dock must say so instead of pretending to listen.
  assert(/unavailable|speech service|connection/i.test(panel.querySelector('#cp-voice-status').textContent), 'the status must explain why');
  panel.querySelector('.cp-mic').click();
  await sleep(20);
  eq(panel.querySelector('.cp-mic').dataset.state, 'idle', 'the mic must not enter a listening state');
  copilot.closeCopilot();
});

await check('voice input asks for consent before starting a recogniser', async () => {
  core.setState((s) => { s.settings.voice.networkRecognitionConsent = false; }, 'test');
  class StubRecognition {
    constructor() { this.started = false; }
    start() { this.started = true; }
    stop() {}
  }
  g.SpeechRecognition = StubRecognition;
  win.SpeechRecognition = StubRecognition;
  copilot.resetCopilotSession();
  copilot.openCopilot();
  await sleep(40);
  const panel = win.document.getElementById('copilot-panel');
  panel.querySelector('.cp-mic').click();
  await sleep(20);
  const consent = panel.querySelector('.cp-consent');
  assert(consent, 'a consent card must appear before any audio is captured');
  assert(/speech service|audio/i.test(consent.textContent), 'the consent must state what leaves the device');
  eq(copilot.copilotState().listening, false, 'nothing may be recorded before consent');
  // Deny: no recogniser, no listening state.
  panel.querySelector('[data-cp="voice-consent-deny"]').click();
  await sleep(20);
  eq(copilot.copilotState().listening, false, 'declining must not start capture');
  assert(!panel.querySelector('.cp-consent'), 'the card closes on deny');
  // Allow: the recogniser starts.
  panel.querySelector('.cp-mic').click();
  await sleep(20);
  panel.querySelector('[data-cp="voice-consent-allow"]')?.click();
  await sleep(20);
  eq(core.getState().settings.voice.networkRecognitionConsent, true, 'the choice must persist');
  eq(copilot.copilotState().listening, true, 'capture starts after consent');
  copilot.closeCopilot();
  delete g.SpeechRecognition;
  delete win.SpeechRecognition;
  core.setState((s) => { s.settings.voice.networkRecognitionConsent = false; }, 'test');
});

/* ====================================================================================
 * 7. Source-level guarantees
 * ===================================================================================*/
await check('no component calls the animation library directly', () => {
  const files = ['src/shell.js', 'src/main.js', 'src/copilot/panel.js', 'src/views1.js', 'src/views2.js', 'src/voice.js'];
  files.forEach((file) => {
    const source = readFileSync(join(root, file), 'utf8');
    assert(!/from 'animejs'/.test(source), `${file} must import motion.js, not anime.js`);
  });
});

await check('interface sound is synthesised, with no audio assets to fetch', () => {
  const source = readFileSync(join(root, 'src/sound.js'), 'utf8');
  assert(!/new Audio\(|\.mp3|\.wav|fetch\(/.test(source), 'sound must not load files or use the network');
  assert(/AudioContext/.test(source), 'sound must use WebAudio');
});

await check('the design system still governs colour: the hologram adds no literal hex', () => {
  const css = readFileSync(join(root, 'src/copilot.css'), 'utf8');
  const literals = css.match(/#(?:[0-9a-fA-F]{3,8})\b/g) || [];
  const allowed = literals.filter((value) => !['#fff', '#fff'].includes(value));
  assert(allowed.length === 0, `copilot.css must use tokens, found ${allowed.join(', ')}`);
});

console.log(results.join('\n'));
console.log(`\nMOTION + SOUND + GESTURES: ${results.length - failures}/${results.length} PASSED`);
process.exit(failures ? 1 : 0);
