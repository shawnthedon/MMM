# 🚀 MMM — Production Roadmap: Out of Demo Mode, Into Live Operation

**Status:** authoritative execution plan
**Written:** 2026-10-28 · **Baseline commit:** `743e45f` (`main`)
**Audience:** whoever picks this up next — including a developer who has never seen this repo
**Scope:** the *remainder* of application development up to and including production operation

---

## 0. How to read this document

This roadmap answers one question in order:

> “The app looks finished but is still a demo. What exactly is fake, in what order do I fix it, and how do I prove each fix is real?”

It is deliberately sequenced **de-demo first**. Nothing else in this plan matters until the app stops
presenting seeded browser data as system state. Security, backups, and CI come next because they are
cheap to add while the system is small and very expensive to retrofit after real users exist.

Five parts, used together:

| Part | What it is | When you use it |
| --- | --- | --- |
| **1. Audit** | What is actually true today, with file references | Read once, re-verify each release |
| **2. Demo inventory** | Every simulated surface + its rectification path | Work item by work item |
| **3. Live-operation track (L0–L8)** | Ordered phases with beginner steps | The main build sequence |
| **4. Non-functional checklist** | Detailed NFR requirements with evidence gates | Runs in parallel from L1 onward |
| **5. TODO list + schedule + evidence log** | Flat checkboxes, week plan, proof table | Daily stand-up |

### 0.1 Relationship to the existing documents (do not duplicate them)

The repository already contains a large amount of planning material. **This document is the
sequencer; the older documents are the detail libraries.** When they disagree about *order*, this
document wins. When they disagree about *detail*, the older document wins.

| Document | Owns | Relationship to this file |
| --- | --- | --- |
| [`IMPLEMENTATION_CHECKLIST.md`](IMPLEMENTATION_CHECKLIST.md) | Functional build-out, Phases 0–18, sample-data inventory | Reference for *how* each feature is built. Its Phase 6/7/9/12/13 map onto L4–L7 here. |
| [`IMPLEMENTATION_ROADMAP.md`](IMPLEMENTATION_ROADMAP.md) | NFR deep dives + milestones **M1–M9** + resource library | Reference for NFR theory. Part 4 here is the *checklist* form of M1–M9, plus the demo-exit track that it lacks. |
| [`FEATURE_COMPLETION_ROADMAP.md`](FEATURE_COMPLETION_ROADMAP.md) | Module playbooks M01–M21: what each screen fakes, and step-by-step how to make it real | **The how.** Phases L3–L7 below are the *order*; this file is the *implementation detail* for each screen. |
| [`roadmap/next-up.md`](roadmap/next-up.md) | Open items with acceptance criteria (Kanban, Comms, Local AI) | Its open items appear here as `L7`/`L8` work. |
| [`PROGRESS.md`](PROGRESS.md) | Running status log | Append one line per phase completed here. |
| [`DESIGN_SPEC.md`](DESIGN_SPEC.md), [`design/RELAY_DESIGN_SYSTEM.md`](design/RELAY_DESIGN_SYSTEM.md) | Visual + behavioural standards | Binding on every UI change below. |
| [`copilot/`](copilot/), [`voice/`](voice/), [`comms/`](comms/), [`local/`](local/), [`kanban/`](kanban/) | Feature specs and evidence | Cite them instead of re-specifying. |

**The rule that keeps these from drifting:** the demo inventory in Part 2 is the single list of
“things that lie.” Every item has an ID (`D01`…). When you close one, you tick it in Part 5 and you
update the row in Part 2 — nowhere else.

### 0.2 Legend

| Symbol | Meaning |
| --- | --- |
| 🟥 **P0** | Blocks any external user. Fix before a stranger sees the app. |
| 🟧 **P1** | Blocks public launch / paid use. |
| 🟨 **P2** | Blocks scale, hiring, or support. Do before GA+1 quarter. |
| ✅ | Verified in this repository, with the command that proves it |
| ⚠️ | Implemented but **not verified live** — must not be described as working |
| ❌ | Does not exist |
| 🎭 | Demo / simulated / seeded |
| **Evidence** | The command or artefact that turns a claim into a fact |

Every “done” in this plan requires **evidence**, not inspection. A phase is not complete because the
code looks right; it is complete when a command output, screenshot, measurement, or provider receipt
is pasted into the evidence log in Part 6.

### 0.3 Ground rules (non-negotiable, inherited from the product spec)

1. **Never present seeded, simulated, or disconnected behaviour as functional.** If the app cannot
   do a thing, the UI says so.
2. **No inert controls.** A button either does the thing, or is disabled with a reason.
3. **Passwords and provider keys never touch client JavaScript, `localStorage`, logs, URLs, or chat.**
4. **When blocked, mark BLOCKED.** “Could not verify” is a valid, respectable result and is always
   better than a false PASS.
5. **Mobile-first.** Base CSS targets the smallest screen, `min-width` queries only, no `max-width`
   media queries, nothing truncated at 320 px, targets ≥ 44 px. Enforced by
   `npm run test:responsive`.
6. **Dark is the default theme**, and no screen may render unstyled/white.

---

## 1. Verified state of the build (2026-10-28)

This section is the honest starting line. It was produced by reading the code and running the
commands below, not by trusting the README.

### 1.1 What is genuinely real today

| Area | State | Proof |
| --- | --- | --- |
| Gateway HTTP + WebSocket server (zero-dep + `ws`) | ✅ | `npm run test:gateway` (28), `npm run test:comms-gateway` (27) |
| Auth: session cookie, CSRF, `mmm_` scoped bearer tokens, lockout, RBAC (Observer→Owner), hash-chained audit log | ✅ | `npm run test:gateway`, `npm run test:session-safety` |
| SQLite persistence (WAL) + migrations 001–003 | ✅ | `npm run migrate`; `apps/gateway/migrations/` |
| Server-side Comms adapters (Telegram, WhatsApp, Discord, Slack, Twilio) with AES-256-GCM channel secrets, retry queue, signed inbound webhooks | ⚠️ | Code + mock-server tests pass (`npm run test:comms`, `27`); **no live provider has ever been verified** |
| PWA: manifest, installable, versioned service worker, offline shell | ✅ | `public/sw.js`, `public/manifest.webmanifest`, `npm run test:sw-safety` |
| UI: 19 views, RELAY design system, motion/sound/gestures, full-screen Copilot, voice studio UI | ✅ | `npm test`, browser suites, `docs/design/` screenshots |
| Test corpus: 36 scripts (unit, contract, and browser) | ✅ | `npm test` + browser suites |
| Vercel static hosting config with COOP/COEP/CSP-adjacent headers | ✅ | `vercel.json`; `npm run test:isolation` |

### 1.2 What is missing or unreliable (the real gap list)

| # | Gap | Evidence in repo |
| --- | --- | --- |
| 1 | **No CI.** Tests are run by a human, on a laptop. Nothing blocks a broken merge. | no `.github/` directory at all |
| 2 | **No supply chain / container target.** No `Dockerfile`, no `docker-compose.yml`, no SBOM, no image scanning. | root listing |
| 3 | **No linter/formatter config.** README documents `npm run lint`; the script does not exist. | `package.json` scripts vs `README.md` “Quality checks” |
| 4 | **A populated runtime database is committed to Git.** `data/mmm.sqlite` + `-shm` + `-wal`, 675 KB, containing 1 principal, 26 providers, 9 tasks, 3 teams, 1 swarm. Schema is at migration 001 while the code is at 003. | `git ls-files data`; `.gitignore` has no `data/` |
| 5 | **No observability.** Health endpoint only; no metrics, no structured logs, no traces, no error tracking, no uptime monitor, no alerting, no SLOs. | `apps/gateway/server.js` routes (`/healthz` is the only ops route) |
| 6 | **No backup or restore path.** A single SQLite file in `./data`, no snapshot job, no tested restore. | no backup script; `DATA_DIR` unused beyond `db.js` |
| 7 | **No rate limiting per principal** — one global `MMM_RATE_LIMIT` (600) for the process. No per-token quotas, no spend caps enforced server-side. | `server.js` |
| 8 | **Browser test suites are not in `npm test`.** `test:motion:browser`, `test:scroll:browser`, `test:voice:browser`, `test:relay:browser`, `test:isolation:browser`, `test:local-spike:browser`, `test:sw-safety:browser` must be run by hand. | `package.json` |
| 9 | **API contracts declared but not all exist**: swarm deploy/pause/resume/cancel, skills activate, files, analytics series. Chat messages and the Copilot conversation (`GET/POST /copilot…`, M30) now ship. | `packages/shared/api-routes.json` → `"planned"` |
| 10 | **The product still runs a browser simulation ticker** that advances swarms and spend with `Math.random()`. | `src/main.js` `tick()` |
| 11 | **No production deploy topology documented**: the gateway is a Node process, the app is a static SPA on Vercel. Nothing explains how they meet at one origin, or how TLS/same-site cookies work across them. | `README.md` “Deploy” covers Vercel only |
| 12 | **No legal/privacy surface**: no terms, no privacy notice, no data-retention enforcement (settings exist and are inert), no DPA/NDPA posture, no cookie statement. | none in repo |
| 13 | **Node runtime is unpinned** — no `engines`, no `.nvmrc`. `better-sqlite3` needs native build; `node:sqlite` is flagged experimental. | `package.json` |
| 14 | **No on-call or incident process**, no status page, no escalation, no postmortem template. | none |

**Why this matters:** the app’s *UI* is at roughly 80 % but its *operability* is at roughly 15 %.
Most teams in this position ship, then spend a year discovering items 1–14 the hard way. The
sequence below front-loads the cheap fixes.

---

## 2. Demo inventory — every simulated surface and how to rectify it

Each row is a defect against ground rule 1. Columns: **what the user sees**, **where it comes from**,
**why it is wrong**, **rectification**, **how to prove the fix**.

Read this before touching any code. It is the actual backlog of dishonesty.

### 2.1 Data provenance (the root cause)

| ID | Surface | Where | What it does today | Rectification | Evidence |
| --- | --- | --- | --- | --- | --- |
| **D01** 🟥 | Whole app runs on seeded browser data when no gateway is configured | `src/api.js` `storedUrl()/envUrl()`; `VITE_GATEWAY_URL` empty in `.env.example` | `agents`, `tasks`, `approvals`, `events` are seeded into `localStorage`; `swarms`, `teams`, `usage` **have no server store at all** (`LOCAL_SLICES` in `src/datastore.js`) | L2: make the gateway the only writer. L3: add server stores for the local slices, then delete `LOCAL_SLICES`. | `npm run test:readsync` extended to assert `liveSlices` = all 7 slices |
| **D02** ✅ | Provenance chip + source notes (`demo data` / `live gateway`) | `src/sourceui.js`, `datastore.js` `sourceExplanation()` | Tells the truth about where rows came from | **KEEP.** This is the honesty mechanism, not a demo artefact. Extend it to every new slice; never remove it to “look finished”. | `npm run test:readsync` |
| **D03** 🟧 | Status dot says “demo mode — no gateway configured” | `src/shell.js` ~L437 (`#gw-dot`) | Correct today, but becomes permanent if a build ships without `VITE_GATEWAY_URL` | L2: make `VITE_GATEWAY_URL` a build-time requirement in production (`vite build` fails or the app shows a blocking setup screen). Keep the dev fallback. | build without the var → non-zero exit or setup screen |
| **D04** 🟥 | **Live simulation ticker** — swarm progress, spend, node state, usage bars all move on a `setInterval` with `Math.random()` | `src/main.js` `tick()`; gated by `settings.simulate` | Motion that no server produced. The single most misleading thing in the app. | L3: delete the ticker. Progress must come from `swarms` rows + WS events. If nothing is running, nothing moves. | `rg "Math.random" src/main.js` → none; swarm progress in UI equals `/api/v1/swarms` payload |

### 2.2 Feature surfaces

