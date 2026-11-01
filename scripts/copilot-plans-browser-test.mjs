/* Copilot swarm-plan drafts in a real Chromium, against a real gateway and a real provider.
 * Run: npm run test:plans:browser
 * Optional deps: npm install --no-save --ignore-scripts puppeteer-core @sparticuz/chromium
 *
 * The loop a person performs: ask for a workflow in the Copilot, read the plan card, submit it, try to save
 * it before the gate is decided (refused), have a *different* principal allow it, then save it — and find
 * exactly one `swarms` row that is `planned`, unexecuted, with zero progress and zero spend, and no run
 * anywhere.
 */
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'vite';

const DATA_DIR = `/tmp/mmm-plans-browser-${process.pid}`;
rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;
process.env.MMM_QUIET = '1';
process.env.MMM_SECRET = 'browser-test-secret-material-that-is-long-enough-1234';
process.env.MMM_BOOTSTRAP_EMAIL = 'owner@planbrowser.local';
process.env.MMM_BOOTSTRAP_PASSWORD = 'OwnerPassw0rd!2026';

let puppeteer;
try {
  await import('@sparticuz/chromium');
  puppeteer = (await import('puppeteer-core')).default;
} catch {
  console.log('SKIP plans browser: install puppeteer-core and @sparticuz/chromium');
  process.exit(0);
}

