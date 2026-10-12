# SwarmOS — Design Specification
## Mobile-First AI Agent Orchestration Dashboard

| Field | Value |
| --- | --- |
| Document | Design Specification (UI/UX + Systems) |
| Codename | **SwarmOS** (working title) |
| Version | 1.0 |
| Date | 2026-10-12 |
| Status | Draft for build |
| Audience | Product, Design, Frontend, Backend, Security, QA |
| Delivery target | Self-hosted, single-gateway, mobile-first web app (PWA) |

---

## 1. Executive Summary

**SwarmOS** is a mobile-first control plane for creating, deploying, and governing teams and swarms of AI agents. It unifies:

- **Agent engineering** — advanced agent profiles across seven selectable frameworks (Swarmzero, AutoPentest, A.I.M.A, Project Nautilus, OpenAI Swarm, CrewAI, LangGraph), each runnable with any LLM from a 25+ provider model gateway.
- **Swarm operations** — parallel execution with dependency graphs, resource allocation, live task telemetry, and a Kanban surface for human-in-the-loop work.
- **OpenClaw runtime** — a skills system, tool/MCP integrations, multi-model routing, and a Telegram command layer so agents can act and be steered from any messaging platform.
- **Self-improvement** — a Self-Improving Agent Loop with tiered memory and machine-learning optimization: agents synthesize new skills, refine their own prompts, and optimize tool selection from execution history.
- **Trust & Governance** — a four-layer security framework with per-agent trust scores, full MCP call auditing, and configurable approval gates.
- **Embedded Copilot** — an in-app AI assistant with *full control capabilities* over the application itself (create agents, deploy swarms, change settings, run terminal commands — always subject to governance gates).

The entire system runs on a **self-hosted gateway with zero external dependencies**: SQLite storage, embedded job queue, filesystem artifacts. **No Redis, no Postgres, no external orchestrator required.** Optional outbound MCP/plugin connections (GitHub, Supabase, Firecrawl, Vercel, Airtable, Base44) are user-configured, not required.

---

## 2. Goals & Non-Goals

### 2.1 Goals
1. **Mobile-first, not mobile-also.** Every core workflow is completable on a 360 px viewport with one thumb. Desktop is an enhancement layer (master–detail, multi-pane, denser data).
2. **Full-lifecycle control.** Build agent → attach skills/tools → team it → deploy swarm → watch execution → approve gated actions → audit everything → iterate.
3. **Any model, any agent.** Per-agent model selection across cloud, local, and enterprise providers with routing policies, fallbacks, and cost budgets.
4. **OpenClaw everywhere.** Skills + tools + messaging surfaces (Telegram first; Slack, Discord, WhatsApp via adapters) with a consistent command grammar.
5. **Safe autonomy.** Self-improvement and swarm actions are powerful; the Trust & Governance layer makes them auditable, reversible where possible, and human-gated where necessary.
6. **Zero-dependency self-hosting.** One gateway process, one SQLite database, one artifact directory. Backup = copy two things.

### 2.2 Non-Goals (v1)
- Multi-tenant SaaS control plane (single deployment = single org; multi-workspace is v2).
- Training foundation models from scratch (we fine-tune adapters/prompt policies only).
- Mobile native apps (PWA + responsive web first; native shells later).
- Guaranteed compatibility with proprietary agent frameworks not listed in §13.

---

## 3. Users & Personas

| Persona | Device | Needs | Success signal |
| --- | --- | --- | --- |
| **Maya — Solo AI Engineer** | Phone (primary), laptop | Spin up agent teams fast, test skills, control costs | Deploys a 5-agent swarm from phone in < 10 min |
| **Devon — Platform/Ops Lead** | Phone (triage), desktop (deep work) | Reliability, governance, resource caps, audit trails | Zero unapproved privileged actions in 30 days |
| **Sam — Security Researcher** | Phone + desktop | AutoPentest agents, approval gates, MCP audit | Every exploit-sim step gated & logged |
| **Priya — No-code Builder** | Phone | Templates, marketplace plugins, copilot-driven setup | Builds a content pipeline with Base44 + Firecrawl via chat |
| **Omar — Executive/Observer** | Phone | Read-only analytics, spend, trust posture | Daily digest via Telegram |

---

## 4. Design Principles

1. **Thumb-first.** Primary actions live in the bottom 40% of the viewport. Top bars hold context, not commands.
2. **Progressive disclosure.** Simple by default; expert controls behind "Advanced" affordances and long-press menus.
3. **Status at a glance.** Every agent/team/swarm carries semantic color: state, health, trust tier. Glanceable in < 2 seconds.
4. **Streaming everything.** Agent output, terminal output, execution events — all progressive; never a spinner where a stream exists.
5. **Reversible by default.** Destructive actions require confirmation + are journaled (undo where technically feasible).
6. **Copilot as a peer operator.** The copilot is not a help widget; it is a first-class operator with the same powers as the user — and the same gates.
7. **Honest empty states.** Every empty screen offers a create/template action or copilot shortcut.
8. **Calm density.** Mobile lists are scannable; charts are legible at 320 px; tables become card stacks.

---

## 5. Information Architecture

### 5.1 Sitemap

```
App Shell (PWA)
├── Home / Command Deck (dashboard landing)
├── Agents
│   ├── Agent List
│   ├── Agent Profile (tabs: Overview · Brain · Tools · Skills · Memory · Trust · Logs)
│   └── Agent Creator (5-step wizard)
├── Teams & Swarms
│   ├── Team List / Templates
│   ├── Team Builder (topology canvas)
│   ├── Swarm Deploy Sheet
│   └── Live Swarm Monitor (DAG + resource lanes)
├── Tasks (Kanban)
│   ├── Board View (columns, swimlanes)
│   ├── Dependency Graph View
│   └── Task Detail (sheet)
├── Skills Hub
│   ├── Installed / Marketplace / Mine (self-written)
│   ├── Skill Detail
│   └── Skill Editor + Test Sandbox
├── Model Gateway
│   ├── Providers & Keys
│   ├── Routing Policies
│   ├── Budgets & Rate Limits
│   └── Live Usage
├── Plugins (MCP Marketplace)
├── Chat (threads, channels, approvals)
├── Telegram Bridge
├── Analytics
├── Artifacts & Files
├── Terminal
├── Settings
└── Copilot (overlay, available everywhere)
```

### 5.2 Navigation Model (Mobile)

- **Bottom Tab Bar (5 slots):** `Home · Agents · Tasks · Chat · More`.
- **"More" Sheet:** full module grid (Skills Hub, Model Gateway, Plugins, Telegram, Analytics, Artifacts, Terminal, Settings).
- **FAB (Floating Action Button):** context-sensitive create (new agent / new task / new thread / deploy swarm). Long-press FAB → radial quick-create menu.
- **Copilot Dock:** persistent pill above the tab bar (collapsed) → expands to full-height sheet (expanded). Always reachable with one thumb.
- **Gestures:** swipe-right on list items = quick actions (run, pause, archive); pull-to-refresh on all feeds; swipe down on full-screen sheets to dismiss; long-press = context menu.
- **Deep links:** every entity has a stable URL (`/agents/:id`, `/swarms/:id/live`) for sharing into Telegram and copilot citations.

### 5.3 Desktop Adaptation (≥ 1024 px)
- Left icon rail + persistent secondary nav; master–detail panes; multi-panel Live Monitor (DAG + logs + resources side-by-side); keyboard shortcuts (`⌘K` command palette = copilot, `g a` → Agents, etc.).

---

## 6. Responsive & Mobile-First Strategy

| Breakpoint | Layout | Notes |
| --- | --- | --- |
| 360–413 px (S) | Single column, bottom sheets, stacked cards | Baseline target; nothing may overflow |
| 414–767 px (M) | Single column, wider sheets, 2-up stat tiles | Most phones |
| 768–1023 px (L) | 2-pane where useful (list + detail sheet) | Tablets portrait |
| 1024–1439 px (XL) | Master–detail, side rail, floating panels | Desktop |
| ≥ 1440 px (XXL) | Multi-panel consoles, optional code panels | Command centers |

Rules:
1. All touch targets ≥ 44×44 px with ≥ 8 px separation.
2. No hover-only affordances; every hover state has a tap/long-press equivalent.
3. Tables convert to **card stacks** below 768 px (label: value rows) with a "compare" multi-select mode.
4. Charts use compact variants (sparklines, single-series) on S/M; full multi-series dashboards on L+.
5. The terminal and code editors use full-bleed landscape mode on phones (rotate hint), with an accessory toolbar (ESC, TAB, Ctrl, /, arrows) above the keyboard.
6. Safe-area insets respected (notch, home indicator); bottom nav sits above `env(safe-area-inset-bottom)`.
7. PWA: installable, offline shell, background sync for queued actions (see §24).