| ID | Surface | Where | What the user sees | Rectification | Evidence |
| --- | --- | --- | --- | --- | --- |
| **D05** 🟥 | **Teams & Swarms** | `src/views1.js` (~L107, L121), seeded `fixtures/swarms.json` | Deploy sheet quotes “Deploy · est $6.40” and starts a fake swarm; footnote admits “Swarms and usage remain demo data” | L3: `POST /api/v1/swarms`, `/swarms/:id/{pause,resume,cancel}`, migration `004_swarms.sql`, WS topic `swarms`. Estimate computed from a real model-price table server-side. | `npm run test:swarms` new suite: deploy→row in SQLite→WS event→progress from server |
| **D06** 🟥 | **Chat** replies | `src/views2.js` `simulateReply()` (~L559), called from `sendChat` and `new-chat-go` | Canned agent replies, one of which invents a cost (“Estimated cost: $0.42”) | L4: persist threads/messages via `GET/POST /api/v1/chat/threads/:id/messages`. Until an LLM is wired (L5), the server returns an explicit `runtime: 'none'` acknowledgement, and the UI shows “no model configured” instead of fake prose. | thread survives reload + second browser; DB rows present; `rg "simulateReply" src` → none |
| **D07** 🟧 | **Model Gateway** | `src/views2.js` ~L336 (`26 providers`), `toggle-provider` handler | 26 seeded providers with latency numbers, MTD spend, “on/off” switches that only mutate `localStorage`; page title implies a working router | L5: provider registry seeded from a real catalogue with `verified` flags; keys stored server-side (AES-GCM, same vault as comms); one real client per provider; usage metered from responses; disable every provider with no key and label it `unconfigured`. | one live completion with token counts + cost recorded in `usage`; toggle changes server row |
| **D08** 🟧 | **Plugins / MCP** | `src/views2.js` ~L392–394 | “all calls proxied & audited by the gateway”, “gateway injects short-lived scoped tokens”, `callsToday` counters | L7: either implement MCP client + per-call scoped tokens + audit rows, or rewrite the copy to “not implemented” and remove the counters. Do not ship the banner while false. | `POST /api/v1/plugins/:id/call` audit row; or copy test |
| **D09** 🟧 | **Skills Hub** (24 marketplace skills, activation) | seeded `fixtures/skills.json`; `POST /skills/:id/activate` **planned** | Skills can be imported/validated but “activate” has no server effect | L7: implement activation (server-side row + audit) or relabel to “installed locally, not executable”. | activation changes a server row and survives reload |
| **D10** 🟧 | **Analytics** | `src/views2.js` ~L741 “Live · last 24h”, L745–748 hardcoded `+12`, `87% success`, `▲ 8%`, `median 4m`, `2 denied by policy` | Numbers literally typed into the template | L6: `GET /api/v1/analytics/series/:metric` + SQL aggregates; every tile computed or removed. Remove “Live” until it is. | tile value equals a SQL query result; no numeric literals in the template |
| **D11** 🟨 | **Export report** | `src/views2.js` `on('export-report')` | Toasts “exported → artifacts/reports/…”, then unshifts a **hardcoded CSV string** into local state | L6: generate CSV server-side from the same aggregate query, return a real file; or remove the button. | downloaded CSV matches live query for a known fixture |
| **D12** 🟧 | **Artifacts / Files** | `src/views2.js` `views.artifacts`; `GET/POST /files` planned | File list is local demo data; nothing is stored | L6: `files` table exists — expose `GET/POST /api/v1/files` with content-type validation, size cap, and owner scoping. | upload → row → download → byte-identical |
| **D13** 🟨 | **Terminal** | `src/terminal.js` (banner, `reset-demo`, `plugins` with `callsToday`) | Simulated command shell over local state | L6: keep it as a **local UI console** explicitly labelled “browser-only console”; wire real read commands through the API and refuse writes it cannot perform. Remove `reset-demo`. | `help` output lists only implemented commands; each tested |
| **D14** 🟩 | **Copilot answers + drafts** | `apps/gateway/src/copilot.js`, `src/copilot/conversation.js`, `capabilities.js` | On a gateway: stored, multi-turn, metered model calls, each reply linked to its `model_calls` row; no model → the server's refusal, no invented turn. Off a gateway the deterministic engine answers and labels itself. | Agent drafts (M31) are the first artefact: canonical schema in `packages/shared/agentDraft.js`, an `agent_drafts` row, and activation gated on an approval a different principal made. Remaining: swarm-plan drafts, browser JSON, open-source voice — units 3–5. | `test:copilot-api` 19 · `test:copilot:ui` 8 · `test:drafts` 21 · `test:drafts:ui` 10 · activation refused before the gate |
| **D15** 🟧 | **Voice** | `src/voice/studio.js` (explicit fake engine), `adapters.js` (never fabricates) | Studio UI works against a fake engine for stale-audio rules; mic consent flow is real | L7: bind one real engine (browser Web Speech or a server TTS adapter) behind the existing adapter interface; otherwise keep `blocked` and keep the fake engine out of production builds. | a spoken clip produced by a named engine, with the engine recorded |
| **D16** 🟨 | **Training** | capability `training: blocked` | View exists; no backend | Keep blocked. Implement only with a real job runner (`jobs` table exists) — never a progress bar without a job. | job row + logs + artefact |
| **D17** ⚠️ | **Comms delivery** | gateway routes `/api/v1/comms/*` | Real adapter code, real encryption, mock-tested only | L7: verify one provider end-to-end with a real bot in a private channel; record the message id. | provider-side message id in `comms_messages` |
| **D18** 🟥 | **“Reset demo data”** | `src/views2.js` ~L995 + handler ~L1044; `src/core.js` `resetDemo()` | Destroys local state with a single confirm | L8: delete. Replace with an Owner-only **server-side** workspace reset (`POST /api/v1/admin/reset`) that is audited, typed-confirmed, and disabled in production by default. | button gone; route requires Owner + `audit_log` row |
| **D19** 🟥 | **Dev seed route** | `POST /api/v1/dev/seed` (Owner-only, blocked in prod unless `MMM_ALLOW_SEED=1`) | Restores the demo | L8: keep for local dev; ensure production `NODE_ENV=production` blocks it and add a startup assertion that prints a warning if `MMM_ALLOW_SEED` is set. | gateway test asserts 403 in production mode |
| **D20** 🟥 | **`fixtures/` + committed `data/`** | `fixtures/*.json`, `data/mmm.sqlite*` | Demo seed ships in the repo and produces builds that can look populated | L8: `fixtures/` becomes test-only (loaded by tests, not by the SPA); `data/` moves to `.gitignore` and is purged from history; production DB is created by migrations + bootstrap only. | `git ls-files data` → empty; `fixtures` unreferenced by `src/` |
| **D21** 🟨 | **Settings claims** | `src/views2.js` ~L985–988 | “4 templates active”, “AEAD-sealed vault”, “default-deny · proxy” as static text | L4/L8: compute each from real state (approval templates table, vault key presence, egress policy rows) or delete the row. | values derived, not typed |
| **D22** 🟨 | **“Live simulation feed” toggle** | `src/views2.js` ~L951, `toggle-sim` ~L1033 | A user-facing switch that turns fabrication on/off | L3: delete with the ticker. Fire the migration that removes `settings.simulate` from persisted state. | `rg "simulate" src` → only legitimate uses |
| **D23** 🟨 | **Provider/plugin usage counters** (`callsToday`, `latency`) | seeded fixtures; `views2.js` L405, L747, L797 | Counts that no meter produced | L5/L7: derive from `usage`/`audit_log`, or remove the field from the UI and the fixture. | counter equals `SELECT count(*)` |
| **D24** 🟧 | **Demo Owner identity** (`user-maya`, trust 100) seeded in the committed DB and fixtures | `apps/gateway/src/seed.js`, `data/mmm.sqlite` | A real-looking Owner that never authenticated | L1: bootstrap the first Owner from env (`MMM_BOOTSTRAP_EMAIL/PASSWORD`) or print a one-time generated password; never seed a principal with a known role in production. | fresh DB → login works; `SELECT count(*) FROM principals` = 1 with hash set |

### 2.3 The de-demo rule of thumb

> If a number, a status, or a movement is not the direct result of a request the server answered,
> it does not belong on screen. When you cannot yet produce the real value, show **“not available”**
> with the reason — that is a legitimate production state, and it is what the capability registry
> (`src/copilot/capabilities.js`) already models correctly.

**Reference implementation to copy:** the capability registry. It has one place that says what is
`available`, `demo`, `blocked`, `unconfigured`, or `unverified`, and the UI renders from it. Extend
that pattern to provider status, plugin status, voice engines, and delivery channels instead of
inventing per-screen copy.

---

## 3. The live-operation track (L0 → L8)

### 3.0 Sequence, duration, and gates

Work top to bottom. Durations assume **one developer, part-time, familiarising as they go** — they are
planning aids, not commitments.

| Phase | Outcome | Duration | Gate that must pass before the next phase |
| --- | --- | --- | --- |
| **L0** | No new fiction; repo hygiene | 1 day | `npm test` green, `git ls-files data` empty |
| **L1** | A real gateway you can log into | 2–3 days | login + `/api/v1/summary` returns your own rows |
| **L2** | The SPA talks to that gateway | 3 days | `liveSlices` = the four gateway slices in a browser |
| **L3** | Swarms are server-owned | 1 week | a deployed swarm survives refresh and has no random motion |
| **L4** | Chat + Copilot persist server-side | 1 week | message survives reload and a second browser |
| **L5** | Real model calls, metered | 1.5 weeks | one completion with tokens + cost recorded |
| **L6** | Files, analytics, console are real | 1 week | exported CSV equals a live SQL query |
| **L7** | Skills/MCP/comms/voice verified or honestly blocked | 2 weeks | one external provider round-trip recorded |
| **L8** | Demo path deleted; production hardening | 3 days | `rg -i "demo\|simulate\|mock" src/` justifies every hit |

**Four release gates** pull requirements from Part 4 forward. They are not optional and they are not
“later”:

| Gate | When | Requirements (IDs from Part 4) |
| --- | --- | --- |
| **G1 · Internal** | after L2 | SEC-01, SEC-02, SEC-05, SEC-06, DX-01…DX-03, DEP-01, DATA-02 (first drill) |
| **G2 · Private beta** | after L5 | SEC-07…SEC-12, OBS-01…OBS-05, REL-01…REL-04, PERF-01…PERF-03, A11Y-01…A11Y-04 |
| **G3 · Public beta** | after L7 | SEC-03, SEC-04, SEC-13…SEC-16, DEP-02…DEP-06, DATA-01, DATA-03…DATA-06, REL-05…REL-07, LEG-01…LEG-03 |
| **G4 · GA** | after L8 | everything, plus the review checklist in NFR-REV |

---

### L0 — Freeze the fiction (1 day)

**Why first.** You cannot improve a system whose displayed state you do not trust. This phase adds no
features; it stops the bleeding and makes the repo honest.

**Steps**

1. Create a branch:
   ```bash
   git switch -c chore/demo-freeze
   ```
2. Add runtime data to `.gitignore` and stop tracking it:
   ```bash
   printf '\n# runtime data — never commit databases, WAL or snapshots\ndata/\n*.sqlite\n*.sqlite-shm\n*.sqlite-wal\nbackups/\n' >> .gitignore
   git rm -r --cached data
   git commit -m "chore: stop tracking runtime database artifacts"
   ```
   > The database currently committed is at migration 001 while the code is at 003, so it is also
   > stale. Removing it from the index does not remove it from history — see DATA-05 in Part 4 for
   > the history purge, which must be done before the repository is ever made public.
3. Delete the three false strings on the Settings and Models screens (D07, D21) or replace them with
   a `not verified` chip. Smallest possible honest change:
   - `src/views2.js:` `26 providers · …` → derive from `getState().providers.length`, and label the
     page `catalogue · not connected` until L5.
   - `src/views2.js:` `4 templates active` / `AEAD-sealed vault` / `default-deny · proxy` → compute
     or remove.
4. Fix the README command that does not exist: either add a `lint` script (recommended, see DX-02) or
   delete the line. Never document a command you have not run.
5. Pin the runtime:
   ```bash
   node -e "const fs=require('fs');const p=require('./package.json');p.engines={node:'>=22.5 <23'};fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
   echo "22" > .nvmrc
   ```
6. Run everything and record the baseline in the evidence log:
   ```bash
   npm test && npm run build
   ```
7. Write a one-page CHANGELOG entry stating that the app is a prototype entering de-demo work.

**Done when:** `git ls-files data` prints nothing, `npm test` is green, and every remaining “demo”
string in `src/` is either honest (labels the absence) or scheduled against a `D`-ID.

---

### L1 — Stand up a real gateway (2–3 days)

**Why now.** All later phases write to this server. If it is not stable, every later test is
ambiguous.

**Steps**

1. Copy the environment template and generate a real secret:
   ```bash
   cp .env.example .env
   openssl rand -base64 48      # paste into MMM_AUTH_SECRET
   ```
   Edit `.env`:
   ```
   PORT=8787
   DATA_DIR=./data
   NODE_ENV=development
   MMM_AUTH=required
   MMM_AUTH_SECRET=<the 48-byte value>
   MMM_BOOTSTRAP_EMAIL=owner@example.com
   MMM_BOOTSTRAP_PASSWORD=<a 20+ character passphrase>
   MMM_CORS_ORIGIN=http://localhost:5173,http://127.0.0.1:5173
   ```
   > `.env` is already gitignored. Never paste the values into a chat, a screenshot, or a commit.
2. Create the schema and start the server:
   ```bash
   npm install --ignore-scripts   # see Pitfalls
   npm run migrate
   npm run dev:gateway
   ```
   Expected: `MMM gateway → http://localhost:8787  (ws: /ws, data: …, sqlite: …, auth: required)`
   and no “No Owner principal exists” error.
3. Prove it from the shell — health, login, authenticated read, CSRF-protected write:
   ```bash
   curl -s localhost:8787/healthz
   # → {"ok":true,"db":"sqlite-wal","driver":"...","auth":{"mode":"required",...}}

   curl -s -c cookies.txt -X POST localhost:8787/api/v1/auth/login \
     -H 'content-type: application/json' \
     -d '{"email":"owner@example.com","password":"<your passphrase>"}' | tee login.json
   # → principal, permissions, csrfToken, expiresAt

   CSRF=$(node -e "console.log(require('./login.json').csrfToken)")
   curl -s -b cookies.txt localhost:8787/api/v1/summary
   curl -s -b cookies.txt -H "x-mmm-csrf: $CSRF" \
     -H 'content-type: application/json' -X POST localhost:8787/api/v1/tasks \
     -d '{"title":"first real task","agentId":"<an id from GET /api/v1/agents>"}'
   ```
   Delete `login.json` and `cookies.txt` afterwards; they hold credentials.
4. Seed **once, on purpose**, for development only:
   ```bash
   npm run seed -- --reset
   ```
   Understand what this does: it writes demo rows into your own database. That is acceptable in
   development and forbidden in production (`NODE_ENV=production` blocks it unless
   `MMM_ALLOW_SEED=1`).
5. Verify the audit chain still holds after your writes:
   ```bash
   curl -s -b cookies.txt localhost:8787/api/v1/audit/verify
   npm run audit:verify
   ```

**Verification checklist**

- [ ] `GET /healthz` returns `ok: true` and `auth.mode: "required"`.
- [ ] Login returns a session cookie (`HttpOnly`, `SameSite=Strict`) and a `csrfToken`.
- [ ] A POST without `x-mmm-csrf` is refused with 403.
- [ ] `mmm.sqlite*` files appear in `data/` and are **not** in `git status`.
- [ ] `npm run audit:verify` reports an intact chain.

**Pitfalls**

- `npm install` may fail building `better-sqlite3` without Python/build tools. Use
  `npm install --ignore-scripts`; the gateway falls back to `node:sqlite` (experimental warning is
  expected). On a server, install build tools so you get the stable driver.
- If `MMM_AUTH=dev-open` is set locally, remember that production **refuses to start** with it.
  Do not build habits around it.
- Port 8787 already in use → `lsof -i :8787`.

**Done when:** a second person can follow steps 1–4 on a clean machine and reach a working login.

---

### L2 — Point the app at the gateway and make live the default (3 days)

**Why now.** The SPA has a complete API client; it simply has no URL. This is the single highest-value
change in the entire roadmap.

**Steps**

1. Set the gateway URL for the dev build in `.env`:
   ```
   VITE_GATEWAY_URL=/
   ```
   `/` means *same origin*. The Vite dev server already proxies `/api`, `/healthz`, and `/ws` to
   `127.0.0.1:8787` (see `vite.config.js`), so cookies work without CORS.
2. Restart Vite, open `http://localhost:5173`, sign in with the bootstrap Owner.
   ```bash
   npm run dev -- --host 0.0.0.0 --port 5173
   ```
