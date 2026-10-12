# ✅ SwarmOS — Implementation Checklist (Prototype → Production)

> **Purpose:** an ordered, beginner-friendly checklist to turn the SwarmOS PWA prototype into a real production application — including restructuring the codebase, replacing every simulated behavior with a working implementation, and handling all sample data, objects, and instances (seed → migrate → restore).
>
> **Audience:** developers new to the project (or new to production web development).
> **Format:** every item is a checkbox. Work top-to-bottom. Each phase has a **Goal**, ordered **To-dos**, and **Done when…** exit criteria.

**Status legend**
`⬜` not started · `🟨` in progress · `✅` done · `⏭` optional/skippable

---

## 🧭 How to use this document

1. **Do the phases in order** — later phases depend on earlier ones (e.g. you can't wire real LLM calls before the API exists).
2. Every to-do says **what** to do, **why** it matters, and **how** (commands/files). If a step is unfamiliar, read the linked section of [`docs/DESIGN_SPEC.md`](DESIGN_SPEC.md) first.
3. Check the box only when the **Done when** criteria for that phase are met.
4. The appendix at the bottom contains the **full sample-data inventory** (every demo agent, task, skill, provider…) and **how to restore it** at any time.

### 🗺 Phase map (do in this order)

| # | Phase | What you build | Est. effort |
| --- | --- | --- | --- |
| 0 | 🧰 Environment & orientation | Dev setup, run the prototype, code tour | 1–2 days |
| 1 | 🏗 Restructure the application | Monorepo layout, real state layer, API client | 1–2 weeks |
| 2 | 💾 Database & sample data | SQLite schema, migrations, seed/restore tooling | 1–2 weeks |
| 3 | 🚪 Gateway core (API + WS) | Real HTTP API, WebSocket events, auth | 2 weeks |
| 4 | 🤖 Agents & framework adapters | Real agent runtimes (7 frameworks) | 3–4 weeks |
| 5 | 🐝 Teams, swarms & parallel engine | Scheduler, DAG execution, resource allocation | 2–3 weeks |
| 6 | 🧠 Model Gateway (real LLM calls) | 26 providers, routing, budgets, keys vault | 2–3 weeks |
| 7 | 🧩 MCP plugins (real integrations) | MCP proxy + GitHub/Supabase/… connectors | 2–3 weeks |
| 8 | ⚡ Skills runtime & self-improvement | Skill loader, evals, skill synthesis, ML loop | 3–4 weeks |
| 9 | 💬 Chat + ✦ Copilot (real) | Streaming LLM chat, intent → app actions | 2 weeks |
| 10 | ✈️ Telegram bridge (real bot) | Bot, commands, inline approval buttons | 1–2 weeks |
| 11 | 🔐 Trust & governance engine | Gates, trust scoring, hash-chained audit | 2 weeks |
| 12 | 📁 Artifacts + 💻 Terminal (real) | Governed FS, PTY sessions, safety rails | 1–2 weeks |
| 13 | 📊 Analytics (real metrics) | Event pipeline, aggregations, digests | 1 week |
| 14 | 📱 PWA & offline hardening | SW strategy, sync queue, install flows | 1 week |
| 15 | 🧪 Testing & QA | Unit/integration/e2e/load/security | 2 weeks (overlap) |
| 16 | 📡 Observability & ops tooling | Logs, metrics, diagnostics, backups | 1 week |
| 17 | 🚀 Deployment & production ops | Docker, TLS, domain, update/backup drills | 1 week |
| 18 | 🎉 Launch & post-launch | Go-live checklist, monitoring, iteration | ongoing |

---

## 🎯 Definition of “Production Ready”

Before starting, agree on what “done” means. SwarmOS is production-ready when:

- [ ] A fresh machine can go from `git clone` → running app in **< 15 minutes** using only the README.
- [ ] Every item in the **Prototype → Real** table below is `✅` (no simulated behavior remains in default mode).
- [ ] All **sample data** can be created (`npm run seed`), wiped (`npm run seed -- --reset`), and restored deterministically.
- [ ] Secrets (API keys, bot tokens) live only in the sealed vault — never in code, logs, or exports.
- [ ] Every privileged action passes through **approval gates** and appears in the **hash-chained audit log**.
- [ ] Automated tests (unit + integration + e2e) pass in CI; load test target (200 concurrent agent runs) holds.
- [ ] Backups are taken automatically and a **restore drill** has been performed successfully at least once.
- [ ] Uptime/health monitoring alerts work; incident runbook exists.
- [ ] The app installs on iOS/Android via PWA and works offline (shell + queued actions).

---

## 🔁 Prototype → Real feature map (what this checklist must fix)

The prototype **simulates** these behaviors. Each one must become real (each is expanded into to-dos in the phases below):

| # | Prototype behavior (simulated) | Real implementation | Phase |
| --- | --- | --- | --- |
| 1 | State in `localStorage` | SQLite + REST/WS API | 2–3 |
| 2 | Agent “runs” are timer ticks | Real agent runtimes executing tool loops | 4–5 |
| 3 | Model dropdowns don't call LLMs | HTTP calls to real providers w/ streaming | 6 |
| 4 | Plugin install toggles a flag | Real MCP server lifecycle + proxied calls | 7 |
| 5 | Skills are static cards | Skill loader, sandboxed execution, evals | 8 |
| 6 | Copilot replies are rule-based strings | Real LLM w/ tool-calling intent router | 9 |
| 7 | Chat replies are canned | Streaming LLM with agent context/memory | 9 |
| 8 | Telegram preview is in-app UI | Real Telegram Bot API + signed buttons | 10 |
| 9 | Trust score is hardcoded 0–100 | Computed scoring engine + policy updates | 11 |
| 10 | Terminal echoes a fake CLI | Real PTY (`node-pty`) + gateway shell | 12 |
| 11 | Artifacts are JSON strings | Real files on disk w/ ACLs + journaling | 12 |
| 12 | Analytics are seeded arrays | Aggregations over real events/runs | 13 |
| 13 | Self-improvement badges are static | Real loop: propose → eval → review → adopt | 8 |
| 14 | Swarms “progress” via `setInterval` | Scheduler with jobs, DAG, checkpoints | 5 |
| 15 | Offline banner is cosmetic | Background sync queue + idempotent API | 14 |

---

# Phase 0 🧰 Environment & Orientation

**Goal:** get the prototype running locally and understand the code layout before changing anything.

- [ ] **0.1 Install required software** (one-time)
  - Install **Node.js ≥ 20** from [nodejs.org](https://nodejs.org) (LTS is fine). Verify:
    ```bash
    node -v    # e.g. v20.x
    npm -v     # e.g. 10.x
    ```
  - Install **git** from [git-scm.com](https://git-scm.com). Verify: `git --version`.
  - Install a code editor (recommended: **VS Code** — free) and the ESLint + Prettier extensions.
  - *(Optional, for icons)* Install **ImageMagick** (`brew install imagemagick` on macOS / `apt install imagemagick` on Linux / `choco install imagemagick` on Windows).

- [ ] **0.2 Clone the repo and run the prototype**
  ```bash
  git clone https://github.com/shawnthedon/MMM.git
  cd MMM
  npm install          # downloads Vite + dev tools (creates node_modules/)
  npm run dev          # starts http://localhost:5173
  ```
  - Open the URL. You should see the **Command Deck**. If a port is busy, Vite will suggest another — that's fine.

- [ ] **0.3 Run the test + production build once**
  ```bash
  npm run smoke        # boots the app in happy-dom and renders all 12 modules
  npm run build        # produces dist/
  npm run preview      # serves dist/ on :4173 (PWA + service worker active)
  ```

- [ ] **0.4 Take the 20-minute product tour** (click through the app)
  - Home → approve/deny the pending approval → Agents → open **Researcher-01** → Teams → open `market-intel-swarm` (watch the DAG) → Tasks (drag a card) → Skills → Models → Plugins → Chat → Telegram (tap `/status`) → Analytics → Files → Terminal (`help`) → Settings (switch to Light theme).
  - Open the **✦ Copilot** dock and run `status`, then `create agent Nova` and confirm the action card.

- [ ] **0.5 Code tour** (know where things live)

  | Path | What it is |
  | --- | --- |
  | `index.html` | App entry page |
  | `src/main.js` | Boot, hash router, live simulation ticker |
  | `src/core.js` | Store (state + seed data), utils, icons |
  | `src/shell.js` | Chrome (top bar, tabs, sheets, toasts), action registry |
  | `src/copilot.js` | Copilot dock + intent engine (rule-based today) |
  | `src/views1.js` / `src/views2.js` | The 12 module UIs |
  | `src/terminal.js` | Fake CLI (becomes a real PTY client later) |
  | `src/styles.css` | Design system tokens + components |
  | `public/` | Manifest, service worker, icons |
  | `docs/DESIGN_SPEC.md` | The full design & systems specification |
  | `scripts/smoke.mjs` | Runtime smoke test (happy-dom) |

- [ ] **0.6 Set up your git workflow**
  ```bash
  git config user.name "Your Name"
  git config user.email "you@example.com"
  git checkout -b develop        # work on develop; merge to main via PRs
  ```
  - Rule of thumb: **small commits**, one logical change each. Run `npm run smoke` before every commit.

**✅ Done when:** `npm run dev`, `npm run smoke`, `npm run build` all work on your machine, and you can explain what `src/core.js` and `src/shell.js` do.

---

# Phase 1 🏗 Restructure the Application

**Goal:** evolve the single-page prototype into a maintainable **client + gateway** architecture — the “restructuring of the application” — while keeping the UI working at every step.

- [ ] **1.1 Create the target folder structure** (monorepo, npm workspaces)
  ```
  MMM/
  ├── apps/
  │   ├── web/                 ← move current src/ + index.html + public/ here
  │   └── gateway/             ← new: the self-hosted backend (Phase 3)
  ├── packages/
  │   └── shared/              ← shared types, event names, API contracts
  ├── fixtures/                ← sample data as JSON/SQL (Phase 2)
  ├── docs/
  └── package.json             ← workspaces: ["apps/*", "packages/*"]
  ```
  - In the root `package.json` add: `"workspaces": ["apps/*", "packages/*"]`.
  - Move files with `git mv` (keeps history). Update import paths. Re-run `npm run smoke` — fix breakage before continuing.

- [ ] **1.2 Extract the state layer from the UI**
  - Today `src/core.js` mixes three concerns: **data shapes**, **seed data**, and **persistence**. Split into:
    - `packages/shared/types.js` — entity shapes (Agent, Task, Swarm, Skill…) as JSDoc typedefs (or TypeScript if you prefer — recommended for beginners on a team).
    - `apps/web/store.js` — observable store only (no `localStorage` logic).
    - `apps/web/api.js` — **API client** (fetch + WebSocket) with the same `getState/commit/subscribe` surface, so views don't change much.
  - Keep `localStorage` behind a flag (`VITE_DATA_MODE=local`) so the UI still runs without the gateway during development.

- [ ] **1.3 Define the API contract before coding it**
  - In `packages/shared/`, write the endpoint list from spec §20 (`GET/POST /agents`, `/swarms/:id/pause`, WS topics `runs.*`, `approvals.*`, …) as a single `api-routes.json` + event-envelope spec.
  - Add a mock server (a tiny Express/Node file returning the **seed data** from Phase 2) so the frontend can switch to `VITE_DATA_MODE=api` early.

- [ ] **1.4 Introduce environment configuration**
  - Add `apps/web/.env.example` (`VITE_API_URL`, `VITE_WS_URL`, `VITE_DATA_MODE`) and `apps/gateway/.env.example` (`PORT`, `DATA_DIR`, `MASTER_KEY`, `TELEGRAM_BOT_TOKEN`, provider keys…).
  - **Never commit real `.env` files.** Add `.env` to `.gitignore` (already done) and document each variable in the README.

- [ ] **1.5 Add code-quality tooling** (beginner-friendly automation)
  - Add ESLint + Prettier configs at the repo root; wire `npm run lint` and `npm run format`.
  - Add `npm run check` = lint + smoke. Make it a habit (later: CI runs it automatically).

**✅ Done when:** the app runs in both `local` and `api` (mock) modes, `apps/web` has no `localStorage` imports outside `store.js`/`api.js`, and `npm run smoke` passes.

---

# Phase 2 💾 Database, Migrations & Sample Data

**Goal:** real persistence with SQLite, and **first-class sample data** — every demo agent, task, skill, provider, etc. becomes a seed fixture you can create, wipe, and restore at will.

- [ ] **2.1 Set up the SQLite database in the gateway**
  - Use `better-sqlite3` (simple, fast, sync API) or Node 22's built-in `node:sqlite`.
  - Create `apps/gateway/src/db.js`:
    ```js
    import Database from 'better-sqlite3';
    export const db = new Database(process.env.DATA_DIR + '/swarmos.sqlite');
    db.pragma('journal_mode = WAL');   // concurrency + crash safety
    ```
  - **Why WAL?** many readers + one writer, crash-safe — exactly what spec §18 requires.

- [ ] **2.2 Implement the schema from spec §19 as migrations**
  - Create `apps/gateway/migrations/001_init.sql` with the tables from the spec: `principals`, `agents`, `prompt_versions`, `teams`, `team_members`, `swarms`, `tasks`, `runs`, `events`, `jobs`, `skills`, `agent_skills`, `plugins`, `plugin_tools`, `plugin_grants`, `providers`, `model_policies`, `budgets`, `memory_*`, `files`, `file_versions`, `threads`, `messages`, `telegram_links`, `approvals`, `audit_log`, `capability_tokens`.
  - Write a tiny migration runner `node scripts/migrate.mjs` that applies `migrations/*.sql` in order and records applied files in a `migrations` table. Add `"migrate": "node scripts/migrate.mjs"` to `package.json`.
  - **Beginner tip:** a migration is just a SQL file that describes *changes* to the database. Never edit an applied migration — add a new one (`002_add_x.sql`).

- [ ] **2.3 Create the seed fixtures — “all sample data, objects and instances”**
  - Create `fixtures/` with one JSON file per entity type, transcribing the prototype's demo data **exactly** (full inventory in Appendix A):
    ```
    fixtures/
    ├── agents.json        (6 agents: Researcher-01, Coder-07, RedTeam-Alpha, SRE-Bot, Content-Weaver, Analyst-Prime)
    ├── teams.json         (3 teams)  ├── swarms.json   (market-intel-swarm + 6 DAG nodes)
    ├── tasks.json         (9 tasks)  ├── skills.json   (6 skills incl. 2 pending synthesized)
    ├── plugins.json       (6 MCP plugins)  ├── providers.json (26 providers)
    ├── policies.json      (3 routing policies)  ├── approvals.json (ap-1, ap-2)
    ├── threads.json       (3 chat threads)  ├── files.json (6 artifacts)
    ├── events.json        (6 events)  ├── settings.json (workspace defaults + trust weights)
    └── telegram.json      (bot link + demo conversation)
    ```
  - Write `scripts/seed.mjs` (`npm run seed`):
    ```bash
    npm run seed              # insert sample data (idempotent: skips if present)
    npm run seed -- --reset   # wipe ALL data, re-migrate, re-seed (restore factory demo)
    ```
  - The UI button **Settings → Reset demo data** must call `POST /api/v1/dev/seed?reset=1` (gateway) instead of rewriting `localStorage`.

- [ ] **2.4 Add an export/backup/restore drill**
  - `npm run backup` → copies `swarmos.sqlite` (via `sqlite3 .backup` API) + `data/artifacts/` into `backups/<timestamp>/`.
  - `npm run restore -- backups/<timestamp>` → replaces data dir and restarts.
  - Practice the drill now, then schedule it in Phase 16.

- [ ] **2.5 Connect the frontend to real persistence**
  - Replace every `setState(...)` write with an API call + optimistic update; keep `subscribe()` for re-render.
  - WS `events` topic updates the store live (replaces the `setInterval` simulation ticker — delete it in Phase 5).

**✅ Done when:** `npm run seed` produces the full demo (all 6 agents visible in the UI), `npm run seed -- --reset` restores it after you mess things up, and killing the gateway mid-write never corrupts the DB.

---

# Phase 3 🚪 Gateway Core — Real API & WebSocket

**Goal:** the self-hosted backend: HTTP API, WebSocket event stream, authentication. **Zero external dependencies** (no Redis/Postgres).

- [ ] **3.1 Scaffold the gateway**
  - `apps/gateway` with Fastify or Express (Fastify recommended: fast + schema validation built in).
  - `npm run dev:gateway` (watch mode) and `npm run dev:web` — add `concurrently` to run both with one `npm run dev`.
  - Bind to `0.0.0.0`, serve `apps/web/dist` statically in production (single process, per spec §18).

- [ ] **3.2 Implement core API resources** (in this order — each is a small vertical slice: route → validation → DB query → audit)
  1. `GET/POST /api/v1/agents`, `GET/PATCH/DELETE /api/v1/agents/:id`
  2. `GET/POST /api/v1/teams`, `GET/POST /api/v1/swarms`, `POST /swarms/:id/{deploy,pause,resume,cancel}`
  3. `GET/POST/PATCH /api/v1/tasks` (incl. `assign`, `depend`)
  4. `GET/POST /api/v1/skills`, `POST /skills/:id/{activate,eval}`
  5. `GET/POST /api/v1/chat/threads`, `POST /threads/:id/messages`
  6. `GET/POST /api/v1/approvals`, `POST /approvals/:id/{allow,deny}`
  7. `GET /api/v1/analytics/summary`, `GET /analytics/series/:metric`
  8. `GET/POST /api/v1/files`, `GET /files/:id/content`
  - Use request validation schemas (JSON Schema / Zod). Every mutation accepts an `Idempotency-Key` header (safe retries).

- [ ] **3.3 WebSocket event stream**
  - `GET /ws` upgrades; clients subscribe to topics (`runs.*`, `tasks.*`, `chat.*`, `approvals.*`, `trust.*`, `resources.*`, `analytics.*`).
  - Event envelope per spec §20.3: `{id, cursor, ts, topic, entity, type, payload, trust_context}`.
  - Implement **cursor replay**: on reconnect the client sends `lastCursor` and receives missed events (store recent events in the `events` table).

- [ ] **3.4 Authentication & RBAC (Layer 1 of governance)**
  - Session login (email + password) for the app; bootstrap first Owner from env (`BOOTSTRAP_ADMIN_EMAIL/PASSWORD`).
  - Hash passwords with **argon2** or **bcrypt**. Sessions: signed, HTTP-only, SameSite=Strict cookies.
  - Roles: `Owner, Admin, Operator, Reviewer, Observer` — enforce in a `requireRole('Operator')` middleware per route.
  - API tokens (for CLI/Telegram) in `capability_tokens` with scopes + expiry.

- [ ] **3.5 The job queue (replaces Redis)**
  - `jobs` table with leasing (`lease_owner`, `lease_until`), attempts, `next_run_at`.
  - `apps/gateway/src/queue.js`: `enqueue(type, payload)`, worker loop claims jobs with `UPDATE ... WHERE state='queued' ...` transactions, heartbeats leases, retries with exponential backoff, poisons after N attempts.
  - On gateway startup: reclaim jobs whose leases expired (crash recovery).

**✅ Done when:** the web app runs fully against the gateway (no `localStorage`), a second browser tab sees live WS updates, and restarting the gateway mid-job resumes cleanly.

---

# Phase 4 🤖 Agents & Framework Adapters

**Goal:** real agent execution — an agent profile becomes a running LLM + tools loop, with a pluggable adapter per framework.

- [ ] **4.1 Define the Framework Adapter Interface (FAI)** — `packages/shared/fai.js`
  ```
  describe()              → capabilities (async?, streaming?, handoffs?, checkpointing?)
  compile(profile)        → runtime bundle from AgentProfile
  run(input, ctx)         → async event stream: tokens | tool_call | handoff | state | end
  checkpoint()/restore()  → pause/resume
  export_trace()          → normalized trace for audit + analytics
  self_improve_hooks()    → callbacks used in Phase 8
  ```
  - Write a **conformance test suite** (same inputs → normalized event stream) every adapter must pass.

- [ ] **4.2 Build the reference adapter first: “Raw tool-loop”**
  - Before wrestling with 7 SDKs, implement a plain ReAct-style loop (LLM → tool call → observation → …) using the Model Gateway client (Phase 6). This is the fallback adapter and your debugging baseline.

- [ ] **4.3 Implement the 7 framework adapters (one PR each)**
  - [ ] `adapters/openai-swarm.js` — lightest SDK, start here to validate FAI
  - [ ] `adapters/crewai.js` — role-based crews (Python sidecar if needed: `apps/gateway/runners/crewai/` with a tiny FastAPI runner; document Python 3.11+ requirement)
  - [ ] `adapters/langgraph.js` — graph exec + checkpointing
  - [ ] `adapters/swarmzero.js`
  - [ ] `adapters/autopentest.js` — pipeline stages with forced gates between stages
  - [ ] `adapters/aima.js` — BDI-style deliberation
  - [ ] `adapters/nautilus.js` — durable long-running (checkpoint-heavy)
  - **Beginner tip:** if a framework is Python-only, run it as a **subprocess sidecar** speaking JSON-lines over stdin/stdout. The gateway stays Node.

- [ ] **4.4 Agent run pipeline**
  - `POST /agents/:id/run` → creates a `runs` row → enqueues `run.start` job → worker calls adapter → streams events to WS `runs.*` → persists trace + cost → updates agent stats (`successRate`, `costToday`, `runs`).
  - Implement retries, timeouts (`max runtime` from profile), and cancellation (adapter `abort()` via `AbortController`).

- [ ] **4.5 Memory subsystem (real)**
  - Working memory in-run; episodic rows in `memory_episodes` (FTS5 index for search); semantic facts in `memory_semantic`; embeddings in `memory_vectors` (embedded sqlite-vec extension or brute-force cosine to start).
  - Retrieval hook: before each agent step, fetch top-k relevant memories (configurable per agent).
  - Retention job (daily): prune episodes older than the agent's retention setting.

- [ ] **4.6 Wire Agent Manager UI to reality**
  - “Run” starts a real run; the **Logs** tab streams real trace lines; tool calls show real args/results (redacted per policy); memory tab shows real counts + search.

**✅ Done when:** pressing **Run** on `Researcher-01` makes a real LLM call, invokes a real tool, stores memory, and the run appears in Analytics — with the adapter conformance suite green for all 7 frameworks.

---

# Phase 5 🐝 Teams, Swarms & the Parallel Execution Engine

**Goal:** replace the `setInterval` progress bar with a real scheduler that executes task DAGs across agents with resource limits.

- [ ] **5.1 Task DAG model**
  - Persist DAG in `tasks.deps_json` + `swarms.nodes_json`. Add validation: no cycles (topological sort), max fan-out setting.
  - Compute **critical path** for the monitor UI highlight.

- [ ] **5.2 Scheduler (`apps/gateway/src/scheduler.js`)**
  - Ready-queue = nodes whose deps are `done`. Priority = weighted fair queue × priority × deadline slack; aging prevents starvation.
  - Concurrency limits: global `parallel slots`, per-swarm slots, per-agent caps (from Settings).
  - Preemption: for checkpointable adapters, pause at safe points; others run to completion.
  - Retry policy per node (exponential backoff, max attempts, fallback agent/model, poison queue).

- [ ] **5.3 Resource allocation**
  - Track live usage per swarm: tokens/s, $/h, plugin quota, slots. Enforce budget caps: soft warn at 80% (event `budget.warned`), hard stop at 100% (configurable override through a gate).
  - Feed the **Resource lanes** panel in the Live Monitor from real numbers.

- [ ] **5.4 Swarm lifecycle**
  - `deploy` → validates team + budget + gate policy → creates swarm + nodes → schedules wave 1 → streams `swarm.*` events.
  - `pause` (freeze at checkpoints), `resume`, `cancel` (rollback in-flight privileged actions via gates).
  - Fan-out/fan-in: sub-tasks spawn child nodes with budget inheritance.

- [ ] **5.5 Real-time visualization**
  - Live Monitor DAG receives `runs.*` events (node status colors animate from real state). Wave timeline scrubs the `events` table for history replay.
  - Operator controls call real API: pause node, cancel, retry, bump priority, reassign agent, add approval hold.

**✅ Done when:** deploying `market-intel-swarm` executes 6 real nodes in dependency order across 3 agents, the DAG and resource bars move only on real events (no timers), and `npm run seed -- --reset` restores the demo swarm in `live` state.

---

# Phase 6 🧠 Model Gateway — Real LLM Calls

**Goal:** every model chip in the UI maps to a real provider call with streaming, routing, fallbacks, budgets, and a sealed key vault.

- [ ] **6.1 Provider adapter layer (`apps/gateway/src/models/`)**
  - One file per category with a common interface: `listModels()`, `chat(params) → stream`, `embed?(text)`, `health()`.
  - Implement in this order (validate with real keys as you go):
    1. **OpenAI** (GPT-5, o3) · **Anthropic** (Claude Opus 4, Sonnet 4) · **Google** (Gemini 3 Pro) · **xAI** (Grok 3)
    2. **OpenRouter, Together AI, Mistral, Cohere, AI21, Zhipu GLM**
    3. **Local:** Ollama, LM Studio, llama.cpp, vLLM, LocalAI, TabbyAPI (OpenAI-compatible endpoints — usually one adapter + base URL)
    4. **Specialized:** DeepSeek, Qwen, MiniMax, Moonshot AI, Perplexity, Groq
    5. **Enterprise:** Azure OpenAI, AWS Bedrock, GCP Vertex AI, IBM watsonx
  - Normalize: streaming chunks, tool/function calls, JSON-mode errors, usage/cost accounting per provider price table (keep prices in `fixtures/prices.json`, updatable).

- [ ] **6.2 Secrets vault**
  - Encrypt provider keys at rest (libsodium `crypto_secretbox` / Node `aes-256-gcm`) with a master key from `MASTER_KEY` env (derive with scrypt).
  - API returns masked keys only (`sk-…abc`). Rotation endpoint + reminder job.
  - **Rule:** agents never see raw keys — the gateway injects them per call.

- [ ] **6.3 Routing policies (real engine)**
  - Parse the YAML policy cards (spec §29) into a matcher: `WHEN task.type ∈ … AND confidence < … → model X; fallbacks; escalate`.
  - Priority chain: workspace default → team → agent → per-request override. Log every decision (`model.routing` event) with reason for explainability.

- [ ] **6.4 Budgets, limits & caching**
  - Enforce $/day, tokens/day, per-agent, per-run caps (table `budgets`); hard-stop + `budget.hard_stop` event.
  - **Semantic cache** (opt-out per agent): hash of (model, system, messages) → cached response in SQLite; invalidation on prompt-version change.
  - Retry ladder on `schema_invalid`/`rate_limited`: same model → fallback model → escalate (per policy).

- [ ] **6.5 Wire the UI**
  - Provider **Test connection** button does a real 1-token ping; **Live Usage** streams real rows; latency sparklines use real p50/p95; per-agent model picker actually changes the model used.

**✅ Done when:** a chat message and an agent run both make real LLM calls to two different providers in one session, fallback works when you revoke a key, and costs in Analytics match provider dashboards within ~5%.

---

# Phase 7 🧩 MCP Plugins — Real Integrations

**Goal:** the Plugin Marketplace installs real MCP servers; every tool call flows through the audited gateway proxy.

- [ ] **7.1 MCP client + proxy (`apps/gateway/src/mcp/`)**
  - Support transports: **stdio** (spawn subprocess), **SSE**, **HTTP** (streamable). Use the official MCP SDKs (TS/Python).
  - Registry: `plugin_tools` rows describe each tool (JSON schema). Agents request calls via `tool.invoke` → proxy checks: allowlist → trust policy (Phase 11) → budget → **gate if privileged** → execute → scan response for prompt-injection patterns → write `audit_log` → return.
  - Capability tokens: short-lived per-call tokens replace raw credentials.

- [ ] **7.2 Curated connectors (one at a time — install → config → call → audit)**
  - [ ] **GitHub** — repos.read, code.search, pr.create, issues.manage, actions.trigger (fine-grained PAT scopes; `pr.create` = gated)
  - [ ] **Supabase** — db.query, db.migrate, auth.admin, storage, edge.invoke (migrations gated)
  - [ ] **Firecrawl** — scrape, map, crawl, extract, search (wire into research skills)
  - [ ] **Vercel** — deploy, env.manage, logs.read, domains, projects (`deploy` to production = gated)
  - [ ] **Airtable** — base.list, records.crud, schema.update (per-base scopes)
  - [ ] **Base44** — apps.list, data.crud, functions.invoke, auth
  - Each connector needs: config schema, health-check call, tool permission UI mapping, fixtures for tests (recorded JSON), and an uninstall cleanup step.

- [ ] **7.3 Custom MCP servers**
  - “Add MCP server” form must actually spawn/connect and register tools; flag `verified:false`; egress still proxied; kill/restart with backoff + circuit breaker (watchdog job).

- [ ] **7.4 Plugin budgets & limits**
  - Per-plugin rate limits and daily quotas (visible in Settings); `resource.throttled` events when hit.

**✅ Done when:** installing **Firecrawl** in the marketplace lets `Researcher-01` really scrape a URL (visible in audit log with args hash + latency), and a `vercel.deploy` tool call from an agent really blocks on an approval gate.

---

# Phase 8 ⚡ Skills Runtime & Self-Improving Loop

**Goal:** OpenClaw skills that really execute, and the self-improvement loop (skill synthesis, prompt refinement, tool optimization) working end-to-end with human review.

- [ ] **8.1 Skill package format & loader**
  - Implement the manifest from spec §11.4 (`name, version, runtime, entry, tools, permissions, evals, trust`).
  - Loader: parse `skill.md` (markdown prompt skill) or `skill.js` (executable skill) → validate manifest → bind declared tools (must exist in the agent's granted tools) → reject dependency cycles at install time.
  - Versioning: semver rows in `skills` + `skill_versions`; one-tap rollback in UI.

- [ ] **8.2 Skill packs & loadouts**
  - Bundle skills into packs (“Research Pack”, “Pentest Pack”, “Content Pack”) as `fixtures/packs/*.json`.
  - Per-agent loadout + autoload rules + invocation priority (used by the run loop in Phase 4).

- [ ] **8.3 Eval harness (gates everything)**
  - `evals/suite.yaml` per skill: list of {input, expected checks} cases. Runner executes the skill in a **sandboxed session** (no privileged tools, capped tokens) and scores with LLM-judge + deterministic checks.
  - Minimum pass rate for activation (configurable, default 80%). Eval results feed the trust score (Phase 11) and the Skills Hub “eval trend” chart.

- [ ] **8.4 Skill synthesis (agents write new skills)** 🧬
  - Trigger detection: repeated sub-task patterns or explicit “learn from this” in Reflect step.
  - Agent proposes: manifest + body + eval suite → runs evals in sandbox → submits to **Synthesized** queue with evidence (before/after metrics, trigger episodes).
  - Activation policy from Settings: `off | suggest | auto-with-review | full-auto (tier A only)`. **Never silent auto-activation.**
  - UI: Synthesized tab review actions (`Approve & activate / Edit / Reject (feedback to agent)`) become real API calls with audit entries.

- [ ] **8.5 Prompt refinement** 📝
  - Golden task set per agent (editable in UI). Refinement loop: agent proposes prompt diff → run golden set + safety evals → accept only if score improves and safety doesn't regress → publish as `prompt_versions` row with `origin: agent-refined` + metric deltas.
  - Auto-rollback job: if live KPIs drop below floor within N hours of promotion, revert to previous version.

- [ ] **8.6 Tool-usage optimizer (ML)** 🔧
  - Contextual bandit per agent over tool/strategy choices (features: task type, input size, historical cost/latency/success). Reward = success − λ·cost − μ·latency.
  - Constraint: the bandit may only choose among **already-allowed** tools (never expands permissions).
  - Persist the model in SQLite (`bandit_models` table or JSON blob); retrain incrementally on run completion. Explain choices in the Trust tab.

- [ ] **8.7 Memory + loop integration**
  - Reflect step writes distilled learnings to `memory_semantic`; loop records (`loop_records` table) capture plan/act/observe/reward for the ML jobs and Analytics “self-improvement impact”.

**✅ Done when:** `Content-Weaver` really proposes `content.repurpose` → evals run → you approve it in Skills Hub → the skill executes in a later run; and a prompt refinement measurably raises an agent's eval score.

---

# Phase 9 💬 Chat + ✦ Copilot (Real LLM, Real App Control)

**Goal:** chat streams real LLM tokens; the Copilot parses intents with an LLM and executes **real app actions** through the API with action cards.

- [ ] **9.1 Chat engine**
  - `POST /threads/:id/messages` → orchestrator picks the agent (or copilot) → builds context (thread history, agent memory, attached artifacts) → streams tokens via Model Gateway → persists message + usage.
  - Implement @mentions (dispatch to named agent), slash commands (`/run /task /deploy /approve /ask`), and per-send model override.
  - Rich message blocks: tool-call cards, code blocks (“Open in Terminal/Files”), tables, artifact previews, approval cards — all driven by the real WS stream.

- [ ] **9.2 Copilot intent router (LLM + tools)**
  - Replace the rule engine in `copilot.js` with an LLM **tool-calling** loop whose tools are the *app's own API*: `create_agent`, `deploy_swarm`, `create_task`, `open_route`, `approve_gate`, `set_setting`, `run_agent`, `query_analytics`, `terminal_exec`…
  - Flow: **Intent → Plan (tool calls) → Confirm (action card) → Act (API) → Report**. Render the plan as the existing action-card UI (reuse component).
  - Scoped sessions (read-only / this-swarm / full app) enforced by filtering which tools the LLM can call.

- [ ] **9.3 Copilot safety (do not skip)**
  - [ ] **Self-approval ban:** an `approve_gate` tool executed by the copilot principal is rejected by the API when the gate's requester is the copilot or the same agent — enforced server-side, not just in UI.
  - [ ] Prompt-injection defense: tool results and fetched content are wrapped as untrusted; instructions inside them can't elevate permissions.
  - [ ] Dry-run mode: copilot plans everything and emits a runbook without executing.
  - [ ] Attribution: every action audited as `You via Copilot` with the plan snapshot.
  - [ ] Conversation memory is user-visible/editable (What Copilot remembers).

- [ ] **9.4 Voice (optional but specified)**
  - Push-to-talk via Web Speech API or Whisper API; show recognized intent before acting.

- [ ] **9.5 Context strip**
  - Auto-attach open screen + selected entities + recent runs as removable context chips; “Add context” picker for entities/files/log ranges.

**✅ Done when:** typing `deploy swarm “audit our Vercel staging”` into the dock produces a real plan card, and confirming it really deploys a swarm (visible in Teams) — while `approve ap-1` from the copilot of its own gated request is rejected by the API.

---

# Phase 10 ✈️ Telegram Bridge (Real Bot)

**Goal:** operate SwarmOS from real Telegram: commands, notifications, two-way agent chat, inline approval buttons.

- [ ] **10.1 Bot setup (real)**
  - Create a bot with @BotFather; put the token in the gateway `.env` (sealed vault). Setup wizard in the UI calls the real Telegram API (`getMe` test, webhook/long-poll toggle).
  - **Long polling first** (works behind NAT — perfect for self-hosters), optional webhook mode later.

- [ ] **10.2 Command layer (spec §11.8)**
  - Implement handlers: `/status /swarms /swarm <id> /deploy /agents /agent <id> <action> /tasks /task /ask /approve /deny /models /use /logs /budget /copilot /help`.
  - All commands map to the **same API + RBAC** as the app; `via: telegram` recorded in audit.

- [ ] **10.3 Inline approval buttons (signed, one-time)**
  - Approval notifications include `✅ Allow once / ❌ Deny` inline buttons carrying a **signed one-time token** (HMAC over `approval_id + chat_id + expiry`); replay = rejected. Handlers call the approvals API with the Telegram principal.

- [ ] **10.4 Allowlist & roles**
  - Chat-ID allowlist enforced at ingress; map Telegram users → principals/roles; `/link <code>` flow to bind an account.

- [ ] **10.5 Notification topics & digests**
  - Topic routing (Approvals/Failures/Deployments/Budget/Trust/Daily digest) with quiet hours; severity → silent vs. notified.
  - Daily/weekly digest job (from Analytics aggregates) posted to the configured chat.

- [ ] **10.6 Two-way agent chat**
  - `/ask agent msg` starts a session bound to the chat; agent replies stream in chunks (edit message); humans can `/pause`; agents can ask humans questions via the bot.

**✅ Done when:** you deny an approval from your phone in Telegram and the gateway blocks the Vercel deploy, and `/budget` returns today's real spend.

---

# Phase 11 🔐 Trust & Governance Engine

**Goal:** the four-layer security framework fully enforced server-side: gates, trust scores, hash-chained audit.

- [ ] **11.1 Policy engine (Layer 4 rules as data)**
  - `policies` table: `IF action ∈ {deploy.prod, db.migrate, spend > $X, fs.delete, github.pr.merge, vercel.prod, self.improve.activate} THEN require approval FROM {role}`.
  - Evaluation API `POST /policy/simulator` (“what happens if agent X does Y?”) — used by Settings UI + copilot.
  - Gate templates in Settings map to real policy rows (CRUD).

- [ ] **11.2 Approval objects (real lifecycle)**
  - `request → pending → allowed/denied/expired` with evidence bundle (plan/diff), decider identity, scopes (“always for this tool/target/agent”), delegation + escalation timeouts (page alternate approver).
  - Inline cards in Chat/Task/Telegram all resolve through `POST /approvals/:id/{allow,deny}`.

- [ ] **11.3 Trust scoring service (Layer: per-agent trust)**
  - Implement the formula (spec §16.2) as a scheduled job (hourly) + event-driven updates (`trust.changed` with factor deltas: “−6: approval denied…”).
  - Weights from Settings sliders feed the engine live. Tiers gate features: tier A unlocks `full-auto`, tier C auto-quarantines (role reassignment + human review).
  - Manual operator adjustment with audit trail (`operator_adjust`).

- [ ] **11.4 Hash-chained audit log (Layer 3)**
  - Append-only `audit_log` with `hash = H(prev_hash + entry)`; verification endpoint/CLI `npm run audit:verify`.
  - Record: principal, `actor_via`, action, redacted args + args hash, policy decision, result. Retention + export (JSON/CSV) jobs.

- [ ] **11.5 Runtime isolation (Layer 2)**
  - Capability tokens per agent (tool allowlist + caps + TTL); filesystem via artifacts ACLs; **all network egress via gateway proxy** (domain allowlists per agent).
  - Sandboxed tool processes (resource limits; containers if host supports); prompt-injection scanner on tool results crossing trust boundaries.

**✅ Done when:** the policy simulator matches real enforcement in 20 golden test cases; tampering with an old audit row breaks the hash chain and `audit:verify` fails loudly; a tier-C agent is auto-quarantined after simulated incidents.

---

# Phase 12 📁 Artifacts + 💻 Terminal (Real)

**Goal:** a real governed filesystem and a real terminal.

- [ ] **12.1 Artifacts store**
  - Files on disk under `data/artifacts/` with metadata in `files`/`file_versions` (content-addressed blobs + dedupe). Path ACLs: `/runs/**` owned by the run's agent, `/shared/**` team-visible.
  - Real upload (multipart), download, move/rename/trash/restore, text search (SQLite FTS over extracted text), preview rendering stays client-side.
  - File journal: every write records `who/when/run-id`; secret-pattern redaction in previews.

- [ ] **12.2 Terminal (real PTY)**
  - `node-pty` on the gateway; WS `terminal.*` channels; xterm.js on the client (replace the fake CLI).
  - Sessions: local shell profiles (`sh`, `bash`, `python`, `node`, `swarm-cli`), per-session cwd/env, kill/attach, asciinema-style replay saved as artifact.
  - `swarm` CLI (`apps/gateway/cli/`): `swarm status|agents|swarms|deploy|logs|approve|audit:verify` using API tokens.

- [ ] **12.3 Safety rails (do not skip)**
  - Command policy engine (allow/deny regex lists from Settings); destructive patterns (`rm -rf`, `git push --force`, `DROP TABLE`, mass `kill`) require confirm cards; read-only session mode; agent PTYs in sandbox profiles with caps.

**✅ Done when:** uploading a file in the UI creates a real file on disk with ACL metadata, and the terminal runs a real `bash` — with `rm -rf /` blocked by policy and everything replayable.

---

# Phase 13 📊 Analytics (Real Metrics)

**Goal:** every chart driven by real events/runs.

- [ ] **13.1 Event pipeline**
  - All domain events (run/tool/gate/trust/budget) land in `events` + rollup tables (`metrics_hourly`) via a small aggregation job (every 5 min).

- [ ] **13.2 Aggregation endpoints**
  - `analytics/summary` (stat tiles), `analytics/series/:metric` (time series), leaderboard, trust distribution, MCP activity, self-improvement impact, cost attribution (by team/swarm/agent/task type).

- [ ] **13.3 Export & digests**
  - CSV/JSON export (real files to artifacts); scheduled Telegram digests (Phase 10) built from these aggregates.

- [ ] **13.4 Anomaly notices (light)**
  - Simple detectors: spend spike vs. 7-day baseline, success-rate drop, trust drop > 10 pts → `System` notifications.

**✅ Done when:** Analytics numbers reconcile with the `runs` table (spot-check SQL) and export produces a real CSV in Artifacts.

---

# Phase 14 📱 PWA & Offline Hardening

**Goal:** installable, offline-capable, mobile-perfect.

- [ ] **14.1 Service worker strategy (production)**
  - Cache app shell on install; navigation = network-first w/ cache fallback; hashed assets = stale-while-revalidate; versioned cache name with cleanup on activate.
  - Test with DevTools → Network → Offline after a first visit.

- [ ] **14.2 Offline action queue**
  - Mutations made offline are queued (`pendingQueue`) with `Idempotency-Key`s and synced on reconnect (background sync where supported; `online` event fallback). Show the “N queued actions” banner + review list.

- [ ] **14.3 Mobile polish pass**
  - Touch targets ≥ 44 px audit; safe-area insets on all fixed bars; 320 px viewport test (no horizontal scroll); `prefers-reduced-motion`; text-only zoom.
  - iOS Safari + Android Chrome install flows tested on real devices; share-target (`navigator.share`) for artifacts.

- [ ] **14.4 Performance budgets (from spec §23)**
  - Shell interactive ≤ 2.5 s on mid-range phone/4G; initial JS ≤ 250 KB gzip; route transitions ≤ 200 ms. Lighthouse (mobile) performance ≥ 90.

**✅ Done when:** Lighthouse PWA checks pass, the app is usable in airplane mode (shell + queued actions), and budgets hold on a real phone.

---

# Phase 15 🧪 Testing & QA

**Goal:** confidence to change code safely. (Run continuously from Phase 1 onward — this phase is the formalization.)

- [ ] **15.1 Unit tests** — Vitest for: policy engine (golden cases), trust formula, routing matcher, job queue leasing, DAG topo sort, bandit updates, audit hash chain.
- [ ] **15.2 Adapter conformance suite** — every framework adapter passes the FAI tests (run/stream/checkpoint/trace).
- [ ] **15.3 Integration tests** — API + real SQLite (temp DB per test): CRUD, gates, RBAC matrix fuzzing, WS replay from cursor.
- [ ] **15.4 E2E (Playwright, mobile viewport 390×844)** — the golden path: seed → create agent → attach skills → deploy swarm → approve gate from Telegram (mock API) → analytics updates; plus offline-queue sync path.
- [ ] **15.5 Load** — 200 concurrent agent runs on one gateway; scheduler fairness assertions; WS fan-out to 50 clients; record numbers in `docs/load-test.md`.
- [ ] **15.6 Chaos** — kill plugin subprocess mid-run; restart gateway mid-job; revoke a provider key mid-run; assert recovery + audit integrity.
- [ ] **15.7 Security** — prompt-injection corpus (jailbreak text in tool results), secrets-leak scanning of logs/exports (gitleaks in CI), auth/negative tests, `npm audit` gate.
- [ ] **15.8 Accessibility** — axe checks in CI + one manual screen-reader pass per release.
- [ ] **15.9 CI pipeline** — GitHub Actions: `lint → smoke → unit → integration → build` on every PR; e2e + load on main nightly.

**✅ Done when:** CI is green on main, the golden-path e2e runs nightly, and a deliberate bug (break the hash chain) makes CI fail.

---

# Phase 16 📡 Observability & Ops Tooling

**Goal:** see what's happening and survive accidents.

- [ ] **16.1 Structured logging** — pino JSON logs (request-id, principal, run-id) to `data/logs/` with rotation + retention from Settings. Redaction of secrets/PII.
- [ ] **16.2 Metrics** — `/metrics` (Prometheus text format is fine even without Prometheus) + the in-app Analytics. Track: run success rate, queue depth, WS clients, provider latency/error, budget utilization.
- [ ] **16.3 Health & diagnostics** — `/healthz` (DB, queue, plugins, providers), “diagnostics bundle” button (redacted logs + config + versions) in Settings.
- [ ] **16.4 Backups on schedule** — daily `npm run backup` via cron/Task Scheduler; keep N days; optional push to S3-compatible storage via a plugin; **quarterly restore drill** (put it in the calendar).
- [ ] **16.5 Alerts** — health-check failures, queue backlog, budget hard-stops, trust quarantines → Telegram System topic.

**✅ Done when:** you can diagnose a simulated outage from logs + diagnostics bundle alone, and a restore drill recovers the app from backup in < 30 minutes.

---

# Phase 17 🚀 Deployment & Production Ops

**Goal:** ship it — self-hosted with zero external dependencies.

- [ ] **17.1 Containerize**
  - `apps/gateway/Dockerfile` (multi-stage: build web → run gateway serving `dist/` + SQLite + artifacts in a volume).
  - `docker-compose.yml`:
    ```yaml
    services:
      swarmos:
        build: .
        ports: ["8787:8787"]
        env_file: .env
        volumes: ["./data:/data"]
        restart: unless-stopped
    ```
  - Verify: `docker compose up` on a clean machine = working app on `:8787`.

- [ ] **17.2 Server + domain + TLS**
  - Any VPS (Hetzner/DigitalOcean/…) or home lab. Put **Caddy** (auto-HTTPS) or nginx in front. Open only 80/443. Set `PUBLIC_URL`.
  - Cloudflare Tunnel is a nice zero-port alternative for home hosting.

- [ ] **17.3 Production config**
  - Strong `MASTER_KEY`, `BOOTSTRAP_ADMIN_*`, `SESSION_SECRET`; `NODE_ENV=production`; file permissions `600` on `.env`; disk quota for `data/`.

- [ ] **17.4 Update & rollback procedure**
  - `git pull && npm ci && npm run migrate && npm run build && docker compose restart`. Keep the previous `dist/` + DB backup before each update. Document rollback (restore backup + previous image).

- [ ] **17.5 Security baseline**
  - SSH keys only, firewall (ufw), automatic security updates, fail2ban optional; dependency updates via Dependabot; token rotation reminders.

- [ ] **17.6 Runbook (`docs/RUNBOOK.md`)**
  - Incident types (gateway down, queue stuck, provider outage, budget runaway, compromise) → detection → mitigation → postmortem template.

**✅ Done when:** the app runs at `https://your-domain` on a fresh server following only your docs, survives a reboot, and an update+rollback drill succeeds.

---

# Phase 18 🎉 Launch & Post-Launch

- [ ] **18.1 Pre-launch checklist**
  - [ ] All Prototype→Real items `✅` · [ ] Seed/restore drill done · [ ] Backup + restore drill done · [ ] Load test numbers recorded · [ ] Security test summary reviewed · [ ] README quick-start validated by someone who has never seen the project · [ ] RUNBOOK rehearsed · [ ] Costs: verify Analytics vs provider dashboards.

- [ ] **18.2 Soft launch** — deploy for 1–2 real users/teams; watch: run success rate, gate hit rate, provider errors, budget accuracy. Fix before widening.

- [ ] **18.3 Post-launch cadence**
  - Weekly: review audit highlights, trust movements, synthesized skills queue, provider spend.
  - Monthly: dependency updates, restore drill rotation, policy review, price-table update.
  - Quarterly: access review (who has Owner/Admin), token rotation, chaos drill.

- [ ] **18.4 Iterate on the roadmap** — backfill spec §25 P1–P4 items not yet done; open issues for every deferred item.

---

# 📎 Appendix A — Sample Data & Instance Inventory

> Every demo object below ships in `fixtures/` (Phase 2) and must be restorable with `npm run seed -- --reset`. IDs match the prototype so links/screenshots stay valid.

## Agents (6)
| ID | Name | Framework | Model | Trust | Notes |
| --- | --- | --- | --- | --- | --- |
| `ag-researcher` | Researcher-01 | LangGraph | anthropic/claude-sonnet-4 | 92 | running; firecrawl tools |
| `ag-coder` | Coder-07 | CrewAI | openai/gpt-5 | 88 | running; GitHub PR tools |
| `ag-pentester` | RedTeam-Alpha | AutoPentest | anthropic/claude-opus-4 | 76 | paused; every step gated |
| `ag-sre` | SRE-Bot | Swarmzero | google/gemini-3-pro | 95 | running; Vercel tools |
| `ag-content` | Content-Weaver | Project Nautilus | mistral/large-latest | 81 | idle; Airtable/Supabase |
| `ag-analyst` | Analyst-Prime | A.I.M.A | deepseek/deepseek-v3 | 58 | error state; tier B watch |

## Teams (3) · Swarms (1)
- `tm-research` Research Squad (Hierarchical: researcher, content, analyst) · `tm-ops` Ops Crew (Peer mesh: sre, coder) · `tm-red` Red Cell (Pipeline: pentester, analyst)
- `sw-market` **market-intel-swarm** — objective: “Map the EU AI-agent market”, budget $10 (spent $3.41), 6 DAG nodes: planner → research-a/research-b → analyze/writer → assembler, channel telegram.

## Tasks (9)
`tk-1` Draft EU market map *(done)* · `tk-2` Crawl vendor pricing *(doing)* · `tk-3` Normalize pricing into Airtable *(doing)* · `tk-4` Positioning heatmap *(review)* · `tk-5` Security review of new MCP plugin *(todo, high)* · `tk-6` Rotate Vercel deploy key *(todo, high)* · `tk-7` Weekly cost digest *(doing)* · `tk-8` Refine Content-Weaver prompt v12 *(review)* · `tk-9` Archive Q3 artifacts *(done)*

## Skills (6)
`sk-1` firecrawl.deep-research v1.2.0 (marketplace) · `sk-2` dev.tdd-loop v2.0.1 · `sk-3` sre.triage v1.5.0 (user) · `sk-4` **content.repurpose v0.9.0 — synthesized by Content-Weaver (pending review)** · `sk-5` **data.forecast-lite v0.3.1 — synthesized by Analyst-Prime (pending review)** · `sk-6` core.citations v1.0.2

## Plugins (6)
GitHub (installed), Firecrawl (installed), Vercel (installed), Supabase, Airtable, Base44 (available) — tool lists & scopes per spec §11.6.

## Providers (26)
Frontier: OpenAI, Anthropic, Google, xAI · Mid-tier: OpenRouter, Together, Mistral, Cohere, AI21, Zhipu · Local: Ollama, LM Studio, llama.cpp, vLLM, LocalAI, TabbyAPI · Specialized: DeepSeek, Qwen, MiniMax, Moonshot, Perplexity, Groq · Enterprise: Azure OpenAI, AWS Bedrock, GCP Vertex, IBM watsonx. (On by default: the ones with demo spend in `providers.json`.)

## Policies (3) · Approvals (2)
`po-1` default-task-routing · `po-2` cheap-night-shift · `po-3` code-escalation
`ap-1` vercel.deploy · production (SRE-Bot, medium) · `ap-2` db.migrate · staging (Analyst-Prime, high)

## Chat (3) · Files (6) · Events (6) · Telegram demo
Threads: `th-1` Researcher-01 DM · `th-2` # market-intel-swarm · `th-3` SRE-Bot DM (with an embedded approval card)
Files: `runs/market-intel/report.md`, `vendors.csv`, `skills/content.repurpose/skill.md`, `logs/gateway-2026-10-12.log`, `configs/routing.yaml`, `artifacts/heatmap-positioning.png`
Settings: workspace `SwarmLab`, trust weights (success 12, compliance 10, approvals 8, evals 8, uptime 6, incidents 15, cost 8), self-improve policy `suggest`, autonomy default L2.

---

# 📎 Appendix B — Restoring the Application & All Sample Data

Use this whenever you want the factory demo back (screenshots, workshops, debugging).

| Method | When to use | How |
| --- | --- | --- |
| **In-app button** | Quick reset during dev | Settings → ⚠️ Data → **Reset demo data** (confirms with typed `RESET`) |
| **Seed script** | Fresh DB / scripted setup | `npm run seed -- --reset` (wipes, re-migrates, inserts all fixtures) |
| **Seed (non-destructive)** | Add demo to an empty DB | `npm run seed` (skips entities that already exist) |
| **Backup restore** | Recover real data | `npm run restore -- backups/<timestamp>` |
| **Nuclear (prototype only)** | Old localStorage prototype | DevTools → Application → Local Storage → delete key `swarmos-state-v1` → reload |
| **API (CI/tests)** | Ephemeral environments | `POST /api/v1/dev/seed?reset=1` (must be disabled in production via `ALLOW_DEV_SEED=false`) |

**Fresh-machine bring-up (everything, in order):**
```bash
git clone https://github.com/shawnthedon/MMM.git && cd MMM
npm install
npm run migrate          # create SQLite schema
npm run seed             # load all sample data & instances
npm run dev              # web + gateway
# or production:
npm run build && npm run start
```
**Verify restoration:** 6 agents on Agents screen · 1 live swarm with 6 DAG nodes · 9 Kanban cards · 2 pending approvals (bell badge “2”) · 2 synthesized skills awaiting review · 26 providers listed · Telegram demo conversation present.

---

# 📎 Appendix C — Command Reference (cheat sheet)

| Command | Does |
| --- | --- |
| `npm run dev` | Dev servers (web + gateway) |
| `npm run build` / `npm run preview` | Production build / serve built PWA |
| `npm run smoke` | Runtime smoke test (all 12 modules render) |
| `npm run test` | Unit + integration (Vitest) |
| `npm run e2e` | Playwright golden-path tests |
| `npm run lint` / `npm run format` | Code style |
| `npm run migrate` | Apply DB migrations |
| `npm run seed [-- --reset]` | Load / restore sample data |
| `npm run backup` / `npm run restore -- <dir>` | Backup / restore data |
| `npm run audit:verify` | Verify audit hash chain |
| `npm run icons` | Regenerate PWA PNG icons |
| `./scripts/push-to-github.sh <url> [token]` | Push repo to a remote |

---

# 📎 Appendix D — Beginner Glossary

| Term | Meaning |
| --- | --- |
| **Migration** | A SQL file that changes the database structure; applied in order, never edited after |
| **Seed / fixture** | Sample data files used to fill the database with demo agents/tasks/… |
| **WS (WebSocket)** | A persistent connection the server uses to push live updates to the UI |
| **PTY** | A pseudo-terminal — what makes the in-app terminal a *real* shell |
| **MCP** | Model Context Protocol — standard way to expose tools to agents |
| **Adapter** | Code that lets one agent framework speak SwarmOS's common interface (FAI) |
| **Approval gate** | A policy checkpoint requiring human sign-off before a privileged action |
| **Trust tier** | A (≥80) / B (50–79) / C (<50) — computed score unlocking or restricting autonomy |
| **Hash chain** | Each audit row embeds the previous row's hash — tampering breaks the chain |
| **Idempotency key** | A request header making retries safe (server deduplicates) |
| **Bandit** | A simple ML model that learns which tool/strategy works best over time |
| **PWA** | Progressive Web App — installable website with offline support |

---

*Work through Phase 0 today. Check boxes as you go. When Appendix B's “Verify restoration” passes on a production deploy, you're done.* ✅