---

## 7. Design System Foundations

### 7.1 Color Tokens (Dark default; Light theme provided)

| Token | Dark | Light | Usage |
| --- | --- | --- | --- |
| `bg/base` | `#0B0F17` | `#F7F9FC` | App background |
| `bg/surface` | `#121826` | `#FFFFFF` | Cards, sheets |
| `bg/elevated` | `#1A2234` | `#FFFFFF` + shadow | Modals, menus |
| `text/primary` | `#EAF0FA` | `#0E1524` | Headings, primary text |
| `text/secondary` | `#93A1BA` | `#5A6880` | Descriptions |
| `brand/primary` | `#6C8CFF` | `#3B5BFF` | CTAs, active nav |
| `brand/accent` | `#22D3EE` | `#0891B2` | Copilot, live/streams |
| `state/success` | `#34D399` | `#059669` | Healthy, done |
| `state/warning` | `#FBBF24` | `#D97706` | Degraded, pending approval |
| `state/danger` | `#F87171` | `#DC2626` | Failed, blocked |
| `state/running` | `#818CF8` | `#4F46E5` | Executing |
| `trust/tier-a` | `#34D399` | `#059669` | Trust ≥ 80 |
| `trust/tier-b` | `#FBBF24` | `#D97706` | Trust 50–79 |
| `trust/tier-c` | `#F87171` | `#DC2626` | Trust < 50 / quarantined |

### 7.2 Typography
- UI font: **Inter** (or system-ui stack); Mono: **JetBrains Mono** / `ui-monospace`.
- Scale (mobile): 12 / 13 / 15 / 17 / 20 / 24 / 30 / 36. Body = 15 px, minimum = 12 px (labels only). Line height 1.45 body, 1.2 headings.

### 7.3 Spacing, Radius, Elevation
- Spacing scale: 4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48.
- Radii: 8 (chips) / 12 (cards) / 16 (sheets) / 24 (modals) / 999 (pills).
- Elevation: 3 levels (resting card, sheet, modal); dark theme uses surface steps + 1 px borders instead of heavy shadows.

### 7.4 Motion
- Standard easing `cubic-bezier(0.2, 0.8, 0.2, 1)`; durations 120 ms (micro), 200 ms (sheets), 320 ms (page transitions).
- Streaming text uses subtle fade-in per token; skeleton shimmer ≤ 1.2 s loop.
- `prefers-reduced-motion` disables shimmer, parallax, and animated DAG edges (static arrows).

### 7.5 Iconography & Haptics
- Outline icon set, 24 px grid, 2 px stroke. Status icons pair color with shape (never color alone).
- Haptics (PWA where supported): light tick on toggle, success pulse on deploy, warning double-tick on approval request.

---

## 8. Core Interaction Patterns

| Pattern | Where | Behavior |
| --- | --- | --- |
| **Command palette / Copilot** | Global (`⌘K` / dock tap) | Natural language → app actions; shows inline "intent chips" before execution |
| **Radial quick-create** | FAB long-press | 5 actions around FAB thumb arc |
| **Swipe actions** | All lists | Right: primary (Run/Pause); Left: Archive/Delete (destructive requires hold) |
| **Drag & drop** | Kanban, Team Builder, DAG reorder | Long-press 250 ms to lift; haptic at drop; snap-to-column |
| **Inline approval cards** | Chat, Task detail, Telegram | Deny / Allow once / Allow & remember (scope picker) |
| **Optimistic UI** | All mutations | Immediate reflect; rollback toast with "Retry" on failure |
| **Pull-to-refresh** | Feeds | Shows last-updated timestamp chip |
| **Split sheets** | Entity detail | Half sheet (peek) ↔ full sheet (drag handle 3-stop snap) |
| **Live stream affordance** | Runs, terminal | "LIVE" pulse badge; tap = jump to tail; freeze = scroll up auto-pauses tailing |
| **Compare mode** | Lists/tables | Multi-select → side-by-side card compare (max 3 on mobile) |

---

## 9. Global Shell

### 9.1 Top Context Bar (mobile)
Left: workspace switcher + connection dot (gateway healthy / degraded / offline). Center: current screen title + entity status pill. Right: notifications bell (badge = pending approvals count), avatar.

### 9.2 Notification Center
Grouped: **Approvals** (actionable inline), **Runs** (failures, completions), **System** (gateway, backups), **Trust** (score changes, quarantine events). Each notification deep-links to source. Actions: Approve/Deny inline without opening the app screen.

### 9.3 Offline & Degraded States
- Banner under top bar: "Offline — N queued actions will sync" with tap-to-review queue.
- Gateway-down: read-only cached data + retry countdown + Telegram fallback notice ("Control has moved to Telegram bridge").

### 9.4 Global Search
Indexed across agents, teams, tasks, skills, plugins, files, chat, audit log. Result grouping with type chips. Search query can be escalated to Copilot ("Ask Copilot instead").

---

## 10. Embedded AI Copilot (Full-Control In-App Assistant)

### 10.1 Role & Positioning
The Copilot is a **first-class operator** embedded in every screen. It can perform (almost) anything the user can: create agents, assemble teams, deploy swarms, edit skills, change settings, run terminal commands, manage files, install plugins, and query analytics — always through the same governance gates as human actions.

### 10.2 UI Anatomy (expanded sheet)
1. **Header** — model selector (per-conversation), scope chip ("Current: Swarm Monitor"), token/cost meter, minimize.
2. **Thread** — interleaved conversation, action cards, diffs, charts, approval cards, artifacts.
3. **Context strip** — auto-attached context chips (open screen, selected entities, recent runs) with removable chips + "Add context" (pick entity/file/log range).
4. **Composer** — text, voice (push-to-talk), attach file/URL, mode selector: `Ask · Act · Build · Analyze`.
5. **Action cards** — every consequential action renders as a card: description, target entities, diff/preview, risk level, gate status, `Confirm · Edit & run · Cancel`.

### 10.3 Capability Model (Intent Router)

| Capability | Examples | Gate |
| --- | --- | --- |
| Query & explain | "Why did agent-7 fail?" | None |
| Navigation | "Open the DAG for today's swarm run" | None |
| Create/update | "Create a research agent with Firecrawl + GPT-5" | Confirm if > N resources or paid model |
| Execute | "Deploy the triage team to prod" | Approval gate (deploy = always confirm) |
| Governed ops | "Approve the pending Vercel deploy from agent-3" | Trust policy + role check; never auto-approves *its own* requests |
| Destructive | "Delete swarm and purge artifacts" | Typed confirmation ("DELETE") + audit |
| Terminal | "Tail the gateway log" | Sandbox profile; dangerous commands gated |
| Self-improvement | "Let the refactor agent rewrite its own prompt" | Requires `self.improve` permission; diff review recommended |

### 10.4 Safety Architecture
- **Intent → Plan → Confirm → Act → Report.** Plans are structured (JSON tool calls), rendered as human-readable cards.
- **No ambient authority.** Copilot executes with an explicit *principal* = the user + a scoped session token; every app mutation is attributed to "User via Copilot" in the audit log.
- **Self-approval ban.** Copilot can never approve its own or an agent's approval-gate request; a human (or a separate governance bot with explicit delegation) must approve.
- **Scoped sessions.** User can pin copilot scope: "Only this swarm", "Read-only", "Full app".
- **Prompt-injection defense.** Copilot treats agent output/tool results as untrusted content; instructions embedded in fetched content are stripped/quoted; cross-origin content cannot expand copilot permissions.
- **Dry-run mode.** Global toggle: copilot plans all actions and produces a runbook without executing.

### 10.5 Conversation Memory
Per-thread memory + workspace-level memory store (opt-in). Memory items are user-visible ("What Copilot remembers") and editable/deletable — mirrors agent memory governance (§14.2).

### 10.6 Voice & Push-to-Talk
Hold mic = record; release = transcribe → intent preview → confirm → act. Always shows the recognized intent before acting. Hands-free mode ("Hey SwarmOS" wake is optional, local-only).

### 10.7 Copilot Surfaces
- Dock (global), inline "sparkle" buttons on empty states and error states, `/copilot` in chat threads, Telegram `/copilot <msg>`, terminal `swarm copilot` command.

---

## 11. Module Specifications (12 Modules)

> Every module includes: purpose, mobile layout, key components, states (empty/loading/error/offline), permissions, and analytics events.

---

### 11.1 Module 1 — Agent Manager (Advanced Agent Profiles)

**Purpose.** Create, configure, version, and operate individual agents with deep profiles: framework, brain (model), tools, skills, memory, self-improvement policy, and trust posture.

