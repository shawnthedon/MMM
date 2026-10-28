// Optional real Chromium integration test; supply a local, licensed GGUF with MMM_SPIKE_MODEL.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { build, preview } from 'vite';

const model = process.env.MMM_SPIKE_MODEL;
if (!model) throw new Error('Set MMM_SPIKE_MODEL to a local GGUF file; none is bundled.');
if (process.env.MMM_SPIKE_REQUIRE_NETWORK_NAMESPACE === '1') {
  // Run under a pre-created Linux network namespace; never claim isolation just from a flag.
  const ip = (...args) => JSON.parse(execFileSync('ip', ['-j', ...args], { encoding: 'utf8' }));
  const interfaces = ip('address', 'show');
  assert.deepEqual(interfaces.map(item => item.ifname), ['lo'], 'isolated test needs only loopback');
  assert.ok(interfaces[0].flags.includes('UP'), 'loopback must be up for Vite');
  assert.ok(interfaces[0].addr_info.some(info => info.local === '127.0.0.1'), 'loopback IPv4 missing');
  for (const family of ['-4', '-6']) {
    assert.ok(ip(family, 'route', 'show').every(route => route.dev === 'lo'), `${family} external route exists`);
  }
  console.log('PASS Linux network namespace has only loopback and no external routes');
}
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
  // A write failure must not replace an already imported file with partial bytes.
  const interruption = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('mmm-local-spike');
    const file = () => dir.getFileHandle('model.gguf').then(h => h.getFile());
    const digest = async f => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await f.arrayBuffer()))).join(',');
    const before = await digest(await file());
    const header = new Blob([new Uint8Array([71, 71, 85, 70, 3, 0, 0, 0])]);
    const broken = { size: 40, slice: () => header, stream: () => new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(8)); controller.error(new Error('simulated read failure')); },
    }) };
    let error = '';
    try { await window.localSpike.importModel(broken); } catch (e) { error = e.message; }
    return { error, preserved: before === await digest(await file()) };
  });
  assert.match(interruption.error, /simulated read failure/);
  assert.equal(interruption.preserved, true, 'interrupted import must preserve the previously installed file');
  await page.click('#prepare');
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Runtime asset prepared'), { timeout: 60000 });
  await page.setOfflineMode(true);
  const start = requests.length;
  await page.click('#load');
  await page.waitForFunction(() => /Model loaded locally|Not completed/.test(document.querySelector('#status').textContent), { timeout: 90000 });
  assert.match(await page.$eval('#status', el => el.textContent), /Model loaded locally/);
  const loadMetrics = await page.$eval('#metrics', el => el.textContent);
  // Observe the actual model worker, not just page requests. Validate the observer with a
  // deliberate offline sentinel request, then isolate the ensuing inference interval.
  const worker = page.workers()[0];
  assert.ok(worker, 'the runtime worker must exist');
  const workerRequests = [];
  const workerSession = worker.client;
  workerSession.on('Network.requestWillBeSent', event => workerRequests.push(event.request.url));
  await workerSession.send('Network.enable');
  // Page offline emulation does not reliably propagate to dedicated workers. The sentinel
  // checks that this observer sees their HTTP attempts; it does not prove worker disconnection.
  const workerSentinel = await worker.evaluate(async (url) => { try { await fetch(url); return 'reachable'; } catch { return 'blocked'; } }, `${base}/network-audit-sentinel`);
  assert.ok(workerRequests.some(url => url.endsWith('/network-audit-sentinel')), 'worker request observer must see the sentinel');
  const workerStart = workerRequests.length;
  await page.type('#prompt', 'Once upon a time');
  await page.click('#generate');
  await page.waitForFunction(() => /Local generation completed|Not completed/.test(document.querySelector('#status').textContent), { timeout: 90000 });
  assert.match(await page.$eval('#status', el => el.textContent), /Local generation completed/);
  const output = await page.$eval('#output', el => el.textContent);
  const metrics = await page.$eval('#metrics', el => el.textContent);
  assert.ok(output.length > 0, 'real model produced no output');
  const network = requests.slice(start).filter(req => /^https?:/.test(req.url) && !req.url.endsWith('/network-audit-sentinel'));
  assert.deepEqual(network, [], `page attempted network requests while offline: ${JSON.stringify(network)}`);
  assert.deepEqual(workerRequests.slice(workerStart).filter(url => /^https?:/.test(url)), [], 'runtime worker attempted HTTP during inference');
  await page.evaluate(() => {
    const output = document.querySelector('#output');
    const observer = new MutationObserver(() => {
      if (output.textContent) { observer.disconnect(); document.querySelector('#stop').click(); }
    });
    observer.observe(output, { childList: true, characterData: true, subtree: true });
  });
  await page.click('#generate');
  await page.waitForFunction(() => /Generation stopped|Not completed|Local generation completed/.test(document.querySelector('#status').textContent), { timeout: 90000 });
  assert.match(await page.$eval('#status', el => el.textContent), /Generation stopped/);
  assert.ok((await page.$eval('#output', el => el.textContent)).length > 0, 'partial output remains visible');
  assert.match(await page.$eval('#metrics', el => el.textContent), /No completed generation measurements/);
  assert.deepEqual(workerRequests.slice(workerStart).filter(url => /^https?:/.test(url)), [], 'runtime worker attempted HTTP during stop');
  const workerClosed = new Promise(resolveClose => page.once('workerdestroyed', resolveClose));
  await page.click('#unload');
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Runtime unloaded'));
  await Promise.race([workerClosed, new Promise((_, reject) => setTimeout(() => reject(new Error('worker not terminated')), 5000))]);
  assert.equal(await page.evaluate(() => window.localSpike.status().loaded), false);
  assert.equal(page.workers().length, 0, 'unload terminates the model worker');
  // Reload from the previously cached same-origin runtime while still offline.
  await page.click('#prepare');
  await page.waitForFunction(() => /Not completed|Runtime asset prepared/.test(document.querySelector('#status').textContent), { timeout: 30000 });
  assert.match(await page.$eval('#status', el => el.textContent), /Runtime asset prepared/);
  await page.click('#load');
  await page.waitForFunction(() => /Model loaded locally|Not completed/.test(document.querySelector('#status').textContent), { timeout: 90000 });
  assert.match(await page.$eval('#status', el => el.textContent), /Model loaded locally/);
  await page.click('#unload');
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Runtime unloaded'));
  // A header-only truncated file may import, but the real runtime must reject it on load.
  const corrupt = await page.evaluate(async () => {
    const data = new Uint8Array(40); data.set([71, 71, 85, 70, 3, 0, 0, 0]);
    await window.localSpike.importModel(new Blob([data]));
    await window.localSpike.prepare();
    try { await window.localSpike.load(); return { loaded: true }; }
    catch (e) { return { loaded: false, error: e.message, status: window.localSpike.status() }; }
  });
  assert.equal(corrupt.loaded, false, 'truncated GGUF must not load');
  assert.ok(corrupt.error, 'corrupt GGUF failure must be reported');
  assert.equal(corrupt.status.loaded, false);
  assert.equal(corrupt.status.cleanupPending, false);
  await page.goto(`${base}/#/local`, { waitUntil: 'networkidle0' });
  assert.ok(await page.$('#local-preflight'), 'offline PWA shell was replaced by spike HTML');
  assert.deepEqual(errors, []);
  console.log(`PASS page-offline OPFS load, generation, stop, repeat load/unload and corrupted-model rejection\n${loadMetrics}\n${metrics}\nOutput characters: ${output.length}\nPage HTTP requests during inference (excluding sentinel): ${network.length}\nWorker HTTP requests during generation/stop: 0 (instrumented after model load)\nWorker sentinel with page offline: ${workerSentinel}\nPASS interrupted OPFS write preserves old model; offline PWA shell remains intact`);
} finally {
  if (browser) await browser.close();
  await new Promise((resolveClose, reject) => server.httpServer.close(err => err ? reject(err) : resolveClose()));
}
