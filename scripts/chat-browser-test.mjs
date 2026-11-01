/* Chat in a real Chromium — the screen, the composer, and the absence of a reply.
 * Run: npm run test:chat:browser
 * Optional deps: npm install --no-save @sparticuz/chromium puppeteer-core
 *
 * happy-dom can prove the markup; only a browser can prove the banner is on screen, the composer
 * really submits through the app's own event path, and that nothing appears afterwards — the exact
 * claim the old `simulateReply` used to break after 0.9–1.8 seconds.
 */
import assert from 'node:assert/strict';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';

const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const results = [];
let browser;

try {
  browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    executablePath: process.env.MMM_CHROMIUM_PATH || await chromium.executablePath(),
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;

  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(`${base}/#/chat`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#view .chat-runtime');

  /* ---------- 1. the notice is on screen and says the truth ---------- */
  const banner = await page.evaluate(() => {
    const el = document.querySelector('#view [data-chat-runtime]');
    const rect = el.getBoundingClientRect();
    return {
      source: el.getAttribute('data-chat-runtime'),
      replies: el.getAttribute('data-replies'),
      text: el.textContent.replace(/\s+/g, ' ').trim(),
      visible: rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight,
      role: el.getAttribute('role'),
    };
  });
  assert.equal(banner.source, 'demo', 'no gateway is configured in this run, and the screen says so');
  assert.equal(banner.replies, 'no', 'the screen states that no replies are generated');
  assert.equal(banner.role, 'note', 'the notice is a note for assistive technology');
  assert.ok(banner.visible, 'the notice must be visible without scrolling');
  assert.ok(/no model runtime/i.test(banner.text), `the notice names the gap (got “${banner.text}”)`);
  results.push('PASS the runtime notice is visible and states that no reply is generated');

  /* ---------- 2. sending works through the real composer ---------- */
  const before = await page.evaluate(() => document.querySelectorAll('#chat-msgs .msg').length);
  await page.click('#chat-input');
  await page.type('#chat-input', 'Summarise the vendor crawl');
  await page.evaluate(() => {
    const input = document.getElementById('chat-input');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 400));
  const sent = await page.evaluate(() => {
    const msgs = [...document.querySelectorAll('#chat-msgs .msg')];
    const last = msgs.at(-1);
    return {
      count: msgs.length,
      text: last?.textContent.replace(/\s+/g, ' ').trim() || '',
      mine: last?.classList.contains('me') || false,
      input: document.getElementById('chat-input').value,
      status: document.getElementById('chat-send-status')?.textContent.trim() || '',
    };
  });
  assert.equal(sent.count, before + 1, 'exactly one message was added');
  assert.ok(sent.text.includes('Summarise the vendor crawl'), `the typed text is on screen (got “${sent.text}”)`);
  assert.ok(sent.mine, 'it is rendered as the reader’s own message');
  assert.equal(sent.input, '', 'the composer was cleared');
  assert.ok(/no reply is generated/i.test(sent.status), `the status line repeats the fact (got “${sent.status}”)`);
  results.push('PASS a message sent from the real composer is stored and shown once');

  /* ---------- 3. and nothing answers it ---------- */
  await new Promise((r) => setTimeout(r, 3200)); // longer than any fake delay the app ever used
  const settled = await page.evaluate(() => {
    const msgs = [...document.querySelectorAll('#chat-msgs .msg')];
    return { count: msgs.length, last: msgs.at(-1)?.textContent.replace(/\s+/g, ' ').trim() || '' };
  });
  assert.equal(settled.count, before + 1, 'no reply arrived — nothing is generated');
  assert.ok(settled.last.includes('Summarise the vendor crawl'), 'the last message is still the reader’s');
  results.push('PASS waiting longer than the old fake delay produces no reply');

  /* ---------- 4. 320px: nothing overflows ---------- */
  await page.setViewport({ width: 320, height: 640, isMobile: true, hasTouch: true });
  await new Promise((r) => setTimeout(r, 250));
  const narrow = await page.evaluate(() => ({
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    bannerOverflow: (() => {
      const el = document.querySelector('#view .chat-runtime');
      return el.scrollWidth - el.clientWidth;
    })(),
    sendTarget: Math.round(document.querySelector('.send-btn').getBoundingClientRect().height),
  }));
  assert.ok(narrow.overflowX <= 0, `320px must not scroll sideways (${narrow.overflowX}px)`);
  assert.ok(narrow.bannerOverflow <= 1, `the notice must not clip its text (${narrow.bannerOverflow}px)`);
  assert.ok(narrow.sendTarget >= 44, `the send control needs a 44px target, got ${narrow.sendTarget}`);
  results.push('PASS 320px: no sideways scroll, the notice wraps, the send control is a 44px target');

  /* ---------- 5. the app never posts a second message on its own ---------- */
  const posts = [];
  page.on('request', (req) => { if (req.method() === 'POST') posts.push(req.url()); });
  await new Promise((r) => setTimeout(r, 1200));
  assert.deepEqual(posts, [], `the screen must not fire a request of its own after a send (saw ${posts.join(', ')})`);
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  results.push('PASS no background writes and no runtime errors');

  console.log(results.join('\n'));
  console.log(`\nCHAT (REAL CHROMIUM): ${results.length} passed`);
} catch (error) {
  console.error(results.join('\n'));
  console.error(`\nFAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
}
