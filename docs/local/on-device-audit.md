# On-device AI — phase 1 audit

**Spec:** [`MMM_On_Device_AI_Design_Specification.md`](MMM_On_Device_AI_Design_Specification.md) (v1.0, 27 Oct 2026)
**Entry point:** More → **Local** (badged *new*) → `#/local` · **Code:** `src/local.js`, `src/local.css`
**Tests:** `npm run test:local` (13 checks)
**Status: phase 1 only.** No model, download, inference or image generation exists. The screen says so.

---

## 1. What MMM actually is (spec §4 discovery gate)

| Question | Answer, from this repository |
| --- | --- |
| Framework | Plain ES modules + Vite 6, no UI framework. `src/*.js` modules, hash router in `src/main.js`, views registered on a `views` object. |
| Platform targets | Installable **PWA** (manifest + service worker), mobile-first web. No native shell: no Capacitor, Cordova, React Native, Flutter or Electron in the dependency tree. |
| Persistence | `localStorage` workspace store (`swarmos-state-v1`) for UI state; the gateway has SQLite (`better-sqlite3` → `node:sqlite` fallback) behind REST + WebSocket. **No IndexedDB and no OPFS usage yet.** |
| Native extensions | None. Server side is a Node gateway (`apps/gateway`); nothing runs on-device outside the browser sandbox. |
| Build / tests | `npm run build` (Vite), `npm test` → smoke, copilot, auth, read-sync, designer, skills, comms, responsive, local, gateway. happy-dom harnesses with a CSS stub (`scripts/register-css-stub.mjs`). |
| Design system | `src/styles.css` tokens + mobile-first rules in [`../ui/responsive.md`](../ui/responsive.md); no component library. |

**Consequence (the smallest viable integration):** anything GGUF has to run **inside a browser tab**
— WebAssembly (or WebGPU) runtime, weights in OPFS/IndexedDB, jobs in IndexedDB or the gateway.
There is no background execution, no Android foreground service, and notifications are limited to
what the Notification/Push APIs allow while a service worker is registered.

## 2. Measured capability gate (what the screen does today)

`#/local` runs real probes on the device and reports **measured** values, not expectations:

| Probe | Why it decides the architecture |
| --- | --- |
| Secure context | WASM workers, storage APIs and WebGPU are all gated on HTTPS/localhost. |
| WebAssembly | Without it there is no local runtime at all → verdict **blocked**. |
| WASM SIMD | Token generation is several times slower without it. |
| Threads (`SharedArrayBuffer`) | Requires **cross-origin isolation** (COOP `same-origin` + COEP `require-corp`). The Vite dev server and Vercel deploy do **not** send those headers today — enabling them is a real, testable change. |
| WebGPU + adapter | Only a *possible* acceleration path; adapter presence is checked, nothing is allocated. |
| OPFS / persistent storage | Multi-GB weights must not live in `localStorage`; without OPFS the fallback is IndexedDB (slower). |
| Storage quota | Reports real free bytes, so "will this model fit" is answered with a number. |
| `deviceMemory`, `hardwareConcurrency` | Memory hints for the conservative thread default; Chromium-only, so unknown elsewhere. |

Verdicts are deliberately about the **platform**: `blocked` · `constrained` · `spike-ready`. Even
`spike-ready` says *"nothing is implemented yet — this only says the platform could host phase 2"*.

## 3. Known blockers before phase 2 can even start

1. **Cross-origin isolation** — add COOP/COEP to `vite.config.js` (dev) and `vercel.json` (prod), then
   re-run the preflight; without it inference is single-threaded.
2. **Runtime choice + licence** — llama.cpp (`ggml`) is the realistic WASM target; check its licence,
   the build/ABI story for a WASM artifact, and whether we ship a prebuilt `.wasm` (size!) or build it.
   No runtime has been adopted.
3. **Storage strategy** — OPFS for weights, IndexedDB for job/metadata state (the spec forbids
   `localStorage` or in-memory blobs for this).
4. **No native background downloads** — a browser tab cannot guarantee resumable large downloads or
   notifications after the tab dies. Document this as a platform limitation rather than simulating it.
5. **Image generation** — separate pipeline/model entirely; feasibility (phase 5) has not been run and
   will not be claimed without a real-device measurement.

## 4. Service boundary to implement (spec §11, adapted to this repo)

Keep the UI behind one module — `src/localRuntime.js` — with typed results and no framework coupling:

```js
getCapabilities()                     // what phase 1 already measures
listModels()                          // catalogue + lifecycle state
importModel(file)                     // File System Access / <input type=file> → OPFS
downloadModel(modelId, { signal })    // real progress, cancel, atomic promote after SHA-256
onDownloadProgress(jobId, listener)   // lifecycle-safe subscription
loadModel(modelId, opts) / unloadModel(modelId)
generateText(req, onToken)            // streamed, cancellable, never cloud fallback
stopGeneration(requestId)
generateImage(req, onProgress)        // only after phase 5 passes
getStorageInfo()
```

Lifecycle states are already specified in the spec (§6) and must be stored, not derived from UI
optimism. Every failure path must release allocations and surface an actionable message.

## 5. Files this phase touched

| File | Change |
| --- | --- |
| `src/shell.js` | `local` route; More panel rebuilt on a four-per-row `.mod-grid` with uniform `.mod-tile` geometry and a *new*-badged Local tile |
| `src/local.js` | preflight view, `detectCapabilities()`, `assess()`, phase + preset data, re-measure action |
| `src/local.css` | mobile-first layout for the preflight rows, verdict and phase list |
| `src/styles.css` | `.mod-grid` / `.mod-tile` / `.mod-ico` / `.mod-label` / `.mod-badge` |
| `src/main.js`, `src/copilot/knowledge.js` | module import; `describeScreen('local')` that reports the honest status |
| `scripts/local-test.mjs`, `scripts/smoke.mjs`, `package.json` | 13 checks (grid geometry, tile uniformity, honest copy, probe logic, verdicts) + smoke route |
| `docs/local/*` | this audit + the spec, kept in-repo so later work starts from the document |

## 6. Phase plan and evidence expectations

| Phase | Status | Exit evidence required before PASS |
| --- | --- | --- |
| 1 Audit | **done** (this document + preflight screen) | capabilities measured on the target device; architecture and risks recorded |
| 2 Runtime spike | not started | one small GGUF loaded and queried offline in airplane mode on a real device; licence, bundle size, load time, tokens/sec, memory recorded |
| 3 Model manager | not started | import/reject tests, real download progress + cancel + recovery, checksum verification, lifecycle persistence |
| 4 Offline text | not started | streaming + stop, airplane-mode test, network log showing no upload |
| 5 Image feasibility | not started | side-by-side runtime/model comparison on real hardware with timings and quality notes |
| 6 Image feature | not started | only if 5 passes; otherwise the feature stays marked unavailable |

**Do not** add load/generate/gallery controls before phases 2–4 pass: the current screen exposes a
single control (Re-measure) precisely so that no button can be inert or misleading.
