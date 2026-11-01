# 📍 MMM — Development Progress Tracker

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
  Desktop Chromium ran a tiny mixed-Q4 model with page-offline emulation; mobile/device airplane-mode,
  complete binary-licence review, memory/thermal measurements and broader lifecycle tests remain
  open. No weights bundled. Details: [`local/runtime-spike-research.md`](local/runtime-spike-research.md).
- 🟨 **Spike hardening** — reject native load failures that wllama can otherwise report as loaded;
  accurate abort status, retryable worker cleanup and no redirected runtime asset. Browser evidence
  covers interrupted OPFS writes, truncated GGUF rejection, real streaming stop and worker shutdown.
  **Correction:** Puppeteer page-offline emulation did not disconnect the dedicated worker, so the
  previous test was not proof of full offline operation. A follow-up Linux network-namespace test
  disconnected the whole browser from external networks and passed; worker generation/stop made no
  observed HTTP(S) requests. Mobile airplane mode remains unverified.
- ⬜ Phases 3–6 (model manager, offline text product, image feasibility/feature) — not started.

### Agent Browser — autonomous browsing that stops when it should — ✅ module, ⬜ engine on host
- ✅ `apps/gateway/src/browser/` — policy + states, stall watchdog, loop detection, bounded recovery
  ladder, checkpoints, evidence, one action per tick, `resumeInterrupted()` on boot
- ✅ `apps/gateway/migrations/004_browser.sql` — `browser_tasks` / `browser_steps` / `browser_evidence`
- ✅ API + RBAC (`browser:read` Observer, `browser:run` Operator) + `browser` WebSocket topic
- ✅ `src/browser.js` + `src/browser.css` — mobile-first panel: objective, site, last verified
  milestone, time since progress, recovery counters, blocker, timeline, evidence viewer,
  pause / resume / stop / assist; no fabricated activity, no inert controls
- ✅ Tests: `npm run test:browser` (22, AT-15…AT-26), `npm run test:browser:engine` (7, real Chromium),
  `npm run test:browser-ui` (8, screen)
- ⬜ Install Chromium on the deployment host and record one real task before calling the capability
  `available`; ⬜ per-principal domain allowlist; ⬜ evidence in object storage; ⬜ downloads
- Doc: [`browser/AGENT_BROWSER.md`](browser/AGENT_BROWSER.md)

### Comms — server-side credentials + routes — ✅
- ✅ **Migration 003** — `comms_channels` (encrypted config, routing, verification), `comms_messages`
  (one row per attempt, dedupe key, retry cursor), `comms_settings` (quiet hours, rate limit, retries).
- ✅ **Encryption at rest** — AES-256-GCM with a key derived from `MMM_SECRET` (HKDF-SHA256); a
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
  a 5-minute replay window, Twilio form params), `x-mmm-delivery` dedupe, deterministic commands
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
  skill.json, registry JSON, skill.yaml, MMM portable packages and .zip/.skill bundles. Pipeline:
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
  scoped `mmm_` bearer tokens, 5-role matrix (Owner/Admin/Operator/Reviewer/Observer), lockout,
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
GET|POST|DELETE /api/v1/tokens          → scoped mmm_ tokens (hash-at-rest)
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

---

## 🏷 2026-10-29 — Renamed SwarmOS → MMM (clean break)

The repository and the product now share one name. 363 identifiers across 68 files: brand strings
(app title, manifest, boot splash, terminal banner, comms messages), 19 `SWARMOS_*` env vars → `MMM_*`,
session cookie, CSRF/request-id/delivery headers, API token prefix `swk_` → `mmm_`, database file
`swarmos.sqlite` → `mmm.sqlite`, `localStorage` keys, service-worker cache prefix (bumped to `mmm-v4`,
which also purges the pre-rename shell), npm package name, docs and diagrams.

Upgrade steps, the full before/after table and the rationale for a clean break rather than a
compatibility shim: [`ops/RENAME_MMM.md`](ops/RENAME_MMM.md). `npm test` and `npm run build` green
after the rename; `data/` is now gitignored and no longer tracked.

---

## 🧩 2026-10-29 — Feature Completion Roadmap