3. Confirm provenance flips. In the browser console:
   ```js
   (await import('/src/datastore.js')).getStatus()
   // → { status:'live', liveSlices:['agents','tasks','approvals','events'], demoSlices:[...] }
   ```
   The header chip must now read `live gateway`, and the source note under a screen must say
   “refreshed <time>”.
4. Make a change in the UI that the server owns (create a task), then reload. If it survives, the
   read path is live. `PATCH`/`POST` paths must send `x-mmm-csrf`; the API client already does.
5. Make **production builds require a gateway**. Add a guard so a release build cannot silently ship
   in demo mode:
   ```js
   // vite.config.js — fail the production build when no gateway is configured
   if (mode === 'production' && !process.env.VITE_GATEWAY_URL) {
     throw new Error('VITE_GATEWAY_URL is required for production builds');
   }
   ```
   The `defineConfig` signature becomes `defineConfig(({ mode }) => ({ … }))`.
6. Keep the dev fallback: with no URL, the app still runs on fixtures **and says so loudly**. That
   path is for development only and is deleted in L8.

**Verification**

```bash
npm run test:readsync   # must still pass, and now assert the live slice list
npm run smoke
```

- [ ] A browser reload keeps a server-written row.
- [ ] Header chip reads `live gateway`; the demo chip is gone from all four gateway screens.
- [ ] `npm run build` fails without `VITE_GATEWAY_URL`, succeeds with it.
- [ ] Logging out (or expiring the session) flips the chip back to `demo data` with the reason
      “Not signed in — the gateway cannot authorise a read.” That message *is* the honesty feature;
      do not soften it.

**Pitfalls**

- If the chip stays on “demo”, check the browser console for a 401 and confirm you are signed in.
  `sourceExplanation()` in `src/datastore.js` tells you precisely why it is not live — read it first,
  always.
- `SameSite=Strict` cookies are dropped if the app and gateway are different origins **and** not
  proxied. Do not “fix” this with `SameSite=None`; fix it with a reverse proxy (Part 4, DEP-04).

**Done when:** the four gateway-owned slices are live in a browser and the build refuses to ship
without a gateway.

---

### L3 — Make swarms real, delete the ticker (1 week)

> Implementation detail for this phase: [`FEATURE_COMPLETION_ROADMAP.md` §M04](FEATURE_COMPLETION_ROADMAP.md)
> (and §4.1–§4.5 there for the migration/route/slice/test recipes used by every phase below).

**Why now.** This is the loudest lie in the product (D04, D05): a swarm that “runs” because a
`setInterval` says so. It also unblocks usage/cost, analytics, and Copilot swarm control.

**Steps**

1. Migration `apps/gateway/migrations/004_swarms.sql`. Minimum viable model:
   ```sql
   CREATE TABLE IF NOT EXISTS swarms (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     objective TEXT NOT NULL,
     team_id TEXT REFERENCES teams(id),
     status TEXT NOT NULL DEFAULT 'queued',   -- queued|running|paused|done|cancelled|failed
     budget_cap_cents INTEGER NOT NULL,
     spent_cents INTEGER NOT NULL DEFAULT 0,
     progress REAL NOT NULL DEFAULT 0,
     created_by TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     started_at INTEGER, ended_at INTEGER,
     error TEXT
   );
   CREATE TABLE IF NOT EXISTS swarm_nodes (
     id TEXT PRIMARY KEY, swarm_id TEXT NOT NULL REFERENCES swarms(id) ON DELETE CASCADE,
     name TEXT NOT NULL, role TEXT, status TEXT NOT NULL DEFAULT 'queued',
     spent_cents INTEGER NOT NULL DEFAULT 0, started_at INTEGER, ended_at INTEGER, error TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_swarms_status ON swarms(status, created_at DESC);
   ```
   Add it to `migrate()` and run `npm run migrate`. Migrations must be forward-only and idempotent.
2. Add routes mirroring the existing style in `apps/gateway/server.js`:
   - `GET /api/v1/swarms` (`swarm:read`)
   - `POST /api/v1/swarms` (`swarm:write`, mutating, audited)
   - `POST /api/v1/swarms/:id/pause|resume|cancel` (`swarm:write`)
   Add `swarm:read` / `swarm:write` to the RBAC matrix in `src/rbac.js` and to
   `packages/shared/api-routes.json` (remove them from `"planned"`).
3. **Decide what “running” means before writing the worker.** Two legitimate options:
   - **Supervised mode (start here):** `running` means a human/agent loop is attached; the server
     stores real node transitions that a worker POSTs. No worker → status stays `queued` and the UI
     says “no runtime attached”.
   - **Worker mode (later):** a `jobs`-driven worker (`jobs` table already exists) that dequeues a
     node, calls the model gateway (L5), writes results, and advances progress.
   Either way: **progress is a function of completed nodes**, `progress = done_nodes / total_nodes`.
   Never a random increment.
4. Compute the deploy estimate server-side from a price table (`model_prices` keyed by model id) —
   never the hardcoded `$6.40` in the sheet (`src/views1.js` ~L500).
5. Broadcast every transition on the `swarms` WS topic so all clients agree.
6. Delete `tick()` from `src/main.js`, delete `toggle-sim` and `settings.simulate`, and add a
   persistence migration that strips the key from stored state.
7. Extend `src/datastore.js`: move `swarms` (and later `usage`) from `LOCAL_SLICES` into
   `GATEWAY_SLICES` with an adapter `adaptSwarm()` and a provenance transition on fetch.

**Verification**

```bash
npm run test:gateway          # existing suite must stay green
npm run test:swarms           # new: deploy → row → WS event → progress from node count
rg -n "Math.random" src/main.js    # → no matches
rg -n "settings.simulate" src      # → no matches
```

- [ ] Deploy a swarm, reload, and its state is identical.
- [ ] Open the app in two browsers: a transition in one appears in the other within a second.
- [ ] Stop the gateway: the swarm list shows **stale**, not invented progress.
- [ ] `progress` equals `COUNT(done nodes) / COUNT(nodes)` in SQL.

**Pitfalls**

- Do not let the UI compute progress from timestamps. Server-computed only.
- WS reconnects must re-fetch on reconnect; otherwise the client looks live while frozen.

**Done when:** nothing in the product moves unless a server row or message caused it.

---

### L4 — Chat and Copilot persist server-side (1 week)

**Why now.** These are the two most-used surfaces, and both currently invent content (D06, D14).
Persistence is a prerequisite for attaching a model in L5.

**Steps**

1. Migration: `chat_threads`, `chat_messages`, `copilot_messages` (message id, thread id, author
   principal, role, body, `runtime` (`none|model|tool`), `model_id`, `tokens_in`, `tokens_out`,
   `cost_cents`, `request_id`, `created_at`).
2. Implement the planned contracts:
   - `GET/POST /api/v1/chat/threads/:id/messages` (`chat:read` / `chat:write`)
   - `POST /api/v1/copilot/messages` (`copilot:use`) — returns an assistant message **and** the
     capability snapshot the UI renders.
   Update `packages/shared/api-routes.json`.
3. Delete `simulateReply()` and both call sites in `src/views2.js`. Until a model exists, the server
   replies with an explicit record:
   ```json
   { "role": "system", "runtime": "none",
     "body": "No model runtime is configured. This message is stored, not answered.",
     "capability": { "id": "llm", "status": "unconfigured" } }
   ```
   The UI renders that as a notice, not as prose from an agent.
4. Wire optimistic sends through the API client with a per-message `requestId` so a retry cannot
   duplicate a message (idempotency).
5. Copilot action cards keep their existing two-step confirmation. When an action cannot be executed
   by the server, the card must end in `blocked` with the reason — never in a fake “done” step.

**Verification**

- [ ] Send a message, hard-refresh, message still present.
- [ ] Send from a second browser/device, both converge over WS.
- [ ] No reply text is generated in the client: `rg -n "Estimated cost: \\$0.42|On it\\. I'll fold" src` → none.
- [ ] Every stored assistant message has `runtime` set, and the UI displays it.
- [ ] Retrying a failed send does not duplicate the row (send the same `requestId` twice; count = 1).

**Done when:** the chat log is a database table, and “no model configured” is a first-class state.

---

### L5 — Real model calls, real metering, enforced budgets (1.5 weeks)

**Why now.** This is what turns the product from a control plane *about* AI into one that runs AI.
Everything before this is plumbing that makes this step safe.

**Steps**

1. Choose **one** provider to start with. Do not integrate ten. Recommended: a provider with a simple
   REST API and clear pricing (OpenAI, Anthropic, Mistral, Groq, or an aggregator such as OpenRouter).
2. Store keys server-side, reusing the existing channel-secret vault (AES-256-GCM, masked on read)
   from the comms implementation. Add a `provider_keys` table or extend `providers` with an encrypted
   column. **Never** a `VITE_` variable for a secret — `VITE_*` is compiled into client JS.
3. Add a `src/providers/<vendor>.js` adapter with the same shape as `commsAdapters.js`:
   `buildRequest(config, messages) → { url, method, headers, body }` (pure, unit-testable) and
   `parse(response) → { text, tokensIn, tokensOut, model, raw }`. A 2xx is mandatory before anything
   is recorded; an error is an error, not a partial success.
4. Route every call through one function so metering cannot be bypassed:
   ```
   modelCall({ principal, modelId, messages, purpose }) →
     1. authorise (permission + budget)
     2. price lookup
     3. request with timeout + abort
     4. persist usage row (tokens, cost, latency, requestId, principal, purpose)
     5. audit + broadcast
   ```
5. **Enforce budgets server-side.** Before the call, sum the day's spend for the workspace and the
   agent; refuse at the cap with `429`/`402` and a readable reason. A budget that only colours a
   progress bar is decoration.
6. Stream responses (`text/event-stream`) for chat and Copilot. Cap body size and per-response
   tokens; enforce a wall-clock timeout; abort on client disconnect so you stop paying for tokens.
7. `llm` in `src/copilot/capabilities.js` is now **read from the runtime** (M30), not asserted by hand:
   `available` only when the gateway reports a provider with a sealed key, `not configured` when the
   gateway exists without one, `unverified` in demo mode. A capability that can be typed in is a claim;
   one that is computed is evidence.
8. Add rate limits per principal and per token (see SEC-08) so one client cannot drain the balance.

**Verification**

- [ ] One recorded completion: request id, model, `tokens_in/out`, cost, latency — all in `usage`.
- [ ] A call with a deliberately wrong key returns a handled error, an audit row, and **no** usage row.
- [ ] Exceeding the daily cap refuses the call *before* the provider is contacted (prove with a
      provider-side request count of 0 for that attempt).
- [ ] Cost shown in the UI equals `SUM(cost_cents)` for the window shown.
- [ ] The key never appears in the built bundle: `npm run build && grep -r "sk-" dist/` → nothing.

**Pitfalls**

- Token counting differs per provider. Store both provider-reported usage and your own estimate, and
  show the provider's number.
- Pricing changes. Keep `model_prices` as data with an effective date, not as constants in code.
- Retries can double-charge. Retry only before the provider acknowledges, or use the provider's
  idempotency key.

**Done when:** a stranger could not make the app spend money beyond the configured cap, and every
cent shown on screen traces to a usage row.

---

### L6 — Files, analytics, and the console (1 week)

**Why now.** Removes the last three fake data surfaces (D10, D11, D12, D13) and gives operators a
real export.

**Steps**

1. `GET/POST /api/v1/files`: content-type allowlist, hard size cap (`MMM_BODY_LIMIT` is 256 KB —
   raise deliberately or stream uploads), owner scoping, checksum, and a `files` row. Store bytes
   outside SQLite (filesystem under `DATA_DIR/files`, or object storage) with the DB holding metadata.
2. `GET /api/v1/analytics/series/:metric?window=24h&bucket=1h` implemented as SQL aggregates over
   `usage`, `tasks`, `approvals`, `audit_log`. Keep the metric names in `packages/shared/api-routes.json`
   so the front end cannot invent one.
3. Replace every hardcoded tile in `src/views2.js` `views.analytics` with the response. Delete the
   `+12`, `87%`, `▲ 8%`, `median 4m`, `2 denied` literals. If a metric is not computable yet, render
   `not tracked` — never a plausible number.
4. Make `export-report` produce the CSV **from the same query**, server-side, and return it as a
   download. No `unshift` of a literal CSV string.
5. Terminal: retitle to “Console · this browser” unless/until commands execute server-side. Implement
   `status`, `agents`, `tasks`, `swarms`, `audit` as authenticated GETs; keep `help` accurate; remove
   `reset-demo`.

**Verification**

- [ ] Upload a file → download → SHA-256 matches.
- [ ] Analytics tile value equals the SQL result for a fixed fixture date.
- [ ] Exported CSV row count equals the series length.
- [ ] `rg -n "\\+ 12|87%|median 4m" src/views2.js` → none.
- [ ] Every command in `help` is implemented; `npm run test:terminal` covers the list.

---

### L7 — Skills, plugins/MCP, comms verification, voice (2 weeks)

**Why now.** These are the “integrations” claims. Each must end either **verified** or **explicitly
blocked**. Half-verified is the worst outcome.

**Steps, per area**

| Area | Do this | Or do this (honest fallback) |
| --- | --- | --- |
| **Skills** | Migration + `POST /api/v1/skills/:id/activate` (audited, revocable); runtime executes only signed, reviewed skills | Relabel the button `install locally` and remove claims of execution |
| **Plugins/MCP** | Implement an MCP client (`initialize` → `tools/list` → `tools/call`), per-call scoped tokens, allowlist of servers, audit each call with args hash | Rewrite `src/views2.js` ~L392–394 to “MCP client not implemented”, remove `callsToday` |
| **Comms** | Verify one provider live: create a bot, send to a private channel, store the provider message id, verify a signed inbound webhook with the provider's own signature | Keep `unverified` in the capability registry and say so on the screen |
| **Voice** | Bind one engine behind `src/voice/adapters.js`; record which engine produced the audio | Keep `blocked`; remove the fake engine from production builds |

**Verification**

- [ ] Each area has exactly one status: `available` (with evidence) or `blocked`/`unconfigured`
      (with reason). No third state.
- [ ] The capability registry, the screen copy, and the test expectations agree.
      `npm run test:skills`, `npm run test:comms`, `npm run test:voice` updated accordingly.

**Pitfalls**

- A mock-server test proves your *client* is correct; it does not prove the provider accepts you.
  Label accordingly — that distinction is already honoured in `docs/comms/server-side.md`.
- MCP servers are arbitrary code. Only allow a reviewed allowlist, and run them with the least
  privilege you can arrange.

