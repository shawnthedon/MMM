# Local AI runtime spike — in progress, not phase-2 PASS

The experimental entry point is `local-spike.html` (also linked from Local AI). It uses a user-selected
GGUF, stores one fixed-name file in OPFS, prepares same-origin WASM, loads it in a worker, generates a
short streamed **raw completion**, stops on request and unloads. It is not a model manager, chat
assistant or production AI feature. No weights are bundled, downloaded or redistributed. Header-only
checks do not establish model integrity, safety, licence, tokenizer correctness or compatibility.
There is no catalogue, checksum verification, atomic install manager, conversation history, model
selection, recovery, memory estimation, or cloud fallback. The page must stay open for an offline
run; it is not cached as a standalone offline entry point. The normal PWA shell remains distinct.

## Build and licence

* Runtime pinned to [`@wllama/wllama` 3.8.1](https://github.com/ngxson/wllama), a WebAssembly
  binding for llama.cpp; package includes MIT `LICENCE` and reports no runtime npm dependencies.
  `Wllama.getLibllamaVersion()` reports `b11364-46ca246`. MIT notices for wllama, llama.cpp and
  json.hpp are included under `public/third-party/`. A comprehensive audit of the prebuilt WASM's
  complete embedded third-party notices and source/binary reproducibility remains open. Review
  model-specific licences separately.
* Vite production build on 28 Oct 2026 emits one **8,763,949-byte** WASM (2,404,310 bytes gzip),
  and a separate ~331 kB JS spike chunk (~149 kB gzip); the normal app does not load that chunk.
  No CDN compatibility fallback is permitted (`setCompat(null)`); unsupported browsers fail instead.
  The spike requires cross-origin isolation and SharedArrayBuffer, plus OPFS; Safari/Firefox and
  actual mobile devices remain unverified. It uses CPU only, one thread, 256-token context and a
  64-token output limit. The 512 MiB file cap is a spike safeguard, **not** a memory guarantee.
* `src/localRuntime.js` accepts local file blobs, uses a fixed OPFS directory/name, fetches only the
  same-origin WASM to a blob URL before going offline, never uses a URL-based model loader, and
  suppresses runtime logs. Closing the tab can end work; storage may be evicted by the browser.
  Network isolation remains a test result for the tested runtime/browser, not a universal guarantee.

## Desktop evidence — 28 October 2026

Headless Chromium 153.0.8010.0 on Linux x86-64, Intel Xeon 2.60 GHz sandbox, 3.8 GiB reported system
memory; Vite **built preview** at secure localhost. These are desktop sandbox measurements, not an
Android/iOS measurement. We used a tiny pre-trained 260K-parameter story model **only as a runtime
fixture**, not as a capable assistant. It has no chat template/training and its output is not a
quality benchmark.

* Source weights and tokenizer: [`wbrown/tinyoai`](https://github.com/wbrown/tinyoai) commit
  `90338dac3a48648f257aa80752638dae4873dda2`, which attributes `stories260K.bin` and `tok512.bin` to
  Karpathy and identifies them as MIT in its LICENSE. SHA-256: weights
  `b0a507e7ad0f626624f17112325e66691f9076d622e1d3274d103d00299f2696`; tokenizer
  `037cb335abb25d1fa9e8ecae30ed2a3a8ace9302862ebcdc05d51a6bbb10c312`.
* Converted locally using llama.cpp commit `8642541b255bfb5dc39cd351a178be09013a55d6` and
  `llama-convert-llama2c-to-ggml`; quantized with `llama-quantize Q4_0`. Quantizer reports 6 of 48
  tensors falling back to F16, so it is **mixed Q4_0/F16/F32**, not exclusively Q4. The resulting
  277,024-byte GGUF SHA-256 is `58bfd5e359c080e8c121dd667d226f9bfc136ed83cfc240f3a05e3b1d5b9c731`.
  It remains a temporary local test artifact, not a repository file.
* From the built page, a real file-picker import wrote the GGUF to OPFS. WASM was prepared while
  online; Chromium's offline mode was then enabled. A real model load took **0.26 s**, and a
  64-token raw completion took **0.14 s** (~**461.89 tokens/s**, including prompt processing).
  The run produced 175 output characters and unloaded successfully. The page-level request log
  recorded zero HTTP requests after offline mode was enabled; Chromium offline mode additionally
  prevented network traffic. This is not a device airplane-mode test or a comprehensive network
  audit of every browser/worker.
* An offline navigation back to the normal PWA still returned the real application shell. Peak
  runtime memory, thermal behaviour and battery consumption were **not measured**; browser APIs do
  not reliably expose these. Numbers are a single small-model sandbox run and must not be generalized.

Run `npm run test:local-runtime` for mock-backed lifecycle/failure checks. The optional real-browser
test requires the separately installed tools from [cross-origin-isolation.md](cross-origin-isolation.md)
and a local GGUF: `MMM_SPIKE_MODEL=/path/to/model.gguf npm run test:local-spike:browser`. In a minimal
Linux sandbox, set `LD_LIBRARY_PATH` as shown in that document. The test enables browser offline mode,
uses the UI for import/load/generation/unload, and checks page requests plus PWA shell preservation.

## Remaining phase-2 gate

Verify the top-level deployed app and intended mobile devices, including isolation, model import,
real airplane mode, completion, repeated load/unload and a network capture covering workers. Pick an
appropriately licensed, checksum-verified small Q4 model with known tokenizer/template; record the
exact model, OS, browser, RAM/chipset, bundle size, load time, tokens/s, peak memory if measurable,
thermal/battery observations, errors, and model/output limitations. Test corrupt files, low storage,
stop, memory pressure and interrupted operations. Complete binary attribution review. The sandbox
success does **not** satisfy these gates; phase 2 remains **in progress**, and phases 3–6 remain
unstarted. No estimated measurement should be reported as observed.
