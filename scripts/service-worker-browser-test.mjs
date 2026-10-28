/* Optional real Chromium integration test: the proxy represents a same-origin gateway. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { build, preview } from 'vite';

let calls = 0;
const gateway = createServer((req, res) => {
  calls += 1;
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'private, no-store' });
  res.end(JSON.stringify({ principal: req.headers['x-test-identity'] }));
});
await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
await build({ logLevel: 'silent' });
const server = await preview({ preview: { host: '127.0.0.1', port: 0, proxy: { '/api': `http://127.0.0.1:${gateway.address().port}` } }, logLevel: 'silent' });
let browser;
try {
  browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], executablePath: await chromium.executablePath(), headless: true });
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  await page.setViewport({ width: 320, height: 700, isMobile: true, hasTouch: true });
  await page.goto(`${base}/#/home`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: 'networkidle0' });
  assert(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)));
  for (const identity of ['A', 'B']) {
    const value = await page.evaluate(async (who) => (await fetch('/api/v1/agents', { headers: { 'x-test-identity': who } })).json(), identity);
    assert.equal(value.principal, identity);
  }
  assert.equal(calls, 2, 'both principals must reach the gateway');
  const cachedApi = await page.evaluate(async () => {
    const entries = await Promise.all((await caches.keys()).map(async (name) => (await (await caches.open(name)).keys()).map((r) => r.url)));
    return entries.flat().filter((url) => url.includes('/api/'));
  });
  assert.deepEqual(cachedApi, []);
  await page.setOfflineMode(true);
  const offline = await page.evaluate(async () => {
    try { await fetch('/api/v1/agents'); return 'unexpected response'; } catch { return 'network failure'; }
  });
  assert.equal(offline, 'network failure', 'offline must not expose a cached API response');
  await page.setOfflineMode(false);
  for (const route of ['home', 'agents', 'tasks', 'comms']) {
    await page.goto(`${base}/#/${route}`, { waitUntil: 'networkidle0' });
    const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: document.documentElement.clientWidth }));
    assert(overflow.scroll <= overflow.width, `${route} overflows at 320px: ${JSON.stringify(overflow)}`);
  }
  console.log('PASS real service worker: two identities reach the gateway, no API cache, offline fails closed');
  console.log('PASS real Chromium: home, agents, tasks and comms fit a 320px viewport');
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
  await new Promise((resolve) => gateway.close(resolve));
}
