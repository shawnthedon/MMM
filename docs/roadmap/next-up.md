# Next up — open work with acceptance criteria

Written to be picked up cold, without the chat that produced it. Each item lists the files, the data
model, the edge cases that matter, and "done when" checks that a test can assert.

> **Execution order lives elsewhere.** The ordered plan out of demo mode is
> [`../PRODUCTION_ROADMAP.md`](../PRODUCTION_ROADMAP.md) (tracks L0–L8 + NFR checklist). This file keeps
> the per-item acceptance criteria for work that is already specified.

Last updated: 2026-10-28 · Experimental Local AI runtime ran a tiny model in an externally disconnected Linux network namespace; deployed host and mobile devices remain unverified. Runtime phase 2 has not passed.

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

## 2. ✅ Comms: make the gateways live — SHIPPED

Done in this round: migration 003 (`comms_channels`, `comms_messages`, `comms_settings`), route set
with `comms:read`/`comms:write`, AES-256-GCM credentials server-side (masked on every read, never
persisted by the browser), delivery rows per attempt with backoff/quiet hours/rate limit, idempotent
sends, redaction, signature-gated inbound with replay dedupe and provider handshakes, fan-out from
task-done / approval-needed, and a panel that states where the secrets live.

Evidence: `npm run test:comms-gateway` (27) and `npm run test:comms` (22). Doc:
[`../comms/server-side.md`](../comms/server-side.md), credentials per channel in
[`../comms/credentials.md`](../comms/credentials.md).

Still open (smaller, ordered):

1. **Discord interactions** — Ed25519 verification with the app public key (the adapter refuses today,
   which is why Discord inbound is unusable).
2. **Web Push (VAPID)** for the browser channel, so alerts arrive outside an open tab. Needs a key
   pair, `push_subscriptions`, and a service-worker `push` handler.
3. **Worker split** — the retry ticker is in-process and `unref`'d. Move it to a loop or a separate
   process so retries survive a gateway restart schedule.
4. **Provider rate-limit headers** — parse `Retry-After` / `x-ratelimit-*` instead of only our counter.
5. **Template selection** for WhatsApp outside the 24-hour window (adapter already supports it).
6. **Key rotation** for `SWARMOS_SECRET` (a key ring with versioned ciphertext).

## 3. Local (on-device AI) — phases 2–6

**Spec:** [`../local/MMM_On_Device_AI_Design_Specification.md`](../local/MMM_On_Device_AI_Design_Specification.md)
**Phase-1 audit:** [`../local/on-device-audit.md`](../local/on-device-audit.md)
**Screen today:** `#/local` measures the platform and claims nothing else (`npm run test:local`).

Order of work, each gated on real evidence:

1. **Cross-origin isolation (in progress)** — COOP/COEP configured for Vite dev/preview and Vercel;
   service-worker cache bumped. Built preview passed a desktop Chromium online/offline browser check.
   Confirm on the deployed top-level app and intended mobile devices; check embedded previews and
   third-party integrations under COEP/COOP. Evidence: [`../local/cross-origin-isolation.md`](../local/cross-origin-isolation.md).
2. **Runtime spike (phase 2, in progress)** — separate `local-spike.html` and `src/localRuntime.js`
   load an imported GGUF from OPFS using pinned wllama and stream raw completions. Desktop Chromium
   page-offline test ran a tiny mixed-Q4 fixture; the worker remained network-capable. Follow-up
   verification covers worker observation during generation, stop, interrupted writes and corrupt
   model rejection; an externally disconnected Linux namespace run passed, but is not mobile
   airplane-mode proof. Finish binary licensing review, deployment and
   intended-device airplane-mode testing, network audit, real performance/memory/thermal evidence
   and lifecycle failures before marking PASS. Evidence and limits:
   [`../local/runtime-spike-research.md`](../local/runtime-spike-research.md).
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