---

### L8 — Decommission demo mode (3 days)

**Why last, not first.** You delete the crutches only once the real path is proven. Deleting them
early leaves you unable to test.

**Steps**

1. Remove `fixtures/` from the app’s runtime path. It stays only as test input. Move it to
   `tests/fixtures/` if that helps make the boundary obvious.
2. Remove `resetDemo()` (`src/core.js`), the `reset-demo` handler (`src/views2.js` ~L1044), the
   terminal hint, and the “Reset demo data” button. Replace with an Owner-only, audited
   `POST /api/v1/admin/reset` that requires the workspace name typed as confirmation.
3. Remove the `settings.simulate`, `gateway.sqlite … localStorage-backed demo`, and
   `Swarms and usage remain demo data` strings. Replace with live status or nothing.
4. Make `POST /api/v1/dev/seed` absent (not merely refused) when `NODE_ENV=production`, and log a
   startup warning if `MMM_ALLOW_SEED` is set in production.
5. Keep the provenance chip. It is now always `live gateway` in production — which is exactly the
   signal you want if it ever regresses.
6. Sweep:
   ```bash
   rg -n -i "demo|simulat|mock|fake|sample|placeholder|coming soon|not implemented" src/ apps/gateway/src/
   ```
   Every hit must be either (a) a legitimate, tested negative state, or (b) deleted.
7. Update `README.md`: remove “demo” framing, document the real production run.

**Done when:** a fresh clone, a fresh database, and a production build show an empty-but-honest
workspace with a working sign-in and no invented content anywhere.

---
## 4. Non-functional requirements — the detailed checklist

Each row is a requirement with a **single, demonstrable** completion test. “Done” means the evidence
column can be produced on demand, by someone other than the author.

**How this maps to the older roadmap:** this Part is the checklist form of milestones **M1–M9** in
[`IMPLEMENTATION_ROADMAP.md`](IMPLEMENTATION_ROADMAP.md) (M1 test/maintainability → DX; M2
performance → PERF; M3 security → SEC; M4 reliability → REL; M5 accessibility → A11Y; M6 scalability →
CAP; M7 observability → OBS; M8 deployability → DEP; M9 launch review → NFR-REV). Use the older
document for the *why* and the tutorial depth; use this for the *order* and the *bar*.

---

### 4.1 SEC — Security & privacy

| ID | Requirement | Evidence of completion | Prio · Gate |
| --- | --- | --- | --- |
| **SEC-01** | No secret in the client bundle, repo history, logs, URLs, or error messages. Only `VITE_*` public config is client-side. | `npm run scan:secrets` (gitleaks) clean; `grep -rE "sk-[A-Za-z0-9]{16,}\|whsec_\|xoxb-" dist/` empty; `.env` untracked; `git log -p -S "MMM_BOOTSTRAP_PASSWORD"` shows only placeholders | P0 · G1 |
| **SEC-02** | Every data route authenticates and every route declares a permission; denials are audited. | `npm run test:gateway` includes a route × role matrix; a grep of `route(` shows no route without `{ permission }` except the documented public ones | P0 · G1 |
| **SEC-03** | TLS everywhere; HTTP redirects to HTTPS; HSTS with a sane max-age; no mixed content. | `curl -sI https://host` shows `strict-transport-security`; browser console shows zero mixed-content warnings; `testssl.sh` grade ≥ A | P0 · G1 |
| **SEC-04** | Security headers on every response, including the static app: CSP (no `unsafe-eval`), `X-Content-Type-Options`, `Referrer-Policy`, frame-ancestors, COOP/COEP (already required for on-device AI). | `npm run test:headers` hits dev, preview and prod URLs and asserts each header; securityheaders.com grade ≥ A | P0 · G1 |
| **SEC-05** | Dependencies are pinned, audited, and updated deliberately; no high/critical advisories in the shipped graph. | `npm audit --omit=dev --audit-level=high` exits 0; Dependabot PRs enabled; lockfile committed; SBOM generated per release (DEP-06) | P0 · G1 |
| **SEC-06** | All input validated server-side: body size, content type, string lengths, enum values, id shapes, JSON depth. | Contract tests per route with oversized/invalid bodies return 400/413; `MMM_BODY_LIMIT` exercised | P0 · G1 |
| **SEC-07** | Sessions: `HttpOnly`, `SameSite=Strict`, `Secure` behind TLS, rotating secret, absolute + idle expiry, revocation on password change, fixation prevented. | `npm run test:session-safety`; a manual cookie inspection in DevTools shows all flags; revoking a session 401s immediately | P0 · G2 |
| **SEC-08** | Rate limits and quotas exist per IP **and** per principal/token; login is limited harder than reads; a 429 includes `Retry-After`. | `npm run test:limits` (new): 100 parallel logins → 429; 20 parallel completions → 429; headers asserted | P0 · G2 |
| **SEC-09** | Audit log covers every mutation and every denial, with actor, action, target, outcome, request id and IP; the hash chain verifies and a tampered row is detected. | `npm run test:gateway` includes a tamper test; `npm run audit:verify` in CI; a documented "who changed what" query | P0 · G2 |
| **SEC-10** | Password policy enforced (length ≥ 12, breach list optional), lockout after N failures, Owner can force reset, MFA available for Owner/Admin. | Unit tests for policy; lockout test; a real TOTP enrolment round-trip (RFC 6238) recorded | P1 · G3 |
| **SEC-11** | CSRF protection on every cookie-authenticated mutation; `Origin`/`Referer` validated; no state change on GET. | Existing CSRF test extended to a generated route list; a POST with foreign `Origin` is refused | P0 · G2 |
| **SEC-12** | Secure production defaults: refuses `dev-open` auth, refuses missing bootstrap in production, refuses default/weak secrets, blocks seeding, sets `NODE_ENV`, and fails loudly on misconfiguration. | `npm run test:prod-guards` starts the gateway with each bad config and asserts a non-zero exit and a specific message | P0 · G2 |
| **SEC-13** | Logs and audit rows are redacted: no passwords, tokens, cookies, message bodies of private channels, or full provider payloads. | Redaction unit tests for each logger call site; a captured log line for a login and a provider call contains no secret substrings | P1 · G3 |
| **SEC-14** | Key/secret rotation is possible without downtime: auth secret rotation invalidates sessions predictably, channel/provider keys re-encrypt. | Documented runbook + a rehearsal on staging (sessions invalidated, new calls succeed) | P1 · G3 |
| **SEC-15** | A security contact and disclosure policy exist; a penetration test or structured self-assessment has been performed. | `SECURITY.md` present with a contact; OWASP ASVS L2 self-assessment sheet committed; issues triaged | P2 · GA |
| **SEC-16** | Dependency and container scanning run in CI, not on a laptop. | CodeQL (or Semgrep) + `osv-scanner` jobs green on `main`; results visible in the Security tab | P1 · G3 |

**Notes.** Two of these are already stronger than most production apps: the audit hash chain and the
server-side secret vault. Do not weaken them to ship faster. The weakest link today is SEC-01 —
`data/mmm.sqlite` is committed, and any future migration that adds a password column would turn
that into a live credential leak.

---

### 4.2 REL — Reliability & resilience

| ID | Requirement | Evidence of completion | Prio · Gate |
| --- | --- | --- | --- |
| **REL-01** | `/healthz` is liveness; add `/readyz` that checks DB reachable, migrations applied, disk writable. | Both endpoints tested; `readyz` returns 503 when the DB file is made read-only | P0 · G2 |
| **REL-02** | Graceful shutdown on `SIGTERM`: stop accepting, drain in-flight requests, close WS with code 1001, checkpoint WAL, exit 0 within a deadline. | A test sends SIGTERM mid-request and asserts the request completes and the exit code is 0 | P0 · G2 |
| **REL-03** | Every outbound call has a timeout, bounded retries with jitter, and idempotency where money or messages are involved. | Code review checklist + tests: a hanging provider is aborted at T; a retried send produces one provider message | P0 · G2 |
| **REL-04** | No silent data loss: writes either commit or return an error; partial failures roll back; the client is told which. | Failure-injection test (full disk / read-only DB) returns a clear error and leaves no half-written row | P0 · G2 |
| **REL-05** | Queue work is durable and resumable: the comms retry queue and any job runner survive a restart. | Kill the process during a retry; after restart the job continues and the attempt count is correct | P1 · G3 |
| **REL-06** | Failure is visible in the UI: stale data is labelled stale, offline is labelled offline, and nothing is invented while disconnected. | Browser offline test: chip flips to `offline`; no timestamps advance; a queued action is marked pending | P1 · G3 |
| **REL-07** | Documented DR: RTO ≤ 4 h, RPO ≤ 15 min (choose your numbers), with a rehearsed restore. | Restore drill log with timings, dated, in the evidence table | P1 · G3 |
| **REL-08** | Dependency failure isolation: a dead provider/plugin does not take down reads or the UI. | Kill a provider mid-flight; reads still serve; the affected card shows `unavailable` | P1 · G3 |
| **REL-09** | Load shedding: under overload the gateway returns 503/429 quickly rather than collapsing. | Load test at 5× expected concurrency shows latency-bounded rejection, not process death | P2 · GA |

---

### 4.3 PERF — Performance on a mid-range phone

| ID | Requirement | Evidence of completion | Prio · Gate |
| --- | --- | --- | --- |
| **PERF-01** | Performance budget enforced in CI: JS ≤ 250 KB gzip initial, LCP ≤ 2.5 s on 4G mobile, INP ≤ 200 ms, CLS ≤ 0.1. | Lighthouse CI assertions green on the built app; the budget file is in the repo | P0 · G2 |
| **PERF-02** | Measured load test at expected peak: p95 read ≤ 300 ms, p95 write ≤ 500 ms, error rate < 0.1 %. | `k6 run` report committed with a fixed data volume and concurrency | P0 · G2 |
| **PERF-03** | Hot queries are indexed and plans checked; no full table scan on a list route at 10 k rows. | `EXPLAIN QUERY PLAN` output for each list query attached; indexes added | P1 · G2 |
| **PERF-04** | No memory growth over a 24 h soak; WS clients disconnect cleanly. | Soak test: RSS flat within 10 %; connection count returns to baseline | P1 · G3 |
| **PERF-05** | Verified on a real mid-range Android device over throttled 3G, not only desktop Chrome. | Screen recording + numbers recorded for LCP/INP; issues filed | P1 · G3 |
| **PERF-06** | Bundle composition is understood: dynamic imports for motion/anime.js and local runtime kept; no duplicate dependency shipped. | `npx vite-bundle-visualizer` snapshot archived; no chunk regressions > 10 % in CI | P2 · GA |

---

### 4.4 A11Y — Accessibility (WCAG 2.2 AA)

| ID | Requirement | Evidence of completion | Prio · Gate |
| --- | --- | --- | --- |
| **A11Y-01** | Automated audit: zero serious/critical axe violations on every route, both themes. | `npm run test:a11y` (axe + Playwright) green for all routes | P0 · G2 |
| **A11Y-02** | Full keyboard operability: focus visible, logical order, no traps except intentional modals, Escape closes, focus returns. | Manual keyboard walkthrough recorded as a checklist with screenshots | P0 · G2 |
| **A11Y-03** | Contrast ≥ 4.5:1 for all text including status chips; status never conveyed by colour alone. | Automated contrast test over token pairs + the existing label-pairing rule | P0 · G2 |
| **A11Y-04** | Screen-reader pass on the four core flows (sign in, create task, deploy swarm, open Copilot) with NVDA or VoiceOver. | Notes per flow, issues fixed or filed with severity | P1 · G3 |
| **A11Y-05** | `prefers-reduced-motion` fully respected, including end state (no residual `opacity: 0.1`). | `npm run test:motion` covers reset; manual check with the OS setting on | P0 · G2 |
| **A11Y-06** | Touch targets ≥ 44 px and no truncation at 320 px on every screen. | `npm run test:responsive` green; screenshot matrix at 320/360/390 px archived | P0 · G2 |

---

### 4.5 OBS — Observability & operations

| ID | Requirement | Evidence of completion | Prio · Gate |
| --- | --- | --- | --- |
| **OBS-01** | Structured JSON logs with level, timestamp, request id, principal id, route, status, duration. No `console.log` of objects. | A sample log file committed in `docs/ops/`; `rg "console.log" apps/gateway` justified per hit | P0 · G2 |
| **OBS-02** | One request id flows browser → gateway → audit → provider call, and is returned in `x-mmm-request-id` (already implemented) and shown in error UIs. | Trace one failing request end-to-end by id; the id appears in the UI error and the log line | P0 · G2 |
| **OBS-03** | `/metrics` (Prometheus) exposes request counts/latency histograms, error rate, WS connections, queue depth, DB size, model spend. Protected or bound to localhost. | `curl /metrics` parses; a Grafana dashboard screenshot is archived | P0 · G2 |
| **OBS-04** | Dashboards for the four golden signals + business metrics (swarms running, spend today, approvals pending). | Dashboard JSON committed; link in `docs/ops/runbook.md` | P1 · G3 |
| **OBS-05** | Alerts that page a human: 5xx rate, p95 latency, disk < 15 %, failed backups, audit chain failure, spend > 80 % of cap, cert expiry < 14 days. Each with a runbook link. | Alert rules committed; a fired test alert acknowledged in the on-call channel | P0 · G3 |
| **OBS-06** | Error tracking (Sentry or equivalent) with release tagging, source maps uploaded, PII scrubbed. | A deliberately thrown client and server error appear grouped with the release tag | P1 · G3 |
| **OBS-07** | SLOs documented: availability 99.5 %, p95 API latency, job success rate; error budget policy written. | `docs/ops/slo.md`; a monthly review entry | P2 · GA |
| **OBS-08** | Audit review cadence: weekly denied-action review, monthly access review. | Two dated review records, however short | P1 · G3 |

**Note.** Today the only operational endpoint is `/healthz`. This cluster is not a “nice to have”:
without OBS-01/03/05 you will discover outages from users.

---

### 4.6 DEP — Deployability & release engineering

