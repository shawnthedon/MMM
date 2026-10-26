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
- ⬜ 2.5 Frontend switch to API mode (`VITE_DATA_MODE=api`)

## Phase 3 🚪 Gateway core — 🟨 (first slice landed)
- ✅ **3.2 (slice)** REST API — agents (list/create/get/update), tasks (list/create/update), approvals (list/allow/deny), events feed, summary, dev/seed — `node apps/gateway/server.js` → `:8787`
- ✅ **3.3 (slice)** WebSocket `/ws` — live event broadcast on every mutation (topics: `agents`, `tasks`, `approvals`, `system`)
- ✅ **3.5 (slice)** Job table schema ready (leasing fields)
- ✅ Audit log v1 — hash-chained `audit_log` + `npm run audit:verify`
- ⬜ 3.1 Fastify migration / schema validation
- ⬜ 3.2 rest: teams/swarms/skills/chat/files/analytics routes
- ⬜ 3.4 Auth + RBAC (Owner/Admin/Operator/Reviewer/Observer)

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
- ⬜ **Phase 3** Runtime-backed orchestration — needs gateway auth/RBAC + API client first.
- ⬜ **Phase 4** Training Studio — **BLOCKED**: no worker, dataset decoder, checkpoint store or
  model registry. Training mode reports the blocker and runs metadata-only dataset checks.
- ⬜ **Phase 5** Voice Studio — **BLOCKED/UNVERIFIED**: candidate engines (Local TTS, NeuTTS,
  OpenVoice) not verified here; singing has no supported path and is reported unsupported.
- ⬜ **Phase 6** Communication gateway & OpenSMS — **UNCONFIGURED**: needs a server-side secret
  store + proxy, verified topology, and on-device tests. Telegram remains a UI simulation.
- ⬜ **Phase 7** Browser control — not started; no candidate reviewed, nothing enabled.
- ⬜ **Phase 8** Hardening & acceptance — device/browser screenshots and screen-reader passes
  outstanding; server-side policy enforcement blocked on 3.4.

## Phase 4 🤖 Agents & adapters — ⬜ (FAI + 7 adapters)
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
GET  /healthz                          → { ok, db: 'sqlite-wal', dataDir, uptime }
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
GET  /api/v1/events?cursor=            → event feed (replayable)
GET  /api/v1/audit/verify              → hash-chain check
POST /api/v1/dev/seed  {reset?:bool}   → restore sample data
WS   /ws                               → live event stream
```

## 🧪 Try it

```bash
npm run migrate          # create SQLite schema
npm run seed -- --reset  # restore ALL sample data & instances
npm run dev:gateway      # API on :8787
curl localhost:8787/api/v1/summary
```

---
*Last updated: 2026-10-26 — Copilot Phase 0 discovery + Phase 1 FAB/panel/modes/knowledge/memory.*
