# 🧩 MMM — Feature Completion Roadmap

## Making every non-functioning part of the app actually work, screen by screen

**Written:** 2026-10-29 · **Baseline:** `098a591` (`main`) · **Status:** execution guide
**Audience:** a developer who can read JavaScript and run commands, but has never seen this repo.

---

## 0. What this document is

This is the **feature-level** companion to [`PRODUCTION_ROADMAP.md`](PRODUCTION_ROADMAP.md).

| Document | Answers | Shape |
| --- | --- | --- |
| [`PRODUCTION_ROADMAP.md`](PRODUCTION_ROADMAP.md) | *“In what order do I take this from demo to production, and how do I run it once it is there?”* | Phases L0–L8, NFR checklist (SEC/REL/PERF/A11Y/OBS/DEP/DATA), ops recipes |
| **This document** | *“This screen does not work. What exactly is missing, and how do I build the missing part?”* | 23 module playbooks (M01–M23), each with steps, code, tests, evidence |
| [`IMPLEMENTATION_CHECKLIST.md`](IMPLEMENTATION_CHECKLIST.md) | *“What was originally planned?”* | Functional phases 0–18 (historical) |
| [`IMPLEMENTATION_ROADMAP.md`](IMPLEMENTATION_ROADMAP.md) | *“What is a good non-functional target?”* | NFR theory + M1–M9 milestones |

**Use them together:** pick the next screen from §6 of this file, build it with the playbook in §5, and
keep the operational requirements from the other document as the bar. Do not maintain a third list —
when a module is finished, tick it here and record the evidence in
[`PRODUCTION_ROADMAP.md` §8.2](PRODUCTION_ROADMAP.md).

### 0.1 The single most important discovery

Before writing a line of code, understand this, because it changes the shape of the whole job:

> **The database is already 80 % built. The API is not.**

Migration `001_init.sql` already creates tables for `swarms`, `teams`, `team_members`, `skills`,
`plugins`, `providers`, `model_policies`, `threads`, `messages`, `files` and `jobs` — and
`apps/gateway/src/seed.js` already fills each of them with rows. **Not one of those eleven tables has
a single HTTP route.** The screens read their *own local copy* from `localStorage` instead. (`settings`
has no route either; the auth layer reads it internally.)

So most of this roadmap is **not** “design a schema and write a backend”. It is:

1. expose a table that already exists (**a route**, ~20 lines),
2. let the client read it instead of its local copy (**a slice**, ~10 lines),
3. add the piece that cannot be faked (**execution**: a model call, a worker, a transport),
4. delete the local simulation,
5. prove it with a test.

Step 3 is where the real work is. Steps 1, 2, 4 and 5 are mechanical, and this document gives you the
template for each.

### 0.2 Status vocabulary (used by the app itself)

The Copilot's capability registry (`src/copilot/capabilities.js`) already defines the honest
vocabulary. Use it everywhere — including in this roadmap:

| Status | Means | What the UI must show |
| --- | --- | --- |
| `available` | Works here, verified by a test or a real call | The feature |
| `unverified` | Code exists, external service never confirmed | “not verified” + what is missing |
| `demo` | Operates a local copy, nothing leaves the browser | “demo data — not enforced” |
| `unconfigured` | Needs credentials/setup the operator has not supplied | “configure X to enable” |
| `blocked` | Cannot work in this environment at all | Why, with no fake progress |

Anything that cannot reach `available` must land on one of the other four. **There is no sixth
state, and “looks fine” is not one of them.**

### 0.3 How to use a playbook

Every module in §5 has the same six parts:

1. **Today** — what actually works, with file references you can open.
2. **The gap** — the specific lie or absence.
3. **Done means** — acceptance criteria a test can assert.
4. **Steps** — numbered, beginner-level, with real code for this repo.
5. **Test to add** — the script that proves it, in this repo's style.
6. **URLs** — the external documentation you will need.

Work one module per sitting. Do not start a second before the first has a passing test, because a
half-wired slice is worse than a demo slice: it *looks* live while still being local.

---

## 1. Ten-minute orientation

### 1.1 What the app is made of

```
index.html ──► src/main.js ──► router (hash) ──► views.*        ← 18 screens, no framework
                    │
                    ├─ src/core.js       state shape + seed + helpers
                    ├─ src/datastore.js  where rows come from (gateway or demo)  ◄── the honesty layer
                    ├─ src/api.js        fetch wrapper, cookies, CSRF, tokens
                    ├─ src/shell.js      chrome, sheets, toasts, actions (`on('act', ...)`)
                    └─ src/views1.js · views2.js · terminal.js · voice.js · local.js · designer.js
                              │
                              ▼  HTTP + WebSocket
                    apps/gateway/server.js  (zero-dep HTTP + `ws`, 36 routes)
                              │
                              ├─ src/auth.js   sessions, CSRF, mmm_ tokens, lockout
                              ├─ src/rbac.js   5 roles → permission sets
                              ├─ src/db.js     SQLite (WAL) + migrations + events + audit chain
                              └─ src/comms.js  AES-256-GCM channel vault + delivery queue
```

Two facts that explain almost every “why doesn't this work?”:

- **The client renders from `getState()`**, a plain object persisted to `localStorage`
  (`mmm-state-v1`). A screen works when *something* keeps that object truthful.
- **`src/datastore.js` decides which slices are gateway-owned** (`GATEWAY_SLICES`) and which are not
  (`LOCAL_SLICES`). Today: gateway = agents, tasks, approvals, events; local = swarms, teams, usage —
  and every other screen (skills, plugins, providers, files, chat, telegram) reads seed data.
  When a slice is local, the UI still *says* “demo data” in the header chip. That chip is the
  feature you must not delete; it is how a regression becomes visible.

### 1.2 The seven layers of a working feature

Every real feature in this repo is built the same way. Learn this once; reuse it twenty times.

| # | Layer | File | What it does | Skip it and… |
| --- | --- | --- | --- | --- |
| 1 | **State** | `src/core.js` | default shape of the slice | the view crashes on first paint |
| 2 | **Table** | `apps/gateway/migrations/*.sql` | durable rows | data dies on reload |
| 3 | **Route** | `apps/gateway/server.js` | HTTP + permission + audit + WS broadcast | data exists but is unreachable |
| 4 | **Client call** | `src/api.js` | `api.thing()` wrapper | you hand-roll fetch and forget CSRF |
| 5 | **Provenance** | `src/datastore.js` | marks the slice `gateway` vs `demo` | the UI claims live data it does not have |
| 6 | **UI states** | `src/views*.js` | loading / empty / live / stale / blocked | a spinner forever, or a lie |
| 7 | **Test** | `scripts/*-test.mjs` | proves 1–6 | it silently rots |

### 1.3 The gap, in one table

| Table exists and is seeded | Route exists | Client reads it | Screen |
| --- | --- | --- | --- |
| agents | ✅ | ✅ | Agents, Designer |
| tasks | ✅ | ✅ | Tasks / Kanban |
| approvals | ✅ | ✅ | Approvals |
| events | ✅ | ✅ | Home, activity lists |
| comms_channels, comms_messages, comms_settings | ✅ | ✅ | Comms |
| **teams, agents.team_id** | ❌ | ✅ | Teams |
| **swarms** | ❌ | ❌ | Teams & Swarms |
| **skills** | ❌ | ❌ | Skills Hub, Matrix |
| **plugins** | ❌ | ❌ | Plugin Marketplace |
| **providers, model_policies** | ❌ | ❌ | Model Gateway |
| **threads, messages** | ❌ | ❌ | Chat |
| **files** | ❌ | ❌ | Artifacts |
| **jobs** | ❌ (unused) | ❌ | nothing yet — this is your runtime |
| settings | ❌ | localStorage | Settings |
| — no table — | ❌ | ❌ | Usage / cost, Analytics, Training, Voice engines, Local AI models |

Read that table as the work order. The top block is finished; the middle block is plumbing; the
bottom block is real engineering.

---

## 2. The truth table — every screen and surface

20 routed screens, plus four surfaces that are not routes (the approvals list inside Home, the
Copilot overlay, Training, and the usage ledger behind Analytics).

Legend: **✅ real** · **🟠 persisted but not served** · **🎭 simulated** · **❌ absent**.
Every row cites the file where the behaviour lives, so you can verify it in under a minute.

| # | Screen | Route | Status | What is actually happening | Where |
| --- | --- | --- | --- | --- | --- |
| 1 | **Home / Deck** | `#/home` | ✅ | Agents, approvals and events come from the gateway when signed in | `src/views1.js` |
| 2 | **Agents** | `#/agents` | 🟠 | Cards are real and persist, and **team, team position and goal are real columns** (`agents.team_id`, `agents.team_position`, `agents.goal`); every *number* is still a seed constant — `status: 'running'` is a label, `successRate`, `costToday`, `runs`, `lastActive`, `memory` are never computed | `001_init.sql` (agents), `006_team_membership.sql`, `fixtures/agents.json` |
| 3 | **Agent Designer** | `#/designer` | 🟠 | Saves through `createAgent()` → `POST /api/v1/agents` (real), but validation is client-side only and there is no versioning, evaluation or rollback | `src/designer.js:648` |
| 4 | **Teams** | `#/teams` | ✅ | Real end to end: create, rename, delete, add/remove member, reorder by position, through gateway routes with RBAC and audit. Membership lives once, on `agents.team_id` + `agents.team_position` (`team_members` retired by `006`). Deleting a team **unassigns** its members and says so. The panel is a full-height sheet on a phone and a 900 px docked panel above that | `apps/gateway/src/teams.js`, `server.js`, `src/team-panel.js`, `src/views1.js`, `src/agents.css` |
| 5 | **Teams & Swarms** | `#/swarms` | 🎭 | Deploy writes a **local object** with a fabricated node list; the estimate `$6.40` is a string literal; progress advances from `Math.random()` in a `setInterval` | `src/views1.js:500-520`, `src/main.js` `tick()` |
| 6 | **Tasks / Kanban** | `#/tasks` | ✅ | Real CRUD through the gateway; moves confirm before writing; drag, wires and zoom are client-side by design | `src/kanban.js`, `src/views2.js` |
| 7 | **Approvals** | `#/approvals` | ✅ | Real gates, separation of duties (you cannot approve your own), audited decisions | `server.js`, `scripts/gateway-auth-test.mjs` |
| 8 | **Skills Hub** | `#/skills` | 🎭 | 24-entry catalogue + 6 installed skills are local; import/validation/quarantine is genuinely good code but client-side; “activate” changes a local flag | `src/skillsData.js`, `src/skillsImport.js` |
| 9 | **Skills Matrix** | `#/matrix` | 🎭 | Relationship editing is local state only | `src/views2.js` |
| 10 | **Model Gateway** | `#/models` | 🎭 | 26 seeded providers; the on/off switch flips a local boolean; `latency`, `spendMTD` are constants; **no provider client, no key storage, no streaming** | `src/views2.js:328-380`, `fixtures/providers.json` |
| 11 | **Plugins / MCP** | `#/plugins` | 🎭 | “Install” sets `installed = true` locally and toasts success; the pasted API key is discarded; `callsToday` counts are seed data; the banner claims calls are “proxied & audited by the gateway” | `src/views2.js:385-470` |
| 12 | **Chat** | `#/chat` | 🎭 | Sending a message schedules a **canned reply** after 0.9–1.8 s, one of which invents a cost (`Estimated cost: $0.42`) | `src/views2.js:559` `simulateReply()` |
| 13 | **Copilot** | overlay | 🟠 | Real UI, real consent flow, real capability registry; answers are deterministic retrieval over local state; actions are labelled `demo` | `src/copilot/*` |
| 14 | **Analytics** | `#/analytics` | 🎭 | Four tiles, a chart and a “Live · last 24h” subtitle built from `+ 12`, `87% success`, `▲ 8%`, `median 4m`, `2 denied by policy` typed into the template | `src/views2.js:734-800` |
| 15 | **Artifacts / Files** | `#/artifacts` | 🎭 | File list is seed; “Upload” writes into local state; storage reads `248 MB / 2 GB` as a string; `files` table exists unused | `src/views2.js:816-880` |
| 16 | **Terminal** | `#/terminal` | 🎭 | 24 commands over local state; `/run`, `/deploy`, `/spend` fabricate results; banner says “shell v0.1.0-proto” | `src/terminal.js` |
| 17 | **Comms** | `#/comms` | ⚠️ | Genuinely server-side: encrypted channel configs, delivery rows, retry queue, signature-gated inbound. **Never verified against a live provider** | `apps/gateway/src/comms.js`, `docs/comms/` |
| 18 | **Telegram Bridge** | `#/telegram` | 🎭 | Entirely local. The link switch flips a boolean; “Send test notification” toasts **“Sent to Telegram”** without sending anything; the command preview answers with hardcoded strings, including a fake agent progress line | `src/views2.js:640-740` |
| 19 | **Voice Studio** | `#/voice` | 🟠 | `browser-speech` adapter is real where `speechSynthesis` exists (on-device); the local-endpoint and cloning adapters are contract-only until you run a server | `src/voice/adapters.js` |
| 20 | **Training** | — | ❌ | No screen, no backend, no job runner. Correctly reports `blocked` | `capabilities.js` |
| 21 | **Local AI** | `#/local` | ❌ | Phase 2 spike only; model manager, offline text, image phases not started | `src/local.js`, `docs/local/` |
| 23 | **Agent Browser** | `#/browser` | ✅ | Real end to end: gateway-owned tasks, one action per tick, watchdog, bounded recovery, checkpoints, evidence. **Requires Chromium on the gateway host** — until it is installed the screen reports `unconfigured` and offers no start button | `apps/gateway/src/browser/`, `src/browser.js` |
| 24 | **Self-Improvement** | `#/evolution` | ✅ | Real end to end: per-agent policy, isolated candidate, real sandboxed test runs, independent review, approval, versioned promotion and rollback, audit. **The sandbox is process isolation, not a container, and says so.** No model writes the patch for you yet | `apps/gateway/src/evolution/`, `src/evolution.js` |
| 22 | **Settings** | `#/settings` | 🎭 | Trust-weight sliders change a *preview number* only; notification toggles do nothing; retention is display text; “4 templates active”, “AEAD-sealed vault”, “default-deny · proxy” are static strings | `src/views2.js:930-1000` |

