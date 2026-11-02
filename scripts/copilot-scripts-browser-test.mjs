/* Browser-script drafts in a real Chromium, against a real gateway and a real provider.
 * Run: npm run test:scripts:browser
 * Optional deps: npm install --no-save --ignore-scripts puppeteer-core @sparticuz/chromium
 *
 * The loop a person performs: ask the Copilot to look at a page, read the script card, submit it, try to run
 * it before the gate is decided (refused), have a *different* principal allow it, then run it as an Operator
 * — and find exactly one real browser task, queued with the criteria the script declared, and a card that
 * reports that task's status rather than a finished story.
 */
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'vite';

const DATA_DIR = `/tmp/mmm-scripts-browser-${process.pid}`;
rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;
process.env.MMM_QUIET = '1';
process.env.MMM_SECRET = 'browser-test-secret-material-that-is-long-enough-1234';
process.env.MMM_BROWSER_ALLOW_SIM = '1';   // the scripted driver is allowed — tests only
// Pin the gateway's browser engine to the scripted driver: the browser this test drives with puppeteer is
// a separate process, and a real engine here would open real pages mid-test.
process.env.MMM_BROWSER_CHROMIUM_PATH = '/nonexistent/mmm-test-chromium';
process.env.MMM_BROWSER_DISABLE = '1';     // no background ticker: the test drives nothing, so the task stays queued
process.env.MMM_BOOTSTRAP_EMAIL = 'owner@scriptbrowser.local';
process.env.MMM_BOOTSTRAP_PASSWORD = 'OwnerPassw0rd!2026';

let puppeteer;
try {
  await import('@sparticuz/chromium');
  puppeteer = (await import('puppeteer-core')).default;
} catch {
  console.log('SKIP scripts browser: install puppeteer-core and @sparticuz/chromium');
  process.exit(0);
}

/* ---------- a real provider that answers with a script ---------- */
const KEY = 'sk-scripts-browser-0123456789';
const SCRIPT = {
  objective: 'Read the pricing page heading',
  entryUrl: 'https://shop.test/pricing',
  steps: [
    { action: 'goto', url: 'https://shop.test/pricing' },
    { action: 'extract', key: 'heading', selector: 'h1' },
  ],
  successCriteria: [{ key: 'heading', kind: 'text', equals: 'Pricing' }],
  limits: { steps: 6, actions: 10 },
  allowActions: ['goto', 'extract'],
};
const received = [];
const provider = createHttpServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    received.push({ url: req.url, auth: req.headers.authorization || '', body: JSON.parse(body || '{}') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: '```json\n' + JSON.stringify(SCRIPT) + '\n```' } }],
      usage: { prompt_tokens: 320, completion_tokens: 140, total_tokens: 460 },
    }));
  });
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
const providerBase = `http://127.0.0.1:${provider.address().port}/v1`;

