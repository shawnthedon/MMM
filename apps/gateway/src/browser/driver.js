/* ============ Agent Browser — driver contract and registry ============
 * The orchestration (watchdog, retries, loops, checkpoints, evidence) is engine-agnostic. A driver is
 * whatever can actually hold a browser: Puppeteer/Chromium today, a remote CDP endpoint tomorrow.
 *
 * Contract — a driver instance owns exactly one task:
 *
 *   start()                     launch/attach; idempotent
 *   open({ task })              create the session (tab/context)
 *   goto(url, { signal })       → { url, title, status }
 *   waitFor({ selector, text }) → { found }
 *   click(selector, { signal, method })  method: 'pointer' | 'keyboard' | 'dom'
 *   type(selector, text, { signal })
 *   extract({ selector, key })  → { key, value }
 *   snapshot()                  → { url, title, text, digest, elements }
 *   screenshot()                → { base64, digest, bytes }
 *   reload({ signal })
 *   health()                    → { ok, tabs, memoryMB }
 *   close()
 *
 * Every failure is a `BrowserError` with a code the runner can reason about. Drivers must not retry,
 * loop, or decide what "progress" means — that belongs to the runner, in one place, tested once.
 */

import { existsSync } from 'node:fs';

export class BrowserError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'BrowserError';
    this.code = code; // timeout | blocked | session_expired | crash | not_found | no_change | unsupported | limit
    this.detail = detail;
  }
}

export const isBrowserError = (err) => err instanceof BrowserError;

/** Driver metadata is static; availability is measured, never assumed. */
export const DRIVER_CATALOGUE = Object.freeze([
  {
    id: 'puppeteer',
    label: 'Puppeteer / Chromium',
    kind: 'engine',
    summary: 'A real Chromium driven over the DevTools protocol. Runs headless on the gateway host.',
    install: 'npm install puppeteer   # or set MMM_BROWSER_CHROMIUM_PATH to an existing Chromium',
    docs: 'https://pptr.dev/guides/what-is-puppeteer',
  },
  {
    id: 'simulated',
    label: 'Simulated pages (tests only)',
    kind: 'test-only',
    summary:
      'A deterministic fake browser used to prove the watchdog, retry ladder and loop detection without a real engine. Refused unless MMM_BROWSER_ALLOW_SIM=1.',
    install: 'set MMM_BROWSER_ALLOW_SIM=1 (tests only — never in production)',
    docs: 'docs/browser/AGENT_BROWSER.md',
  },
]);

const ALLOW_SIM = () => process.env.MMM_BROWSER_ALLOW_SIM === '1';

/**
 * Which drivers can run here, and why not. The UI renders this verbatim: an unavailable engine is a
 * configuration task for the operator, never a hidden fallback.
 */
export async function driverCapabilities() {
  const out = [];
  for (const meta of DRIVER_CATALOGUE) {
    let available = false;
    let reason = '';
    if (meta.id === 'puppeteer') {
      const probe = await probePuppeteer();
      available = probe.ok;
      reason = probe.reason;
    } else if (meta.id === 'simulated') {
      available = ALLOW_SIM();
      reason = available ? 'enabled by MMM_BROWSER_ALLOW_SIM' : 'test-only driver; set MMM_BROWSER_ALLOW_SIM=1 to enable';
    }
    out.push({ ...meta, available, reason });
  }
  return out;
}

async function probePuppeteer() {
  let puppeteer;
  try {
    puppeteer = await import('puppeteer-core');
  } catch {
    return { ok: false, reason: 'puppeteer-core is not installed on the gateway host' };
  }
  const path = await resolveChromium();
  if (!path) return { ok: false, reason: 'no Chromium binary found (set MMM_BROWSER_CHROMIUM_PATH)' };
  // Availability is measured, not assumed: a configured path that does not exist is not an engine.
  if (!existsSync(path)) return { ok: false, reason: `no Chromium binary at ${path}` };
  return { ok: true, reason: `chromium at ${path}`, puppeteer, path };
}

async function resolveChromium() {
  if (process.env.MMM_BROWSER_CHROMIUM_PATH) return process.env.MMM_BROWSER_CHROMIUM_PATH;
  try {
    const sparticuz = (await import('@sparticuz/chromium')).default;
    return await sparticuz.executablePath();
  } catch {
    /* not a serverless host */
  }
  // Common local installs; the driver also tries puppeteer's own download cache.
  return process.env.CHROME_PATH || '';
}

/** Resolve `auto` to the first driver that can actually run, or explain why none can. */
export async function resolveDriverId(requested = 'auto') {
  const caps = await driverCapabilities();
  if (requested && requested !== 'auto') {
    const found = caps.find((c) => c.id === requested);
    if (!found) return { ok: false, reason: `unknown driver: ${requested}` };
    if (!found.available) return { ok: false, reason: `${found.id} is not available: ${found.reason}` };
    return { ok: true, id: found.id };
  }
  const usable = caps.find((c) => c.available && c.kind === 'engine') || caps.find((c) => c.available);
  if (!usable) {
    return {
      ok: false,
      reason: caps.map((c) => `${c.id}: ${c.reason}`).join('; '),
    };
  }
  return { ok: true, id: usable.id };
}

/** Instantiate a driver for one task. Throws when the engine cannot be used. */
export async function createDriver(id, { task } = {}) {
  if (id === 'puppeteer') {
    const { createPuppeteerDriver } = await import('./drivers/puppeteer.js');
    return createPuppeteerDriver({ task });
  }
  if (id === 'simulated') {
    if (!ALLOW_SIM()) throw new BrowserError('unsupported', 'The simulated driver is test-only (MMM_BROWSER_ALLOW_SIM).');
    const { createSimulatedDriver } = await import('./drivers/simulated.js');
    return createSimulatedDriver({ task });
  }
  throw new BrowserError('unsupported', `unknown driver: ${id}`);
}