> **Note on honesty already present.** The header chip, the provenance notes and the capability
> registry are the app telling the truth about itself. They are correct today. Every playbook below
> *keeps* them and *narrows* what they cover by making the slice real — never widen a claim, only
> reduce the gap between claim and behaviour.

---

## 3. The “not installed” list — what you must obtain, and what happens without it

These are the things the app cannot conjure: credentials, servers, or a runtime. Each row says what
to get, where, how long it takes, whether it costs money, and exactly what the app does until you do.

| Dependency | Who needs it | Get it at | Cost / time | Until you have it |
| --- | --- | --- | --- | --- |
| **One LLM provider key** | Chat, Copilot, Swarms, Agents | Appendix A.1 | Free tier exists at several; 5 min | Every screen must show `unconfigured`; no reply text may be generated client-side |
| **MCP servers** (GitHub, Supabase, Firecrawl, Vercel, Airtable, Base44) | Plugins | Appendix A.2 | Each has a free tier or a local server; 10–30 min each | Plugin cards must say “no MCP client” and hide `callsToday` |
| **Telegram bot** | Telegram Bridge, Comms | Appendix A.3 | Free, 3 min with @BotFather | Screen must show “not linked” and the test button must be disabled |
| **Slack / Discord / WhatsApp / Twilio** | Comms | Appendix A.3 | Free sandboxes for Slack/Discord; WhatsApp and Twilio need a business account | Those channels stay `unverified` in the UI |
| **Local speech server** (Kokoro-FastAPI or Piper) | Voice: local engine | Appendix A.5 | Free; one Docker command | Voice falls back to `browser-speech`, which is real but OS-dependent |
| **Training/evals backend** (promptfoo, OpenAI evals, or a job runner) | Training | Appendix A.6 | Free/OSS, 1 day to wire | Training stays `blocked` — that is the correct state, not a bug |
| **Chromium for the Agent Browser** | Agent Browser | Appendix A.24 | Free/OSS; `npm i puppeteer` (~180 MB) or point at a system Chrome | The browser module reports `unconfigured` with the driver reason and refuses to start a task — no fake session |
| **Local GGUF model** | Local AI | Appendix A.7 | Free; 1–4 GB download | Local AI stays “spike only”; never claim offline inference |
| **Sandbox for tool execution** | Agents that run code | Appendix A.8 | Free tiers exist | Tools that execute code stay disabled |

**Rule:** none of these may be replaced by a mock in the shipped path. A mock belongs in a test file
(`scripts/*-test.mjs`), never in `src/`.

---

## 4. The standard playbook — how to implement anything here

Copy these five recipes. They are extracted from code that already works in this repo, so they will
fit without fighting the architecture.

### 4.1 Recipe 1 — add a table (migration)

Migrations are auto-discovered: `db.migrate()` reads every `*.sql` in `apps/gateway/migrations/`,
sorts by name, and applies the ones missing from the `migrations` table.

```sql
-- apps/gateway/migrations/004_usage.sql
-- One row per metered model call. Written only after a provider answered 2xx.
CREATE TABLE IF NOT EXISTS usage_events (
  id            TEXT PRIMARY KEY,
  ts            INTEGER NOT NULL,
  principal_id  TEXT NOT NULL,
  agent_id      TEXT,
  swarm_id      TEXT,
  purpose       TEXT NOT NULL DEFAULT 'chat',   -- chat | copilot | swarm-node | skill | eval
  provider_id   TEXT NOT NULL,
  model_id      TEXT NOT NULL,
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  cost_micros   INTEGER NOT NULL DEFAULT 0,     -- integer money: never floats
  latency_ms    INTEGER NOT NULL DEFAULT 0,
  request_id    TEXT,
  ok            INTEGER NOT NULL DEFAULT 1,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_ts      ON usage_events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_usage_agent   ON usage_events(agent_id, ts DESC);
```

```bash
npm run migrate      # → "migrated: 004_usage.sql"; run it twice to prove it is a no-op the second time
```

Rules that are not optional:

- **Never edit an applied migration.** Add a new one. Somebody's production database already ran the
  old text.
- **Wrap destructive changes** (drop/rename) in a new table + copy + swap, not `ALTER ... DROP`.
- **Money is integer** (micro-units or cents). Floats accumulate rounding errors that show up as
  “why is my invoice 3 cents off?”.
- **Every table that holds user content gets `deleted_at`** so deletion is auditable.

### 4.2 Recipe 2 — add a route

Routes live in `apps/gateway/server.js` and follow one shape:

```js
route(method, /^regex$/, { permission, mutating?, public?, rawBody? }, handler(ctx) => { code, body, headers? })
```

A complete, working pair of routes for swarms — the one this repo is missing:

```js
/* ---------- swarms ---------- */
route('GET', /^\/api\/v1\/swarms$/, { permission: 'read' }, () => ({
  code: 200,
  body: {
    swarms: db.prepare('SELECT * FROM swarms ORDER BY started_at DESC').all()
      .map((row) => ({ ...row, budget: JSON.parse(row.budget || '{}'), nodes: JSON.parse(row.nodes || '[]') })),
  },
}));

route('POST', /^\/api\/v1\/swarms$/, { permission: 'swarm:write', mutating: true }, (ctx) => {
  const objective = String(ctx.body?.objective || '').trim().slice(0, 500);
  const teamId = String(ctx.body?.teamId || '').trim();
  const cap = Math.min(Math.max(Number(ctx.body?.budgetCap) || 5, 0.5), 500);   // clamp, always
  if (objective.length < 8) return { code: 400, body: { error: 'objective must be at least 8 characters' } };
  if (!db.prepare('SELECT 1 FROM teams WHERE id = ?').get(teamId)) {
    return { code: 400, body: { error: 'unknown team' } };
  }

  const id = `sw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const now = Date.now();
  db.prepare(`INSERT INTO swarms (id, team_id, name, objective, status, progress, budget, nodes, channel, started_at, created_by)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, teamId, objective.slice(0, 40), objective, 'queued', 0,
    JSON.stringify({ cap, spent: 0 }), '[]', 'app', now, ctx.principal.id
  );
  const event = logEvent('swarm', `Swarm queued: ${objective.slice(0, 60)}`, id);
  audit(ctx.principal.id, ctx.principal.via, 'swarm.create', { id, teamId, cap }, 'allow', 'ok');
  broadcast('swarms', { type: 'swarm.created', entity: id, event });
  return { code: 201, body: { id, status: 'queued' } };
});
```

What each line is protecting:

| Piece | Why |
| --- | --- |
| `permission: 'swarm:write'` | RBAC decides, not the UI. `swarm:write` already exists in `src/rbac.js` |
| `mutating: true` | forces the CSRF check for cookie sessions |
| `String(...).slice(0, 500)` | every input is bounded; the body limit is 256 KB but a *field* limit prevents absurd rows |
| `clamp` on money | a hostile or fat-fingered client cannot set a $1e9 budget |
| `400` with a specific message | the UI can show the reason (`ApiError.body.error`) |
| `logEvent` + `audit` + `broadcast` | activity feed, tamper-evident trail, and every other open tab updates |

Status codes the client already understands: `400` bad input, `401` not signed in, `403` permission
or CSRF, `404` missing, `409` conflict, `429` rate/budget, `500` bug.

### 4.3 Recipe 3 — add the client call

```js
// src/api.js — inside `export const api = { ... }`
swarms: () => request('/api/v1/swarms'),
createSwarm: (body) => request('/api/v1/swarms', { method: 'POST', body }),
pauseSwarm: (id) => request(`/api/v1/swarms/${encodeURIComponent(id)}/pause`, { method: 'POST', body: {} }),
```

`request()` already handles: same-origin credentials, the CSRF header on mutations, timeouts,
`x-mmm-request-id` capture, session-epoch invalidation (a late response from a previous login can
never be adopted), and turning HTTP failures into a typed `ApiError` with `.status`, `.code`,
`.requestId`, `.body.error`.

**Never** call `fetch()` directly from a view. If you do, you lose all five.

### 4.4 Recipe 4 — make the slice live (provenance)

In `src/datastore.js`:

1. Move the slice from `LOCAL_SLICES` to `GATEWAY_SLICES`.
2. Write an adapter, next to `adaptAgent`/`adaptTask`:
   ```js
   export function adaptSwarm(row) {
     return {
       id: row.id, teamId: row.team_id, name: row.name, objective: row.objective,
       status: row.status, progress: Number(row.progress) || 0,
       budget: JSON.parse(row.budget || '{}'), nodes: JSON.parse(row.nodes || '[]'),
       channel: row.channel, startedAt: Number(row.started_at) || 0, source: 'gateway',
     };
   }
   ```
3. Add it to the fetch batch and to `adopt()`:
   ```js
   async function fetchAll() {
     const [agents, tasks, approvals, events, swarms] = await Promise.all([
       api.agents(), api.tasks(), api.approvals(), api.events(0), api.swarms(),
     ]);
     return { agents, tasks, approvals, events, swarms };
   }
   ```
   and in `adopt()` set `swarms: 'gateway'` and include `swarms` in `replaceSlices({...})`.
4. Add a WS handler for the `swarms` topic so a deploy in one tab appears in the other.

Then the header chip flips from `demo data` to `live gateway` for that screen with no UI change at
all — because the chip reads provenance, not a hardcoded label.

### 4.5 Recipe 5 — the test that proves it

Every gateway test in this repo boots a **throwaway database**, so it never touches `data/mmm.sqlite`:

```js
/* scripts/swarms-test.mjs — Run: npm run test:swarms */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'mmm-swarm-'));
process.env.MMM_QUIET = '1';
process.env.MMM_BOOTSTRAP_EMAIL = 'owner@test.local';
process.env.MMM_BOOTSTRAP_PASSWORD = 'OwnerPassw0rd!2026';
process.env.NODE_ENV = 'test';

const { createGateway } = await import('../apps/gateway/server.js');
const gateway = createGateway();
await new Promise((r) => gateway.server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${gateway.server.address().port}`;

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failures += 1; console.log(`FAIL ${name}: ${e.message}`); }
};

// login → cookie jar → CSRF, then exercise the routes
const login = await fetch(`${BASE}/api/v1/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'owner@test.local', password: 'OwnerPassw0rd!2026' }),
});
const cookie = login.headers.get('set-cookie').split(';')[0];
const { csrfToken } = await login.json();
const call = (path, opts = {}) => fetch(`${BASE}${path}`, {
  ...opts,
  headers: { cookie, 'content-type': 'application/json', 'x-mmm-csrf': csrfToken, ...(opts.headers || {}) },
});

await check('a queued swarm is persisted and readable', async () => {
  const created = await (await call('/api/v1/swarms', {
    method: 'POST',
    body: JSON.stringify({ objective: 'research 20 vendors', teamId: 'tm-research', budgetCap: 6 }),
  })).json();
  const list = await (await call('/api/v1/swarms')).json();
  const row = list.swarms.find((s) => s.id === created.id);
  if (!row) throw new Error('swarm was not persisted');
  if (row.status !== 'queued') throw new Error(`expected queued, got ${row.status}`);
  if (row.budget.cap !== 6) throw new Error('budget cap was not stored');
});

await check('a reject is a reject, not a silent pass', async () => {
  const res = await call('/api/v1/swarms', { method: 'POST', body: JSON.stringify({ objective: 'x' }) });
  if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`);
});

await check('the audit chain still verifies after the writes', async () => {
  const out = await (await call('/api/v1/audit/verify')).json();
  if (!out.ok) throw new Error('audit chain broken');
});

