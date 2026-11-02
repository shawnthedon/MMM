# Copilot — local voice input, and what happens to the audio (M34)

| Field | Value |
| --- | --- |
| Parent spec | `MMM-Copilot-Design-Spec-2026-11-01.md` §3 (voice), §9 (permissions), §11 (copy) |
| Unit | 5 of 6 — **open-source voice** (4: Agent Browser JSON, [`browser-scripts.md`](browser-scripts.md); 6: hardening) |
| Files | `packages/shared/voiceEngines.js`, `apps/gateway/migrations/015_voice_endpoints.sql`, `apps/gateway/src/voice.js`, `apps/gateway/server.js` (raw/binary body support + 6 routes), `apps/gateway/src/rbac.js` (3 permissions), `src/voice/capture.js`, `src/copilot/voiceInput.js`, `src/copilot/panel.js`, `src/voice.js` (Speech hosts card), `src/api.js`, `src/core.js`, `src/views2.js`, `packages/shared/api-routes.json` |
| Evidence | `npm run test:voice-stt` (**16 passed**, real gateway + a real loopback speech host) · `npm run test:voice-input:ui` (**10 passed**) · `npm run test:voice-input:browser` (**5 passed** in real Chromium with a real MediaRecorder and a real fake microphone) · `npm run test:voice` 48 · `npm test` (48 suites) · `npm run build` |
| Status | **PASS for the voice-input scope.** A person can now speak, have the audio transcribed by a host on their own network, and read the transcript before it is sent. TTS was already shipped (Voice Studio); this unit adds the missing half — and the licence facts to go with both. |
| Licences | Verified against upstream this session — [`docs/voice/OPEN_SOURCE_VOICE.md`](../voice/OPEN_SOURCE_VOICE.md) |

---

## 1. The gap this unit closed

Voice Studio already had a **synthesis** contract (`/health`, `/v1/audio/speech`, loopback-only, size and
timeout caps, sentence queue with generations and abort). Speech **input** had exactly one path: the
browser's `SpeechRecognition`, which is network-backed in every shipping browser — so the Copilot could
either upload audio to a vendor or not listen at all. That is not "open-source voice"; it is one vendor
path with a consent screen.

Unit 5 adds the missing half:

> A speech host the **operator** runs, configured on the **gateway**, reached through the gateway, with the
> microphone captured by the browser and the audio forwarded — and a transcript that arrives in the
> composer **for review**, not already sent.

Three transports, in this order, decided from facts rather than preference:

| Order | Transport | Where the audio goes | Consent |
| --- | --- | --- | --- |
| 1 | `local-stt` — recording posted to the gateway, forwarded to the operator's host | a host on **your** network | `localSttConsent` |
| 2 | `browser-recognition` — the platform recogniser | a browser/OS **vendor service** | `networkRecognitionConsent` |
| 3 | `text` | nowhere | none, and never gated |

The two consents are separate on purpose: allowing one must never quietly allow the other. Both are in
Settings → Voice & speech, and both are asked in the panel at the moment they are needed.

## 2. Why the host lives on the gateway

Not an architectural preference — three constraints that all point the same way:

- an HTTPS-hosted PWA **cannot** POST a clip to a plain-http LAN host (mixed content), but the gateway
  sits next to the host and can;
- an endpoint is a **capability**, so it needs a permission, an audit trail and a life-cycle — none of
  which a value in `localStorage` has;
- the browser never learns the host's address, so a modified client cannot redirect a recording.

```text
mic ──► MediaRecorder ──► POST /api/v1/voice/transcribe (raw audio/*) ──► gateway
                                                                          │  loopback-validated row
                                                                          ▼
                                                    POST <host>/inference   (multipart)
                                                    POST <host>/v1/audio/transcriptions
                                                                          │
                         {text, engine, stayedLocal, elapsedMs} ◄─────────┘
```

## 3. The contract, exactly as it exists

Two transcription shapes, because two real things exist. The endpoint row says **which**; nothing is
guessed at run time.