**Mobile layout.**
- *List:* search + filter chips (framework, status, trust tier, model); card rows: avatar/glyph, name, framework badge, model chip, status pulse, trust tier dot, last-active. Swipe: Run / Pause / Duplicate.
- *Profile (tabs):*

| Tab | Contents |
| --- | --- |
| **Overview** | Identity card (name, role, description, avatar), status, uptime, success rate, cost today, quick actions (Run, Pause, Clone, Deploy to team) |
| **Brain** | Framework picker (7 frameworks), system prompt editor (versioned, diff view), model picker (any provider/model), temperature/top-p/seed, context window strategy, fallback model chain, token & spend budget |
| **Tools** | Enabled MCP tools & native tools, per-tool permission scopes, rate limits, allow/deny lists, test-run button per tool |
| **Skills** | Installed skills with versions, auto-load rules, skill invocation priority, "Learn new skills" policy toggle |
| **Memory** | Working / episodic / semantic / vector stores, retention sliders, redaction rules, "forget" tools, memory inspection search |
| **Trust** | Live trust score gauge (0–100), factor breakdown, approval-gate policy, capability grants (deploy, network, filesystem, spend), quarantine history |
| **Logs** | Filterable run log, MCP call trace, prompt/response viewer (redacted), export |

**Agent Creator wizard (5 steps):** ① Identity & role → ② Framework + topology defaults → ③ Brain (model + params + budget) → ④ Tools & skills (marketplace picks) → ⑤ Governance (trust seed, gates, deployment target). Progress persisted; "Copilot, fill this for me" shortcut.

**Advanced profile features.**
- **Prompt versioning:** semantic versions, changelog, A/B harness (run same test set across versions), rollback.
- **Model matrix:** per-agent override of workspace default model; time-of-day routing (cheap model at night); "escalate to frontier" on low-confidence trigger.
- **Personality & behavior:** verbosity, risk appetite (conservative/balanced/aggressive), autonomy level (L0 ask-always → L4 full-auto within gates), working hours, loadout presets ("Researcher", "Pentester", "SRE", "Content").
- **Cloning & templates:** clone as template; export/import agent profiles as JSON bundles.

**States.** Empty: starter templates + copilot CTA. Loading: skeleton cards. Error: inline retry + last-known cache badge. Offline: read-only with queued edits chip.

**Permissions.** `agent.read`, `agent.write`, `agent.run`, `agent.delete`, `agent.self_improve` (separate!). Delete = soft-delete with 30-day restore.

**Events.** `agent_created`, `agent_updated`, `agent_prompt_published`, `agent_model_changed`, `agent_cloned`, `agent_deleted`, `agent_quarantined`.

---

### 11.2 Module 2 — Team Orchestrator (Teams & Swarms)

**Purpose.** Compose agents into teams; deploy swarms (1–N teams + shared resources) with topologies, goals, and budgets; monitor live orchestration.

**Concepts.**
- **Team** = named set of agents + role graph (lead, workers, critics, gatekeepers) + shared skill/tool policy.
- **Swarm** = a deployed instance: team(s) + objective + runtime config (parallelism, budget, model routing, gate policy) + target channel (app/Telegram/webhook).
- **Topology presets:** Hierarchical (supervisor→workers), Peer mesh (handoffs), Pipeline (staged), Debate (proposer/critic), Marketplace (auction task allocation), Custom DAG.

**Mobile layout.**
- *Team list:* cards with member avatars stack, topology glyph, health, active swarms count.
- *Team Builder:* vertical canvas on mobile (nodes = cards, edges = drag-to-connect handles); pinch-zoom canvas on tablets; role editor sheets; "Auto-balance" (copilot proposes topology for a goal).
- *Deploy Sheet (bottom sheet, 4 sections):* Objective (goal text + success criteria + max runtime) → Resources (parallel slots, token & $ budget, model policy) → Governance (gate policy template: e.g., "Gate all writes") → Target (schedule now/cron, channel, notifications). Big **Deploy** button with cost estimate chip.
- *Live Swarm Monitor:* header (status, elapsed, spend vs budget, progress ring); tab bar: **Graph · Tasks · Agents · Resources · Log**. Graph tab = compact DAG (see §15.3); tapping nodes opens inline node sheets.

**Swarm lifecycle:** `draft → deploying → live → paused → completed / failed / cancelled`. Pause freezes workers at safe checkpoints; cancel escalates through gate policy for in-flight privileged actions.

**Templates.** Curated team templates ("Research Squad", "AutoPentest Cell", "Content Pipeline", "SRE On-Call Crew", "Data ETL Swarm") — one-tap deploy with guided objective.

**Events.** `team_created`, `team_updated`, `swarm_deploy_started`, `swarm_deployed`, `swarm_paused`, `swarm_completed`, `swarm_budget_warning`, `topology_changed`.

---

### 11.3 Module 3 — Kanban Task Board

**Purpose.** Human-facing task orchestration: plan work, watch agents execute, intervene, and approve — with dependency graphs and WIP control.

**Mobile layout.**
- *Board:* horizontally scrollable columns (Backlog · Ready · In Progress · Review · Done) with snap; cards show: title, assignee (agent avatar or human), priority flag, due chip, dependency icon (⛓ n), status pill, progress bar for subtasks. Vertical drag within column; horizontal drag across columns (snap + haptic).
- *Card detail (sheet):* description (markdown), checklist, attachments/artifacts, linked chat thread, dependency list (blocks/blocked-by), execution trace link, approval sub-tasks, comments with @agent mentions (creates agent tasks).
- *Graph view toggle:* task dependency DAG with critical-path highlight; tap node → card sheet. Mobile DAG uses vertical layered layout with zoom.
- *Swimlanes:* by agent, team, or priority.

**Agent integration.**
- Tasks can be **agent-executable** (spawned runs), **human**, or **hybrid** (agent drafts → human review column).
- @mention an agent in a comment or description to enqueue work ("@researcher summarize these URLs").
- Agent completion moves cards automatically; failures create blocked cards with error summary + retry affordance.

**Rules & automation.** WIP limits per column (exceed = column glow warning); auto-assign rules (skill-based routing); cron-created recurring tasks; "Definition of Done" checks (e.g., requires approval record).

**Events.** `task_created`, `task_moved`, `task_assigned_agent`, `task_dependency_set`, `task_completed`, `wip_limit_hit`.

---

### 11.4 Module 4 — Skills Hub

**Purpose.** Discover, install, create, test, and govern **OpenClaw-compatible skills** — including skills written by agents themselves (self-improvement output).

**Skill anatomy (manifest):**
```yaml
name: firecrawl.deep-research
version: 1.2.0
description: Multi-source research with citation capture
runtime: openclaw-skill/1
entry: skill.md            # prompt/instruction skill
tools: [firecrawl.scrape, firecrawl.map, fs.write_artifact]
permissions: [network.egress, artifacts.write]
models_preferred: [any]
evals: evals/suite.yaml    # required for auto-activation
trust:
  origin: marketplace | user | agent-synthesized
  review_status: approved | pending | quarantined
```

**Mobile layout.**
- *Tabs:* **Installed · Marketplace · Mine · Synthesized**.
- *Cards:* icon, name, version, origin badge (Marketplace / You / `agent-synthesized` ⚗), permission chips, trust dot, invocations/7d, success rate.
- *Skill detail:* README (markdown), permissions requested, tools used, eval results (pass % sparkline), version history with diffs, dependent agents list, install/uninstall, "Add to agent" multi-select.
- *Skill Editor (mobile-first):* markdown editor with live prompt preview; tool binding picker; permission checklists; **Test Sandbox** — run skill against sample input in a gated session with token/cost meter and side-by-side before/after diff.
- *Synthesized tab:* skills proposed by agents (from §14) in `pending review` state with: proposed-by, trigger history, eval results, diff vs. closest existing skill, `Approve & activate · Edit · Reject (with feedback to agent)`.

**Governance.** Agent-synthesized skills **never auto-activate** without policy permission; default = human review. All skills are versioned; rollback is one tap. Evals gate activation (min pass rate configurable).

**Events.** `skill_installed`, `skill_published`, `skill_updated`, `skill_activated`, `skill_rejected`, `skill_synthesized_submitted`, `skill_rollback`.

---

### 11.5 Module 5 — Model Gateway (Multi-Model Routing)

**Purpose.** Unified access to every supported LLM with per-agent overrides, routing policies, fallbacks, budgets, and health monitoring.

**Provider matrix (initial support):**

