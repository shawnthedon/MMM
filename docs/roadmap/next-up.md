# Next up — open work with acceptance criteria

Written to be picked up cold, without the chat that produced it. Each item lists the files, the data
model, the edge cases that matter, and "done when" checks that a test can assert.

Last updated: 2026-10-27 · Baseline: Kanban board shipped (`npm run test:kanban` 26/26); next up is live Comms then Local AI phase 2.

---

## 1. ✅ Kanban board: zoom, dependency wires, drop confirmation, Copilot control — SHIPPED

All acceptance criteria below are met; the implementation notes and the limits that remain are in
[`../kanban/board.md`](../kanban/board.md), evidence is `npm run test:kanban` (26 checks).

- Zoom `− 100% + Fit`, 10 % steps, clamped 70–150 %, persisted on the workspace store. Implemented as
  `--kb-zoom` + CSS `zoom` on the board track rather than `transform: scale()`: a transform does not
  extend the scrollable area (far columns become unreachable) and would scale hit targets
  inconsistently. Drops land in the column under the pointer at every level with no pointer-delta
  arithmetic because `elementFromPoint` stays truthful.
- Wires: inert SVG overlay, one curve + arrowhead per dependency edge, recomputed on
  render/resize/scroll/zoom/drag, endpoints-missing edges skipped and counted, done-blockers dimmed,
  auto-on below 900 px with a chip override.
- Confirmation on every move (drag, drawer chips, Copilot) via `confirmModal`, which now resolves
  `'confirm' | 'cancel'`; cancel changes nothing and logs nothing, confirm writes one change and one
  event.
- One seam (`src/kanban.js`) with the full Copilot intent set; gateway moves go through
  `PATCH /api/v1/tasks/:id` (`task:write`) and report refusals.
- Not done (deliberately, no endpoint/column exists): server-side dependencies, card ordering,
  delete on a gateway. These refuse rather than pretend.

## 2. Comms: make the gateways live

Already built: channel catalogue, adapters, signature verification, panel, routing, Copilot seam,
18/18 tests. Missing: **persistence and routes**.

1. **Migration** `comms_channels` (id, workspace, channel, config_ciphertext, enabled, verified_at,
   last_test, created_by, updated_at) + `comms_messages` (direction, channel, body_redacted, status,
   provider_id, created_at). Encrypt secrets with a key derived from `SWARMOS_SECRET`.
2. **Routes** (RBAC `comms:read`/`comms:write`, audit every call):
   ```
   POST /api/v1/comms/:channel/inbound    signature-gated, CSRF-exempt
   GET  /api/v1/comms/:channel/verify     Meta hub.challenge, Slack url_verification
   POST /api/v1/comms/:channel/send       server-side delivery only
   GET  /api/v1/comms/status              status + last test, never secrets
   ```
   Wire them straight to `handleInbound()` / `deliver()` from `src/comms*.js` — the logic exists.
3. **Move credentials server-side**: the browser stops storing secrets; the panel reads masked values
   only. The panel already displays `••••last4` and never echoes values.
4. **Outbound queue** with retry/backoff, per-channel rate limit, quiet hours, redaction in logs.
5. **Agent fan-out**: task-done / approval-needed / run-failed events → `routesFor(agentId)`.
6. **Web Push** for the browser channel (VAPID), so alerts arrive outside an open tab.
7. Provider limits to respect: Meta 24-hour window (templates), Discord 3 s ACK, Slack 3 s ack +
   `response_url`, Twilio signature URL.

**Done when:** a real Telegram message sent from the panel appears in Telegram, an inbound `/status`
gets an answer, the same message shows in `comms_messages` with the provider id and in the audit
chain, and no secret is ever returned by `GET /api/v1/comms/status`.

**Credentials needed:** see [`../comms/credentials.md`](../comms/credentials.md).

---

## 3. Local (on-device AI) — phases 2–6

**Spec:** [`../local/MMM_On_Device_AI_Design_Specification.md`](../local/MMM_On_Device_AI_Design_Specification.md)
**Phase-1 audit:** [`../local/on-device-audit.md`](../local/on-device-audit.md)
**Screen today:** `#/local` measures the platform and claims nothing else (`npm run test:local`).

Order of work, each gated on real evidence:

1. **Cross-origin isolation** — add `Cross-Origin-Opener-Policy: same-origin` and
   `Cross-Origin-Embedder-Policy: require-corp` to the Vite dev server and `vercel.json`; confirm
   `crossOriginIsolated === true` in the preflight (this alone moves threads from "off" to
   "available"). Watch for third-party assets that break under COEP.
2. **Runtime spike (phase 2)** — pick and licence-check a WASM GGUF runtime (llama.cpp/ggml build or
   prebuilt `.wasm`), ship it behind `src/localRuntime.js`, load one small Q4 model from OPFS, and
   record: bundle size, load time, tokens/sec, peak memory, thermal notes — on a real device, in
   airplane mode. No UI beyond a spike route until this passes.
3. **Model manager (phase 3)** — `listModels/importModel/downloadModel` with persisted lifecycle
   states (spec §6), real progress/cancel/resume where the host supports it, SHA-256 verification and
   atomic promote of partial files. Metadata in IndexedDB, never `localStorage`.
4. **Offline text (phase 4)** — streaming `generateText` + `stopGeneration`, local history, and a
   network-log test proving no prompt/response leaves the device.
5. **Image feasibility (phase 5)** then feature (phase 6) — only with recorded real-device
   measurements; otherwise the UI keeps an explicit *unavailable* state.

**Rules that must survive implementation:** no silent cloud fallback, no fabricated progress or
images, no controls that do nothing, and every "PASS" backed by a captured measurement rather than
code inspection.

## 4. Housekeeping queued from the same conversation
- Header: workspace-name text removed (done); Chat moved into the header (done) — revisit if a
  fourth header action is ever added, the 34 px floor at <380 px must hold.
- Skills Matrix is no longer in the More panel; it stays reachable from the Skills Hub header, every
  skill drawer, and `#/matrix`. Do not remove the route — the title bar and tests rely on it.
