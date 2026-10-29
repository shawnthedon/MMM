# End-to-end issue mission — evidence and outstanding work

Date: 2026-10-28. This records the scope actually implemented and tested on the mission branch;
it is not an acceptance certificate. The requested `Copilot_Master_MMM_V2.md` was not present in
this checkout. `docs/DESIGN_SPEC.md` exists but does not replace the missing master contract.

## Stage status

| Stage | Status | Evidence / remaining acceptance work |
| --- | --- | --- |
| 1. Discovery and frontend/gateway | **Partial** | The historical Phase 0 report now has a current reconciliation. Client request epochs and cancellation prevent late requests adopting a previous identity; 401 clears session and CSRF, cached data and comms. Comms controls write through to the gateway; unauthorised API mode fails closed. Static-only SW caching removes old app caches and bypasses dynamic/API requests. Tests cover controlled races and actual Chromium SW behavior. Full contract/reconnect, cross-tab and production deployment acceptance is not established. |
| 2. Copilot governance | **Partial, not complete** | Gateway RBAC, CSRF, audit and approval separation are exercised against real HTTP. WebSockets now check browser origin and revalidate the credential on message/broadcast. API-mode Copilot channel mutations are blocked. There is still no server-side operation/parameter-bound approval, expiry/replay protection for execution, comprehensive risk policy or budget enforcement. Existing CRUD routes cannot be assumed to meet those requirements. |
| 3. Training Studio | **Not implemented** | The local GGUF spike is inference, not training. There is no validated dataset/job/worker/result pipeline or model artifact registry. Inspection does not verify schema, safety or data rights and is explicitly not an audit or completed training. A compatible engine and method, resource policy, dataset contract, secure persistence and real execution/cancellation tests are still needed. |
| 4. Voice Studio | **Not implemented** | No TTS, STT, voice-cloning or singing engine is integrated. See candidate review below. Actual inference, consent/profile storage, model/dependency licences and mobile resource tests are still required. |
| 5. OpenSMS and browser control | **Not implemented** | OpenSMS is not Twilio. Its upstream API was reviewed below, but a secure configured adapter, approved network topology, operation-bound approvals and authorised device test are still needed. Browser comms is an in-app message channel, not automation. No isolated browser-control adapter, origin policy, approval-bound effects or safe execution tests exist. |
| 6. Final verification | **Partial** | See commands below. The test suite and local browser checks do not establish deployment, real external provider delivery, full mobile-device behavior or completion of stages 1–5. No lint script exists in `package.json`. |

## Upstream investigation (source review, not execution)

* [OpenSMS source, commit `333b1fd8d8dee061902e3bb03859d76ec7c9fe7f`](https://github.com/daslearning-org/OpenSMS/tree/333b1fd8d8dee061902e3bb03859d76ec7c9fe7f): repository licence Apache-2.0. `app/services/postApi.py` exposes `POST /sms/`, Bearer API key, JSON `{number,text}`, and returns `{stat}` after calling Android SMS code. HTTP 200 is not success unless `stat` is true, and even that is dispatch, not a carrier delivery receipt. Port 9292 and Android-owned lifecycle are defaults; `/control/` is unauthenticated placeholder code and must not be used for remote lifecycle control. OpenSMS's plain HTTP topology would expose a Bearer token unless protected by an authorised secure transport. No Android device, permission, API key or reachable instance was supplied.
* [OpenVoice, commit `74a1d147b17a8c3092dd5430504bd83ef6c7eb23`](https://github.com/myshell-ai/OpenVoice/tree/74a1d147b17a8c3092dd5430504bd83ef6c7eb23): upstream README describes voice cloning and says V1/V2 are MIT. This is not evidence of singing, browser/mobile compatibility, consent handling or all weight/dependency licences.
* [NeuTTS, commit `ac69851f28fc63a487917e7c2e27f0d75c759cba`](https://github.com/neuphonic/neutts/tree/ac69851f28fc63a487917e7c2e27f0d75c759cba): upstream describes TTS with separate language model and audio codec; lists Air as Apache-2.0 and Nano/2E under NeuTTS Open License 1.0. Its published phone benchmark measures only the language model, not the full codec pipeline. We did not obtain or validate the weights, dependencies, licence terms, full mobile runtime, speech synthesis, STT or singing. `Local TTS` is not identified sufficiently for a source/licence review.

## Security and compatibility notes

* SW `mmm-v3` deletes older `mmm-*` caches on activation; the old worker can still serve its
  old cache until a client updates and activates the new worker. Client requests bypass CacheStorage;
  browser tests use a real same-origin mock gateway. This is not a cross-browser acceptance test.
* A failed logout clears the local session and warns that server revocation was not confirmed;
  the server cookie may still be valid. No client can guarantee revocation during a network outage.
* WebSocket origin checks permit the explicit CORS allowlist and same-host browser origins. A
  reverse proxy must preserve the external Host or configure `MMM_CORS_ORIGIN`. No-Origin
  non-browser clients remain supported. Revoked credentials are rejected at the next inbound
  message or outbound broadcast, not by a periodic disconnect timer.
* SMS `baseUrl` is restricted to `https://api.twilio.com`, with redirects refused. Existing custom
  endpoints stay stored but cannot send. Twilio webhooks now use the exact configured URL and
  base64 HMAC; Meta webhooks require a separately configured `appSecret`. Existing WhatsApp
  configurations must add that field for inbound use. No genuine provider has been contacted.
* Direct sends bypass the queue's per-minute limit, outbound requests lack complete operation-bound
  approval and budget controls, inbound sender identity mapping is incomplete, and queued message
  redaction can change message content. These remain production blockers; do not expose the gateway
  as a fully governed automation system.

## Verification performed

* `npm ci --no-audit --no-fund --ignore-scripts` — dependencies installed. SQLite tests use the
  repository's Node SQLite fallback; native `better-sqlite3` compilation was not verified.
* `npm test` — full repository suite, including session, worker, provider and persistence regressions.
* `npm run build` — Vite production build succeeded with existing mixed static/dynamic import warnings.
* `npm run test:gateway` — real local HTTP/WebSocket RBAC, origin and revocation regression checks.
* `npm run test:training-jsonl` — bounded inline JSONL syntax, malformed rows, limits and error redaction (not a model-ready dataset validator).
* `npm run test:comms-gateway` — real local gateway with controlled provider mocks, including Twilio
  form signature and refusal of a private outbound target. Mock success is not provider acceptance.
* `LD_LIBRARY_PATH=/tmp/chromium-libs/lib npm run test:isolation:browser` — real Chromium online and
  offline shell retained cross-origin isolation after worker activation.
* `LD_LIBRARY_PATH=/tmp/chromium-libs/lib npm run test:sw-safety:browser` — actual service worker
  sent two test identities to the gateway, did not cache the API, and failed closed offline; home,
  agents, tasks and comms did not horizontally overflow at 320 px. This does not cover all screens,
  target sizes, browsers, or real mobile devices.
* `git diff --check` — whitespace check. No repository lint script is defined.

Optional browser tests require `@sparticuz/chromium` and `puppeteer-core`, installed temporarily
without adding runtime dependencies; the Linux Chromium library bundle was extracted under `/tmp`.