const PORT = 8787; // vite proxies /api, /healthz and /ws here
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

  const login = async (email, password) => {
    await page.goto(`${base}/#/login`);
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('#login-form');
    await page.type('#login-email', email);
    await page.type('#login-password', password);
    try {
      await Promise.all([page.click('#login-submit'), page.waitForFunction(() => !document.getElementById('login-form'), { timeout: 20000 })]);
    } catch (error) {
      const body = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 300));
      throw new Error(`login as ${email} did not complete (${error.message}); page says: ${body}`);
    }
    await sleep(600);
  };
  const logout = async () => {
    await page.evaluate(async () => {
      const { csrfToken } = await (await fetch('/api/v1/auth/session', { credentials: 'include' })).json();
      await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'include', headers: { 'x-mmm-csrf': csrfToken || '' } });
    });
    await sleep(300);
  };

  await login('owner@scriptbrowser.local', 'OwnerPassw0rd!2026');

  const go = async (hash) => {
    await page.evaluate((h) => { window.location.hash = h; }, hash);
    await sleep(700);
  };
  const post = (path, body) => page.evaluate(async (p, b) => {
    const csrf = (await (await fetch('/api/v1/auth/session', { credentials: 'include' })).json()).csrfToken;
    const res = await fetch(p, {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-mmm-csrf': csrf },
      body: JSON.stringify(b || {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }, path, body);
  const get = (path) => page.evaluate(async (p) => (await fetch(p, { credentials: 'include' })).json(), path);
  const openCopilot = async () => {
    await page.evaluate(() => document.querySelector('[data-act="copilot-open"]')?.click());
    await sleep(900);
    assert.ok(await page.$('#copilot-panel'), 'the panel opened');
    await page.evaluate(() => document.getElementById('copilot-panel')?.querySelector('[data-cp="toggle-advanced"]')?.click());
    await sleep(300);
  };
  const say = async (text) => {
    await page.type('#copilot-input', text);
    await page.evaluate(() => document.getElementById('cp-form').requestSubmit());
    await sleep(2600);
  };
  const card = () => page.evaluate(() => {
    const el = document.getElementById('copilot-panel')?.querySelector('.cp-script');
    if (!el) return null;
    return {
      id: el.getAttribute('data-script-id'),
      state: el.getAttribute('data-script-state'),
      text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
      steps: [...el.querySelectorAll('.cp-script-step')].map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim()),
      sensitive: el.querySelectorAll('.cp-script-step.sensitive').length,
      task: el.querySelector('[data-task-status]')?.textContent.trim() || '',
      actions: [...el.querySelectorAll('[data-cp^="script-"]')].map((b) => b.getAttribute('data-cp')),
    };
  });
  const eqTaskCount = (n) => {
    const rows = dbm.db.prepare('SELECT * FROM browser_tasks').all();
    assert.equal(rows.length, n, `browser tasks on the gateway: ${rows.length} (expected ${n})`);
    return rows;
  };
  const clickCard = async (act) => {
    await page.evaluate((a) => {
      document.getElementById('copilot-panel')?.querySelector(`[data-cp="${a}"]`)?.click();
    }, act);
    await sleep(1600);
  };

  /* ---------- 1. seal a key ---------- */
  await go('#/models');
  await sleep(900);
  await (await page.$('[data-act="provider-key"][data-id="pv-openai"]')).evaluate((n) => n.click());
  await sleep(500);
  await page.type('.sheet.open #pk-key', KEY);
  await page.evaluate((url) => { document.querySelector('.sheet.open #pk-url').value = url; }, providerBase);
  await page.evaluate(() => { document.querySelector('.sheet.open #pk-model').value = 'gpt-4o-mini'; });
  await (await page.$('.sheet.open [data-act="provider-key-save"]')).evaluate((n) => n.click());
  await sleep(1600);
  assert.equal(await page.$('.sheet.open'), null, 'the key was sealed');

  /* ---------- 2. ask it to look at a page ---------- */
  await go('#/home');
  await openCopilot();
  let scriptId = '';
  await check('“open … and check …” produces a script card in a real browser', async () => {
    await say('Open https://shop.test/pricing and check the heading');
    const st = await card();
    assert.ok(st, 'a script card is rendered');
    scriptId = st.id;
    assert.equal(st.state, 'ready-for-review', `the validator's state is shown (got "${st.state}")`);
    assert.ok(/Read the pricing page heading/.test(st.text), `the objective is on the card (got "${st.text.slice(0, 160)}")`);
    assert.equal(st.steps.length, SCRIPT.steps.length, 'one preview line per step');
    assert.ok(/^Open .*shop\.test\/pricing/.test(st.steps[0]), `the first step is a sentence (got "${st.steps[0]}")`);
    assert.ok(/^Read .*heading/.test(st.steps[1]), `and so is the second (got "${st.steps[1]}")`);
    assert.equal(received.length, 1, 'the provider was called once');
    assert.equal(received[0].auth, `Bearer ${KEY}`, 'with the sealed key');
    assert.ok(/browser script/i.test(received[0].body.messages[0].content), 'and asked for a browser script');
    assert.ok(!st.actions.includes('script-run'), 'running is not offered before the gate');
  });

  await check('the script is a row, and the call is metered under its own purpose', async () => {
    const list = await get('/api/v1/copilot/scripts');
    assert.equal(list.drafts.length, 1, 'one script draft');
    const d = list.drafts[0];
    assert.equal(d.id, scriptId, 'the card is showing that row');
    assert.equal(d.script.objective, SCRIPT.objective, 'with the model’s objective');
    assert.equal(d.script.entryUrl, SCRIPT.entryUrl, 'and the page it opens');
    assert.equal(d.preview.length, SCRIPT.steps.length, 'and the preview the gateway derived');
    const calls = dbm.db.prepare("SELECT * FROM model_calls WHERE purpose='copilot.script'").all();
    assert.equal(calls.length, 1, 'exactly one script call in the ledger');
    assert.ok(d.modelCallId > 0, 'linked to it');
    eqTaskCount(0);
  });

  /* ---------- 3. submit, then refuse an early run ---------- */
  await check('submitting opens a real gate whose evidence is the preview', async () => {
    await clickCard('script-submit');
    const st = await card();
    assert.equal(st.state, 'awaiting-approval', `the card waits (got "${st.state}")`);
    assert.ok(/Waiting for a decision on the Approvals screen/.test(st.text), 'and names where the decision happens');
    const approvals = await get('/api/v1/approvals');
    const gate = approvals.find((a) => a.action === 'browser.script.run');
    assert.ok(gate, 'a real approvals row exists');
    assert.equal(gate.status, 'pending', 'pending');
    assert.ok(/Read the pricing page heading/.test(gate.evidence || '') && /shop\.test\/pricing/.test(gate.evidence || ''),
      `the evidence is the preview (got "${String(gate.evidence).slice(0, 160)}")`);
  });

  await check('running before the gate is decided is refused, in the server’s words', async () => {
    const res = await post(`/api/v1/copilot/scripts/${scriptId}/activate`);
    assert.ok([403, 409].includes(res.status), `refused (${res.status}: ${res.body.error})`);
    assert.ok(/approval/i.test(res.body.error || ''), `and says why (got "${res.body.error}")`);
    eqTaskCount(0);
  });

  /* ---------- 4. a different principal allows it ---------- */
  const made = await post('/api/v1/principals', {
    name: 'reviewer', email: 'reviewer@scriptbrowser.local', role: 'Reviewer', password: 'AnotherPassw0rd!2026', type: 'human',
  });
  assert.ok([200, 201].includes(made.status), `reviewer created (${made.status})`);
  await logout();
  await login('reviewer@scriptbrowser.local', 'AnotherPassw0rd!2026');

  await check('a Reviewer allows the gate', async () => {
    const approvals = await get('/api/v1/approvals');
    const gate = approvals.find((a) => a.action === 'browser.script.run' && a.status === 'pending');
    assert.ok(gate, 'the Reviewer sees the pending gate');
    const allow = await post(`/api/v1/approvals/${gate.id}/allow`);
    assert.equal(allow.status, 200, `allowed (${JSON.stringify(allow.body)})`);
    assert.equal(allow.body.status, 'allowed', 'recorded as allowed');
    const res = await post(`/api/v1/copilot/scripts/${scriptId}/activate`);
    assert.equal(res.status, 403, `the Reviewer holds no browser:run (${JSON.stringify(res.body)})`);
    eqTaskCount(0);
  });

  /* ---------- 5. the Owner runs what someone else allowed ---------- */
  await logout();
  await login('owner@scriptbrowser.local', 'OwnerPassw0rd!2026');
  await go('#/home');
  await openCopilot();
  await sleep(900);

  await check('after a reload the script card is rebuilt from the draft, with its live state', async () => {
    const st = await card();
    assert.ok(st, 'the card came back from the gateway draft');
    assert.equal(st.state, 'awaiting-approval', `with the live state (got "${st.state}")`);
    assert.ok(st.actions.includes('script-run'), 'and running is now offered, because the gate is open');
  });

  await check('running queues exactly one real task, with the criteria the script declared', async () => {
    await clickCard('script-run');
    const st = await card();
    assert.equal(st.state, 'active', `the card is active (got "${st.state}")`);
    const rows = eqTaskCount(1);
    const task = rows[0];
    const who = dbm.db.prepare("SELECT id FROM principals WHERE email='owner@scriptbrowser.local'").get();
    assert.ok(who, 'the owner principal exists');
    assert.equal(task.owner_id, who.id, `owned by the principal who ran it (got "${task.owner_id}")`);
    const criteria = JSON.parse(task.success_criteria || '[]');
    assert.equal(criteria.length, 1, `the criteria were carried through (got ${JSON.stringify(criteria)})`);
    assert.equal(task.objective, SCRIPT.objective, 'with the script’s objective');
    assert.equal(task.status, 'queued', `queued, not finished (got "${task.status}")`);
    assert.equal(task.driver, 'simulated', `the scripted driver, pinned by the test (got "${task.driver}")`);
    assert.equal(st.task, 'queued', 'and the card shows that status, not a prediction');
    assert.ok(/step 0\//.test(st.text), `with the progress the task has, which is none (got "${st.text.slice(-200)}")`);
  });

  await check('a second run is a conflict and queues no second task', async () => {
    const res = await post(`/api/v1/copilot/scripts/${scriptId}/activate`);
    assert.equal(res.status, 409, `conflict (${JSON.stringify(res.body)})`);
    eqTaskCount(1);
  });

  /* ---------- 6. the phone ---------- */
  await check('the script card fits a 320 px screen with 44 px controls and no page errors', async () => {
    await go('#/home');
    await openCopilot();
    await sleep(900);
    await page.setViewport({ width: 320, height: 720, isMobile: true, hasTouch: true });
    await sleep(900);
    const metrics = await page.evaluate(() => {
      const el = document.querySelector('#copilot-panel .cp-script');
      if (!el) return { missing: true };
      const wide = [...el.querySelectorAll('*')]
        .filter((n) => n.getAttribute('aria-hidden') !== 'true')
        .filter((n) => n.getBoundingClientRect().right > 320.5)
        .map((n) => `${n.tagName}.${String(n.className?.baseVal ?? n.className)}`);
      const small = [...el.querySelectorAll('button')]
        .filter((n) => n.offsetParent !== null)
        .map((n) => n.getBoundingClientRect())
        .filter((r) => r.height > 0 && r.height < 43.5);
      return {
        missing: false,
        scrollWidth: document.documentElement.scrollWidth,
        cardWidth: Math.round(el.getBoundingClientRect().width),
        wide,
        small: small.length,
      };
    });
    assert.equal(metrics.missing, false, 'the script card is on screen');
    assert.equal(metrics.scrollWidth <= 320, true, `no sideways scroll on the page (${metrics.scrollWidth})`);
    assert.deepEqual(metrics.wide, [], `nothing in the card passes 320 px (${metrics.wide.join(', ')})`);
    assert.equal(metrics.small, 0, 'every button in the card is at least 44 px tall');
    assert.ok(metrics.cardWidth <= 320, `the card itself fits (${metrics.cardWidth})`);
    assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  });
} catch (error) {
  failures += 1;
  results.push(`FAIL harness: ${error.message}`);
  console.log(`FAIL harness: ${error.message}`);
} finally {
  console.log(results.join('\n'));
  console.log(`\nSCRIPTS BROWSER: ${results.filter((r) => r.startsWith('PASS')).length} passed, ${failures} failed`);
  exitCode = failures > 0 ? 1 : 0;
  try { await browser?.close(); } catch { /* ignore */ }
  try { gateway.server.closeAllConnections?.(); gateway.server.close(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 200));
  try { await vite.close(); } catch { /* ignore */ }
  try { provider.close(); } catch { /* ignore */ }
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(exitCode);
}
