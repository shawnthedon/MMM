# Voice Studio — delivery report

Status: **PASS for the device-speech path. BLOCKED for model inference, cloning and hosted providers.**
Version: 1.0.0 · Branch `arena/5195aac6-mmm` · Base `e396422` · 2026-10-28.

Voice Studio is the live type-to-speech editor, voice-profile manager, model catalogue and
diagnostics surface for MMM, plus the Copilot voice surface that uses it. The one rule that shapes
every screen: **a capability appears as working only after this build has exercised it.**

---

## 1. What ships

| File | Lines | Responsibility |
| --- | --- | --- |
| `src/voice/registry.js` | 234 | roles, adapter registry, model catalogue, verification levels, `filterModels`, `availabilityFor`, local-first `routeRequest` |
| `src/voice/chunker.js` | 168 | abbreviation-aware sentence segmentation with offsets, word-boundary hard splits, incremental `createSentenceBuffer` |
| `src/voice/queue.js` | 159 | ordered playback queue, generation counter, `AbortController` per chunk, stale-audio rejection, overflow reporting |
| `src/voice/adapters.js` | 440 | device speech engine adapter, local HTTP TTS adapter, cloning adapter (`/v1/voice-profiles`), loopback endpoint validation |
| `src/voice/profiles.js` | 128 | profile schema, consent records, sanitisation, active-profile resolution with fallback reason |
| `src/voice/studio.js` | 340 | controller: buffer + queue + profiles + persistence, strategies, idle flush, generation invalidation |
| `src/voice.js` | 599 | Voice Studio UI: Overview · Models · Type-to-speech · Voices · Diagnostics, plus Copilot hooks |
| `src/voice.css` | 76 | mobile-first styling, RELAY tokens only |
| `scripts/voice-test.mjs` | 592 | 48 deterministic tests (chunker, queue, studio, profiles, adapters, registry, store, UI) |
| `scripts/voice-browser-test.mjs` | 161 | 12 real-browser checks (Chromium, layouts, real `speechSynthesis`, Copilot 🔊) |

Wiring changes: `src/main.js` (route + per-view `skipRender` hook), `src/shell.js` (route + module
tile), `src/core.js` (`settings.voice` seed + migration), `src/local.js` and `src/views2.js`
(deep links), `src/copilot/{capabilities,orchestrator,panel}.js` + `src/copilot.css` (voice
capability, voice intents, per-reply 🔊, composer mic), `package.json` (`test:voice`,
`test:voice:browser`).

## 2. Model catalogue (all honesty levels shown in the UI)

| Model | Roles | Licence | Install | Verification |
| --- | --- | --- | --- | --- |
| Device speech engine (`browser-speech`) | tts, stt* | OS-provided | built-in | **runtime-probe** (measured at runtime) |
| Qwen2.5-Omni 3B/7B | conversational, tts, stt, streaming, multimodal | Apache-2.0 (advertised, re-check per artifact) | not installed | advertised |
| Piper | tts | MIT (advertised) | not installed | contract-only |
| OpenVoice V2 | tts, clone | MIT (advertised) | not installed | advertised |
| NeuTTS-Air | tts, clone | Apache-2.0 (advertised; other NeuTTS variants differ) | not installed | advertised |
| whisper.cpp | stt | MIT (advertised) | not installed | contract-only |

\* The device engine advertises recognition, but Voice Studio does not expose it: Chromium's
recogniser uploads audio to a network service, which would violate the no-silent-upload rule.

Selecting a model is only possible when `availabilityFor()` says it is usable. Today that is the
device engine only; every other tile is disabled with the reason printed underneath.

## 3. Architecture

```
editor input ──► chunker (buffer, offsets) ──► studio controller ──► queue (generation + abort)
                                                     │                        │
                                        profiles/consent gate        adapter: device | local host
                                                     │                        │
                                              settings.voice            audio / error surface
```

- **Generation ids.** Any material text change, voice change, profile revocation or Stop bumps the
  generation. Chunks carry their generation; the queue drops anything from an older one, so late
  audio from a cancelled request can never be heard.
- **Ordering.** Exactly one chunk is in flight; the next starts only when the previous resolves,
  errors or is aborted. The queue is capped (32) and overflow is reported, never silent.
- **Flushing.** Sentence strategy speaks each completed sentence; the unfinished tail is spoken by
  the idle flush (default 900 ms), by Play, or on leaving the field. Manual strategy speaks only on
  Play and always replays the full text in a new generation.
