/* Copilot agent drafts in a real Chromium, against a real gateway and a real provider.
 * Run: npm run test:drafts:browser
 * Optional deps: npm install --no-save --ignore-scripts puppeteer-core @sparticuz/chromium
 *
 * The loop a person performs: ask for an agent in the Copilot, read the draft card, submit it, try to
 * activate it before the gate is decided (refused), have a *different* principal allow it, then activate
 * it — and find exactly one idle agent on the gateway and no run anywhere.
 */
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'vite';

const DATA_DIR = `/tmp/mmm-drafts-browser-${process.pid}`;
rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;
process.env.MMM_QUIET = '1';
process.env.MMM_SECRET = 'browser-test-secret-material-that-is-long-enough-1234';
process.env.MMM_BOOTSTRAP_EMAIL = 'owner@drafts.local';
process.env.MMM_BOOTSTRAP_PASSWORD = 'OwnerPassw0rd!2026';

let chromium;
let puppeteer;
try {
  chromium = (await import('@sparticuz/chromium')).default;
  puppeteer = (await import('puppeteer-core')).default;
} catch {
  console.log('SKIP drafts browser: install puppeteer-core and @sparticuz/chromium');
  process.exit(0);
}

/* ---------- a real provider that answers in JSON ---------- */
const KEY = 'sk-drafts-browser-0123456789';
const DRAFT = {
  name: 'Ticket Triage',
  role: 'triages inbound support tickets',
  description: 'Sorts and labels inbound support mail.',
  goal: 'Label and route every inbound support ticket within a minute.',
  framework: 'LangGraph',
  model: 'gpt-4o-mini',
  autonomy: 2,
  preset: 'review-first',
  limits: { steps: 10, minutes: 5, costUsd: 1 },
  gates: { enabled: true, expiry: '30d' },
  skills: [],
  plugins: [],
  interaction: ['text'],
  responsibilities: ['label the ticket', 'route it'],
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
      choices: [{ index: 0, message: { role: 'assistant', content: '```json\n' + JSON.stringify(DRAFT) + '\n```' } }],
      usage: { prompt_tokens: 320, completion_tokens: 140, total_tokens: 460 },
    }));
  });
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
const providerBase = `http://127.0.0.1:${provider.address().port}/v1`;