| Mode | Path | Fields MMM sends | Why |
| --- | --- | --- | --- |
| `whisper.cpp` (default) | `POST /inference` | `file`, `response_format=json`, `temperature=0.0` | whisper.cpp's own server documents exactly these. It does **not** document a `language` field — language is a server flag — so none is sent. |
| `openai` | `POST /v1/audio/transcriptions` | `file`, `model`, `response_format=json`, `language` | the shape OpenAI-compatible wrappers (e.g. over faster-whisper) expose. |

Both answer `{"text": "…"}`. `GET /health` is probed but **optional**: a `404` is recorded as
`no-health-endpoint`, not as a failure, because whisper.cpp's server ships no health route and calling that
"down" would train people to ignore the status.

Endpoint validation (`validateVoiceEndpoint`): `http`/`https` only, no credentials in the URL, no query or
fragment, loopback unless `MMM_VOICE_ALLOW_REMOTE=1` (and then HTTPS only), and it refuses a URL that
already carries the request path — the most common misconfiguration, and one that otherwise fails as a
mysterious 404 *after* a recording has been uploaded.

## 4. Nothing spoken is stored

There is no audio column, no transcript column and no history table. `voice_endpoints` stores *hosts*.
A transcription is returned to the caller and dropped; the audit row records
`{endpointId, engine, mode, bytes, elapsedMs, empty}` — never words. Both the gateway suite and the
real-browser suite walk **every table in the database** and assert that the transcript string appears
nowhere in it.

## 5. Routes and permissions

| Method | Path | Permission | What it does |
| --- | --- | --- | --- |
| GET | `/api/v1/voice` | `voice:read` | capabilities: local STT present, the engine catalogue with licences, limits |
| GET | `/api/v1/voice/endpoints` | `voice:read` | configured hosts and their last health result |
| POST | `/api/v1/voice/endpoints` | **`voice:configure` (Owner)** | add a host; refuses anything that is not loopback by default |
| PATCH | `…/endpoints/:id` | `voice:configure` | edit / disable |
| DELETE | `…/endpoints/:id` | `voice:configure` | remove (the audit row stays) |
| POST | `…/endpoints/:id/check` | `voice:read` | health probe, persisted on the row |
| POST | `/api/v1/voice/transcribe` | `voice:transcribe` (Operator) | the audio body, forwarded and dropped; 20/min per principal |

`voice:configure` is Owner-only because an endpoint decides where a recording may be sent. The transcribe
route is the only route in the gateway that accepts a **binary** body: `bodyLimit` is raised for it alone
(6 MB), declared `content-length` is checked first, an oversized body is a 413 *before* the host is
contacted, and a non-audio content type is a 415.

## 6. What the panel does

- **Records with a real `MediaRecorder`** (`src/voice/capture.js`): secure-context and container probed
  before the mic is offered, permission errors mapped to `permission-denied` / `no-microphone` /
  `microphone-busy` / `insecure-context`, tracks released on stop, cancel, error **and** the two-minute
  cap.
- **Stop** finishes the clip and uploads it. **Discard** (a control that exists only while recording)
  throws it away and uploads nothing.
- **The transcript lands in the composer, unsent.** The browser-recogniser path keeps its own behaviour (a
  final transcript sends immediately) because there the person watches the words appear; a whole-clip
  transcript arrives with no interim feedback, so reviewing it *is* the check.
- **A failure is never re-routed.** If the local host fails, the panel shows the gateway's reason
  verbatim — including its `hint` — and says typing still works. It does **not** silently re-send the
  recording to the browser's vendor recogniser, which is precisely what the consent screen exists to
  prevent.
- **Every status names the destination**: "audio goes to the speech host on your gateway and stays on your
  network", or "the browser's speech service processes audio online", or "typing is the only way in".
- **Voice Studio → Diagnostics → Speech hosts** is the operator surface: list with health status, `Check
  now`, `Remove`, and an add form. Adding requires `voice:configure`; the form is not rendered for a role
  that cannot use it, with the reason printed instead.

## 7. What was proven

`npm run test:voice-stt` — 16 checks, real gateway and a real speech host on loopback:

