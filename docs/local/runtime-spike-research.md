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
  A later Linux network-namespace test isolated the whole test browser from external networks; this is not mobile-device evidence (see below).

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
  recorded zero HTTP requests after page offline mode was enabled. **Correction:** a subsequent
  sentinel test showed that Puppeteer's page offline setting did not disconnect the dedicated worker
  from the local server. The earlier run therefore did not establish network disconnection for the
  worker and must not be treated as a complete offline or privacy test. See the follow-up below.
* An offline navigation back to the normal PWA still returned the real application shell. Peak
  runtime memory, thermal behaviour and battery consumption were **not measured**; browser APIs do
  not reliably expose these. Numbers are a single small-model sandbox run and must not be generalized.

## Follow-up desktop verification — 28 October 2026

A repeated run on built Vite preview and headless Chromium 153 using the same 277,024-byte fixture
found and fixed two failures: wllama's native `load` result can report `success=false` while its JS
`loadModel()` still resolves, and stopping its iterator stream produced an unhandled abort rejection.
The spike now validates the actual native context (`success` and nonzero dimensions) before marking
a model loaded, uses the callback streaming API, treats an abort as stopped even if a provider
returns normally, and retains failed cleanup for an explicit retry. A runtime-asset redirect is
refused. This validates the selected runtime's result; it is still **not** a full GGUF integrity or
licence validation.

The updated browser test exercised a real interrupted OPFS replacement (the previous model's SHA-256
remained unchanged), rejected a truncated GGUF at runtime load, exercised the Stop button during real
streaming without an unhandled exception, verified that unload terminated the model worker, and
performed a second load/unload. Eleven mock-backed tests additionally cover cancellation, quota,
invalid context, redirect and failed-cleanup retry. The 320 px check passed in desktop Chromium.

For generation and stop, Chrome DevTools Protocol was attached to the existing dedicated model
worker. A deliberate local HTTP sentinel request was observed, validating the observer; it was also
**reachable despite page offline emulation**. Excluding that sentinel, zero HTTP(S) requests were
observed from the instrumented worker during generation/stop and zero from the page during the first
inference. Worker instrumentation starts **after** model load and does not prove coverage of other
workers, service workers, other browsers, or network traffic at process level. The test does not
prove airplane-mode operation: only a physically disconnected target device or equivalent verified
network isolation and an appropriate network capture can do that. This supersedes the stronger claim
in the previous report. No prompt, completion, or model data was included in the sentinel.

### Linux network-namespace run

The same updated browser test was subsequently run in a Linux network namespace with **only the
loopback interface** and no external IPv4/IPv6 routes. The test process checks that configuration
before launching Vite and Chromium; both page and model workers inherit the namespace. The tiny
GGUF loaded from OPFS, generated 64 tokens, stopped, unloaded, loaded again and rejected the truncated
file. The loopback sentinel remained reachable (expected, as it is the local test server); the
instrumented model worker made no HTTP(S) requests during generation/stop, excluding the sentinel.
One sample measured **0.33 s** load and **0.16 s** generation (~**388.13 tokens/s**, including
prompt processing). This establishes disconnected-external-network behaviour only for this Linux
sandbox and fixture; it does not establish mobile airplane mode or complete network logging during
worker startup. Peak memory, heat and battery remain unmeasured.

To repeat in a disposable Linux environment with `ip`, `unshare`, permission to create a network
namespace, the Chromium dependencies and a prepared GGUF (adjust the user and paths):

```sh
sudo unshare -n sh -c 'ip link set lo up && exec sudo -u user env MMM_SPIKE_REQUIRE_NETWORK_NAMESPACE=1 MMM_SPIKE_MODEL=/tmp/mmm-stories260k-q4.gguf LD_LIBRARY_PATH=/tmp/chromium-libs/lib npm run test:local-spike:browser'
```

The namespace preflight aborts unless loopback is the only interface and there are no external
routes. Ordinary `npm run test:local-spike:browser` does not create or assert this namespace.
The fixture can be reconstructed outside the repository from the pinned sources above using a local
llama.cpp build; it is not necessary to download model weights for normal app use:

```sh
git clone https://github.com/wbrown/tinyoai.git /tmp/mmm-tinyoai
git -C /tmp/mmm-tinyoai checkout 90338dac3a48648f257aa80752638dae4873dda2
git clone https://github.com/ggml-org/llama.cpp.git /tmp/mmm-llama
git -C /tmp/mmm-llama checkout 8642541b255bfb5dc39cd351a178be09013a55d6
cmake -S /tmp/mmm-llama -B /tmp/mmm-llama/build -DLLAMA_BUILD_EXAMPLES=ON -DLLAMA_BUILD_TESTS=OFF -DLLAMA_CURL=OFF -DCMAKE_BUILD_TYPE=Release
cmake --build /tmp/mmm-llama/build --target llama-convert-llama2c-to-ggml llama-quantize -j 4
/tmp/mmm-llama/build/bin/llama-convert-llama2c-to-ggml --copy-vocab-from-model /tmp/mmm-tinyoai/assets/tok512.bin --llama2c-model /tmp/mmm-tinyoai/assets/stories260K.bin --llama2c-output-model /tmp/mmm-stories260k.gguf
/tmp/mmm-llama/build/bin/llama-quantize /tmp/mmm-stories260k.gguf /tmp/mmm-stories260k-q4.gguf Q4_0
sha256sum /tmp/mmm-stories260k-q4.gguf
```

The follow-up sample loaded in **0.29 s** and generated 64 tokens in **0.15 s**, about **430.30
tokens/s**, on the same sandbox class; timing includes prompt processing. Peak memory, battery and
thermal effects remain unmeasured. These results are not representative of mobile inference.

Run `npm run test:local-runtime` for mock-backed lifecycle/failure checks. The optional real-browser
test requires the separately installed tools from [cross-origin-isolation.md](cross-origin-isolation.md)
and a local GGUF: `MMM_SPIKE_MODEL=/path/to/model.gguf npm run test:local-spike:browser`. In a minimal
Linux sandbox, set `LD_LIBRARY_PATH` as shown in that document. The test emulates offline mode for
its page, inspects the dedicated runtime worker after load, and checks PWA shell preservation. It is
not an airplane-mode test, and deliberately demonstrates the worker-emulation limitation.

## Remaining phase-2 gate

Verify the top-level deployed app and intended mobile devices, including isolation, model import,
real airplane mode, completion, repeated load/unload and a network capture covering workers. Pick an
appropriately licensed, checksum-verified small Q4 model with known tokenizer/template; record the
exact model, OS, browser, RAM/chipset, bundle size, load time, tokens/s, peak memory if measurable,
thermal/battery observations, errors, and model/output limitations. Test corrupt files, low storage,
stop, memory pressure and interrupted operations. Complete binary attribution review. The sandbox
success does **not** satisfy these gates; phase 2 remains **in progress**, and phases 3–6 remain
unstarted. No estimated measurement should be reported as observed.
