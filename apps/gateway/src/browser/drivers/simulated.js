/* ============ Simulated browser driver — TESTS ONLY ============
 * A deterministic stand-in for a browser, used to prove the parts of the agent that must be correct
 * *before* an engine is wired: stall detection, the retry ladder, loop detection, checkpoint/resume,
 * deadline handling, block reporting and honest completion.
 *
 * It is not a mock of a provider and it is never selected in production: `driver.js` refuses to
 * construct it unless MMM_BROWSER_ALLOW_SIM=1, and the gateway UI labels any task that used it as
 * simulated. A task executed here can never be described as a real browsing session.
 *
 * Script shape (stored in `browser_tasks.sim`):
 * {
 *   pages: {
 *     "https://shop.test/": {
 *       title: "Catalogue", status: 200, text: "Widgets",
 *       elements: [{ ref: "next", role: "link", name: "Next", text: "Next", href: "https://shop.test/2" }]
 *     }
 *   },
 *   faults: { s2: "timeout" | "blocked:captcha" | "blocked:login" | "crash" | "nochange" | "expired" | "notfound" },
 *   faultMode: "once" | "always",   // default "once"
 *   stalledNav: ["https://slow.test/"]  // goto never settles for these URLs
 * }
 */
import { BrowserError } from '../driver.js';

const enc = (value) => new TextEncoder().encode(String(value));
const digestOf = async (text) => {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const buf = await subtle.digest('SHA-256', enc(text));
    return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h).toString(16).padStart(12, '0');
};

// A 1×1 transparent PNG — enough to prove that a screenshot artefact exists and is stored.
const PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const abortable = (signal) =>
  new Promise((_, reject) => {
    if (signal?.aborted) return reject(new BrowserError('timeout', 'the action was aborted by the watchdog'));
    signal?.addEventListener('abort', () => reject(new BrowserError('timeout', 'the action was aborted by the watchdog')), { once: true });
  });

export function createSimulatedDriver({ task } = {}) {
  const sim = (() => {
    try { return JSON.parse(task?.sim || '{}'); } catch { return {}; }
  })();
  const pages = sim.pages || {};
  const faults = sim.faults || {};
  const faultMode = sim.faultMode || 'once';
  const consumed = new Set();
  let currentUrl = task?.entry_url || Object.keys(pages)[0] || 'about:blank';
  let started = false;
  let crashed = false;
  const log = [];

  const page = (url) => pages[url] || { title: 'Not found', status: 404, text: `No page ${url}`, elements: [] };

  function takeFault(step) {
    const id = step?.id;
    if (!id || !faults[id]) return null;
    if (faultMode === 'once' && consumed.has(id)) return null;
    consumed.add(id);
    const raw = String(faults[id]);
    const [kind, arg] = raw.split(':');
    return { kind, arg };
  }

  function raise(fault) {
    switch (fault.kind) {
      case 'timeout':
        return new Promise(() => {}); // never settles: only the watchdog can end this
      case 'crash':
        crashed = true;
        throw new BrowserError('crash', 'the browser process disappeared');
      case 'blocked':
        throw new BrowserError('blocked', `the site refused the agent (${fault.arg || 'restriction'})`, { kind: fault.arg || 'restriction' });
      case 'expired':
        throw new BrowserError('session_expired', 'the signed-in session expired');
      case 'notfound':
        throw new BrowserError('not_found', 'the target element was not found');
      case 'nochange':
        throw new BrowserError('no_change', 'the action completed but nothing on the page changed');
      default:
        return null;
    }
  }

  const guard = async (signal) => {
    if (crashed) throw new BrowserError('crash', 'the browser process disappeared');
    if (signal?.aborted) throw new BrowserError('timeout', 'the action was aborted by the watchdog');
  };

  return {
    id: 'simulated',
    label: 'Simulated pages (tests only)',
    simulated: true,

    async start() {
      started = true;
      crashed = false;
    },

    async open() {
      if (!started) await this.start();
      return { url: currentUrl };
    },

    async goto(url, { signal, step } = {}) {
      await guard(signal);
      const fault = takeFault(step);
      if (fault) {
        const pending = raise(fault);
        if (pending) return Promise.race([pending, abortable(signal)]);
      }
      if ((sim.stalledNav || []).includes(url)) {
        // A navigation that never completes — the watchdog must end it.
        return Promise.race([new Promise(() => {}), abortable(signal)]);
      }
      const target = page(url);
      if (target.status >= 400) {
        throw new BrowserError(target.status === 404 ? 'not_found' : 'blocked', `page returned ${target.status}`, { status: target.status });
      }
      currentUrl = url;
      log.push(`goto ${url}`);
      return { url, title: target.title, status: target.status };
    },

    async waitFor({ selector, text } = {}) {
      const current = page(currentUrl);
      const found = selector
        ? (current.elements || []).some((e) => e.ref === selector || e.name === selector)
        : String(current.text || '').includes(text || '');
      if (!found) throw new BrowserError('not_found', `waited for ${selector || text} and it never appeared`);
      return { found: true };
    },

    async click(selector, { signal, step } = {}) {
      await guard(signal);
      const fault = takeFault(step);
      if (fault) {
        const pending = raise(fault);
        if (pending) return Promise.race([pending, abortable(signal)]);
      }
      const current = page(currentUrl);
      const el = (current.elements || []).find((e) => e.ref === selector || e.name === selector);
      if (!el) throw new BrowserError('not_found', `no element matching ${selector}`);
      if (el.href) {
        currentUrl = el.href;
        const next = page(currentUrl);
        return { url: currentUrl, title: next.title, changed: true };
      }
      // An element with no destination: nothing changed, which the loop detector must notice.
      return { url: currentUrl, change: false, changed: false };
    },

    async type(selector, text, { signal, step } = {}) {
      await guard(signal);
      const fault = takeFault(step);
      if (fault) {
        const pending = raise(fault);
        if (pending) return Promise.race([pending, abortable(signal)]);
      }
      const current = page(currentUrl);
      const el = (current.elements || []).find((e) => e.ref === selector || e.name === selector);
      if (!el) throw new BrowserError('not_found', `no field matching ${selector}`);
      el.value = String(text);
      return { url: currentUrl, changed: true };
    },

    async extract({ selector, key } = {}) {
      const current = page(currentUrl);
      const el = selector ? (current.elements || []).find((e) => e.ref === selector || e.name === selector) : null;
      const value = el ? (el.text ?? el.value ?? el.name ?? '') : String(current.text || '');
      return { key: key || 'text', value, url: currentUrl };
    },

    async snapshot() {
      const current = page(currentUrl);
      const text = String(current.text || '');
      return {
        url: currentUrl,
        title: current.title || '',
        text,
        digest: await digestOf(`${currentUrl}|${current.title}|${text}|${(current.elements || []).length}`),
        elements: (current.elements || []).map((e) => ({ ref: e.ref, role: e.role, name: e.name })),
      };
    },

    async screenshot({ signal } = {}) {
      await guard(signal);
      return { base64: PIXEL_PNG, digest: await digestOf(`shot|${currentUrl}`), bytes: Math.round((PIXEL_PNG.length * 3) / 4) };
    },

    async reload({ signal } = {}) {
      await guard(signal);
      return { url: currentUrl };
    },

    async health() {
      return { ok: started && !crashed, tabs: 1, memoryMB: 42, crashed };
    },

    async close() {
      started = false;
      return { closed: true };
    },
  };
}