Added [`FEATURE_COMPLETION_ROADMAP.md`](FEATURE_COMPLETION_ROADMAP.md): the feature-level companion to
the production roadmap. It audits all 18 routed screens (plus the approvals list, Copilot overlay,
training and the usage ledger) against what actually backs them, and gives 23 module playbooks with
beginner-level steps, real code for this repo, a test per module and 95 documentation links.

Key audit finding: **migration 001 already creates and seeds 15 tables, but only 4 have routes.**
`swarms`, `teams`, `team_members`, `skills`, `plugins`, `providers`, `model_policies`, `threads`,
`messages`, `files` and `jobs` are all persisted, seeded and unreachable — so most of the remaining
work is "expose an existing table + add the runtime", not "design a backend". Also documented: the
Telegram Bridge is entirely local even though a real Telegram adapter already exists in
`apps/gateway/src/comms.js`, and agent rows persist fictional history (`runs`, `success_rate`,
`cost_today` are seed constants nothing recomputes).

---

## 🧬 2026-10-29 — Self-modification and code evolution (M23)

Every agent is now *capable* of controlled self-modification. Authority stays with the gateway: a
per-agent policy (five levels, default **L1 recommend**), an isolated workspace that never touches the
repository, a sandbox with a rebuilt environment and a command allowlist, real test runs, independent
peer review, approval separated from deployment, versioned promotion with rollback, automatic rollback
when the health check fails, quotas that stop runaway loops, and a ten-stage audit trail.

- Backend: `apps/gateway/src/evolution/` + `migrations/005_evolution.sql`; 18 routes; WS topic `evolution`.
- Screen: `#/evolution` (`src/evolution.js`, `src/evolution.css`) — agent tabs, policy editor for Owners,
  observations, experiments, ten-stage bar, diff, test output, reviews, comparison **with its stated
  limits**, approval and timeline. Mobile-first, 44 px targets, no fabricated activity.
- Permissions: `evolution:read` Observer · `run` Operator · `review`/`approve` Reviewer · `deploy` Admin ·
  `policy` Owner.
- Evidence: `npm run test:evolution` — **20 passed** (`SELF-MODIFICATION ACCEPTANCE`), AC1–AC18, against a
  real gateway on a temporary `DATA_DIR` with real sandboxed `node` runs;
  `npm run test:evolution:ui` — **10 passed**.
- Honest limits: the sandbox is **process isolation, not a container** (no network isolation) and the API
  and screen both say so; there is no model-driven patch author yet; reproduction is files + manifest,
  not an image digest. Full list: [`evolution/SELF_MODIFICATION.md`](evolution/SELF_MODIFICATION.md) §10.

---

## 👥 2026-10-29 — Teams, membership and the agent panel (M24)

Teams are real. Membership is stored **once**, on the agent row (`agents.team_id` +
`agents.team_position`); `team_members` is retired by `006_team_membership.sql`, so the grid, the
panel, the designer and the gateway cannot disagree about who is on what team.

- Backend: `apps/gateway/src/teams.js` + 8 routes (create, rename, delete, add/remove member, reorder).
  Reads need `read`, team mutations `swarm:write`, membership writes `agent:write`; every change is
  audited and broadcast on WS topic `agents`. `DELETE /api/v1/agents/:id` is a soft delete that also
  frees the team slot — a team is never deleted as a side effect.
- **Deleting a team unassigns its members** (`teamId → null`), detaches its swarms and deletes no agent;
  the confirmation says exactly that, and the audit entry records `agentsDeleted: 0`.
- Panel: full-height sheet below 900 px, docked right-hand panel at 900 px and up. Identity, team
  assignment with an “n of m” position slider, responsibilities, instructions (goal + multiline prompt,
  never truncated), capabilities, autonomy **with an explicit “orchestration is not implemented” note**,
  status, and four shortcuts (Skills filtered to that agent, Tools and MCP, Chat enabled only while the
  agent is active, and the team menu).
- Left team menu with real member counts, an active-team panel, a ⋯ menu, and **“New agent in <team>”**
  that carries the team into the designer as a visible, editable suggestion — nothing is written until
  the definition is saved.
- Grid: 1 / 2 / 3 columns, cards with avatar, name, role, team, lifecycle pill, capability chips and an X
  delete; inline editing of name, role and team behind an explicit Save, and a failed write leaves the
  card unchanged.