| Category | Providers |
| --- | --- |
| **Frontier Cloud** | OpenAI (GPT-5, o3), Anthropic (Claude Opus 4, Sonnet 4), Google (Gemini 3 Pro), xAI (Grok 3) |
| **Mid-Tier Cloud** | OpenRouter, Together AI, Mistral, Cohere, AI21, Zhipu GLM |
| **Local/Self-Hosted** | Ollama, LM Studio, llama.cpp, vLLM, LocalAI, TabbyAPI |
| **Specialized** | DeepSeek, Qwen, MiniMax, Moonshot AI, Perplexity, Groq |
| **Enterprise** | Azure OpenAI, AWS Bedrock, GCP Vertex AI, IBM watsonx |

**Mobile layout.**
- *Providers tab:* cards per provider — connection status dot, auth type (key / OAuth / local endpoint), models count, latency p50 sparkline, spend MTD, "Test connection" button.
- *Keys & secrets:* values never rendered after save (masked); hardware-backed encryption note; per-key scopes; rotation reminders; local providers store base URL only.
- *Routing Policies tab:* visual policy builder (stacked rule cards): `WHEN task.type = "code" AND tokens < 32k → model: claude-sonnet-4; fallback: deepseek-v3; escalate: claude-opus-4 IF confidence < 0.6`. Policies attach at workspace → team → agent levels (most specific wins).
- *Budgets tab:* $/day, tokens/day, per-agent caps, per-team caps; soft warn (80%) → hard stop (100%) with override gated.
- *Live Usage tab:* streaming request table (agent, model, tokens, latency, cost) with pause/auto-refresh.

**Routing features.** Semantic cache (SQLite-backed, opt-out per agent), prompt/completion token accounting, structured-output validation retry ladder, model capability tags (vision, tools, JSON mode, 128k+) used by policy engine and copilot suggestions.

**Events.** `provider_added`, `key_rotated`, `policy_published`, `budget_soft_cap_hit`, `budget_hard_stop`, `fallback_invoked`, `model_health_degraded`.

---

### 11.6 Module 6 — Plugin Marketplace (MCP Integration)

**Purpose.** Install and manage MCP servers/plugins that extend every agent's tool surface. First-class curated integrations: **GitHub, Supabase, Firecrawl, Vercel, Airtable, Base44** — plus arbitrary user MCP servers (stdio / SSE / HTTP).

**Plugin card anatomy:** icon, name, publisher (verified badge), category (DevOps, Data, Web, No-code, Custom), permission scopes, tools exposed (count + sample), install size, ratings, "Works offline?" flag.

**Mobile layout.**
- *Marketplace:* featured carousel (curated), category chips, search; detail = overview, tools list (searchable), permissions review screen (required vs optional toggles), config form (auth per plugin), install button.
- *Installed tab:* per-plugin status (connected / error), tools toggles, per-agent binding matrix (which agents may use which tools), request log (calls today), revoke/uninstall.
- *Custom MCP tab:* "Add MCP server" form (name, transport: stdio/SSE/HTTP, command/URL, env vars (sealed), auth headers (sealed), health-check command); raw JSON config editor for power users.

**Curated plugin specs (v1 targets):**

| Plugin | Core tools (examples) | Key permissions | Notes |
| --- | --- | --- | --- |
| **GitHub** | repos.read, code.search, pr.create, issues.manage, actions.trigger | repo scope (fine-grained selectable) | PR creation = gated write |
| **Supabase** | db.query, db.migrate, auth.admin, storage, edge.invoke | project scoped keys | Migrations gated |
| **Firecrawl** | scrape, map, crawl, extract, search | network.egress | Rate-limited budget integration |
| **Vercel** | deploy, env.manage, logs.read, domains, projects | team scoped token | Production deploys = gated |
| **Airtable** | base.list, records.crud, schema.update | base scoped | Write ops gated per-base |
| **Base44** | apps.list, data.crud, functions.invoke, auth | workspace token | No-code app actions |

**MCP call lifecycle (all plugins):** `agent intent → tool allowlist check → trust policy check → budget check → [approval gate if privileged] → execution via gateway proxy → response scan (prompt-injection filter) → audit log entry`. The gateway proxies all MCP traffic (single egress point) — agents never hold raw plugin credentials; the gateway injects short-lived scoped tokens.

**Events.** `plugin_installed`, `plugin_config_updated`, `plugin_tool_granted`, `plugin_tool_revoked`, `plugin_uninstalled`, `mcp_health_degraded`.

---

### 11.7 Module 7 — Chat Interface

**Purpose.** Unified conversational surface: talk to the copilot, direct-message agents, participate in team channels, and handle approvals inline.

**Mobile layout.**
- *Inbox:* threads list (Direct · Channels · System) with unread badges, mention chips, last-message preview, agent avatar clusters; swipe = pin/mute/archive.
- *Thread view:* message stream with rich blocks: text (markdown), tool-call cards (collapsible), code blocks with copy + "Open in Terminal/Files", tables (horizontal scroll), charts, artifacts (inline preview), task cards, approval cards, swarm run embeds.
- **Composer:** text + attach (file, artifact, URL, task) + slash commands (`/run`, `/task`, `/deploy`, `/approve`, `/ask`) + agent picker (`@`) + model chip (per-send override) + send-mode (Send now / Schedule / Queue behind task).
- **Agent messaging semantics:** DM with an agent = interactive run context (session-scoped memory); messages stream back token-by-token with a live status strip ("thinking · using tool firecrawl.scrape · waiting approval").

**Approval cards (inline, actionable).** Show: requester, action summary, target, diff/preview, risk score, related policy; buttons: `Deny · Allow once · Allow for this session · Allow always (scoped)` with scope picker (this tool / this target / this agent).

**Human-in-the-loop modes.** Silent observer (runs post summaries), Interactive (default), Pair mode (agent asks before every external step).

**Events.** `thread_created`, `message_sent`, `agent_invoked_in_chat`, `approval_resolved_in_chat`, `artifact_shared`.

---

### 11.8 Module 8 — Telegram Bridge (OpenClaw Command Layer)

**Purpose.** Operate the entire platform from Telegram: status, commands, approvals, and two-way agent chat — the OpenClaw-inspired command layer.

**Setup wizard (mobile):** create bot via @BotFather → paste token (sealed) → set admin allowlist (chat IDs) → choose notification topics → test round-trip → done. Optional: bind multiple bots (one per team/swarm).

**Command grammar (extensible; matches app permissions):**

| Command | Action |
| --- | --- |
| `/status` | Gateway health, live swarms, pending approvals |
| `/swarms` / `/swarm <id>` | List / swarm detail card |
| `/deploy <template> "<objective>"` | Deploy swarm (confirm keyboard) |
| `/agents` / `/agent <id> <action>` | List / run·pause·stop agent |
| `/tasks` / `/task <id> move <col>` | Kanban access |
| `/ask <agent> <msg>` | Two-way chat with an agent |
| `/approve <id>` / `/deny <id> <reason>` | Resolve approval gates (inline buttons preferred) |
| `/models` / `/use <agent> <model>` | Model routing ops |
| `/logs <run-id>` | Last N log lines as formatted message |
| `/budget` | Spend today vs caps |
| `/copilot <msg>` | Full copilot conversation in Telegram |
| `/help` | Context-sensitive help |

**Notification topics (mirroring Telegram topics/threads):** Approvals · Failures · Deployments · Budget · Trust · Daily digest. Severity maps to message priority (silent vs. notification sound).

**Security.** Chat-ID allowlist enforced at gateway; per-user Telegram identity maps to an RBAC role; approval buttons are signed one-time tokens (replay-proof); all bot actions audited with `via: telegram`. Loss of Telegram ≠ loss of control (app remains authoritative).

**Two-way agent chat.** Long-running agent sessions bound to a chat; agents can ask humans questions via the bot; humans can interrupt with `/pause`.

**Events.** `telegram_bot_linked`, `telegram_command_executed`, `telegram_approval_resolved`, `telegram_digest_sent`.

---

### 11.9 Module 9 — Analytics Dashboard

**Purpose.** Operational, financial, and quality intelligence across agents, swarms, models, and governance.

**Mobile layout.** Vertical feed of chart cards (scroll), each expandable to full-screen landscape chart with table fallback. Period selector chips (24h · 7d · 30d · custom).

**Card catalog:**
1. **Executive strip** — spend today, active agents, running tasks, success rate, pending approvals (5 stat tiles, 2-up grid).
2. **Throughput** — tasks completed/hour (stacked by agent/team), area chart.
3. **Success & failure** — donut + top failure reasons list (tap → filtered runs).
4. **Model spend & latency** — stacked bars by provider; latency p50/p95 sparkline; $/task trend.
5. **Agent leaderboard** — sortable card table: success rate, avg cost, avg latency, trust score Δ.
6. **Trust posture** — fleet trust distribution histogram; quarantine events timeline.
7. **MCP activity** — calls by plugin; denied-by-policy counts; approval conversion rate.
8. **Self-improvement impact** — skills synthesized, adopted, rejection rate; before/after eval deltas after prompt refinements.
9. **Parallelism & resources** — concurrency utilization heatmap (hour × day); queue depth.
10. **Cost attribution** — by team / swarm / agent / task type (treemap on desktop, ranked bars on mobile).

