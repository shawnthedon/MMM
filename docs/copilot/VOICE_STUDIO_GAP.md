# Voice Studio & Copilot voice — discovery and gap report

Status: **report complete, implementation landed for the device path only.**
Date: 2026-10-28. Branch: `arena/5195aac6-mmm`. Base commit: `e396422` (PR #17).

This is the required discovery document: what existed before the work, what the three attached
specifications ask for, what the repository actually contains, and which claims are safe to make.
It is written from measurement, not from the spec's aspirations. Delivery detail lives in
[`docs/voice/VOICE_STUDIO.md`](../voice/VOICE_STUDIO.md).

---

## 1. Method

1. Read all three specs in full (Voice Studio implementation spec, Live Type-to-Speech spec,
   Copilot master/Architect Prime spec).
2. Enumerated the repository: `src/` modules, `src/copilot/*`, `src/views*.js`, `src/shell.js`,
   `src/core.js`, `src/local.js`, `scripts/*`, `docs/*`, gateway code and tests.
3. Probed the browser APIs available at runtime (`speechSynthesis`, `getVoices()`, `localService`).
4. Recorded every capability as **verified here**, **advertised upstream**, or **contract only**.
5. Only then wrote code, and only for paths that can be verified on this device.

## 2. What existed before this work (baseline)

| Area | State before | Evidence |
| --- | --- | --- |
| Speech output | none | no `speechSynthesis` usage anywhere in `src/` |
| Speech input | none | no `SpeechRecognition` usage |
| TTS / STT engines | none | no model files, no runtime, no server, no weights |
| Audio queue / chunker | none | no sentence segmentation, no playback queue |
| Voice profiles / consent | none | no profile schema, no consent record |
| Copilot voice capability | `status: 'unverified'` | `src/copilot/capabilities.js` |
| Copilot answers | deterministic retrieval + live state | `src/copilot/orchestrator.js`, knowledge pack `repo:66b1bd3` |
| LLM provider | none reachable | `CAPS.llm` `unverified`, no provider fetch in `src/` |
| Local AI screen | preflight measurement only | `src/local.js`, "production local AI is not implemented" banner |

**Conclusion:** the app could not speak, could not listen, and had no notion of a voice, a consent
record or a speech model. Any UI claiming otherwise would have been a mock.

## 3. Gap table (spec demand → repository reality → decision)

| Spec demand | Repository reality | Decision in this change |
| --- | --- | --- |
| Model catalogue with roles and verification levels | nothing | `src/voice/registry.js`: 6 entries; only the device engine is `runtime-probe`, everything else is `advertised` or `contract-only` |
| Installation manager (checksum, resume, cancel, retry) | no downloader, no artifact directory, no checksum store | **not implemented**; the UI states exactly this. No download buttons exist. |
| Model configuration schema + migration | settings exist, no voice slice | `state.settings.voice` added to `seed()` and validated in `migrate()`; missing keys are filled, saved user values win |
| Runtime adapter registry (`getCapabilities … getHealth`) | none | `src/voice/adapters.js`: browser engine, local HTTP TTS host, cloning host — real `checkAvailability`, real request/response validation |
| Voice profile manager (consent, provenance, deletion) | none | `src/voice/profiles.js` + Voices screen: consent principal + scope recorded, revocation, deletion, no raw audio stored |
| Local runtime service | none | contract documented and probed; **no service ships here** |
| Optional hosted providers | none; spec forbids silent upload | **deliberately absent** — routing can never return a remote provider |
| Primary model Qwen2.5-Omni | not installed; Apache-2.0/multimodal claims unverified locally | catalogue entry marked `advertised`, not selectable; hardware/licence gate recorded as BLOCKED |
| Cloning (OpenVoice/NeuTTS) | not installed | adapter implements the six spec calls; every one returns `supported:false` with the exact reason when no host is configured |
| Live type-to-speech (defaults, chunking, streaming) | none | `src/voice/chunker.js` + `src/voice/studio.js` + `src/voice/queue.js`; real playback via the device engine |
| Cancellation / stale-output protection | none | monotonic generation + `AbortController` per chunk + re-check after every `await`; proven in tests |
| Persist preferences only | n/a | only `autoSpeak`, `strategy`, `modelId`, `selectedProfileId`, `rate`, `pitch`, `lang`, endpoint, profiles; no text, no audio |
| Copilot control plane honesty | Copilot exists but `voice` was `unverified` | `CAPS.voice.dynamic()` now measures the engine, and each reply has a working 🔊 control |
| Speech input | browser recogniser uploads audio to a network service in Chromium | **blocked on purpose**; the mic control says why instead of pretending |

## 4. Security review (as implemented)

- **No keys in client JS.** There is no cloud speech client at all, so no key can leak.
- **Endpoint validation.** `validateLocalEndpoint()` accepts only loopback (`127.0.0.1`, `::1`,
  `localhost`) unless `allowRemote` is passed; remote hosts must be HTTPS; URLs containing
  credentials are rejected; only `http:`/`https:` are accepted; `javascript:`, `file:` rejected.
- **SSRF surface.** Requests go to a URL the user typed and validated, with `credentials: 'omit'`,
  a request timeout, a content-type gate (`audio/*`) and a byte-size cap. Non-audio responses are
  rejected instead of being played.
- **Archive / path traversal / model code.** Nothing is downloaded, unpacked or executed, so those
  protections are not merely unimplemented — the attack surface does not exist yet.
- **Logs.** No audio, transcripts or secrets are logged; errors carry status codes and messages only.
- **Consent.** A cloned profile cannot be created without a granted consent record naming the
  principal; revoking or deleting invalidates queued audio immediately.
- **No external bind by default.** The app never starts a server; the documented local-host contract
  is inbound-only from the browser.

## 5. What remains honestly BLOCKED

| Item | Why it is blocked | What would unblock it |
| --- | --- | --- |
| Qwen2.5-Omni local inference | no runtime, no weights, no hardware measurement on a real phone | pinned release + licence re-check + device benchmark |
| Voice cloning (OpenVoice V2 / NeuTTS-Air) | no engine installed; licence and mobile-resource claims unverified | local host implementing `/v1/voice-profiles`, plus consent + deletion policy |
| Hosted providers | spec forbids silent upload; no credentials, no policy | explicit provider policy, server-side proxy, user-visible consent per request |
| Installation manager | no downloader/checksum/artifact store | artifact pipeline with integrity + resume + cancellation |
| Speech recognition | the only browser recogniser is network-backed | on-device STT (whisper.cpp host) with measured latency |
| Word-level streaming | the device engine returns whole utterances | a streaming-capable engine; not claimed anywhere in the UI |