- no host → 409 `no-endpoint` with a hint naming whisper.cpp, and **nothing is sent anywhere**;
- an Operator, a Reviewer and an Observer are all refused `POST /voice/endpoints`; an Observer can read;
- the validator refuses a remote host, embedded credentials, a `file:` scheme, a query string, and a URL
  that already carries the request path — each with a message that says what to do;
- an engine that does not serve HTTP (Piper, Kokoro, OpenVoice, NeuTTS — all three `cli`/`library`) is
  refused with "run a compatible host", rather than being offered as if it were a server;
- a clip is forwarded as multipart to `/inference` with `response_format` and **without** a `language`
  field; a prefixed mount (`/speech`) keeps its prefix and an `openai`-mode endpoint appends its own path
  and *does* send `language` and `model`;
- **nothing spoken is stored** — the transcript string appears in no table, and the audit row holds only
  bytes/engine/outcome;
- a 500 from the host → 502 with the host's status and no `text`; a 200 without `text` → 502 `bad-response`;
  a prose body → 502; a genuinely silent clip → 200 with `empty: true`;
- an oversized clip → 413 and the host is never contacted; a `text/plain` body → 415; an empty recording →
  415;
- a host that never answers → 504; a dead port → 502 `unreachable`; a disabled endpoint is never chosen and
  naming it is a 409; 20 transcriptions/minute per principal, then 429;
- health: `available` → `no-health-endpoint` (404) → `unreachable` (socket dropped), each persisted on the
  row;
- capabilities report the catalogue with SPDX ids, a `verifiedVia` pointing at the upstream licence, and
  `allowRemoteHosts: false`.

`npm run test:voice-input:ui` — 10 checks: no path at all still names typing; a configured host asks for
the **local** consent naming the gateway (not the vendor one); the microphone is not opened before consent;
stop posts exactly one clip with an audio content type and leaves the transcript in the composer **unsent**;
discard uploads nothing and releases the tracks; a failed transcription is shown in the gateway's words and
does **not** fall back to the recogniser (asserted with a recogniser present); a refused microphone is named;
a browser that cannot record falls back to the recogniser and says why; a silent clip is "heard nothing"
and sends nothing; text input works through all of it; and the chain itself is asserted without a DOM
(local → network → text, offline → text, nothing → text).

`npm run test:voice-input:browser` — 5 checks in **real Chromium** with
`--use-fake-device-for-media-stream`: the Owner adds a host from Voice Studio and sees it come back
`reachable`; a non-loopback host is refused with a 400 that names loopback; the Copilot shows the local
consent, records two seconds with a real `MediaRecorder`, posts **>1 kB of real WebM** to the host at
`/inference`, and leaves the transcript in the composer with zero messages sent to the Copilot; the
transcript appears in no table and no audit row; and the dock plus the host card fit 320 px with 44 px
controls and no page errors.

## 8. Honest limits

- **No speech host ships with MMM.** Everything above is a contract, and this repository does not vend a
  whisper binary or weights. With no host configured the panel says so and falls back — it never claims
  local transcription is happening.
- **The microphone is the platform's.** A clip is whatever `MediaRecorder` produced on that device
  (`audio/webm;codecs=opus` in Chromium); MMM does not re-encode, because a browser-side ffmpeg would be a
  much larger dependency than the problem it solves.
- **A transcript is a guess until a person reads it** — which is why the local path does not auto-send and
  why nothing is written to the conversation until the person presses send.
- **Licence verification is per-repository, not per-artifact.** The SPDX ids were read from
  `api.github.com/repos/<owner>/<repo>/license` on 2026-11-02; model **weights** and demo assets can carry
  their own terms, and the catalogue says so where it matters
  ([`docs/voice/OPEN_SOURCE_VOICE.md`](../voice/OPEN_SOURCE_VOICE.md)).
- **No streaming transcription.** A clip is uploaded whole and answered whole; there is no partial
  transcript, so there is no "speak and watch it appear" on the local path.
- **Not built**: TTS through the gateway (Voice Studio's local TTS host adapter is browser-side and stays
  that way), and the hardening pass (unit 6).
