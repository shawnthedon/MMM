/* Local voice input in real Chromium, with a real microphone device and a real speech host.
 * Run: npm run test:voice-input:browser
 * Optional deps: npm install --no-save --ignore-scripts puppeteer-core @sparticuz/chromium
 *
 * Chromium's fake capture device (`--use-fake-device-for-media-stream`) is a real MediaStream: the panel
 * records it with a real MediaRecorder, produces real WebM/Opus bytes, and posts them to the gateway. The
 * gateway forwards them to a speech host on loopback — a small HTTP server in this test that speaks the
 * documented contract. Nothing here is stubbed on the app side; the only fake is the audio itself, and the
 * assertions are about bytes that actually arrived and a transcript that actually came back.
 *
 * The loop: an Owner adds the host from Voice Studio, checks it, opens the Copilot, allows local voice
 * input, records two seconds, stops — and finds an editable transcript in the composer, nothing sent, and
 * no transcript stored anywhere on the gateway.
 */
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'vite';

const DATA_DIR = `/tmp/mmm-voice-browser-${process.pid}`;
rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;
process.env.MMM_QUIET = '1';
process.env.MMM_SECRET = 'browser-test-secret-material-that-is-long-enough-1234';
process.env.MMM_BOOTSTRAP_EMAIL = 'owner@voicebrowser.local';
process.env.MMM_BOOTSTRAP_PASSWORD = 'OwnerPassw0rd!2026';

let puppeteer;
try {
  await import('@sparticuz/chromium');
  puppeteer = (await import('puppeteer-core')).default;
} catch {
  console.log('SKIP voice browser: install puppeteer-core and @sparticuz/chromium');
  process.exit(0);
}

