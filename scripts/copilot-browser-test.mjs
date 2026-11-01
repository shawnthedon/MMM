/* The Copilot conversation in a real Chromium, against a real gateway and a real provider.
 * Run: npm run test:copilot:browser
 * Optional deps: npm install --no-save --ignore-scripts puppeteer-core @sparticuz/chromium
 *
 * happy-dom proves the wiring; only a browser proves the loop a person performs — sign in, open the
 * Copilot, see that no model can answer, install a key on the Models screen, ask a question, and watch
 * a real loopback provider answer with the reply rendered in the panel and the whole turn in the
 * gateway's own tables. Then reload: the conversation is still there, because it was never in the panel.
 */
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'vite';

const DATA_DIR = `/tmp/mmm-copilot-browser-${process.pid}`;
rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;
process.env.MMM_QUIET = '1';
process.env.MMM_SECRET = 'browser-test-secret-material-that-is-long-enough-1234';
process.env.MMM_BOOTSTRAP_EMAIL = 'owner@copilot.local';
process.env.MMM_BOOTSTRAP_PASSWORD = 'OwnerPassw0rd!2026';

let chromium;
let puppeteer;
try {
  chromium = (await import('@sparticuz/chromium')).default;
  puppeteer = (await import('puppeteer-core')).default;
} catch {
  console.log('SKIP copilot browser: install puppeteer-core and @sparticuz/chromium (npm i --no-save --ignore-scripts puppeteer-core @sparticuz/chromium)');
  process.exit(0);
}

/* ---------- a real OpenAI-compatible provider on loopback ---------- */
const KEY = 'sk-copilot-browser-0123456789';
const REPLY = 'Three things I can actually do: answer from the knowledge pack, read this screen, and refuse what I cannot do.';
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
      usage: { prompt_tokens: 240, completion_tokens: 40, total_tokens: 280 },
    }));
  });
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
const providerBase = `http://127.0.0.1:${provider.address().port}/v1`;

