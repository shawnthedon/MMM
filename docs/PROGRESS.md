# 📍 SwarmOS — Development Progress Tracker

> Live status of the build-out described in [`IMPLEMENTATION_CHECKLIST.md`](IMPLEMENTATION_CHECKLIST.md)
> (functional) and [`IMPLEMENTATION_ROADMAP.md`](IMPLEMENTATION_ROADMAP.md) (non-functional).
> Update this file in every development PR.

**Legend** ⬜ not started · 🟨 in progress · ✅ done · ⏭ deferred

---

## Phase 0 🧰 Environment & Orientation — ✅
- ✅ Node 20 + git + Vite toolchain running
- ✅ `npm run dev` / `build` / `preview` / `smoke` all green
- ✅ Code tour documented in checklist

## Phase 1 🏗 Restructure the application — 🟨
- ✅ **1.3** API contract started — `packages/shared/api-routes.json` (implemented + planned routes)
- ⬜ 1.1 Full monorepo move (`apps/web`, npm workspaces) — web app stays at root for now to keep the PWA shipping
- ⬜ 1.2 Full state-layer extraction (`store.js` / `api.js` split)
- ⬜ 1.4 `.env` config for gateway (`PORT`, `DATA_DIR`)
- ⬜ 1.5 ESLint + Prettier tooling

## Phase 2 💾 Database & sample data — 🟨
- ✅ **2.1** SQLite (WAL) integrated — `better-sqlite3`, `apps/gateway/src/db.js`
- ✅ **2.2** Migration runner + `001_init.sql` (17 tables: agents, teams, swarms, tasks, approvals, events, skills, plugins, providers, policies, threads, messages, files, settings, jobs, principals, audit_log, migrations) — `npm run migrate`
- ✅ **2.3** Sample data as fixtures — `fixtures/*.json` generated from the canonical prototype seed (`npm run export-fixtures`); restore with `npm run seed` / `npm run seed -- --reset`
- ⬜ 2.4 Backup/restore tooling (`npm run backup` / `restore`)
- ✅ **2.5** Frontend API mode — client + auth + writes **and read sync**: `src/datastore.js` adopts
  agents/tasks/approvals/events from `GET /api/v1/*` when a session exists, follows the WS and
  re-syncs on focus, writes through to the gateway (server copy wins, no duplicates), and never
  lets gateway rows reach `localStorage`. Every screen states its source (`src/sourceui.js` chip +
  banner/sheet); a failure downgrades to demo or labels the rows stale instead of mixing them.
  Evidence: `npm run test:readsync` (12 checks). Design + limits: [`copilot/read-sync.md`](copilot/read-sync.md).

### Kanban board — zoom, wires, confirmed moves, Copilot control — ✅
- ✅ **One write seam** — `src/kanban.js` owns every board mutation (`moveTask`, `commitMove`,
  `assignTask`, `setPriority`, `renameTask`, `linkDeps`, `unlinkDeps`, `deleteTask`, `setZoom`,
  `toggleWires`, `setFilter`, `boardStats`). Drag-and-drop, the card drawer and the Copilot all call
  it, so there is no second path to the data.
- ✅ **Zoom** — `− 100% + Fit` toolbar, 10 % steps, clamped 70–150 %, persisted in the workspace store
  (survives re-render and reload), applied as `--kb-zoom` + CSS `zoom` on the board track so every
  card scales together and drops stay accurate at any level.
- ✅ **Dependency wires** — inert SVG overlay over the board, one curve + arrowhead per `deps` edge,
  recomputed on render/resize/scroll/zoom/drag; edges with a missing endpoint are skipped and counted,
  edges whose blocker is done are dimmed; auto-on below 900 px with a Wires chip to override.
- ✅ **Confirmation on every move** — drop, drawer chip and Copilot all go through `moveTask` →
  `confirmModal`; cancel changes nothing and logs nothing, confirm applies one change and one event.
- ✅ **Copilot control** — move / assign / unassign / priority / rename / link / unlink / delete
  (two-step) / create / zoom / wires / filter / board status, with refusal instead of guessing on
  ambiguous cards, unknown columns and dependency cycles.
- ✅ **Honesty** — gateway moves use `PATCH /api/v1/tasks/:id` (`task:write`) and report refusals;
  dependencies and deletes are refused on a gateway because no endpoint/column exists.
- ✅ Evidence: `npm run test:kanban` (26 checks). Design + limits: [`kanban/board.md`](kanban/board.md).