- Evidence: `npm run test:teams` — **12 passed** against a real gateway, including *“deleting a team
  unassigns members instead of deleting them”*; `npm run test:teams:ui` — **23 passed**;
  `npm run test:teams:browser` — **6 passed** in real Chromium (full-height sheet at 390 px, no overflow
  at 320 px, 900 px dock at 1280 px, grid 1/2/3, screen values matching state). `npm test` and
  `npm run build` green.
- Honest limits: `team_position` is not yet used for dispatch, there are no per-team budgets, and there is
  no membership-history screen beyond the audit trail.

---

## 💬 2026-11-01 — Chat is a real transcript, and it says it cannot answer (M25)

The fabricated replies are **deleted, not hidden**: `simulateReply()` and its four canned sentences —
including `Estimated cost: $0.42` — are gone from `src/views2.js`.

- Backend: `apps/gateway/src/chat.js` + six routes (`GET/POST /threads`, `GET/POST /threads/:id/messages`,
  `POST /threads/:id/read`, `DELETE /threads/:id`). Reads need `chat:read` (Observer), writes
  `chat:write` (Operator); WS topic `chat`. Threads and messages were already seeded in 001 — they now
  have a read and a write path.
- **Nothing answers.** One function builds `runtimeStatus()` (`configured: false`, `generatesReplies:
  false`, and a plain-language note), every read and write carries it, and the screen renders the note
  verbatim. A request body cannot assert `from: 'agent'`: it is refused with the reason, because an agent
  message may only be written by a runtime.
- Idempotent writes: `007_chat_idempotency.sql` adds `messages.client_id` with a **partial** unique index,
  so a retried send returns the same row (`200 { duplicate: true }`) instead of a second message.
- `unread` is a server-owned counter raised only by a message from someone else and cleared only by an
  explicit read mark; the receipt is sent only from a visible tab. A failed write keeps the text in the
  composer and says what failed. A stale remembered thread id is replaced by the thread actually shown.
- A gateway without the chat routes leaves the slice on demo provenance and the banner says so — it never
  shows fixtures as a live transcript.
- Evidence: `npm run test:chat` — **16 passed** against a real gateway on a temporary `DATA_DIR`,
  including a restart (`the transcript survives a gateway restart`); `npm run test:chat:ui` — **10
  passed**; `npm run test:chat:browser` — **5 passed** in real Chromium (notice visible at 390 px, one
  message from the real composer, **nothing appears after 3.2 s**, no sideways scroll at 320 px, no
  background request). `npm test` and `npm run build` green.
- Honest limits: no model runtime (so no reply), no streaming, no pagination past 200 messages per
  thread, no per-thread access control beyond `chat:read`.

---

## 💻 2026-11-01 — The terminal runs real commands now (M26)

The screen that used to print 24 plausible-looking answers is gone. `src/terminal.js` now drives real
child processes on the gateway, and the fabricating cases (`run`, `deploy`, `spend`, the `Math.random()`
swarm) are **deleted** — `deploy` and `run` print the route they would need and stop.

- Policy first: `apps/gateway/src/terminal/policy.js` allows `node`, `npm`, `npx` and **no shell**, so
  `&&`, `|`, `>` and `$(…)` are refusals with a reason rather than syntax. `npm -g`, `--prefix`,
  `--registry`, `--userconfig`, `--script-shell` and absolute paths are refused; absolute arguments are
  resolved against the real workspace root and anything outside it is `bad-path`.
- Execution: `apps/gateway/src/terminal/index.js` spawns with `shell: false` in its own process group,
  with a cwd that must be absolute and inside a workspace — checked again at spawn time, because a
  `spawn` with an undefined cwd silently inherits the gateway's own directory (that bug was real: it is
  how a test suite once ran `npm init -y` inside this repository).
- Live output: SSE (`run` · `chunk` · `exit`) with `GET /runs/:id/output?since=` as the replay path, so
  output is not lost when you leave the screen and come back. Exact exit codes and signals; states
  `running`/`completed`/`failed`/`cancelled`/`timed_out`/`refused`/`blocked`.
- Control: **Stop** or Ctrl+C sends `SIGINT` to the process group (`SIGTERM` → `SIGKILL` escalation),
  one command per session at a time (`409`), several sessions, a cwd that persists per session, env
  vars accepted by **name** and never echoed back, and the gateway's own environment is not inherited.
