/* Optional real-browser check: npm run test:scroll:browser
 * Requires: npm install --no-save @sparticuz/chromium puppeteer-core
 *
 * Proves, in Chromium, that a reader can reach the bottom of every long page and that the periodic
 * simulation re-render no longer snaps the page back to the top.
 */
import assert from 'node:assert/strict';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { build, preview } from 'vite';

await build({ logLevel: 'silent' });
const server = await preview({ preview: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await puppeteer.launch({
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  executablePath: await chromium.executablePath(),
  headless: true,
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

  for (const route of ['home', 'settings', 'agents', 'analytics', 'comms', 'skills']) {
    await page.goto(`${base}/#/${route}`, { waitUntil: 'networkidle0' });
    const metrics = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, viewport: innerHeight }));
    if (metrics.height <= metrics.viewport + 40) continue; // nothing to scroll on this route

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await wait(200);
    const bottom = await page.evaluate(() => {
      const last = [...document.querySelectorAll('#view > *')].filter((el) => el.getBoundingClientRect().height > 0).at(-1);
      const tabbar = document.querySelector('.tabbar')?.getBoundingClientRect();
      return {
        y: Math.round(scrollY),
        max: Math.round(document.documentElement.scrollHeight - innerHeight),
        lastBottom: last ? Math.round(last.getBoundingClientRect().bottom) : null,
        viewport: innerHeight,
        tabbarTop: tabbar ? Math.round(tabbar.top) : null,
      };
    });
    assert(bottom.y >= bottom.max - 2, `${route}: cannot reach the bottom (${bottom.y}/${bottom.max})`);
    assert(bottom.lastBottom !== null && bottom.lastBottom <= bottom.viewport - 4, `${route}: final content ends below the viewport (${bottom.lastBottom} > ${bottom.viewport})`);
    if (bottom.tabbarTop !== null) assert(bottom.lastBottom <= bottom.tabbarTop + 1, `${route}: final content is hidden behind the tab bar`);

    await wait(6500); // more than one 4.2s simulation tick
    const held = await page.evaluate(() => Math.round(scrollY));
    assert(Math.abs(held - bottom.y) <= 8, `${route}: page snapped from ${bottom.y} to ${held} after a tick`);

    await page.evaluate(() => window.scrollTo(0, Math.round((document.documentElement.scrollHeight - innerHeight) * 0.45)));
    await wait(200);
    const mid = await page.evaluate(() => Math.round(scrollY));
    await wait(6500);
    const midHeld = await page.evaluate(() => Math.round(scrollY));
    assert(Math.abs(midHeld - mid) <= 8, `${route}: mid-page position snapped from ${mid} to ${midHeld}`);
    console.log(`PASS ${route}: bottom reachable, ${bottom.max}px scroll range held across ticks (${mid}px mid-page kept)`);
  }

  // Live data must still re-render while the reader is idle.
  await page.goto(`${base}/#/home`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await wait(200);
  const start = await page.evaluate(() => Math.round(scrollY));
  const mutations = await page.evaluate(async () => {
    let count = 0;
    const observer = new MutationObserver((records) => { count += records.length; });
    observer.observe(document.getElementById('view'), { childList: true, subtree: true });
    await new Promise((resolve) => setTimeout(resolve, 6500));
    observer.disconnect();
    return count;
  });
  assert(mutations > 0, 'the view stopped updating entirely while scrolled down');
  assert(Math.abs((await page.evaluate(() => Math.round(scrollY))) - start) <= 8, 'idle re-render moved the page');
  console.log(`PASS live updates still render while scrolled (${mutations} DOM mutations) without moving the page`);

  // Navigation still starts the new page at the top.
  await page.click('.tabbar [data-to="tasks"]');
  await page.waitForFunction(() => location.hash.includes('tasks'));
  await wait(250);
  assert.equal(await page.evaluate(() => Math.round(scrollY)), 0, 'navigation did not start at the top');

  // The kanban board's horizontal position survives a tick.
  const board = await page.evaluate(() => {
    const el = document.getElementById('kb-viewport');
    el.scrollLeft = 380;
    return Math.round(el.scrollLeft);
  });
  await wait(6500);
  assert(Math.abs((await page.evaluate(() => Math.round(document.getElementById('kb-viewport').scrollLeft))) - board) <= 4, 'kanban horizontal scroll was reset');
  console.log('PASS kanban board keeps its horizontal position across ticks');

  // Smallest supported phone: the same guarantee at 320px.
  await page.setViewport({ width: 320, height: 700, isMobile: true, hasTouch: true });
  for (const route of ['settings', 'comms']) {
    await page.goto(`${base}/#/${route}`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await wait(200);
    const atBottom = await page.evaluate(() => Math.round(scrollY));
    assert(atBottom > 0, `${route}: nothing scrolled at 320px`);
    await wait(6500);
    assert(Math.abs((await page.evaluate(() => Math.round(scrollY))) - atBottom) <= 8, `${route}: 320px page snapped to the top`);
  }
  console.log('PASS 320px phone holds its bottom position across ticks');

  // Desktop layout behaves the same.
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${base}/#/settings`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await wait(200);
  const desktopBottom = await page.evaluate(() => Math.round(scrollY));
  await wait(6500);
  assert(Math.abs((await page.evaluate(() => Math.round(scrollY))) - desktopBottom) <= 8, 'desktop page snapped to the top');
  assert.deepEqual(errors, []);
  console.log('PASS desktop page holds its bottom position; no uncaught page errors');
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
