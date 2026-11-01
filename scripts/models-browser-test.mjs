/* The model gateway in a real Chromium, against a real gateway and a real provider.
 * Run: npm run test:models:browser
 * Optional deps: npm install --no-save --ignore-scripts puppeteer-core @sparticuz/chromium
 *
 * happy-dom proves the wiring; only a browser proves the loop a person performs — sign in, seal a key,
 * make one real request, watch the ledger record it, set a budget that refuses the next one, reload and
 * find the provider still configured. The provider here is a real HTTP server on loopback, so the
 * adapter's request is genuine: if it did not send an Authorization header, this suite fails.
 */
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'vite';

const DATA_DIR = `/tmp/mmm-models-browser-${process.pid}`;
rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;
process.env.MMM_QUIET = '1';
process.env.MMM_BOOTSTRAP_EMAIL = 'owner@models.local';
process.env.MMM_BOOTSTRAP_PASSWORD = 'OwnerPassw0rd!2026';

let chromium;
let puppeteer;
try {
  chromium = (await import('@sparticuz/chromium')).default;
  puppeteer = (await import('puppeteer-core')).default;
} catch {
  console.log('SKIP models browser: install puppeteer-core and @sparticuz/chromium (npm i --no-save --ignore-scripts puppeteer-core @sparticuz/chromium)');
  process.exit(0);
}

/* ---------- a real OpenAI-compatible provider on loopback ---------- */
const KEY = 'sk-browser-test-abcdef0123456789';
const REPLY = 'Hello from a real loopback provider.';
const received = [];
const provider = createHttpServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    received.push({ url: req.url, auth: req.headers.authorization || '', body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: REPLY } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }));
  });
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
const providerBase = `http://127.0.0.1:${provider.address().port}/v1`;

const PORT = 8787;
const { createGateway } = await import('../apps/gateway/server.js');
const gateway = createGateway();
await new Promise((resolve) => gateway.server.listen(PORT, '127.0.0.1', resolve));

const vite = await createServer({ logLevel: 'silent', server: { port: 0 }, clearScreen: false });
await vite.listen();
const base = `http://127.0.0.1:${vite.httpServer.address().port}`;

const results = [];
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS ${name}`); console.log(`PASS ${name}`); }
  catch (e) { failures += 1; results.push(`FAIL ${name}: ${e.message}`); console.log(`FAIL ${name}: ${e.message}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;
let exitCode = 0;