### More panel — module grid — ✅
- ✅ Four tiles per row at every width with fixed geometry (92/98 px height, 38 px icon badge,
  two-line label with reserved height), so icons line up and every tile is exactly the same size.
- ✅ Replaced per-tile inline sizing/avatars with `.mod-tile`; 12 modules = 3 tidy rows.

### Local (on-device AI) — 🟨 preflight + isolation prerequisite
- ✅ **Entry point** — new **Local** tile in the More panel (badged *new*), route `#/local`.
- ✅ **Phase-1 audit** — [`local/on-device-audit.md`](local/on-device-audit.md) records MMM's real
  platform (Vite PWA, no native shell, localStorage + gateway SQLite, no IndexedDB/OPFS yet), the
  smallest viable integration and remaining risks: deployed isolation, runtime licence, OPFS storage,
  no native background downloads, image feasibility unproven.
- ✅ **Preflight screen** — measures the device live: secure context, WebAssembly, WASM SIMD,
  threads/COI, WebGPU + adapter, OPFS, persistent storage, quota/free bytes, memory hints; verdict
  `blocked` / `constrained` / `spike-ready` with actionable reasons.
- ✅ **Honesty** — no model bundled or downloaded; the preflight has no inference control and links to
  the separate experimental spike. No cloud fallback; presets remain unverified.
- ✅ Evidence: `npm run test:local` (13 checks).
- 🟨 **Isolation prerequisite** — COOP/COEP on Vite dev/preview + Vercel and service-worker cache
  upgrade. HTTP/config checks pass; headless desktop Chromium verified online/offline isolation and
  shared WASM memory on the built preview. Deployed Vercel and intended mobile devices remain
  unverified. Evidence: [`local/cross-origin-isolation.md`](local/cross-origin-isolation.md).
- 🟨 **Phase 2 experimental runtime** — a separate spike imports a user-provided GGUF to OPFS,
  prepares same-origin wllama WASM, then loads, streams raw completion, stops and unloads locally.
  Desktop Chromium ran a tiny mixed-Q4 model with network disabled; mobile/device airplane-mode,
  complete binary-licence review, memory/thermal measurements and broader lifecycle tests remain
  open. No weights bundled. Details: [`local/runtime-spike-research.md`](local/runtime-spike-research.md).
- ⬜ Phases 3–6 (model manager, offline text product, image feasibility/feature) — not started.

### Comms — server-side credentials + routes — ✅
- ✅ **Migration 003** — `comms_channels` (encrypted config, routing, verification), `comms_messages`
  (one row per attempt, dedupe key, retry cursor), `comms_settings` (quiet hours, rate limit, retries).
- ✅ **Encryption at rest** — AES-256-GCM with a key derived from `SWARMOS_SECRET` (HKDF-SHA256); a
  generated `data/.comms-key` with a warning only when the env var is absent. Tampered ciphertext
  decrypts to nothing instead of guessing. API returns `••••last4`; a masked value sent back is
  ignored, never stored over the real secret.
- ✅ **Routes** — `GET /comms`, `PUT /comms/settings`, `GET /comms/messages`, `PUT|DELETE /comms/:channel`,
  `POST /comms/:channel/send`, `POST /comms/queue`, plus public `GET /comms/:channel/verify` and
  `POST /comms/:channel/inbound`. `comms:read` for every role, `comms:write` from Operator; every call
  audited (including refusals).
- ✅ **Delivery honesty** — one `comms_messages` row per attempt; verified only by a provider-accepted
  send; `4xx` fails, network/timeout/rate-limit/5xx queue with `30s→2m→5m→15m` backoff up to
  `retryLimit`, per-channel rate limit defers, quiet hours hold (`202`), `dedupeKey` makes sends
  idempotent, bodies redacted (tokens, bearers, phone numbers).
- ✅ **Inbound** — signature first over the raw body (Telegram secret token, Meta HMAC, Slack v0 with
  a 5-minute replay window, Twilio form params), `x-swarmos-delivery` dedupe, deterministic commands
  from gateway rows, gated commands refused, replies delivered through the same path.
- ✅ **Fan-out** — task-done and approval-needed enqueue to channels routed to that agent; delivery
  happens in the queue worker, so an outage delays instead of losing or faking.
- ✅ **Browser** — `src/commsGateway.js` adopts masked channel state when the session holds
  `comms:read`, saves/sends through the gateway, drops it on sign-out, and the persist filter refuses
  to write gateway-owned comms to localStorage. Without a session the panel keeps its browser-only
  behaviour and states it.
