// Optional real-browser evidence; see docs/local/cross-origin-isolation.md for setup.
// Uses a temporary Chromium/Puppeteer install, not a runtime dependency of the app.
import assert from 'node:assert/strict';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { build, preview } from 'vite';

await build({ logLevel: 'silent' });
const server = await preview({ preview: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
let browser;
try {
  // Do not use chromium.args: its serverless defaults disable web security/site isolation,
  // invalidating this test's cross-origin isolation evidence.
  browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], executablePath: await chromium.executablePath(), headless: true });
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  const url = `${base}/#/local`;
  const failures = [];
  page.on('pageerror', (err) => failures.push(err.message));
  // Simulate the previous worker's cached, unisolated document before the new worker installs.
  await page.goto(`${base}/manifest.webmanifest`);
  await page.evaluate(async () => {
    const old = await caches.open('mmm-v1');
    await old.put('./index.html', new Response('<html>old shell</html>', { headers: { 'content-type': 'text/html' } }));
  });
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#local-caps .local-row');
  await page.evaluate(() => navigator.serviceWorker.ready);
  assert.equal(await page.evaluate(async () => (await caches.keys()).includes('mmm-v1')), false, 'old unisolated cache is removed');
  console.log('PASS activation removes the pre-isolation shell cache');
  // Reload to make the registered service worker control the document and cache built assets.
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('#local-caps .local-row');
  const verify = async (label) => {
    const result = await page.evaluate(() => ({
      isolated: window.crossOriginIsolated,
      sab: typeof SharedArrayBuffer === 'function',
      sharedWasm: (() => { try { return new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }).buffer instanceof SharedArrayBuffer; } catch { return false; } })(),
      controlled: Boolean(navigator.serviceWorker.controller),
      panel: document.querySelector('#local-caps')?.textContent,
    }));
    assert.equal(result.isolated, true, `${label}: crossOriginIsolated`);
    assert.equal(result.sab, true, `${label}: SharedArrayBuffer`);
    assert.equal(result.sharedWasm, true, `${label}: shared WebAssembly.Memory`);
    assert.equal(result.controlled, true, `${label}: service worker control`);
    assert.match(result.panel, /Threads \(SharedArrayBuffer\)\s*available/i, `${label}: preflight reports available`);
    console.log(`PASS ${label}: isolated, shared memory usable, preflight and service worker agree`);
  };
  await verify('online');
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('#local-caps .local-row');
  await verify('offline cached shell');
  assert.deepEqual(failures, [], `browser errors: ${failures.join('; ')}`);
} finally {
  if (browser) await browser.close();
  await new Promise((resolve, reject) => server.httpServer.close((err) => err ? reject(err) : resolve()));
}
