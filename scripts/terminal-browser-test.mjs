/* Terminal in a real Chromium — the Definition of Done, end to end.
 * Run: npm run test:terminal:browser
 * Optional deps: npm install --no-save puppeteer-core @sparticuz/chromium
 *
 * The happy-dom suite can prove the client posts the right thing. Only a browser with the real
 * gateway behind it can prove the claim that matters: a person opens the screen, types `npm install`,
 * watches the install arrive line by line, and then runs that project's own script in the same
 * terminal. Everything below is a real process on this machine — no fixture replies.
 *
 * The gateway runs in this process on the port Vite's dev proxy expects, so the page talks to it
 * same-origin through `/api`, exactly as it does under `npm run dev`.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';

const DATA_DIR = '/tmp/mmm-terminal-browser';
rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
process.env.DATA_DIR = DATA_DIR;
process.env.MMM_QUIET = '1';
process.env.MMM_BOOTSTRAP_EMAIL = 'owner@mmm.local';
process.env.MMM_BOOTSTRAP_PASSWORD = 'OwnerPassw0rd!2026';

const PORT = 8787;
let chromium;
let puppeteer;
try {
  chromium = (await import('@sparticuz/chromium')).default;
  puppeteer = (await import('puppeteer-core')).default;
} catch {
  console.log('SKIP terminal browser: install puppeteer-core and @sparticuz/chromium (npm i --no-save --ignore-scripts puppeteer-core @sparticuz/chromium)');
  process.exit(0);
}

const { createGateway } = await import('../apps/gateway/server.js');
const gateway = createGateway();
await new Promise((resolve) => gateway.server.listen(PORT, '127.0.0.1', resolve));

const vite = await createServer({ logLevel: 'silent', server: { port: 0 }, clearScreen: false });
await vite.listen();
const base = `http://127.0.0.1:${vite.httpServer.address().port}`;

const results = [];
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    results.push(`PASS ${name}`);
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    results.push(`FAIL ${name}: ${error.message}`);
    console.log(`FAIL ${name}: ${error.message}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
let page;
const screenText = () => page.evaluate(() => {
  const el = document.getElementById('term-screen');
  return el ? el.textContent : '';
});
const waitForText = async (pattern, timeout = 90000) => {
  const started = Date.now();
  for (;;) {
    const text = await screenText();
    if (pattern.test(text)) return text;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${pattern} — screen ended with “${text.slice(-400).replace(/\s+/g, ' ')}”`);
    await sleep(250);
  }
};
const type = async (line) => {
  await page.click('#term-input');
  await page.type('#term-input', line);
  await page.evaluate(() => {
    document.getElementById('term-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
};

try {
  browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    executablePath: process.env.MMM_CHROMIUM_PATH || await chromium.executablePath(),
    headless: true,
  });
  page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

  // The app's own way of choosing a gateway: '/' means same origin, which the dev proxy forwards.
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('mmm.gateway', '/'); } catch { /* ignore */ }
  });
  // With a gateway configured the app gates every screen behind sign-in, so sign in through the
  // app's own form — that is what sets the CSRF token the mutating routes require — then open the
  // terminal the way a person would.
  await page.goto(`${base}/#/login`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#login-form');
  await page.type('#login-email', 'owner@mmm.local');
  await page.type('#login-password', 'OwnerPassw0rd!2026');
  await Promise.all([page.click('#login-submit'), page.waitForFunction(() => !document.getElementById('login-form'), { timeout: 20000 })]);
  await page.evaluate(() => { window.location.hash = '#/terminal'; });
  await page.waitForSelector('#term-screen');
  await sleep(1200);

  await check('the screen opens against the real gateway and says so', async () => {
    const state = await page.$eval('[data-term-state]', (el) => el.dataset.termState);
    assert.notEqual(state, 'offline', `state should be live, got ${state}`);
    const cwd = await page.$eval('[data-term-cwd]', (el) => el.textContent.replace(/\s+/g, ' ').trim());
    assert.ok(/default/.test(cwd), `the workspace is shown (got “${cwd}”)`);
    const text = await screenText();
    assert.ok(/real processes/i.test(text), 'the banner states what this terminal is');
    assert.deepEqual(pageErrors, [], `no page errors (${pageErrors.join('; ')})`);
  });

  const runBar = async () => {
    await page.waitForSelector('[data-term-runbar]', { timeout: 15000 });
    return page.$eval('[data-term-runbar]', (el) => ({ status: el.dataset.status, text: el.textContent.replace(/\s+/g, ' ').trim() }));
  };
  const settled = async (timeout = 60000) => {
    const started = Date.now();
    for (;;) {
      const bar = await page.$eval('[data-term-runbar]', (el) => el.dataset.status).catch(() => null);
      if (['completed', 'failed', 'cancelled', 'timed_out'].includes(bar)) return bar;
      if (Date.now() - started > timeout) throw new Error(`the run never settled (bar: ${bar})`);
      await sleep(250);
    }
  };

  await check('AT-1/AT-2 `node --version` and `npm --version` run for real', async () => {
    await type('node --version');
    const text = await waitForText(/v\d+\.\d+\.\d+/);
    assert.ok(text.includes(process.version), `the output is this host's Node (${process.version})`);
    const bar = await runBar();
    assert.equal(bar.status, 'completed', `the run bar reports completion (got ${bar.status}: ${bar.text})`);
    assert.ok(/exit 0/.test(bar.text), `and the exit code (got “${bar.text}”)`);

    await type('npm --version');
    await waitForText(/10\.\d+\.\d+/);
    assert.equal(await settled(), 'completed', 'npm reports a version and completes');
  });

  await check('the working directory is a real folder in the workspace', async () => {
    await type('node -e "console.log(process.cwd())"');
    await sleep(1500);
    const text = await screenText();
    const match = text.match(/\/tmp\/mmm-terminal-browser\/workspaces\/[^\s"\\]+/);
    assert.ok(match, `the child's cwd is printed and inside the workspace (screen: ${text.slice(-200)})`);
    assert.ok(existsSync(match[0]), `that directory exists (${match[0]})`);
  });

  let projectDir = join(DATA_DIR, 'workspaces', 'default');
  await check('the app opened a session inside a workspace, not the repository', async () => {
    const info = await page.evaluate(async () => {
      const res = await fetch('/api/v1/terminal/sessions', { credentials: 'include' });
      return res.json();
    });
    const live = info.sessions?.[0];
    assert.ok(live?.cwdPath, `the first command opened a session (got ${JSON.stringify(info)})`);
    assert.ok(live.cwdPath.startsWith(DATA_DIR), `it runs inside the sandbox (${live.cwdPath})`);
    assert.ok(!live.cwdPath.startsWith('/home/user/MMM'), 'and never inside the gateway’s own checkout');
    projectDir = live.cwdPath;
  });

  await check('AT-3 `npm init -y` creates a real package.json on disk', async () => {
    await type('npm init -y');
    await waitForText(/package\.json/, 60000).catch(async (error) => {
      throw new Error(`${error.message} (cwd ${projectDir})`);
    });
    await sleep(800);
    assert.ok(existsSync(join(projectDir, 'package.json')), `package.json exists on disk in ${projectDir}`);
    if (existsSync(join(projectDir, 'package.json'))) {
      const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'));
      assert.equal(pkg.version, '1.0.0', 'it is npm’s own file, not a fixture');
    }
  });

  // A real script, written to the real project, so `npm run` has something true to list and run.
  const pkgPath = join(projectDir, 'package.json');
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : { name: 'mmm-terminal-demo', version: '1.0.0' };
  pkg.name = 'mmm-terminal-demo';
  pkg.scripts = { greet: 'node greet.mjs', tick: 'node tick.mjs' };
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(join(projectDir, 'greet.mjs'), "console.log('hello from the project');\n");
  writeFileSync(join(projectDir, 'tick.mjs'), "console.log('ticking');\nsetInterval(() => console.log('tick'), 400);\n");

  await check('AT-6 `npm run` lists the project’s own scripts', async () => {
    await type('npm run');
    const text = await waitForText(/greet/);
    assert.ok(/greet/.test(text) && /tick/.test(text), 'both real scripts are listed');
    // and the same scripts appear as chips, read from package.json rather than hard-coded
    const chips = await page.$$eval('[data-act="term-script"]', (els) => els.map((e) => e.dataset.name));
    assert.ok(chips.includes('greet') && chips.includes('tick'), `chips: ${chips.join(',')}`);
  });

  await check('AT-7 a project script runs and prints its real output', async () => {
    await type('npm run greet');
    await waitForText(/hello from the project/);
    await sleep(800);
    const bar = await page.$eval('[data-term-runbar]', (el) => el.dataset.status);
    assert.equal(bar, 'completed', `the script completed (bar: ${bar})`);
  });

  await check('a script chip runs the same script from the screen', async () => {
    const chip = await page.$('[data-act="term-script"][data-name="greet"]');
    assert.ok(chip, 'the greet chip is on screen');
    await chip.click();
    await sleep(2500);
    const text = await screenText();
    const occurrences = (text.match(/hello from the project/g) || []).length;
    assert.ok(occurrences >= 2, `the script ran again from the chip (${occurrences} runs)`);
  });

  await check('AT-9 an interrupt stops a long-running process for real', async () => {
    await type('npm run tick');
    await waitForText(/ticking/);
    await sleep(1500);
    assert.equal(await page.$eval('[data-term-runbar]', (el) => el.dataset.status), 'running', 'the run bar shows it is live');
    await page.click('[data-act="term-interrupt"]');
    await waitForText(/sent SIGINT|SIGINT/i, 20000);
    await sleep(2500);
    const text = await screenText();
    const ticks = (text.match(/"tick"/g) || []).length + (text.match(/\btick\b/g) || []).length;
    const frozen = text;
    await sleep(1500);
    assert.equal(await screenText(), frozen, 'no more output after the interrupt — the process is gone');
    const bar = await page.$eval('[data-term-runbar]', (el) => el.dataset.status);
    assert.ok(['cancelled', 'failed', 'completed'].includes(bar), `the bar settles after interrupt (got ${bar})`);
    assert.ok(ticks > 0, 'the process really was printing');
    // and Ctrl+C from the prompt must reach the same place
    await type('npm run tick');
    await sleep(2000);
    await page.click('#term-input');
    await page.evaluate(() => {
      document.getElementById('term-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }));
    });
    await sleep(2500);
    const afterCtrlC = await page.$eval('[data-term-runbar]', (el) => el.dataset.status);
    assert.ok(['cancelled', 'failed', 'completed'].includes(afterCtrlC), `Ctrl+C settles the run too (got ${afterCtrlC})`);
  });

  await check('AT-4 `npm install express` installs into the project when the registry answers', async () => {
    const probe = await new Promise((resolve) => {
      import('node:child_process').then(({ execFile }) => {
        execFile('npm', ['view', 'express', 'version', '--silent'], { timeout: 60000 }, (error, stdout) => {
          resolve(error ? null : stdout.trim());
        });
      });
    });
    if (!probe) {
      results.push('SKIP AT-4 registry unreachable in this environment — no install is claimed');
      return;
    }
    await type('npm install express');
    await waitForText(/added \d+ package/i, 240000);
    await sleep(1000);
    assert.ok(existsSync(join(projectDir, 'node_modules', 'express', 'index.js')), 'express is on disk');
    const manifest = JSON.parse(readFileSync(pkgPath, 'utf8'));
    assert.ok(manifest.dependencies?.express, 'package.json records the dependency');
    const bar = await page.$eval('[data-term-runbar]', (el) => el.dataset.status);
    assert.equal(bar, 'completed', `the install completed (bar: ${bar})`);
  });

  await check('the dependency is really loadable from that project', async () => {
    await type('node -e "import(\'express\').then(m => console.log(\'express\', typeof m.default))"');
    await waitForText(/express (function|object)/, 30000);
  });

  await check('the transcript survives leaving the screen and coming back', async () => {
    const before = await screenText();
    assert.ok(before.length > 200, 'there is a transcript worth keeping');
    await page.evaluate(() => { window.location.hash = '#/home'; });
    await page.waitForSelector('#view .home-grid, #view .home', { timeout: 15000 }).catch(() => {});
    await sleep(600);
    await page.evaluate(() => { window.location.hash = '#/terminal'; });
    await page.waitForSelector('#term-screen');
    await sleep(800);
    const after = await screenText();
    assert.ok(after.includes('hello from the project'), 'the previous runs are still on screen');
    assert.ok(after.length >= before.length - 5, 'nothing was dropped');
  });

  await check('a shell command is refused in the browser, with the reason on screen', async () => {
    await type('rm -rf /');
    await sleep(1500);
    const text = await screenText();
    assert.ok(/not an allowed executable/i.test(text), `the refusal is shown (got “${text.slice(-200)}”)`);
    assert.ok(existsSync(join(projectDir, 'package.json')), 'and nothing was deleted');
  });

  await check('the terminal left no orphaned process behind', async () => {
    const { execFileSync } = await import('node:child_process');
    const ps = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' });
    assert.ok(!/tick\.mjs/.test(ps), 'tick.mjs is not still running');
  });

  await check('no page errors were raised during the whole session', async () => {
    assert.deepEqual(pageErrors, [], pageErrors.join('; '));
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
console.log(`\nTERMINAL BROWSER: ${passed} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
