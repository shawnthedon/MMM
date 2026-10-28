/* Local AI preflight. The experimental runtime lives on a separate spike page; this
 * screen reports device capabilities and never claims the production feature is complete. */
import { esc, icon, now } from './core.js';
import { views } from './views1.js';
import { toast, on } from './shell.js';
import './local.css';

export const SPEC_VERSION = '1.0';

/* ---------- capability probes ---------- */
const GB = 1024 ** 3;

/** Minimal but valid WebAssembly module using a v128 instruction (the standard SIMD sniff). */
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
  10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

/**
 * Measure what this browser/runtime can actually do.
 * Every probe is defensive: a throw becomes `unknown`, never a crash and never a fake `true`.
 */
export async function detectCapabilities(env = {}) {
  const nav = env.navigator ?? (typeof navigator !== 'undefined' ? navigator : {});
  const win = env.window ?? (typeof window !== 'undefined' ? window : {});
  const caps = {
    checkedAt: Date.now(),
    secureContext: null,
    wasm: null,
    wasmSimd: null,
    threads: null,
    crossOriginIsolated: null,
    webgpu: null,
    webgpuAdapter: null,
    opfs: null,
    serviceWorker: null,
    persistentStorage: null,
    storage: null,
    deviceMemoryGb: null,
    cores: null,
  };

  const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };

  // tri-state: `true`/`false` when the platform reports it, `null` when it does not
  caps.secureContext = safe(() => (typeof win.isSecureContext === 'boolean' ? win.isSecureContext : null), null);
  caps.wasm = safe(() => typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function', false);
  caps.wasmSimd = safe(() => (caps.wasm ? WebAssembly.validate(SIMD_PROBE) : false), false);
  caps.crossOriginIsolated = safe(() => win.crossOriginIsolated === true, false);
  caps.threads = safe(() => typeof SharedArrayBuffer === 'function' && caps.crossOriginIsolated === true, false);

  // WebGPU: presence + a real adapter request. No adapter means no GPU path on this device.
  caps.webgpu = safe(() => Boolean(nav.gpu && typeof nav.gpu.requestAdapter === 'function'), false);
  if (caps.webgpu) {
    caps.webgpuAdapter = await safe(async () => {
      const adapter = await nav.gpu.requestAdapter();
      if (!adapter) return null;
      const info = safe(() => adapter.info || null, null);
      return {
        vendor: info?.vendor || null,
        architecture: info?.architecture || null,
        device: info?.device || null,
        description: info?.description || null,
      };
    }, null);
    if (caps.webgpuAdapter && typeof caps.webgpuAdapter.then === 'function') caps.webgpuAdapter = await caps.webgpuAdapter;
  }

  caps.opfs = safe(() => Boolean(nav.storage && typeof nav.storage.getDirectory === 'function'), false);
  caps.serviceWorker = safe(() => Boolean(nav.serviceWorker || win.navigator?.serviceWorker), false);
  caps.deviceMemoryGb = safe(() => (typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null), null);
  caps.cores = safe(() => (typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null), null);

  if (nav.storage && typeof nav.storage.estimate === 'function') {
    const est = await safe(async () => nav.storage.estimate(), null);
    if (est && typeof est.quota === 'number') {
      caps.storage = {
        quotaBytes: est.quota,
        usageBytes: est.usage || 0,
        freeBytes: Math.max(0, est.quota - (est.usage || 0)),
      };
    } else {
      caps.storage = null;
    }
    caps.persistentStorage = await safe(async () => (typeof nav.storage.persisted === 'function' ? await nav.storage.persisted() : null), null);
  } else {
    caps.storage = null;
  }

  return caps;
}

/**
 * Turn measurements into an honest verdict.
 * The verdict describes the *platform*, never the feature: the feature does not exist yet.
 */