- ✅ Evidence: `npm run test:comms-gateway` (27 checks, real HTTP + mocked provider) and
  `npm run test:comms` (22 — panel, adapters, browser gateway path).
- ⬜ Not done: Discord Ed25519 interactions, Web Push/VAPID, a separate retry worker, template
  selection in the panel, key rotation. Doc: [`comms/server-side.md`](comms/server-side.md).

### Mobile-first responsive audit — ✅
- ✅ Removed the last desktop-first breakpoints: every stylesheet is now authored phone-first
  (`min-width` only; `test:responsive` fails on any `max-width` query).
- ✅ Comms panel rebuilt mobile-first: single-column gateway grid that splits at 560 px, stacked
  tile bodies with clamped descriptions and wrapped capability chips, a 44 × 44 switch target, a
  separate settings button vs enable switch (no nested interactive elements), stacked delivery-log
  rows, scrollable/wrapping inbound endpoint, safe-area-aware sheet.
- ✅ Global fixes: `.kv` rows stack under 480 px, `.grid-3` is 2 columns until 520 px, setting tabs
  scroll instead of squeezing, inputs are 16 px (no iOS zoom-on-focus), compact controls are fluid,
  long strings wrap (`overflow-wrap: anywhere`), viewport allows pinch zoom.
- ✅ Evidence: `npm run test:responsive` (17 checks). Rules: [`ui/responsive.md`](ui/responsive.md).

### Comms — communication gateways — ✅ (panel + adapters), ⬜ (gateway routes)
- ✅ **Comms panel** `#/comms` (`src/comms.js`): Telegram · WhatsApp · Discord · Slack · SMS ·
  Browser, each with advanced settings — connection, routing (Copilot + agents), command surface,
  delivery & safety, inbound endpoint, live **Send test**.
- ✅ **Telegram folded in** — the old standalone module is now the first channel; the legacy
  `#/telegram` route deep-links into the panel. The More panel no longer lists Chat, Skills Matrix or
  Telegram.
- ✅ **Adapters** `src/commsAdapters.js` — request builders per provider, signature verification
  (Telegram secret token, Slack v0 HMAC + replay window, WhatsApp sha256 + GET handshake, Twilio
  HMAC-SHA1, Discord ed25519), honest delivery classification, injected `fetch` for tests.
- ✅ **Honest status model** — `not_configured → configured_unverified → verified | failed`; only a
  provider-accepted live test can mark a channel verified. Browser channel is fully local (inbox).
- ✅ **Copilot control** — `comms status`, `test <channel>`, `route <agent> to <channel>`,
  `mute/wake <channel>`, `inbox`; refuses credentials in chat.
- ✅ **Tests** `npm run test:comms` (18 checks) incl. forged/stale signatures and provider failures.
- ⬜ **Gateway persistence + routes** (`/api/v1/comms/:channel/*`, encrypted secrets, outbound queue,
  agent fan-out, Web Push) — specified in [`comms/channels.md`](comms/channels.md); credentials list in
  [`comms/credentials.md`](comms/credentials.md).

### Skills Hub + Skills Matrix (spec §6/§7 slice) — ✅
- ✅ **24-skill catalogue** — `src/skillsData.js`; 8 typed relationship types + 24 seeded edges;
  existing ids `sk-1…sk-6` preserved; `core.migrate()` merges the catalogue into saved workspaces.
- ✅ **Advanced import** — `src/skillsImport.js` + `src/skillsImportView.js`: SKILL.md frontmatter,
  skill.json, registry JSON, skill.yaml, SwarmOS portable packages and .zip/.skill bundles. Pipeline:
  parse → schema → quarantine → scan (secrets, instruction injection, unsafe paths, size) →
  dependency/version resolution → permission review → preview → install/reject → audit log.
  Imports land `pending` and never grant a tool or permission.
- ✅ **Import button next to New** in the Skills Hub, with the review sheet, skip toggles and log.
- ✅ **Skills Matrix** — `src/skillsMatrix.js`, route `#/matrix`, graph icon shortcut in the hub
  header and in every skill drawer: typed edges with distinct line styles, legend-as-filter,
  accessible table alternative, cycle/duplicate/self-link rejection, version bumps + undo, export.
  Runtime overlay is reported as *not instrumented* (no skills runtime exists).
- ✅ **Tests** — `npm run test:skills` (23 checks); smoke renders `#/matrix`.
- ⬜ Still absent: skill execution/evals, gateway `skills` table + routes, fetching skills from a URL.
- Design + limits: [`copilot/skills-hub.md`](copilot/skills-hub.md).