// vite.config proxies /api, /healthz and /ws to 8787, which is how the browser talks to the gateway.
const PORT = 8787;
const { createGateway } = await import('../apps/gateway/server.js');
const dbm = await import('../apps/gateway/src/db.js');
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
    executablePath: process.env.MMM_CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('mmm.gateway', '/'); } catch { /* ignore */ } });

  await page.goto(`${base}/#/login`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#login-form');
  await page.type('#login-email', 'owner@copilot.local');
  await page.type('#login-password', 'OwnerPassw0rd!2026');
  await Promise.all([page.click('#login-submit'), page.waitForFunction(() => !document.getElementById('login-form'), { timeout: 20000 })]);
  await sleep(600);

  const go = async (hash) => {
    await page.evaluate((h) => { window.location.hash = h; }, hash);
    await sleep(700);
  };
  const click = async (selector, wait = 600) => {
    const el = await page.$(selector);
    assert.ok(el, `no element for ${selector}`);
    await el.evaluate((node) => node.click());
    await sleep(wait);
  };
  const panelText = () => page.evaluate(() => (document.getElementById('copilot-panel') || {}).textContent?.replace(/\s+/g, ' ').trim() || '');
  const panelState = () => page.evaluate(() => {
    const p = document.getElementById('copilot-panel');
    if (!p) return null;
    return {
      source: p.getAttribute('data-source'),
      gateway: p.getAttribute('data-gateway'),
      modeButtons: p.querySelectorAll('[data-cp="mode"]').length,
      bubbles: [...p.querySelectorAll('.cp-msg')].map((el) => ({
        bot: el.classList.contains('bot'),
        text: (el.querySelector('.cp-bubble')?.textContent || '').replace(/\s+/g, ' ').trim(),
        meta: (el.querySelector('.cp-msg-meta')?.textContent || '').replace(/\s+/g, ' ').trim(),
        callId: el.getAttribute('data-call-id'),
      })),
    };
  });
  const openCopilot = async () => {
    await page.evaluate(() => document.querySelector('[data-act="copilot-open"]')?.click());
    await sleep(900);
    assert.ok(await page.$('#copilot-panel'), 'the panel opened');
  };
  const closeCopilot = async () => {
    await page.evaluate(() => document.querySelector('#copilot-panel [data-cp="close"]')?.click());
    await sleep(300);
  };
  const say = async (text) => {
    // Typing is the real path: focus the composer, type, submit the form.
    await page.evaluate(() => {
      const p = document.getElementById('copilot-panel');
      p?.querySelector('[data-cp="toggle-advanced"]')?.click();
    });
    await sleep(400);
    await page.type('#copilot-input', text);
    await page.evaluate(() => document.getElementById('cp-form').requestSubmit());
    await sleep(2200);
  };

  /* ---------- 1. no key: the panel says the truth and does not pretend ---------- */
  await openCopilot();
  await check('before a key the panel states there is no model and shows no mode-less conversation', async () => {
    const st = await panelState();
    assert.equal(st.source, 'local', 'answers come from the built-in engine');
    assert.equal(st.gateway, 'unready', 'and the gateway says why');
    assert.ok(st.modeButtons > 0, 'the mode tabs are still the way into the deterministic answers');
    const body = await panelText();
    assert.ok(/No model is configured, so nothing here is model-written/.test(body), `the notice is explicit (got "${body.slice(0, 300)}")`);
    assert.ok(/stay in this browser/.test(body), 'and says where the conversation lives');
    assert.ok(/Install a provider key/.test(body), 'and offers the fix');
  });

  await check('a question gets a built-in answer that says no model was called', async () => {
    await say('what can you do?');
    const st = await panelState();
    const bot = st.bubbles.filter((b) => b.bot).at(-1);
    assert.ok(bot, 'something answered');
    assert.ok(/no model called/i.test(bot.meta), `the meta line admits it (got "${bot.meta}")`);
    assert.equal(received.length, 0, 'the provider was never contacted');
  });

  await closeCopilot();

  /* ---------- 2. install a key on the Models screen ---------- */
  await go('#/models');
  await sleep(900);
  await click('[data-act="provider-key"][data-id="pv-openai"]', 500);
  await page.type('.sheet.open #pk-key', KEY);
  await page.evaluate((url) => { document.querySelector('.sheet.open #pk-url').value = url; }, providerBase);
  await page.evaluate(() => { document.querySelector('.sheet.open #pk-model').value = 'gpt-4o-mini'; });
  await click('.sheet.open [data-act="provider-key-save"]', 1600);
  const sheetClosed = await page.$('.sheet.open');
  assert.equal(sheetClosed, null, 'the key was sealed through the sheet');

  /* ---------- 3. a real conversation ---------- */
  await go('#/home');
  await sleep(500);
  await openCopilot();
  await check('with a key the panel becomes a live conversation with no mode tabs', async () => {
    const st = await panelState();
    assert.equal(st.source, 'live', 'a model answers');
    assert.equal(st.gateway, 'ready', 'and the gateway reports a configured provider');
    assert.equal(st.modeButtons, 0, 'the mode tabs are gone');
    const body = await panelText();
    assert.ok(/gpt-4o-mini/.test(body), `the model is named (got "${body.slice(0, 300)}")`);
    assert.ok(/cost estimated/.test(body), 'and the cost basis is stated');
    assert.ok(!/No model is configured/.test(body), 'the warning is gone');
  });

  await check('a real question reaches the provider and the reply carries its ledger id', async () => {
    await say('What can you actually do?');
    const st = await panelState();
    const bot = st.bubbles.filter((b) => b.bot).at(-1);
    assert.equal(bot.text, REPLY, `the provider's text is rendered (got "${bot.text}")`);
    assert.ok(/240 in \/ 40 out/.test(bot.meta), `tokens are shown (got "${bot.meta}")`);
    assert.ok(/est\./.test(bot.meta), 'the cost is labelled estimated');
    assert.ok(/call #\d+/.test(bot.meta), 'and the call id is in the provenance line');
    assert.ok(Number(bot.callId) > 0, 'the bubble carries it as an attribute');
    assert.equal(received.length, 1, 'the provider was called exactly once');
    assert.equal(received[0].auth, `Bearer ${KEY}`, 'with the sealed key in the Authorization header');
    const sent = JSON.parse(received[0].body);
    assert.equal(sent.model, 'gpt-4o-mini', 'for the model that was configured');
    assert.equal(sent.messages.filter((m) => m.role === 'user').at(-1).content, 'What can you actually do?', 'with the question that was typed');
  });

  await check('the turn exists in the gateway’s own tables, not in the panel', async () => {
    const row = dbm.db.prepare("SELECT * FROM model_calls WHERE purpose='copilot' ORDER BY ts DESC LIMIT 1").get();
    assert.ok(row, 'a copilot call is in the ledger');
    assert.equal(row.status, 'ok', 'and it succeeded');
    const msgs = dbm.db.prepare("SELECT * FROM messages WHERE model_call_id=?").all(row.id);
    assert.equal(msgs.length, 1, 'exactly one message points at it');
    assert.ok(msgs[0].body.startsWith('Three things I can actually do'), 'and it is the reply');
    const thread = dbm.db.prepare("SELECT * FROM threads WHERE id=?").get(msgs[0].thread_id);
    assert.equal(thread.kind, 'copilot', 'in a copilot thread');
    assert.ok(thread.owner_id, 'owned by a principal');
  });

  await check('the conversation survives a reload, because it lives on the gateway', async () => {
    await page.reload({ waitUntil: 'networkidle0' });
    await sleep(900);
    await openCopilot();
    await sleep(800);
    const st = await panelState();
    assert.equal(st.source, 'live', 'still live after a reload');
    assert.ok(st.bubbles.some((b) => b.text === 'What can you actually do?'), 'the question is still there');
    assert.ok(st.bubbles.some((b) => b.text === REPLY), 'and so is the answer');
  });

  /* ---------- 4. the layout survives a narrow phone ---------- */
  await check('nothing overflows and no control is under 44 px at 320 px', async () => {
    await page.setViewport({ width: 320, height: 720, isMobile: true, hasTouch: true });
    await sleep(900);
    const metrics = await page.evaluate(() => {
      const p = document.getElementById('copilot-panel');
      // The holographic backdrop is decorative and clipped by its container; it is not content.
      const wide = [...p.querySelectorAll('*')]
        .filter((el) => !el.closest('.cp-holo') && el.getAttribute('aria-hidden') !== 'true')
        .filter((el) => el.getBoundingClientRect().right > 320.5)
        .map((el) => el.className || el.tagName);
      const small = [...p.querySelectorAll('button')]
        .filter((el) => el.offsetParent !== null)
        .map((el) => ({ cls: el.className, r: el.getBoundingClientRect() }))
        .filter((x) => x.r.height > 0 && (x.r.height < 43.5 || x.r.width < 43.5));
      return {
        docScroll: document.documentElement.scrollWidth,
        wide: wide.slice(0, 6),
        small: small.map((x) => `${x.cls}:${Math.round(x.r.width)}x${Math.round(x.r.height)}`).slice(0, 8),
      };
    });
    assert.equal(metrics.docScroll <= 320, true, `no sideways scroll (scrollWidth ${metrics.docScroll})`);
    assert.deepEqual(metrics.wide, [], `nothing sticks out past 320 px (${metrics.wide.join(', ')})`);
    assert.deepEqual(metrics.small, [], `every control is at least 44 px (${metrics.small.join(', ')})`);
  });

  await check('no page errors across the whole conversation', async () => {
    assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  });
} catch (error) {
  failures += 1;
  results.push(`FAIL harness: ${error.message}`);
  console.log(`FAIL harness: ${error.message}`);
} finally {
  console.log(results.join('\n'));
  console.log(`\nCOPILOT BROWSER: ${results.filter((r) => r.startsWith('PASS')).length} passed, ${failures} failed`);
  exitCode = failures > 0 ? 1 : 0;
  try { await browser?.close(); } catch { /* ignore */ }
  try { gateway.server.closeAllConnections?.(); gateway.server.close(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 200));
  try { await vite.close(); } catch { /* ignore */ }
  try { provider.close(); } catch { /* ignore */ }
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(exitCode);
}