**Drill-downs.** Any chart segment → filtered run list → run detail (trace, prompt, cost, artifacts). Export: CSV / JSON; scheduled Telegram digests (daily/weekly).

**Events.** `report_exported`, `digest_subscribed`, `anomaly_dismissed`, `anomaly_opened`.

---

### 11.10 Module 10 — Settings (Highly Customisable)

**Purpose.** One deeply configurable panel for the whole platform, organized for mobile scanning (section list → detail pages).

**Sections:**

| Section | Key controls |
| --- | --- |
| **Workspace** | Name, icon, timezone, locale, week start, default channel |
| **Appearance** | Theme (dark/light/system), accent color, density (comfortable/compact), font size, chart style, reduced motion, glass/flat surfaces |
| **Notifications** | Per-channel matrix (app/Telegram/email-webhook) × event class; quiet hours; digest schedules |
| **Agents defaults** | Default framework, default model policy, autonomy level, self-improvement policy (off / suggest / auto-with-review / full-auto), memory defaults |
| **Execution** | Parallel slots (global + per-swarm), queue priorities, retry policies, timeout defaults, checkpointing |
| **Models & budgets** | Link to Model Gateway; global caps; currency; invoice export |
| **Security & governance** | Gate policy templates, trust score weights (sliders!), role matrix (RBAC editor), session timeout, device management, 2FA |
| **Approvals** | Auto-approve rules (scoped), delegation (e.g., "Devon may approve Vercel prod"), escalation timeouts |
| **Integrations** | Plugins, Telegram, webhooks (inbound/outbound), email-SMTP (optional) |
| **Data & storage** | SQLite path, artifact storage path, retention windows, redaction rules, backup/restore, export-all |
| **Terminal** | Shell profile, allowed/denied command patterns, working dir defaults, font size |
| **Copilot** | Default mode (Ask/Act/Build), autonomy scope, memory on/off, voice settings, dry-run default |
| **Advanced** | Feature flags, experimental adapters, gateway config editor (validated YAML/JSON), debug logging toggles, log redaction |
| **About** | Version, license, update channel, telemetry (off by default), diagnostics bundle |

**Trust weight sliders (Security section)** — operators tune the trust formula live (see §16.2) with instant preview on sample agents.

**Settings UX.** Each page: sticky save bar, unsaved-changes guard, "Reset to default" per row, search settings, copy-as-JSON for support. All changes audited with before/after diffs.

**Events.** `settings_changed` (with diff), `backup_created`, `restore_performed`, `feature_flag_toggled`.

---

### 11.11 Module 11 — Artifacts & File Management

**Purpose.** A governed workspace filesystem for agent outputs, inputs, and shared project files — with rich previews and safe sharing.

**Mobile layout.**
- *Browser:* breadcrumb bar, grid/list toggle, folder cards + file cards (icon by type: markdown, code, image, PDF, CSV, JSON, audio/video); FAB = new folder / upload / "Ask agent to create".
- *File detail:* preview renderer (images, PDF, markdown, code with syntax highlight, CSV grid, Jupyter-style outputs), metadata (size, created-by agent/human, run linkage, checksum), versions (diff view for text), share sheet (expiring link, send to Telegram, attach to chat), terminal-reveal.
- *Storage meter:* usage ring with per-type breakdown; cleanup suggestions (orphaned run artifacts, old logs).

**Capabilities.** Upload (camera & files via mobile share target — PWA `share_target`), download, move/rename/copy, star, trash with restore, batch ops (multi-select mode), text search inside files, `.gitignore`-style agent export rules.

