# Local AI: cross-origin isolation prerequisite

## Change and scope

The Vite development server, Vite built preview and Vercel configuration send
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. The
pre-existing Local screen measures `window.crossOriginIsolated` and `SharedArrayBuffer`; it does not
assume that headers alone made threads available. The service-worker cache was bumped from
`swarmos-v1` to `swarmos-v2`, so an update does not keep serving a pre-header cached shell offline.
An initial online update is necessary before an existing installation gets the new worker and shell.

Same-origin HTML, JS, CSS, manifest, icons and service worker require no third-party exemption. No
external fonts, scripts or images are referenced by the app shell. Cross-origin resources added later
must explicitly allow CORS or CORP; fetches to a separately hosted gateway must continue to satisfy
its CORS and cookie rules. `COOP: same-origin` separates cross-origin popup browsing contexts, which
may break future popup-based authentication or integrations that depend on `window.opener`. Test
those integrations before deploying them. A cross-origin iframe/preview host must also cooperate:
headers on the embedded document alone do not guarantee an isolated frame. Test the deployed app in
a top-level HTTPS tab when an embed cannot provide isolation. HTTP localhost is a browser secure
context; other deployments require HTTPS. Other hosting/reverse proxies must add the same headers.

## Evidence and limits

* `npm run test:isolation` starts real Vite dev and built-preview HTTP servers, checks response
  headers and existing shell resources, and checks Vercel's JSON configuration. This is not a
  deployed Vercel test.
* On 28 Oct 2026, headless Chromium 153 on Linux x86-64, running the **built Vite preview** at
  localhost, observed `crossOriginIsolated === true`, a usable `SharedArrayBuffer` and shared
  `WebAssembly.Memory`, and the preflight reported threads available. A controlling service worker
  was present; the same checks passed after an offline reload from its cached shell. This is a
  desktop browser check, **not** mobile, production deployment, provider integration, model loading
  or inference evidence. `npm run test:isolation:browser` reproduces it where a compatible browser
  and libraries are available.
* Vercel deployment, cross-origin embedding, mobile browsers and popup/external integrations are
  **not verified** here. Confirm on each intended host and device; inspect network/console errors.
  A healthy preview server or a passing JSON test alone cannot establish isolation.

To run the optional browser test in a disposable development environment (it is not part of
`npm test` and does not add browser tooling to the production bundle):

```sh
npm install --no-save --no-audit --no-fund --ignore-scripts @sparticuz/chromium@153.0.0 puppeteer-core@25.16.0
npm run test:isolation:browser
```

The Chromium binary requires its OS shared libraries (including NSS/NSPR). In minimal Linux images,
install system browser prerequisites. For example, this sandbox used the library archive shipped by
`@sparticuz/chromium` (temporary paths only):

```sh
mkdir -p /tmp/chromium-libs
node -e "const z=require('zlib'),f=require('fs');f.writeFileSync('/tmp/chromium-libs/al2023.tar',z.brotliDecompressSync(f.readFileSync('node_modules/@sparticuz/chromium/bin/al2023.tar.br')))"
tar xf /tmp/chromium-libs/al2023.tar -C /tmp/chromium-libs
LD_LIBRARY_PATH=/tmp/chromium-libs/lib npm run test:isolation:browser
```
 This test deliberately does **not** use the package's `--disable-web-security`
or site-isolation-disabling defaults, which would invalidate the measurement.

## Phase gate

Header implementation and automated checks are in place; target-device/production verification is
pending. This is not phase-2 runtime PASS. There is no model, runtime, inference, claimed throughput,
or cloud fallback. For a candidate runtime and remaining checks see
[`runtime-spike-research.md`](runtime-spike-research.md).
