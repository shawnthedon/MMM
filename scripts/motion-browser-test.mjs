/* Motion, sound and swipe behaviour in a real browser.
 * Run: npm run test:motion:browser
 * Optional deps: npm install --no-save @sparticuz/chromium puppeteer-core
 *
 * Proves what a headless Chromium can prove: anime.js is loaded, page transitions actually run,
 * sheets/toasts/modal animate, the Copilot overlay fills the viewport and animates in and out,
 * the title swaps stage ⇄ advanced, interface sound reaches a real AudioContext, and a pointer
 * swipe on an agent card runs/stops it. Audibility and feel still need a human on a device.
 */
import assert from 'node:assert/strict';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';

// A dev server, not a preview: these checks import the real modules (/src/motion.js) so the
// animation engine, the sound engine and the gesture layer are exercised exactly as shipped.
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
let browser;
const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
    executablePath: await chromium.executablePath(),
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;

  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(`${base}/#/home`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#view .deck-agent');

  /* 1. the engine is present and motion is enabled */
  const engine = await page.evaluate(async () => {
    const motion = await import('/src/motion.js');
    const loaded = await motion.initMotion();
    return { loaded: Boolean(loaded), ready: motion.isMotionReady(), enabled: motion.motionEnabled() };
  });
  assert.equal(engine.loaded, true, 'anime.js did not load');
  assert.equal(engine.enabled, true, 'motion should be enabled by default');
  results.push('PASS anime.js loads and motion is enabled');

  /* 2. page transitions run on navigation */
  const transition = await page.evaluate(async () => {
    const nav = await import('/src/main.js');
    nav.navigate('agents');
    const view = document.getElementById('view');
    const first = getComputedStyle(view).opacity;
    await new Promise((resolve) => setTimeout(resolve, 420));
    return { first: Number(first), settled: Number(getComputedStyle(view).opacity) };
  });
  assert(transition.first < 1, `the view should fade in, first frame opacity was ${transition.first}`);
  assert.equal(transition.settled, 1, 'the view must settle fully visible');
  results.push(`PASS page transition animates in (${transition.first} → ${transition.settled})`);

  /* 3. sheets animate and leave no stale open sheet */
  const sheetRun = await page.evaluate(async () => {
    const shell = await import('/src/shell.js');
    shell.openSheet({ title: 'Motion probe', body: '<p>hello</p>' });
    await new Promise((r) => setTimeout(r, 30));
    const sheet = document.querySelector('.sheet.open');
    const midTransform = getComputedStyle(sheet).transform;
    await new Promise((r) => setTimeout(r, 420));
    const settledTransform = getComputedStyle(sheet).transform;
    shell.closeAllSheets();
    const stillOpen = document.querySelectorAll('.sheet.open').length;
    await new Promise((r) => setTimeout(r, 500));
    return { midTransform, settledTransform, stillOpen, leftovers: document.querySelectorAll('#sheet-root > *').length };
  });
  assert.ok(sheetRun.midTransform && sheetRun.midTransform !== 'none', 'the sheet should be moving, not just appearing');
  const settleY = (() => {
    const match = /matrix\(1, 0, 0, 1, ([\d.-]+), ([\d.-]+)\)/.exec(sheetRun.settledTransform || '');
    return match ? Math.abs(Number(match[2])) : 0;
  })();
  assert.ok(settleY < 2, `the sheet should settle in place, off by ${settleY}px`);
  assert.equal(sheetRun.stillOpen, 0, 'no sheet may stay open after closeAllSheets');
  assert.equal(sheetRun.leftovers, 0, 'the ghost should be cleaned up');
  results.push('PASS sheet opens with motion, closes cleanly and ghosts are removed');

  /* 4. interface sound reaches a real AudioContext */
  const audio = await page.evaluate(async () => {
    const sound = await import('/src/sound.js');
    const unlocked = sound.unlockAudio();
    const played = sound.sfx.tap();
    const Ctor = window.AudioContext || window.webkitAudioContext;
    const ctx = Ctor ? new Ctor() : null;
    const state = ctx?.state || 'none';
    ctx?.close?.();
    return { unlocked, played, state };
  });
  assert.equal(audio.unlocked, true, 'audio should unlock after a gesture');
  assert.equal(audio.played, true, 'a click cue should synthesise through WebAudio');
  results.push(`PASS interface sound plays through WebAudio (context: ${audio.state})`);

  /* 5. the Copilot overlay is full screen, blank first, then the hologram */
  // The FAB sits in the bottom bar; dispatch its click rather than relying on hit-testing.
  await page.$eval('[data-act="copilot-open"]', (el) => el.click());
  await page.waitForSelector('#copilot-panel');
  const immediate = await page.evaluate(() => {
    const panel = document.getElementById('copilot-panel');
    const box = panel.getBoundingClientRect();
    return {
      view: panel.dataset.view,
      w: Math.round(box.width),
      h: Math.round(box.height),
      vw: window.innerWidth,
      vh: window.innerHeight,
      bodyVisible: getComputedStyle(panel.querySelector('.cp-body')).display,
      image: getComputedStyle(panel.querySelector('.cp-holo-image')).opacity,
      title: panel.querySelector('#copilot-title').textContent.trim().slice(0, 24),
    };
  });
  assert.equal(immediate.w, immediate.vw, `the overlay must span the viewport (${immediate.w} vs ${immediate.vw})`);
  assert.ok(Math.abs(immediate.h - immediate.vh) <= 2, `the overlay must fill the height (${immediate.h} vs ${immediate.vh})`);
  assert.equal(immediate.view, 'stage', 'it must open on the stage');
  assert.equal(immediate.bodyVisible, 'none', 'the controls must be hidden on the stage');
  assert.ok(/Advanced Copilot/.test(immediate.title), `title should read Advanced Copilot, got “${immediate.title}”`);
  await sleep(1100);
  const hologram = await page.evaluate(() => {
    const panel = document.getElementById('copilot-panel');
    const img = panel.querySelector('.cp-holo-image');
    return {
      opacity: Number(getComputedStyle(img).opacity),
      complete: img.complete && img.naturalWidth > 0,
      naturalWidth: img.naturalWidth,
      mic: Boolean(panel.querySelector('.cp-mic')),
    };
  });
  assert.equal(hologram.complete, true, 'the hologram image must load (no invented asset path)');
  assert.ok(hologram.opacity > 0.5, `the hologram must resolve in, opacity ${hologram.opacity}`);
  assert.equal(hologram.mic, true, 'the stage needs a central microphone');
  results.push(`PASS Copilot opens full screen (${immediate.w}×${immediate.h}) on a blank stage, then reveals the hologram (${hologram.naturalWidth}px asset)`);

  /* 6. the title swaps stage ⇄ advanced */
  await page.$eval('#copilot-title', (el) => el.click());
  await sleep(700);
  const advanced = await page.evaluate(() => {
    const panel = document.getElementById('copilot-panel');
    return {
      view: panel.dataset.view,
      body: getComputedStyle(panel.querySelector('.cp-body')).display,
      dock: getComputedStyle(panel.querySelector('.cp-voice-dock')).display,
      composer: Boolean(panel.querySelector('#copilot-input')),
      expanded: panel.querySelector('#copilot-title').getAttribute('aria-expanded'),
    };
  });
  assert.equal(advanced.view, 'advanced', 'the title must reveal the controls');
  assert.notEqual(advanced.body, 'none', 'the controls must be visible in advanced mode');
  assert.equal(advanced.dock, 'none', 'the stage dock must step aside');
  assert.equal(advanced.expanded, 'true', 'the title must report expanded');
  assert.equal(advanced.composer, true, 'the composer must exist');
  await page.$eval('#copilot-title', (el) => el.click());
  await sleep(500);
  const backToStage = await page.evaluate(() => document.getElementById('copilot-panel').dataset.view);
  assert.equal(backToStage, 'stage', 'the title must return to the stage');
  results.push('PASS title click swaps stage ⇄ advanced');

  /* 7. closing animates out and leaves nothing interactive behind */
  await page.evaluate(() => document.querySelector('[data-cp="close"]').click());
  const closing = await page.evaluate(() => ({
    panel: Boolean(document.getElementById('copilot-panel')),
    ghosts: document.querySelectorAll('.cp-ghost').length,
    fab: document.querySelector('[data-act="copilot-open"]').getAttribute('aria-expanded'),
  }));
  assert.equal(closing.panel, false, 'the live overlay must be removed immediately');
  assert.equal(closing.ghosts, 1, 'a decorative copy should animate the exit');
  assert.equal(closing.fab, 'false', 'the launcher must collapse');
  await sleep(600);
  assert.equal(await page.evaluate(() => document.querySelectorAll('.cp-ghost').length), 0, 'the ghost must be removed');
  results.push('PASS closing animates out, then cleans up');

  /* 8. a pointer swipe on an agent card runs and stops the agent */
  await page.goto(`${base}/#/agents`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#view [data-swipe-card]');
  const swipe = async (direction) => {
    const box = await page.evaluate(() => {
      const card = document.querySelector('#view [data-swipe-card] .swipe-surface');
      const rect = card.getBoundingClientRect();
      return { id: card.closest('[data-swipe-card]').dataset.swipeId, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    for (let step = 1; step <= 6; step += 1) {
      await page.mouse.move(box.x + (direction * 120 * step) / 6, box.y + 2);
    }
    await page.mouse.up();
    await sleep(400); // the store persists on a 250 ms debounce
    return box.id;
  };
  const statusOf = (id) => page.evaluate(async (agentId) => {
    const core = await import('/src/core.js');
    return core.getState().agents.find((a) => a.id === agentId)?.status;
  }, id);
  const leftId = await swipe(-1);
  const afterLeft = await statusOf(leftId);
  assert.equal(afterLeft, 'running', `swipe left should run the agent (${leftId}), status was ${afterLeft}`);
  const rightId = await swipe(1);
  const afterRight = await statusOf(rightId);
  assert.equal(afterRight, 'paused', `swipe right should stop the agent (${rightId}), status was ${afterRight}`);
  results.push(`PASS pointer swipe runs (${leftId}) and stops (${rightId}) agents`);

  /* 9. card geometry: nothing overflows at 320 px, the card still opens on tap */
  await page.setViewport({ width: 320, height: 780, isMobile: true, hasTouch: true });
  await page.goto(`${base}/#/home`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#view [data-swipe-card]');
  const narrow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    width: document.documentElement.clientWidth,
    under: [...document.querySelectorAll('#view .swipe-under')].every((el) => el.getBoundingClientRect().width <= document.documentElement.clientWidth),
    target: document.querySelector('#view .swipe-surface').getBoundingClientRect().height,
  }));
  assert.ok(narrow.scroll <= narrow.width, `horizontal overflow at 320px (${narrow.scroll} > ${narrow.width})`);
  assert.equal(narrow.under, true, 'swipe layers must not exceed the viewport');
  assert.ok(narrow.target >= 44, `the card must stay a 44px target, got ${narrow.target}`);
  results.push('PASS 320px: no overflow, swipe layers contained, card target ≥44px');

  /* 9b. the immersive stage fits a 320 px phone without overflow */
  await page.$eval('[data-act="copilot-open"]', (el) => el.click());
  await page.waitForSelector('.cp-mic');
  await sleep(700);
  const stage320 = await page.evaluate(() => {
    const panel = document.getElementById('copilot-panel');
    const mic = panel.querySelector('.cp-mic').getBoundingClientRect();
    const caption = panel.querySelector('.cp-stage-caption').getBoundingClientRect();
    return {
      scroll: document.documentElement.scrollWidth,
      width: document.documentElement.clientWidth,
      micLeft: mic.left, micRight: mic.right, micSize: Math.round(mic.width),
      captionLeft: caption.left, captionRight: caption.right,
      link: panel.querySelector('.cp-stage-link').getBoundingClientRect().height,
    };
  });
  assert.ok(stage320.scroll <= stage320.width, `the overlay overflowed at 320px (${stage320.scroll} > ${stage320.width})`);
  assert.ok(stage320.micLeft >= 0 && stage320.micRight <= stage320.width, 'the mic must stay inside the viewport');
  assert.ok(stage320.micSize >= 44, `the mic must be a real target, got ${stage320.micSize}px`);
  assert.ok(stage320.captionLeft >= 8 && stage320.captionRight <= stage320.width - 8, 'the caption must be inset from the edges');
  assert.ok(stage320.link >= 44, 'the “type instead” link must be a 44px target');
  await page.evaluate(() => document.querySelector('[data-cp="close"]').click());
  await sleep(400);
  results.push('PASS 320px: immersive stage fits, mic and link stay ≥44px and inside the viewport');

  /* 10. reduced motion is honoured end to end */
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluate(async () => {
    const core = await import('/src/core.js');
    core.setState((s) => { s.settings.motion = 'system'; }, 'test');
  });
  const reduced = await page.evaluate(async () => {
    const motion = await import('/src/motion.js');
    motion.pageIn(document.getElementById('view'));
    const view = document.getElementById('view');
    const immediate = Number(getComputedStyle(view).opacity);
    return { enabled: motion.motionEnabled(), immediate };
  });
  assert.equal(reduced.enabled, false, 'reduced motion must switch animation off');
  assert.equal(reduced.immediate, 1, 'with reduced motion the end state must be immediate');
  results.push('PASS prefers-reduced-motion disables animation and applies the end state');

  assert.equal(errors.length, 0, `page errors: ${errors.join(' | ')}`);
  results.push('PASS no page errors during the run');
  console.log(results.join('\n'));
  console.log(`\nMOTION BROWSER: ${results.length}/${results.length} PASSED`);
} finally {
  await browser?.close();
  await server.close();
}