- Governance: `npm ci` and `npm uninstall` open an approval that a **different** principal must grant —
  self-approval is `403`, denial runs nothing. Every run is recorded (actor, command, status, exit code,
  duration) and audited without any secret in the row. An agent with a grant runs through the same policy
  and gets output plus exit code back; without a grant the route is `403`, not a spawn.
- Screen: the existing design, kept — same chips, prompt and scrollback — plus a live run bar with the
  exit code, a stop control, a cwd indicator with the detected `package.json` and its scripts.
- Evidence: `npm run test:terminal` — **28 passed** against a real gateway on a temporary `DATA_DIR`
  (real `npm init -y`, real `npm install` of a packed local package, `npm install express` when the
  registry answers, `npm run build`/`dev`, exit codes 7 and 3, SSE spread over time, approval gate, role
  matrix, no orphan after `SIGINT`); `npm run test:terminal:ui` — **12 passed**; `npm run
  test:terminal:browser` — **15 passed** in real Chromium (sign in → open the terminal → `npm install
  express` visibly installs → run the project's script → interrupt it, no output afterwards). `npm test`
  and `npm run build` green.
- Honest limits: process isolation, **not** a container — no filesystem or network namespaces, and the
  capability endpoint says `isolation: 'process'` with the unenforced list. No PTY, so TTY-only programs
  will not behave. `npm install` needs the network unless the package is already cached; the app never
  claims otherwise.

---

## 🧹 2026-11-01 — The ticker is dead and the static claims are gone (M27)

There was a 4.2-second `tick()` in `src/main.js` that advanced live swarms with `Math.random()`, drifted
a fake usage curve and invented events — on every screen, forever. It is **deleted**, with the
`settings.simulate` switch that drove it. A switch that turns a simulation on is still a simulation.

- **Swarms are plans.** `src/core.js` shipped a fixture claiming 62% progress and `$3.41` spent on nodes
  marked `done`; every cent was a literal. It now ships `status: 'planned'`, `executed: false`, six
  `planned` nodes and `spent: 0`. The list, the record and the detail view each say **not executed**, the
  `Deploy · est $6.40` button is “Save record”, and Pause/Cancel are gone — there is no process to pause.
- **Models is a catalogue.** “Model Gateway” + “Active providers” + “Spend MTD” + a per-provider on/off
  switch described a gateway that does not exist. The screen now says *not configured*, *0 calls made by
  this app*, marks routing policies *illustrative / not enforced*, and the switch, the invented spend and
  the typed budget bars are deleted.
- **Plugins holds no secret.** The banner claimed “all calls proxied & audited by the gateway”, each row
  showed a `calls today` counter, and Install asked for an API key it then threw away while toasting
  success. Now: “no MCP client is installed in this build”, rows read *not connected*, the action opens
  *what it needs*, `callsToday` is deleted, and the credential field is gone — collecting a secret the app
  cannot store is worse than the fake install.
- **Settings tells the truth.** “4 templates active”, “AEAD-sealed vault”, “default-deny · proxy” are
  replaced by a live pending-approval count, *audit gateway-only*, “no key vault in this build” and
  “egress not enforced by this app”. Notifications say they are device-local and nothing is sent;
  retention says nothing is deleted on that schedule.
- **Analytics stops charting calls it never made**: the MCP tile reads *not measured · no client*, the
  bar chart is gone, and Export now computes its CSV from the rows on screen (`size` is the real byte
  length) instead of writing `spend_today,17.93` and `mcp_calls,535` as constants.
- Copilot knowledge and proposal text no longer describe a ticker; a swarm record is saved with status
  `planned` and the card says the plan will not move.
- Evidence: `npm run test:honesty` — **13 passed** (no `tick`, no `settings.simulate`, no `Math.random` in
  `main.js`, fixtures are plans, the claims are absent from both source and rendered DOM, no password
  field, no provider switch, and **five seconds of unchanged state**); `npm run test:honesty:browser` —
  **8 passed** in real Chromium at 390 px, including **six seconds with a byte-identical DOM** (the old
  tick fired at 4.2 s), no page errors across ten screens and no sideways scroll at 320 px. `npm test`
  and `npm run build` green.
- Honest remaining: Analytics still carries typed-in tiles (`▲ 8%`, `87% success`, `median 4m`) — that is
  session 11 and needs a ledger; no swarm is executed or persisted, which is session 4 and needs a
  scheduler.

---

## 🐝 2026-11-01 — Swarm plans are rows now, and the schema refuses to lie (M28)

`swarms` has existed since `001_init.sql` with a `status` column nothing wrote and a `nodes` blob nothing
read. Session 3 + 4 of the roadmap turn it into the app's first module where the **database** enforces the
honesty rule instead of a comment in the UI.

- **Schema** (`009_swarms.sql`): adds `executed`, `updated_at`, `run_note`. Rows claiming `live`,
  `running` or `paused` are reset to `planned`, and any progress or spend on an unexecuted row is zeroed —
  a plan nothing ran cannot have either.
- **Module** (`apps/gateway/src/swarms.js`): `listSwarms`, `getSwarm`, `createSwarm`, `updateSwarm`,
  `setSwarmStatus`, `deleteSwarm`, one `runtimeStatus()` that states “nothing schedules, starts or advances
  one” on every payload. The accepted payload is an allowlist, so `executed: true` in a request is a `400`
  rather than a silently dropped field, and `progress` / `budget.spent` are **computed from `executed`**
  rather than read from a column that could be stale.
- **Status is a plan decision, not process control**: `planned` ⇄ `cancelled`, then `archived` (one-way).
  `live`, `running`, `paused` and `completed` are a `409` whose message names what would have to exist
  first. The screen's buttons say *Mark cancelled*, *Re-open plan*, *Archive*, *Delete*.
- **Routes**: `GET/POST /swarms`, `GET/PATCH/DELETE /swarms/:id`, `POST /swarms/:id/status`. Reads need
  `read`, writes `swarm:write`, every mutation audits (no objective text in the trail), and changes
  broadcast on the `swarms` WebSocket topic.
- **Client**: `swarms` moved from `LOCAL_SLICES` to `GATEWAY_SLICES` — fetched with the rest, adapted
  once, kept out of `localStorage`, restored on sign-out; a gateway without the routes keeps the slice on
  demo provenance instead of failing the refresh. The screen reads the store; “Deploy” became “New plan”.
- **Deleted**: the fabricated “Resource allocation” panel on the record screen (`tokens/s 78%`,
  `$6/h cap`, `2.2k/5k calls`, `4/6 slots`) — typed-in numbers on a module that cannot allocate anything.
  The seed and `fixtures/swarms.json` now create plans, not runs.
- Evidence: `npm run test:swarms` — **17 passed** against a real gateway (refusals for `executed: true`,
  four claimed-status 409s, cancel/re-open, one-way archive, Observer read/write split, audit rows, a WS
  `swarm.created`, survival across a restart, seed and fixture checks); `npm run test:swarms:ui` — **8
  passed**; `npm run test:swarms:browser` — **8 passed** in real Chromium (save a plan from the real sheet
  → it exists in `GET /swarms` → cancel → reload → still cancelled; no start/pause/stop control; six
  seconds with an unchanged DOM; no sideways scroll at 320 px, which is how a wrapping chip bug was found
  and fixed). `npm test` and `npm run build` green.
- Honest limit: **nothing executes a swarm.** No scheduler, no worker, no per-node budget enforcement —
  `budget.cap` is a number in a row, not a limit anything applies. That is the next step, and the 409s
  are already written to guard it.

## 🔐 2026-11-01 — The Models screen gets a ledger, and the ledger gets a gateway (M29)

Session 7 + 8 + 11 of the roadmap. The Models screen was the app's most careful lie: a catalogue that
said “not configured” and therefore could never be wrong, above a `providers.spend_mtd` column nothing
ever wrote. It is now a real gateway with one adapter, a sealed key store and a meter.

- **Key material has one owner** (`apps/gateway/src/secrets.js`): `MMM_SECRET` → `<DATA_DIR>/.mmm-key` →
  legacy `.comms-key`, HKDF-SHA256 with a **per-purpose** domain separator (`provider-key-v1`,
  `comms-config-v1`), AES-256-GCM in `v1.<iv>.<tag>.<body>`. Comms was moved onto it — same derivation,
  same salt, so values sealed before this change still open — and now imports nothing from `node:crypto`
  itself.
- **Schema** (`010_model_calls.sql`): `providers` gains `key_fingerprint`, `key_hint`, `default_model`,
  `configured_at/by`, `updated_at`; **`spend_mtd` is dropped**, because a column nothing writes is a
  number waiting to be believed. New `model_calls` ledger: one row per *attempt*, `status ∈ ok | blocked |
  error`, tokens, `cost_usd`, `cost_estimated`, latency, `request_id`, `reply_chars` — length only, never
  the prompt or the reply. The migration also seeds the 26-row catalogue as *names to configure*
  (`status='off'`, no money), so a fresh gateway has something to configure.
- **One funnel** (`apps/gateway/src/models.js`): provider → key present? → `unseal` (a tampered blob is a
  `409` asking for re-entry, not a crash) → model id shape → non-empty messages → **budget checked against
  today's SUM** → `fetch` with `redirect:'manual'` (a redirect would send the key somewhere else), an
  `AbortController` timeout and a 256 KB response cap → parse `choices[0].message.content` and
  `usage.*` → estimate the cost → write the row → audit **without any text**. A refusal is written as
  `blocked` with zero cost, so spend stays a number that happened.
- **Routes**: `GET /providers`, `GET /providers/:id`, `PUT|DELETE /providers/:id/key`,
  `POST /providers/:id/call`, `GET /usage`, `GET /model-calls`, `PUT /budget`. `model:read` (every role),
  `model:call` (Operator+), `model:key` (**Owner only**), WS topic `models`. A read returns
  `status: configured|unconfigured`, a 16-hex fingerprint and a `••••abcd` hint — never the key.
- **Screen** (`src/views2.js`, `src/datastore.js`, `src/api.js`): `providers` joins `GATEWAY_SLICES`;
  `getModelsLedger()` carries the gateway's `usage`, `budget`, `runtime` and recent calls. The screen shows
  spend today (**estimated**), budget left, tokens, refused/failed counts, per-provider spend and calls,
  an install/replace/remove-key sheet, a **Test call** sheet that renders the reply with tokens, estimated
  cost and latency, an editable budget, and the ledger itself. Without a gateway it says nothing is
  callable and offers no control at all. Analytics now reads the same ledger for its money and token
  tiles, and the invented `▲ 8% vs yesterday`, `+ 12`, `median resolve 4m`, `+6.2% eval uplift` and
  `−18% avg cost/task` are gone.
- Evidence: `npm run test:models` — **22 passed** against a real gateway plus a real local
  OpenAI-compatible server (the key absent from every read, the audit chain, the event feed **and the
  SQLite/WAL bytes**; prompt and reply text absent from the ledger and the files; budget refusal with the
  provider contacted zero times; redirect not followed; timeout; oversized/malformed/empty bodies refused;
  tampered key → `409` → recovery; Observer read-only; a sealed key surviving a restart; key removal
  returning the provider to `unconfigured`). `npm run test:models:ui` — **11 passed**. `npm run
  test:models:browser` — **9 passed** in real Chromium against a real gateway **and a real loopback
  OpenAI-compatible server** (seal a key through the sheet → the key never appears in the DOM → a real
  request reaches the provider with `Authorization: Bearer …` → the ledger matches `GET /usage` → a zero
  budget refuses the next call with the provider contacted zero times → reload keeps the key → removal
  returns the provider to `unconfigured` → no sideways scroll at 320 px). `npm test` (39 suites) and
  `npm run build` green.
- Honest limit: **no streaming, no retries, no policy routing, no invoices.** Cost is an estimate from a
  price table and the UI says *estimated*; the `llm` capability stays unflipped because nothing else in
  the app calls the funnel yet — Chat still answers nothing, and still says so.

## 💬 2026-11-01 — The Copilot gets a conversation instead of a switch statement (M30)

Unit 1 of the Copilot upgrade: the 1,282-line deterministic `handle()` is no longer the only thing that can
answer. On a gateway, a turn is a real model call, stored as a row, linked to the ledger row that produced
it — and when no model can answer, the refusal is the server's, not a keyword matcher wearing the model's
name.

- **Schema** (`011_copilot.sql`): `threads.owner_id` (one conversation per principal), `messages.model_call_id`
  (the call that produced an assistant turn), and `copilot.provider` / `copilot.model` settings. There is one
  insert path and it **throws** if an agent turn arrives without a call id, so a reply cannot exist without
  the meter that made it. Copilot threads are excluded from `GET /threads` — they would otherwise put a
  model-written turn inside Chat, whose banner says, truthfully, that it generates no replies.
- **Gateway** (`apps/gateway/src/copilot.js`): one turn stores your message **first** (a provider outage must
  not lose what you typed), resolves the model, and — with no sealed key — answers `409 { code: 'no-model' }`
  while writing **no assistant row**. With a key it calls the M29 funnel (`purpose: 'copilot'`), stores the
  reply with tokens, latency, estimated cost and call id, and audits lengths only: never the question, never
  the answer. History is the last 24 turns / 12,000 chars, oldest first, the new message exactly once;
  `clientId` makes a retried send one turn.
- **Routes**: `GET /copilot`, `POST /copilot/messages` (30/min per principal), `DELETE /copilot`,
  `GET /copilot/runtime`, `PUT /copilot/model`. `copilot:read` (every role), `copilot:write` (Operator —
  every turn spends money), `copilot:model` (**Owner**, the same rank as installing the key it depends on).
  The conversation id is never read from a request body, so a guessed id returns *your* thread.
- **Panel / client** (`src/copilot/conversation.js`, `panel.js`): two facts are decided separately — where
  the reply comes from (`live` model vs `local` engine) and what the gateway says (`ready` / `unready` /
  `unavailable` / `error` / `demo`). Only `ready` turns the conversation into a model conversation; the
  transcript on screen is then the gateway's, not `localStorage`'s. Mode tabs render whenever the built-in
  engine is what replies (including on a gateway with no key, which keeps every existing action card and
  gateway write working); on a live conversation the row becomes a runtime statement (provider · model ·
  *cost estimated*) with no tabs, because there is nothing to choose when you can just talk. A live reply
  carries `model · 120 in / 30 out · $0.0021 est. · 640 ms · call #42`; a local reply says no model was
  called. `unready` shows a notice before you type and states that the conversation stays in the browser;
  `unavailable` (a gateway without the routes) is stated rather than mimed; pending distinguishes
  *Working…* from *Waiting for the model…*; Stop aborts the request; clearing takes two taps and deletes on
  the server. The `llm` capability now reads the runtime: `available` only when a sealed key is resolving.
- Evidence: `npm run test:copilot-api` — **19 passed** against a real gateway and a real loopback
  OpenAI-compatible provider (no key → 409, question stored, no assistant row, provider contacted zero
  times; a real turn carries the ledger id; prompt is system + stored history with no duplicated turn;
  provider failure → 502 with only the question stored; a body `conversationId` is ignored; a retried
  `clientId` is one turn; a body-`conversationId` from another principal cannot reach your transcript;
  Observer may read but not spend; conversations survive a restart; a clear removes only your own turns).
  `npm run test:copilot:ui` — **8 passed** (demo labels every answer "no model called"; `unready` warns
  first and invents nothing; the transcript is the gateway's; a live bubble carries tokens, estimated cost
  and call id while no mode button exists; an upstream failure is marked failed with the server's words and
  no call id; Stop aborts; clearing is two steps; a gateway without the routes is reported).
  `npm run test:copilot:browser` — **8 passed in real Chromium** against a real gateway and a real loopback
  provider (no key → local answers, provider contacted zero times; seal a key through the Models sheet → the
  panel becomes live with no mode tabs; a real question reaches the provider with `Bearer` and comes back as
  the provider's text with `240 in / 40 out · est. · call #N`; the reply exists in `messages` pointing at a
  `model_calls` row with `purpose='copilot'`; reload keeps the conversation; at 320 px nothing overflows and
  every control is ≥ 44 px; no page errors). `npm test` (41 suites) and `npm run build` green. Design + limits: [`copilot/conversation.md`](copilot/conversation.md).
- Honest limit: **no streaming and no tool calls.** Multi-turn context only — the Copilot cannot read your
  board or create an agent yet. Drafts, swarm plans, Agent Browser JSON and open-source voice are units 2–5
  and are not built; the panel does not imply otherwise.