## Phase 3 🚪 Gateway core — 🟨 (first slice landed)
- ✅ **3.2 (slice)** REST API — agents (list/create/get/update), tasks (list/create/update), approvals (list/allow/deny), events feed, summary, dev/seed — `node apps/gateway/server.js` → `:8787`
- ✅ **3.3 (slice)** WebSocket `/ws` — live event broadcast on every mutation (topics: `agents`, `tasks`, `approvals`, `system`)
- ✅ **3.5 (slice)** Job table schema ready (leasing fields)
- ✅ Audit log v1 — hash-chained `audit_log` + `npm run audit:verify`
- ✅ **3.4 Auth + RBAC** — scrypt passwords, HttpOnly SameSite=Strict session cookies, HMAC CSRF,
  scoped `swk_` bearer tokens, 5-role matrix (Owner/Admin/Operator/Reviewer/Observer), lockout,
  authenticated + topic-filtered WebSocket, deny-by-default route map, CORS allowlist, audit of every
  mutation *and* denial. Evidence: `npm run test:gateway` (28 checks). See
  [`copilot/copilot-governance-auth.md`](copilot/copilot-governance-auth.md).
- ✅ **3.4 (client)** — `src/api.js` + `src/auth.js` + `#/login` (sign-in, account, password change,
  gateway config, honest demo-mode escape). Copilot agent/task/approval actions now go through the
  gateway with server-side enforcement. Evidence: `npm run test:auth` (16 checks).
- ⬜ 3.1 Fastify migration / schema validation
- ⬜ 3.2 rest: teams/swarms/skills/chat/files/analytics routes

## ✦ Copilot (master spec phases) — 🟨
> Spec: `docs/copilot/PHASE0_DISCOVERY.md` (discovery + blockers) ·
> `docs/copilot/copilot-ui-fab-panel.md` (module spec + evidence)

- ✅ **Phase 0** Repository discovery & contracts — every claim in the report is tied to a file;
  blockers recorded (`PHASE0_DISCOVERY.md`).
- ✅ **Phase 1** FAB + panel + holographic empty state — central bottom-nav launcher, floating
  panel (mobile sheet / desktop card), 7 modes, context strip, action tray, details drawer,
  draft/mode persistence, Escape + focus trap, reduced-motion path. Evidence: `npm run smoke`
  (28 checks) + `npm run test:copilot` (6 interaction checks) + `npm run build`.
- ✅ **Phase 1 cards** answer (with sources + verification badges), proposal (risk class, edit
  re-arms review, 5-min expiry, two-step consequential confirm), result (per-step state,
  blocked steps named), diagnostic (real `/healthz` probe), knowledge, capability, activity.
- ✅ **Phase 1 grounding (subset of Phase 2)** versioned knowledge pack with per-entry
  verification status, version, update date and source files; keyword retrieval; explicit
  "no grounded answer" instead of guessing.
- 🟨 **Phase 2** Knowledge & memory — browser-scoped working/episodic/preference memory with
  secret redaction, export, clear, and Settings kill-switch ✅. Ingestion, revision/approval,
  semantic memory, retention enforcement, server audit ⬜.
- ✅ **Phase 3 (actions)** Runtime-backed actions — with a gateway session, Copilot's agent/task
  writes and approval decisions are authorised by gateway RBAC, audited, and report the server's
  refusal verbatim. Swarm deploy remains local (no gateway route yet).
- ⬜ **Phase 4** Training Studio — **BLOCKED**: no worker, dataset decoder, checkpoint store or
  model registry. Training mode reports the blocker and runs metadata-only dataset checks.
- ⬜ **Phase 5** Voice Studio — **BLOCKED/UNVERIFIED**: candidate engines (Local TTS, NeuTTS,
  OpenVoice) not verified here; singing has no supported path and is reported unsupported.
- ⬜ **Phase 6** Communication gateway & OpenSMS — **UNCONFIGURED**: needs a server-side secret
  store + proxy, verified topology, and on-device tests. Telegram remains a UI simulation.
- ⬜ **Phase 7** Browser control — not started; no candidate reviewed, nothing enabled.
- 🟨 **Phase 8** Hardening & acceptance — server-side enforcement for actions ✅; device/browser
  screenshots, screen-reader passes, 2FA/SSO, per-object ACLs and read sync outstanding.

