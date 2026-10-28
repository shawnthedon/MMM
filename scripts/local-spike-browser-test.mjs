// Optional real Chromium integration test; supply a local, licensed GGUF with MMM_SPIKE_MODEL.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { build, preview } from 'vite';

const model = process.env.MMM_SPIKE_MODEL;
if (!model) throw new Error('Set MMM_SPIKE_MODEL to a local GGUF file; none is bundled.');
await build({ logLevel: 'silent' });
const server = await preview({ preview: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
let browser;
try {
  browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], executablePath: await chromium.executablePath(), headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 320, height: 720 });
  const errors = [];
  const requests = [];
  page.on('pageerror', err => errors.push(err.message));
  page.on('request', req => requests.push({ url: req.url(), method: req.method() }));
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  // Install app's worker and check the spike doesn't poison its cached shell.
  await page.goto(`${base}/#/local`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.goto(`${base}/local-spike.html`, { waitUntil: 'networkidle0' });
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  const layout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > innerWidth,
    smallButtons: [...document.querySelectorAll('button')].filter(el => el.getBoundingClientRect().height < 44).map(el => el.id),
  }));
  assert.equal(layout.overflow, false, 'spike must not overflow at 320px');
  assert.deepEqual(layout.smallButtons, [], 'buttons need 44px touch height');
  await (await page.$('#model-file')).uploadFile(resolve(model));
  await page.click('#import');
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Model imported'), { timeout: 60000 });
  await page.click('#prepare');
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Runtime asset prepared'), { timeout: 60000 });
  await page.setOfflineMode(true);
  const start = requests.length;
  await page.click('#load');
  await page.waitForFunction(() => /Model loaded locally|Not completed/.test(document.querySelector('#status').textContent), { timeout: 90000 });
  assert.match(await page.$eval('#status', el => el.textContent), /Model loaded locally/);
  const loadMetrics = await page.$eval('#metrics', el => el.textContent);
  await page.type('#prompt', 'Once upon a time');
  await page.click('#generate');
  await page.waitForFunction(() => /Local generation completed|Not completed/.test(document.querySelector('#status').textContent), { timeout: 90000 });
  assert.match(await page.$eval('#status', el => el.textContent), /Local generation completed/);
  const output = await page.$eval('#output', el => el.textContent);
  const metrics = await page.$eval('#metrics', el => el.textContent);
  assert.ok(output.length > 0, 'real model produced no output');
  const network = requests.slice(start).filter(req => /^https?:/.test(req.url));
  assert.deepEqual(network, [], `page attempted network requests while offline: ${JSON.stringify(network)}`);
  await page.click('#unload');
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Runtime unloaded'));
  assert.equal(await page.evaluate(() => window.localSpike.status().loaded), false);
  await page.click('#prepare'); // offline reload must fail, not silently claim success
  await page.waitForFunction(() => /Not completed|Runtime asset prepared/.test(document.querySelector('#status').textContent), { timeout: 30000 });
  // A cached same-origin asset is permitted to work offline, but no cloud is permitted.
  await page.goto(`${base}/#/local`, { waitUntil: 'networkidle0' });
  assert.ok(await page.$('#local-preflight'), 'offline PWA shell was replaced by spike HTML');
  assert.deepEqual(errors, []);
  console.log(`PASS offline OPFS model load, generation and unload\n${loadMetrics}\n${metrics}\nOutput characters: ${output.length}\nHTTP requests after offline: ${network.length}\nPASS offline PWA shell remains intact`);
} finally {
  if (browser) await browser.close();
  await new Promise((resolveClose, reject) => server.httpServer.close(err => err ? reject(err) : resolveClose()));
}
