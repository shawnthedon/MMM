# Copilot — Phase A: Application Operation Inventory

| Field | Value |
| --- | --- |
| Request | MMM Copilot — **Phase A only**: Application Operation Inventory (discovery, no implementation) |
| Spec inputs | `MMM-Copilot-Full-Application-Operator-Extension-2026-11-02.md` (§5 registry, §5.2 coverage matrix, §6 orchestration, §7 permissions, §12 Phase A exit) · `Dynamic Feature Awareness and Roadmap Intelligence.plain.md` · `MMM-Copilot-Design-Spec-2026-11-01.md` (read selectively) |
| Repository | `shawnthedon/MMM` |
| Branch / baseline | `arena/c7550742-mmm` @ `13d3db4` (merge of PR #49, M36 terminal) |
| Date | 2026-11-02 |
| Scope | Read-only inspection. No capability registry, dispatcher, wiring, UI change, behaviour change or Phase B work was performed. |
| Status | **Phase A complete. Awaiting approval before Phase B.** |

## How to read this document

Every statement is **verified** against the code or a command in this checkout, and cites
`file:line` or a command result. Two exceptions are always marked inline:

- **⚠ UNVERIFIED** — code path exists but could not be exercised in this environment.
- **ASSUMPTION** — an inference from reading code, not observed behaviour.

Nothing in this document is marked *available* because a document, a prompt or a roadmap entry says
so. Where the specs and the code disagree, the code is reported and the disagreement is listed in
§1.3 and §10.

Numbers used throughout (measured, not estimated):

| Measure | Value | How measured |
| --- | --- | --- |
| Gateway HTTP routes | **154**, in 25 path groups | extracted from `route(...)` table, `apps/gateway/server.js:171` |
| Gateway permissions | **43** declared; 40 attached to route metadata + `public` | `node -e` import of `apps/gateway/src/rbac.js` |
| Role grants | Observer 13 · Reviewer 19 · Operator 26 · Admin 36 · Owner 43 | same |
| WS topics | **12** accepted + `*` | `apps/gateway/server.js:2303` |
| Tables | **43** domain tables + `schema_migrations`, over 15 migrations | `grep CREATE TABLE apps/gateway/migrations/*.sql` |
| Client code | 23,570 lines (`src/*.js`, `src/copilot/*.js`, `src/voice/*.js`) | `wc -l` |
| Gateway code | 11,267 lines | `wc -l` |
| Test code | 20,546 lines, 68 `test:*` scripts (79 npm scripts total) | `wc -l`; `package.json` |
| Default test run | `npm test` = **49 suites**, 841 `PASS` lines, **exit 0** | run this session |
| Excluded from `npm test` | **19** of 21 `*:browser` suites (they launch Chromium; puppeteer is not installed here) | `package.json` + `ls node_modules` |
| Gateway-backed client slices | **8** (agents, tasks, approvals, events, teams, threads, swarms, providers) | `src/datastore.js:19` |
| Copilot capability entries | **10**; 9 statuses hard-coded, **1** dynamic (`llm`) | `src/copilot/capabilities.js` |
| Knowledge-pack entries | **33**; pinned to `repo:66b1bd3`, built 2026-10-26 | `src/copilot/knowledge.js:14` |

---

# 1. Executive summary

## 1.1 The shape of the application today

MMM is **two applications sharing one repository and one data model**:

1. **A self-hosted gateway** (`apps/gateway/`, 154 routes, Node HTTP + `ws` + SQLite, 43 domain tables,
   cookie sessions + CSRF + scoped tokens + RBAC + hash-chained audit). Its work surfaces are real:
   agents and drafts, teams, tasks, approvals, swarm *plans*, the model gateway with a metered ledger,
   chat transcripts, the Agent Browser (Puppeteer), the terminal (real child processes), self-modification
   (sandbox + review + versioned promotion) and comms delivery.
2. **A mobile-first PWA** (`src/`, 23.6k lines) that is a genuine client for **8 slices** of that
   gateway (`src/datastore.js:19`) and, for everything else, a **seeded demo** with its own
   localStorage store (`core.js`, key `mmm-state-v1`).

The seam between them is disciplined and is the single most important fact for Phase B:
**every REST call in the client goes through one module, `src/api.js` (106 distinct paths)**, and the
data layer already stamps per-slice provenance (`demo` / `gateway` / `degraded`) and refuses to let demo
fixtures masquerade as live rows (`src/datastore.js:19,291,308`). There is no ad-hoc `fetch` scattered
through views. A dispatcher therefore has exactly one transport to wrap.

## 1.2 What Copilot is today — and the finding that matters most for Phase B

There are **two Copilot implementations with different authority semantics**, and they disagree:

| | Client Copilot (`src/copilot/*`, 5,797 lines) | Gateway Copilot (`apps/gateway/src/copilot.js`, 26 routes) |
| --- | --- | --- |
| Engine | Deterministic; **no model** is called. Keyword intents + 33-entry knowledge pack + live app state | Real model call through the sealed-key model gateway; refused when unconfigured |
| Interface | 7 modes (Ask, Operate, Build, Knowledge, Training, Voice, Activity) — `src/copilot/orchestrator.js:21-29` | One plain chat; the model is told which screen you are on — `apps/gateway/src/copilot.js:331` |
| Actions | **Operate mode executes the 18 commands it advertises** through a proposal → confirm → execute contract with per-action permission checks, rollback text, verify hints and an episodic memory (`orchestrator.js:1048`) | **None.** A single completion with no tools, no function calling, no action channel — `models.callModel` accepts no `tools`/`tool_choice` (`apps/gateway/src/models.js:291`) |
| "Create agent" | Writes a **real agent** via `POST /api/v1/agents` (`agent:write`) — `orchestrator.js:424` | Produces a **draft** that a *different* principal must approve before an idle definition is stored (`apps/gateway/src/agentDrafts.js:4`) |
| "Deploy swarm" | Writes **browser-only state** and reports "Persist on gateway: blocked — POST /swarms/:id/deploy is still planned" (`orchestrator.js:541-565`), even when signed in | Produces a plan **draft** with approval (`apps/gateway/src/swarmPlanDrafts.js`) |
| Honesty model | Per-message provenance + capability registry + blocked-mode list | A 40-line system prompt listing what is true in this build (`apps/gateway/src/copilot.js:76-115`) |

Consequences, all verified:

- **The capability registry the Operator Extension asks for already half-exists — but in the wrong
  place and in the wrong shape.** `src/copilot/capabilities.js` holds 10 capabilities with
  id/label/summary/detail/requirements/evidence, keyed to the client. It has no input/output schemas, no
  risk class, no permission field, no handler reference, no timeout/retry policy, no idempotency, and is
  not queryable by the gateway. **9 of its 10 statuses are literal strings**; only `llm` derives its
  status at read time (`capabilities.js:312`). It therefore cannot satisfy Operator §5 ("derive from
  actual services and runtime contracts") and will drift silently.
- **The action dispatcher also half-exists** — as `orchestrator.js` proposal objects. They already carry
  what Operator §6.2 demands (capability-ish id, params, editable set, risk, permissions, effects,
  rollback, confirm label, execute) but there is no schema validation, no idempotency key, no
  trace/correlation id, no timeout/retry, no server-side re-validation of the *plan*, and the whole thing
  is client-side and model-free.
- **The gateway has the best-governed action pattern in the repo and Copilot does not use it.** The three
  draft pipelines (`agent_drafts`, `swarm_plan_drafts`, `browser_script_drafts`) implement
  create → validate → submit → *different* principal's approval → activate → audit, with ownership
  checks, state machines and stored findings (`apps/gateway/src/agentDrafts.js:76-218`). This is the
  natural template for Phase B — and note it is *stricter* than what the client Copilot does for the same
  intent.
- **The model-driven Copilot cannot act at all.** For Phase C this is the hard blocker: `callModel` has no
  tool/function channel, and no server-side operation registry exists for a model proposal to be
  validated against.
- **The knowledge pack is stale by construction.** `PACK.version = 'repo:66b1bd3'`, built 2026-10-26
  (`knowledge.js:13-17`), while this checkout is `13d3db4` (2026-11-02). Its `app.overview` entry — the
  one marked `status: 'verified'` — says *"Today the PWA renders seeded demo state from the browser; the
  gateway exists but the front end does not call it yet"* (`knowledge.js`, `app.overview`). That is false
  today for 8 slices. No test pins or refreshes the pack version (grep of `scripts/*.mjs`).

## 1.3 Spec overlaps and contradictions (reported, not resolved)

| # | Conflict | Spec side | Code side | Where |
| --- | --- | --- | --- | --- |
| S1 | **Registry ownership** | Operator §5: registry "derived from actual services and runtime contracts", "queryable at runtime" | Client-side static table; the gateway has no registry route (`/capabilities` → 404) | `src/copilot/capabilities.js` vs probe |
| S2 | **Approval semantics** | Operator §7.3 "meaningful approval": bound to action + parameters, expiring, replay-protected | `approvals` rows are free-form (`action`, `target`, `risk`, `evidence`); only `terminal.run` has an execution hook; no expiry, no parameter hash, no idempotency | `apps/gateway/server.js:1761-1803` |
| S3 | **Who may act** | Operator §4.1 "execute, do not merely explain" + §7.4 autonomy levels | Gateway Copilot executes nothing; client Copilot executes those 18 commands but one of them (swarm deploy) does not reach the gateway | this §1.2 |
| S4 | **Long-running work** | Operator §6.5: persistent operation id, progress, cancel, "do not make the chat request the record" | No `agent_runs`/`operations` table; no `/agents/:id/run` and no `/agents/:id/stop`; "running" is a status string. Terminal runs, browser tasks, evolution experiments *are* persisted operations — three separate records, no shared shape | schema; probe |
| S5 | **Feature state reporting** | Dynamic Feature Awareness: Copilot must know each feature's real state and roadmap position | Three vocabularies coexist — datastore per-slice `provenance` (`demo / gateway`) with a global sync `status` (`idle / loading / live / degraded / demo / error`); capability `available / demo / blocked / unconfigured / unverified`; conversation `idle / loading / ready / unready / unavailable / error / demo` — plus one stale static pack | §6 |
| S6 | **Design Spec vs Operator scope** | Design Spec: Copilot as an assistant embedded in a defined UI (dock, modes, cards); Operator: Copilot as the primary operating interface (hologram, §8) | Present build: dock/panel with modes; no hologram, no operation tracking UI | `src/copilot/panel.js`, §10 Q9 |
| S7 | **"One application state"** | Operator §4.3 | Two stores (gateway SQLite + `localStorage mmm-state-v1`) and, for swarm plans, two writers | `src/core.js:139`, `src/datastore.js` |
| S8 | **Training/voice "blocked" wording** | Design Spec describes voice as a first-class surface | Probe: `localStt:false, localTts:false, allowRemoteHosts:false`; training has only JSONL inspection | probe; `src/copilot/jsonlInspection.js` |

## 1.4 Ten findings that should shape Phase B

1. **One client seam** (`src/api.js`) and one provenance mechanism already exist — build on them; do not
   add a second transport.
2. **Only 8 data slices are gateway-backed, and 6 screens have no backend at all** (Skills, Skills Matrix,
   Plugins/MCP, Artifacts/Files, Telegram, Local AI); 3 more (Home, Analytics, Settings) mix live gateway
   data with fixture numbers. Five documented API operations are `planned` and absent — skills activate,
   files, analytics series, swarm deploy/execute, agent run. A registry must be able to say "missing
   implementation" (Operator §5.1) as a first-class status, not "error".
3. **`packages/shared/api-routes.json` is not a contract.** 12 groups vs 25 real groups; 5 `planned` items
   of which 2 now exist (`POST /threads/:id/messages`, swarm status) and are named wrongly
   (`/chat/threads/...`); `DELETE /agents/:id` exists in the gateway and is absent from the file.
4. **Three "operations" subsystems already persist long-running work** (terminal runs, browser tasks,
   evolution experiments) and none of them shares a shape. Operator §6.5 wants one; that is a design
   decision, not a wiring job.
5. **Approvals are records, not bindings.** Only `terminal.run` acts on `allow`
   (`server.js:1794-1801`). Any dispatcher that relies on approvals for consequential actions needs the
   binding built.
6. **Copilot's swarm-deploy intent bypasses the gateway** and even cites a route that does not exist
   (`POST /swarms/:id/deploy`); the real route is `PATCH /api/v1/swarms/:id/status` (`swarm:write`), and
   `datastore.createSwarmPlan` already uses it. This is the clearest example of "two writers, one state".
7. **The client capability table cannot be trusted to describe the gateway** — it is static, client-scoped,
   and 9/10 statuses are literals. Anything Phase B builds must be derived server-side or drift-tested.
8. **The knowledge pack is a snapshot of a commit that no longer exists in this history** and contains at
   least one now-false "verified" claim. Dynamic Feature Awareness cannot build on it unmodified.
9. **Verification is uneven, and the browser tier is not exercised by default.** `npm test` (49 suites,
   841 `PASS` lines, exit 0) covers the node + happy-dom tier, including 2 of the 21 `*:browser` scripts.
   The other **19** — the ones that would prove layout, 320 px behaviour, gestures, service worker and
   *browser* honesty — are not in `npm test`, and puppeteer/Chromium is not installed here. There is no CI
   (`.github/workflows` absent).
10. **Dead weight is small but real:** `jobs` and `team_members` tables have zero readers/writers;
    `files`, `model_policies`, `plugins`, `skills` are seed-only (skills/plugins are read as validation
    context by the drafts module); `principal:write:privileged` is a declared permission used nowhere; the
    WS `voice` topic is filtered but unreachable (not in the subscribe allowlist).

---

# 2. Complete Application Operation Inventory

## 2.1 Status vocabulary used here

`working` · `implemented-not-verified` · `partial` · `UI-only` · `demo` · `blocked` · `planned`.
Mapping to the three vocabularies already in the code is given in §6.3.

## 2.2 The inventory — every module, all ten required fields

Cells are deliberately terse; §3 expands each module.

| # | Module | Capability | Existing implementation | Backend connection | Status | Permissions | Dependencies | Blockers | Evidence | Recommended next step |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Shell, router, PWA, service worker | 20 screens + login, tabs, sheets, modals, offline banner, SW | `src/shell.js`, `src/main.js`, `public/sw.js` | static only | working | — | browser | SW update depends on client install | `main.js` router; `npm test` 49 suites | keep; add SW assertions in Phase B tracing tests |
| 2 | Data layer & provenance | 8 gateway slices, demo snapshot, WS live, refresh coalescing | `src/datastore.js` (957 L), `src/api.js` (106 paths) | REST + `/ws` | working | inherits route perms | gateway session | demo/localStorage second store | `datastore.js:19,291,308`; `test:readsync`, `test:session-safety` | expose slice→operation map to the registry |
| 3 | Identity: login/session/CSRF/password | cookie sessions, scrypt, CSRF, token auth | `apps/gateway/src/auth.js`, 4 routes | native | working | `public` (login) | SQLite | — | `test:auth`, probe `/healthz` `auth.mode:required` | none |
| 4 | Principals & roles | role matrix, principal CRUD | 3 routes + `rbac.js` | native | partial (API only, **no UI**) | `principal:read/write` | — | no screen consumes it | probe `/roles`: 5 roles + map | decide whether Copilot may manage principals (Q4) |
| 5 | Scoped tokens | issue/revoke bearer tokens | 3 routes | native | partial (API only, no UI) | `token:issue`, `token:revoke:any` | — | no UI | `server.js:421-470` | expose as owner-only operation or exclude |
| 6 | Audit chain & events | hash-chained audit, verify, event feed | `db.js audit()`, 3 routes | native | working | `audit:read`, `audit:verify`, `event:read` | — | no audit screen | probe `/audit/verify` `{ok:true}`; `test:hardening` | expose "verify audit" as a read operation |
| 7 | Summary & usage | counts + ledger rollups | 2 routes | native | partial | `summary:read`, `read` | model_calls | Home deck still shows fixture spend | probe `/summary` zeros; `/usage` empty | make deck read `/usage` only (no new work) |
| 8 | Agents (definitions) | CRUD, team assignment, delete | 5 routes, `teams.js` membership | native | partial — rows real, **numbers fixture** | `read`, `agent:write` | teams | `success_rate` default `0.85`; no run endpoint | schema; probe; `docs/FEATURE_COMPLETION_ROADMAP.md` row 2 | registry entry: create/update/delete **available**, run **missing** |
| 9 | Agent Designer | form → `createAgent()` | `src/designer.js:677` | `POST /agents` | partial | `agent:write` | agents | validation client-only; no versioning/eval | `test:designer` | route through drafts for consistency (Q1) |
| 10 | Agent drafts | create→validate→submit→approve→activate→archive | `agentDrafts.js`, 7 routes | native | working | `copilot:read/write`, `approval:*` | model (draft-from-prompt), approvals | activation stores idle definition only | `test:drafts` 21, `test:drafts:ui` 11 | **template for the Phase B dispatcher** |
| 11 | Teams & membership | CRUD, members, reorder | 8 routes, `teams.js` | native | working | `agent:write`, `read` | agents | `team_members` table dead (006) | `test:teams` 12, `test:teams:ui` 23 | registry: 6 operations |
| 12 | Swarm plans | plan CRUD, status, budget cap | 6 routes, `swarms.js` | native | partial — plans real, **nothing executes** | `read`, `swarm:write` | agents | no scheduler/runner; Copilot deploy bypasses gateway | `test:swarms` 17; `orchestrator.js:541-565` | fix writer divergence; registry: plan ops only |
| 13 | Tasks / Kanban | CRUD + move, wires, zoom | 3 routes; `src/kanban.js` seam | native | partial — CRUD real, deps/order/delete have no endpoint | `read`, `task:write` | agents | server-side deps absent | `test:kanban` 26 | registry: create/move/assign/priority |
| 14 | Approvals | request, decide, separation of duties | 3 routes, `canDecideApproval` | native | working as a *record*; **binding missing** | `approval:read/request/decide` | terminal (only hook) | no expiry/param binding/idempotency | `test:gateway`, `server.js:1761-1803` | add binding before deferring any action to a gate |
| 15 | Model gateway | providers, sealed keys, budget, ledger, metered calls | `models.js`, `secrets.js`, 8 routes | outbound HTTPS | working | `model:read/key/call` | provider key; egress | no streaming; **no tool calling** | `test:models` 22, `test:models:ui` 11 | add tools channel in Phase C, not A |
| 16 | Chat threads & messages | threads, messages, read receipts, idempotency | `chat.js`, 6 routes | native | working | `chat:read/write` | — | no reply generated | `test:chat` 16 | registry: send/read only, never "reply" |
| 17 | Copilot (gateway, model) | single-turn model conversation, metered, per-principal | 26 routes, `copilot.js` | model gateway | working when a key is sealed; `unconfigured` here | `copilot:read/write/model` | sealed key | **no actions, no tools** | probe `/copilot/runtime` `configured:false`; `test:copilot-api` 19 | Phase C target |
| 18 | Copilot (client, deterministic) | 7 modes, 18 advertised Operate commands, proposals with confirm | `orchestrator.js` 1,282 L, `panel.js` | via `src/api.js` | working (deterministic by design) | client mirror of `auth.can` | gateway session for live data | one intent (swarm) bypasses gateway; mode set differs from gateway | `test:copilot` 8, `test:copilot-api` 19, `test:honesty` 13 | **source of the dispatcher's UX contract** |
| 19 | Capability registry (client) | 10 capabilities, evidence strings | `src/copilot/capabilities.js` | none | partial — static, 1 dynamic | — | — | not server-derived; no schemas/risk/perms | §1.2; `capabilities.js:312` | replace/extend server-side (Q2, Q3) |
| 20 | Knowledge pack | 33 entries, keyword retrieval, sources | `src/copilot/knowledge.js` | none | partial — **stale**, pinned `repo:66b1bd3` | — | repo snapshot | no freshness test; 1 verified claim false | `knowledge.js:13`; §1.2 | regenerate + drift test (Q7) |
| 21 | Copilot memory | draft, episodes, preferences | `src/copilot/memory.js` | localStorage | working, browser-scoped | — | — | no server audit/cross-device | `capabilities.js` `memory` evidence | keep out of Phase B scope |
| 22 | Swarm plan drafts | draft→approve→activate | `swarmPlanDrafts.js`, 7 routes | native | working | `copilot:*`, `approval:*` | model | plan still unexecutable | `test:plans` 24, `test:plans:ui` 10 | reuse for Copilot swarm intent |
| 23 | Browser script drafts | draft→approve→queue one real task | `browserScriptDrafts.js`, 7 routes | browser | working | `copilot:*`, `browser:run` | Chromium | engine unconfigured in this env | `test:scripts` 25, `test:scripts:ui` 10 | registry: "approval *is* the run" |
| 24 | Training | JSONL syntax inspection only | `jsonlInspection.js`, `test:training-jsonl` | none | blocked | — | training backend, validator | no runner, no jobs | probe: no route; roadmap row 20 | report `blocked` (already correct) |
| 25 | Skills Hub / Matrix | 24-entry catalogue, import/validate/quarantine, matrix | `skillsData.js`, `skillsImport.js`, `views2.js:141` | **none** (`/skills` → 404) | UI-only (local flag) | — | skills table seeded only | no activate route (planned) | `test:skills`; probe 404 | exclude until an endpoint exists |
| 26 | Plugins / MCP | catalogue that states "no MCP client" | `src/views2.js:708` | none | demo (honest) | — | MCP client | `plugins` table seeded, read only by draft validation | probe `/plugins` 404 | exclude |
| 27 | Agent Browser | tasks, 8 actions, watchdog, evidence | `browser/` (driver, runner, policy, watchdog), 6 routes | Puppeteer | implemented-not-verified here (`engine:null`, `status:unconfigured`) | `browser:read/run` | Chromium on host | engine missing | probe `/browser/capabilities`; `test:browser` 22 | registry: `unconfigured` when no engine |
| 28 | Terminal | real child processes (node/npm/npx), SSE, approvals, agent grants | `terminal/`, 21 routes | host process | working | `terminal:read/run/grant/signal` | Node on host | no shell by design; offline npm only for cached packages | `test:terminal` 30, `test:terminal:ui` 12 | registry: run/approve/cancel/signal |
| 29 | Evolution / self-modification | policy, sandbox candidate, review, promote/rollback | `evolution/`, 29 routes | host process | working, sandbox **process isolation only** | `evolution:read/run/policy/review/approve/deploy` | git workspace | no model writes the patch; not containerised | `test:evolution` 20, `test:evolution-ui` 10; probe `status:partial` | registry: 8 operations; keep level gating |
| 30 | Comms | channels, encrypted creds, queue, signatures, inbound | `comms.js`, `commsAdapters.js`, 9 routes | outbound HTTPS | implemented-not-verified (no live provider) | `comms:read/write` | provider credentials | no live verification | `test:comms`, `test:comms-gateway`; probe 6 channels | registry: `unverified` |
| 31 | Telegram bridge (view) | redirects to Comms on mount; dead fake controls remain in the bundle | `src/views2.js:961-1055` | **none** | demo (deprecated) | — | — | duplicates the real `telegram` comms channel | `views2.js:964-969` redirect; `:1034-1055` dead handlers | finish the removal, or rebuild on comms (Q6) |
| 32 | Voice Studio & voice input | device recogniser, local endpoint config, TTS adapter | `src/voice/*`, `voice.js`, 7 routes | browser API / operator host | partial | `voice:read/configure/transcribe` | local speech server | probe: `localStt:false, localTts:false, allowRemoteHosts:false` | `test:voice` 16, `test:voice-stt` 16, `test:voice-input:ui` 10 | registry: `unconfigured` until host set |
| 33 | Local AI | spike: on-device runtime probe | `src/local.js`, `localRuntime.js` | none | blocked (phase-2 spike only) | — | model files, isolation | no download/manager | `test:local`, `docs/local/*` | exclude |
| 34 | Analytics | spend/tokens from ledger; leaderboard fixture | `src/views2.js:1065` | `/usage`, `/model-calls` | partial | `model:read` | model_calls | `successRate`/`costToday` fixtures; no `/analytics` route | probe 404; roadmap row 14 | registry: money series only |
| 35 | Artifacts / Files | list, upload into local state, "248 MB / 2 GB" string | `src/views2.js:1164` | **none** (`/files` → 404, table seeded only) | demo | — | files route | no storage backend | probe 404 | exclude; report `planned` |
| 36 | Settings | live pending count, audit truth, notification/retention copy; trust sliders preview | `src/views2.js:1236` | partial (`/summary`, `/audit`) | partial | `read` | — | no `/settings` route; storage demo | probe 404 | registry: read-only truth panels |
| 37 | Home / Deck | agents, approvals, events live; spend/trust/success fixture | `src/views1.js:58-140` | 3 slices | partial | `read`, `approval:read` | — | fixture numbers | footnote in view; roadmap row 1 | replace fixture fields with ledger (later phase) |
| 38 | Design system / RELAY, motion, gestures | tokens, 4 modes, haptics, swipe commands | `src/*.css`, `gestures.js` | — | working | — | — | verification via `:browser` suites only | `test:design`, `test:motion`, `test:relay:browser` (not run) | include visual checks in Phase F |

**Totals (computed from the table):** 38 modules — **working 17 · partial 13 · blocked 2 ·
implemented-not-verified 2 · demo 3 · UI-only 1**. No module is `planned`: "planned" appears only for
absent API operations in §2.3. Full expansion in §3.

## 2.3 Capability coverage matrix (Operator Extension §5.2 shape)

One row per **user-visible operation** that a Copilot would plausibly invoke. `Copilot today` describes
the *client* Operate path (the only path that can act). Risk uses the spec's taxonomy
(read-only · reversible · consequential · destructive).

| Module | User operation | Service / API | Permission | Risk | Copilot today | Verification | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Agents | List / read agents | `GET /agents`, `/agents/:id` | `read` | read-only | connected (answers) | gateway read | working |
| Agents | Create agent definition | `POST /agents` | `agent:write` | reversible | **connected** (Operate: "create agent X") | read-back + audit | working |
| Agents | Update / delete agent | `PATCH`, `DELETE /agents/:id` | `agent:write` | reversible / destructive | missing (delete exists in datastore, no intent) | read-back | working (API), not wired |
| Agents | Start / stop an agent | **no endpoint, no runtime** | — | — | refuses truthfully ("no execution runtime") | n/a | blocked |
| Agent drafts | Draft an agent from a prompt | `POST /copilot/drafts` | `copilot:write` | reversible | missing in client UI intent set | draft row + findings | working |
| Agent drafts | Submit / approve / activate | `.../submit`, approvals, `.../activate` | `approval:decide` | consequential | missing (client) | separation of duties | working |
| Teams | Create / rename / delete team | 4 routes | `agent:write` | reversible | missing (no Operate intent) | read-back | working |
| Teams | Add / remove / reorder members | 4 routes | `agent:write` | reversible | missing | read-back | working |
| Swarm plans | Create plan | `POST /swarms` | `swarm:write` | reversible | **diverges** — writes local state only | read-back (fails today) | partial |
| Swarm plans | Change status / archive / delete | `PATCH`, `DELETE /swarms/:id` | `swarm:write` | reversible | missing | read-back | working |
| Swarm plans | Execute a plan | **nothing exists** | — | — | correctly refuses | n/a | blocked |
| Tasks | Create task | `POST /tasks` | `task:write` | reversible | connected | read-back + audit | working |
| Tasks | Move card between columns | `PATCH /tasks/:id` | `task:write` | reversible | connected (kanban seam) | confirm modal + read-back | working |
| Tasks | Assign / priority / rename | `PATCH /tasks/:id` | `task:write` | reversible | connected | read-back | working |
| Tasks | Add dependency, reorder, delete | **no endpoint** | — | — | refuses (kanban seam declines) | n/a | blocked |
| Approvals | List pending / read | `GET /approvals` | `approval:read` | read-only | connected | read | working |
| Approvals | Allow / deny a gate | `POST /approvals/:id/(allow or deny)` | `approval:decide` | consequential | connected, with self-approval refusal | audit verify | working |
| Approvals | Request a gate | `POST /approvals` | `approval:request` | reversible | not exposed as an intent | read-back | working (API) |
| Models | Read providers / ledger / budget | 4 routes | `model:read` | read-only | answers in Ask mode only | probe | working |
| Models | Seal / clear a provider key | `PUT/DELETE /providers/:id/key` | `model:key` | consequential | missing (UI-only path) | fingerprint, never the key | working |
| Models | Test-call a provider | `POST /providers/:id/call` | `model:call` | consequential (spends) | missing as an intent | ledger row | working |
| Models | Set budget caps | `PUT /budget` | `model:key` | consequential | missing | read-back | working |
| Chat | Send a message | `POST /threads/:id/messages` | `chat:write` | reversible | missing (Copilot has its own thread) | idempotent by `clientId` | working |
| Chat | Mark read / delete thread | `POST .../read`, `DELETE` | `chat:write` | reversible | missing | read-back | working |
| Copilot | Send a Copilot turn | `POST /copilot/messages` | `copilot:write` | consequential (spends) | gateway path only | ledger + stored turn | working when keyed |
| Browser | Start a task | `POST /browser/tasks` | `browser:run` | consequential | missing | task row + steps | implemented-not-verified (no engine) |
| Browser | Pause / resume / stop / assist | `POST /browser/tasks/:id/*` | `browser:run` | reversible | missing | step evidence | implemented-not-verified |
| Terminal | Run a command | `POST /terminal/runs` | `terminal:run` | consequential | Copilot can *read* terminal, cannot run | SSE + exit code + audit | working |
| Terminal | Approve a destructive npm command | approvals + `terminal/signal` | `terminal:grant`, `approval:decide` | consequential | not wired | run starts on `allow` | working |
| Terminal | Cancel / signal a run | `POST /terminal/runs/:id/signal` | `terminal:signal` | reversible | missing | exit code | working |
| Evolution | Read policy / versions / health | 6 routes | `evolution:read` | read-only | missing | probe | working |
| Evolution | Propose a candidate, review, approve, promote, roll back | 9 routes | `evolution:run/review/approve/deploy` | consequential → destructive | missing | versioned promotion + audit | working |
| Comms | Read channels / queue / messages | 4 routes | `comms:read` | read-only | connected (comms seam) | probe | implemented-not-verified |
| Comms | Configure channel / send / test | 5 routes | `comms:write` | consequential | partly connected ("test <channel>") | delivery rows | implemented-not-verified |
| Voice | Configure a local speech endpoint | `POST /voice/endpoints` etc. | `voice:configure` | reversible | missing | probe `localStt:false` | partially implemented |
| Voice | Transcribe audio | `POST /voice/transcribe` | `voice:transcribe` | read-only-ish | client uses device recogniser | `test:voice-stt` | partial |
| Identity | Create principal / change role | `POST/PATCH /principals` | `principal:write` | consequential | missing | audit | working (API only) |
| Identity | Issue / revoke token | `POST/DELETE /tokens` | `token:issue` | consequential | missing | hash-at-rest | working (API only) |
| Audit | Read audit / verify chain | `GET /audit`, `/audit/verify` | `audit:read/verify` | read-only | answers in Ask mode | probe `{ok:true}` | working |
| Skills | Activate a skill | **planned, no endpoint** | — | — | must refuse | n/a | planned |
| Files | Upload / list / download | **planned, no endpoint** | — | — | must refuse | n/a | planned |
| Analytics | Series per metric | **planned, no endpoint** | — | — | must refuse | n/a | planned |
| Training | Validate a dataset | inline inspection only (client) | — | — | reports blocked | `test:training-jsonl` | blocked |

**Matrix totals (computed from the table):** **43 operations** — working 29 · blocked 4 ·
implemented-not-verified 4 · partial 3 · planned 3. *(Counts by row status; "missing" in `Copilot today`
is the Phase C gap, not a status.)*

Of the 43, the client Copilot can reach **8 rows today** — agent list/create, task create/move/assign,
approvals list/decide, and comms read (partly) — plus swarm create, which reaches the wrong store. Every
other row is `missing`: **that is the concrete size of the Phase C wiring job.**

---

# 3. Module-by-module implementation and runtime status

## 3.1 Platform

**3.1.1 Shell, router, PWA, service worker.** 20 screens plus a login view rendered by `views1.js` / `views2.js`;
`shell.js` owns topbar, bottom dock, sheets, `confirmModal()` and `[data-act]` delegation; `main.js` owns
the hash router, re-render on store change and SW registration. No simulation ticker (removed in an
earlier milestone). Runtime: working in the node/happy-dom tier; layout and SW behaviour are asserted only
by `test:relay:browser`, `test:scroll:browser`, `test:sw-compat`-style suites that were **not run** here.

**3.1.2 Data layer.** `src/datastore.js` is the only writer of gateway data on the client. It adapts rows
(`adaptAgent`, `adaptSwarm`, …), keeps a demo snapshot to restore on sign-out, coalesces refreshes,
reconnects the socket with backoff, and exposes `sourceExplanation(slice)` so a screen can say why a slice
is demo. `src/api.js` is the only HTTP client (106 paths, `ApiError` with `forbidden`/`unauthenticated`
flags used across the Copilot for honest refusals). Runtime: working. This is the correct single seam for
Phase B/C.

**3.1.3 Identity, roles, tokens, audit.** Sessions: `scrypt` hashes, HttpOnly+SameSite=Strict cookie, HMAC
CSRF, login throttling (`auth_attempts`). RBAC: 43 permissions mapped to 5 roles with explicit sets
(`ROLE_PERMISSIONS`), Owner = all. Audit: hash-chained `audit_log`, `GET /audit/verify` returned
`{ok:true}` on the probe. Gaps: no UI for principals/tokens; `principal:write:privileged` unused;
`token:revoke:any` and `system:diagnostics` are handler-only checks (legitimate, but invisible to any
route-metadata-derived registry — a registry built from route metadata alone would miss them).

**3.1.4 Real-time.** `broadcast(topic, payload)` fans out to subscribers; subscription is role-filtered by
`subscriptionFilter` (`server.js:176-187`). Two flaws, both verified: (a) an **unknown topic is dropped
silently** — the allowlist filter at `server.js:2303` removes it before `refused` is computed, so a client
typo gets no error; (b) the filter has a `voice` branch but `voice` is **not in the allowlist**, making
that branch unreachable. The probe's `refused: []` for `events`, `comms`, `voice` is consistent with (a).

## 3.2 Agents, teams, work

**3.2.1 Agents.** 5 routes. Rows are real; every *number* on the card is a fixture: `status` is a string,
`success_rate` defaults to `0.85` in the migration/seed/insert path, `cost_today`, `runs`, `memory` are
never computed. There is no `agent_runs` table and no run/stop route; the swipe `run` / `stop` commands
PATCH `status` through `setAgentState` and then toast "… is now running on the gateway"
(`views1.js:1229-1230` → `:1192-1206` → `datastore.updateAgent` → `PATCH /agents/:id`). The client
Copilot refuses to do this on a live slice and says why (`orchestrator.js:726-735`) — a correct refusal
that the UI gesture path does not share. **This divergence is a Phase B input:** a dispatcher must own the
"start agent" operation so the gesture, the Copilot and the panel cannot disagree.

**3.2.2 Agent Designer.** `createAgent()` → `POST /agents`. Validation is client-side; the gateway accepts
what it is given. No versions, no evaluation, no rollback. The governed path is the draft pipeline, which
the Designer does **not** use.

**3.2.3 Teams.** Fully real: create/rename/delete, member add/remove, reorder by position; membership
lives on `agents.team_id` + `agents.team_position` (`team_members` retired by migration 006 and now dead
— zero references). Deleting a team unassigns members and reports the count.

**3.2.4 Swarm plans.** Real rows with a budget cap, status machine, archive, delete, `swarms` WS topic and
per-mutation audit. The API refuses a status that would claim a run. **Nothing executes a plan** and no
scheduler exists (verified: only three timers in the gateway — comms queue ticker, browser ticker,
WS keep-alive). The client Copilot's deploy intent writes local state and cites a non-existent route
(§1.2); `datastore.createSwarmPlan` uses the real `POST /swarms` + `PATCH /swarms/:id/status`.

**3.2.5 Tasks / Kanban.** Real CRUD through the gateway, with a confirm step on every move; drag, wires and
zoom are client-side by design (`--kb-zoom` + CSS `zoom`, not `transform`). Dependencies, card ordering and
delete have no endpoint and refuse rather than pretend. One seam (`src/kanban.js`) serves the board, the
drawer and Copilot — the cleanest existing example of what Phase B should generalise.

**3.2.6 Approvals.** Generic rows (`action`, `target`, `risk`, `principal`, `evidence`, `status`) with
separation of duties enforced in `canDecideApproval`. Gaps: a requester may set `principal` from the
request body; there is no expiry, no parameter binding, no replay protection; and the only action wired to
a decision is `terminal.run`. `POST /approvals` is otherwise a record-keeping endpoint.

## 3.3 Intelligence

**3.3.1 Model gateway.** Owner seals a key (AES-256-GCM, fingerprint + `••••abcd` hint on read, never the
key), one OpenAI-compatible adapter, ledger row per attempt (`ok`/`blocked`/`error`, tokens, estimated
cost, latency), daily and per-call caps enforced before egress, redirects not followed, prompts/replies
not stored. *All of this is proven by the gateway suite against a stub provider; behaviour against a
**real** provider is **⚠ UNVERIFIED** in this environment (Appendix C.1).* Probe: 26 catalogue providers, 0 configured, `budget {dailyUsd:5, perCallUsd:0.5,
enforced:true}`, `costBasis:estimated`. 22 + 11 tests pass. **No `tools` / `tool_choice` support.**

**3.3.2 Chat.** Threads and messages persist, survive reload and restart, idempotent by `clientId`, read
receipt is a write. Nothing answers; the API says `runtime.configured:false` in every read and the screen
prints it.

**3.3.3 Copilot — gateway.** One model turn per message, metered, stored, linked to `model_calls`, with a
screen hint injected into the system prompt. When no key is sealed the send is refused and **no assistant
turn is invented**. With no key in this environment the probe reports `configured:false`.

**3.3.4 Copilot — client.** 7 modes; Operate executes through proposal objects that already look like an
action contract (params, editable fields, risk, permissions, effects, rollback, verify, execute). It is
deterministic and says so per message. It branches on gateway availability everywhere (`apiReady()`), and
its refusals are specific ("no execution runtime to start it and this build has no run endpoint"). The
mode set differs from the gateway path, which has no modes at all — a UI that shows modes while the
gateway shows a runtime statement is a product inconsistency, not a bug, but Phase B must pick one.

**3.3.5 Capability registry.** 10 entries (knowledge, memory, actions, training, voice, channels, opensms,
browser, evolution, llm). Source statuses: available 3, demo 1, blocked 1, unconfigured 1, unverified 4;
only `llm` computes its status at read time. Fields present: id, label, status, summary, detail,
requirements, evidence. Fields **absent** (all required by Operator §5): input/output schema, handler,
permission, risk class, read-only/mutating, confirmation requirement, cancellation/reversibility, timeout,
retry, health requirement, audit requirement, idempotency.

**3.3.6 Knowledge pack.** 33 entries across 18 modules; 31 `verified`, 2 `unknown` (`voice.candidates`,
`comms.opensms`); every entry stamped with `PACK.version` = `repo:66b1bd3`, built 2026-10-26. At least one
"verified" entry is now false (§1.2). Retrieval is keyword-based; there is no ingestion, revision or
approval pipeline.

**3.3.7 Drafts (3 pipelines).** `agent_drafts`, `swarm_plan_drafts`, `browser_script_drafts`: 21 routes
(7 per pipeline — list, get, create, patch, submit, activate, archive), with ownership checks, state
machines, stored validation findings, audit per transition, and an activation that either stores an idle
definition or queues one real browser task. `agentDrafts.duplicate()` is implemented but **not exposed by
any route**. This is the best-governed write path in the repository.

## 3.4 Module surfaces without a backend

Skills Hub (24-entry catalogue + import/validation/quarantine that is good code running in the browser;
"activate" flips a local flag), Skills Matrix (local relationship editing), Plugins/MCP (catalogue that
states "no MCP client is installed"; the install action explains what it needs), Artifacts/Files (seed
list, upload into local state, "248 MB / 2 GB" as a string), Analytics (money/tokens from the ledger, but
the agent leaderboard uses fixture `successRate`/`costToday`), Settings (live pending-approval count and
honest security copy; trust sliders only move a preview), Telegram (a deprecated screen that redirects to
Comms on mount — but whose fake link switch, "Sent to Telegram" toast and hardcoded `/status`, `/ask`,
`/copilot` replies, **including a fabricated agent progress line**, are still in the bundle and would be
live if the redirect did not run), Local AI (spike only), Training (blocked, correctly).

The real Telegram capability lives in `apps/gateway/src/comms.js` + `src/commsAdapters.js` as a comms
channel, so the honest path exists; the residual risk is dead-but-shipped code that a failed dynamic
import would expose. Left as-is, it is a small but real contradiction of the repo's own rule that a mock
belongs in a test file, never in `src/`.

---

# 4. Demo / placeholder / disconnected findings

| Where | What it does now | What it should do | Real service it needs |
| --- | --- | --- | --- |
| `src/views2.js:961-1055` Telegram screen | Redirects to Comms on mount (`:964-969`); the fake link toggle, "Sent to Telegram" toast and hardcoded replies (one inventing agent progress) remain as unreachable-but-live handlers | Delete the dead view entirely (the real channel already exists), or rebuild it on the channel | `comms.js` channel `telegram` + `commsAdapters.js` — **already implemented** |
| `src/views2.js:1164+` Files/Artifacts | Seed list; "Upload" writes local state; storage string "248 MB / 2 GB" | Real list/upload/download with real byte counts | `GET/POST /files` (**planned, absent**); `files` table seeded but unread |
| `src/views2.js:708` Plugins/MCP | Catalogue; rows read "not connected"; install explains requirements | Real MCP client, tool enumeration, per-plugin scopes | MCP client + `plugins` route (**absent**); table seeded, read only as draft-validation context |
| `src/views2.js:141` Skills Hub / Matrix | Local catalogue + local activation flag; matrix edits local | Persisted skills, activation with approval, matrix in the DB | `POST /skills/:id/activate` (**planned**) + `/skills` |
| `src/views1.js:58-140` Home deck | Agents/approvals/events live; spend, trust, success, "runs" from fixtures | Ledger-derived spend; measured success or explicit "not measured" | `/usage` (exists), `model_calls` |
| `src/views2.js:1065` Analytics | Money/tokens real; leaderboard `successRate`/`costToday` fixture | Leaderboard from ledger per agent, or remove the columns | `model_calls` grouped by principal (**no route**) |
| `src/views2.js:1236` Settings | Live pending count; trust sliders move a preview; storage is a demo | Trust weights applied by the routing policy, or labelled as preview-only (partly done) | `model_policies` (**seeded, no route**) |
| `src/core.js:139` seeded store | Whole demo workspace in `localStorage` | Nothing, when a gateway is present | — (by design; provenance exists) |
| `migrations/001` `agents.success_rate` default `0.85` | Every new agent claims 85 % success | Null + "not measured" | measurement pipeline (**absent**) |
| `src/copilot/orchestrator.js:541-565` swarm deploy | Writes local state on a live session; says gateway persist is "blocked, planned" | Write through `POST /swarms` then `PATCH .../status`, or refuse on a live session | `swarms.js` (**exists**) |
| `src/copilot/knowledge.js` `app.overview` | States the front end does not call the gateway yet | Regenerated from the repo at a pinned revision | generation job (**absent**) |
| `apps/gateway/migrations` `jobs`, `team_members` | Zero reads/writes | Drop, or use for a real runner | — |
| WS `voice` topic branch | Unreachable | Reached, or deleted | `server.js:2303` allowlist |
| `src/views1.js:1229` swipe "run"/"stop" | PATCHes `status` to `running` | Refuse (as Copilot does) or call a real run endpoint | run endpoint (**absent**) |

---

# 5. Existing APIs, services, state stores and permission systems

## 5.1 HTTP surface (154 routes, 25 groups)

`evolution` 29 · `copilot` 26 · `terminal` 21 · `comms` 9 · `teams` 8 · `voice` 7 · `swarms` 6 ·
`threads` 6 · `browser` 6 · `agents` 5 · `providers` 5 · `auth` 4 · `principals` 3 · `tokens` 3 ·
`tasks` 3 · `approvals` 3 · `audit` 2 · `healthz` 1 · `roles` 1 · `summary` 1 · `usage` 1 ·
`model-calls` 1 · `budget` 1 · `events` 1 · `dev` 1.

Route metadata carries `{ public, permission, mutating }` in one table (`server.js:164-171`), which is the
single best starting point for a server-derived registry: permission and mutation class are already
machine-readable for all 154 routes.

## 5.2 Services and their contracts

All paths in this table are under `apps/gateway/`.

| Service | File | Public surface | Persistence |
| --- | --- | --- | --- |
| Identity/auth | `src/auth.js` | login, session, logout, password, tokens, revalidate | `sessions`, `capability_tokens`, `auth_attempts`, `settings(auth.secret)` |
| Agents/teams | `src/teams.js`, `server.js` | agent CRUD, team CRUD, membership, reorder | `agents` (`team_id`, `team_position`), `teams` |
| Tasks | `server.js` | list/create/patch | `tasks` |
| Approvals | `server.js` + `canDecideApproval` | list/request/decide | `approvals` |
| Swarms | `src/swarms.js` | plan CRUD, status, budget | `swarms` |
| Models | `src/models.js`, `src/secrets.js` | providers, keys, budget, call, usage, model-calls | `providers`, `settings(models.budget)`, `model_calls` |
| Chat | `src/chat.js` | threads, messages, read | `threads`, `messages` |
| Copilot | `src/copilot.js` | conversation, runtime, model, messages | `threads`, `messages`, `settings(copilot.*)`, `model_calls` |
| Drafts ×3 | `agentDrafts.js`, `swarmPlanDrafts.js`, `browserScriptDrafts.js` | draft lifecycle + approval binding | `agent_drafts`, `swarm_plan_drafts`, `browser_script_drafts`, `approvals` |
| Browser | `src/browser/*` | tasks, steps, evidence, capabilities | `browser_tasks/steps/evidence` |
| Terminal | `src/terminal/*` | workspaces, runs, SSE stream, signal, grants | `terminal_workspaces/sessions/runs/agent_grants` |
| Evolution | `src/evolution/*` | policies, observations, experiments, reviews, versions, rollback | `evolution_*` (7 tables) |
| Comms | `src/comms.js`, `commsAdapters.js` | channels, credentials, send, queue, inbound, settings | `comms_channels/messages/settings` |
| Voice | `src/voice.js` | endpoints, transcribe, synthesize | `voice_endpoints` |
| Audit | `src/db.js` | `audit()`, `logEvent()`, `verifyAuditChain()` | `audit_log`, `events` |

## 5.3 State stores

1. **Gateway SQLite** (WAL) — 43 domain tables, authority for the 8 live slices.
2. **Browser `localStorage mmm-state-v1`** — the demo workspace, Copilot memory, drafts of local skills,
   Kanban zoom, theme, provenance. Survives sign-out (demo snapshot restore).
3. **The model ledger** — `model_calls`; the only money truth (`spend_mtd` was deliberately dropped).
4. **Seed-only tables** — `files`, `model_policies`, `plugins`, `skills`; `jobs` and `team_members` have no
   readers at all.

## 5.4 Permission systems

- **Server** — `rbac.js`: 43 permissions, role sets, `can()`, `canDecideApproval()`,
  `canAssignRole()`, `canManagePrincipal()`; enforced per route and per WS topic; every denial is audited.
- **Client mirror** — `src/auth.js` `can()` from the session payload; used for affordance hiding **and** by
  the Copilot before it acts (`canDo('agent:write')`), with the server re-checking.
- **Approvals** — separation of duties; a second principal, not a second factor.
- **Evolution levels** — per-agent sandbox policy (`defaultLevel: 1`, 12 protected paths).
- **Terminal grants** — `terminal_agent_grants` lets an authorised agent run commands via the same path.

---

# 6. Dynamic Feature Awareness — readiness assessment

The Dynamic Feature Awareness spec asks Copilot to know, and report truthfully, **what each feature is,
what state it is really in, and where it sits on the roadmap**. Readiness, dimension by dimension:

| Dimension | What exists | Verdict |
| --- | --- | --- |
| Machine-readable operations | 154 routes with `{permission, mutating}` metadata | **Strong** — best asset in the repo |
| Operations that are *client-only* | 6 screens have no endpoint at all, 3 mix live and fixture data; 5 documented `planned` routes; 2 of those 5 already exist under a different name | **Weak** — needs an explicit "no service" declaration |
| Capability catalogue | 10 static entries, client-side, 1 dynamic | **Weak** — shape and location both wrong (S1) |
| Permission truth | 43 permissions, role sets, server enforcement | **Strong** |
| Runtime health | `/healthz`, `/browser/capabilities`, `/copilot/runtime`, `/evolution/capabilities`, `/voice` config | **Medium** — per-module probes exist but no single endpoint summarises them |
| Roadmap truth | `docs/FEATURE_COMPLETION_ROADMAP.md` (truth table, 20 screens), `docs/PRODUCTION_ROADMAP.md` (L0–L8), `docs/PROGRESS.md` (928 lines), `docs/roadmap/next-up.md` | **Medium** — rich but human-prose; nothing machine-readable, and the rows are already drifting (§1.2) |
| Knowledge pack | 33 entries, pinned to `repo:66b1bd3` | **Weak** — stale by construction, no drift test, one false "verified" |
| Status vocabulary | three coexisting vocabularies | **Weak** — must unify (Q5) |
| Self-reporting UI | provenance chips, "demo data" footnotes, capability cards, `SYSTEM_PROMPT` truth list | **Strong** — the honesty culture is real; it needs a data source, not more prose |

**Assessment: the honesty layer is culturally strong and structurally incomplete.** Publishing a
feature state to Copilot is *possible today* for the 8 live slices, and *impossible today* for the
remaining screens and planned operations without inventing an endpoint, which the spec forbids. The gap
is not goodwill; it is a missing machine-readable catalogue that treats "absent" as a legal state.

Prerequisite order for the spec's goal: (1) unify the state vocabulary; (2) generate/validate the
catalogue against the route table and the `planned` list, with a drift test; (3) refresh the knowledge
pack from the current revision with a test that pins the revision; (4) only then expose it to the model
(as context, not as a tool).

## 6.3 Proposed single vocabulary — and how the three existing ones map onto it

Proposal only (Q5 asks for the decision). Seven states, every one of which a real deployment can be in:

| Proposed state | Means | datastore (`provenance` / sync `status`) | capability `status` | conversation `status` |
| --- | --- | --- | --- | --- |
| `available` | real service, reachable now, this role may use it | `gateway` / `live` | `available` | `ready` |
| `degraded` | real service, reachable, failing or partially working | `gateway` / `degraded` | — (no equivalent) | `error` |
| `unconfigured` | real service, present, needs operator setup (key, engine, host, credentials) | `demo` / `demo` or `live` | `unconfigured` | `unready` / `unavailable` |
| `unverified` | implemented but never exercised against the real dependency | `gateway` / `live` | `unverified` | `unready` |
| `demo` | no backend; seeded fixtures, clearly labelled | `demo` / `demo` | `demo` | `demo` |
| `blocked` | cannot exist yet — missing runtime, backend or model | `demo` / `demo` | `blocked` | `unready` |
| `no-service` | no endpoint and no fixture; the screen is a catalogue only | `demo` / `demo` | — (no equivalent) | `demo` |

Two observations from building this table. First, **the capability registry has no way to say "degraded"**
and no way to say "no-service" — the latter is exactly where the 6 no-backend screens sit. Second, the
datastore collapses "demo because there is no backend" and "demo because the gateway is not connected"
into the same per-slice value, so a client cannot tell a missing feature from a signed-out session without
reading the screen's own copy. That is the concrete defect the unification fixes.

---

# 7. Dependencies, blockers and architectural gaps

## 7.1 Hard blockers (no code can work around these)

| Blocker | Affects | Evidence |
| --- | --- | --- |
| No agent runtime, runner or scheduler in the repository | "start agent", "run swarm", any autonomy level > suggest | schema has no `agent_runs`; no `/agents/:id/run`; only 3 timers, none a scheduler |
| No tool/function calling in the model adapter | model-driven Copilot acting (Phase C) | `models.callModel` has no `tools` parameter |
| No MCP client | Plugins/MCP | probe `/plugins` 404; UI says so |
| No training/eval backend | Training, model-evaluated drafts | only `jsonlInspection.js` |
| No files API | Artifacts, browser evidence download | probe `/files` 404 |
| No skills API | Skills Hub activation, matrix | probe `/skills` 404 |
| No analytics series API | Analytics chart/export beyond `/usage` | probe `/analytics` 404 |
| No Chromium on this host | Agent Browser | probe `engine:null, status:unconfigured` |
| No provider key sealed | Copilot (model), any metered call | probe `configured:false`, `configuredCount:0` |
| No speech host configured | local STT/TTS | probe `localStt:false, localTts:false` |
| No live comms provider | comms delivery | `implemented-not-verified` across the board |

## 7.2 Architectural gaps (fixable, ranked by what they block)

1. **No operation contract.** Route metadata is rich but per-route, not per-operation: `POST /agents` is one
   route, "create an agent with these fields and this risk class" is one operation. Nothing maps a
   *user-intent-shaped* operation to a route + permission + risk + confirmation rule.
2. **No single authority for "what can Copilot do".** Three partial answers exist (capability table,
   orchestrator intents, `SYSTEM_PROMPT` prose). They already disagree (§1.2).
3. **Two writers, one state, three subsystems.** Swarm plans are written by the module and (locally) by
   Copilot; long-running work lives in three unrelated record shapes.
4. **Approvals are records, not bindings.** No parameter hash, expiry, replay protection or generic
   execution hook.
5. **No correlation/trace id end-to-end.** The gateway returns `requestId`; the client surfaces it in some
   Copilot steps only. Operator §6.2 wants a trace id on every action.
6. **No idempotency outside chat/drafts/comms.** `models`, `terminal`, `evolution`, `tasks` have none.
7. **The contract file is stale.** `packages/shared/api-routes.json` (12 groups, 5 planned) is neither
   generated nor validated against `server.js`.
8. **Verification tiers are split.** 49 suites run by default; 19 of 21 browser scripts do not; no CI.
9. **Stale knowledge pack** with no freshness test.
10. **Dead surface** (`jobs`, `team_members`, unused permission, unreachable WS branch) — small, but it
    will mislead any auto-derived registry that trusts the schema.

---

# 8. Evidence and code references

## 8.1 Commands run (read-only)

| Command | Result |
| --- | --- |
| `node /tmp/routes4.mjs` (extract `route(...)` from `apps/gateway/server.js`) | 154 routes; 25 groups; group counts as in §5.1 |
| `node --input-type=module -e "import … rbac.js"` | 43 permissions; Observer 13 / Reviewer 19 / Operator 26 / Admin 36 / Owner 43 |
| cross-reference of route permissions vs declared | 40 routed + `public`; 3 declared-not-in-metadata, of which 2 are handler checks (`token:revoke:any`, `system:diagnostics`) and 1 unused (`principal:write:privileged`) |
| `grep CREATE TABLE apps/gateway/migrations/*.sql` | 43 domain tables + `schema_migrations`, 15 migrations |
| `wc -l src/*.js src/copilot/*.js src/voice/*.js` | 23,570 |
| `wc -l apps/gateway/server.js apps/gateway/src/**` | 11,267 |
| table-usage grep across `server.js` + `apps/gateway/src` (excluding `db.js`) | `jobs`, `team_members` 0 references; `files`, `model_policies`, `plugins`, `skills` seed-only (skills/plugins additionally read as draft-validation context) |
| knowledge-pack census | 33 entries, 31 `verified` / 2 `unknown`, `PACK.version = repo:66b1bd3`, built 2026-10-26 |
| capability census (parsed `CAPS`) | 10 entries; available 3, demo 1, blocked 1, unconfigured 1, unverified 4; dynamic overrides: 1 |
| `npm test` | **49 suites, 841 `PASS` lines, 0 FAIL, exit 0** (node + happy-dom tier) |
| npm-script audit | 68 `test:*` scripts; 49 in `npm test`; 19 of 21 `*:browser` scripts excluded; `node_modules` has no puppeteer/playwright |
| `.github/workflows` | absent — no CI |
| live gateway probe (earlier in Phase A, throwaway `DATA_DIR`, port 8895) | `/healthz` ok; `/roles` 5 roles + permission map; `/terminal` policy `{isolation:process, executables:[node,npm,npx], shell:false}`; `/browser/capabilities` `engine:null, status:unconfigured`; `/copilot/runtime` `configured:false, providerCount:26, configuredCount:0, streaming:false, costBasis:estimated`; `/voice` `localStt:false, localTts:false, allowRemoteHosts:false`; `/evolution/capabilities` `status:partial, defaultLevel:1, protected:12`; `/comms` 6 channels; budget `{5, 0.5, enforced:true}`; `/audit/verify` `{ok:true}`; `/summary` all zeros; 404 for `/skills /plugins /files /workflows /settings /analytics /features /capabilities /roadmap /health`; WS subscribe accepted 12 topics, `refused: []` |

## 8.2 Primary code references

- Client seams: `src/api.js` (106 paths) · `src/datastore.js:19,291,308` (slices, provenance, explanation) ·
  `src/core.js:139` (provenance defaults) · `src/auth.js` (`can`).
- Copilot client: `src/copilot/orchestrator.js:21-29` (modes), `:374-500` (create agent),
  `:499-565` (deploy swarm, local-only), `:570-620` (create task), `:627-712` (approvals),
  `:1048` (full Operate command list), `:1274` (suggestions).
- Copilot capability/knowledge: `src/copilot/capabilities.js` (`CAPS`, `getCapability`, `:312` dynamic
  `llm`) · `src/copilot/knowledge.js:13-17` (`PACK`), `app.overview` entry.
- Gateway Copilot: `apps/gateway/src/copilot.js:76-115` (`SYSTEM_PROMPT`), `:298-378` (`send`),
  `:161-180` (`runtimeStatus`).
- Governance: `apps/gateway/src/rbac.js` (`PERMISSIONS`, `ROLE_PERMISSIONS`, `canDecideApproval`) ·
  `apps/gateway/server.js:164-171` (route table), `:176-187` (WS filter), `:1755-1803` (approvals),
  `:2300-2312` (subscribe).
- Governed drafts: `apps/gateway/src/agentDrafts.js:76-218` · `swarmPlanDrafts.js` · `browserScriptDrafts.js`.
- Divergence evidence: `src/copilot/orchestrator.js:726-735` (honest refusal to fake a run) vs
  `src/views1.js:1229-1230` (swipe PATCHes status via `:1192`).
- Deprecated telegram view: `src/views2.js:964-969` (redirect) and `:1034-1055` (dead handlers) vs `apps/gateway/src/comms.js`.

---

# 9. Recommended implementation order (for later phases — nothing started)

Ordered so that each step is verifiable on its own and no step depends on an absent service.

**Phase B — registry and dispatcher (proposal)**
1. **Unify the state vocabulary** into one enum with a documented mapping from the three existing ones
   (§6). Small, testable, unblocks everything else.
2. **Declare operations, not routes.** A server-side catalogue derived from the route table plus explicit
   entries for the 6 screens and 5 operations that have no service, each with `status: 'no-service'`.
   Include permission, risk class, read-only/mutating, confirmation requirement, reversibility,
   idempotency, timeout, health requirement, audit requirement. Enforce it with a **drift test**: every
   route must be claimed by an operation, and every operation must map to a real route or the literal
   `no-service`.
3. **Serve it read-only** (`GET /capabilities`, role-filtered) and have the client capability cards read
   *one* source. Replace the 9 static statuses.
4. **Dispatcher core, no model.** One `execute(operationId, params, {principal, traceId, idempotencyKey})`
   that re-validates permission server-side, applies the risk/confirmation policy, writes an audit row,
   and returns a structured result. First operations, chosen because their contracts already exist and are
   tested: **tasks (create/move/assign), agents (create/update/delete), teams, approvals, swarm plans.**
5. **Migrate every client-Copilot executor that writes state** (agent create, swarm deploy, task create,
   kanban moves, approvals) onto the dispatcher, and delete the local-write paths — starting with swarm
   deploy, which currently violates Operator §4.3.
6. **Approval binding** (needed before any consequential operation is gated): bind a gate to
   `(operationId, paramsHash)`, add expiry and single-use; wire a generic hook so `allow` can execute.
7. **Idempotency + trace ids** on the dispatcher, reusing the `clientId` pattern from chat/drafts.

**Phase C — connect the model (after B)**
8. Structured-proposal protocol first (model proposes JSON; server validates; user confirms), then tool
   calling when `callModel` supports it. Keep the gateway `SYSTEM_PROMPT` truth list as the tone/honesty
   contract, and make it read the registry instead of restating it.

**Phase D — operator surface.** 9. Progress/cancel views driven by real operation records (§7.2 item 3).

**Phase E — coverage.** 10. Only after endpoints exist: skills, files, analytics series. 11. Remove or wire
the deprecated Telegram view. 12. Delete dead tables/permission and fix the WS allowlist.

**Phase F — hardening.** 13. Bring the 19 excluded browser suites into the default run (or a documented
second tier) with Chromium provisioned; add a CI workflow. 14. Regenerate the knowledge pack from the
release commit, with a test pinning it.

**Cross-cutting, do early:** fix `packages/shared/api-routes.json` (generate it from the route table, or
delete the pretence of it being a contract).

---

# 10. Questions and decisions requiring approval

Each question changes the Phase B design, so none was decided unilaterally.

| # | Question | Options | Recommendation |
| --- | --- | --- | --- |
| Q1 | **Which authority model for Copilot-initiated writes?** The client writes agents directly (`agent:write`); the gateway produces drafts needing a second principal. | (a) drafts for everything model-proposed, direct write only for explicit typed operator commands; (b) direct write everywhere; (c) drafts everywhere | (a) — preserves the spec's "capability ≠ authority" while keeping the operator's explicit command path fast |
| Q2 | **Where does the registry live?** | (a) gateway, served to clients; (b) client only; (c) both, with a drift test | (a), mirrored for offline with a version stamp |
| Q3 | **How is it derived?** | (a) introspect the route table at boot; (b) hand-declared + drift test; (c) generated file committed by a script | (b) now, (c) once the shape settles — introspection alone misses handler-level checks and the screens with no service at all |
| Q4 | **Should Copilot manage identity (principals, roles, tokens)?** No UI exists for either today. | (a) exclude in Phase B; (b) include as Owner-only consequential operations | (a) — highest blast radius, lowest value |
| Q5 | **One status vocabulary — which?** | `available / degraded / unconfigured / unavailable / blocked / no-service / demo` vs extending an existing one | Adopt a 7-state enum and map the three existing vocabularies onto it (§6.3) |
| Q6 | **Deprecated Telegram screen:** finish removing it? | (a) delete the view and let `#/telegram` land on the real comms channel; (b) rebuild it on the channel; (c) leave as-is | (a) — the redirect already does the work; deleting the dead handlers removes a shipped fake |
| Q7 | **Knowledge pack:** regenerate how? | (a) build-time generation from the repo + version test; (b) manual refresh each release; (c) drop it and rely on the registry | (a) |
| Q8 | **Verification tier:** 19 browser suites are outside `npm test` and Chromium is not installed here. | (a) provision Chromium and add them to the required gate; (b) keep them optional | (a) before Phase D (a UI-heavy phase) |
| Q9 | **Design Spec vs Operator "hologram" surface** — which is the Phase D target? | (a) the existing dock/panel with progress cards; (b) a new hologram surface per Operator §8 | (a) — the dock exists and is tested; a new surface is a redesign, not a wiring step |
| Q10 | **Model action channel:** structured proposals or provider tool calling? | (a) server-validated JSON proposals first; (b) wait for/implement tool calling in `callModel` | (a) — works with every provider today and keeps validation server-side |

---

# Appendix A — Files inspected

Extent: **F** = read in full · **S** = selected sections (the ones cited) · **M** = metadata/structure only.

**Client (`src/`)**
`main.js` S · `shell.js` S · `core.js` S · `api.js` S · `auth.js` S · `datastore.js` S ·
`copilot.js` S · `copilot/capabilities.js` F · `copilot/orchestrator.js` S · `copilot/knowledge.js` S ·
`copilot/conversation.js` S · `copilot/memory.js` S · `copilot/panel.js` S · `copilot/drafts.js` S ·
`copilot/plans.js` S · `copilot/scripts.js` S · `copilot/voiceInput.js` S · `copilot/jsonlInspection.js` S ·
`copilot/runtime.js` S · `views1.js` S · `views2.js` S · `kanban.js` S · `designer.js` S · `comms.js` S ·
`commsGateway.js` S · `commsChannels.js` S · `commsAdapters.js` S · `skillsData.js` S · `skillsImport.js` S ·
`local.js` S · `localRuntime.js` S · `evolution.js` S · `browser.js` S · `terminal.js` S ·
`voice/adapters.js` S · `gestures.js` S · `team-panel.js` S · `*.css` M

**Gateway (`apps/gateway/`)**
`server.js` S (route table, identity, agents, approvals, WS, summary) · `src/rbac.js` F ·
`src/copilot.js` S · `src/agentDrafts.js` S · `src/swarmPlanDrafts.js` S · `src/browserScriptDrafts.js` S ·
`src/models.js` S · `src/secrets.js` M · `src/chat.js` S · `src/teams.js` S · `src/swarms.js` S ·
`src/comms.js` S · `src/voice.js` S · `src/auth.js` M · `src/db.js` M · `src/seed.js` M ·
`src/browser/{driver,index,policy,runner,watchdog,loops}.js` S · `src/evolution/{index,sandbox,diff,policy,runner,workspace}.js` S ·
`src/terminal/{index,policy,runner}.js` S · `migrations/001-015` M (table/Ddl inventory)

**Shared** — `packages/shared/api-routes.json` F · `agentDraft.js`, `browserScript.js`, `swarmPlanDraft.js`,
`voiceEngines.js` M

**Docs** — `docs/FEATURE_COMPLETION_ROADMAP.md` S (§0–§3, §5 samples, §6 checklist, row index) ·
`docs/PROGRESS.md` S · `docs/PRODUCTION_ROADMAP.md` S · `docs/roadmap/next-up.md` S ·
`docs/copilot/{PHASE0_DISCOVERY,MISSION_VERIFICATION,hardening,conversation,skills-hub,agent-drafts,
swarm-plan-drafts,browser-scripts,voice-input,read-sync,copilot-governance-auth,copilot-ui-fab-panel}.md` S ·
`docs/terminal/*` S · `docs/comms/*` S · `docs/browser/*` S · `docs/evolution/SELF_MODIFICATION.md` S ·
`docs/local/*` S · `docs/voice/*` S · `docs/ui/responsive.md` S · `docs/DESIGN_SPEC.md` S · `README.md` S

**Specs (inputs, outside the repo)** — Operator Extension S (§1–§7, §12, §13) · Dynamic Feature Awareness
F · Design Spec S (architecture, phases, permissions, UI).

# Appendix B — Tests and checks run

| Check | Command | Result |
| --- | --- | --- |
| Full suite | `npm test` | **49 suites, 841 `PASS` lines, 0 failures, exit 0** (190 s) |
| Route extraction | helper script over `server.js` | 154 routes / 25 groups (§5.1) |
| Permission census | import `rbac.js` | 43 permissions; 5 role sets (§5.4) |
| Permission cross-reference | route metadata vs declaration | 2 handler-only, 1 unused (§8.1) |
| Schema census | `grep CREATE TABLE` over migrations | 43 + `schema_migrations` |
| Table usage | `grep` for `FROM` / `INTO` / `UPDATE` / `JOIN` per table | dead/seed-only list (§8.1) |
| Capability census | parse `CAPS` | 10 entries, 1 dynamic |
| Knowledge census | grep + `PACK` | 33 entries, pinned `repo:66b1bd3` |
| Contract file audit | parse `api-routes.json` | 12 groups, 5 `planned`, 2 stale names |
| npm-script audit | parse `package.json` | 68 `test:*` scripts; 49 in `npm test`; 19 of 21 `*:browser` scripts excluded |
| CI presence | `ls .github/workflows` | absent |
| Live gateway probe | throwaway `DATA_DIR`, port 8895 | payloads in §8.1 |

**Not run:** the 19 excluded browser suites (`puppeteer` not installed; no Chromium). Every claim about
real-browser layout, 320 px rendering, gestures, motion and service-worker lifecycle is therefore
**⚠ UNVERIFIED** here and stays in Appendix C.

# Appendix C — What could not be verified

1. **Live-provider behaviour** of comms, the model gateway and (in this environment) the Agent Browser — no
   credentials, no Chromium.
2. **Browser-tier UI claims** — 19 suites excluded; see Appendix B.
3. **Agent status flip / approvals / swarms round-trip against seeded data.** The probe ran on an
   *unseeded* database: list endpoints returned 0 rows and the agent-status-flip check was skipped by its
   `if (agents.length)` guard. No conclusion in this document rests on that probe alone — the shapes it
   would have exercised are asserted by the gateway suites in `npm test` — but the seeded round trip itself
   stays unverified.
4. **Production/multi-user behaviour** — sessions, rate limits, token revocation under concurrency are
   asserted by tests, not observed in a deployment.
5. **The Design Spec** was read selectively; where it conflicts with the Operator Extension (§1.3 S6) the
   conflict is reported, not resolved.
6. **Evolution sandbox isolation** is process isolation, not a container; the probe's own capability report
   says network/filesystem-outside-workspace/CPU are "notEnforced". Whether that is acceptable is a
   governance decision, not a factual gap.

---

## Completion statement

Phase A is **complete** against the Operator Extension's exit criterion: every major module has been
inspected (38 modules, 43 user-visible operations), each operation is mapped to a real route or to the
literal fact that no service exists, and **nothing is marked available without a real implementation
path** — 6 screens and 5 documented API operations are explicitly reported as having no backend.

**Deliverable status: complete, with the verification limits in Appendix C.**
No code, schema, test, UI, demo feature or behaviour was changed. The only file written is this document.

**Stopping here. Phase B (capability registry and dispatcher) has not been started and will not start
without your approval** — including answers to the ten questions in §10.
