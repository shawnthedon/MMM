/* No fabrications, in a real browser — the screens people actually see.
 * Run: npm run test:honesty:browser
 * Optional deps: npm install --no-save puppeteer-core @sparticuz/chromium
 *
 * happy-dom can read the templates. Only a browser can prove that the screens *render* without the
 * claim, and that nothing moves on its own: the old ticker ran every 4.2 s, so six seconds of a real
 * page with an unchanged DOM is the assertion that it is gone.
 */
import assert from 'node:assert/strict';
import { createServer } from 'vite';

let chromium;
let puppeteer;
try {
  chromium = (await import('@sparticuz/chromium')).default;
  puppeteer = (await import('puppeteer-core')).default;
} catch {
  console.log('SKIP honesty browser: install puppeteer-core and @sparticuz/chromium (npm i --no-save --ignore-scripts puppeteer-core @sparticuz/chromium)');
  process.exit(0);
}

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
  await page.goto(`${base}/#/teams`, { waitUntil: 'networkidle0' });

  const text = () => page.evaluate(() => document.getElementById('view').textContent.replace(/\s+/g, ' ').trim());
  const go = async (route) => { await page.evaluate((r) => { window.location.hash = `#/${r}`; }, route); await sleep(700); };

  await check('the teams screen renders and says nothing executes', async () => {
    await go('teams');
    const body = await text();
    assert.ok(/No swarm has ever executed anything/.test(body), `banner missing: ${body.slice(0, 200)}`);
    assert.ok(/not executed/.test(body), 'the not-executed label is rendered');
    assert.ok(!/Deploy · est/.test(body), 'the invented estimate is not on screen');
  });

  await check('six seconds pass with no self-advancing progress', async () => {
    await go('teams');
    const snapshot = () => page.evaluate(() => {
      const bars = [...document.querySelectorAll('#view .progress > i')].map((el) => el.getAttribute('style') || '');
      return JSON.stringify({ bars, body: document.getElementById('view').textContent });
    });
    const before = await snapshot();
    await sleep(6000); // the old tick fired at 4.2 s
    const after = await snapshot();
    assert.equal(after, before, 'the DOM changed on its own — something is still ticking');
  });

  await check('the swarm detail is a plan with no live controls', async () => {
    await go('teams/sw-market');
    const body = await text();
    assert.ok(/Not executed/.test(body), 'the plan banner is shown');
    assert.ok(!/Pause|Cancel swarm/.test(body), 'no pause/cancel for a process that is not running');
    assert.ok(!/\$3\.41|62%/.test(body), 'the fabricated spend and progress are gone');
  });

  await check('settings makes no vault or egress claim', async () => {
    await go('settings');
    const body = await text();
    for (const claim of ['AEAD-sealed vault', '4 templates active', 'default-deny · proxy']) {
      assert.ok(!body.includes(claim), `“${claim}” is still on screen`);
    }
    assert.ok(/no key vault in this build/.test(body), 'and the truth is');
  });

  await check('the plugin catalogue renders with no credential field', async () => {
    await go('plugins');
    const body = await text();
    assert.ok(/No MCP client is installed in this build/.test(body), 'the client is declared absent');
    assert.ok(!/calls today/.test(body), 'no call counter');
    assert.equal(await page.$$eval('#view input[type="password"]', (e) => e.length), 0, 'no password input');
  });

  await check('the model screen offers no provider switch', async () => {
    await go('models');
    const body = await text();
    assert.ok(/Model catalogue/.test(body), 'titled as a catalogue');
    assert.ok(/not configured/.test(body), 'says not configured');
    assert.equal(await page.$$eval('[data-act="toggle-provider"]', (e) => e.length), 0, 'no switch');
  });

  await check('no page errors while visiting every screen', async () => {
    for (const r of ['home', 'agents', 'teams', 'tasks', 'skills', 'models', 'plugins', 'analytics', 'settings', 'terminal']) await go(r);
    assert.deepEqual(errors, [], errors.join('; '));
  });

  await check('nothing overflows sideways at 320px', async () => {
    await page.setViewport({ width: 320, height: 720, isMobile: true, hasTouch: true });
    for (const r of ['teams', 'models', 'plugins', 'settings', 'analytics']) {
      await go(r);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `${r} scrolls sideways by ${overflow}px at 320px`);
    }
  });
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { await vite.close(); } catch { /* ignore */ }
}

console.log(results.join('\n'));
const passed = results.filter((r) => r.startsWith('PASS')).length;
console.log(`\nHONESTY BROWSER: ${passed} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