| ID | Requirement | Evidence of completion | Prio · Gate |
| --- | --- | --- | --- |
| **DEP-01** | Reproducible build: pinned Node (`engines`/`.nvmrc`), committed lockfile, `npm ci` clean build, identical artefact hashes across two machines. | `npm ci && npm run build` twice → identical hashes (or documented asset-hash diff) | P0 · G1 |
| **DEP-02** | Container image for the gateway: multi-stage, non-root, `tini`/`--init`, healthcheck, read-only root FS where possible, pinned base digest. | `docker build` + `docker run` smoke; `docker scout`/`trivy` shows no high/critical | P0 · G3 |
| **DEP-03** | Process supervision and restart: systemd unit or orchestrator with restart policy, resource limits, log capture. | `systemctl status` / deploy config committed; a kill -9 self-heals | P0 · G3 |
| **DEP-04** | **One origin**: reverse proxy (Caddy/Nginx) serves the SPA and proxies `/api`, `/healthz`, `/ws` to the gateway. This is what makes `SameSite=Strict` cookies work and removes CORS from the critical path. | `curl https://host/api/v1/summary` works with the app's cookie; no CORS preflight in the network tab | P0 · G3 |
| **DEP-05** | Three environments — dev, staging, production — with the same code path and different config only. Staging is where migrations and restore drills are rehearsed. | URL table in `docs/ops/environments.md`; staging exists and is reachable | P1 · G3 |
| **DEP-06** | One-command release with rollback: build → migrate → deploy → smoke → tag. Previous artefact retained and restorable in < 10 min. | Release runbook executed twice; a rollback performed on staging with timings | P0 · G3 |
| **DEP-07** | Migrations are forward-only, idempotent, backed up before running, and reversible in practice by restore. Deploy order documented (migrate then start). | `npm run migrate` twice is a no-op; pre-migration backup file present | P0 · G3 |
| **DEP-08** | Static asset caching and service-worker versioning correct: new `CACHE` name per release, no stale authenticated data. | `SW` cache version bumped in the release checklist; `npm run test:sw-safety` green | P1 · G3 |
| **DEP-09** | Configuration is validated at boot with a single schema; missing/invalid values fail fast with a readable message. | Invalid `MMM_*` values produce a specific exit message; test asserts it | P1 · G3 |

---

### 4.7 DATA — Data integrity, backup, retention

| ID | Requirement | Evidence of completion | Prio · Gate |
| --- | --- | --- | --- |
| **DATA-01** | Automated backup of SQLite (online backup API or `VACUUM INTO`, never a copy of a live WAL file), encrypted, off-host, daily + before every migration. | Backup files exist with sizes and dates; the job is in cron/systemd timer and its failure alerts | P0 · G3 |
| **DATA-02** | A restore has actually been performed, on a clean host, timed and documented. | Drill log: restore start→verified data, with row counts compared | P0 · G1 (first drill) / G3 (full) |
| **DATA-03** | Retention is enforced, not merely configured: runs/logs/audit retention jobs delete and are audited. | A test with backdated rows proves deletion; the job is scheduled | P1 · G3 |
| **DATA-04** | Ownership scoping: every row that belongs to a workspace/principal is filtered by it on read and checked on write. | Cross-tenant test: principal B cannot read or mutate A's rows by guessing ids | P0 · G3 |
| **DATA-05** | Repository history contains no secret and no runtime database; if it ever did, history is purged and collaborators re-clone. | `git log --all -- data/` empty after purge (or an explicit, dated waiver); gitleaks full-history scan clean | P0 · G1 |
| **DATA-06** | Data portability and deletion: export all workspace data (JSON) and delete an account/workspace on request. | Both endpoints implemented and tested; a deletion leaves no orphan rows and an audit record | P1 · GA |
| **DATA-07** | Integrity checks scheduled: `PRAGMA integrity_check` weekly, `PRAGMA quick_check` at boot; WAL checkpointing tuned. | Scheduled job output archived; a corrupted-copy detection test | P1 · G3 |
| **DATA-08** | Capacity plan: expected rows/month, DB growth, disk alert thresholds, archive policy. | A one-page projection with the alert thresholds it implies | P2 · GA |

---

### 4.8 DX — Developer experience & CI

| ID | Requirement | Evidence of completion | Prio · Gate |
| --- | --- | --- | --- |
| **DX-01** | CI on every push and PR: install → lint → unit/contract tests → build → browser tests → security scans. Red blocks merge. | `.github/workflows/ci.yml` required check visible on a PR; a deliberately broken PR fails | P0 · G1 |
| **DX-02** | Linting and formatting exist and pass: ESLint (or oxlint), Prettier, Stylelint for CSS. The documented `npm run lint` actually runs. | `npm run lint` and `npm run format:check` exit 0 in CI | P0 · G1 |
| **DX-03** | Branch protection: no direct pushes to `main`, one review, required checks, linear history or merge commits per policy, signed releases optional. | `gh api repos/:owner/:repo/branches/main/protection` shows the rules | P0 · G1 |
| **DX-04** | Contract tests between client and gateway: the client's route list and the server's route table are compared automatically. | A test fails when `api-routes.json` and `server.js` disagree (catches the 7 “planned” routes) | P1 · G2 |
| **DX-05** | Pre-commit hooks: format, lint staged files, secret scan. Fast (< 5 s) and skippable for emergencies. | Hook installed via a documented `npm run prepare`; a staged secret is blocked | P2 · G3 |
| **DX-06** | Docs-as-code: roadmap, runbook, environments, and evidence log live in `docs/`, updated in the same PR as the change. | Review checklist includes “docs updated”; no orphan documents older than a release | P1 · G3 |
| **DX-07** | Test data is deterministic: fixed clocks/seeds where randomness exists, no `Math.random()` in assertions or fixtures. | `rg "Math.random" scripts/` justified per hit; flaky test rate tracked | P1 · G3 |
| **DX-08** | The full suite runs in < 10 minutes locally and in CI, with browser suites included (they currently are not). | CI duration recorded; `npm test` includes or explicitly fans out to browser suites | P1 · G2 |

---

### 4.9 CAP & COST — Capacity, rate economics

| ID | Requirement | Evidence of completion | Prio · Gate |
| --- | --- | --- | --- |
| **CAP-01** | Documented capacity envelope: max concurrent WS clients, requests/s, DB size, file storage — measured, not guessed. | Numbers in `docs/ops/capacity.md` with the test that produced them | P1 · G3 |
| **CAP-02** | Horizontal scale path is credible: stateless HTTP + shared DB (or single-writer with a queue), WS fan-out strategy, sticky sessions if needed. | A written design note; a two-instance staging test passes reads and shows the known limitation | P2 · GA |
| **COST-01** | Model spend is capped per workspace, per agent, and per day, enforced server-side before the call. | Budget-refusal test proves the provider was not contacted | P0 · G3 |
| **COST-02** | Cost is attributed: every usage row carries principal, agent, swarm, purpose, model, and a price snapshot. | A cost report by agent/day reconciles to the provider invoice for a test period | P1 · G3 |
| **COST-03** | Hosting cost is understood and alerted: fixed monthly ceiling, an alert at 80 %, and a documented downgrade path. | Cost dashboard/alert exists; numbers in the capacity doc | P2 · GA |

---

### 4.10 LEG — Legal, privacy, and trust surface

| ID | Requirement | Evidence of completion | Prio · Gate |
| --- | --- | --- | --- |
| **LEG-01** | Terms of service and privacy notice published, linked from sign-in and Settings, versioned with an effective date. | URLs live; versions committed under `docs/legal/` | P1 · G3 |
| **LEG-02** | Data-protection posture documented: lawful basis, data inventory, retention, sub-processors (model providers, hosting), user rights, breach process. Nigeria's NDPA 2023 and, if you serve the EU, GDPR both apply. | One-page record of processing + a sub-processor list; a contact for rights requests | P1 · G3 |
| **LEG-03** | Licence hygiene: every dependency and every bundled model/asset is licensed for your use; third-party notices generated. | `npx license-checker --summary` reviewed; `NOTICE`/`THIRD-PARTY.md` generated per release; the local-AI binaries' licences recorded | P1 · G3 |
| **LEG-04** | AI disclosure and acceptable use: the product states what the agents can do, that outputs may be wrong, and what is prohibited. | In-product note + AUP page; the Copilot already models this honestly — extend the language | P2 · GA |
| **LEG-05** | Support path: a contact, a response expectation, and a status page. | `SUPPORT.md` + status page URL; both referenced from the app footer | P2 · GA |

---

### 4.11 DOC — Documentation & handover (part of “production level”)

| ID | Requirement | Evidence of completion | Prio · Gate |
| --- | --- | --- | --- |
| **DOC-01** | A runbook: start/stop, deploy, rollback, restore, rotate secrets, read the dashboards, common failures and their fixes. | `docs/ops/runbook.md`, tested by someone who did not write it | P0 · G3 |
| **DOC-02** | An on-call/incident process: severity levels, who is called, comms templates, blameless postmortem template. | `docs/ops/incidents.md` + one postmortem from a real (even minor) incident | P1 · G3 |
| **DOC-03** | Architecture diagram and data-flow map that match the code, including where secrets live and what leaves the network. | One diagram + a table of every outbound destination | P1 · G3 |
| **DOC-04** | Known-limitations page, honest, updated each release. This roadmap's Part 2 is its starting draft. | `docs/ops/limitations.md` | P1 · G3 |

---

## 5. Step-by-step recipes (beginner-friendly)

Each recipe is self-contained: copy the commands, replace the obvious placeholders, and it works on a
fresh Ubuntu 24.04 or macOS machine with Node 22 installed. Tool links are in Appendix A.

### 5.1 Recipe: CI that actually blocks bad merges (DX-01, DX-02, DX-08)

1. Install the tools and pin them:
   ```bash
   npm i -D eslint @eslint/js prettier stylelint stylelint-config-standard globals
   npx eslint --init     # choose: JavaScript modules, browser + node, no framework, JSON config
   ```
2. Add scripts to `package.json`:
   ```json
   "lint": "eslint src apps scripts",
   "lint:css": "stylelint \"src/**/*.css\"",
   "format:check": "prettier --check .",
   "test:browser": "node scripts/motion-browser-test.mjs && node scripts/scroll-browser-test.mjs && node scripts/relay-browser-test.mjs && node scripts/voice-browser-test.mjs"
   ```
3. Create `.github/workflows/ci.yml`:
   ```yaml
   name: ci
   on: [push, pull_request]
   jobs:
     verify:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with: { node-version: 22, cache: npm }
         - run: npm ci --ignore-scripts
         - run: npm run lint
         - run: npm run format:check
         - run: npm test
         - run: npm run build
   ```
4. Push a branch with a deliberate syntax error; confirm the check goes red and the PR cannot merge.
5. Turn on protection:
   ```bash
   gh api -X PUT repos/:owner/:repo/branches/main/protection \
     -f 'required_status_checks[strict]=true' \
     -f 'required_status_checks[contexts][]=verify' \
     -f 'enforce_admins=true' -f 'required_pull_request_reviews[required_approving_review_count]=1' \
     -f 'restrictions=' 
   ```
   (Or do it in Settings → Branches; the UI is friendlier and equivalent.)

**Watch out for:** browser suites need Chromium. In CI, add a job that installs `npx puppeteer browsers
install chrome` and runs `test:browser` with the sandbox flags the scripts already use.

### 5.2 Recipe: secret scanning + dependency scanning (SEC-01, SEC-05, SEC-16)

```bash
# local scan of the working tree and full history
docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:latest detect -s /repo -v
# or: brew install gitleaks && gitleaks detect -v
```
Add to CI:
```yaml
  secrets:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: gitleaks/gitleaks-action@v2
  deps:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm audit --omit=dev --audit-level=high
```
Then enable Dependabot (`.github/dependabot.yml`):
```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule: { interval: weekly }
    open-pull-requests-limit: 5
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: monthly }
```
If a secret was ever committed, **rotate it first**, then purge history (`git filter-repo`), force-push,
and have every collaborator re-clone. Rotation is the fix; history rewriting is the cleanup.

### 5.3 Recipe: containerise the gateway (DEP-02, DEP-03)

`Dockerfile`:
```dockerfile
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci --omit=dev && apt-get purge -y python3 make g++ && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY apps ./apps
COPY src ./src
COPY packages ./packages
RUN useradd -r -u 10001 mmm && mkdir -p /data && chown -R mmm /data
USER mmm
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","apps/gateway/server.js"]
```
Build and run:
```bash
docker build -t mmm-gateway:$(git rev-parse --short HEAD) .
docker run --rm -p 8787:8787 --env-file .env -v "$PWD/data:/data" mmm-gateway:latest
curl -s localhost:8787/healthz
```
**Note:** set `DATA_DIR=/data` in the container environment so the volume is actually used.

### 5.4 Recipe: one origin with HTTPS (DEP-04, SEC-03)

The cleanest fix in this entire document. Caddy gives you automatic TLS and websocket proxying in
nine lines.

`Caddyfile`:
```
mmm.example.com {
  encode zstd gzip
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options nosniff
    Referrer-Policy strict-origin-when-cross-origin
    Cross-Origin-Opener-Policy same-origin
    Cross-Origin-Embedder-Policy require-corp
  }
  handle /api/* { reverse_proxy 127.0.0.1:8787 }
  handle /healthz { reverse_proxy 127.0.0.1:8787 }
  handle /ws* { reverse_proxy 127.0.0.1:8787 }
  handle { root * /srv/mmm/dist
           try_files {path} /index.html
           file_server }
}
```
```bash
sudo systemctl reload caddy     # or: caddy run --config Caddyfile
curl -sI https://mmm.example.com | grep -i strict-transport
```
Now set in the build environment:
```
VITE_GATEWAY_URL=/
```
…and the app talks to its own origin. Cookies work, CORS disappears, COOP/COEP apply to the document
(needed for on-device AI). **Do not** solve cross-origin cookies with `SameSite=None`; that is a
security regression, not a fix.

### 5.5 Recipe: backups you have actually restored (DATA-01, DATA-02, REL-07)

Never copy `mmm.sqlite` while the process runs — a WAL copy can be torn. Use SQLite's own
mechanism:
```bash
mkdir -p backups
sqlite3 data/mmm.sqlite ".backup 'backups/mmm-$(date +%F-%H%M).sqlite'"
# verify immediately
sqlite3 backups/mmm-*.sqlite "PRAGMA integrity_check;"
```
Automate with a systemd timer or cron:
```cron
15 2 * * * cd /srv/mmm && ./scripts/backup.sh >> /var/log/mmm-backup.log 2>&1
```
`scripts/backup.sh` should: take the backup → integrity check → encrypt
(`age -r <pubkey>` or `gpg -c`) → copy off-host (`rclone copy`, S3, or R2) → prune older than N days
→ print one line with size and duration. **Fail loudly** and alert (OBS-05) when any step fails.