/* ---------- a real provider that answers with a plan ---------- */
const KEY = 'sk-plans-browser-0123456789';
const PLAN = {
  name: 'Weekly Brief',
  objective: 'Research this week’s AI news and draft a one-page brief for the team.',
  channel: 'app',
  topology: 'Hierarchical',
  budgetCap: 6,
  nodes: [
    { id: 'n1', label: 'planner' },
    { id: 'n2', label: 'research-a' },
    { id: 'n3', label: 'analyze' },
    { id: 'n4', label: 'writer' },
  ],
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
      choices: [{ index: 0, message: { role: 'assistant', content: '```json\n' + JSON.stringify(PLAN) + '\n```' } }],
      usage: { prompt_tokens: 300, completion_tokens: 120, total_tokens: 420 },
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

  await login('owner@planbrowser.local', 'OwnerPassw0rd!2026');

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
    const el = document.getElementById('copilot-panel')?.querySelector('.cp-plan');
    if (!el) return null;
    return {
      id: el.getAttribute('data-plan-id'),
      state: el.getAttribute('data-plan-state'),
      text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
      actions: [...el.querySelectorAll('[data-cp^="plan-"]')].map((b) => b.getAttribute('data-cp')),
    };
  });
  const clickCard = async (act) => {
    await page.evaluate((a) => {
      document.getElementById('copilot-panel')?.querySelector(`[data-cp="${a}"]`)?.click();
    }, act);
    await sleep(1400);
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

  /* ---------- 2. ask for a workflow ---------- */
  await go('#/home');
  await openCopilot();
  let planDraftId = '';
  await check('“draft a plan that …” produces a plan card in a real browser', async () => {
    await say('Draft a plan that researches this week’s AI news and writes a brief');
    const st = await card();
    assert.ok(st, 'a plan card is rendered');
    planDraftId = st.id;
    assert.equal(st.state, 'ready-for-review', `the validator’s state is shown (got "${st.state}")`);
    assert.ok(/Weekly Brief/.test(st.text), `the plan’s name is on the card (got "${st.text.slice(0, 160)}")`);
    assert.ok(/4 nodes/.test(st.text), 'the node count is on the card');
    assert.ok(/Nothing executes this plan/.test(st.text), 'and the blocking fact that nothing runs it');
    assert.equal(received.length, 1, 'the provider was called once');
    assert.equal(received[0].auth, `Bearer ${KEY}`, 'with the sealed key');
    assert.ok(/swarm PLAN/.test(received[0].body.messages[0].content), 'and asked for a plan');
    assert.ok(!st.actions.includes('plan-save'), 'saving is not offered before the gate');
  });

  await check('the plan draft is a row, and the call is metered under its own purpose', async () => {
    const list = await get('/api/v1/copilot/plans');
    assert.equal(list.drafts.length, 1, 'one plan draft');
    const d = list.drafts[0];
    assert.equal(d.plan.objective, PLAN.objective, 'with the model’s objective');
    assert.equal(d.plan.budgetCap, 6, 'and its cap');
    assert.equal(d.state, 'ready-for-review', 'and the validator’s state');
    assert.ok(d.findings.some((f) => f.severity === 'blocked'), 'including the blocked execution finding');
    const calls = dbm.db.prepare("SELECT * FROM model_calls WHERE purpose='copilot.plan'").all();
    assert.equal(calls.length, 1, 'exactly one plan call in the ledger');
    assert.ok(d.modelCallId > 0, 'linked to it');
  });

  /* ---------- 3. submit, then refuse an early save ---------- */
  await check('submitting opens a real gate that the Approvals screen can decide', async () => {
    await clickCard('plan-submit');
    const st = await card();
    assert.equal(st.state, 'awaiting-approval', `the card waits (got "${st.state}")`);
    assert.ok(/Waiting for a decision on the Approvals screen/.test(st.text), 'and names where the decision happens');
    const approvals = await get('/api/v1/approvals');
    const gate = approvals.find((a) => a.action === 'swarm.plan.save');
    assert.ok(gate, 'a real approvals row exists');
    assert.equal(gate.status, 'pending', 'pending');
    assert.ok(/starts nothing/.test(gate.evidence || ''), `the evidence says nothing starts (got "${gate.evidence}")`);
  });

  await check('saving before the gate is decided is refused, in the server’s words', async () => {
    await clickCard('plan-save');
    const st = await card();
    assert.ok(/still pending/i.test(st.text), `the refusal is rendered (got "${st.text.slice(-220)}")`);
    assert.equal(st.state, 'awaiting-approval', 'and the state did not move');
    const swarms = await get('/api/v1/swarms');
    assert.equal(swarms.swarms.filter((s) => s.name === 'Weekly Brief').length, 0, 'no swarm was saved');
  });

  /* ---------- 4. a different principal decides ---------- */
  const made = await post('/api/v1/principals', {
    name: 'reviewer', email: 'reviewer@planbrowser.local', role: 'Reviewer', password: 'AnotherPassw0rd!2026', type: 'human',
  });
  assert.ok([200, 201].includes(made.status), `reviewer created (${made.status})`);
  await logout();
  await login('reviewer@planbrowser.local', 'AnotherPassw0rd!2026');

  await check('the Reviewer allows the gate and still cannot save the plan', async () => {
    const approvals = await get('/api/v1/approvals');
    const gate = approvals.find((a) => a.action === 'swarm.plan.save' && a.status === 'pending');
    assert.ok(gate, 'the Reviewer sees the pending gate');
    const allow = await post(`/api/v1/approvals/${gate.id}/allow`);
    assert.equal(allow.status, 200, `allowed (${JSON.stringify(allow.body)})`);
    assert.equal(allow.body.status, 'allowed', 'recorded as allowed');
    const res = await post(`/api/v1/copilot/plans/${planDraftId}/activate`);
    assert.equal(res.status, 403, `the decider holds no swarm:write (${JSON.stringify(res.body)})`);
  });

  /* ---------- 5. the Owner saves it ---------- */
  await logout();
  await login('owner@planbrowser.local', 'OwnerPassw0rd!2026');
  await go('#/home');
  await openCopilot();
  await sleep(900);

  await check('after a reload the plan card is rebuilt from the draft, with its live state', async () => {
    const st = await card();
    assert.ok(st, 'the card came back from the gateway draft');
    assert.equal(st.state, 'awaiting-approval', `with the live state (got "${st.state}")`);
    assert.ok(st.actions.includes('plan-save'), 'and saving is now offered');
  });

  await check('saving stores exactly one planned swarm — no progress, no spend, no run', async () => {
    await clickCard('plan-save');
    const st = await card();
    assert.equal(st.state, 'active', `the card is active (got "${st.state}")`);
    assert.ok(/zero progress and zero spend/.test(st.text), 'and says what was stored');
    const swarms = await get('/api/v1/swarms');
    const mine = swarms.swarms.filter((s) => s.name === 'Weekly Brief');
    assert.equal(mine.length, 1, 'exactly one swarm');
    const swarm = mine[0];
    assert.equal(swarm.status, 'planned', 'status planned');
    assert.equal(swarm.executed, false, 'executed false');
    assert.equal(swarm.progress, 0, 'progress 0');
    assert.equal(swarm.budget.spent, 0, 'spend 0');
    assert.equal(swarm.nodes.length, 4, 'with the four nodes the draft carried');
    assert.ok(swarm.nodes.every((n) => n.status === 'planned'), 'every node planned');
    assert.equal(swarm.runtime.scheduler, false, 'and the payload says no scheduler exists');
    const events = await get('/api/v1/events?cursor=0');
    const list = Array.isArray(events) ? events : events.events || [];
    assert(!list.some((e) => /swarm/i.test(String(e.text || '')) && /(running|started|executing|completed)/i.test(String(e.text || ''))),
      'no event claims the swarm ran');
  });

  await check('the Swarms screen shows the plan, labelled as not executed', async () => {
    await go('#/teams'); // the Swarms screen's route is `teams` (Teams & Swarms)
    await sleep(1200);
    // Scoped to the row for this plan: the screen legitimately uses the word "live" about other things
    // (gateway connection, seeded fixtures). What must not happen is *this row* claiming a run.
    const row = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('#view *')].filter((n) => /Weekly Brief/.test(n.textContent || '') && n.children.length <= 3);
      const el = nodes.at(-1)?.closest('.card, .row, li, tbody tr, article, section') || nodes.at(-1);
      return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
    });
    assert(/Weekly Brief/.test(row), `the plan row is on the screen (got "${row.slice(0, 200)}")`);
    assert(/planned|not executed/i.test(row), `and it is labelled as a plan (got "${row.slice(0, 200)}")`);
    assert(!/running|in progress|\blive\b/i.test(row), `the row does not claim a run (got "${row.slice(0, 200)}")`);
  });

  await check('a second save is a conflict and cannot create a second swarm', async () => {
    const res = await post(`/api/v1/copilot/plans/${planDraftId}/activate`);
    assert.equal(res.status, 409, 'conflict');
    const swarms = await get('/api/v1/swarms');
    assert.equal(swarms.swarms.filter((s) => s.name === 'Weekly Brief').length, 1, 'still one swarm');
  });

  /* ---------- 6. the phone ---------- */
  await check('the plan card fits a 320 px screen with 44 px controls and no page errors', async () => {
    await go('#/home');
    await openCopilot();
    await sleep(700);
    await page.setViewport({ width: 320, height: 720, isMobile: true, hasTouch: true });
    await sleep(900);
    const metrics = await page.evaluate(() => {
      const el = document.querySelector('#copilot-panel .cp-plan');
      if (!el) return { missing: true };
      const wide = [...el.querySelectorAll('*')]
        .filter((n) => n.getAttribute('aria-hidden') !== 'true')
        .filter((n) => n.getBoundingClientRect().right > 320.5)
        .map((n) => `${n.tagName}.${String(n.className.baseVal ?? n.className)}`);
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
    assert.equal(metrics.missing, false, 'the plan card is on screen');
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
  console.log(`\nPLANS BROWSER: ${results.filter((r) => r.startsWith('PASS')).length} passed, ${failures} failed`);
  exitCode = failures > 0 ? 1 : 0;
  try { await browser?.close(); } catch { /* ignore */ }
  try { gateway.server.closeAllConnections?.(); gateway.server.close(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 200));
  try { await vite.close(); } catch { /* ignore */ }
  try { provider.close(); } catch { /* ignore */ }
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(exitCode);
}
