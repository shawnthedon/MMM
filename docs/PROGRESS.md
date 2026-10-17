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
*Last updated: 2026-10-15 — Phase 0–2 foundation + gateway first slice.*