The drill (do this once now, then quarterly):
```bash
age -d -i key.txt backups/mmm-2026-10-28-0215.sqlite.age > /tmp/restore.sqlite
sqlite3 /tmp/restore.sqlite "PRAGMA integrity_check; SELECT count(*) FROM tasks;"
DATA_DIR=/tmp/restoreenv npm run dev:gateway    # point the gateway at the restored copy
```
Record: start time, end time, row counts before/after, anything that surprised you. That log **is**
your RTO/RPO evidence.

### 5.6 Recipe: logs, metrics, alerts (OBS-01, OBS-03, OBS-05)

1. Structured logs:
   ```bash
   npm i pino pino-http
   ```
   ```js
   import pino from 'pino';
   export const log = pino({ level: process.env.LOG_LEVEL || 'info',
     redact: { paths: ['req.headers.cookie','req.headers.authorization','*.password','*.token','*.secret'], censor: '[redacted]' } });
   ```
   Log one line per request with `requestId`, `route`, `status`, `ms`, `principalId`. Errors log
   `err.message` and `err.stack`, never the body of a request that may hold a secret.
2. Metrics:
   ```bash
   npm i prom-client
   ```
   Expose `GET /metrics` bound to localhost or behind `system:diagnostics`. Minimum set:
   `http_requests_total{route,status}`, `http_request_duration_seconds` histogram,
   `ws_connections`, `queue_depth`, `db_size_bytes`, `model_spend_cents_today`.
3. Prometheus scrape config:
   ```yaml
   scrape_configs:
     - job_name: mmm
       static_configs: [{ targets: ['127.0.0.1:8787'] }]
   ```
4. Alerts (Prometheus rules or your host's alerting):
   - `rate(http_requests_total{status=~"5.."}[5m]) > 0.05` for 10 m
   - `histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m])) > 1`
   - `node_filesystem_avail_bytes / node_filesystem_size_bytes < 0.15`
   - `mmm_backup_age_hours > 36`
   - `mmm_audit_chain_ok == 0`
   - `mmm_model_spend_cents_today > 0.8 * cap`
5. Route every alert to one channel with a link to the runbook section that fixes it. An alert with no
   runbook link is a future 3 a.m. argument.

### 5.7 Recipe: rate limits and quotas that match real abuse (SEC-08, COST-01)

1. Keep the global limiter, then add buckets:
   ```js
   // per principal, per minute
   const limiter = (key, limit, windowMs) => auth.rateLimit(key, { limit, windowMs });
   // login: 20 / 5 min / IP (exists)
   // reads: 600 / min / principal
   // mutations: 60 / min / principal
   // model calls: 20 / min / principal AND spend < cap
   ```
2. Return `429` with `Retry-After` and a readable body; never a silent drop.
3. Test it:
   ```bash
   seq 1 200 | xargs -P 50 -I{} curl -s -o /dev/null -w "%{http_code}\n" \
     -X POST localhost:8787/api/v1/auth/login -H 'content-type: application/json' \
     -d '{"email":"nobody@example.com","password":"x"}' | sort | uniq -c
   ```
   Expect a mix of 400/401 and then 429 — and **no 200s**.
4. For spend caps, check *before* the call, then reserve, then reconcile with actual usage. A cap
   checked after the fact is a receipt, not a limit.

### 5.8 Recipe: accessibility gate in CI (A11Y-01, A11Y-03)

```bash
npm i -D @axe-core/playwright @playwright/test
npx playwright install --with-deps chromium
```
`tests/a11y.spec.js`:
```js
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const routes = ['#/', '#/tasks', '#/agents', '#/teams', '#/swarms', '#/chat', '#/skills',
                '#/analytics', '#/files', '#/terminal', '#/settings'];

for (const route of routes) {
  test(`a11y ${route}`, async ({ page }) => {
    await page.goto(`http://localhost:5173/${route}`);
    await page.waitForTimeout(400);
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    const serious = violations.filter(v => ['serious', 'critical'].includes(v.impact));
    expect(serious, JSON.stringify(serious.map(v => v.id), null, 2)).toEqual([]);
  });
}
```
Run it in CI against a real `vite dev` server (the scripts in `scripts/` already show the pattern).
Fix findings by token, not by exception: the design system forbids per-screen colour overrides.

### 5.9 Recipe: performance budget (PERF-01)

```bash
npm i -D @lhci/cli
npx lhci autorun --collect.staticDistDir=dist \
  --assert.assertions.categories:performance=0.9 \
  --assert.assertions.largest-contentful-paint=2500 \
  --assert.assertions.cumulative-layout-shift=0.1 \
  --assert.assertions.total-blocking-time=200
```
Check the *mobile* preset (default) — desktop Lighthouse numbers are decoration. Then confirm on a
throttled real device (PERF-05): Chrome DevTools → Network → Slow 4G, CPU ×4, and record.

### 5.10 Recipe: load test with a real dataset (PERF-02, CAP-01)

```bash
npm i -D k6   # or install the binary
```
```js
// load.js
import http from 'k6/http';
import { check } from 'k6';
export const options = { stages: [
  { duration: '30s', target: 20 }, { duration: '1m', target: 50 }, { duration: '30s', target: 0 } ] };