## Phase 4 🤖 Agents & adapters — 🟨 (designer + definition storage ✅; adapters & run ⬜)
- ✅ **4.7 Agent Designer** — `#/designer`: goal/templates → component map → inspector → dual
  validation (definition vs activation) → summary; saves an **idle** definition to the gateway
  (`POST /api/v1/agents`) or the local store, and refuses when the gateway is not serving agents.
  Voice/image and scheduled behaviour are blocked at selection because no media service or
  scheduler exists. Shortcuts: New-agent flow, Quick create, All modules, Agents header.
  Evidence: `npm run test:designer` (18 checks). See
  [`copilot/agent-designer.md`](copilot/agent-designer.md).
- ⬜ Adapters (FAI + 7), run pipeline, memory subsystem — unchanged, still blocked by the same gaps
  the designer now reports at the point of creation.
## Phase 5 🐝 Parallel execution engine — ⬜ (scheduler, DAG)
## Phase 6 🧠 Model gateway (real LLM calls) — ⬜
## Phase 7 🧩 MCP plugins (real integrations) — ⬜
## Phase 8 ⚡ Skills runtime & self-improvement — ⬜
## Phase 9 💬 Chat + Copilot (real) — ⬜
## Phase 10 ✈️ Telegram bridge (real) — ⬜
## Phase 11 🔐 Trust & governance engine — 🟨 (audit chain ✅; gates/trust scoring ⬜)
## Phase 12 📁 Artifacts + 💻 Terminal (real) — ⬜
## Phase 13 📊 Analytics (real) — ⬜
## Phase 14 📱 PWA offline hardening — 🟨 (SW + manifest ✅; action queue ⬜)
## Phase 15 🧪 Testing & QA — 🟨 (smoke suite ✅; unit/e2e/load ⬜)
## Phase 16 📡 Observability — ⬜
## Phase 17 🚀 Deployment — 🟨 (Vercel static ✅; Docker/self-host ⬜)
## Phase 18 🎉 Launch — ⬜

---

## 🔌 Gateway API — quick reference (live in this slice)

```
POST /api/v1/auth/login                 → session cookie + CSRF token (public, throttled)
GET  /api/v1/auth/session               → principal, permissions, CSRF
POST /api/v1/auth/logout|password       → revoke session(s)
GET  /api/v1/roles                      → RBAC matrix
GET|POST /api/v1/principals             → Admin: list/create (role ceiling enforced)
PATCH /api/v1/principals/:id            → Admin: role/status (no self-change, no equals)
GET|POST|DELETE /api/v1/tokens          → scoped swk_ tokens (hash-at-rest)
GET  /healthz                           → { ok, db, driver, uptime, auth: { mode, roles } }
GET  /api/v1/summary                   → entity counts
GET  /api/v1/agents                    → all agents
POST /api/v1/agents                    → create agent
GET  /api/v1/agents/:id                → one agent
PATCH /api/v1/agents/:id               → update fields
GET  /api/v1/tasks                     → all tasks
POST /api/v1/tasks                     → create task
PATCH /api/v1/tasks/:id                → move/assign/update
GET  /api/v1/approvals                 → all approvals
POST /api/v1/approvals/:id/allow|deny  → resolve a gate
GET  /api/v1/comms                      → channels (masked), settings, stats, recent messages
PUT  /api/v1/comms/:channel             → save config / enable / routing (encrypted at rest)
DELETE /api/v1/comms/:channel           → remove credentials + verification
POST /api/v1/comms/:channel/send        → real delivery (idempotent with dedupeKey)
POST /api/v1/comms/queue                → run the retry queue now
GET  /api/v1/comms/messages             → delivery log (redacted bodies)
GET  /api/v1/comms/:channel/verify      → provider handshake (public: Meta hub.challenge, Slack)
POST /api/v1/comms/:channel/inbound     → signed webhook (public, signature-gated, deduped)
GET  /api/v1/events?cursor=            → event feed (replayable)
GET  /api/v1/audit                     → recent audit rows (audit:read)
GET  /api/v1/audit/verify              → hash-chain check (audit:verify)
POST /api/v1/dev/seed  {reset?:bool}   → restore sample data
WS   /ws                               → live stream, requires credentials, topic-filtered by role
```

## 🧪 Try it

```bash
npm run migrate          # create SQLite schema (+ auth tables)
npm run dev:gateway      # first run prints a generated Owner password once
npm run seed -- --reset  # restore ALL sample data & instances
npm run dev:gateway      # API on :8787
curl localhost:8787/api/v1/summary
```

---
*Last updated: 2026-10-27 — Gateway authentication + RBAC (3.4) and server-enforced Copilot actions.*