export function assess(caps = {}) {
  const blockers = [];
  const cautions = [];
  const positives = [];

  if (caps.secureContext === false) blockers.push('Not a secure context — WASM workers, storage APIs and WebGPU are unavailable. Serve the app over HTTPS (or localhost).');
  if (caps.wasm === false) blockers.push('WebAssembly is unavailable, so no GGUF runtime can exist on this platform.');
  if (caps.storage && caps.storage.freeBytes < 1 * GB) {
    cautions.push(`Only ${formatBytes(caps.storage.freeBytes)} of storage headroom is visible to the app. A 1–2 GB quantization will not fit; small models (135M–0.5B, Q4) may.`);
  } else if (!caps.storage) {
    cautions.push('Storage quota could not be measured — the browser refused or does not implement `navigator.storage.estimate()`.');
  }
  if (caps.threads === false) {
    cautions.push('Threads are off: `SharedArrayBuffer` needs cross-origin isolation (COOP/COEP). Inference would run single-threaded and slower.');
  }
  if (caps.wasmSimd === false) cautions.push('WASM SIMD is missing — token generation would be substantially slower.');
  if (caps.webgpu && caps.webgpuAdapter) positives.push(`WebGPU adapter detected${caps.webgpuAdapter.vendor ? ` (${caps.webgpuAdapter.vendor}${caps.webgpuAdapter.architecture ? ` ${caps.webgpuAdapter.architecture}` : ''})` : ''} — a GPU backend is plausible.`);
  else if (caps.webgpu) cautions.push('WebGPU is present but no adapter was returned — assume CPU-only.');
  else cautions.push('WebGPU is unavailable — CPU/WASM only.');
  if (caps.opfs) positives.push('Origin Private File System is available, so weights can live in managed app storage instead of `localStorage`.');
  else cautions.push('OPFS is unavailable: weights would have to live in IndexedDB, which is slower for multi-GB files.');
  if (caps.deviceMemoryGb) {
    if (caps.deviceMemoryGb <= 2) cautions.push(`The browser reports ~${caps.deviceMemoryGb} GB RAM. Expect only the smallest quantizations to load; measure before promising anything.`);
    else positives.push(`The browser reports ~${caps.deviceMemoryGb} GB RAM and ${caps.cores ?? 'an unknown number of'} cores.`);
  }

  const status = blockers.length ? 'blocked' : cautions.length ? 'constrained' : 'spike-ready';
  return { status, blockers, cautions, positives };
}

export const STATUS_COPY = {
  blocked: { label: 'Blocked on this platform', chip: 'bad', detail: 'Local inference cannot run here without changing platform (see the blockers).' },
  constrained: { label: 'Possible, with limits', chip: 'warn', detail: 'The platform can host a small GGUF runtime, but expect slow generation and tight memory.' },
  'spike-ready': { label: 'Ready for a runtime spike', chip: 'ok', detail: 'This only describes platform capabilities; the runtime spike has not passed its real-device gate.' },
};

const formatBytes = (bytes) => {
  const n = Number(bytes) || 0;
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
};

/* ---------- spec content (kept as data so it is easy to audit against the document) ---------- */
export const PHASES = [
  { id: 1, title: 'Audit', detail: 'Inspect MMM docs, code, platform, build/test and persistence; report before coding.', status: 'this screen' },
  { id: 2, title: 'Runtime spike', detail: 'Import, load and query a minimal GGUF model offline on intended hardware; record licence, build, memory, speed.', status: 'in progress' },
  { id: 3, title: 'Model manager', detail: 'Import, catalogue, downloads with real progress, validation, recovery, lifecycle states.', status: 'not started' },
  { id: 4, title: 'Offline text', detail: 'Streaming, cancellation, local history, airplane-mode and privacy tests.', status: 'not started' },
  { id: 5, title: 'Image feasibility', detail: 'Compare mobile-capable image pipelines on real hardware; record speed, memory, heat, quality.', status: 'not started' },
  { id: 6, title: 'Image feature', detail: 'Prompt, five ratios, progress/cancel, viewer, gallery, export — only if phase 5 passes.', status: 'not started' },
];

