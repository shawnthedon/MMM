# Open-source voice — what the licences actually say

MMM will only send speech to engines that are open source and run on hardware the operator controls. This
page is the evidence for that claim, kept separate from the feature pages so it can be checked without
reading code.

**How to read the table.** `verified` means the SPDX identifier below was read from the upstream
repository's own licence file through the GitHub API on the date shown — not from a README badge, a blog
post or memory. `advertised` means the project claims the licence but this build has not re-read it; those
entries are listed for completeness and are **not** offered as endpoints.

| Engine | Roles | Licence (SPDX) | Licence file | Upstream | Verified | Serves HTTP? |
| --- | --- | --- | --- | --- | --- | --- |
| whisper.cpp | stt | **MIT** | `LICENSE` | [`ggml-org/whisper.cpp`](https://github.com/ggml-org/whisper.cpp) | **verified** 2026-11-02 | **yes** — `POST /inference`, multipart `file`, `response_format=json` |
| faster-whisper | stt | **MIT** | `LICENSE` | [`SYSTRAN/faster-whisper`](https://github.com/SYSTRAN/faster-whisper) | **verified** 2026-11-02 | no — a Python library; the HTTP surface comes from a wrapper the operator runs |
| Piper | tts | **MIT** | `LICENSE.md` | [`rhasspy/piper`](https://github.com/rhasspy/piper) | **verified** 2026-11-02 | no — CLI/library; needs a wrapper |
| Kokoro | tts | **Apache-2.0** | `LICENSE` | [`hexgrad/kokoro`](https://github.com/hexgrad/kokoro) | **verified** 2026-11-02 | no — Python package |
| OpenVoice | tts, clone | MIT (project's claim) | `LICENSE` | [`myshell-ai/OpenVoice`](https://github.com/myshell-ai/OpenVoice) | advertised | no — library; Voice Studio's cloning contract needs a host |
| NeuTTS Air | tts, clone | Apache-2.0 (project's claim) | `LICENSE` | [`neuphonic/neutts`](https://github.com/neuphonic/neutts) | advertised | no — library; other NeuTTS variants differ |

Verification method, so it can be repeated:

```bash
curl -sSL https://api.github.com/repos/ggml-org/whisper.cpp/license \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.license.spdx_id,j.name,j.path)})"
# → MIT LICENSE LICENSE
```

`ggml-org/whisper.cpp` is the current home of whisper.cpp: `ggerganov/whisper.cpp` now returns
`301 Moved Permanently`, which is why older notes in this repository name the old path.

## What "verified" does not cover

- **Weights.** A permissively licensed *inference implementation* says nothing about the model weights it
  loads. Whisper weight files, Kokoro voice packs and cloned-voice references can carry their own terms.
  MMM records the code licence and says so; it does not assert anything about the weights.
- **Wrappers.** `faster-whisper` is MIT; the HTTP wrapper the operator chooses to put in front of it is a
  separate project with a separate licence.
- **Hosting.** These are all local-first engines, but nothing stops someone pointing MMM at a remote host.
  That is why `MMM_VOICE_ALLOW_REMOTE=1` exists and why remote endpoints are marked `remote` wherever they
  appear in the UI and in the capability payload.

## What MMM actually integrates today

| Capability | Status | Where |
| --- | --- | --- |
| Speech synthesis, device engine | **works now** (measured at runtime) | `src/voice/adapters.js`, Voice Studio |
| Speech synthesis, local host | **works when a host is configured** — `GET /health`, `POST /v1/audio/speech` | `src/voice/adapters.js` |
| Speech **recognition**, local host | **works when a host is configured** — `POST /inference` or `POST /v1/audio/transcriptions`, via the gateway | `apps/gateway/src/voice.js`, [`../copilot/voice-input.md`](../copilot/voice-input.md) |
| Speech recognition, browser service | works, but **network-backed** and therefore opt-in per browser | `src/copilot/panel.js` |
| Voice cloning | **blocked** until a cloning host and a recorded consent decision exist | `src/voice/adapters.js` |

No proprietary or hosted speech provider is wired in anywhere, and no code path selects one. The gateway's
speech routes talk only to the endpoints an Owner configured, and those are loopback by default.
