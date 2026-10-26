# Copilot — Phase 0 Repository Discovery & Contracts

| Field | Value |
| --- | --- |
| Spec | `Copilot_Master_MMM_V2.md` v1.0 (2026-10-25) |
| Repository | `shawnthedon/MMM` (SwarmOS) |
| Baseline commit | `66b1bd3` on `main` |
| Discovery date | 2026-10-26 |
| Author | Coding agent |
| Status | Evidence recorded; Phase 1 landed on top of this baseline |

This is the report required by §16 of the master specification ("First Action for the
Coding Agent"). It records **what exists today**, verified by reading the files named in each
row. Nothing here is an assumption about intended behaviour; where a capability is described
only in a document, it is marked `documented` and **not** claimed as working.

---

## 1. Existing Copilot entry point and UI files

| File | Role | Verified state |
| --- | --- | --- |
| `src/copilot.js` | Copilot dock/sheet + rule-based intent engine + action cards | Present, 317 lines. Opened from the bottom **dock** strip and a `copilot-open` action. Original entry point is a dock, not a FAB in the bottom-nav centre. |
| `src/shell.js` | App chrome: topbar, `<main id="view">`, floating `+` FAB (quick create), Copilot dock, 5-slot tab bar, generic `openSheet()` / `confirmModal()` / toast helpers, global `[data-act]` event delegation | Present. Tab bar slots: `home · agents · tasks · chat · more`. |
| `src/main.js` | Hash router, re-render on store change, simulation ticker, PWA registration, offline banner, dock hint rotation | Present. |
| `src/core.js` | Store (`localStorage` key `swarmos-state-v1`), seeded demo data, icons, formatting helpers | Present. |
| `src/terminal.js` | In-app terminal that can call `copilotSay()` and `window.__copilotChip()` | Present. |
| `src/views1.js`, `src/views2.js` | 13 module views (home, agents, teams/swarms, tasks, chat, skills, models, plugins, telegram, analytics, artifacts, terminal, settings) | Present. |

**Consequence for the spec:** the existing Copilot is a bottom sheet without mode switching,
context strip, holographic empty state, layered memory, knowledge retrieval, capability
reporting, or a FAB in the central navigation slot. Phase 1 therefore replaces the entry
point and the panel internals while keeping every integration point
(`openCopilot`, `copilotSay`, `window.__copilotChip`, the `copilot-open` action) working.

## 2. Current application stack and conventions

- **Build:** Vite 6 (`vite.config.js`), plain ES modules, no framework, no TypeScript.
- **UI:** server-rendered-by-string HTML into `#view`; one delegated `click` listener for
  `[data-act]` in `src/shell.js`; views export `{ render(params), mount(params) }`.
- **State:** single mutable object + subscribe/commit in `src/core.js`; persisted to
  `localStorage` (debounced 250 ms), **device-local demo data**.
- **Styling:** one hand-written stylesheet `src/styles.css` with design tokens
  (`--brand`, `--surface`, radii, `--tabbar-h`, `--safe-b`) and a `[data-theme='light']` /
  `[data-density='compact']` override. Mobile-first; desktop is an enhancement layer.
- **Accessibility already in place:** `aria-label` on icon buttons, `:focus-visible` outline,
  `prefers-reduced-motion` guard for the DAG/boot/pulse animations.
- **Tests:** `npm run smoke` boots the real app in `happy-dom`, renders every view, and
  exercises the terminal and legacy Copilot API. CSS imports are stubbed by
  `scripts/register-css-stub.mjs`.
- **Icons:** inline SVG map in `src/core.js` (`icon(name, size)`); no icon dependency.

## 3. Existing services and integration contracts

| Service | Reality in this repo | Evidence |
| --- | --- | --- |
| Gateway REST/WS | `apps/gateway/server.js` (Node `http` + `ws` + `better-sqlite3`), port `8787`: `/healthz`, `/api/v1/summary`, `agents`, `tasks`, `approvals`, `events`, `audit/verify`, `dev/seed`, `WS /ws`. CORS `*`. **No auth/RBAC** — file header says "Auth/RBAC arrives in Phase 3". | `apps/gateway/server.js:1-60`, `packages/shared/api-routes.json` |
| Database | SQLite (WAL) with 17 tables, migration runner, hash-chained `audit_log`, `npm run audit:verify`. | `apps/gateway/migrations/001_init.sql`, `apps/gateway/src/db.js`, `docs/PROGRESS.md` |
| Frontend ↔ gateway | **Not wired.** The PWA renders seeded fixtures from `core.js`; `docs/PROGRESS.md` lists "2.5 Frontend switch to API mode" as not started. | `src/core.js:seed()`, `docs/PROGRESS.md` |
| Agent/task runtime | None. Agent "running" status and swarm progress come from seeded demo state and a `setInterval` simulation in `src/main.js`. | `src/main.js:74-113` |
| Model gateway (real LLM calls) | None. Providers/model catalogue is demo data. | `docs/PROGRESS.md` Phase 6 ⬜ |
| Knowledge service | None (this change adds a read-only, versioned, source-linked pack + search). | — |
| Memory service | None (this change adds browser-scoped layered memory with redaction). | — |
| Training backend | None. No worker, queue, dataset decoder, or model registry. | `docs/PROGRESS.md` Phase 5 ⬜ |
| Voice service | None. No engine adapter, no audio pipeline. | — |
| Communication gateway | Telegram screen is a UI simulation only (`src/views2.js`); no outbound transport. | `src/views2.js:400-530` |
| Browser control | None. | — |
| Governance | Audit chain exists server-side; approval gates exist as **client-side demo** objects in `state.approvals`. | `src/shell.js:notificationsSheet`, `apps/gateway/src/db.js` |
| File/artifact service | `state.files` metadata + inline text content; no binary storage or upload. | `src/core.js:files` |

## 4. Requirement coverage (before this change)

| Requirement (§ of spec) | Status | Note |
| --- | --- | --- |
| §2.1 FAB in central bottom-nav slot | **absent** | Launcher is a dock strip; separate `+` FAB floats above it. |
| §2.2 floating panel, state preservation | **partial** | `openSheet()` sheet; draft is lost on close. |
| §2.3 compact component-driven layout | **partial** | Thread + action cards only; no modes, context strip, tray, drawer. |
| §2.4 holographic empty state | **absent** | No blank-state derivation or decorative layer. |
| §2.5 interactive card catalogue | **partial** | Only "action card" (rows + confirm/cancel) and text answers. |
| §3 modes | **absent** | Settings stores a `copilotMode` string (`ask/act/build/analyze`) that nothing reads. |
| §4 grounded knowledge + sources | **absent** (added here, read-only) | |
| §5 layered memory | **absent** (added here, browser-scoped subset) | |
| §6.1 agent management via runtime | **demo only** | Mutates local demo state; not runtime-confirmed. |
| §6.2/6.3 swarm execution + evidence | **demo only** | Simulation ticker drives progress. |
| §7 training studio | **blocked** | No backend; capability card added instead of fake success. |
| §8 voice studio + singing | **blocked** | Candidates unverified; consent gate not implementable without storage/backends. |
| §9 OpenSMS + communication gateway | **blocked/unconfigured** | Needs server-side secret + verified topology; see blockers. |
| §10 browser control | **blocked** | No adapter; not reviewed in this environment. |
| §11 governance | **client-side demo** | Risk classes + explicit confirm added; server-side enforcement impossible until auth/RBAC lands. |
| §11.2 secret redaction / demo-vs-live separation | **partial → improved** | Panel now labels demo data and redacts secret-like strings before memory writes. |

## 5. Blockers requiring a decision (do not guess)

1. **Server-side Copilot.** Grounding, memory, approvals and audit must be enforced in a
   backend (§11, §12). The gateway has no auth/RBAC yet (`docs/PROGRESS.md` 3.4 ⬜), so the
   Copilot implemented here is explicitly a **client-side, demo-mode** surface. Consequential
   actions are confirmed in the UI and recorded locally; they are **not** server-enforced.
   Decision needed: land gateway auth/RBAC (3.4) before any Copilot action is treated as
   governed.
2. **Frontend ↔ gateway contract.** Nothing in the PWA calls `:8787` today. The panel probes
   `/healthz` and reports `reachable` / `unreachable` truthfully, but no data is read from the
   gateway. Decision needed: approve the API client + auth token strategy (Phase 2.5 / 3.4)
   before wiring agents/tasks/approvals to the runtime.
3. **Training backend.** No queue, worker, dataset decoder or model registry exists. Any
   "training" UI without these would be simulated. The Copilot Training mode therefore reports
   `BLOCKED` and offers **real, local dataset validation** over File Manager entries only.
   Decision needed: pick a backend (e.g. a worker process + adapter) before Phase 4.
4. **Voice engines.** The three candidates named in the spec (Local TTS, NeuTTS, OpenVoice)
   were **not** inspected in this environment (outbound network is restricted), so licence,
   maintenance, mobile runtime support and — critically — singing capability remain
   `unverified`. No generation path is offered. Decision needed: verify each upstream
   repository and licence, then approve an adapter.
5. **OpenSMS.** The master spec records a source review (Apache-2.0, FastAPI `POST /sms/` on
   port 9292, Bearer auth, `/control/` unauthenticated and not a real remote start/stop). This
   environment could not re-verify the upstream release. The integration is **not**
   implemented: an API key must never live in browser JavaScript, and HTTPS→HTTP private-network
   reachability is unverified, so a server-side proxy + on-device test is a prerequisite.
6. **Browser-control "stealth".** No candidate review was possible; nothing is enabled. Only
   authorised automation is in scope (§10).

## 6. File-level implementation sequence (with tests and evidence)

| Increment | Files | Verification |
| --- | --- | --- |
| **P1.1 Launcher** — Copilot FAB becomes the centre slot of the tab bar; remove the duplicate dock and the floating `+` (quick-create moves into Copilot's tray and More) | `src/shell.js`, `src/main.js`, `src/copilot.css` | `npm run smoke` checks tab-bar shape, FAB `aria-label="Open Copilot"`, absence of `.dock` |
| **P1.2 Panel** — floating panel, mobile bottom sheet / desktop card, header runtime status, context strip, minimise/close, Escape, focus trap + restore, draft persistence | `src/copilot/panel.js`, `src/copilot/memory.js` | smoke: open → Escape → reopen keeps draft; `aria-expanded` toggles |
| **P1.3 Holographic blank state** — derived from real UI state, fades out on first substantive message, `aria-hidden`, `pointer-events:none`, reduced-motion path | `src/copilot/panel.js`, `src/copilot.css` | smoke: `data-blank` flips after a message; layer has `aria-hidden="true"` |
| **P1.4 Modes** — Ask / Operate / Build / Knowledge / Training / Voice / Activity, active mode always visible, unavailable modes explain why | `src/copilot/orchestrator.js`, `src/copilot/capabilities.js` | smoke: selecting Training renders a `BLOCKED` capability card, no fake job |
| **P1.5 Grounded knowledge** — versioned, source-linked pack + hybrid keyword search with status labels | `src/copilot/knowledge.js` | smoke: search returns sources and a verification status; unknown query admits ignorance |
| **P1.6 Layered memory** — working draft, episodic actions, preferences, secret redaction, delete/export | `src/copilot/memory.js` | smoke: draft survives reopen; episode appended after a confirmed action; secret-like input redacted |
| **P1.7 Cards** — answer/refs, proposal with review-edit-approve-cancel + expiry + two-step consequential confirm, result with steps, diagnostic, knowledge, approval, capability, activity | `src/copilot/orchestrator.js`, `src/copilot/panel.js` | smoke: consequential proposal needs two confirmations; legacy `copilotSay(text, card)` still works |
| **P1.8 Runtime truth** — `/healthz` probe, demo-data labelling, offline state | `src/copilot/runtime.js` | smoke: runtime chip present, failure path yields `unreachable` |
| **Docs** | `docs/copilot/PHASE0_DISCOVERY.md`, `docs/copilot/copilot-ui-fab-panel.md`, `docs/PROGRESS.md`, `README.md` | Reviewed against implemented file names |
| **Tests** | `scripts/smoke.mjs` (28 checks), `scripts/copilot-tour.mjs` (6 interaction checks) | `npm test` → both suites green |

Later phases (§13) are deliberately **not** started: each needs a blocker above resolved
first. The capability registry exposes their status in-product so the UI never implies a
feature that does not exist.

## 7. Known limitations of the Phase 1 increment

- All mutations act on `localStorage` demo state. Nothing is sent to, or confirmed by, the
  gateway. Cards say so ("demo runtime") rather than implying execution.
- The knowledge pack is a static, reviewed snapshot tied to commit `66b1bd3`; there is no
  ingestion, editing, revision or approval workflow yet (§4.3 → Phase 2).
- Memory is per-browser and not shared across devices; there is no retention enforcement
  beyond a 50-episode cap and no server audit trail.
- No LLM is called. Answers come from deterministic retrieval + live app state. The spec's
  "AI" answer generation and tool-calling router remain Phase 2/9 work.
- Approval enforcement is UI-level only (self-approval is blocked by construction, but a
  determined client can mutate `localStorage`). Server enforcement is blocker #1.