gateway.server.close();
console.log(failures ? `\nSWARMS: ${failures} FAILED` : '\nSWARMS: all checks passed');
process.exit(failures ? 1 : 0);
```

```bash
# register it
node -e "const fs=require('fs');const p=require('./package.json');
p.scripts['test:swarms']='node scripts/swarms-test.mjs';
fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
npm run test:swarms
```

Then add `&& npm run test:swarms` to the `test` script so it can never be forgotten.

---

## 5. Module playbooks

Ordered by value: **M01–M06** make the core (agents, teams, swarms, tasks, approvals) real;
**M07–M11** make the intelligence layer real; **M12–M16** make the data and surfaces real;
**M17–M21** are the long-horizon items that may legitimately stay `blocked`.

---

### M01 · Agents — “the demo agents”

> **This is the most misunderstood part of the app, so read the framing before the steps.**

**Today.** The six agents are **not fake rows**. They live in a real table, they survive a reload,
and the Designer writes them through a real, permission-checked, audited endpoint:

```sql
CREATE TABLE agents (
  id, name, role, framework, framework_config, model, fallback,
  status, trust, autonomy, success_rate, cost_today, runs, last_active,
  tools, skills, prompt, memory, created_by, deleted_at
);
```

**The gap.** Every *behavioural* column is a seed constant that nothing ever updates:

| Column | Reads as | Reality |
| --- | --- | --- |
| `status` | `running` | a string. No process exists, no run started, nothing will ever set it back to `idle` |
| `runs` | `214` | invented |
| `success_rate` | `0.94` | invented |
| `cost_today` | `4.28` | invented — and it is the number Analytics sums |
| `last_active` | a timestamp | invented |
| `memory` | `{episodic: 1840, semantic: 412, kb: "14.2 MB"}` | invented |
| `tools` / `skills` | `["firecrawl.scrape", ...]` | strings; nothing can invoke them |
| `model` | `anthropic/claude-sonnet-4` | an id; no provider client exists |

So an agent screen that says “Researcher-01 · running · 94 % success · $4.28 today” is not showing
demo *data* — it is showing a **fictional history attached to a real record**. That is the specific
thing to fix.

**Done means.**

- An agent's `status` changes only because a run started or ended.
- `runs`, `success_rate`, `cost_today`, `last_active` are computed from `agent_runs` (+ `usage_events`).
- With no provider key configured, “Run agent” is **disabled with the reason**, not a fake success.
- A fresh database shows an empty agent list — not six characters.

**Steps.**

1. **Create the run table** (`apps/gateway/migrations/005_agent_runs.sql`):
   ```sql
   CREATE TABLE IF NOT EXISTS agent_runs (
     id           TEXT PRIMARY KEY,
     agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
     principal_id TEXT NOT NULL,
     objective    TEXT NOT NULL DEFAULT '',
     status       TEXT NOT NULL DEFAULT 'queued',  -- queued|running|done|failed|cancelled
     model_id     TEXT NOT NULL DEFAULT '',
     provider_id  TEXT NOT NULL DEFAULT '',
     started_at   INTEGER, ended_at INTEGER,
     tokens_in    INTEGER NOT NULL DEFAULT 0,
     tokens_out   INTEGER NOT NULL DEFAULT 0,
     cost_micros  INTEGER NOT NULL DEFAULT 0,
     error        TEXT,
     output       TEXT NOT NULL DEFAULT '',
     created_at   INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_runs_agent ON agent_runs(agent_id, created_at DESC);
   ```
   ```bash
   npm run migrate
   ```

2. **Add the routes** (`apps/gateway/server.js`, following §4.2):
   - `GET /api/v1/agents/:id/runs` → `permission: 'read'`
   - `POST /api/v1/agents/:id/run` → `permission: 'agent:write'`, `mutating: true`

   The `POST` must **refuse before queueing** when no provider is usable:
   ```js
   const provider = db.prepare(`SELECT * FROM providers WHERE id = ? AND status = 'on'`).get(providerIdFor(agent.model));
   if (!provider || !provider.key_sealed) {
     return { code: 409, body: { error: 'no model provider is configured for this agent',
                                 detail: `The agent asks for ${agent.model}. Add a key for its provider in Models.` } };
   }
   ```
   A `409` with a reason is the honest behaviour; a queued job that silently never runs is not.

3. **Write the worker** — a single function started from `startGateway()`:
   ```js
   async function drainRuns() {
     const job = db.prepare(`SELECT * FROM agent_runs WHERE status = 'queued' ORDER BY created_at LIMIT 1`).get();
     if (!job) return;
     db.prepare(`UPDATE agent_runs SET status='running', started_at=? WHERE id=?`).run(Date.now(), job.id);
     db.prepare(`UPDATE agents SET status='running' WHERE id=?`).run(job.agent_id);
     broadcast('agents', { type: 'agent.updated', entity: job.agent_id });
     try {
       const result = await modelCall({ principalId: job.principal_id, agentId: job.agent_id,
                                        modelId: job.model_id, purpose: 'agent-run',
                                        messages: buildAgentMessages(job) });       // see M09
       db.prepare(`UPDATE agent_runs SET status='done', ended_at=?, tokens_in=?, tokens_out=?,
                   cost_micros=?, output=? WHERE id=?`)
         .run(Date.now(), result.tokensIn, result.tokensOut, result.costMicros, result.text, job.id);
     } catch (err) {
       db.prepare(`UPDATE agent_runs SET status='failed', ended_at=?, error=? WHERE id=?`)
         .run(Date.now(), String(err.message).slice(0, 300), job.id);
     } finally {
       recomputeAgentStats(job.agent_id);          // one SQL statement, see step 4
       db.prepare(`UPDATE agents SET status='idle' WHERE id=? AND status='running'`).run(job.agent_id);
       broadcast('agents', { type: 'agent.updated', entity: job.agent_id });
     }
   }
   setInterval(() => { drainRuns().catch(() => {}); }, 1000).unref();
   ```

4. **Compute, never store by hand** — one statement replaces four invented columns
   (`recomputeAgentStats`, `modelCall` and `buildAgentMessages` are helpers *you* write in this module;
   they do not exist yet):
   ```sql
   UPDATE agents SET
     runs         = (SELECT COUNT(*) FROM agent_runs WHERE agent_id = agents.id AND status='done'),
     success_rate = COALESCE((SELECT AVG(status='done') FROM agent_runs
                              WHERE agent_id = agents.id AND status IN ('done','failed')), 0),
     cost_today   = COALESCE((SELECT SUM(cost_micros)/1000000.0 FROM agent_runs
                              WHERE agent_id = agents.id AND created_at > ?), 0),
     last_active  = COALESCE((SELECT MAX(COALESCE(ended_at, started_at)) FROM agent_runs
                              WHERE agent_id = agents.id), last_active)
   WHERE id = ?;
   ```
   > `AVG(status='done')` works because SQLite treats booleans as 1/0. Keep the SQL in one place
   > (`recomputeAgentStats`) so the UI, the API and the tests can never disagree.

5. **Tool calls: refuse until M08.** If the agent's prompt needs a tool, the run must fail with
   “no MCP client is installed” rather than pretend it browsed the web. Wire tools in M08.

6. **Migrate the seed.** In `apps/gateway/src/seed.js`, stop writing `status`, `runs`, `success_rate`,
   `cost_today`, `last_active` and `memory` with invented values — write `status='idle'`, zeros and
   `{}`. Six DEMO agents become six **configured** agents with no history, which is the truth.

7. **UI** (`src/views1.js`, agent drawer): render `runs`/`successRate` as “— until first run” when
   `runs === 0`; disable Run with `aria-disabled` + reason when a `409` came back; show live elapsed
   time from `started_at`, not a fake progress bar.

**Test to add** — `scripts/agent-runs-test.mjs`: with an injected fake provider (fetch stub) assert
(a) a run row moves `queued → done`, (b) `usage_events` gets exactly one row, (c) agent counters equal
the SQL aggregates, (d) **with no provider key the POST is 409 and no run row is created**.

**Evidence:** the four SQL aggregates printed next to the UI numbers for the same agent.

**URLs:** Appendix A.1 (provider APIs), A.4 (frameworks if you adopt one).

---

### M02 · Agent Designer

**Today.** A genuinely good four-step wizard that writes a real agent record via
`createAgent()` → `POST /api/v1/agents`, with client-side validation and dual checks.

**The gap.** Validation is client-side only (a crafted request bypasses it); there is no versioning,
no diff, no rollback, and no evaluation before activation. The spec's “idle definition” state exists
in the UI but not in the database.

**Done means.** Server-side validation returns field-level errors; every save creates an immutable
version; you can diff and restore; an agent cannot be marked “active” while its latest version failed
validation.

**Steps.**

1. Migration `006_agent_versions.sql`: `agent_versions(id, agent_id, version, prompt, model, tools, manifest, created_by, created_at)`; `agents.current_version`.
2. Validate in the route with a small shared module (`packages/shared/agent-schema.js`) used by both
   the browser and the gateway — one source of truth, so the two can never drift.
3. `POST /api/v1/agents/:id/versions` and `POST /api/v1/agents/:id/versions/:v/activate`
   (`agent:write`, audited). Activation is the only thing that changes what runs.
4. Designer: show the server's field errors verbatim; add a “draft vs active” badge; never show
   “validated” from a client-only check.

**Test:** a request with a 40 000-character prompt or a bad model id returns 400 with the field name;
a version round-trips and the active pointer moves.

**URLs:** A.4 (LangGraph / OpenAI Agents SDK config patterns), A.6 (prompt evaluation before activation).

---

### M03 · Teams

**Today.** `teams` and `team_members` are seeded; the screen reads seed data.

**The gap.** No routes at all. The topology (`Hierarchical`, …) is a label with no behaviour.

**Done means.** Teams are created, renamed and populated through the API; membership changes are
audited; deleting a team does not orphan agents.

**Steps.**

1. `GET /api/v1/teams` (`read`), `POST` / `PATCH /api/v1/teams/:id` (`agent:write`), and
   `PUT /api/v1/teams/:id/members` (`agent:write`) — returning `{ team, members: [...] }`.
2. Validate topology against a fixed enum; reject an unknown agent id with 400.
3. Move `teams` into `GATEWAY_SLICES` (§4.4) with `adaptTeam()`.
4. Swarms (M04) read team membership to build the node list — this is why teams come before swarms.

**Test:** create a team, add two members, delete one, assert the join table and the audit rows.

**URLs:** A.4 (multi-agent topologies), A.9 (the topology patterns in `docs/DESIGN_SPEC.md`).

---

### M04 · Swarms — the loudest simulation in the app

**Today.**

```js
// src/views1.js ~L500
<button class="btn grow grad" data-act="swarm-deploy-go">Deploy · est $${'6.40'}</button>
```
```js
// src/views1.js ~L507 — the deploy handler
st.swarms.unshift({ id: uid('sw'), ..., status: 'live', progress: 0.03,
  budget: { cap, spent: 0.1 }, nodes: [ { id: 'n1', label: 'planner', status: 'running', spent: 0.1 }, ... ] });
```
```js
// src/main.js — tick() every 2 s, gated on settings.simulate
w.progress = Math.min(0.97, w.progress + 0.004 + Math.random() * 0.012);
```

A swarm “runs” because a timer says so. The price estimate is a string literal. The node list is
written by hand at deploy time.

**The gap.** `swarms` table exists (with `nodes` JSON) and is seeded — **no route**. No worker, no
real estimate, no pause/resume/cancel, and progress is random.

**Done means.** Deploy writes a row; the estimate is computed from a price table; progress equals
completed nodes ÷ total nodes, computed server-side; pause/resume/cancel change server state; two
browsers agree; with the gateway stopped the list shows **stale**, not invented movement.

**Steps.**

1. Add `GET /api/v1/swarms`, `POST /api/v1/swarms` (see §4.2), and
   `POST /api/v1/swarms/:id/pause|resume|cancel` — all `swarm:write`, all audited, all broadcasting
   on the `swarms` topic. Reject transitions that make no sense (`cancel` on a finished swarm → 409).
2. **Estimate server-side** from data, not prose:
   ```sql
   CREATE TABLE IF NOT EXISTS model_prices (
     model_id TEXT PRIMARY KEY, input_micros_per_1k INTEGER, output_micros_per_1k INTEGER,
     effective_from INTEGER NOT NULL
   );
   ```
   `GET /api/v1/swarms/estimate?teamId=…&nodes=3` returns a range with the assumption stated
   (“3 nodes × 8 k in / 2 k out × current price”). The button renders that; when no price exists it
   says “estimate unavailable” instead of inventing `$6.40`.
3. **Decide what `running` means — and write it down.** Two legitimate models:
   - **Supervised (start here):** `running` means a runtime is attached. The worker (or a human
     operator via API) posts node transitions; nothing advances by itself.
   - **Executed (after M01 + M09):** the swarm worker leases `jobs` rows, runs each node as an agent
     run, and marks the node `done` when that run finishes.

   Either way, the invariant is the same: **`progress = nodes.filter(done).length / nodes.length`**.
4. **Delete the simulation.** Remove `tick()` from `src/main.js`, the `toggle-sim` handler and
   `settings.simulate` from `src/views2.js`, and strip the key from persisted state.
5. **Wire the slice** (§4.4) and subscribe to the `swarms` WS topic.
6. **Failure paths matter:** budget exhausted → node `failed` with reason; worker crash → lease
   expires and the swarm is marked `stalled` (visible), never silently frozen at 97 %.

**Test:** deploy → row; pause → status; resume → status; cancel → status + audit; kill the worker →
stalled; assert `progress === done/total` for a 3-node fixture.

**Evidence:** a two-browser screen recording, plus the SQL row matching the UI percentage.

**URLs:** A.4 (LangGraph/CrewAI/OpenAI Swarm for orchestration patterns), A.1 (pricing pages for the
estimate table), A.10 (durable job runners if you outgrow the in-process loop).

---

### M05 · Tasks / Kanban

**Today.** Real gateway CRUD (`GET/POST/PATCH /api/v1/tasks`), confirmation before every move,
dependency wires, zoom, Copilot intents — one of the most complete features in the app.

**The gap.** Deliberately missing (documented in `docs/kanban/board.md`): server-side dependencies,
card ordering, delete, and blocking when a dependency is `done`. These refuse rather than pretend.

**Done means.** Dependencies and order persist; delete is soft (`deleted_at`) and audited; a move
that violates a dependency is refused with the blocker named.

**Steps.**

1. Migration: `task_edges(from_task, to_task, kind)`, `tasks.position REAL`, `tasks.deleted_at`.
2. `PATCH /api/v1/tasks/:id` accepts `position`; `POST /api/v1/tasks/:id/edges`; `DELETE` soft-deletes.
3. Refuse a move into `done` while an inbound `blocks` edge is unfinished, returning the blocker id.
4. Kanban already re-reads on WS `tasks` topic — verify ordering does not fight the drag preview.

**Test:** create A→B, finish A, then B becomes movable; attempt the reverse and assert 409 + reason.

**URLs:** existing `docs/kanban/board.md`; A.11 for fractional-index ordering.

---

### M06 · Approvals & governance

**Today.** Real and strong: gates with allow/deny, separation of duties (you cannot decide your own
request), hash-chained audit, RBAC matrix, lockout, scoped tokens.

**The gap.** Gates are only raised by the routes that exist. Consequential actions the app advertises
(deploy a swarm, spend above a budget, install a plugin with write scopes, send a message from a
channel) do not raise gates. Approval “templates” are a static claim.

**Done means.** A configurable policy decides when a gate is required; a consequential action without
a gate is impossible by construction; `approvals` links to the action it authorises.

**Steps.**

1. Migration: `approval_policies(id, action, condition, required_role, ttl_minutes)`, plus
   `approvals.action_ref` and `approvals.policy_id`.
2. One helper, used by every consequential route:
   ```js
   function gateRequired(action, ctx) { /* returns { required, policy } */ }
   function raiseGate(action, payload, ctx) { /* creates approval, returns 202 { approvalId } */ }
   ```
   If `gateRequired()` is true and no gate exists for this action, the route returns
   `202 Accepted` with the approval id — **it does not perform the action**.
3. Wire gates for: swarm deploy above budget, provider key change, plugin install with `write` scope,
   principal role change, channel send above a rate threshold.
4. Settings can now show real templates (they exist in the table) instead of “4 templates active”.

**Test:** an Operator deploys above the cap → 202 + gate; a Reviewer allows → the deploy proceeds and
both rows are audited; the requester cannot decide their own gate (403).

**URLs:** `docs/copilot/copilot-governance-auth.md`; A.12 (approval workflow patterns).

---

### M07 · Skills Hub — from “installed” to “executable”

**Today.** A real catalogue (24 entries, 4 installed) and genuinely careful import code: format detection,
dependency checks, quarantine, typed matrix, export. All of it runs in the browser.

**The gap.** `skills` table exists and is seeded, **no routes**. “Activate” flips a local flag. Nothing
can invoke a skill, so `invokes` counts and `success` rates are seed values. A2A correctly reports
unavailable.

**Done means.** Skills are imported and activated server-side with audit; an activated skill can be
invoked by an agent run (M01); a skill that needs an unavailable tool is shown as `blocked` with the
missing tool named; the matrix persists.

**Three honest levels — pick one and label it:**

| Level | What “active” means | Effort |
| --- | --- | --- |
| **L1 · Installed** | Row exists, validated, enabled flag true. Not executable. | 1 day |
| **L2 · Invocable** | The skill body is prepended to an agent run's prompt (a “prompt skill”). Real, verifiable effect. | 2 days |
| **L3 · Tool-executing** | Skill declares tools; calls go through M08's MCP client with scoped tokens. | after M08 |

**Steps.**

1. Routes: `GET /api/v1/skills`, `POST /api/v1/skills` (import one package — reuse the *server-side*
   copy of the validator), `POST /api/v1/skills/:id/activate|deactivate` (`agent:write`), all audited.
2. Share the validation module with the browser (`packages/shared/skill-schema.js`) so import rules
   cannot diverge.
3. Store `body` and `manifest` (both columns already exist). Activation sets `status='active'` and
   writes an audit row naming the version.
4. L2: in `buildAgentMessages()` (M01), prepend active skills whose `tools` ⊆ available tools.
5. Move `skills` into `GATEWAY_SLICES`; the Matrix writes through `PUT /api/v1/skills/:id/edges`.

**Test:** import a package, activate, run an agent whose agent record lists that skill, assert the
prompt contains the body and `invokes` incremented; deactivate and assert it stops appearing.

**URLs:** A.13 (skill/agent packaging conventions), A.2 (tool servers).

---

### M08 · Plugins / MCP — “not installed” in the most literal sense

**Today.** Six plugin cards. Three show as installed, three as available. Clicking install writes
`installed = true` locally and toasts “installed”. The auth key you paste is **discarded**. The banner
says calls are “proxied & audited by the gateway”; nothing is proxied, nothing is audited, and
`callsToday` is invented.

**The gap.** No MCP client, no server registry, no per-call credential, no audit of tool calls.
`plugins.config_sealed` and `plugins.scopes` exist in the schema and are unused.

**Done means.** A plugin is “installed” only when the gateway has connected to its MCP server and
listed its tools; tool calls carry a scoped token, are audited with an arguments hash, increment a
real counter, and are refused when the scope is missing.

**Steps.**

1. **Decide transport.** MCP servers are either **stdio** (a local child process) or **HTTP/SSE**.
   Start with stdio for local servers, HTTP for the hosted ones (Appendix A.2).
2. Add `plugin_servers(id, plugin_id, transport, command, url, allowed_tools, enabled)` — never store
   a credential in `plugins`; seal it with the same AES-256-GCM vault the comms channels use
   (`encryptJson` / `decryptJson` in `apps/gateway/src/comms.js` are the real functions to copy).
3. Implement the client as a small JSON-RPC module (`apps/gateway/src/mcp.js`):
   `initialize()` → `tools/list` → `tools/call`, with a per-call timeout and a hard output cap.
   ```js
   // apps/gateway/src/mcp.js (shape, not a full implementation)
   export async function callTool(pluginId, tool, args, { principal, requestId }) {
     const server = getServer(pluginId);
     if (!server.enabled) throw new Error('plugin disabled');
     if (!server.allowed_tools.includes(tool)) throw new Error(`tool ${tool} is not in this plugin's allowlist`);
     const out = await rpc(server, 'tools/call', { name: tool, arguments: args }, { timeoutMs: 15000 });
     db.prepare('UPDATE plugins SET calls_today = calls_today + 1 WHERE id = ?').run(pluginId);
     audit(principal.id, principal.via, 'mcp.call', { pluginId, tool, argsHash: hash(args), requestId }, 'allow', 'ok');
     return out;
   }
   ```
4. **Install = connect + list tools**, and it fails loudly:
   `POST /api/v1/plugins/:id/install` → 200 `{ tools: [...] }` or 502 with the server's error.
   Uninstall kills the process and clears the sealed config.
5. **Never** log arguments in full — hash them (`args_hash`), log the tool name and the outcome.
6. Rewrite the screen copy when you are done: it may then say what is true. Until then, change
   `src/views2.js:392-394` to “MCP client not implemented — these are catalogue entries” and delete
   the `callsToday` render (or render “—”).
7. Dangerous tools (write, delete, deploy) must pass through an approval gate (M06).

**Test:** a local mock MCP server (a tiny Node script speaking JSON-RPC on stdio) — install lists two
tools, a call increments the counter and writes an audit row with an args hash, a tool outside the
allowlist is refused, and a crashed server surfaces 502 rather than hanging.

**URLs:** A.2 — MCP spec, reference servers, and each of the six integrations' API docs.

---

### M09 · Model Gateway — 26 providers, zero calls

**Today.** A catalogue of 26 providers with `status`, `models`, `latency`, `spendMTD`. Toggling one
flips a local boolean. `providers.key_sealed` and `providers.endpoint` already exist in the schema and
are never used.

**The gap.** No provider client, no key storage, no streaming, no metering, no budget enforcement, no
routing. The page is a catalogue pretending to be a router.

**Done means.** One provider works end to end: key sealed server-side, a real completion recorded with
provider-reported tokens, cost written to the ledger, budget enforced **before** the call, and the key
provably absent from the built bundle.

**Steps.**

1. **Pick one provider.** Not six. It is much easier to generalise from one working adapter than to
   debug six broken ones.
2. **Seal the key** using the comms vault (`encryptJson`/`decryptJson` in `apps/gateway/src/comms.js`):
   `PUT /api/v1/providers/:id` (`principal:write:privileged` for key changes — an Operator must not be
   able to point the workspace at their own endpoint) → store ciphertext in `key_sealed`, never return
   it (masked last-4 only).
3. **Adapter with the same contract as the comms adapters** — pure `buildRequest`, testable offline:
   ```js
   // apps/gateway/src/providers/openai.js
   export function buildRequest({ model, messages, maxTokens, stream }) {
     return {
       url: 'https://api.openai.com/v1/chat/completions',
       method: 'POST',
       headers: { 'content-type': 'application/json' },
       body: { model, messages, max_tokens: maxTokens, stream: Boolean(stream) },
     };
   }
   export function parse(json) {
     return { text: json.choices[0].message.content,
              tokensIn: json.usage.prompt_tokens, tokensOut: json.usage.completion_tokens,
              model: json.model };
   }
   ```
4. **One funnel**, so metering cannot be bypassed:
   ```
   modelCall({ principalId, agentId, purpose, modelId, messages })
     → resolve provider + price → enforce budget → call with timeout/abort
     → on 2xx: write usage_events + return; on failure: audit + throw (no usage row)
   ```
   Budget check happens **before** the network call, aggregating `usage_events` for the day.
5. **Routing**: `model_policies` already exists (priority + rules). Resolve policy → provider →
   fallback in one function used by `modelCall`, and expose `GET /api/v1/routing/resolve?agentId=`.
6. **Streaming** for chat: `text/event-stream`, abort on client disconnect (otherwise you keep paying
   for tokens nobody reads), cap `max_tokens`, cap response size.
7. **Prices as data** in `model_prices` with `effective_from`; never constants in code.
8. **Flip the capability** `llm` from `unverified` to `available` **only** after a recorded call.
9. Move `providers` + `model_policies` into `GATEWAY_SLICES`; render “3 of 26 configured” from real
   `key_sealed` presence, not a hardcoded “26 providers”.

**Test:** with a local stub HTTP server — a completion writes one usage row with exact token counts
and cost, a 401 from the provider writes an audit row and **no** usage row, a call above the daily cap
returns 429 without contacting the provider, and `grep -r "sk-" dist/` is empty.

**URLs:** A.1 — every provider's API reference and pricing page.

---

### M10 · Chat

**Today.** Sending a message writes it locally and schedules one of four canned replies after
0.9–1.8 s, one of which invents a spend figure:

```js
// src/views2.js:559
`Good call — dispatching as a task with a review gate. Estimated cost: $0.42.`,
```

**The gap.** `threads` and `messages` tables exist and are seeded, **no routes**. No model. The reply
text is generated in the browser, which is the worst place for it.

**Done means.** Threads and messages are server rows; a reply only exists if a runtime produced it;
with no model configured the server stores an explicit “not answered” message and the UI renders it as
a notice.

**Steps.**

1. `GET /api/v1/chat/threads`, `POST /api/v1/chat/threads`,
   `GET|POST /api/v1/chat/threads/:id/messages` (`read` / `chat:write` — add the permission to
   `src/rbac.js` for Operator).
2. `POST` accepts a `clientId` for idempotency (retry cannot duplicate a row).
3. Delete `simulateReply()` and both call sites (`sendChat`, `new-chat-go`).
4. Until M09 is done, the POST returns:
   ```json
   { "message": { "id": "…", "role": "system", "runtime": "none",
                  "body": "No model runtime is configured. This message is stored, not answered." } }
   ```
   The UI renders `runtime !== 'model'` as a notice, never as an agent speaking.
5. After M09: `POST` calls `modelCall(purpose: 'chat')`, streams, persists the assistant message with
   `model_id`, tokens and cost.
6. Move `threads`/`messages` into `GATEWAY_SLICES`; subscribe to a `chat` WS topic per thread.

**Test:** a message survives reload and a second browser; a retried POST with the same `clientId`
creates one row; with no provider the reply has `runtime: 'none'`; `rg "Estimated cost"` finds nothing.

**URLs:** A.1 (chat completion + streaming), A.14 (SSE/browser streaming).

---

### M11 · Copilot

**Today.** The strongest surface in the app: full-screen stage, consent-gated mic, capability
registry, action cards with two-step confirmation, honest labels (`demo`, `blocked`, `unverified`).

**The gap.** Conversations are browser-only; answers are deterministic retrieval; actions write to
the local store; `llm` is `unverified` (correct).

**Done means.** Messages persist; the capability registry drives every claim; when an action cannot be
performed server-side the card ends `blocked` with the reason; `llm` becomes `available` only with a
recorded call.

**Steps.**

1. `POST /api/v1/copilot/messages` (`copilot:use`): store the turn, attach the capability snapshot,
   and — once M09 exists — call the model with a system prompt built from the registry.
2. Replace the orchestrator's state reads with the same `api.*` calls the screens use, so Copilot and
   UI can never disagree about the world.
3. Point every action card at the real route from M01–M08. A card's last step must be the route's
   response: `ok` only on 2xx, `blocked` on 409/403 with the server's message.
4. Keep the ghost/consent/motion machinery untouched — it is finished and covered by
   `npm run test:motion`.

**Test:** a message persists; an action against a blocked capability renders `blocked` with the server's
reason and writes no state; a successful action writes exactly one audit row.

**URLs:** A.1, A.15 (tool-calling / structured output patterns).

---

### M12 · Analytics — numbers that were typed in

**Today.**

```js
// src/views2.js ~L741-748
<div class="sub">Live · last 24h</div>
{"▲ 8% vs yesterday"}
${s.tasks.filter((t) => t.column === 'done').length + 12}
{"87% success"} {"2 denied by policy"} {"median resolve 4m"}
```

**The gap.** `+ 12`, `87 %`, `▲ 8 %`, `median 4m` and `2 denied` are literals. There is no usage
ledger, so there is nothing to aggregate.

**Done means.** Every tile is a SQL aggregate over a real table; a metric that cannot be computed says
`not tracked`; the export is generated from the same query; the “Live · last 24h” subtitle is only
shown when the window is actually live.

**Steps.**

1. Add the ledger (`004_usage.sql` in §4.1) and make M09 write to it.
2. One aggregate endpoint:
   `GET /api/v1/analytics/series/:metric?window=24h&bucket=1h` (`read`), metric names from an
   allowlist (`spend`, `tokens`, `tasks_done`, `approvals`, `mcp_calls`, `runs`).
   ```sql
   SELECT (ts / ?) * ? AS bucket, SUM(cost_micros) AS value
   FROM usage_events WHERE ts > ? GROUP BY bucket ORDER BY bucket;
   ```
3. Replace every literal. Where a metric has no source yet, render `not tracked` — a dash is honest,
   a plausible number is not.
4. `export-report` calls `GET /api/v1/analytics/export.csv` (same query, `text/csv`), then triggers a
   real download. Delete the `unshift({ content: 'metric,value\nspend_today,17.93…' })` block.
5. Budget bars read the same ledger; they become meaningful for the first time.

**Test:** insert three usage rows at known timestamps, assert the series buckets and the tile value;
assert the CSV row count equals the series length; `rg "median 4m|87%|\+ 12" src/` is empty.

**URLs:** A.16 (SQLite aggregate/date functions), A.17 (charting if you replace the sparkline).

---

### M13 · Artifacts / Files

**Today.** Six seeded files, an upload sheet that writes into local state, and a storage bar reading
`248 MB / 2 GB` as a string. `files` table exists (`path, type, size, content, created_by, run_id,
deleted_at`) and is unused by any route.

**The gap.** No routes; no real bytes; no size accounting; no ownership.

**Done means.** Upload stores a row and returns a checksum; download returns byte-identical content;
the storage bar is a `SUM(size)`; a user cannot read another principal's file.

**Steps.**

1. `GET /api/v1/files`, `POST /api/v1/files` (`file:write`), `GET /api/v1/files/:id/content`,
   `DELETE /api/v1/files/:id` (soft delete, audited).
2. For text (the current `content TEXT` column) keep it in SQLite; for binaries, write under
   `DATA_DIR/files/<id>` and keep metadata in the row. Cap uploads (`MMM_BODY_LIMIT` is 256 KB) and
   reject a type outside an allowlist with 415.
3. Compute `size` and `sha256` server-side; never trust the client's numbers.
4. Scope by `created_by` unless the principal holds `system:diagnostics`.
5. Replace `248 MB / 2 GB` with `SUM(size)` against a configurable quota (`settings` table).
6. Move `files` into `GATEWAY_SLICES`.

**Test:** upload → row → download → hash matches; an oversized upload is 413; a second principal gets
404, not 403, for someone else's file (do not leak existence).

**URLs:** A.18 (content-type handling, checksums), A.19 (object storage if you outgrow local disk).

---

### M14 · Terminal

**Today.** 24 commands over local state. `help` lists commands that fabricate results (`/run`,
`/deploy`, `/spend`), and the banner says “shell v0.1.0-proto”.

**The gap.** It presents itself as a shell with system access. It has none.

**Done means.** Every command either performs a real, permission-checked operation or refuses with a
reason; the title says what it is (“Console · this browser”); `help` matches the implementation exactly.

**Steps.**

1. Retitle to **Console** and add one line under the prompt: “Runs in this browser. Reads go through
   the gateway; writes need the screens.”
2. Wire read commands to the API: `status` → `GET /api/v1/summary`, `agents`, `tasks`, `swarms`,
   `audit` (requires `audit:read`; a Reviewer-only command is fine — refusing is the point).
3. Delete fabricating cases (`run`, `deploy`, `spend` fallback text). A command that cannot act should
   print the exact route it would call and stop.
4. Remove `reset-demo` (the demo path is removed in the roadmap's L8).
5. Make `help` generated from the command table so it cannot drift.

**Test:** a table-driven test iterating the command registry, asserting each command returns either a
real value or a refusal containing a reason — never an invented figure.

**URLs:** A.20 (ANSI/hosted terminal conventions, if you later add a real PTY).

---

### M15 · Comms & the Telegram Bridge — the fake screen on top of a real transport

**Today.** This is the most fixable high-impact defect in the product.

- **Comms** (`#/comms`) is genuinely server-side: AES-256-GCM sealed channel configs, masked reads,
  delivery attempts with backoff, quiet hours, rate limits, idempotent sends, signature-gated inbound.
  It is `unverified` because no live provider has been exercised.
- **Telegram Bridge** (`#/telegram`) is **entirely local**, even though the Telegram transport already
  exists in `apps/gateway/src/comms.js`:
  ```js
  on('tg-link', …)   // flips a local boolean and toasts "Bot linked ✓"
  on('tg-test', …)   // toasts "Sent to Telegram" — sends nothing
  on('tg-cmd', …)    // answers with hardcoded strings, e.g. "13/20 vendors crawled"
  ```

**The gap.** Two implementations of the same idea, and the visible one is the fake one.

**Done means.** The Telegram screen is a **view of the comms channel**: linking calls the real
`PUT /api/v1/comms/telegram`, the test button performs a real send and reports the provider's result
(id, status, error), the command preview explains that commands arrive by webhook, and no string is
invented.

**Steps.**

1. Delete `tg-link`, `tg-test`, `tg-cmd` local handlers and the `telegram` state slice. Do not keep a
   fallback — a second source of truth is how this bug happened.
2. Rebuild the screen against the existing endpoints:
   - `PUT /api/v1/comms/telegram` with `{ botToken, chatId, allowlist }` → response is masked
   - `POST /api/v1/comms/telegram/send` with `{ text }` → response includes the provider message id
   - `GET /api/v1/comms/messages?channel=telegram` → the real delivery log (this is the “live bot
     preview”)
   - `GET /api/v1/comms/:id/verify` → the provider handshake (what “link” actually means)
3. The command list becomes documentation of the **inbound webhook** grammar, with a link to
   `docs/comms/channels.md`; it must not render fake agent replies.
4. Get a bot token (Appendix A.3), configure it, send one real message to a private chat, and record
   the provider's message id in the evidence table. Only then move `channels` from `unverified` to
   `available` **for that channel**.
5. Keep `opensms` as `unconfigured` until a real adapter exists.

**Test:** a mocked provider (existing pattern in `scripts/comms-gateway-test.mjs`) asserts the screen's
send calls the route and renders the provider id; a failed send renders the provider's error and
**does not** toast success.

**URLs:** A.3 — Telegram Bot API, webhooks, Slack, Discord, WhatsApp Cloud, Twilio, OpenSMS.

---

### M16 · Voice

**Today.** Better than the label suggests. `browser-speech` (Web Speech `speechSynthesis`) is a real
on-device engine where the OS provides voices; the studio's stale-audio rules, cancellation and
stale-request handling are real and tested (48 assertions). The local-endpoint and cloning adapters
are honest contract-only stubs that refuse.

**The gap.** Capability `voice` reports `blocked`; the local engine needs a server you have not
installed; cloning needs an adapter with a real model.

**Done means.** The voice capability reflects the **measured** device state (`available` when an
on-device voice exists and speaks a test phrase), the local engine works against a real local TTS
server if configured, and cloning stays `blocked` until an engine exists.

**Steps.**

1. Change the capability from a static `blocked` to a runtime probe: enumerate
   `speechSynthesis.getVoices()`, check `localService`, synthesise a short buffer, and report per-voice
   results. (`src/voice/adapters.js` already does most of this — surface it in `capabilities.js`.)
2. Optional local engine: run Kokoro-FastAPI or Piper on `127.0.0.1` and point the adapter at it —
   `validateLocalEndpoint()` already enforces loopback-only and no credentials in the URL.
3. Never route audio to a cloud service without the existing consent card; keep the mic consent flow
   exactly as it is.
4. Move the fake test engine in `src/voice/studio.js` behind a test-only flag so production builds
   cannot instantiate it.

**Test:** on a machine with voices, `available`; with `speechSynthesis` deleted, `blocked` with the
reason; local endpoint refusal for a non-loopback URL (already covered).

**URLs:** A.5 — Web Speech API, Kokoro, Piper, whisper.cpp, OpenVoice, NeuTTS.

---

### M17 · Training & evaluation

**Today.** No backend at all. Capability correctly `blocked`. A `jobs` table exists and is unused.

**The gap.** Everything. This is the one module where doing nothing is currently correct.

**Done means.** Either a real job runner produces a real artefact (dataset → run → metrics → model
card), or the surface stays `blocked` with a reason. Half a progress bar is worse than none.

**Steps (only when you decide to build it).**

1. Use `jobs` for the queue (it already has `lease_owner`, `lease_until`, `attempts`, `next_run_at` —
   a proper leased queue).
2. Datasets as files (M13) with a manifest and a hash; no training data in browser storage.
3. Run evaluations first (cheap, fast, useful): promptfoo or OpenAI evals against golden cases.
4. Only then training/fine-tuning; store the model card, the dataset hash, the eval delta and the
   cost. A “model” without those four is not a model, it is a claim.

**Test:** a job moves `queued → running → done` with an artefact; a killed worker's lease expires and
the job is retried exactly once more (`attempts`).

**URLs:** A.6 — promptfoo, OpenAI evals, LangSmith, Ragas.

---

### M18 · Local AI (on-device)

**Today.** A measured preflight screen, a separate `local-spike.html`, and `src/localRuntime.js` that
loads a GGUF from OPFS with pinned `wllama`. Phase 2 (runtime spike) is in progress; model manager,
offline text and image phases have not started. Nothing claims otherwise.

**The gap.** Phases 3–6. Model download/verify, streaming generation, local history, lifecycle
failures, and real device measurements.

**Steps**

1. Model manager: `listModels/importModel/downloadModel` with persisted lifecycle states, SHA-256
   verification, atomic promote of partial files, real progress and cancel.
2. Offline text: streaming with `stopGeneration`, local history, and a **network-log test** proving no
   prompt or response leaves the device.
3. Real-device measurements (memory, thermal, tokens/s) before any UI promise.
4. Keep every failure visible: corrupt model, interrupted write, OOM — each with its own state.

**Test:** existing `npm run test:local` + `test:local-runtime`, extended with the network-isolation
assertion.

**URLs:** A.7 — wllama, llama.cpp, OPFS/File System Access, WebGPU.

---

### M19 · Settings & trust

**Today.** Trust-weight sliders change a preview number; notification switches change nothing;
retention is display text; three security lines are static strings; “Reset demo data” wipes local
state.

**The gap.** The screen configures nothing that affects the system.

**Done means.** Every control either changes server behaviour or is removed; trust is computed from
real signals; notifications route through a real channel; retention is enforced by a scheduled job.

**Steps.**

1. Move settings to the `settings` table with `GET/PUT /api/v1/settings` (`principal:write` for
   workspace-level keys, audited).
2. **Trust**: compute from `agent_runs` (success rate), approvals (compliance), incidents
   (`audit_log` denies) and cost adherence — the weights you already have become a real formula.
   Publish the formula next to the slider.
3. **Notifications**: each topic maps to a channel and an event type; the toggle enables a real
   destination (M15). No destination, no toggle.
4. **Retention**: a scheduled job deletes rows past the configured age and records what it deleted.
5. Replace the three static strings with computed status (`SELECT COUNT(*) FROM approval_policies`,
   vault key present, egress policy rows).
6. Remove “Reset demo data”; replace with an Owner-only, typed-confirmation workspace reset (audited,
   off by default in production) — this is roadmap task H02/H03.

**Test:** a PUT changes what a subsequent GET returns and writes an audit row; a retention job with a
backdated row deletes exactly that row.

**URLs:** A.21 (config management patterns, feature flags).

---

### M20 · Auth, RBAC & sessions

**Today.** Strong: cookie sessions with CSRF, scoped `mmm_` tokens, 5-role matrix, lockout, audit
chain, separation of duties. Tested at 30 assertions.

**The gap.** No MFA, no password reset (there is no email path), no invite flow, no session list UI,
no token scopes UI beyond creation.

**Done means.** An Owner can enrol TOTP; a locked-out user can be reset by an Owner (and, if you add
email, self-serve); a user can see and revoke their own sessions.

**Steps**

1. TOTP: `principals.totp_secret_sealed`, `totp_enabled`, 10 single-use recovery codes (hashed).
   Verify with a small RFC 6238 implementation; do not roll your own crypto beyond HMAC.
2. `GET /api/v1/sessions` (own) + `DELETE /api/v1/sessions/:id`; show device, IP, last seen.
3. Password reset: Owner-generated single-use link **or** email if you add Resend/SES; the link must be
   single-use, expiring, and audited.
4. Enforce MFA for `Owner`/`Admin` before production (a config flag, default on in production).

**Test:** enrol → verify with a computed code → wrong code fails 5× → lockout; recovery code works
once and never again.

**URLs:** A.22 — OWASP MFA guidance, RFC 6238, WebAuthn.

---

### M21 · PWA, offline and the service worker

**Today.** Real and careful: versioned cache, no caching of authenticated responses, offline shell
only, cache purge on activate (`npm run test:sw-safety`). This module is **done** — listed so nobody
“improves” it by caching API responses.

**The only remaining work:** bump `CACHE` in `public/sw.js` on each release (documented in the
production roadmap) and verify installability on iOS and Android once.

**URLs:** A.23.

---

### M22 · Agent Browser (autonomous browsing that stops when it should)

**Today.** Implemented and proven. The gateway owns the task; the browser is a replaceable driver.

| Piece | Where | What it does |
| --- | --- | --- |
| Policy & states | `apps/gateway/src/browser/policy.js` | `queued → running → recovering → waiting_for_user / paused` → `completed / failed / blocked / cancelled / timed_out`. Terminal states are final. Refusals are classified (`captcha`, `rate_limit`, `forbidden`, `paywall`, `login`) and a blocked kind has an **empty recovery ladder**. |
| Watchdog | `browser/watchdog.js` | Measures three things: time since the last meaningful change, the age of the in-flight action, and the deadline. “A page that remains open is not evidence of progress.” Aborts via `AbortController`. |
| Loop detection | `browser/loops.js` | Repeated action against the same page state, two-page ping-pong, and repeated identical errors. Real progress resets the detector, so pagination does not trip it. |
| Recovery ladder | `policy.js` (`RECOVERY_LADDER`) | settle → re-inspect → safe refresh → relocate element → alternate interaction → declared alternate source. Each rung is bounded and never repeats for the same obstacle; exhausted ⇒ `waiting_for_user`. |
| Driver contract | `browser/driver.js` | `start/open/goto/waitFor/click/type/extract/snapshot/screenshot/reload/health/close`, every failure a typed `BrowserError`. |
| Real engine | `browser/drivers/puppeteer.js` | Chromium over CDP, 390×844 mobile viewport, optional whole-session proxy. **No stealth, no UA rotation, no CAPTCHA solving, no credential extraction, no access-control bypass.** |
| Test engine | `browser/drivers/simulated.js` | Scripted pages/faults so the resilience rules are provable on any machine. Refused unless `MMM_BROWSER_ALLOW_SIM=1`, and every task it runs is labelled **Simulated** in the API and the UI. |
| Runner | `browser/runner.js` | One action per tick, checkpoint after every successful step, evidence per milestone, criteria-driven completion, `resumeInterrupted()` on boot. |
| Storage | `apps/gateway/migrations/004_browser.sql` | `browser_tasks` (objective, criteria, plan, budgets, deadline, checkpoint, recovery log), `browser_steps` (timeline), `browser_evidence` (digest + capped payload). |
| API | `apps/gateway/server.js` | `GET /api/v1/browser/capabilities`, `GET|POST /api/v1/browser/tasks`, `GET /api/v1/browser/tasks/:id`, `GET …/evidence/:eid`, `POST …/:id/{pause,resume,stop,assist}`, WebSocket topic `browser`. Permissions: `browser:read` (Observer+), `browser:run` (Operator+). |
| Screen | `src/browser.js`, `src/browser.css` | Objective, site, last verified milestone, time since progress, recovery counters, blocker, timeline, evidence viewer (real screenshots), pause/resume/stop/assist. Mobile-first, 44 px targets, no fabricated activity. |

**Acceptance tests (spec AT-15…AT-26)** — `npm run test:browser` (22 checks, scripted driver) and
`npm run test:browser:engine` (7 checks, real Chromium; prints `SKIP` when no engine is installed
rather than passing falsely). Screen: `npm run test:browser-ui` (8 checks).

**The gap.** No engine is bundled, so a stock checkout reports `unconfigured`. There is no task
scheduler across owners, no per-domain allowlist, no download interception, no video/screenshot
annotation, and no cost accounting tied to browser minutes.

**Next steps**

1. Install Chromium on the deployment host and record one real task; only then may the capability
   card move from `unverified` to `available` for that deployment.
2. Add a **domain allowlist** per principal (`browser:run` scoped to hosts) — the honest alternative
   to “undetectable” browsing.
3. Move evidence payloads to object storage when `MMM_BROWSER_EVIDENCE_DIR` exists; keep the digest in
   SQLite.
4. Add downloads: `page.on('download')` into a quarantine folder, hashed, listed in the timeline.

**URLs:** A.24 (Puppeteer), A.25 (CDP), A.26 (robots.txt / terms).

---

### M23 · Self-modification and code evolution (controlled, not a command)

**Today.** Implemented and proven end to end. Every agent is *capable* of self-modification; authority
is held by the gateway, never by the agent's instructions.

| Piece | Where | What it does |
| --- | --- | --- |
| Autonomy model | `evolution/policy.js` | Five levels (recommend → modify+test → auto-stage → bounded deploy → supervised continuous), each a fixed capability set. Default **level 1** for every agent, including new specialists. |
| Protected boundaries | `policy.js` (`PROTECTED_PATHS`, `SENSITIVE_PATHS`) | Permissions, auth, the audit-log layer, the request pipeline, migrations, `package.json`, CI, `.env*`, the shared test harness — recommend-only for an agent. Sensitive but allowed paths can never auto-deploy on a scripted test alone. |
| Path safety | `policy.normalisePath`, `checkWriteScope` | No absolute paths, no traversal, no control characters; every write must match the agent's scope; 40 files / 256 KB each / 4 MB / 3 000 diff lines. |
| Test integrity | `policy.checkTestIntegrity` | A candidate cannot pass by deleting, skipping or weakening the test that catches the defect — findings are blocking. |
| Sandbox | `evolution/sandbox.js` | Rebuilt environment (no secrets, no `DATA_DIR`, no ambient credentials), command allowlist, wall-clock `SIGKILL`, 256 MB heap, 64 KB output cap. Reports honestly: `isolation: 'process'`, with an explicit **not enforced** list. |
| Workspace | `evolution/workspace.js` | Baseline + working copy under `DATA_DIR/experiments/<id>/`; the repository is never modified by the gateway. |
| Cycle | `evolution/runner.js` | Ten stages: observe → diagnose → plan → isolated copy → rewrite → test → peer review → compare → promote → monitor. Every transition records actor, reason and evidence. |
| Review & approval | `runner.review`, `effectiveReviews` | A different agent reviews; self-review and self-approval are refused; a revised verdict supersedes the earlier one instead of accumulating. Approving never deploys. |
| Versions | `workspace.publishVersion/activateVersion` | `DATA_DIR/runtime/<agent>/<version>/files/` + `current.json`; the last known-good version survives the whole experiment; rollback is a pointer move that keeps the audit trail and states what it cannot reverse (migrations, side effects). |
| Health & recovery | `runner.healthCheck` | A failing health check stops promotion and rolls back automatically; every outcome is recorded. |
| Limits | `policy.js`, runner quotas | `maxExperimentsPerDay`, `maxTestRuns`, `maxRuntimeMs` (hard cap 15 min) stop runaway experiments and retry loops with a typed error. |
| Storage | `apps/gateway/migrations/005_evolution.sql` | `evolution_policies`, `evolution_grants`, `evolution_observations`, `evolution_experiments`, `evolution_versions` and the event trail. |
| API | `apps/gateway/server.js` | Capabilities, agents, policy, grants, observations, versions, health, rollback, experiments and 13 named steps. WS topic `evolution`. |
| Screen | `src/evolution.js`, `src/evolution.css` | Agent tabs, policy card with an Owner-only level editor, observations, new experiment, sandbox limits, versions & rollback, experiment list, and a detail view with the ten-stage bar, diagnosis, plan, diff, test output, reviews, comparison **with its limitations**, approval and timeline. Mobile-first, 44 px targets, no fabricated activity. |

**Acceptance tests (spec AC1–AC18)** — `npm run test:evolution` (20 checks; a real gateway on a temporary
`DATA_DIR` and real sandboxed `node` runs against `agents/demo-writer/`, whose suite genuinely fails until
the defect is fixed). Screen: `npm run test:evolution:ui` (10 checks).

**The gap.** The sandbox is process isolation, not a container or microVM; there is no model-driven patch
author (a human or an agent operator supplies the edit and the platform validates it); reproduction is
files + manifest rather than an image digest; there is no cost accounting per experiment, and health
checks are command-based rather than real production probes.

**Next steps**

1. Container/microVM per experiment, then change `isolation` to `container` in `describeSandbox()` — the
   API and the screen follow automatically, because they read that field.
2. Pin the container image digest and lockfile hash in `manifest.json` so AC18 means bit-for-bit.
3. Optional model-driven patch author behind the same ten gates — the gates must not move.
4. Meter sandbox minutes per agent and add a spend ceiling alongside the time ceiling.
5. Real health probes (error rate, latency window) to replace command-only checks.

**URLs:** A.27.

### M24 · Teams, membership and the agent panel

**Today.** Implemented and proven end to end. Membership is a **single fact stored once** — on the agent
row — so the grid, the panel, the designer and the gateway can never disagree about who is on what team.

| Piece | Where | What it does |
| --- | --- | --- |
| Storage | `apps/gateway/migrations/006_team_membership.sql` | Retires `team_members` and adds `agents.team_id` (references `teams(id)`, nullable) + `agents.team_position` (dense, 0 when unassigned). SQLite cannot add `NOT NULL` without a constant default, so the column is added nullable and back-filled in the same migration. |
| Membership model | `apps/gateway/src/teams.js` | `assignAgent` moves the row and renumbers the old and new team; `reorderTeam` refuses a partial order; `deleteTeam` runs one transaction: `UPDATE agents SET team_id = NULL, team_position = 0`, `UPDATE swarms SET team_id = NULL`, `DELETE FROM teams`. Audit event `team.delete` records `agentsDeleted: 0` and the unassigned list. |
| Routes | `apps/gateway/server.js` | `GET/POST/PATCH/DELETE /api/v1/teams`, `POST /teams/:id/order`, `POST/DELETE /teams/:id/members`. Reads need `read`; team mutations need `swarm:write`; membership writes need `agent:write`. Every change broadcasts WS topic `agents`. |
| Agent delete | `server.js` `DELETE /api/v1/agents/:id` | Soft delete: the row is flagged, its team slot is renumbered away, and the response says what happened (`softDeleted`, `unassignedFrom`). A team is never deleted as a side effect. |
| Panel | `src/team-panel.js`, `src/team-panel.css` | Right-hand dock ≥ 900 px, full-height sheet below. Identity, team assignment with an “n of m” position slider, responsibilities, instructions (goal + multiline prompt, never truncated), capabilities, autonomy **with an explicit “orchestration is not implemented” note**, status and four shortcuts. A running agent states that prompt edits apply from the next message. |
| Team menu | `src/team-panel.js`, `src/agents.css` | Left menu with real member counts, the active team panel, a ⋯ menu (view / edit / delete) and a floating **“New agent in <team>”** that hands the team to the designer as a visible, editable suggestion (`suggestTeam()`), applied only on save. |
| Grid | `src/views1.js`, `src/agents.css` | 1 / 2 / 3 columns (min-width 560 / 900). Card = avatar, name, role, team, lifecycle pill, capability chips, X delete. Inline edit covers name, role and team with an explicit Save; a failed write leaves the card untouched. |
| Shortcuts | `src/team-panel.js`, `src/views2.js` | Skills (opens the Skills Hub filtered to that agent), Tools and MCP (existing settings screen), Chat (selects the agent, enabled only when it is running), and the team menu. |

**Acceptance tests.** `npm run test:teams` — 12 checks against a real gateway on a temporary `DATA_DIR`,
including the verbatim case *“deleting a team unassigns members instead of deleting them”*.
`npm run test:teams:ui` — 23 checks over the rendered panel and grid in happy-dom.
`npm run test:teams:browser` — 6 checks in a real Chromium: full-height sheet at 390 px, no horizontal
overflow at 320 px, a 900 px docked panel with a 260 px menu at 1280 px, the grid reflowing 1/2/3, and the
screen values matching the session state. Needs `npm i --no-save puppeteer-core @sparticuz/chromium`.

**The gap.** Position is a stored integer, not a scheduling or routing input — nothing dispatches work by
it yet. There is no per-team budget, no nested teams, and no history of membership changes beyond the audit
trail. Deleting a team is irreversible from the UI (the audit entry is the record).

**Next steps**

1. Read `team_position` when dispatching a task, so the order means something operationally.
2. Per-team spend ceilings, sitting inside the existing budget gate rather than beside it.
3. A membership history view built from the audit trail that already records every move.

**URLs:** A.28.

---

## 6. Master implementation checklist

Tick a box only when its **evidence** exists (test output, SQL row, recorded call). Order matters
within each module; modules can interleave except where marked `⛓` (blocked by another module).

### M01 · Agents
- [ ] `agent_runs` table + `npm run migrate` idempotent
- [ ] `GET /api/v1/agents/:id/runs`, `POST /api/v1/agents/:id/run`
- [ ] 409 with a reason when no provider key exists (no run row created)
- [ ] Worker leases a run, calls the model, writes tokens/cost/error
- [ ] `recomputeAgentStats()` is the only writer of `runs`/`success_rate`/`cost_today`/`last_active`
- [ ] `status` transitions are caused by runs, never by seeds
- [ ] Seed writes zeros/`idle`, not fictional history
- [ ] UI: “— until first run”; Run disabled with reason; live elapsed from `started_at`
- [ ] `scripts/agent-runs-test.mjs` in `npm test`

### M02 · Designer
- [ ] Shared `agent-schema.js` used by client **and** gateway
- [ ] Field-level 400 errors rendered verbatim
- [ ] `agent_versions` + activate route (`agent:write`, audited)
- [ ] Draft vs active badge; rollback works

### M03 · Teams
- [ ] `GET/POST/PATCH /api/v1/teams`, `PUT /api/v1/teams/:id/members`
- [ ] Topology enum validated; unknown agent id → 400
- [ ] `teams` slice moved to `GATEWAY_SLICES`
- [ ] Delete a team leaves no orphan members

### M04 · Swarms ⛓ (needs M03 for teams, M06 for budget gates, M09 for executed nodes)
- [ ] `GET/POST /api/v1/swarms` + pause/resume/cancel
- [ ] Estimate computed from `model_prices`, or “unavailable”
- [ ] `progress = done nodes / total nodes`, server-side only
- [ ] **`tick()`, `toggle-sim`, `settings.simulate` deleted**
- [ ] WS `swarms` topic drives every open client
- [ ] Stalled/failed states visible; no frozen 97 %
- [ ] Two-browser test recorded

### M05 · Tasks
- [ ] Dependencies, position, soft delete persist
- [ ] Move into `done` refused while a blocker is open (409 + blocker id)

### M06 · Approvals
- [ ] `approval_policies` table + `gateRequired()` helper
- [ ] Consequential actions return `202` + gate id instead of acting
- [ ] Swarm deploy above cap, key change, privileged plugin install, role change all gated
- [ ] Settings shows real templates from the table

### M07 · Skills ⛓ (M01 for invocation, M08 for tools)
- [ ] `GET/POST /api/v1/skills`, activate/deactivate (audited)
- [ ] Server-side validation shared with the browser
- [ ] L1/L2/L3 level chosen and labelled in the UI
- [ ] `invokes` counted from real invocations
- [ ] Matrix persists server-side

### M08 · Plugins / MCP
- [ ] `plugin_servers` table; credentials sealed with the comms vault
- [ ] `apps/gateway/src/mcp.js`: initialize → tools/list → tools/call, timeouts, output caps
- [ ] Install = connect + list tools; failure is 502 with the server's error
- [ ] Every call: allowlist check, `calls_today` increment, audit with args **hash**
- [ ] Dangerous tools go through a gate
- [ ] Copy updated or `callsToday` removed until true

### M09 · Models ⛓ (blocks M01 execution, M10, M11, M12)
- [ ] One provider adapter with pure `buildRequest`/`parse`
- [ ] Key sealed server-side; never returned; never `VITE_*`
- [ ] `modelCall()` funnel: budget → call → usage → audit
- [ ] Budget enforcement **before** the network call
- [ ] Streaming with abort-on-disconnect
- [ ] `model_prices` as data with `effective_from`
- [ ] `llm` capability flipped only with a recorded call
- [ ] `grep -r "sk-" dist/` empty

### M10 · Chat
- [ ] Threads/messages routes (+ idempotent `clientId`)
- [ ] `simulateReply()` and call sites deleted
- [ ] `runtime: 'none'` message rendered as a notice
- [ ] Model replies persist with model id, tokens, cost

### M11 · Copilot
- [ ] `POST /api/v1/copilot/messages` persists turns
- [ ] Actions call real routes; last step reflects the HTTP result
- [ ] Blocked actions end `blocked` with the server's reason

### M12 · Analytics
- [ ] `usage_events` ledger (M09)
- [ ] `GET /api/v1/analytics/series/:metric` with an allowlist
- [ ] Every literal removed; `not tracked` where unknown
- [ ] Export generated from the same query

### M13 · Files
- [ ] `GET/POST /api/v1/files`, content download, soft delete
- [ ] Type allowlist, size cap, server-computed size + sha256
- [ ] Ownership scoping (404, not 403)
- [ ] Storage bar from `SUM(size)`

### M14 · Terminal
- [ ] Retitled; reads call the API; writes explained, not faked
- [ ] `help` generated from the command table
- [ ] `reset-demo` removed

### M15 · Comms / Telegram ⛓ (M09 optional; independent otherwise)
- [ ] Telegram screen rebuilt on `PUT/POST/GET /api/v1/comms/telegram*`
- [ ] `tg-link`/`tg-test`/`tg-cmd` local handlers deleted
- [ ] One live provider round-trip recorded (provider message id)
- [ ] Capability per channel, not per module
- [ ] Command list documented as webhook grammar

### M16 · Voice
- [ ] Capability measured at runtime, not hardcoded
- [ ] Local engine optional and loopback-only
- [ ] Fake test engine excluded from production builds

### M17–M18 · Training / Local AI
- [ ] Either a real job → artefact → eval, or `blocked` with a reason (no third option)
- [ ] Local AI phases 3–6 only with real-device measurements

### M19 · Settings
- [ ] Settings table + API; every control changes behaviour or is removed
- [ ] Trust computed from real signals, formula published
- [ ] Notifications bound to real channels
- [ ] Retention enforced by a job
- [ ] Static security claims replaced by computed values
- [ ] “Reset demo data” replaced by an Owner-only audited reset

### M20 · Auth
- [ ] TOTP enrolment + recovery codes, enforced for Owner/Admin in production
- [ ] Session list + revoke
- [ ] Owner-driven password reset (single-use, expiring, audited)

### M21 · PWA
- [ ] Cache version bumped per release
- [ ] Installability verified on iOS + Android

### M22 · Agent Browser
- [x] Watchdog, deadline, action/evidence budgets, cancellation
- [x] Loop detection (repeated action, page cycle, repeated error)
- [x] Bounded recovery ladder; refusal ⇒ BLOCKED, login ⇒ WAITING_FOR_USER
- [x] Checkpoints + `resumeInterrupted()` that inspects the page first
- [x] Evidence row per milestone, with digest and capped payload
- [x] Completion only when every success criterion is verified
- [x] Mobile-first screen with pause/resume/stop/assist and evidence viewer
- [ ] Chromium installed on the deployment host + one recorded real task
- [ ] Per-principal domain allowlist
- [ ] Evidence moved to object storage
- [ ] Downloads captured, hashed and listed

### M23 · Self-modification
- [x] Five-level autonomy model, default level 1 for every agent and every new specialist
- [x] Protected boundaries: the safeguards, auth, RBAC, audit layer, migrations, CI, secrets
- [x] Isolated workspace; the repository is never modified by the gateway
- [x] Sandbox with rebuilt environment, command allowlist, timeout, heap and output caps
- [x] Test-integrity check that blocks deleting, skipping or weakening the failing test
- [x] Ten-stage cycle with a recorded reason and actor at every transition
- [x] Independent review, refusal of self-review and self-approval, superseding verdicts
- [x] Versioned promotion with rollback and preserved audit; irreversible changes flagged
- [x] Health check that stops promotion and rolls back automatically
- [x] Quotas that stop runaway experiments and retry loops
- [x] Mobile-first screen that reports the real status and the limits of the evidence
- [ ] Container or microVM isolation (today: process; the API says so)
- [ ] Container image digest + lockfile hash in the manifest for exact reproduction
- [ ] Model-driven patch author behind the existing gates
- [ ] Sandbox spend metering and a cost ceiling
- [ ] Real production health probes

### M24 · Teams and the agent panel
- [x] Membership stored once, on `agents.team_id`, with a dense `agents.team_position`
- [x] Gateway routes for create / rename / delete / add / remove / reorder, with RBAC and audit
- [x] Deleting a team unassigns members (teamId → null), deletes no agent and says so in the confirmation
- [x] Panel: full-height sheet on a phone, 900 px dock above it; every required section rendered
- [x] Position slider labelled “n of m”; releasing it writes the new order explicitly
- [x] Responsibilities and suggestion drafts that are only applied when their own button is tapped
- [x] Instructions shown in full, with the next-message note for a running agent
- [x] Autonomy section that states orchestration is not implemented
- [x] Four shortcuts; Chat enabled only for an active agent
- [x] Agent grid at 1 / 2 / 3 columns with inline name, role and team editing behind an explicit Save
- [x] Failed write leaves the card unchanged; X delete lists the real consequences
- [ ] Position drives dispatch
- [ ] Per-team budget ceilings
- [ ] Membership history surface

---

## 7. TODO — the next twelve sessions

One session ≈ one sitting. Each is independently shippable.

| # | Session | Ships | Proves |
| --- | --- | --- | --- |
| 1 | **Stop the lies that cost nothing** | Delete the three static security claims; Models page says “catalogue · not configured”; Plugins copy says “no MCP client”; remove `callsToday` | `npm test`; screenshots |
| 2 | **Kill the ticker** | Remove `tick()`, `toggle-sim`, `settings.simulate`; swarm progress renders from the local row only, labelled `not executed` | `rg "Math.random" src/main.js` empty |
| 3 | **Swarms: read path** | `swarms` table → routes → slice → WS → real list | new `test:swarms` |
| 4 | **Swarms: write path** | Deploy persists; pause/resume/cancel; delete the `$6.40` literal | two-browser test |
| 5 | **Teams** | Teams CRUD + membership; swarms reads the team | `test:teams` |
| 6 | **Chat persists** | threads/messages routes; delete `simulateReply`; `runtime: 'none'` notice | persistence test |
| 7 | **Provider key + one real call** | Seal a key, one adapter, `modelCall()`, `usage_events` | recorded call + `dist/` grep |
| 8 | **Metering + budgets** | Daily cap enforced pre-call; Models page shows real spend | budget refusal test |
| 9 | **Agents run** | `agent_runs` + worker + recomputed stats + honest seed | `test:agent-runs` |
| 10 | **Telegram Bridge on the real transport** | Screen rebuilt on comms routes; one live message | provider message id |
| 11 | **Analytics + export** | Ledger aggregates, literals gone, CSV from the query | tile = SQL |
| 12 | **Files** | Upload/download/checksum/quota | hash round-trip |

After session 12 the app has no simulated *data* left; what remains (skills execution, MCP, training,
local AI) is genuinely `blocked`/`unconfigured` and labelled as such — which is a finished state, not
an unfinished one.

---

## 8. Definition of done, and the traps

### 8.1 A module is done when all seven are true

1. **Served** — the data comes from a route, not from `localStorage`.
2. **Provenanced** — `src/datastore.js` marks the slice `gateway`; the chip says `live gateway`.
3. **Computed** — every number on screen traces to a row (a `SELECT` you can paste).
4. **Bounded** — every input validated server-side; every list paginated or capped.
5. **Audited** — every mutation writes an `audit_log` row with the actor and the target.
6. **Tested** — a `scripts/*-test.mjs` fails if the behaviour regresses; it is in `npm test`.
7. **Honest** — the empty, error, offline and unconfigured states each say what is true.

### 8.2 Traps specific to this codebase

| Trap | What happens | Do instead |
| --- | --- | --- |
| Calling `fetch()` from a view | No CSRF, no timeout, no stale-session guard | `src/api.js` → `request()` |
| Writing state optimistically and skipping the response | UI drifts from the server; reload “fixes” it | Adopt the server's response, then re-render |
| Adding a slice to `GATEWAY_SLICES` before the route exists | The screen empties and the chip says live — a *new* lie | Route first, then the slice |
| Letting the client compute progress/aggregates | Two clients disagree | Compute in SQL, send the number |
| Storing money as a float | Cents drift | Integer micro-units |
| Rendering `—` as `0` | “Zero spend” reads as a fact | `—` / `not tracked` |
| “Just a small mock for now” in `src/` | It ships | Mocks live in `scripts/` only |
| Editing an applied migration | Production DB disagrees with the repo | New migration file |
| Deleting the provenance chip to “look finished” | The only regression signal is gone | Keep it; it should read `live gateway` |
| Marking a capability `available` after a mock test | It is a lie with a green tick | Only after a real call, with the id recorded |

---

## Appendix A — URLs you will actually need

### A.1 Model providers
- OpenAI API reference — https://platform.openai.com/docs/api-reference
- OpenAI pricing — https://openai.com/api/pricing/
- Anthropic API — https://docs.anthropic.com/en/api/getting-started
- Anthropic pricing — https://www.anthropic.com/pricing
- Google Gemini API — https://ai.google.dev/gemini-api/docs
- Mistral — https://docs.mistral.ai/
- Groq (fast inference) — https://console.groq.com/docs
- DeepSeek — https://api-docs.deepseek.com/
- OpenRouter (one key, many models) — https://openrouter.ai/docs
- Ollama (local models via HTTP) — https://github.com/ollama/ollama/blob/main/docs/api.md
- Token counting / pricing tables to keep your `model_prices` honest — each provider's pricing page above

### A.2 MCP and the six “not installed” integrations
- Model Context Protocol — https://modelcontextprotocol.io/docs/getting-started/intro
- MCP specification — https://modelcontextprotocol.io/specification
- Reference servers (GitHub, filesystem, fetch, …) — https://github.com/modelcontextprotocol/servers
- MCP security best practices — https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices
- GitHub REST API — https://docs.github.com/en/rest
- GitHub MCP server — https://github.com/github/github-mcp-server
- Supabase API — https://supabase.com/docs/guides/api
- Supabase MCP — https://supabase.com/docs/guides/getting-started/mcp
- Firecrawl API (scrape/map/crawl) — https://docs.firecrawl.dev/
- Vercel API — https://vercel.com/docs/rest-api
- Airtable Web API — https://airtable.com/developers/web/api/introduction
- Base44 — https://base44.com/ (check current developer docs before integrating)

### A.3 Messaging and bots
- Telegram Bot API — https://core.telegram.org/bots/api
- Telegram `setWebhook` — https://core.telegram.org/bots/api#setwebhook
- WhatsApp Cloud API — https://developers.facebook.com/docs/whatsapp/cloud-api
- Slack API — https://api.slack.com/
- Slack Bolt (JS) — https://slack.dev/bolt-js/
- Discord developer docs — https://discord.com/developers/docs/intro
- Twilio messaging — https://www.twilio.com/docs/messaging
- OpenSMS (self-hosted SMS) — https://github.com/daslearning-org/OpenSMS
- Resend (email, for password reset) — https://resend.com/docs

### A.4 Agent frameworks and topologies
- LangGraph — https://langchain-ai.github.io/langgraph/
- CrewAI — https://docs.crewai.com/
- OpenAI Agents SDK — https://openai.github.io/openai-agents-python/
- Anthropic tool-use patterns — https://docs.anthropic.com/en/docs/build-with-claude/tool-use
- Multi-agent topology patterns (this repo's own spec) — [`docs/DESIGN_SPEC.md`](DESIGN_SPEC.md)

### A.5 Speech
- Web Speech API (`speechSynthesis`) — https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis
- Web Speech recognition — https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition
- Kokoro-FastAPI (local TTS server) — https://github.com/remsky/Kokoro-FastAPI
- Kokoro model — https://huggingface.co/hexgrad/Kokoro-82M
- Piper (local TTS) — https://github.com/rhasspy/piper
- whisper.cpp (local STT) — https://github.com/ggml-org/whisper.cpp
- OpenVoice (cloning) — https://github.com/myshell-ai/OpenVoice
- NeuTTS (on-device TTS) — https://github.com/neuphonic/neutts

### A.6 Training, evals, prompt quality
- promptfoo — https://www.promptfoo.dev/docs/intro/
- OpenAI evals — https://github.com/openai/evals
- LangSmith (tracing + evals) — https://docs.smith.langchain.com/
- Ragas (RAG evaluation) — https://docs.ragas.io/

### A.7 Local / on-device AI
- wllama — https://github.com/ngxson/wllama
- llama.cpp — https://github.com/ggml-org/llama.cpp
- Origin Private File System — https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system
- WebGPU — https://developer.chrome.com/docs/web-platform/webgpu
- Cross-origin isolation (required for SharedArrayBuffer) — https://web.dev/articles/coop-coep

### A.8 Sandboxed execution
- e2b (code sandboxes) — https://e2b.dev/docs
- Daytona — https://www.daytona.io/docs/

### A.9 This repository's own specifications
- Design spec — [`docs/DESIGN_SPEC.md`](DESIGN_SPEC.md)
- Copilot governance & auth — [`docs/copilot/copilot-governance-auth.md`](copilot/copilot-governance-auth.md)
- Comms channels (adapter contract) — [`docs/comms/channels.md`](comms/channels.md)
- Comms server-side (vault, queue, webhooks) — [`docs/comms/server-side.md`](comms/server-side.md)
- Kanban board (one write seam) — [`docs/kanban/board.md`](kanban/board.md)
- Voice studio — [`docs/voice/VOICE_STUDIO.md`](voice/VOICE_STUDIO.md)
- Local AI audit and spike — [`docs/local/on-device-audit.md`](local/on-device-audit.md)

### A.10 Durable jobs and queues
- SQLite as a queue (leased rows) — https://www.sqlite.org/lang_transaction.html
- Temporal (durable workflows) — https://docs.temporal.io/
- BullMQ — https://docs.bullmq.io/
- pg-boss (Postgres queues, if you migrate) — https://github.com/timgit/pg-boss

### A.11 Ordering and pagination
- Fractional indexing for card order — https://www.figma.com/blog/realtime-editing-of-ordered-sequences/
- Cursor pagination — https://www.sqlite.org/optoverview.html (and your own `events` cursor, already
  implemented in `server.js`)

### A.12 Approvals and policy
- NIST SP 800-53 (access control family) — https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final
- Two-person rule / separation of duties — https://csrc.nist.gov/glossary/term/separation_of_duties

### A.13 Skills packaging
- Anthropic Agent Skills — https://docs.anthropic.com/en/docs/build-with-claude/agent-skills
- MCP tools as the execution substrate — https://modelcontextprotocol.io/docs/learn/architecture

### A.14 Streaming to a browser
- Server-sent events — https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
- `ReadableStream` — https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream
- AbortController — https://developer.mozilla.org/en-US/docs/Web/API/AbortController

### A.15 Tool calling and structured output
- OpenAI function calling — https://platform.openai.com/docs/guides/function-calling
- Anthropic tool use — https://docs.anthropic.com/en/docs/build-with-claude/tool-use
- JSON Schema — https://json-schema.org/learn/getting-started-step-by-step

### A.16 SQL you will write
- SQLite aggregate functions — https://www.sqlite.org/lang_aggfunc.html
- SQLite date/time functions — https://www.sqlite.org/lang_datefunc.html
- SQLite expressions (`status='done'` is 1/0) — https://www.sqlite.org/lang_expr.html
- `EXPLAIN QUERY PLAN` — https://www.sqlite.org/eqp.html

### A.17 Charts (replacing the sparkline)
- Chart.js — https://www.chartjs.org/docs/latest/
- uPlot (small, fast) — https://github.com/leeoniya/uPlot
- Observable Plot — https://observablehq.com/plot/

### A.18 Files, content types, checksums
- MDN MIME types — https://developer.mozilla.org/en-US/docs/Web/HTTP/Basics_of_HTTP/MIME_types
- `crypto.subtle.digest` — https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest
- Content-Disposition — https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Disposition

### A.19 Object storage (when local disk is not enough)
- Cloudflare R2 — https://developers.cloudflare.com/r2/
- AWS S3 presigned URLs — https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html
- MinIO (self-hosted) — https://min.io/docs/minio/linux/index.html

### A.20 Terminal-style UI
- xterm.js — https://xtermjs.org/
- ANSI escape codes — https://en.wikipedia.org/wiki/ANSI_escape_code

### A.21 Configuration and flags
- 12-factor config — https://12factor.net/config
- Feature flags, done simply (OpenFeature) — https://openfeature.dev/docs/reference/intro

### A.22 Authentication extensions
- OWASP MFA guidance — https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html
- RFC 6238 (TOTP) — https://datatracker.ietf.org/doc/html/rfc6238
- WebAuthn guide — https://webauthn.guide/
- SimpleWebAuthn — https://simplewebauthn.dev/

### A.23 PWA
- MDN PWA — https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps
- web.dev Learn PWA — https://web.dev/learn/pwa
- Service worker lifecycle — https://web.dev/articles/service-worker-lifecycle

### A.24 Browser automation (the engine)
- Puppeteer — what it is, and its licence — https://pptr.dev/guides/what-is-puppeteer
- Puppeteer API reference — https://pptr.dev/api
- Chrome DevTools Protocol — https://chromedevtools.github.io/devtools-protocol/
- Playwright (an alternative engine with the same driver contract) — https://playwright.dev/docs/intro

### A.25 Honest automation (what this module will not do)
- `robots.txt` — https://www.rfc-editor.org/rfc/rfc9309.html
- MDN `navigator.webdriver` (why hiding it is a losing game) — https://developer.mozilla.org/en-US/docs/Web/API/Navigator/webdriver
- OWASP automated threats to web applications — https://owasp.org/www-project-automated-threats-to-web-applications/

### A.26 Resilience primitives used by the runner
- MDN `AbortController` — https://developer.mozilla.org/en-US/docs/Web/API/AbortController
- Node timers, `unref()` and why the ticker must not hold the process open — https://nodejs.org/api/timers.html

### A.27 Sandboxing, isolation and supply-chain honesty
- Node.js child process API (`spawn`, `detached`, signal handling) — https://nodejs.org/api/child_process.html
- Node.js `--max-old-space-size` and memory limits — https://nodejs.org/api/cli.html#--max-old-space-sizememorylimit
- OWASP Top 10 for LLM applications (prompt injection, excessive agency) — https://owasp.org/www-project-top-10-for-large-language-model-applications/
- SLSA supply-chain levels (why an image digest matters for reproduction) — https://slsa.dev/spec/v1.0/levels
- Git `diff` format (`--unified`) — https://git-scm.com/docs/git-diff
- NIST SP 800-218 secure software development framework — https://csrc.nist.gov/pubs/sp/800/218/final

> Deployment, CI, backups, TLS, metrics, alerts and the rest of the operational stack are **not**
> repeated here — they are in [`PRODUCTION_ROADMAP.md` Appendix A](PRODUCTION_ROADMAP.md).

---

### A.28 Team membership: the decision record

No external service is required for any of this; the appendix exists so the next session does not
re-litigate a decision that cost a bug to learn.

| Question | Answer | Where |
| --- | --- | --- |
| Why not a `team_members` join table? | It allows two rows to disagree with the agent itself, and its `ON DELETE CASCADE` silently deletes membership when a team goes away — the exact shortcut this module forbids. One nullable column on `agents` makes “who is on what team” a single fact with no reconciliation step. | `006_team_membership.sql`, `src/teams.js` |
| Why a dense integer position? | Reindexing on every move keeps the value meaningful (1…n, no gaps) and makes a partial reorder detectable: `reorderTeam` rejects an order that omits a member rather than guessing. | `src/teams.js` `reorderTeam` |
| Why is the delete a transaction? | Three tables change together — agents, swarms and teams. A half-applied delete would either orphan membership or leave a team with no row. The audit event is written inside it, so there is no state without a record. | `src/teams.js` `deleteTeam` |
| Why does the panel show the agent row rather than its own copy? | The panel, grid and designer all read the same slice; the WS `agents` broadcast invalidates it after every write. Nothing caches a second source of truth. | `src/core.js`, `src/datastore.js` |
| What is honestly missing? | Position is not used for dispatch, teams have no budget, and there is no membership history screen — only the audit trail. | M24 “The gap” |

## Appendix B — Beginner reference

### B.1 Glossary specific to this repo

| Term | Meaning here |
| --- | --- |
| **Slice** | One collection in app state (`agents`, `tasks`, `swarms`, …) |
| **Provenance** | Where a slice's rows came from: `gateway` or `demo` |
| **Gateway** | The Node server in `apps/gateway/` — the only component allowed to decide truth |
| **Capability** | A product feature with a verified status (`available`/`unverified`/`demo`/`unconfigured`/`blocked`) |
| **Gate** | An approval that must be granted before a consequential action |
| **Lease** | A time-limited claim on a job row, so two workers cannot run it |
| **Sealed** | Encrypted at rest with the gateway's AES-256-GCM key; only ciphertext is stored |
| **Masked** | Returned to the browser as `••••1234`, never in full |
| **Audit chain** | Hash-linked append-only log; `npm run audit:verify` proves nobody edited history |

### B.2 Commands

```bash
npm ci --ignore-scripts          # install without native builds (better-sqlite3 fallback)
npm run migrate                  # apply migrations (idempotent)
npm run dev                      # app on :5173, proxies /api to :8787
npm run dev:gateway              # gateway on :8787
npm test                         # unit + contract suite
npm run build                    # production build
npm run test:gateway             # RBAC/CSRF/audit against a throwaway DB
npm run audit:verify             # hash-chain check
```

### B.3 Errors you will hit, and what they mean

| Symptom | Cause | Fix |
| --- | --- | --- |
| `403 CSRF check failed` | Cookie session, mutating request, no `x-mmm-csrf` | Use `api.*` from `src/api.js`; it sends the header |
| `401` + UI flips to “Not signed in” | Session expired or cookie dropped by a cross-origin setup | Same origin via the dev proxy or a reverse proxy — not `SameSite=None` |
| Screen empty after adding a slice | Slice moved to `GATEWAY_SLICES` before the route existed | Add the route first |
| `no such table` in a test | Migration not run in the throwaway `DATA_DIR` | `createGateway()` runs migrations; check `process.env.DATA_DIR` is set **before** import |
| `better-sqlite3` build failure | No toolchain | `npm install --ignore-scripts`, or install `python3 make g++` |
| `SQLite is an experimental feature` | `node:sqlite` fallback | Harmless warning; install build tools for the stable driver |
| Browser suite fails with `libnss3.so` | Missing Chromium system libs | Install the distro Chromium deps, or extract them from `@sparticuz/chromium` and set `LD_LIBRARY_PATH` |
| A number changes on reload | Client-side computation | Move the computation into SQL |

### B.4 The five-minute review every PR needs

1. Does anything on screen claim more than the code does?
2. Is every new number traceable to a `SELECT`?
3. Is every new route permission-checked, audited and broadcasting?
4. Would a test fail if this regressed?
5. Did the docs change in the same commit?

---

*Keep this document honest too. When a module ships, tick it in §6 and add the evidence to
[`PRODUCTION_ROADMAP.md` §8.2](PRODUCTION_ROADMAP.md). When you discover a new lie, add it to §2 with
its file reference — a roadmap that quietly goes out of date is just another demo.*