**Governance.** Path-based ACLs (`/runs/**` auto-owned by run's agent; `/shared/**` team-visible); every write from agents recorded in file journal (who/when/run-id); sensitive patterns auto-redacted in previews (keys, tokens).

**Artifacts API.** Agents write via `artifacts.write` tool only; large files chunked; content-addressed dedupe in SQLite blob index.

**Events.** `file_uploaded`, `file_written_by_agent`, `file_shared`, `file_deleted`, `storage_cleanup_run`.

---

### 11.12 Module 12 — Terminal (Working Terminal)

**Purpose.** A real, working terminal bound to the gateway host (or remote runners) for power users and agents — usable on a phone.

**Mobile layout.**
- Full-bleed terminal surface; accessory key row above keyboard: `ESC · TAB · CTRL · ALT · | · / · ~ · ↑ · ↓ · - · +`; font-size pinch; session tabs (scrollable pills at top); landscape recommendation banner.
- *Session drawer:* sessions list (local shell, agent PTY, remote runner), create session sheet (profile picker: `sh`, `bash`, `python`, `node`, `swarm-cli`), kill/attach.

**Features.** Full xterm-compatible emulation (UTF-8, colors, resize), scrollback (configurable, searchable), copy/paste affordances (long-press selection handles), saved snippets library (run in session / send to agent), command history (per workspace, encrypted at rest), split output logs per session.

**Safety rails.** Command policy engine (allow/deny regex lists from Settings); destructive patterns (`rm -rf`, `git push --force`, `DROP TABLE`, mass `kill`) trigger confirm cards; read-only mode per session; all sessions recorded (asciinema-style replay stored as artifact); agents get PTYs in sandbox profiles with resource caps.

**Integration.** "Open in Terminal" from files, logs, and chat code blocks; terminal output can be sent to copilot for interpretation; `swarm` CLI inside the terminal mirrors the API (deploy, status, logs, approve).

**Events.** `terminal_session_opened`, `terminal_command_blocked`, `terminal_session_replayed`, `terminal_snippet_run`.

---

## 12. Cross-Module Behaviors

| Behavior | Spec |
| --- | --- |
| **Optimistic mutations** | All writes update UI instantly; conflict policy: last-write-wins + merge toast for prompt/settings text |
| **Realtime transport** | Single WebSocket (`/ws`) multiplexing event topics (runs, chat, analytics, notifications); auto-reconnect with exponential backoff + missed-event replay via cursor |
| **Empty states** | Illustration + 1–3 CTAs (template / copilot / docs) |
| **Error taxonomy** | `user` (fix input), `policy` (blocked by governance — explains rule), `provider` (model/plugin upstream), `gateway` (internal — diagnostics ID) |
| **Skeletons** | Per-module skeleton patterns; never full-screen spinners except app boot |

---

## 13. Agent Framework Adapters

All seven frameworks plug into a common **Framework Adapter Interface (FAI)** so the UI, scheduler, governance, and memory layers are framework-agnostic.

```text
Adapter Interface (conceptual)
├── describe()            → capabilities: async?, streaming?, handoffs?, tools std, memory hooks
├── compile(profile)      → runtime bundle from AgentProfile (prompt, tools, model, memory)
├── run(input, ctx)       → event stream: tokens, tool_calls, handoffs, state changes
├── checkpoint()/restore()→ pause/resume (for parallel engine preemption)
├── export_trace()        → normalized trace for audit + analytics
└── self_improve_hooks()  → prompt-refine / skill-synth / tool-optimize callbacks
```

**Capabilities matrix (v1 targets):**

| Framework | Topologies | Handoffs | Streaming | Native memory | Best fit |
| --- | --- | --- | --- | --- | --- |
| **Swarmzero** | Swarm mesh, stigmergy | Peer broadcast | Yes | Shared blackboard | Large parallel swarms, market-style tasks |
| **AutoPentest** | Recon→Exploit→Report pipeline | Stage gates | Yes | Findings store | Security assessment cells |
| **A.I.M.A** | Rational agent (BDI-style) | Deliberative | Yes | Belief KB | Goal-driven deliberation, planning |
| **Project Nautilus** | Deep-sea long-running ops (durable, resumable) | Checkpointed | Yes | Durable journal | Long-running ops, unreliable networks |
| **OpenAI Swarm** | Lightweight routines/handoffs | Yes | Yes | Session | Simple, fast agent handoff demos/patterns |
| **CrewAI** | Role-based crews (sequential/hierarchical) | Yes | Yes | Shared/long-term | Team-of-roles workflows |
| **LangGraph** | Arbitrary graphs, cycles, subgraphs | Graph edges | Yes | Checkpoint store | Complex stateful pipelines |

**Adapter rules.** Frameworks lacking a feature fall back to gateway-provided emulation (e.g., checkpointing emulated via input snapshot). Agent profile stores `framework + framework_config (schema-validated per adapter)`. Mixing frameworks inside one swarm is supported (inter-agent messaging normalized to the OpenClaw envelope).

**Inter-agent messaging envelope (OpenClaw msg):** `id, from, to|broadcast, channel (app|telegram|slack|webhook), type (task|result|question|handoff|event), payload, attachments, trust_context, reply_to, ttl` — every framework adapter speaks this envelope at its boundary.

---

## 14. Self-Improving Agent Loop (Memory + Machine Learning)

### 14.1 Loop Overview

```
            ┌────────────────────────────────────────────────┐
            │                                                │
   goal ──▶ │ 1. PLAN  ──▶ 2. ACT  ──▶ 3. OBSERVE ──▶ 4. REFLECT │
            │    ▲                                      │    │
            │    │        5. LEARN (ML layer)           │    │
            │    │        ├─ skill synthesis            │    │
            │    │        ├─ prompt refinement          │    │
            │    │        └─ tool-usage optimization    │    │
            │    └────────────── memory writes ─────────┘    │
            └────────────────────────────────────────────────┘
                     every phase emits audit + metrics
```

Each iteration is a **Loop Record**: goal, plan, actions, outcomes, cost, reward signal, learnings. Records feed the ML layer and the Analytics "Self-improvement impact" card.

### 14.2 Memory Architecture (Tiered)

| Tier | Store | Contents | Retention | Access |
| --- | --- | --- | --- | --- |
| **Working** | In-run scratch (SQLite `memory_working`) | Current plan, tool state | Run lifetime | Agent only |
| **Episodic** | `memory_episodes` (FTS5 + vectors) | Past runs, decisions, failures | Rolling window (configurable) | Agent + user inspection |
| **Semantic** | `memory_semantic` | Distilled facts, preferences, entity profiles | Long-term | Agent + user edit/delete |
| **Vector** | `memory_vectors` (SQLite-vec or similar embedded extension) | Embeddings of episodes/artifacts | With source | Similarity retrieval |
| **Skill** | Skills Hub | Procedural knowledge (executable) | Versioned forever | Governed (§11.4) |

Governance: every memory item has `source, created_by, trust, pii_flags`; user memory browser with search + "forget" (right-to-erasure compliant); agents can be scoped to `no persistent memory`.

### 14.3 Skill Synthesis (Agents Write New Skills)
- Trigger: repeated sub-task patterns, high-cost tool sequences, or explicit "learn from this" instruction.
- Process: agent drafts skill manifest + `skill.md` + eval suite → runs evals in sandbox → submits to **Synthesized** queue with evidence (before/after metrics).
- Activation: policy-driven — `off` (never) / `suggest` (human approves) / `auto-with-review` (activates, human can veto within N hours) / `full-auto` (only for trust-tier-A agents).
- Every synthesized skill links back to its trigger episodes (explainability).

### 14.4 Prompt Refinement
- Agents propose prompt diffs against a held-out eval set (golden tasks maintained per agent).
- Acceptance requires eval score improvement ≥ threshold without regression on safety evals.
- Prompt versions are first-class (§11.1) — refinements are just new versions with `origin: agent-refined`, annotated with metric deltas.
- Rollback automatic if live KPIs drop below floor after promotion.

### 14.5 Tool-Usage Optimization (ML)
- **Contextual bandit** per agent over tool/strategy choices (features: task type, input size, tool latency/cost history, success history). Reward = task success − cost penalty − latency penalty.
- Optimization targets: tool selection, tool order, parameter defaults (e.g., scrape depth), retry vs. alternative-tool decisions, model escalation choices.
- Explanations surfaced in Trust tab: "firecrawl.map chosen over crawl — 3.2× cheaper on similar tasks".
- Safety constraint: bandit may only choose among *already-allowed* tools; it can never expand its own permissions.

### 14.6 ML Training On-Device (Self-Hosted)
- Embedded learner runs in the gateway process (offline-capable): gradient-free methods + lightweight fine-tune jobs (LoRA adapters for local models via llama.cpp/vLLM when available).
- All training data stays local (execution history, redacted). Export opt-in only.

---

## 15. Parallel Execution Engine

### 15.1 Responsibilities
1. Schedule tasks across agents with **dependency DAG** awareness (topological waves + ready-queue).
2. Enforce **resource allocation**: CPU/memory for local tools, parallel slots per swarm, model RPM/TPM budgets, spend caps, plugin rate limits.
3. Provide **live visualization** and operator controls (pause/resume/cancel/re-prioritize/re-route).

### 15.2 Scheduling Model
- Task = DAG node with `deps[], priority, affinity (agent/team), deadline, cost class, preemptible`.
- Scheduler: weighted fair queuing × priority × deadline slack; aging prevents starvation.
- Preemption: checkpointable adapters (Nautilus, LangGraph) suspend at safe points; others run to completion.
- Retry policy per node: exponential backoff, max attempts, fallback agent/model, poison-queue after exhaustion.
- Fan-out/fan-in: sub-swarms spawn children nodes automatically; budgets inherit with sub-allocation.

### 15.3 Visualization (mobile-first)
- **DAG view:** layered vertical layout on mobile (swimlane rows = agents; edges = animated dashes while data flows; critical path highlighted in `brand/accent`). Pinch-zoom + pan; node chips show status/spend/elapsed. Mini-map on desktop.
- **Resource lanes:** horizontal bars (CPU, mem, model tokens/s, $/h, plugin quota) with budget lines and breach shading.
- **Wave timeline:** Gantt-style strip showing task execution bars over time; scrub to replay history (uses event log).
- Operator controls per node: pause, cancel, retry, bump priority, reassign agent, add approval hold.

### 15.4 Event Stream
`task.queued → task.ready → task.started → task.tool_call → task.checkpoint → task.completed | task.failed | task.cancelled`, plus `resource.throttled`, `budget.warned`, `scheduler.rebalanced`. All persisted (SQLite events table) for replay + Wave timeline.

---

## 16. Trust & Governance Layer (Four-Layer Security Framework)

### 16.1 The Four Layers

```
Layer 4  APPROVAL GATES ── human/delegate sign-off for privileged actions
Layer 3  MCP CALL AUDIT ── every tool/plugin call logged, scored, replayable
Layer 2  RUNTIME ISOLATION ── sandboxes, capability tokens, egress proxy
Layer 1  IDENTITY & ACCESS ── RBAC, agent identities, session/device control
```

**Layer 1 — Identity & Access.** Every actor (human, agent, copilot, bot) has a principal ID. RBAC roles: `Owner, Admin, Operator, Reviewer, Observer`. Agents hold scoped capability tokens (never raw credentials). Device/session management with 2FA; Telegram identities mapped to principals.

**Layer 2 — Runtime Isolation.** Agents execute with capability tokens (tool allowlist + resource caps + TTL). Filesystem access via artifacts API (path ACLs). Network egress via gateway proxy (domain allowlists per agent; plugin traffic forced through MCP proxy). Local tools run in sandboxed processes (seccomp/containers where available). Prompt-injection filters on all tool results crossing trust boundaries.

**Layer 3 — MCP Call Audit.** Every MCP call recorded: principal, agent, tool, args hash + redacted args, policy decision, latency, result status, cost, approval link. Audit trail is append-only (SQLite with hash chaining for tamper evidence). Query UI in Agent Logs + Analytics + `/audit` in CLI/Telegram. Retention configurable; export for compliance.

**Layer 4 — Approval Gates.** Declarative policy: `IF action ∈ {deploy.prod, db.migrate, spend > $X, fs.delete, github.pr.merge, vercel.prod, self.improve.activate} THEN require approval from {role}`. Approval objects: request, risk score, evidence bundle (diff/plan), decision (allow once / scoped / always / deny), decider identity, expiry. Delegation + escalation timeouts (page alternate approver). Gates render inline in Chat, Task cards, Telegram, and Copilot action cards.

### 16.2 Per-Agent Trust Scores (0–100)

```
trust = 50
      + 12 × success_rate_norm          (rolling 30d task success)
      + 10 × policy_compliance          (1 − violations/opportunities)
      +  8 × approval_pass_rate         (gates passed without human correction)
      +  8 × eval_trend                 (self-improvement eval deltas)
      +  6 × uptime_norm
      − 15 × severity_weighted_incidents (failures, injection triggers, gate denials)
      −  8 × cost_overrun_norm          (budget adherence)
      ±  4 × operator_adjust            (manual override, audited)
```

- Weights exposed as sliders in Settings (§11.10) with live preview.
- **Tier A (≥ 80):** eligible for `full-auto` self-improvement and broader auto-approve scopes. **Tier B (50–79):** default gates. **Tier C (< 50):** restricted; auto-quarantine below configurable floor (e.g., 30) — swarm role auto-reassigned, human review required.
- Score changes emit `trust.changed` events with factor deltas ("−6: approval denied for vercel.prod deploy").

### 16.3 Governance UX Touchpoints
- Trust gauge widget reused on agent cards, chat headers, Telegram cards.
- Policy simulator: "What would happen if agent X tried action Y?" (dry-run policy evaluation) — available in Settings and via copilot.
- Incident timeline per agent (quarantines, gate denials, injection attempts blocked).

---

## 17. OpenClaw Layer

### 17.1 Skills System
Executable + prompt skills with manifests (§11.4), versioning, eval gating, and per-agent loadout. Skill packs (e.g., "Research Pack", "Pentest Pack", "Content Pack") install as bundles. Skills can compose other skills; cycles are rejected at install time.

### 17.2 Multi-Model Routing
The Model Gateway (§11.5) is the routing substrate for OpenClaw: per-skill model hints (`models_preferred`), per-task routing policies, escalation ladders, semantic cache, and per-agent budgets. Routing decisions are logged and explainable.

### 17.3 Messaging-Platform Command Layer
Telegram-first (§11.8) with a platform-agnostic command parser (`/verb noun args`) so the same grammar ports to Slack/Discord/WhatsApp adapters. Command handlers are OpenClaw skills themselves (`skill: core.telegram-commands`), so operators can extend the command set by installing skills. All bot actions carry `trust_context` and pass through the same four-layer governance.

---

## 18. Self-Hosted Gateway Architecture (Zero External Dependencies)

### 18.1 Deployment Shape
```
swarmos-gateway (single process; or docker compose with 1 container)
├── HTTP/WS API  (app + PWA served statically from same process)
├── Scheduler + Parallel Execution Engine (in-process, async workers)
├── MCP Proxy + Plugin Runners (subprocesses; stdio/SSE/HTTP)
├── Model Gateway (provider adapters)
├── Telegram Bot Manager (long-poll or webhook to gateway)
├── Embedded Learner (self-improvement ML)
├── Storage
│   ├── SQLite (WAL mode) — ALL state: entities, events, memory, audit
│   └── Filesystem — artifacts, logs, replays, backups (content-addressed)
└── No Redis · No Postgres · No external queue · No external vector DB*
```
\* Vector search via embedded SQLite extension (e.g., sqlite-vec) or brute-force FTS+cosine fallback — both in-process.

### 18.2 Why This Works
- **SQLite WAL** handles concurrent readers + single writer; write serialization per-workspace keeps consistency.
- **Job queue in SQLite** (`jobs` table with leasing, visibility timeouts, retries) replaces Redis-sidekiq.
- **Realtime** via in-process event bus → WebSocket fanout (single gateway node is authoritative). Horizontal scale-out is a v2 concern (read replicas / gateway clustering); v1 targets hundreds of agents on one node.
- **Zero-ops:** install = download binary or `docker run -v data:/data ghcr.io/swarmos/gateway`. Backup = hot-copy SQLite (`.backup`) + artifacts dir; restore = replace + restart. Scheduled backups to local dir or mounted volume; optional push to any S3-compatible store via plugin.

### 18.3 Reliability
- Crash-safe journaling (WAL + job leases); startup recovery replays incomplete jobs.
- Watchdog for subprocess plugins (auto-restart w/ backoff; circuit breaker per plugin).
- Self-diagnostics endpoint + "diagnostics bundle" export (redacted logs, config, versions).

---

## 19. Data Model (SQLite — core tables)

```sql
-- Identity & governance
principals(id, type[user|agent|copilot|bot], name, role, trust, created_at)
capability_tokens(id, principal_id, scopes_json, expires_at, revoked_at)
approvals(id, principal_id, action, target, risk, evidence_json, status,
          decider_id, decided_at, expires_at, policy_id)
audit_log(id, seq, ts, principal_id, actor_via, event, args_hash, args_redacted,
          policy_decision, result, prev_hash, hash)   -- hash-chained

-- Agents & teams
agents(id, name, role, framework, framework_config_json, model_policy_id,
       prompt_current_version_id, autonomy_level, self_improve_policy,
       trust, status, created_by, deleted_at)
prompt_versions(id, agent_id, semver, body, origin[human|agent-refined], metrics_json)
teams(id, name, topology, config_json, created_by)
team_members(team_id, agent_id, role)
swarms(id, team_id, objective, config_json, status, budget_json, channel, deployed_at)

-- Execution
tasks(id, swarm_id, title, status, column, assignee_id, priority, deps_json,
      cost_actual, started_at, completed_at)
runs(id, task_id, agent_id, status, model, tokens_in, tokens_out, cost,
     started_at, ended_at, error, trace_ref)
events(id, ts, run_id, type, payload_json, cursor)     -- replayable stream
jobs(id, type, payload_json, state, lease_owner, lease_until, attempts, next_run_at)

-- Skills, plugins, models
skills(id, name, version, origin, manifest_json, body, review_status, evals_json)
agent_skills(agent_id, skill_id, autoload, priority)
plugins(id, name, transport, config_sealed, status)
plugin_tools(plugin_id, name, schema_json, privileged)
plugin_grants(agent_id, tool_id, scopes_json)
providers(id, category, name, auth_type, endpoint, models_json, health)
model_policies(id, name, rules_json, priority)
budgets(id, scope_type, scope_id, period, cap_amount, cap_tokens, action_on_hit)

-- Memory & artifacts
memory_episodes(id, agent_id, ts, content, embedding, pii_flags, run_id)
memory_semantic(id, agent_id, key, content, trust, source, updated_at)
memory_vectors(id, owner_type, owner_id, ref_table, ref_id, embedding)
files(id, path, size, checksum, mime, created_by, run_id, deleted_at)
file_versions(id, file_id, version, blob_ref, created_at)

-- Messaging
threads(id, kind, title, channel)
messages(id, thread_id, principal_id, body_json, reply_to, created_at)
telegram_links(id, chat_id, role, topic_map_json)
```

---

## 20. API & Realtime Surface

### 20.1 API Style
Single JSON-RPC-ish REST hybrid under `/api/v1/*` + WebSocket `/ws`. All mutations accept `Idempotency-Key`. Auth: session cookie (PWA) / scoped bearer tokens (CLI, bots). Every response carries `x-swarmos-request-id` for diagnostics.

### 20.2 Representative Endpoints
```
GET/POST  /agents · /agents/:id · /agents/:id/run
GET/POST  /teams · /teams/:id/deploy · /swarms/:id/{pause,resume,cancel}
GET/PATCH /tasks · /tasks/:id/assign · /tasks/:id/depend
GET/POST  /skills · /skills/:id/activate · /skills/:id/eval
GET/POST  /models/providers · /models/policies · /models/usage
GET/POST  /plugins · /plugins/:id/grants
GET/POST  /chat/threads · /chat/threads/:id/messages
POST      /approvals/:id/{allow,deny}
GET/POST  /files · /files/:id/content · /terminal/sessions
GET       /analytics/summary · /analytics/series/:metric
POST      /copilot/messages   (streams plan + action cards via WS)
WS topics: runs.*, tasks.*, chat.*, approvals.*, trust.*, resources.*, analytics.*
```

### 20.3 Event Envelope
`{ id, cursor, ts, topic, entity, type, payload, trust_context }` — cursors enable missed-event replay after reconnect.

---

## 21. Security & Privacy Details

1. **Secrets:** plugin keys, model keys, bot tokens sealed with libsodium-style AEAD; master key derived from operator passphrase + KDF (or OS keychain on managed hosts); secrets never leave the gateway; masked in UI/audit.
2. **Prompt injection defense:** tool results wrapped as untrusted; instruction-stripping heuristics; per-source trust levels; copilot cannot be elevated by content it reads.
3. **Supply chain:** plugin manifests signed for marketplace entries; custom MCP servers are always "unverified" flagged; hash-pinned container images for bundled runners.
4. **PII redaction:** configurable regex + NER-lite redaction on logs, memory, and analytics; audit stores redacted args + hash of originals.
5. **Network:** default-deny egress per agent; allowlists per plugin/domain; TLS termination notes for self-hosters.
6. **RBAC + gates** as per §16; quarterly access review reminders built into Settings.

---

## 22. Accessibility

- Target: **WCAG 2.2 AA** across all 12 modules. Contrast ≥ 4.5:1 body / 3:1 large; focus rings visible on all interactive elements; logical tab order; skip-to-content.
- Screen readers: ARIA labels on icon buttons; live regions for streaming output ("Agent replied"), approval prompts, and status changes; chart cards include text summaries + data tables.
- Motor: all targets ≥ 44 px; swipe actions have button alternatives; sticky composers don't cover content; timeouts extendable.
- Cognitive: consistent layouts; plain-language error taxonomy (§12); confirmations explain consequences; reduced-motion mode.
- Language: locale scaffolding (i18n keys) from day one; RTL-ready layout mirror.

---

## 23. Performance & Reliability Budgets

| Metric | Budget (mid-range phone, 4G) |
| --- | --- |
| App shell interactive | ≤ 2.5 s cold / ≤ 1.0 s warm |
| Route transition | ≤ 200 ms |
| First chat token latency (UI) | ≤ 300 ms after provider first-token |
| WS event-to-UI | ≤ 250 ms |
| Kanban drag frame rate | ≥ 55 fps |
| DAG (200 nodes) interaction | ≥ 30 fps on mobile |
| Offline queue | Unlimited items; sync within 5 s of reconnect |
| Bundle budget | Initial JS ≤ 250 KB gzip; per-module lazy chunks |
| SQLite | WAL; query p95 < 20 ms for list views (indexed) |

---

## 24. Testing Strategy & Acceptance Criteria

1. **Unit/adapter tests:** each framework adapter has a conformance suite (run, stream, checkpoint, trace export).
2. **Governance tests:** policy engine golden cases; "copilot cannot self-approve" is an enforced test; audit hash-chain verification test.
3. **E2E (mobile viewport 390×844):** create agent → attach skills → deploy swarm → approve gate from Telegram → review analytics; plus offline queue sync path.
4. **Load:** 200 concurrent agent runs on one gateway node; scheduler fairness checks; WS fanout to 50 clients.
5. **Chaos:** kill plugin subprocess mid-run (recovery), gateway restart mid-job (lease recovery), provider outage (fallback chain).
6. **A11y:** automated axe checks in CI + manual screen-reader passes per release.
7. **Security:** prompt-injection test corpus (tool results containing jailbreaks), RBAC matrix fuzzing, secrets-leak scanning of logs/exports.

**MVP acceptance (top-level):** a user on a phone can, without using a desktop: install the gateway, add one model provider, create 2 agents (different frameworks), install 2 plugins, deploy a 2-agent swarm on a Kanban-driven task, approve one gated MCP call via Telegram, watch analytics update live, and have one self-improvement proposal appear in Skills Hub.

---

## 25. Phased Delivery Roadmap

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| **P0 — Foundation (6–8 wks)** | App shell, design system, Agents CRUD + wizard, Model Gateway (5 providers), SQLite gateway, chat with copilot (Ask mode), Settings core | MVP acceptance above |
| **P1 — Orchestration (6 wks)** | Teams & Swarms, Kanban, Parallel Execution Engine + DAG view, Telegram Bridge v1, approvals gates v1 | Live swarm controlled from phone + Telegram |
| **P2 — OpenClaw (6 wks)** | Skills Hub + marketplace, all 6 curated plugins, MCP proxy + audit, Artifacts & Files, Terminal | Full tool/skill loop with governance |
| **P3 — Intelligence (6 wks)** | Self-improving loop (skill synth, prompt refine, bandit tool opt), trust scores v1, Analytics v1 + digests | Measurable eval uplift from self-improvement |
| **P4 — Scale & Polish (4 wks)** | Remaining providers (all categories), framework adapters 5–7 complete, a11y + perf hardening, PWA offline, policy simulator | GA-quality self-hosted release |

---

## 26. Open Questions & Risks

| # | Item | Notes / mitigation |
| --- | --- | --- |
| 1 | Framework API drift (7 frameworks) | Pin adapter versions; conformance suite in CI |
| 2 | SQLite write contention at high swarm scale | Single-writer batching; shard by workspace; v2 clustering path defined |
| 3 | Self-improvement misuse | Default `suggest` mode; eval gating; trust-tier unlock |
| 4 | Telegram as attack surface | Allowlist + signed one-time buttons + RBAC mapping |
| 5 | Local model quality variance | Capability tags + policy fallback to cloud |
| 6 | Plugin supply chain | Signed marketplace entries; unverified flags; egress proxy |

---

## 27. Glossary

| Term | Definition |
| --- | --- |
| **Agent** | Configured AI worker with profile: framework, brain, tools, skills, memory, trust |
| **Team** | Composed set of agents with role graph and shared policy |
| **Swarm** | Deployed runtime instance of team(s) pursuing an objective |
| **Skill** | OpenClaw-compatible instruction/tool bundle with manifest, evals, versions |
| **MCP** | Model Context Protocol — tool/plugin integration standard used by all plugins |
| **Approval gate** | Policy checkpoint requiring human/delegate sign-off before privileged action |
| **Trust score** | 0–100 composite of reliability, compliance, and quality signals per agent |
| **Self-improving loop** | Plan→Act→Observe→Reflect cycle with ML-driven skill/prompt/tool optimization |
| **FAI** | Framework Adapter Interface — common contract for all 7 agent frameworks |
| **Gateway** | The single self-hosted SwarmOS process (API, scheduler, proxy, storage) |

---

## 28. Appendix A — Key Screen Wireframes (ASCII)

### A.1 Home / Command Deck
```
┌─────────────────────────────────────┐
│ ☰  SwarmOS ▾        🔔 2   👤       │  ← top bar (2 pending approvals)
│ ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬ │
│ Good evening, Maya        [LIVE ●]  │
│ ┌─────────┐ ┌─────────┐             │
│ │$42.18   │ │12 agents│   stat tiles│
│ │today    │ │4 running│             │
│ └─────────┘ └─────────┘             │
│ ⚠ 2 approvals need you   [Review]   │
│ ┌─────────────────────────────────┐ │
│ │▲ Spend (7d)      ╭─── sparkline │ │
│ └─────────────────────────────────┘ │
│ Live now                            │
│ ▸ 🟢 research-swarm   6/9 tasks     │
│ ▸ 🟡 pentest-cell     2/5 tasks     │
│ Recent fails                        │
│ ▸ 🔴 seo-agent — tool timeout  Retry│
│                                     │
│  ┌─────── dock: ✦ Ask Copilot ───┐  │
│  └───────────────────────────────┘  │
│  🏠      🤖      ✅      💬   •••   │  ← tab bar
└─────────────────────────────────────┘
```

### A.2 Live Swarm Monitor (Graph tab)
```
┌─────────────────────────────────────┐
│ ‹  research-swarm    🟢 LIVE  ⏸     │
│ 08:12  ·  $3.41/$10  ·  6/9 tasks   │
│ [Graph][Tasks][Agents][Res][Log]    │
│ ┌─────────────────────────────────┐ │
│ │     □ planner                   │ │
│ │     │╲                          │ │
│ │   □ │ □  researcher-a  researcher-b
│ │     │  ╲                        │ │
│ │     □   □  writer     reviewer  │ │
│ │        ╲╱                       │ │
│ │         □ assembler             │ │
│ │   (critical path highlighted)   │ │
│ └─────────────────────────────────┘ │
│ Resources                           │
│ tokens/s ████████░░ 78%  cap 60k    │
│ $/h      ███░░░░░░░ 32%  cap $6     │
│  ✦ dock ·  🏠 🤖 ✅ 💬 •••           │
└─────────────────────────────────────┘
```

### A.3 Copilot Action Card (in sheet)
```
┌─────────────────────────────────────┐
│ ✦ Copilot            [Act ▾] [⋯]    │
│ ─────────────────────────────────── │
│ "Deploy the triage team to staging" │
│                                     │
│ ┌─ ACTION CARD ───────────────────┐ │
│ │ ▢ Deploy swarm · triage-team    │ │
│ │   target: staging · budget $5   │ │
│ │   models: sonnet-4 → deepseek   │ │
│ │   risk: MEDIUM · gate: confirm  │ │
│ │   [View plan] [Dry run]         │ │
│ │   [ Cancel ]   [ Confirm ]      │ │
│ └─────────────────────────────────┘ │
│ ┌─ composer ──────────────────────┐ │
│ │ Type a message…        🎤 ➤     │ │
│ └─────────────────────────────────┘ │
└─────────────────────────────────────┘
```

---

## 29. Appendix B — Example Routing Policy (YAML)

```yaml
name: default-task-routing
priority: 100
match:
  task_type: [research, summarize]
  budget_remaining_usd: { gte: 0.50 }
route:
  primary: anthropic/claude-sonnet-4
  fallbacks: [deepseek/deepseek-v3, ollama/qwen2.5:32b]
  escalate_to: anthropic/claude-opus-4
  escalate_when: { confidence_lt: 0.6, or: { error_class: [schema_invalid] } }
limits:
  max_tokens_per_run: 180000
  max_cost_per_run_usd: 2.50
cache: semantic:on
```

---

*End of specification. Prepared 2026-10-12 — v1.0 draft for build.*