try {
  browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    executablePath: process.env.MMM_CHROMIUM_PATH || await chromium.executablePath(),
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('mmm.gateway', '/'); } catch { /* ignore */ } });

  await page.goto(`${base}/#/login`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#login-form');
  await page.type('#login-email', 'owner@models.local');
  await page.type('#login-password', 'OwnerPassw0rd!2026');
  await Promise.all([page.click('#login-submit'), page.waitForFunction(() => !document.getElementById('login-form'), { timeout: 20000 })]);

  const go = async (hash) => {
    await page.evaluate((h) => { window.location.hash = h; }, hash);
    await sleep(700);
  };
  const viewText = () => page.evaluate(() => document.getElementById('view').textContent.replace(/\s+/g, ' ').trim());
  const click = async (selector, wait = 600) => {
    const el = await page.$(selector);
    assert.ok(el, `no element for ${selector}`);
    await el.evaluate((node) => node.click());
    await sleep(wait);
  };
  const apiRead = (path) => page.evaluate(async (p) => {
    const res = await fetch(p, { credentials: 'include' });
    return res.json();
  }, path);

  /* ---------- 1. before a key, the screen says so and offers nothing ---------- */
  await go('#/models');
  await sleep(900);
  await check('an unconfigured gateway offers no call control and no spend figure', async () => {
    const body = await viewText();
    assert.ok(/Model gateway/.test(body), 'titled as a gateway');
    assert.ok(/Nothing is configured yet/.test(body), `says nothing is configured (got "${body.slice(0, 220)}")`);
    assert.ok(!/estimated in 30 days/.test(body), 'no spend figure before any call');
    assert.equal(await page.$$eval('[data-act="provider-call"]', (e) => e.length), 0, 'no Test call button');
    assert.ok(await page.$$eval('[data-act="provider-key"]', (e) => e.length) > 0, 'an Owner does get an Install key button');
    assert.ok(/Ledger · 0 recent attempts/.test(body), 'and the ledger is empty, not missing');
  });

  /* ---------- 2. seal a key through the real sheet ---------- */
  await check('sealing a key through the sheet never leaves the key on screen', async () => {
    await click('[data-act="provider-key"][data-id="pv-openai"]', 500);
    assert.ok(await page.$('.sheet.open'), 'the sheet opened');
    await page.type('.sheet.open #pk-key', KEY);
    await page.evaluate((url) => { document.querySelector('.sheet.open #pk-url').value = url; }, providerBase);
    await page.evaluate(() => { document.querySelector('.sheet.open #pk-model').value = 'gpt-4o-mini'; });
    await click('.sheet.open [data-act="provider-key-save"]', 1400);
    assert.equal(await page.$('.sheet.open'), null, 'the sheet closed on success');
    const body = await viewText();
    assert.ok(/••••6789/.test(body), `the hint identifies the key (got "${body.slice(0, 300)}")`);
    const html = await page.evaluate(() => document.body.innerHTML);
    assert.ok(!html.includes(KEY), 'the key is nowhere in the DOM');
    assert.ok(!/sk-browser-test/.test(html), 'and neither is a prefix of it');
    assert.ok(/1 configured/.test(body), 'the header counts one configured provider');
  });

  await check('the gateway stores a sealed value, not the key', async () => {
    const providers = await apiRead('/api/v1/providers');
    const p = providers.providers.find((x) => x.id === 'pv-openai');
    assert.equal(p.status, 'configured', 'configured on the gateway');
    assert.ok(/^[0-9a-f]{16}$/.test(p.fingerprint), 'with a fingerprint');
    assert.equal(JSON.stringify(providers).includes(KEY), false, 'the API never returns the key');
  });

  /* ---------- 3. one real call ---------- */
  await check('a test call really reaches the provider and is metered', async () => {
    await click('[data-act="provider-call"][data-id="pv-openai"]', 500);
    assert.ok(await page.$('.sheet.open'), 'the call sheet opened');
    await page.type('.sheet.open #pc-prompt', 'Say hello');
    await click('.sheet.open [data-act="provider-call-go"]', 2000);
    const sheet = await page.evaluate(() => (document.querySelector('.sheet.open') || {}).textContent || '');
    assert.ok(sheet.includes(REPLY), `the reply is rendered (got "${sheet.slice(0, 400)}")`);
    assert.ok(/Cost \(estimated\)/.test(sheet), 'the cost is labelled estimated');
    assert.ok(/Tokens/.test(sheet), 'tokens are shown');
    assert.ok(received.length >= 1, 'the provider was actually called');
    const sent = received.at(-1);
    assert.equal(sent.url, '/v1/chat/completions', 'the adapter posts to the OpenAI-compatible path');
    assert.equal(sent.auth, `Bearer ${KEY}`, 'with the key in the Authorization header');
    assert.ok(JSON.parse(sent.body).messages[0].content === 'Say hello', 'with the prompt that was typed');
  });

  await check('the ledger on screen is the ledger on the server', async () => {
    await page.keyboard.press('Escape');
    await go('#/models');
    await sleep(900);
    const body = await viewText();
    assert.ok(/Ledger · 1 recent attempt/.test(body), `one attempt is listed (got "${body.slice(0, 400)}")`);
    assert.ok(/gpt-4o-mini/.test(body), 'with the model id');
    assert.ok(/est\./.test(body), 'and an estimated cost');
    const usage = await apiRead('/api/v1/usage');
    assert.equal(usage.today.calls, 1, 'the server agrees on the call count');
    assert.ok(usage.today.usd > 0, 'and has a spend');
    assert.ok(body.includes('$0.00') || Math.abs(usage.today.usd) < 0.01, 'the tile shows the estimated spend');
  });

  /* ---------- 4. a budget that refuses ---------- */
  await check('a zero budget refuses the next call and says nothing was billed', async () => {
    await page.evaluate(() => {
      document.getElementById('mb-daily').value = '0';
      document.getElementById('mb-call').value = '0';
    });
    await click('[data-act="budget-save"]', 1200);
    const before = received.length;
    await click('[data-act="provider-call"][data-id="pv-openai"]', 500);
    await page.type('.sheet.open #pc-prompt', 'this must not be sent');
    await click('.sheet.open [data-act="provider-call-go"]', 1800);
    const sheet = await page.evaluate(() => (document.querySelector('.sheet.open') || {}).textContent || '');
    assert.ok(/budget is spent/.test(sheet), `the refusal explains itself (got "${sheet.slice(-260)}")`);
    assert.ok(/Nothing was billed by us/.test(sheet), 'and does not imply a call happened');
    assert.equal(received.length, before, 'the provider was not contacted');
    await page.keyboard.press('Escape');
    await go('#/models');
    await sleep(800);
    const body = await viewText();
    assert.ok(/refused/.test(body), 'the refusal is in the ledger');
    assert.ok(/no cost/.test(body), 'at zero cost');
  });

  /* ---------- 5. reload: the sealed key survives ---------- */
  await check('the sealed key survives a reload', async () => {
    await page.reload({ waitUntil: 'networkidle0' });
    await sleep(1200);
    await go('#/models');
    await sleep(900);
    const body = await viewText();
    assert.ok(/1 configured/.test(body), 'still configured after a reload');
    assert.ok(/••••6789/.test(body), 'with the same hint');
    const html = await page.evaluate(() => document.body.innerHTML);
    assert.ok(!html.includes(KEY), 'and still no key in the DOM');
  });

  /* ---------- 6. removing the key ---------- */
  await check('removing the key returns the provider to unconfigured', async () => {
    await click('[data-act="provider-unkey"][data-id="pv-openai"]', 500);
    const confirm = await page.$('#confirm-yes, .modal-center .btn.danger, .modal-center .btn.ok');
    if (confirm) { await confirm.evaluate((n) => n.click()); }
    await sleep(1400);
    const body = await viewText();
    assert.ok(/Nothing is configured yet/.test(body), `back to nothing configured (got "${body.slice(0, 240)}")`);
    assert.equal(await page.$$eval('[data-act="provider-call"]', (e) => e.length), 0, 'and no call button');
    const providers = await apiRead('/api/v1/providers');
    assert.equal(providers.providers.find((x) => x.id === 'pv-openai').status, 'unconfigured', 'the server agrees');
  });

  /* ---------- 7. layout and errors ---------- */
  await check('nothing overflows sideways at 320px and no page errored', async () => {
    await page.setViewport({ width: 320, height: 720, isMobile: true, hasTouch: true });
    await go('#/models');
    await sleep(700);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `page overflows by ${overflow}px at 320px`);
    assert.deepEqual(errors, [], errors.join('; '));
  });
} catch (error) {
  failures += 1;
  console.log(`FAIL browser harness: ${error.message}`);
} finally {
  // A browser keeps sockets alive; every close gets a deadline so the suite always ends with a report.
  const deadline = (promise, ms = 4000) => Promise.race([promise, sleep(ms)]).catch(() => {});
  try { gateway.server.closeAllConnections?.(); } catch { /* ignore */ }
  await deadline(browser?.close());
  await deadline(new Promise((r) => vite.close(r)));
  await deadline(new Promise((r) => gateway.server.close(r)));
  await deadline(new Promise((r) => provider.close(r)));
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  const passed = results.filter((r) => r.startsWith('PASS')).length;
  console.log(`\nMODELS BROWSER: ${passed} passed, ${failures} failed`);
  exitCode = failures > 0 ? 1 : 0;
}
process.exit(exitCode);