- **Fallbacks.** `resolveActiveProfile()` returns the active profile *and* a fallback reason. The
  default profile `My cloned voice` is selected in settings, and every surface that uses it states
  that the device voice is speaking instead. No silent substitution.
- **Persistence.** `settings.voice` stores preferences and profile metadata only. Text, audio
  buffers and object URLs never reach the store; the browser adapter revokes object URLs on stop.

## 4. Local TTS host contract

If you run a compatible host, Voice Studio will use it — nothing else changes.

```
GET  /health                     → 200 {"status":"ok"}          (availability probe)
POST /v1/audio/speech            → 200 audio/*                  (synthesis)
     {"input":"…","voice":"<id>","response_format":"wav","speed":1.0}
```

Rules enforced client-side: loopback hosts only by default, HTTPS required for anything remote,
no credentials in the URL, `credentials: 'omit'`, 30 s timeout, `audio/*` content type required,
size cap enforced, abort signal honoured.

Cloning host contract (all six spec calls; each returns `supported:false` with a reason when
unconfigured):

```
POST   /v1/voice-profiles                 create (consent required)
GET    /v1/voice-profiles                 list
GET    /v1/voice-profiles/:id             status
DELETE /v1/voice-profiles/:id             delete + revoke
POST   /v1/voice-profiles/validate        validate reference audio
POST   /v1/voice-profiles/:id/speech      synthesise with a profile
```

## 4b. Screenshots (real Chromium, 320/390 px)

| Screen | File |
| --- | --- |
| Voice editor at 390 px (device engine, fallback + blocked banners) | `docs/voice/editor-390.png` |
| Voice editor at 320 px (no clipped controls) | `docs/voice/editor-320.png` |
| Model catalogue at 390 px (Qwen2.5-Omni advertised-only) | `docs/voice/models-390.png` |
| Voice profiles at 390 px (consent, revocation, blocked cloning) | `docs/voice/voices-390.png` |

## 5. Test evidence

`npm run test:voice` → **48/48 PASSED** (deterministic, fake engine).

| Acceptance test | Coverage |
| --- | --- |
| TTS-01 defaults | `My cloned voice` selected, auto-speak on, sentence strategy, explicit fallback |
| TTS-02 completed sentence submitted immediately | test A5, TTS-02 |
| TTS-03 partial text buffered, not per keystroke | TTS-03 |
| TTS-04 multiple sentences queue in order, no overlap | TTS-04, B1 |
| TTS-05 audio starts before the text is finished | TTS-05 |
| TTS-06 delayed chunks cannot duplicate or reorder | TTS-06, B3 |
| TTS-07 editing invalidates stale synthesis | TTS-07, A6 |
| TTS-08 clear/stop during playback drops pending chunks | TTS-08, B2, B3 |
| TTS-09 voice switch cancels the old generation | TTS-09 |
| TTS-10 revoked/blocked profile explains itself, stays silent | TTS-10, D2 |
| TTS-11 engine failure keeps the editor usable | TTS-11, B5 |
| TTS-12 idle flush speaks the unfinished tail exactly once | TTS-12 |
| TTS-13 no cloud adapter, routing never remote | TTS-13, F1–F3 |
| TTS-14 repeated playback releases resources | TTS-14, B4 |
| Blocked (not crash) when the engine has no voices | TTS-14b |
| TTS-15 manual strategy speaks only on Play | TTS-15 |
| TTS-16 only preferences persist (no text, no audio) | TTS-16, D4 |
| Race: late response after cancel | B3 |
| Race: reverse-order completion | B1, TTS-06 |
| Race: runtime disconnect mid-stream | B5, TTS-11 |
| Race: manual-strategy switch while auto pending | TTS-15 |
| Security: loopback-only endpoints, credentials, schemes | E1–E2 |
| Security: response validation (status, type, size) | E4 |
| Security: unreachable host reports unreachable | E3 |
| Chunking: abbreviations, decimals, ellipsis, word-boundary split | A1–A4 |
| UI: route, all five sections, accessible labels, no dead controls | G3–G5 |
| Copilot: measured capability, singing constraint, navigation | H1–H4 |

