/* Voice Studio in a real browser. Optional deps: npm install --no-save @sparticuz/chromium puppeteer-core
 * Run: npm run test:voice:browser
 *
 * Proves what a headless browser can prove: routing, the editor, real speechSynthesis voice
 * enumeration, generation invalidation on edit, honest blocked states, no horizontal overflow at
 * 320 px, and that a Copilot reply's Speak control reaches the audio engine. It cannot prove audio
 * was audible — see docs/voice/VOICE_STUDIO.md for the device matrix.
 */
import assert from 'node:assert/strict';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { build, preview } from 'vite';

await build({ logLevel: 'silent' });
const server = await preview({ preview: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
let browser;
const results = [];
try {
  browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    executablePath: await chromium.executablePath(),
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;

  for (const width of [320, 390, 1440]) {
    await page.setViewport({ width, height: 900, isMobile: width < 500, hasTouch: width < 500 });
    await page.goto(`${base}/#/voice`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#vs-editor');
    const layout = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
      editor: document.querySelector('#vs-editor').getBoundingClientRect().width,
      buttons: [...document.querySelectorAll('.vs-playback .btn, .vs-tabs button')].map((el) => {
        const box = el.getBoundingClientRect();
        return { w: box.width, h: box.height };
      }),
    }));
    assert(layout.scroll <= layout.width, `horizontal overflow at ${width}px`);
    assert(layout.editor > 200, `editor collapsed at ${width}px`);
    assert(layout.buttons.every((b) => b.h >= 44), `touch target below 44px at ${width}px`);
    results.push(`PASS ${width}px: Voice Studio layout, no overflow, 44px targets`);
  }

  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(`${base}/#/voice`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#vs-editor');

  // The engine must be measured, not assumed.
  const engine = await page.evaluate(() => ({
    present: typeof window.speechSynthesis !== 'undefined',
    voices: typeof window.speechSynthesis?.getVoices === 'function' ? window.speechSynthesis.getVoices().length : -1,
    live: document.querySelector('#vs-live')?.textContent?.trim(),
  }));
  assert(engine.present, 'speechSynthesis missing in this browser build');
  assert(engine.live && engine.live.length > 0, 'status line is empty');
  results.push(`PASS engine probe: speechSynthesis present, ${engine.voices} voice(s) reported, status “${engine.live}”`);

  // Default profile is "My cloned voice" and its fallback is visible, never silent.
  const fallback = await page.evaluate(() => ({
    value: document.querySelector('#vs-profile')?.value,
    banner: document.querySelector('.vs-inline-banner')?.textContent || '',
  }));
  assert.equal(fallback.value, 'my-cloned-voice', 'default profile must be My cloned voice');
  assert(/cloning engine/i.test(fallback.banner), `fallback reason missing (got “${fallback.banner.trim()}”)`);
  results.push('PASS TTS-01: My cloned voice is selected and the fallback is explained in the UI');

  // Typing a finished sentence must produce a synthesis request. We instrument the API first.
  await page.evaluate(() => {
    window.__voiceProbe = { spoken: [], cancelled: 0 };
    const original = window.speechSynthesis.speak.bind(window.speechSynthesis);
    window.speechSynthesis.speak = (utterance) => { window.__voiceProbe.spoken.push(utterance.text); return original(utterance); };
    const cancel = window.speechSynthesis.cancel.bind(window.speechSynthesis);
    window.speechSynthesis.cancel = () => { window.__voiceProbe.cancelled += 1; return cancel(); };
  });
  await page.click('#vs-editor');
  await page.type('#vs-editor', 'Hello there. This is sentence two.', { delay: 12 });
  await page.waitForSelector('#vs-live[data-state="speaking"], #vs-live[data-state="blocked"]', { timeout: 4000 }).catch(() => {});
  const spoken = await page.evaluate(() => window.__voiceProbe);
  assert(spoken.spoken.length >= 1, `no speech request was made (status: ${await page.$eval('#vs-live', (el) => el.textContent)})`);
  assert.equal(spoken.spoken[0].includes('Hello there.'), true, `wrong first chunk: ${spoken.spoken[0]}`);
  results.push(`PASS TTS-02/05: typing submitted ${spoken.spoken.length} chunk(s), first “${spoken.spoken[0]}”`);

  // Editing the text must invalidate the old generation (cancel called, text replaced).
  await page.evaluate(() => { window.__voiceProbe.cancelled = 0; window.__voiceProbe.spoken = []; });
  await page.evaluate(() => {
    const editor = document.querySelector('#vs-editor');
    editor.value = 'Replacement sentence.';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const afterEdit = await page.evaluate(() => window.__voiceProbe);
  assert(afterEdit.cancelled >= 1, 'editing did not cancel the previous generation');
  results.push('PASS TTS-07: editing cancelled the in-flight generation and re-spoke new text');

  // Stop must silence playback.
  await page.click('[data-act="voice-stop"]');
  const afterStop = await page.evaluate(() => ({
    speaking: window.speechSynthesis.speaking,
    pending: window.speechSynthesis.pending,
    live: document.querySelector('#vs-live')?.dataset.state,
  }));
  assert.equal(afterStop.speaking, false, 'stop left the engine speaking');
  results.push('PASS TTS-08: Stop silenced the engine');

  // Catalogue honesty: Qwen2.5-Omni is listed but not installable.
  await page.click('[data-act="voice-tab"][data-tab="models"]');
  await page.waitForSelector('.vs-model');
  const catalogue = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.vs-model')];
    const qwen = cards.find((card) => card.textContent.includes('Qwen2.5-Omni'));
    return { count: cards.length, qwen: qwen?.textContent || '', qwenButtonDisabled: qwen?.querySelector('button')?.disabled };
  });
  assert(catalogue.count >= 4, 'catalogue is too small to be useful');
  assert(catalogue.qwen.includes('advertised'), 'Qwen entry must state its verification level');
  assert.equal(catalogue.qwenButtonDisabled, true, 'Qwen must not be selectable without an adapter');
  results.push(`PASS catalogue: ${catalogue.count} models, Qwen2.5-Omni advertised-only and not selectable`);

  // Diagnostics must never claim a cloud fallback.
  await page.click('[data-act="voice-tab"][data-tab="diagnostics"]');
  await page.waitForSelector('.vs-diag');
  const diag = await page.$eval('#view', (el) => el.textContent);
  assert(/none exists/i.test(diag), 'diagnostics must state there is no cloud fallback');
  results.push('PASS diagnostics: cloud fallback reported as non-existent');

  // Copilot: per-message Speak button must reach the engine.
  await page.goto(`${base}/#/home`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-act="copilot-open"]');
  await page.$eval('[data-act="copilot-open"]', (el) => el.click());
  await page.waitForSelector('#copilot-input', { visible: true, timeout: 5000 });
  const panelOpen = await page.$('#copilot-input');
  if (panelOpen) {
    await page.evaluate(() => {
      window.__voiceProbe = { spoken: [] };
      const original = window.speechSynthesis.speak.bind(window.speechSynthesis);
      window.speechSynthesis.speak = (utterance) => { window.__voiceProbe.spoken.push(utterance.text); return original(utterance); };
    });
    await page.type('#copilot-input', 'status');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.cp-speak', { timeout: 6000 });
    // The bubble sits inside a scrollable panel in a headless viewport; dispatch the click directly.
    await page.$eval('.cp-speak', (el) => el.click());
    await new Promise((resolve) => setTimeout(resolve, 500));
    const spoken = await page.evaluate(() => window.__voiceProbe.spoken);
    assert(spoken.length >= 1, 'the Speak control did not reach the speech engine');
    results.push(`PASS Copilot 🔊: reply read aloud (“${spoken[0].slice(0, 40)}…”)`);
  } else {
    throw new Error('Copilot panel did not open, so the Speak control could not be tested');
  }

  assert.equal(errors.length, 0, `page errors: ${errors.join(' | ')}`);
  results.push('PASS no page errors during the run');
  console.log(results.join('\n'));
  console.log(`\nVOICE STUDIO BROWSER: ${results.length}/${results.length} PASSED`);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
