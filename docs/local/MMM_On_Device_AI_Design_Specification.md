# MMM — On-Device AI Design & Implementation Specification
**Version:** 1.0 · **Date:** 27 October 2026 · **Audience:** MMM development agent

## 1. Purpose
Add local GGUF model management, offline on-device language-model inference, and—if proven feasible—local image generation. Feature inspiration: [PocketStrike](https://github.com/AbuZar-Ansarii/PocketStrike). Verify licences before reusing code, dependencies or weights.

**This is for MMM only. Do not refer to, depend on, or modify AlertMe.** Do not assume MMM's framework, platform, architecture, UI, storage or repository layout. Inspect MMM itself first.

## 2. Non-negotiable rules
- Read MMM's own repository instructions and documentation before coding.
- Preserve existing MMM functionality and conventions; no framework migration without approval.
- Browser-only apps cannot reliably promise all native GGUF, file-system, background notification or image-generation capabilities. If relevant, report the limitation and propose the smallest viable integration before architectural changes.
- Do not fake progress, inference, image outputs or platform support.
- Gate every phase: **Task → Build → Test → Verify → Evidence → PASS → Next Task**.

## 3. Feature scope
1. **Model manager:** import, catalogue, download, verify, load, unload, inspect and delete GGUF models.
2. **Offline inference:** streamed responses from local models after installation; no network dependency for inference.
3. **Downloads:** genuine progress, cancellation, safe recovery and target-platform background notifications where supported.
4. **Image generation:** `/image <prompt>`, five aspect ratios, progress/cancel, zoom/pan viewer, gallery and save/export—only after feasibility is proven.
5. **Privacy/resources:** local-first data handling, storage/RAM checks, accurate status and actionable errors.

## 4. Platform discovery gate
Determine MMM's actual framework, OS targets/minimum versions, build system, persistence, native extension mechanisms, design conventions and tests from its own repo. Propose the smallest compatible architecture. Do not assume Android, PWA, React Native, Flutter or any other stack. If a major platform change is needed, report and obtain approval first.

## 5. Import and model library
- Import user-selected `.gguf` through safe platform file-picker APIs; avoid broad permissions where possible.
- Show model/file name, size, quantization, source, licence, compatibility, integrity and lifecycle status.
- Validate format and metadata, storage capacity, duplicates and checksum when a trustworthy SHA-256 is available. Extension alone is not validation.
- Verify exact model IDs, GGUF files, templates, URLs and licences. Use safe filenames and prevent path traversal.
- Store large weights as persistent managed files; store metadata/job state in MMM's appropriate local persistence layer, not localStorage or in-memory blobs.
- Treat downloaded metadata as untrusted.

## 6. Downloads and lifecycle
Use native/platform-appropriate large-file downloads. Display real percentage, bytes and speed where available. Support cancellation and retry; pause/resume only when supported by implementation and server. Handle network loss, expired URLs, low storage, process death, unsupported range requests and duplicate jobs. Use partial files and atomically promote only after verification. On Android, follow current background-service and notification rules; other platforms must use their own supported mechanisms.

Persist explicit states: `Available → Queued → Downloading → Paused (if supported) → Verifying → Installed → Loading → Loaded → Unloading`, plus `Error` and `Cancelled`. Import: `Importing → Verifying → Installed`. UI must reflect real operations. Check memory before loading; unload releases resources; protect active models from deletion.

## 7. GGUF runtime
Evaluate a maintained native GGUF runtime such as llama.cpp, but do not adopt it without checking licence, platform/ABI/build support and model compatibility. Use CPU acceleration (e.g. ARM NEON) and multithreading only when supported. Keep the UI behind a typed, provider-neutral service boundary.

Support streamed output, stop/cancel, selected-model display, context/output limits within runtime constraints, correct tokenizer/chat template, measured performance metrics, and actionable errors. Handle memory pressure, backgrounding and repeated load/unload. After installation, local inference must work in airplane mode. **Never silently fall back to cloud inference.**

### Requested candidate presets
- SmolLM2 135M / 360M
- Qwen2.5 0.5B Instruct
- Llama 3.2 1B and 3B Instruct
- DeepSeek-R1-Distill-Qwen-1.5B
- Optional third-party abliterated/uncensored variants, clearly labelled with source/licence/risk information

These are candidates, not guaranteed compatible files. Verify exact GGUF versions, templates, model cards and licences. Do not repeat unverified RAM claims; memory use varies with quantization, context and device.

## 8. Local image generation
Text GGUF inference does not itself provide image generation. A separate compatible image model/pipeline/runtime is required. “Unlimited” must not imply unlimited speed, battery, storage or hardware capacity.

- Accept `/image <prompt>` and clear natural-language requests.
- Ratios: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`; constrain dimensions.
- Show runtime/model readiness, progress where available, cancellation and resource limits.
- Add zoom/pan viewer, local gallery/history, delete and explicit save/export using target-platform APIs.
- Never fake an image or silently call a cloud service.
- Before full implementation, compare mobile-compatible runtimes/model families by actual target OS, RAM/storage, CPU/GPU/NPU coverage, licence, output quality and packaging complexity. Run a real-device proof of concept and record speed, memory, heat/battery and output quality.
- Do not assume FLUX, SD-Turbo or another model will run efficiently without evidence. If the feasibility gate fails, keep the feature honestly marked unavailable/experimental.

## 9. Privacy and security
- No prompts, responses, model files or images transmitted during local inference.
- Avoid logging sensitive content, paths or images to analytics/crash services by default.
- Clearly distinguish online downloads/catalogue refresh from offline inference.
- Use app-private storage and scoped/user-selected export locations where supported.
- Validate HTTPS, redirects, filenames, paths, file sizes and metadata. Never execute model files as code.
- Review runtime/dependency/model licences; don't redistribute weights unless permitted.
- Provide reliable delete controls for models, conversations and images.

## 10. Resource and UI requirements
Check free storage and preserve temporary-file headroom. Estimate RAM including context/KV cache where possible. Use conservative thread defaults and handle low-memory/thermal events where supported. Failed loads must release partial allocations. Show actionable errors. Follow MMM's existing design and accessibility system rather than inventing one.

## 11. Service boundary (conceptual)
Adapt to existing MMM conventions:
- `getCapabilities()`
- `listModels()`
- `importModel()`
- `downloadModel(modelId, options)`
- `onDownloadProgress(jobId, listener)`
- `loadModel(modelId, options)` / `unloadModel(modelId)`
- `generateText(request, onToken)` / `stopGeneration(requestId)`
- `generateImage(request, onProgress)`
- `getStorageInfo()`

Use typed result/error objects, stable IDs, cancellation and lifecycle-safe event subscriptions. Only expose features supported by the real platform.

## 12. Phased delivery
1. **Audit:** inspect MMM docs, code, platform, build/test and persistence. Report before coding.
2. **Runtime spike:** import/locate, load and query a minimal GGUF model offline on intended hardware; document licence, build, memory and performance.
3. **Model manager:** import, catalogue, downloads, progress, notifications where supported, validation, recovery and lifecycle.
4. **Offline text:** streaming, cancellation, local history if in scope, airplane-mode and privacy tests.
5. **Image feasibility:** compare and test candidate pipeline on real hardware.
6. **Image feature:** prompt, ratios, progress/cancel, viewer, gallery, export and cleanup only if feasibility passes.

Update MMM's own progress documentation if available. Never edit or create AlertMe documents.

## 13. Acceptance tests
- Valid GGUF imports; invalid/corrupt files are rejected safely.
- Large downloads show real progress, cancel and recover correctly; partial files cannot load.
- Supported models load, stream, stop and unload without leaks/crashes.
- Airplane mode allows local inference after installation.
- No silent cloud fallback; network inspection confirms no prompt/response/image upload during local inference.
- Low RAM/storage produces actionable errors, not crashes.
- Background behavior/notifications comply with the target OS; UI state remains accurate.
- Deletion protects active models and reports partial failures.
- Image generation is verified on supported hardware, saves locally and has an honest unsupported state.
- Existing MMM functionality and design remain intact.
- Release build packages native dependencies and works outside debug mode.

## 14. Test plan
Unit tests: metadata, state transitions, job persistence, URL/path validation, ratio parsing, errors. Integration: picker/import, download recovery/cancel, load/unload, streaming/cancel, export. Real-device tests on low-resource and capable target devices where applicable; record OS, RAM, chipset/ABI, model size, load time, tokens/sec and thermal/image timing. Test airplane mode, corrupt files, low storage, memory pressure, permission denial, process death and repeated lifecycle operations. Review licences and sensitive logging.

## 15. Agent handoff
Before coding, report: confirmed MMM platform/framework, repository/docs inspected, minimum-change architecture, runtime/licensing risks, device assumptions, feasibility tests, likely changed files and phased plan. Then implement one gate at a time. Each report must include changed files, build/test commands, real-device evidence where relevant, limitations, docs updated and acceptance PASS/FAIL. Do not mark PASS from code inspection alone.

**Reference:** [PocketStrike repository](https://github.com/AbuZar-Ansarii/PocketStrike)