export const PRESETS = [
  { name: 'SmolLM2 135M', note: 'Hugging Face · verify licence and exact GGUF', size: '~0.1 GB at Q4' },
  { name: 'SmolLM2 360M', note: 'Hugging Face · verify licence and exact GGUF', size: '~0.25 GB at Q4' },
  { name: 'Qwen2.5 0.5B Instruct', note: 'Apache-2.0 claimed upstream · verify per file', size: '~0.35 GB at Q4' },
  { name: 'Llama 3.2 1B Instruct', note: 'Llama licence · gated download', size: '~0.8 GB at Q4' },
  { name: 'Llama 3.2 3B Instruct', note: 'Llama licence · gated download', size: '~2 GB at Q4' },
  { name: 'DeepSeek-R1-Distill-Qwen-1.5B', note: 'MIT claimed upstream · verify per file', size: '~1 GB at Q4' },
];

/* ---------- render ---------- */
const row = (label, value, chip = '', hint = '') => `
  <div class="local-row">
    <span class="local-row-k">${esc(label)}</span>
    <span class="local-row-v">
      ${chip ? `<span class="chip tiny ${chip}">${esc(value)}</span>` : `<span class="strong small">${esc(value)}</span>`}
      ${hint ? `<span class="tiny muted">${esc(hint)}</span>` : ''}
    </span>
  </div>`;

views.local = {
  title: 'Local AI',
  render() {
    return `
      <div class="page-head">
        <h1>Local AI</h1>
        <div class="sub">On-device GGUF models · spec v${SPEC_VERSION} · phase 1 preflight</div>
      </div>

      <div class="banner warn" style="margin-bottom:12px">
        ${icon('shield', 16)}
        <div><strong>Production local AI is not implemented.</strong> No model is bundled or downloaded.
        This screen only measures device capabilities; an experimental runtime spike is separate and
        has not passed its real-device gate. There is no cloud fallback.</div>
      </div>

      <div class="card" id="local-preflight">
        <div class="row between">
          <div class="strong small">${icon('cpu', 15)} Platform preflight</div>
          <button class="btn sm" data-act="local-rescan">${icon('search', 14)} Re-measure</button>
        </div>
        <div class="tiny muted" style="margin-top:6px">Run in your browser, on the device you would use. Measurements update live.</div>
        <div id="local-caps" class="local-caps">
          <div class="tiny muted" style="padding:10px 0">Measuring…</div>
        </div>
      </div>

      <div class="section-title">What is deliberately absent</div>
      <div class="card">
        ${row('Model files', 'none bundled', 'warn', 'The build ships no weights and no tokenizer.')}
        ${row('Downloads', 'not implemented', 'warn', 'No catalogue fetch, no partial-file recovery, no background notifications.')}
        ${row('Production inference', 'not implemented', 'warn', 'Only a separate experimental GGUF spike exists; device validation is pending.')}
        ${row('Image generation', 'not implemented', 'warn', 'Feasibility (phase 5) has not been run on this hardware.')}
        ${row('Cloud fallback', 'never', 'ok', 'The spec forbids a silent fallback; there is nothing to fall back to.')}
      </div>

      <div class="section-title">Phase plan (§12)</div>
      <div class="card">
        ${PHASES.map((p) => `
          <div class="local-phase ${p.status === 'this screen' ? 'current' : ''}">
            <span class="local-phase-n">${p.id}</span>
            <div class="grow">
              <div class="small strong">${esc(p.title)}
                <span class="chip tiny ${p.status === 'this screen' ? 'brand' : ''}">${esc(p.status)}</span>
              </div>
              <div class="tiny muted">${esc(p.detail)}</div>
            </div>
          </div>`).join('')}
      </div>

      <div class="section-title">Candidate presets (§7) — unverified</div>
      <div class="card">
        <div class="tiny muted" style="margin-bottom:6px">These are candidates from the specification, not
        verified files. Sizes are rough Q4 estimates, not measurements, and memory use varies with
        quantization, context and device.</div>
        ${PRESETS.map((m) => `
          <div class="local-row">
            <span class="local-row-k mono">${esc(m.name)}</span>
            <span class="local-row-v">
              <span class="tiny muted">${esc(m.note)}</span>
              <span class="chip tiny">${esc(m.size)}</span>
            </span>
          </div>`).join('')}
      </div>

      <div class="section-title">Privacy (§9)</div>
      <div class="card">
        <div class="tiny muted">When this ships: prompts, responses, model files and images stay on the
        device during local inference; the only network traffic is an explicit catalogue refresh or model
        download, which this screen will label before it starts. Nothing is logged to analytics by default.</div>
      </div>

      <div class="banner info" style="margin-top:14px">
        ${icon('doc', 16)}
        <div>Phase 2 is an experimental offline runtime spike, not a finished feature. It needs your own
        compatible GGUF and a real-device measurement run. <a class="btn" href="./local-spike.html">Open experimental spike</a></div>
      </div>`;
  },
  async mount() {
    await paintCaps();
  },
};

