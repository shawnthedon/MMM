/* Optional: npm install --no-save @sparticuz/chromium puppeteer-core */
import assert from 'node:assert/strict';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { build, preview } from 'vite';

await build({ logLevel: 'silent' });
const server = await preview({ preview: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
let browser;
try {
  browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], executablePath: await chromium.executablePath(), headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  for (const width of [320, 390, 1440]) {
    await page.setViewport({ width, height: 900, isMobile: width < 500, hasTouch: width < 500 });
    await page.goto(`${base}/#/home`, { waitUntil: 'networkidle0' });
    const snapshot = await page.evaluate(() => ({
      width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
      heading: document.querySelector('h1')?.textContent,
      sidebar: getComputedStyle(document.querySelector('.sidebar')).display,
      controls: [...document.querySelectorAll('.topbar button')].map((e) => [e.getBoundingClientRect().width, e.getBoundingClientRect().height]),
    }));
    assert(snapshot.scroll <= snapshot.width, `horizontal overflow at ${width}px`);
    assert.match(snapshot.heading, /Command deck/);
    assert.equal(snapshot.sidebar === 'none', width < 1100);
    assert(snapshot.controls.every(([w, h]) => w >= 44 && h >= 44), `header touch target at ${width}px`);
    if (width === 320) {
      await page.click('.tabbar [data-act="more"]');
      await page.waitForSelector('.sheet.open .mod-tile');
      const tiles = await page.evaluate(() => [...document.querySelectorAll('.sheet.open .mod-tile')].map((e) => {
        const { x, y, width, height } = e.getBoundingClientRect(); return { x, y, width, height };
      }));
      assert.equal(new Set(tiles.slice(0, 4).map((tile) => tile.y)).size, 1);
      assert(tiles[4].y > tiles[0].y);
      assert(tiles.every((tile) => Math.abs(tile.width - tiles[0].width) < 1 && tile.height === tiles[0].height));
    }
    console.log(`PASS ${width}px home, navigation and header targets`);
  }
  await page.goto(`${base}/#/settings`, { waitUntil: 'networkidle0' });
  for (const [theme, color] of [['light', '#F3F6FA'], ['oled', '#000000'], ['high-contrast', '#000000'], ['dark', '#0B0F17']]) {
    await page.click(`[data-act="set-theme"][data-v="${theme}"]`);
    await page.waitForFunction((value) => document.documentElement.dataset.theme === value, {}, theme);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim()), color);
  }
  await page.reload({ waitUntil: 'networkidle0' });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await page.$eval('.side-copilot', (el) => el.click());
  await page.waitForSelector('.cp-panel');
  await new Promise((resolve) => setTimeout(resolve, 500)); // let the entrance animation settle
  // The Copilot is an immersive full-screen overlay at every width now, not a floating card.
  const panel = await page.evaluate(() => document.querySelector('.cp-panel').getBoundingClientRect().toJSON());
  assert(Math.abs(panel.width - 1440) < 2 && Math.abs(panel.height - 900) < 2 && panel.left === 0 && panel.top === 0,
    `desktop Copilot overlay should fill the viewport: ${JSON.stringify(panel)}`);
  assert.deepEqual(errors, []);
  console.log('PASS four theme modes, persistence, desktop Copilot and no uncaught page errors');
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