`npm run test:voice:browser` (Chromium 320/390/1440 px) → **12/12 PASSED**: no horizontal overflow,
≥44 px targets, real engine probe, fallback banner visible, typing produced real `speak()` calls,
editing cancelled the previous generation, Stop silenced the engine, Qwen2.5-Omni not selectable,
no cloud fallback claimed, Copilot 🔊 reached the engine, zero page errors.

Full suite: `npm test` green (smoke, copilot tour, auth 16/16, readsync 12/12, designer 18/18,
skills 23/23, comms 23/23, design 13/13, responsive 17/17, local 13/13, kanban 26/26, scroll 10/10,
comms-gateway 28/28, gateway 30/30, session-safety 8/8, plus voice 48/48). `npm run build` clean.

## 6. Copilot surface

- **Capability.** `CAPS.voice` now has a `dynamic()` probe: it reads `speechSynthesis`, counts voices
  and `localService` flags, and returns `available` / `unconfigured` / `blocked` with the measured
  evidence string. No hard-coded success.
- **Intents.** “open voice studio”, “read this aloud”, “speak”, “type” route to the editor and open
  it; “can it sing?” answers with the real constraint (the device engine cannot sing; nothing
  installed can) and cites this document.
- **Per-reply speech.** Every assistant message has a `Speak` control that sends the reply text
  through Voice Studio's engine and current voice, and surfaces failures as a toast.
- **Voice input.** The composer mic is intentionally *not* a disguised fake: it opens Voice Studio's
  overview and states that the only browser recogniser uploads audio to a network service.
- **Mode chip.** The Voice mode hint now says what is true: device speech works, cloning and
  Qwen2.5-Omni are blocked.
- **Navigation and the singing question work from any mode**, not only Operate/Voice: “open voice
  studio” opens the screen and “can it sing?” returns the constraint with the delivery-report
  reference. Composer placeholder shortened so it is never clipped next to the mic button.
- **Speech to Copilot is not linked to model output.** Replies are still deterministic retrieval
  over the knowledge pack — speaking them does not make them generated text.

## 7. Hardware / environment of the measurements

| Measurement | Environment |
| --- | --- |
| Deterministic tests | Node 22.22.3, happy-dom, fake engine (no audio hardware claimed) |
| Browser tests | Chromium (Puppeteer, headless, `--no-sandbox`), viewports 320/390/1440 px |
| Voices reported in headless Chromium | 0 (the headless build exposes the API but no voices; the UI reports exactly that) |
| Real device matrix | **not measured here** — no phone, no audio output, no OS voice list available in this sandbox |

Because of that last row, performance numbers (time-to-first-audio, memory on a 320 px phone,
battery) are **not** claimed. They are listed below as open verification work.

## 8. Release gate

| Gate | Result |
| --- | --- |
| Real adapter (not simulated) | **PASS** — device engine measured at runtime; requests proven in Chromium |
| Profile reuse across chunks and sessions | **PASS** — one profile per generation, persisted, revoke/delete invalidates audio |
| Race evidence (cancel, late audio, ordering, disconnect) | **PASS** — B1–B5, TTS-06/07/08/09 |
| Offline / local-first | **PASS for on-device voices; BLOCKED for models** — no cloud adapter exists, so nothing can upload |
| No unintended uploads | **PASS** — no remote speech client, loopback-only endpoints, recogniser not exposed |
| Measured performance on a real device | **BLOCKED** — not measurable in this sandbox |

**Verdict: PASS** for Voice Studio's device-speech path and its Copilot surface.
**BLOCKED:** Qwen2.5-Omni inference, voice cloning, hosted providers, installation manager, speech
recognition, word-level streaming, real-device performance.

## 9. Next tasks (each needs information only the operator can supply)

1. **Qwen2.5-Omni** — pin a release and re-verify the Apache-2.0 claim per artifact, then benchmark
   on a target phone; unblock only with measured load time, RAM ceiling and first-audio latency.
2. **Cloning host** — implement `/v1/voice-profiles` locally, with reference-audio retention policy,
   consent expiry and deletion proof, before enabling the profile creator.
3. **Installation manager** — downloader with checksum manifest, resume, cancellation and a signed
   artifact directory; the UI already has the states, but no button will appear until it is real.
4. **Speech input** — on-device STT via a loopback whisper.cpp host, with measured latency and an
   explicit “audio never leaves this device” proof.
5. **Real-device pass** — run `npm run test:voice:browser` against Android Chrome and iOS Safari on
   real hardware and record voice counts, first-audio latency and battery impact.
