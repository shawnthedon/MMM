/* ============ Puppeteer / Chromium driver ============
 * A real browser. This is the engine the Agent Browser uses in production; it is optional because a
 * Chromium download is a deployment decision, not a source dependency (`puppeteer-core` is imported
 * lazily and a missing install is reported as "not configured", never faked).
 *
 * Deliberate omissions, matching the spec's boundaries:
 *   • no fingerprint spoofing, no user-agent rotation, no stealth patches;
 *   • no CAPTCHA solving, no credential extraction, no paywall or access-control bypass;
 *   • no proxy switching mid-task (a proxy may be configured for the whole session via env).
 * When a site refuses the agent, this driver reports it and the runner stops.
 *
 * Environment:
 *   MMM_BROWSER_CHROMIUM_PATH   absolute path to a Chromium/Chrome binary
 *   MMM_BROWSER_PROXY           optional http(s) proxy, applied for the whole session
 *   MMM_BROWSER_VIEWPORT        390x844 (default, mobile-first like the app)
 */
import { createHash } from 'node:crypto';
import { BrowserError } from '../driver.js';
import { detectBlock } from '../policy.js';

const LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-background-timer-throttling'];

const digest = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 24);

function abortable(promise, signal, label = 'action') {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new BrowserError('timeout', `${label} was aborted by the watchdog`));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new BrowserError('timeout', `${label} was aborted by the watchdog`));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); }
    );
  });
}

const classify = (error) => {
  if (error instanceof BrowserError) return error;
  const message = String(error?.message || error);
  if (/timeout|exceeded/i.test(message)) return new BrowserError('timeout', message);
  if (/not found|no node found|failed to find|waiting for selector/i.test(message)) return new BrowserError('not_found', message);
  if (/detached|target closed|connection closed|protocol error|crash/i.test(message)) return new BrowserError('crash', message);
  return new BrowserError('unsupported', message);
};

async function resolveChromiumRuntime() {
  if (process.env.MMM_BROWSER_CHROMIUM_PATH) {
    return { executablePath: process.env.MMM_BROWSER_CHROMIUM_PATH, args: [], headless: true };
  }
  if (process.env.CHROME_PATH) {
    return { executablePath: process.env.CHROME_PATH, args: [], headless: true };
  }
  try {
    const chromium = (await import('@sparticuz/chromium')).default;
    const executablePath = await chromium.executablePath();
    if (executablePath) {
      return {
        executablePath,
        // Sparticuz supplies the flags required by its compressed serverless Chromium build.
        args: Array.isArray(chromium.args) ? chromium.args : [],
        headless: chromium.headless || 'shell',
      };
    }
  } catch { /* not installed: fall through */ }
  return { executablePath: '', args: [], headless: true }; // use Puppeteer's configured local Chrome resolution
}

