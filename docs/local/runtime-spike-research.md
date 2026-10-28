# Phase 2 runtime spike: candidate and evidence plan

Status: **research only; not adopted or implemented**. No GGUF, runtime, model load or inference has
been tested in MMM. The header prerequisite has desktop-browser evidence; deployment and mobile
verification remain open. Phase 2 cannot pass without an offline run on intended hardware.

## Candidate examined on 28 Oct 2026

[`@wllama/wllama` 3.8.1](https://github.com/ngxson/wllama) is a browser WebAssembly binding for
[llama.cpp](https://github.com/ggml-org/llama.cpp), with a worker and a published npm package. The
package metadata and its included `LICENCE` say MIT (retain the copyright and licence notice on
redistribution); llama.cpp's GitHub metadata also identifies MIT. This is an initial check, **not**
a full third-party/WASM-binary attribution review and says nothing about any model's separate
licence. Exact GGUF weights, tokenizer, chat template, distribution permission and checksum remain
to be verified independently. No model is bundled or selected.

Observed using `npm pack @wllama/wllama@3.8.1` (archive not committed): archive 5,829,483 bytes;
package reports 20,248,968 unpacked bytes; `esm/wasm/wllama.wasm` is 8,763,949 bytes. The actual
MMM build size and memory impact have **not** been measured. The package includes a duplicate WASM
under `src`; do not assume both copies would ship. Upstream documents workers, SIMD, multi-thread
isolation requirements, a file-size constraint, and a load-from-cache offline option. Verify the
exact OPFS-to-`loadModel` flow, worker asset packaging and actual no-network inference before adopting
it. Do not depend on a CDN for runtime assets; an uncached CDN would break offline inference.

## Next gate

1. Verify the deployed top-level app on intended mobile hardware: HTTPS, `crossOriginIsolated`,
   `SharedArrayBuffer`, service-worker update/offline behaviour and any provider integration under
   COEP/COOP. See [cross-origin isolation](cross-origin-isolation.md).
2. Pin the runtime only after checking transitive and binary licences, supported browser/ABI, OPFS
   loading, assets, memory, resource cleanup and its logging behaviour. Keep a provider-neutral
   `src/localRuntime.js` boundary; do not add the dependency or a user-facing control prematurely.
3. Select an exact small Q4 GGUF with a verified model card, licence, source, checksum and chat
   template. Obtain it on a suitable machine (the development sandbox cannot reach model hosts).
4. Build an isolated experimental spike, load the model from OPFS, then disable the network (airplane
   mode) and query it. Capture model/runtime versions, browser/OS/device/CPU/RAM, build size, load
   time, token count/time, tokens/sec, observed peak memory and thermal/battery notes. Capture
   network evidence that prompts and outputs do not leave the device; test repeated load/unload and
   failure handling. Do not fabricate metrics when the browser does not expose them.
5. Only mark phase 2 **PASS** after the recorded target-device evidence meets the spec. Otherwise
   report the blocker and keep model management, offline text and image UI unavailable.