/* ---------- a speech host that speaks the documented contract ---------- */
const host = { requests: [], text: 'what is on my board today' };
const speech = createHttpServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  host.requests.push({ url: req.url, method: req.method, contentType: req.headers['content-type'] || '', bytes: body.length, body });
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', engine: 'whisper.cpp', model: 'ggml-base.en' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ text: host.text }));
});
await new Promise((r) => speech.listen(0, '127.0.0.1', r));
const HOST = `http://127.0.0.1:${speech.address().port}`;

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
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      // A synthetic microphone, and permission granted without a prompt — the browser behaviour under test
      // is the recording pipeline, not the permission dialog.
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    ],
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
    await Promise.all([page.click('#login-submit'), page.waitForFunction(() => !document.getElementById('login-form'), { timeout: 20000 })]);
    await sleep(600);
  };
  await login('owner@voicebrowser.local', 'OwnerPassw0rd!2026');

  const go = async (hash) => {
    await page.evaluate((h) => { window.location.hash = h; }, hash);
    await sleep(800);
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

  /* ---------- 1. the operator adds a host from the screen ---------- */
  await check('the Owner adds a speech host from Voice Studio and sees it come back reachable', async () => {
    await go('#/voice');
    await sleep(700);
    await page.evaluate(() => {
      [...document.querySelectorAll('[data-act="voice-tab"]')].find((b) => /diagnostics/i.test(b.textContent))?.click();
    });
    await sleep(900);
    const before = await page.evaluate(() => document.body.innerText.includes('No speech host is configured'));
    assert.equal(before, true, 'the empty state names what is missing');
    await page.evaluate((url) => {
      const el = document.getElementById('vs-host-url');
      el.value = url;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('vs-host-label').value = 'Test whisper';
    }, HOST);
    await page.evaluate(() => document.querySelector('[data-act="voice-host-add"]')?.click());
    await sleep(1800);
    const list = await get('/api/v1/voice/endpoints');
    assert.equal(list.endpoints.length, 1, 'the host is a row on the gateway');
    assert.equal(list.endpoints[0].remote, false, 'recorded as local');
    assert.equal(list.endpoints[0].lastStatus, 'available', `the automatic check found it (${list.endpoints[0].lastStatus})`);
    const shown = await page.evaluate(() => document.body.innerText);
    assert.ok(/Test whisper/.test(shown), 'the row is on the screen');
    assert.ok(/reachable/i.test(shown), 'with the health status the gateway measured');
  });

  await check('a non-loopback host is refused, with a reason the operator can act on', async () => {
    const direct = await page.evaluate(async (url) => {
      const csrf = (await (await fetch('/api/v1/auth/session', { credentials: 'include' })).json()).csrfToken;
      const r = await fetch('/api/v1/voice/endpoints', {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-mmm-csrf': csrf },
        body: JSON.stringify({ kind: 'stt', engine: 'whisper.cpp', url }),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    }, 'https://speech.example.com');
    assert.equal(direct.status, 400, `refused (${direct.status}: ${JSON.stringify(direct.body).slice(0, 160)})`);
    assert.ok(/loopback/i.test(direct.body.error || ''), `and says why (${direct.body.error})`);
    const list = await get('/api/v1/voice/endpoints');
    assert.equal(list.endpoints.length, 1, 'nothing was stored');
  });

  /* ---------- 2. the mic records for real ---------- */
  await check('the Copilot records a real clip, transcribes it on the host, and leaves it unsent', async () => {
    await go('#/home');
    await page.evaluate(() => document.querySelector('[data-act="copilot-open"]')?.click());
    await sleep(900);
    await page.evaluate(() => document.getElementById('copilot-panel')?.querySelector('[data-cp="toggle-advanced"]')?.click());
    await sleep(300);

    const support = await page.evaluate(async () => {
      const mod = await import('/src/voice/capture.js');
      return mod.captureSupport(window);
    });
    assert.equal(support.ok, true, `this browser can record (${support.reason})`);

    host.requests.length = 0;
    await page.evaluate(() => document.getElementById('copilot-panel')?.querySelector('.cp-mic')?.click());
    await sleep(300);
    const consent = await page.evaluate(() => {
      const card = document.getElementById('copilot-panel')?.querySelector('.cp-consent');
      return card ? { kind: card.getAttribute('data-consent'), text: (card.textContent || '').replace(/\s+/g, ' ').trim() } : null;
    });
    assert.ok(consent, 'a consent card is shown before the microphone opens');
    assert.equal(consent.kind, 'local', 'and it is the local one, because a host is configured');
    assert.ok(/gateway/i.test(consent.text), `it names the gateway (${consent.text})`);

    await page.evaluate(() => document.getElementById('copilot-panel')?.querySelector('[data-cp="voice-consent-allow"]')?.click());
    await sleep(1600);
    const recording = await page.evaluate(() => {
      const el = document.getElementById('cp-voice-status');
      return el ? el.textContent : '';
    });
    assert.ok(/Recording/i.test(recording), `the status says it is recording (${recording})`);

    await page.evaluate(() => document.getElementById('copilot-panel')?.querySelector('.cp-mic')?.click());
    await sleep(2600);

    const status = await page.evaluate(() => document.getElementById('cp-voice-status')?.textContent || '');
    assert.ok(/review it, then send/i.test(status), `the transcript is reported as ready to review (${status})`);
    const value = await page.evaluate(() => document.getElementById('copilot-input')?.value || '');
    assert.equal(value, host.text, `the transcript is in the composer (${value})`);
    assert.equal(host.requests.length, 1, 'the host was called exactly once');
    const sent = host.requests[0];
    assert.equal(sent.url, '/inference', 'at the path whisper.cpp documents');
    assert.ok(/^multipart\/form-data/.test(sent.contentType), `as multipart (${sent.contentType})`);
    assert.ok(sent.bytes > 1000, `with a real recording in it (${sent.bytes} bytes)`);
    const tasks = await get('/api/v1/copilot');
    assert.equal((tasks.messages || []).length, 0, 'nothing was sent to the Copilot');
  });

  await check('the audio and the transcript are not stored on the gateway', async () => {
    const tables = dbm.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    for (const table of tables) {
      const cols = dbm.db.prepare(`PRAGMA table_info(${table})`).all().filter((c) => /TEXT|CHAR|CLOB/i.test(c.type || '')).map((c) => c.name);
      if (!cols.length) continue;
      for (const row of dbm.db.prepare(`SELECT ${cols.join(',')} FROM ${table}`).all()) {
        for (const [col, value] of Object.entries(row)) {
          if (typeof value !== 'string') continue;
          assert.ok(!value.includes(host.text), `${table}.${col} holds the transcript`);
        }
      }
    }
    const audits = dbm.db.prepare("SELECT * FROM audit_log WHERE event='voice.transcribe'").all();
    assert.ok(audits.length >= 1, 'the transcription is audited');
    assert.ok(!audits.at(-1).args_redacted.includes(host.text), 'and the audit does not hold the words');
    assert.ok(/"bytes"/.test(audits.at(-1).args_redacted), 'only the shape of the request');
  });

  /* ---------- 3. the phone ---------- */
  await check('the voice dock and the host card fit 320 px with 44 px controls and no page errors', async () => {
    await page.setViewport({ width: 320, height: 720, isMobile: true, hasTouch: true });
    await sleep(600);
    const dock = await page.evaluate(() => {
      const el = document.getElementById('copilot-panel')?.querySelector('#cp-voice-dock');
      if (!el) return { missing: true };
      const wide = [...el.querySelectorAll('*')]
        .filter((n) => n.getBoundingClientRect().right > 320.5)
        .map((n) => `${n.tagName}.${String(n.className?.baseVal ?? n.className)}`);
      const small = [...el.querySelectorAll('button')]
        .filter((n) => n.offsetParent !== null)
        .map((n) => n.getBoundingClientRect())
        .filter((r) => r.height > 0 && r.height < 43.5).length;
      return { missing: false, wide, small, scrollWidth: document.documentElement.scrollWidth };
    });
    assert.equal(dock.missing, false, 'the dock is on screen');
    assert.deepEqual(dock.wide, [], `nothing in the dock passes 320 px (${dock.wide.join(', ')})`);
    assert.equal(dock.small, 0, 'every control is at least 44 px tall');
    assert.ok(dock.scrollWidth <= 320, `no sideways scroll (${dock.scrollWidth})`);

    await go('#/voice');
    await sleep(700);
    await page.evaluate(() => {
      [...document.querySelectorAll('[data-act="voice-tab"]')].find((b) => /diagnostics/i.test(b.textContent))?.click();
    });
    await sleep(900);
    const card = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.vs-host')][0];
      if (!el) return { missing: true };
      const wide = [...el.querySelectorAll('*')].filter((n) => n.getBoundingClientRect().right > 320.5).map((n) => n.tagName);
      const small = [...el.querySelectorAll('button')].map((n) => n.getBoundingClientRect()).filter((r) => r.height > 0 && r.height < 43.5).length;
      return { missing: false, wide, small, scrollWidth: document.documentElement.scrollWidth };
    });
    assert.equal(card.missing, false, 'the host row is on screen');
    assert.deepEqual(card.wide, [], `nothing in the host row passes 320 px (${card.wide.join(', ')})`);
    assert.equal(card.small, 0, 'its buttons are at least 44 px tall');
    assert.ok(card.scrollWidth <= 320, `no sideways scroll on the screen (${card.scrollWidth})`);
    assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  });
} catch (error) {
  failures += 1;
  results.push(`FAIL harness: ${error.message}`);
  console.log(`FAIL harness: ${error.message}`);
} finally {
  console.log(results.join('\n'));
  console.log(`\nVOICE INPUT BROWSER: ${results.filter((r) => r.startsWith('PASS')).length} passed, ${failures} failed`);
  exitCode = failures > 0 ? 1 : 0;
  try { await browser?.close(); } catch { /* ignore */ }
  try { gateway.server.closeAllConnections?.(); gateway.server.close(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 200));
  try { await vite.close(); } catch { /* ignore */ }
  try { speech.close(); } catch { /* ignore */ }
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(exitCode);
}