async function paintCaps() {
  const host = typeof document !== 'undefined' ? document.getElementById('local-caps') : null;
  if (!host) return null;
  host.innerHTML = '<div class="tiny muted" style="padding:10px 0">Measuring…</div>';
  const caps = await detectCapabilities();
  const verdict = assess(caps);
  const copy = STATUS_COPY[verdict.status];
  host.innerHTML = `
    <div class="local-verdict">
      <span class="chip ${copy.chip}">${esc(copy.label)}</span>
      <span class="tiny muted">${esc(copy.detail)}</span>
    </div>
    ${row('Secure context', caps.secureContext ? 'yes' : 'no', caps.secureContext ? 'ok' : 'bad', 'HTTPS or localhost')}
    ${row('WebAssembly', caps.wasm ? 'available' : 'missing', caps.wasm ? 'ok' : 'bad', 'required for any GGUF runtime')}
    ${row('WASM SIMD', caps.wasmSimd ? 'available' : 'missing', caps.wasmSimd ? 'ok' : 'warn', 'vector math for token generation')}
    ${row('Threads (SharedArrayBuffer)', caps.threads ? 'available' : 'off', caps.threads ? 'ok' : 'warn', caps.crossOriginIsolated ? 'cross-origin isolated' : 'needs COOP/COEP headers')}
    ${row('WebGPU', caps.webgpu ? (caps.webgpuAdapter ? 'adapter found' : 'no adapter') : 'unavailable', caps.webgpuAdapter ? 'ok' : 'warn', caps.webgpuAdapter?.device || caps.webgpuAdapter?.vendor || 'GPU backend is optional')}
    ${row('OPFS (managed files)', caps.opfs ? 'available' : 'unavailable', caps.opfs ? 'ok' : 'warn', 'weights should not live in localStorage')}
    ${row('Persistent storage', caps.persistentStorage === null ? 'unknown' : caps.persistentStorage ? 'granted' : 'not granted', caps.persistentStorage ? 'ok' : '', 'eviction risk for multi-GB files')}
    ${row('Storage headroom', caps.storage ? `${formatBytes(caps.storage.freeBytes)} free` : 'unknown', caps.storage && caps.storage.freeBytes > 1 * GB ? 'ok' : 'warn', caps.storage ? `of ${formatBytes(caps.storage.quotaBytes)} quota` : 'quota API unavailable')}
    ${row('Device memory', caps.deviceMemoryGb ? `~${caps.deviceMemoryGb} GB` : 'not reported', '', 'Chromium only; other browsers hide this')}
    ${row('CPU cores', caps.cores ? String(caps.cores) : 'not reported', '', 'conservative thread default comes later')}
    ${verdict.blockers.length ? `<div class="local-notes bad">${verdict.blockers.map((b) => `<div>${esc(b)}</div>`).join('')}</div>` : ''}
    ${verdict.cautions.length ? `<div class="local-notes warn">${verdict.cautions.map((c) => `<div>${esc(c)}</div>`).join('')}</div>` : ''}
    ${verdict.positives.length ? `<div class="local-notes ok">${verdict.positives.map((c) => `<div>${esc(c)}</div>`).join('')}</div>` : ''}
    <div class="tiny muted" style="margin-top:8px">Measured ${new Date(caps.checkedAt).toLocaleTimeString()}. These results describe the platform, not a feature: no inference is performed.</div>`;
  return { caps, verdict };
}

on('local-rescan', async () => {
  const out = await paintCaps();
  if (out) toast(`Preflight: ${STATUS_COPY[out.verdict.status].label}`, out.verdict.status === 'blocked' ? 'bad' : out.verdict.status === 'constrained' ? 'warn' : 'ok');
});

export const localInternals = { paintCaps, formatBytes };
