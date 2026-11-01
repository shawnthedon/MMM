/* Swarm plans in a real Chromium, against a real gateway.
 * Run: npm run test:swarms:browser
 * Optional deps: npm install --no-save puppeteer-core @sparticuz/chromium
 *
 * happy-dom proves the wiring. Only a browser can prove the loop a person actually performs: sign in,
 * save a plan from the sheet, see it in the list, open it, mark it cancelled, reload the page and find
 * it still there — with "not executed" on screen the whole way.
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'vite';

const DATA_DIR = `/tmp/mmm-swarms-browser-${process.pid}`;
rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;
process.env.MMM_QUIET = '1';
process.env.MMM_BOOTSTRAP_EMAIL = 'owner@swarms.local';
process.env.MMM_BOOTSTRAP_PASSWORD = 'OwnerPassw0rd!2026';
process.env.MMM_ALLOW_SEED = '1';

let chromium;
let puppeteer;
try {
  chromium = (await import('@sparticuz/chromium')).default;
  puppeteer = (await import('puppeteer-core')).default;
} catch {
  console.log('SKIP swarms browser: install puppeteer-core and @sparticuz/chromium (npm i --no-save --ignore-scripts puppeteer-core @sparticuz/chromium)');
  process.exit(0);
}

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

  // Sign in through the app's own form, then open the screen the way a person would.
  await page.goto(`${base}/#/login`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#login-form');
  await page.type('#login-email', 'owner@swarms.local');
  await page.type('#login-password', 'OwnerPassw0rd!2026');
  await Promise.all([page.click('#login-submit'), page.waitForFunction(() => !document.getElementById('login-form'), { timeout: 20000 })]);
  await page.evaluate(() => { window.location.hash = '#/teams'; });
  await page.waitForSelector('#view');

  // Give the gateway the same team grouping the fixture uses, so the sheet has a team to point at.
  await page.evaluate(async () => {
    await fetch('/api/v1/dev/seed', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include', body: '{"reset":false}' });
  });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('#view');
  await sleep(1200);

  const viewText = () => page.evaluate(() => document.getElementById('view').textContent.replace(/\s+/g, ' ').trim());

  await check('the plans screen is live and says nothing executes', async () => {
    const body = await viewText();
    assert.ok(/No swarm has ever executed anything/.test(body), `banner missing (got: ${body.slice(0, 200)})`);
    assert.ok(/live gateway/i.test(body), 'the slice is the gateway’s, not a fixture');
    const chip = await page.$eval('#source-chip', (el) => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
    assert.ok(/live|synced/i.test(chip), `the source chip agrees (got “${chip}”)`);
  });

  await check('saving a plan from the sheet writes a row the server returns', async () => {
    // The header button and the empty-state button both open the sheet; click whichever is visible.
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('[data-act="new-swarm"]')].find((b) => b.getClientRects().length);
      if (!el) throw new Error('no visible new-plan control');
      el.click();
    });
    await page.waitForSelector('.sheet.open');
    await page.evaluate(() => {
      document.querySelector('.sheet.open #sw-obj').value = 'Browser-saved plan for the EU market';
      document.querySelector('.sheet.open #sw-budget').value = '6';
    });
    await page.evaluate(() => {
      const el = document.querySelector('.sheet.open [data-act="swarm-deploy-go"]');
      if (!el) throw new Error('no save control in the open sheet');
      el.click();
    });
    await sleep(1500);
    const body = await viewText();
    assert.ok(/Browser-saved plan/.test(body), `the saved plan is on screen (got: ${body.slice(0, 240)})`);
    assert.ok(/never run/.test(body), 'and the record says it never ran');
    assert.ok(/gateway row/.test(body), 'with the gateway as its source');
    const stored = await page.evaluate(async () => {
      const res = await fetch('/api/v1/swarms', { credentials: 'include' });
      return res.json();
    });
    const row = stored.swarms.find((w) => w.objective.includes('Browser-saved plan'));
    assert.ok(row, 'the plan exists in the database');
    assert.equal(row.executed, false, 'and it is not executed');
    assert.equal(row.progress, 0, 'with zero progress');
    assert.equal(row.budget.spent, 0, 'and no spend');
  });

  await check('a plan decision is labelled as one, and it persists', async () => {
    await page.evaluate(() => {
      const el = document.querySelector('[data-act="swarm-status"][data-status="cancelled"]');
      if (!el) throw new Error('no plan-status control on the record');
      el.click();
    });
    await sleep(1500);
    const body = await viewText();
    assert.ok(/cancelled/.test(body), `the record moved to cancelled (got: ${body.slice(0, 240)})`);
    const stored = await page.evaluate(async () => (await fetch('/api/v1/swarms', { credentials: 'include' })).json());
    const row = stored.swarms.find((w) => w.objective.includes('Browser-saved plan'));
    assert.equal(row.status, 'cancelled', 'the server holds the new status');
    assert.equal(row.executed, false, 'and still nothing ran');
  });

  await check('the plan survives a reload', async () => {
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('#view');
    await sleep(1500);
    const list = await viewText();
    assert.ok(/Browser-saved plan/.test(list), 'the plan is still listed after a reload');
    assert.ok(/cancelled/.test(list), 'with the status it was given');
  });

  await check('no control offers to start, pause or stop a plan', async () => {
    const controls = await page.$$eval('[data-act]', (els) => els.map((e) => e.dataset.act));
    for (const forbidden of ['swarm-pause', 'swarm-cancel', 'swarm-start', 'swarm-run']) {
      assert.ok(!controls.includes(forbidden), `${forbidden} must not exist`);
    }
    const buttons = await page.$$eval('#view button', (els) => els.map((e) => e.textContent.trim()));
    assert.ok(!buttons.some((t) => /^(Run|Start|Resume|Deploy)\b/i.test(t)), `no button claims to run a plan (got ${buttons.join(' | ')})`);
  });

  await check('nothing advances on its own', async () => {
    const snapshot = () => page.evaluate(() => {
      const rows = [...document.querySelectorAll('#view .progress > i')].map((el) => el.getAttribute('style') || '');
      return JSON.stringify({ rows, body: document.getElementById('view').textContent });
    });
    const before = await snapshot();
    await sleep(6000);
    assert.equal(await snapshot(), before, 'the DOM changed by itself — something is ticking again');
  });

  await check('nothing overflows sideways at 320px', async () => {
    await page.setViewport({ width: 320, height: 720, isMobile: true, hasTouch: true });
    await page.evaluate(() => { window.location.hash = '#/teams'; });
    await sleep(600);
    const overflow = await page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      const offenders = [];
      for (const el of document.querySelectorAll('#view *')) {
        const r = el.getBoundingClientRect();
        if (r.right > w + 0.5 && r.width > 0 && r.right <= w + 40) offenders.push(`${el.tagName}.${String(el.className).slice(0, 30)}@${Math.round(r.right)}`);
      }
      return { px: document.documentElement.scrollWidth - w, offenders: offenders.slice(0, 6) };
    });
    if (overflow.px > 1) console.log('DBG overflow', JSON.stringify(overflow));
    assert.ok(overflow.px <= 1, `the plans screen scrolls sideways by ${overflow.px}px at 320px (${overflow.offenders.join(', ')})`);
    const wide = await page.evaluate(() => {
      const el = document.querySelector('#view .banner');
      return el ? Math.round(el.getBoundingClientRect().width) : 0;
    });
    assert.ok(wide > 0 && wide <= 320, `a banner fits the viewport (${wide}px)`);
  });

  await check('no page errors during the whole session', async () => {
    assert.deepEqual(errors, [], errors.join('; '));
  });
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { await new Promise((r) => gateway.server.close(r)); } catch { /* ignore */ }
  try { gateway.wss?.close(); } catch { /* ignore */ }
  try { await vite.close(); } catch { /* ignore */ }
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(results.join('\n'));
const passed = results.filter((r) => r.startsWith('PASS')).length;
console.log(`\nSWARM BROWSER: ${passed} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