const PORT = 8787; // vite.config proxies /api, /healthz and /ws here
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

  const logout = async () => {
    await page.evaluate(async () => {
      const { csrfToken } = await (await fetch('/api/v1/auth/session', { credentials: 'include' })).json();
      await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'include', headers: { 'x-mmm-csrf': csrfToken || '' } });
    });
    await sleep(300);
  };
  const login = async (email, password) => {
    // A full reload, not a hash change: the panel's in-memory session must be gone too, or the router
    // would send an "authenticated" boot straight past the login screen.
    await page.goto(`${base}/#/login`);
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('#login-form');
    await page.type('#login-email', email);
    await page.type('#login-password', password);
    try {
      await Promise.all([page.click('#login-submit'), page.waitForFunction(() => !document.getElementById('login-form'), { timeout: 20000 })]);
    } catch (error) {
      const body = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400));
      throw new Error(`login as ${email} did not complete (${error.message}); page says: ${body}`);
    }
    await sleep(600);
  };
  await page.goto(`${base}/#/login`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#login-form');
  await page.type('#login-email', 'owner@drafts.local');
  await page.type('#login-password', 'OwnerPassw0rd!2026');
  await Promise.all([page.click('#login-submit'), page.waitForFunction(() => !document.getElementById('login-form'), { timeout: 20000 })]);
  await sleep(600);

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
  const cardState = () => page.evaluate(() => {
    const el = document.getElementById('copilot-panel')?.querySelector('.cp-draft');
    if (!el) return null;
    return {
      id: el.getAttribute('data-draft-id'),
      state: el.getAttribute('data-draft-state'),
      text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
      actions: [...el.querySelectorAll('[data-cp^="draft-"]')].map((b) => b.getAttribute('data-cp')),
    };
  });

  /* ---------- 1. seal a key on the Models screen ---------- */
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

  /* ---------- 2. ask for an agent ---------- */
  await go('#/home');
  await openCopilot();
  await check('“create an agent that …” produces a draft card in a real browser', async () => {
    await say('Create an agent that triages inbound support tickets');
    const st = await cardState();
    assert.ok(st, 'a draft card is rendered');
    assert.equal(st.state, 'ready-for-review', `the validator’s state is shown (got "${st.state}")`);
    assert.ok(/Ticket Triage/.test(st.text), `the name is on the card (got "${st.text.slice(0, 160)}")`);
    assert.ok(/No runtime adapter/.test(st.text), 'and the blocking fact that it cannot run');
    assert.equal(received.length, 1, 'the provider was called once');
    assert.equal(received[0].auth, `Bearer ${KEY}`, 'with the sealed key');
    assert.ok(/JSON only/.test(received[0].body.messages[0].content), 'and asked for JSON only');
    assert.ok(!st.actions.includes('draft-activate'), 'activation is not offered before the gate');
  });

  /* ---------- 3. the draft is a row, not a picture ---------- */
  let draftId = '';
  await check('the draft exists in the gateway with its validator findings', async () => {
    const list = await get('/api/v1/copilot/drafts');
    assert.equal(list.drafts.length, 1, 'one draft');
    const d = list.drafts[0];
    draftId = d.id;
    assert.equal(d.spec.name, 'Ticket Triage', 'with the model’s name');
    assert.equal(d.state, 'ready-for-review', 'and the validator’s state');
    assert.ok(d.findings.some((f) => f.severity === 'blocked'), 'including the blocked runtime finding');
    assert.ok(d.modelCallId > 0, 'linked to the metered call');
    const calls = dbm.db.prepare("SELECT * FROM model_calls WHERE purpose='copilot.draft'").all();
    assert.equal(calls.length, 1, 'exactly one draft call in the ledger');
  });

  /* ---------- 4. submit, then refuse activation ---------- */
  await check('submitting moves the card to awaiting approval and creates a real gate', async () => {
    await page.evaluate(() => document.querySelector('[data-cp="draft-submit"]')?.click());
    await sleep(1200);
    const st = await cardState();
    assert.equal(st.state, 'awaiting-approval', `the card waits (got "${st.state}")`);
    assert.ok(/Waiting for a decision on the Approvals screen/.test(st.text), 'and names where the decision happens');
    const approvals = await get('/api/v1/approvals');
    const gate = approvals.find((a) => a.action === 'agent.draft.activate');
    assert.ok(gate, 'a real approvals row exists');
    assert.equal(gate.status, 'pending', 'pending');
    assert.equal(approvals.length >= 1, true, 'it is on the same list the Approvals screen reads');
  });

  await check('activation before the gate is decided is refused, in the server’s words', async () => {
    await page.evaluate(() => document.querySelector('[data-cp="draft-activate"]')?.click());
    await sleep(1400);
    const st = await cardState();
    assert.ok(/still pending/i.test(st.text), `the refusal is rendered (got "${st.text.slice(-200)}")`);
    assert.equal(st.state, 'awaiting-approval', 'and the state did not move');
    const agents = await get('/api/v1/agents');
    assert.equal(agents.filter((a) => a.name === 'Ticket Triage').length, 0, 'no agent was created');
  });

  /* ---------- 5. a different principal allows it ---------- */
  const ownerSession = await page.evaluate(async () => {
    const csrf = (await (await fetch('/api/v1/auth/session', { credentials: 'include' })).json()).csrfToken;
    const res = await fetch('/api/v1/principals', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-mmm-csrf': csrf },
      body: JSON.stringify({ name: 'reviewer', email: 'reviewer@drafts.local', role: 'Reviewer', password: 'AnotherPassw0rd!2026', type: 'human' }),
    });
    return res.status;
  });
  assert.ok([200, 201].includes(ownerSession), `reviewer created (${ownerSession})`);

  await logout();
  await login('reviewer@drafts.local', 'AnotherPassw0rd!2026');

  await check('the gate shows up for a Reviewer and allowing it is recorded', async () => {
    const approvals = await get('/api/v1/approvals');
    const gate = approvals.find((a) => a.action === 'agent.draft.activate' && a.status === 'pending');
    assert.ok(gate, 'the Reviewer sees the pending gate');
    assert.ok(/Ticket Triage/.test(gate.evidence || ''), `with the draft named in the evidence (got "${gate.evidence}")`);
    const allow = await post(`/api/v1/approvals/${gate.id}/allow`);
    assert.equal(allow.status, 200, `allowed (${JSON.stringify(allow.body)})`);
    assert.equal(allow.body.status, 'allowed', 'recorded as allowed');
  });

  await check('a Reviewer cannot activate it — the role that decides holds no agent:write', async () => {
    assert.ok(draftId, 'the draft id is known');
    const res = await post(`/api/v1/copilot/drafts/${draftId}/activate`);
    assert.equal(res.status, 403, `refused (${JSON.stringify(res.body)})`);
  });

  /* ---------- 6. the Owner activates ---------- */
  await logout();
  await login('owner@drafts.local', 'OwnerPassw0rd!2026');
  await go('#/home');
  await openCopilot();
  await sleep(900);

  await check('after a reload the card is rebuilt from the draft, with its live state', async () => {
    const st = await cardState();
    assert.ok(st, 'the card came back from the gateway draft');
    assert.equal(st.state, 'awaiting-approval', `with the live state (got "${st.state}")`);
    assert.ok(st.actions.includes('draft-activate'), 'and activation is now offered to the Owner');
  });

  await check('activating creates exactly one idle agent and marks the draft active', async () => {
    await page.evaluate(() => document.querySelector('[data-cp="draft-activate"]')?.click());
    await sleep(1800);
    const st = await cardState();
    assert.equal(st.state, 'active', `the card is active (got "${st.state}")`);
    assert.ok(/idle agent/i.test(st.text), 'and says an idle definition was created');
    const agents = await get('/api/v1/agents');
    const mine = agents.filter((a) => a.name === 'Ticket Triage');
    assert.equal(mine.length, 1, 'exactly one agent');
    assert.equal(mine[0].status, 'idle', 'and it is idle — nothing started');
    assert.equal(mine[0].approval_gates?.draft, true, 'marked as coming from a draft');
    // Nothing anywhere records a run of this agent.
    const events = await get('/api/v1/events?cursor=0');
    const list = Array.isArray(events) ? events : events.events || [];
    assert(!list.some((e) => /running|deployed/i.test(String(e.text || ''))), 'no event claims it ran');
  });

  await check('the second activation click cannot create a second agent', async () => {
    const before = (await get('/api/v1/agents')).filter((a) => a.name === 'Ticket Triage').length;
    const res = await post(`/api/v1/copilot/drafts/${draftId}/activate`);
    assert.equal(res.status, 409, 'conflict');
    assert.equal((await get('/api/v1/agents')).filter((a) => a.name === 'Ticket Triage').length, before, 'still one agent');
  });

  /* ---------- 7. the phone ---------- */
  await check('the draft card fits a 320 px screen with 44 px controls and no page errors', async () => {
    await page.setViewport({ width: 320, height: 720, isMobile: true, hasTouch: true });
    await sleep(900);
    const metrics = await page.evaluate(() => {
      // Scoped to the card: the composer's context tray is a deliberately scrollable row, and measuring
      // it would say "overflow" about something that is meant to scroll. The card itself must fit.
      const card = document.querySelector('#copilot-panel .cp-draft');
      if (!card) return { missing: true };
      const wide = [...card.querySelectorAll('*')]
        .filter((el) => el.getAttribute('aria-hidden') !== 'true')
        .filter((el) => el.getBoundingClientRect().right > 320.5)
        .map((el) => `${el.tagName}.${String(el.className.baseVal ?? el.className)}`);
      const small = [...card.querySelectorAll('button')]
        .filter((el) => el.offsetParent !== null)
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.height > 0 && r.height < 43.5);
      const tray = document.querySelector('#copilot-panel .cp-tray') || document.querySelector('#copilot-panel .cp-composer');
      return {
        missing: false,
        scrollWidth: document.documentElement.scrollWidth,
        cardWidth: Math.round(card.getBoundingClientRect().width),
        wide,
        small: small.length,
        trayScrolls: tray ? getComputedStyle(tray).overflowX !== 'visible' : true,
      };
    });
    assert.equal(metrics.missing, false, 'the card is still on screen');
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
  console.log(`\nDRAFTS BROWSER: ${results.filter((r) => r.startsWith('PASS')).length} passed, ${failures} failed`);
  exitCode = failures > 0 ? 1 : 0;
  try { await browser?.close(); } catch { /* ignore */ }
  try { gateway.server.closeAllConnections?.(); gateway.server.close(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 200));
  try { await vite.close(); } catch { /* ignore */ }
  try { provider.close(); } catch { /* ignore */ }
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(exitCode);
}