export default function () {
  const res = http.get(`${__ENV.BASE}/api/v1/summary`, { headers: { cookie: __ENV.COOKIE } });
  check(res, { 'status is 200': r => r.status === 200, 'under 300ms': r => r.timings.duration < 300 });
}
```
```bash
BASE=https://staging.example.com COOKIE="mmm_session=…" k6 run load.js
```
Seed 10 000 tasks first, or the numbers mean nothing. Record p95, error rate, RSS, and DB size
alongside the run.

### 5.11 Recipe: error tracking without leaking user data (OBS-06)

```bash
npm i @sentry/node @sentry/browser
```
```js
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  release: process.env.GIT_SHA,
  environment: process.env.NODE_ENV,
  sendDefaultPii: false,
  beforeSend(event) {
    if (event.request?.data) event.request.data = '[redacted]';
    return event;
  },
});
```
Upload source maps from CI (`sentry-cli sourcemaps upload --release $GIT_SHA dist/`). Verify by
throwing one error in the browser and one on the server; both must group under the same release.

### 5.12 Recipe: the release + rollback drill (DEP-06, DEP-07)

Write it down as a numbered list and follow it twice:
```bash
# 1. freeze: green CI on main
# 2. back up before migrating
sqlite3 data/mmm.sqlite ".backup 'backups/pre-$(git rev-parse --short HEAD).sqlite'"
# 3. migrate
npm run migrate
# 4. build
npm run build
# 5. deploy artefact (immutable, tagged)
docker build -t mmm-gateway:$(git rev-parse --short HEAD) .
# 6. smoke
npm run smoke && curl -fsS https://host/healthz && curl -fsS https://host/api/v1/summary -b cookie.txt
# 7. tag
git tag -a v0.2.0 -m "exit demo mode" && git push --tags
```
Rollback = redeploy the previous tagged image + restore the pre-migration backup if the schema
changed. Time it. If it takes longer than 15 minutes, fix the process, not the documentation.

### 5.13 Recipe: the first week of production watching

- Day 1: watch error rate, 5xx, p95, disk, WS connection count on a screen. Do not deploy anything new.
- Day 2: read every audit `deny` row and every 4xx spike. They are either bugs or attacks.
- Day 3: run a restore from the previous night's backup into a scratch host.
- Day 4: ask two real users to do one task each while you watch, silently.
- Day 5: write the first weekly ops note: what broke, what you changed, what is still unknown.

---
## 6. TODO list — ordered, copy-paste into your tracker

Format: `[ ] ID — task (done when…)`. Work top to bottom; do not start a phase before its predecessor's
gate is green.

### Track A · Stop the fiction (L0)

- [ ] **A01** — Add `data/`, `*.sqlite*`, `backups/` to `.gitignore`; `git rm -r --cached data` (done when `git ls-files data` is empty)
- [ ] **A02** — Replace the three static security claims in Settings with computed values or delete them (`src/views2.js` ~L985–988)
- [ ] **A03** — Fix or add `npm run lint`; README must not document commands that do not exist
- [ ] **A04** — Pin Node in `engines` + `.nvmrc`; verify `npm ci` works from clean
- [ ] **A05** — Label the Models page as a catalogue, not a router (derive `26 providers` from state)
- [ ] **A06** — Record the honest baseline in `docs/ops/limitations.md` (start from Part 2)
- [ ] **A07** — `npm test && npm run build` green; paste the counts into the evidence log

### Track B · Real gateway, real reads (L1–L2)

- [ ] **B01** — `.env` with a generated `MMM_AUTH_SECRET`, bootstrap Owner, exact CORS origins
- [ ] **B02** — `npm run migrate` on a fresh DB; confirm migrations 001–003 apply in order
- [ ] **B03** — Prove login + CSRF + authenticated read from `curl`; delete the cookie files
- [ ] **B04** — Seed once; verify audit chain before and after
- [ ] **B05** — Set `VITE_GATEWAY_URL=/`; proxy already exists in `vite.config.js`
- [ ] **B06** — Browser proof: `getStatus().liveSlices` = `agents, tasks, approvals, events`
- [ ] **B07** — Production build fails without a gateway URL
- [ ] **B08** — Extend `scripts/readsync-test.mjs` to assert the live slice list and the build guard
- [ ] **B09** — Write `docs/ops/environments.md`: dev / staging / production URLs and config diffs

### Track C · Server-owned swarms (L3)

- [ ] **C01** — Migration `004_swarms.sql` (`swarms`, `swarm_nodes`, indexes) + `migrate()` registration
- [ ] **C02** — RBAC: `swarm:read`, `swarm:write` in the matrix and in tests
- [ ] **C03** — Routes: list, create, pause, resume, cancel; all audited, all broadcasting on `swarms`
- [ ] **C04** — Decide the runtime model (supervised vs worker) and document it in `docs/ops/`
- [ ] **C05** — Progress = completed nodes / total nodes, computed server-side only
- [ ] **C06** — Server-side deploy estimate from `model_prices`; delete the `$6.40` literal
- [ ] **C07** — Delete `tick()`, `toggle-sim`, `settings.simulate`; migrate stored state
- [ ] **C08** — Move `swarms` into `GATEWAY_SLICES` with `adaptSwarm()`
- [ ] **C09** — New `scripts/swarms-test.mjs` (+ `npm run test:swarms`); add to `npm test`
- [ ] **C10** — Two-browser live test: transition in one appears in the other
- [ ] **C11** — Remove the “Swarms and usage remain demo data” footnote and the “No active demo swarms” copy

### Track D · Persistent chat & Copilot (L4)

- [ ] **D01** — Migration: `chat_threads`, `chat_messages`, `copilot_messages` with `runtime`/usage columns
- [ ] **D02** — Routes: `GET/POST /chat/threads/:id/messages`, `POST /copilot/messages` (+ `api-routes.json`)
- [ ] **D03** — Delete `simulateReply()` and both call sites
- [ ] **D04** — Idempotent sends via `requestId`; retry cannot duplicate
- [ ] **D05** — “No model runtime configured” is a rendered state, not an error toast
- [ ] **D06** — Copilot blocked actions end in `blocked` with a reason, never a fake done
- [ ] **D07** — Tests: persistence, cross-client convergence, no client-side reply text

### Track E · Real model calls (L5)

- [ ] **E01** — Pick one provider; read its pricing page and API reference (Appendix A)
- [ ] **E02** — Server-side key storage (AES-256-GCM, masked reads), never `VITE_*`
- [ ] **E03** — Adapter with pure `buildRequest`/`parse`, mock-tested offline
- [ ] **E04** — Single `modelCall()` funnel: authorise → price → call → persist usage → audit → broadcast
- [ ] **E05** — Budget enforcement before the call (workspace, agent, day)
- [ ] **E06** — Streaming with abort-on-disconnect and max-token caps
- [ ] **E07** — Usage rows carry principal, agent, swarm, purpose, model, price snapshot
- [ ] **E08** — Capability `llm` flips to `available` only with a reproducible recorded call
- [ ] **E09** — Proof the key is absent from `dist/`
- [ ] **E10** — Provider-side invoice reconciliation for one test day

### Track F · Files, analytics, console (L6)

- [ ] **F01** — `GET/POST /api/v1/files` with type allowlist, size cap, checksum, owner scoping
- [ ] **F02** — File bytes outside SQLite; metadata in `files`; download is byte-identical
- [ ] **F03** — `GET /api/v1/analytics/series/:metric` over `usage`, `tasks`, `approvals`, `audit_log`
- [ ] **F04** — Replace every hardcoded analytics literal; `not tracked` where unknown
- [ ] **F05** — `export-report` generates CSV server-side from the same query
- [ ] **F06** — Terminal retitled; only implemented commands in `help`; `reset-demo` removed
- [ ] **F07** — Tests: upload/download hash, tile-vs-SQL equality, CSV row count, command list

### Track G · Integrations: verify or block (L7)

- [ ] **G01** — Skills activation server-side + audit (or relabel install-only)
- [ ] **G02** — MCP client with allowlist, scoped per-call tokens, arg-hash audit (or rewrite the copy)
- [ ] **G03** — Remove plugin `callsToday` unless derived from a real meter
- [ ] **G04** — Verify one comms provider live; store the provider message id
- [ ] **G05** — Verify one signed inbound webhook with the provider's real signature
- [ ] **G06** — Bind one real voice engine behind the adapter, or keep `blocked` and drop the fake engine from prod builds
- [ ] **G07** — Capability registry, UI copy and tests agree for every integration
- [ ] **G08** — Record the evidence (message ids, timestamps) in the evidence table

### Track H · Delete the demo path (L8)

- [ ] **H01** — `fixtures/` becomes test-only; the SPA never imports it
- [ ] **H02** — Remove `resetDemo()`, `reset-demo` button/handler/hint
- [ ] **H03** — Add Owner-only audited `POST /api/v1/admin/reset` (typed confirmation, prod-off by default)
- [ ] **H04** — `dev/seed` absent in production builds; startup warning if `MMM_ALLOW_SEED=1`
- [ ] **H05** — Remove `localStorage-backed demo` and remaining demo strings
- [ ] **H06** — Full sweep: every `demo|simulate|mock|fake|sample` hit justified or deleted
- [ ] **H07** — Fresh-clone test: empty DB, production build, honest empty state, working sign-in
- [ ] **H08** — Rewrite README “Run & Deploy” for the real topology

### Track I · Security & privacy (parallel from L1, gated)

- [ ] **I01** — SEC-01: history + tree secret scan clean; rotate anything ever exposed
- [ ] **I02** — SEC-02: route × role matrix test; no undeclared permission
- [ ] **I03** — SEC-03: TLS + HSTS verified with `testssl.sh` ≥ A
- [ ] **I04** — SEC-04: CSP + headers on all three environments; securityheaders.com ≥ A
- [ ] **I05** — SEC-05: `npm audit --omit=dev` clean; Dependabot on; lockfile committed
- [ ] **I06** — SEC-06: per-route input validation tests (size, type, length, enum, id)
- [ ] **I07** — SEC-07: session flags, expiry, revocation on password change
- [ ] **I08** — SEC-08: per-principal limits + `Retry-After` + tests
- [ ] **I09** — SEC-09: audit coverage for every mutation and denial; tamper test in CI
- [ ] **I10** — SEC-10: password policy, lockout, Owner-forced reset, TOTP for Owner
- [ ] **I11** — SEC-11: CSRF on every mutating route; foreign `Origin` refused
- [ ] **I12** — SEC-12: production guard suite (`dev-open`, missing bootstrap, weak secret, seeding)
- [ ] **I13** — SEC-13: redaction tests for logs and audit rows
- [ ] **I14** — SEC-14: rotation runbook + staging rehearsal
- [ ] **I15** — SEC-15: `SECURITY.md`, ASVS L2 self-assessment, pen-test booked or completed
- [ ] **I16** — SEC-16: CodeQL/Semgrep + OSV scanning in CI

### Track J · Reliability & data safety

- [ ] **J01** — REL-01: `/readyz` with DB + migrations + disk checks
- [ ] **J02** — REL-02: graceful shutdown test (SIGTERM mid-request)
- [ ] **J03** — REL-03: timeouts, jittered retries, idempotency for money/messages
- [ ] **J04** — REL-04: failure-injection test (read-only DB, full disk)
- [ ] **J05** — REL-05: durable queue survives restart
- [ ] **J06** — REL-06: offline/stale UX test; nothing advances while disconnected
- [ ] **J07** — REL-07: DR doc with RTO/RPO + rehearsed restore timings
- [ ] **J08** — REL-08: dependency failure isolation (dead provider does not break reads)
- [ ] **J09** — REL-09: load shedding returns 503/429 instead of collapsing
- [ ] **J10** — DATA-01: nightly encrypted off-host backup (`VACUUM INTO`/`.backup`, not a WAL copy)
- [ ] **J11** — DATA-02: restore drill on a clean host, row counts compared
- [ ] **J12** — DATA-03: retention jobs enforced and audited
- [ ] **J13** — DATA-04: cross-tenant access test (B cannot read A)
- [ ] **J14** — DATA-05: purge committed DB from history; document re-clone
- [ ] **J15** — DATA-06: workspace export + delete
- [ ] **J16** — DATA-07: `integrity_check` scheduled, `quick_check` at boot
- [ ] **J17** — DATA-08: capacity projection + disk thresholds

### Track K · Observability

- [ ] **K01** — OBS-01: structured JSON logs with redaction
- [ ] **K02** — OBS-02: request id end-to-end, shown in error UI
- [ ] **K03** — OBS-03: `/metrics` with golden signals + business metrics, protected
- [ ] **K04** — OBS-04: Grafana dashboard committed
- [ ] **K05** — OBS-05: six alerts, each with a runbook link, test-fired once
- [ ] **K06** — OBS-06: error tracking with release tags and PII scrubbing
- [ ] **K07** — OBS-07: SLOs + error-budget policy
- [ ] **K08** — OBS-08: weekly deny-review and monthly access review, dated

### Track L · Deployability & DX

- [ ] **L01** — DX-01: CI workflow with required status check on `main`
- [ ] **L02** — DX-02: ESLint + Prettier + Stylelint green (`npm run lint` really exists)
- [ ] **L03** — DX-03: branch protection, no direct pushes, review required
- [ ] **L04** — DX-04: client/server route-contract test (catches the 7 “planned” routes)
- [ ] **L05** — DX-05: pre-commit format + lint + secret scan
- [ ] **L06** — DX-06: docs updated in the same PR as the change
- [ ] **L07** — DX-07: deterministic tests; no randomness in assertions
- [ ] **L08** — DX-08: browser suites in CI; full suite < 10 min
- [ ] **L09** — DEP-01: reproducible `npm ci` build, hashes compared
- [ ] **L10** — DEP-02: Dockerfile (multi-stage, non-root, healthcheck) + image scan
- [ ] **L11** — DEP-03: process supervision + restart policy + log capture
- [ ] **L12** — DEP-04: Caddy/Nginx single origin with TLS; CORS off the critical path
- [ ] **L13** — DEP-05: staging environment exists and is reachable
- [ ] **L14** — DEP-06: release runbook executed twice; rollback timed
- [ ] **L15** — DEP-07: migrations forward-only, idempotent, backed up, ordered
- [ ] **L16** — DEP-08: service-worker cache version bumped per release
- [ ] **L17** — DEP-09: boot-time config validation with readable failures

### Track M · Performance & accessibility

- [ ] **M01** — PERF-01: Lighthouse CI budget enforced (mobile preset)
- [ ] **M02** — PERF-02: k6 load test with 10 k rows; p95 recorded
- [ ] **M03** — PERF-03: `EXPLAIN QUERY PLAN` for each list query + indexes
- [ ] **M04** — PERF-04: 24 h soak, RSS flat
- [ ] **M05** — PERF-05: real mid-range Android over throttled 3G
- [ ] **M06** — PERF-06: bundle visualiser snapshot, no > 10 % regression
- [ ] **M07** — A11Y-01: axe in CI, zero serious/critical, all routes
- [ ] **M08** — A11Y-02: keyboard walkthrough of every flow
- [ ] **M09** — A11Y-03: contrast test over token pairs
- [ ] **M10** — A11Y-04: NVDA/VoiceOver pass on four core flows
- [ ] **M11** — A11Y-05/06: reduced motion end state, 44 px targets, 320 px screenshots

### Track N · Legal, docs, launch

- [ ] **N01** — LEG-01: terms + privacy notice, linked in-app, versioned
- [ ] **N02** — LEG-02: record of processing, sub-processor list, rights contact (NDPA/GDPR)
- [ ] **N03** — LEG-03: licence review + `THIRD-PARTY.md` per release
- [ ] **N04** — LEG-04: AI disclosure + acceptable-use page
- [ ] **N05** — LEG-05: support path + status page
- [ ] **N06** — DOC-01: runbook tested by someone else
- [ ] **N07** — DOC-02: incident process + one real postmortem
- [ ] **N08** — DOC-03: architecture + outbound-destination table
- [ ] **N09** — DOC-04: known-limitations page current
- [ ] **N10** — NFR-REV: full review against Part 4, signed off in the evidence table
- [ ] **N11** — Launch: announcement, onboarding copy that matches reality, first-week watch plan

---

## 7. Schedule, milestones, and gates

### 7.1 Ten-week plan (adjust to your availability)

| Week | Main track | Parallel (NFR) | Milestone |
| --- | --- | --- | --- |
| 1 | L0 + L1 | DX-01/02/03, SEC-01 | **G1 · Internal** |
| 2 | L2 | SEC-02, SEC-06, DATA-02 (first drill) | App reads real data |
| 3 | L3 (swarms) | REL-01/02, PERF-01 baseline | No simulated motion |
| 4 | L4 (chat/copilot) | SEC-07/11/12, A11Y-01 setup | Persistent conversations |
| 5 | L5 (one provider) | SEC-08, COST-01, OBS-01/03 | Real model call, metered |
| 6 | L5 finish + L6 | OBS-05, REL-03/04, PERF-02 | **G2 · Private beta** |
| 7 | L6 finish | DEP-02/04, DATA-01 | Real analytics + files |
| 8 | L7 (integrations) | SEC-16, A11Y-02/03, DEP-05 | Verified or blocked, nothing in between |
| 9 | L7 finish + L8 | DEP-06, DATA-03/04/06, OBS-04/06 | Demo path deleted |
| 10 | Hardening + launch | LEG-01/02/03, DOC-01, NFR-REV | **G4 · GA** |

`G3 · Public beta` sits between weeks 8 and 9: do not invite strangers before DNS, TLS, backups, and
alerts exist, even if the product “works”.

### 7.2 Milestone definitions

| Milestone | One-sentence definition | Non-negotiable evidence |
| --- | --- | --- |
| **M0 · Prototype** | The UI demonstrates the intended product on seeded data | Today |
| **M1 · Internal** | One real gateway, real login, real reads, CI blocking bad merges | B06, L01, I01 |
| **M2 · Live-capable** | No invented content anywhere; every screen traces to a server row | C07, D03, F04, H06 |
| **M3 · Private beta** | A small group uses it daily without you watching | G2 gate rows + first-week ops note |
| **M4 · Public beta** | Strangers can sign up, get support, and leave | G3 gate rows + LEG-01/02 + status page |
| **M5 · GA** | You can be paged, restore data, and roll back without heroics | G4 + one restore drill + one rollback drill |

### 7.3 What “not yet” looks like (so you can say it out loud)

It is entirely acceptable to launch with these still open, **provided the UI says so**:

- On-device AI beyond the spike (keeps `blocked` in the capability registry)
- Voice output (keeps `blocked`)
- Training jobs (keeps `blocked`)
- MCP plugins (relabelled, counters removed)
- Horizontal scale (single-node with documented limits)
- Billing (invite-only, manual invoicing)

It is **not** acceptable to launch with any of: an unlabelled simulation, a seeded Owner in production,
no backups, no TLS, no alerts, or no ability to roll back.

---

## 8. Evidence log & definition of done

### 8.1 Definition of done (apply to every task above)

A task is done only when all six are true:

1. **Behaviour** exists and is reachable by a user (or by an operator, for ops tasks).
2. **Honesty**: nothing on screen claims more than the behaviour delivers.
3. **Test**: an automated test would fail if the behaviour regressed — or, for infra tasks, a command
   output proves it.
4. **Docs**: the runbook/roadmap row is updated in the same commit.
5. **Evidence**: a line is added to the table below, with a date and a reproducible command.
6. **No regression**: `npm test`, `npm run build`, and the browser suites still pass.

### 8.2 Evidence log (fill this in as you go — it is the deliverable that survives you)

| Date | ID | Claim | Evidence (command output / artefact path) | Verified by |
| --- | --- | --- | --- | --- |
| 2026-10-28 | audit | Baseline: 36 test scripts, `npm test` green, no CI | `743e45f`, this document §1 | audit |
|  |  |  |  |  |
|  |  |  |  |  |

### 8.3 Anti-patterns that will get you a false PASS

| Anti-pattern | Why it is dangerous | Do instead |
| --- | --- | --- |
| “Tests pass” on a mock provider | Proves your client, not the integration | Record the provider's own id/receipt |
| Screenshot of a green button | Proves rendering, not effect | Show the DB row or the network response |
| “It works on my machine” | Misses packaging and config | Run the documented steps on a clean host |
| Commenting out the failing assertion | Converts a bug into a permanent blind spot | Fix it or file it with a linked issue |
| Adding a “demo” badge to a live feature | Trains users to ignore the badge | Remove the feature or make it real |
| Deleting the provenance chip to look production-ready | Removes the only signal that catches regressions | Keep it; it should read `live gateway` |
| Measuring Lighthouse on desktop | Numbers do not transfer to phones | Use the mobile preset and a real device |

---
## Appendix A — Resource library (every URL you need)

Grouped by the requirement clusters in Part 4. Prefer official documentation; the linked cheat sheets
are for the exact mistakes this codebase is most likely to make.

### A.1 Platform, runtime, build

| Topic | Resource | URL |
| --- | --- | --- |
| Node.js API reference | Node docs | https://nodejs.org/api/ |
| Node release schedule / LTS | Node releases | https://nodejs.org/en/about/previous-releases |
| Node permission model | Permissions | https://nodejs.org/api/permissions.html |
| Vite guide | Vite | https://vite.dev/guide/ |
| Vite dev server + proxy options | Server options | https://vite.dev/config/server-options |
| Vite production build | Build guide | https://vite.dev/guide/build |
| ESM / import maps refresher | MDN JavaScript modules | https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules |
| Twelve-factor config | 12factor | https://12factor.net/config |
| Semver (release numbering) | semver.org | https://semver.org/ |
| Changelog convention | Keep a Changelog | https://keepachangelog.com/en/1.1.0/ |
| Commit message convention | Conventional Commits | https://www.conventionalcommits.org/en/v1.0.0/ |

### A.2 Database, backup, data safety

| Topic | Resource | URL |
| --- | --- | --- |
| SQLite WAL mode | sqlite.org | https://sqlite.org/wal.html |
| Online backup API | sqlite.org | https://sqlite.org/backup.html |
| CLI + `.backup` / `.dump` | SQLite CLI docs | https://sqlite.org/cli.html |
| PRAGMAs (integrity_check, journal) | sqlite.org | https://sqlite.org/pragma.html |
| `better-sqlite3` API | WiseLibs | https://github.com/WiseLibs/better-sqlite3 |
| Continuous SQLite replication | Litestream | https://litestream.io/ |
| Encrypted, deduplicated backups | restic | https://restic.readthedocs.io/en/stable/ |
| File encryption for backups | age | https://github.com/FiloSottile/age |
| Off-host copy | rclone | https://rclone.org/docs/ |
| Object storage (cheap, S3-compatible) | Cloudflare R2 | https://developers.cloudflare.com/r2/ |
| Contingency planning (RTO/RPO framing) | NIST SP 800-34 | https://csrc.nist.gov/pubs/sp/800/34/r1/upd1/final |

### A.3 Security, auth, secrets

| Topic | Resource | URL |
| --- | --- | --- |
| Application security verification standard | OWASP ASVS | https://owasp.org/www-project-application-security-verification-standard/ |
| Top 10 risks | OWASP Top 10 | https://owasp.org/www-project-top-ten/ |
| Practical fixes per topic | OWASP Cheat Sheets | https://cheatsheetseries.owasp.org/ |
| Sessions | Session Management Cheat Sheet | https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html |
| CSRF | CSRF Prevention Cheat Sheet | https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html |
| Cookie flags | MDN Set-Cookie | https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie |
| Content Security Policy | MDN CSP | https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP |
| CSP review tool | CSP Evaluator | https://csp-evaluator.withgoogle.com/ |
| TLS configuration generator | Mozilla SSL Configuration | https://ssl-config.mozilla.org/ |
| TLS grading | testssl.sh | https://testssl.sh/ |
| Header grading | securityheaders.com | https://securityheaders.com/ |
| WebAuthn / passkeys | WebAuthn Guide | https://webauthn.guide/ |
| Passkey library | SimpleWebAuthn | https://simplewebauthn.dev/ |
| TOTP (RFC 6238) | IETF | https://datatracker.ietf.org/doc/html/rfc6238 |
| OIDC (if you add SSO) | OpenID Foundation | https://openid.net/connect/ |
| Breached-password check | Have I Been Pwned API | https://haveibeenpwned.com/API/v3 |
| Secret scanning | gitleaks | https://github.com/gitleaks/gitleaks |
| Dependency vulnerabilities | OSV-Scanner | https://google.github.io/osv-scanner/ |
| npm audit | npm docs | https://docs.npmjs.com/cli/v10/commands/npm-audit |
| Code scanning in CI | GitHub code scanning | https://docs.github.com/en/code-security/code-scanning |
| Secret scanning in CI | GitHub secret scanning | https://docs.github.com/en/code-security/secret-scanning |
| Removing secrets from history | git-filter-repo | https://github.com/newren/git-filter-repo |

### A.4 CI, containers, hosting, TLS

| Topic | Resource | URL |
| --- | --- | --- |
| GitHub Actions | Docs | https://docs.github.com/en/actions |
| Workflow syntax | Docs | https://docs.github.com/en/actions/reference/workflow-syntax-for-github-actions |
| Keyless cloud auth from CI | OIDC hardening | https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect |
| Branch protection | Docs | https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches |
| Automated dependency updates | Dependabot | https://docs.github.com/en/code-security/dependabot |
| Docker basics | Get started | https://docs.docker.com/get-started/ |
| Node images done properly | nodejs/docker-node best practices | https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md |
| Automatic HTTPS + reverse proxy | Caddy | https://caddyserver.com/docs/automatic-https |
| `reverse_proxy` directive (WS included) | Caddy docs | https://caddyserver.com/docs/caddyfile/directives/reverse_proxy |
| TLS termination with Nginx | Nginx docs | https://nginx.org/en/docs/http/configuring_https_servers.html |
| Free certificates | Let's Encrypt | https://letsencrypt.org/getting-started/ |
| Service supervision | systemd.service | https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html |
| Static app hosting | Vercel | https://vercel.com/docs |
| Node hosting | Fly.io | https://fly.io/docs/ |
| Node hosting | Render | https://render.com/docs |
| Node hosting | Railway | https://docs.railway.com/ |

### A.5 Observability & operations

| Topic | Resource | URL |
| --- | --- | --- |
| OpenTelemetry for Node | Getting started | https://opentelemetry.io/docs/languages/js/getting-started/nodejs/ |
| OpenTelemetry JS overview | Docs | https://opentelemetry.io/docs/languages/js/ |
| Prometheus | Overview | https://prometheus.io/docs/introduction/overview/ |
| Alerting rules | Prometheus docs | https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/ |
| Dashboards | Grafana docs | https://grafana.com/docs/ |
| Node metrics library | prom-client | https://github.com/siimon/prom-client |
| Structured logging | pino | https://getpino.io/ |
| Browser + Node error tracking | Sentry JS | https://docs.sentry.io/platforms/javascript/ |
| Node error tracking | Sentry for Node | https://docs.sentry.io/platforms/javascript/guides/node/ |
| Postmortem culture | Google SRE Book | https://sre.google/sre-book/postmortem-culture/ |
| SLO implementation | Google SRE Workbook | https://sre.google/workbook/implementing-slos/ |
| Incident response process | PagerDuty IR | https://response.pagerduty.com/ |
| Postmortem template | Atlassian | https://www.atlassian.com/incident-management/postmortem/templates |
| Public status page | Atlassian Statuspage | https://www.atlassian.com/software/statuspage |

### A.6 Testing, performance, accessibility

| Topic | Resource | URL |
| --- | --- | --- |
| End-to-end browser tests | Playwright | https://playwright.dev/docs/intro |
| Accessibility engine | axe-core | https://github.com/dequelabs/axe-core |
| axe for Playwright | npm | https://www.npmjs.com/package/@axe-core/playwright |
| Performance budgets in CI | Lighthouse CI | https://github.com/GoogleChrome/lighthouse-ci/blob/main/docs/getting-started.md |
| Core Web Vitals | web.dev | https://web.dev/articles/vitals |
| Load testing | Grafana k6 | https://grafana.com/docs/k6/latest/ |
| Quick HTTP load test | autocannon | https://github.com/mcollina/autocannon |
| WCAG 2.2 at a glance | W3C Quick Reference | https://www.w3.org/WAI/WCAG22/quickref/ |
| ARIA patterns | WAI-ARIA APG | https://www.w3.org/WAI/ARIA/apg/ |
| Accessibility course | web.dev Learn Accessibility | https://web.dev/learn/accessibility |
| Linting | ESLint | https://eslint.org/docs/latest/use/getting-started |
| Formatting | Prettier | https://prettier.io/docs/ |
| CSS linting | Stylelint | https://stylelint.io/ |
| PWA fundamentals | MDN PWA | https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps |
| Service workers | web.dev Learn PWA | https://web.dev/learn/pwa |
| Network throttling reference | Chrome DevTools | https://developer.chrome.com/docs/devtools/network/reference/ |

### A.7 Model providers & AI integrations

| Topic | Resource | URL |
| --- | --- | --- |
| OpenAI API reference | platform.openai.com | https://platform.openai.com/docs/api-reference |
| OpenAI pricing (keep as data, not constants) | openai.com | https://openai.com/api/pricing/ |
| Anthropic API | docs.anthropic.com | https://docs.anthropic.com/en/api/getting-started |
| Anthropic pricing | anthropic.com | https://www.anthropic.com/pricing |
| Multi-provider router | OpenRouter | https://openrouter.ai/docs |
| Fast inference | Groq | https://console.groq.com/docs |
| Mistral | docs.mistral.ai | https://docs.mistral.ai/ |
| Google Gemini | ai.google.dev | https://ai.google.dev/gemini-api/docs |
| Self-hosted local models | Ollama API | https://github.com/ollama/ollama/blob/main/docs/api.md |
| GGUF inference in the browser (already a dependency) | wllama | https://github.com/ngxson/wllama |
| llama.cpp upstream | GitHub | https://github.com/ggml-org/llama.cpp |
| Model Context Protocol | Introduction | https://modelcontextprotocol.io/docs/getting-started/intro |
| Reference MCP servers | GitHub | https://github.com/modelcontextprotocol/servers |

### A.8 Messaging integrations

| Topic | Resource | URL |
| --- | --- | --- |
| Telegram bots | Bot API | https://core.telegram.org/bots/api |
| Telegram webhooks | `setWebhook` | https://core.telegram.org/bots/api#setwebhook |
| WhatsApp Cloud API | Meta docs | https://developers.facebook.com/docs/whatsapp/cloud-api |
| Discord bots | Developer docs | https://discord.com/developers/docs/intro |
| Slack apps | api.slack.com | https://api.slack.com/ |
| Twilio messaging | Docs | https://www.twilio.com/docs/messaging |
| OpenSMS (self-hosted SMS) | GitHub | https://github.com/daslearning-org/OpenSMS |
| Transactional email | Resend | https://resend.com/docs |
| Metered billing (if you charge for runs) | Stripe | https://docs.stripe.com/billing/subscriptions/metered-billing |

### A.9 Legal, privacy, licensing

| Topic | Resource | URL |
| --- | --- | --- |
| EU data protection | European Commission | https://commission.europa.eu/law/law-topic/data-protection_en |
| Nigeria Data Protection Commission | NDPC | https://ndpc.gov.ng/ |
| Licence identifiers | SPDX | https://spdx.org/licenses/ |
| Dependency licence audit | license-checker | https://www.npmjs.com/package/license-checker |
| Content/asset licensing | Creative Commons | https://creativecommons.org/share-your-work/cclicenses/ |

---

## Appendix B — Command cheat sheet (everything this repo can do)

```bash
# ---------- setup ----------
cp .env.example .env                     # then fill secrets by hand
openssl rand -base64 48                  # MMM_AUTH_SECRET
npm ci --ignore-scripts                  # node_modules without native builds
npm run migrate                          # apply 001..003 (+004 when written)
npm run seed -- --reset                  # DEVELOPMENT ONLY: demo rows