export async function createPuppeteerDriver({ task } = {}) {
  let puppeteer;
  try {
    puppeteer = await import('puppeteer-core');
  } catch {
    throw new BrowserError('unsupported', 'puppeteer-core is not installed on the gateway host');
  }
  const chromiumRuntime = await resolveChromiumRuntime();
  const [vw, vh] = String(process.env.MMM_BROWSER_VIEWPORT || '390x844').split('x').map((n) => Number(n) || 0);

  let browser = null;
  let context = null;
  let page = null;
  let closed = false;

  async function launch() {
    if (browser?.connected) return;
    browser = await puppeteer.launch({
      executablePath: chromiumRuntime.executablePath || undefined,
      headless: chromiumRuntime.headless,
      args: [
        ...LAUNCH_ARGS,
        ...chromiumRuntime.args,
        ...(process.env.MMM_BROWSER_PROXY ? [`--proxy-server=${process.env.MMM_BROWSER_PROXY}`] : []),
      ],
    });
    browser.on?.('disconnected', () => { browser = null; page = null; });
    context = await (browser.createBrowserContext?.() || browser.createIncognitoBrowserContext?.() || Promise.resolve(browser.defaultBrowserContext?.() || browser));
    page = await context.newPage?.() ?? await browser.newPage();
    await page.setViewport?.({ width: vw || 390, height: vh || 844, isMobile: true, hasTouch: true });
    page.setDefaultTimeout?.(20000);
    page.setDefaultNavigationTimeout?.(20000);
  }

  const current = () => {
    if (closed) throw new BrowserError('crash', 'the browser session is closed');
    if (!page) throw new BrowserError('crash', 'the browser page disappeared');
    return page;
  };

  return {
    id: 'puppeteer',
    label: 'Puppeteer / Chromium',
    simulated: false,

    async start() {
      closed = false;
      await launch().catch((err) => { throw classify(err); });
    },

    async open() {
      await this.start();
      const p = current();
      await abortable(p.goto(task?.entry_url || 'about:blank', { waitUntil: 'domcontentloaded', timeout: 20000 }), null, 'open');
      return { url: p.url() };
    },

    async goto(url, { signal, step } = {}) {
      const p = current();
      const response = await abortable(
        p.goto(url, { waitUntil: 'domcontentloaded', timeout: step?.timeoutMs || 20000 }),
        signal,
        `navigation to ${url}`
      ).catch((err) => { throw classify(err); });
      const status = response?.status?.() ?? 0;
      const body = await p.evaluate(() => document.body?.innerText?.slice(0, 20000) || '').catch(() => '');
      const block = detectBlock(body, status);
      if (block) throw new BrowserError(status === 401 ? 'session_expired' : 'blocked', `the site refused the agent (${block.kind})`, { kind: block.kind, signal: block.signal, status });
      if (status >= 400) throw new BrowserError(status === 404 ? 'not_found' : 'blocked', `page returned ${status}`, { status });
      return { url: p.url(), title: await p.title(), status };
    },

    async waitFor({ selector, text, timeoutMs } = {}, { signal } = {}) {
      const p = current();
      try {
        if (selector) await abortable(p.waitForSelector(selector, { timeout: timeoutMs || 20000 }), signal, 'waitFor');
        else if (text) await abortable(p.waitForFunction((t) => document.body?.innerText?.includes(t), { timeout: timeoutMs || 20000 }, text), signal, 'waitFor');
        return { found: true };
      } catch (err) {
        throw classify(err);
      }
    },

    async click(selector, { signal, method = 'pointer' } = {}) {
      const p = current();
      try {
        if (method === 'dom' || method === 'keyboard') {
          // Alternate interaction: find by accessible text and activate it with the keyboard/JS.
          const clicked = await p.evaluate((sel) => {
            const nodes = [...document.querySelectorAll('a,button,[role="button"],input[type="submit"]')];
            const target = nodes.find((n) => n.getAttribute('data-ref') === sel || n.textContent?.trim() === sel || n.id === sel);
            if (!target) return false;
            target.focus?.();
            target.click?.();
            return true;
          }, selector);
          if (!clicked) throw new BrowserError('not_found', `no element matching ${selector}`);
        } else {
          await abortable(p.click(selector), signal, 'click');
        }
        return { url: p.url(), changed: true };
      } catch (err) {
        throw classify(err);
      }
    },

    async type(selector, text, { signal } = {}) {
      const p = current();
      try {
        await abortable(p.click(selector), signal, 'type');
        await abortable(p.type(selector, String(text)), signal, 'type');
        return { url: p.url(), changed: true };
      } catch (err) {
        throw classify(err);
      }
    },

    async extract({ selector, key } = {}) {
      const p = current();
      try {
        const value = selector
          ? await p.$eval(selector, (el) => el.textContent?.trim() || el.value || '')
          : await p.evaluate(() => document.body?.innerText?.slice(0, 4000) || '');
        return { key: key || 'text', value: String(value).slice(0, 4000), url: p.url() };
      } catch (err) {
        throw classify(err);
      }
    },

    async snapshot() {
      const p = current();
      let elements = [];
      try {
        elements = await p.evaluate(() =>
          [...document.querySelectorAll('a,button,input,[role="button"],[role="link"]')]
            .slice(0, 60)
            .map((el) => ({
              ref: el.getAttribute('data-ref') || el.id || el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 40),
              role: el.getAttribute('role') || el.tagName.toLowerCase(),
              name: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().slice(0, 80),
            }))
        );
      } catch { /* a page may forbid DOM access mid-navigation */ }
      const url = p.url();
      const title = await p.title().catch(() => '');
      const text = await p.evaluate(() => document.body?.innerText?.slice(0, 8000) || '').catch(() => '');
      return { url, title, text, digest: digest(`${url}|${title}|${text}`), elements };
    },

    async screenshot() {
      const p = current();
      try {
        const base64 = await p.screenshot({ type: 'png', encoding: 'base64', captureBeyondViewport: false });
        return { base64, digest: digest(base64.slice(0, 4096)), bytes: Math.round((base64.length * 3) / 4) };
      } catch (err) {
        throw classify(err);
      }
    },

    async reload({ signal } = {}) {
      const p = current();
      try {
        await abortable(p.reload({ waitUntil: 'domcontentloaded' }), signal, 'reload');
        return { url: p.url() };
      } catch (err) {
        throw classify(err);
      }
    },

    async health() {
      if (!browser?.connected) return { ok: false, tabs: 0, memoryMB: 0, crashed: true };
      let tabs = 0;
      let memoryMB = 0;
      try {
        const pages = await browser.pages();
        tabs = pages.length;
        const metrics = await page?.metrics?.();
        if (metrics?.JSHeapUsedSize) memoryMB = Math.round(metrics.JSHeapUsedSize / (1024 * 1024));
      } catch { /* metrics are best-effort */ }
      return { ok: true, tabs, memoryMB };
    },

    async close() {
      closed = true;
      try { await context?.close?.(); } catch { /* ignore */ }
      try { await browser?.close?.(); } catch { /* ignore */ }
      browser = null;
      page = null;
    },
  };
}