# ---------- run ----------
npm run dev                              # SPA on :5173 (proxies /api, /healthz, /ws)
npm run dev:gateway                      # gateway on :8787
npm run build && npm run preview         # production build on :4173

# ---------- gate: must be green before any merge ----------
npm test                                 # the full unit + contract suite (36 scripts total)
npm run smoke                            # every route renders
npm run build                            # production build
npm run test:motion                      # motion logic
npm run test:motion:browser              # real Chromium, motion
npm run test:scroll:browser              # scroll containment
npm run test:relay:browser               # design-system + overlay geometry
npm run test:voice:browser               # voice panel flows
npm run test:isolation:browser           # COOP/COEP in a browser
npm run test:sw-safety:browser           # service-worker behaviour
npm run test:local-spike:browser         # on-device runtime spike
npm run test:responsive                  # mobile-first rules, tap targets
npm run test:gateway                     # RBAC, CSRF, lockout, audit chain
npm run test:comms-gateway               # server-side credentials + delivery
npm run audit:verify                     # hash-chain integrity

# ---------- production (target state) ----------
docker build -t mmm-gateway:$(git rev-parse --short HEAD) .
docker run -d --name mmm --env-file .env -v /srv/mmm/data:/data -p 8787:8787 mmm-gateway:local
caddy run --config Caddyfile             # HTTPS + single origin
sqlite3 data/mmm.sqlite ".backup 'backups/pre-$(date +%F).sqlite'"
k6 run load.js                           # p95 + error rate
npx lhci autorun                         # performance budget
npx playwright test tests/a11y.spec.js   # accessibility gate
gitleaks detect -v                       # secrets, tree + history
```

**Browser tests need Chromium.** On a slim Linux box:
```bash
export LD_LIBRARY_PATH=/tmp/chromium-libs/lib:$LD_LIBRARY_PATH
# puppeteer flags used by the scripts: --no-sandbox --disable-dev-shm-usage --disable-gpu
```

---

## Appendix C — Environment variables (production reference)

| Variable | Required in prod | Purpose | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | ✅ | Enables production guards | `production` refuses `dev-open` auth and seeding |
| `PORT` | ✅ | Gateway listen port | Put behind the proxy; do not expose publicly |
| `DATA_DIR` | ✅ | SQLite + uploads location | Must be a persistent volume, not the image |
| `MMM_AUTH` | ✅ | `required` | Never `dev-open` in production |
| `MMM_AUTH_SECRET` | ✅ | Derives CSRF/HMAC | Generate once, store in a secret manager, rotate deliberately |
| `MMM_BOOTSTRAP_EMAIL` | ✅ (first boot) | First Owner | Remove or rotate after setup |
| `MMM_BOOTSTRAP_PASSWORD` | ✅ (first boot) | First Owner password | ≥ 12 chars; rotate after first login |
| `MMM_SECURE_COOKIES` | ✅ | Marks the session cookie `Secure` | Set when TLS terminates at the proxy |
| `MMM_CORS_ORIGIN` | ⚠️ | Exact origins, comma-separated | Unnecessary once you serve one origin (DEP-04) |
| `MMM_BODY_LIMIT` | ➖ | Default 262144 (256 KB) | Raise deliberately; stream uploads instead |
| `MMM_RATE_LIMIT` | ➖ | Global requests/window | Add per-principal limits (SEC-08) |
| `MMM_SESSION_TTL_MS` | ➖ | Default 12 h | Shorter for admins is reasonable |
| `MMM_LOGIN_MAX_FAILURES` / `MMM_LOCKOUT_MS` | ➖ | Lockout policy | Keep ≥ 5 / 15 min |
| `MMM_ALLOW_SEED` | ❌ | Must stay unset in prod | Startup warning if set |
| `VITE_GATEWAY_URL` | ✅ | Build-time API base | Use `/` for same-origin |
| `SENTRY_DSN` | ➖ | Error tracking | Client-safe DSN; never a token |
| `LOG_LEVEL` | ➖ | `info` in prod | `debug` only while diagnosing |
| Provider keys (e.g. `OPENAI_API_KEY`) | ➖ | Server-side only | Store in the DB vault through the UI, or as process env; **never** `VITE_*` |

---

## Appendix D — First-day orientation (for a developer joining cold)

1. **The shape of the system.** A static, mobile-first SPA (`src/`, Vite, no framework) talks to a
   zero-dependency Node HTTP+WS gateway (`apps/gateway/`) that owns a SQLite database. The SPA can run
   without the gateway — that is demo mode, and it is what this roadmap removes.
2. **Read three files first.** `src/api.js` (transport, CSRF, session), `src/datastore.js`
   (provenance: which slices are live vs demo, and *why*), `apps/gateway/server.js` (every route with
   its permission).
3. **Then read** `src/copilot/capabilities.js`. It is the honest inventory of what the product can do,
   and the vocabulary (`available / demo / blocked / unconfigured / unverified`) used everywhere.
4. **Vocabulary.**
   - *Slice* — one data collection (agents, tasks, approvals, events, swarms, usage…).
   - *Provenance* — where a slice's rows came from (`gateway` or `demo`).
   - *Capability* — a product feature with a verified status.
   - *Gate* — the checkpoint (G1–G4) that must pass before the next audience sees the app.
5. **Your first three tasks**, if you have no idea where to start: A01 (untrack `data/`), B05 (point
   the app at a real gateway), C07 (delete the simulation ticker). They are small, high-value, and
   each one permanently improves the honesty of the product.

---

## Appendix E — Change log of this document

| Date | Change | Reason |
| --- | --- | --- |
| 2026-10-28 | Created. Baseline audit at `743e45f`. | The product reached “UI complete, operations absent”; the demo path needed an explicit, ordered exit plan. |

---

*This document is meant to be edited. When reality disagrees with it, correct the document in the same
commit as the code, and put the evidence in §8.2. A roadmap nobody updates is a fiction — and this
project has already spent enough effort removing those.*
