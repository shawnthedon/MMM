<div align="center">

<img src="public/icons/icon.svg" width="96" alt="SwarmOS logo"/>

# ⬡ SwarmOS

### 📱 Mobile-First AI Agent Orchestration Dashboard

**Create & deploy AI agent teams · run swarms · govern trust · route any model — from your phone.**

![PWA](https://img.shields.io/badge/PWA-installable-6C8CFF?style=for-the-badge&logo=pwa&logoColor=white)
![Mobile-first](https://img.shields.io/badge/Mobile--first-360px%2B-22D3EE?style=for-the-badge&logo=smartphone&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-6-646CFF?style=for-the-badge&logo=vite&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ES2020-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)
![License](https://img.shields.io/badge/License-MIT-34D399?style=for-the-badge&logo=opensourceinitiative&logoColor=white)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-ff69b4?style=for-the-badge&logo=git&logoColor=white)

[✨ Features](#-features) · [📸 Screenshots](#-screenshots) · [🚀 Quick Start](#-quick-start) · [📖 Design Spec](docs/DESIGN_SPEC.md) · [🗺 Roadmap](#-roadmap)

</div>

---

<img src="docs/images/banner.png" alt="SwarmOS — mobile-first AI agent orchestration banner" width="100%"/>

## 🧠 What is SwarmOS?

**SwarmOS** is a self-hosted, zero-dependency control plane for AI agent operations — delivered as a **Progressive Web App** you can install on your phone. It unifies:

- 🤖 **Agent engineering** across 7 selectable frameworks (Swarmzero, AutoPentest, A.I.M.A, Project Nautilus, OpenAI Swarm, CrewAI, LangGraph)
- 🐝 **Swarm operations** — parallel execution, dependency DAGs, resource allocation, Kanban
- 🦞 **OpenClaw runtime** — skills system, MCP tool integrations, multi-model routing, Telegram command layer
- 🧬 **Self-improvement** — agents synthesize new skills, refine their prompts, and optimize tool usage via ML
- 🛡 **Trust & Governance** — 4-layer security, per-agent trust scores, MCP call auditing, approval gates
- ✦ **Embedded Copilot** — an in-app AI operator with **full control** over the application (always gate-checked)

> 🏠 Runs anywhere: **one process + SQLite + a folder**. No Redis. No Postgres. No external orchestrator.

---

## ✨ Features

| | Module | What it does |
| :---: | --- | --- |
| 🤖 | **Agent Manager** | Advanced profiles: framework, brain (any LLM), tools, skills, memory, trust tier, autonomy level (L0–L4) |
| 🐝 | **Team Orchestrator** | Compose teams, pick topologies (hierarchical / mesh / pipeline / debate), deploy swarms with budgets |
| 📋 | **Kanban Board** | Touch drag & drop, swimlanes, dependencies, @agent mentions, human-in-the-loop review columns |
| ⚡ | **Skills Hub** | OpenClaw skills with manifests, eval gating, versioning — incl. review queue for **agent-written skills** |
| 🧠 | **Model Gateway** | **26 providers** — OpenAI, Anthropic, Google, xAI → local Ollama/vLLM → Azure/Bedrock/Vertex/watsonx |
| 🧩 | **Plugin Marketplace** | MCP integrations: **GitHub, Supabase, Firecrawl, Vercel, Airtable, Base44** + custom stdio/SSE/HTTP |
| 💬 | **Chat** | Threads, @mentions, streaming replies, **inline approval cards** that resolve real gates |
| ✈️ | **Telegram Bridge** | OpenClaw command layer: `/status`, `/deploy`, `/approve`, `/ask`, `/copilot` — signed one-time buttons |
| 📊 | **Analytics** | Live KPIs, spend & latency, agent leaderboard, trust posture, self-improvement impact |
| ⚙️ | **Settings** | Trust-weight sliders, autonomy & self-improve policies, notifications, theme, retention |
| 📁 | **Artifacts & Files** | Governed workspace FS, previews, versioning, sharing, run-linked outputs |
| 💻 | **Terminal** | Working `swarm` CLI: `status`, `agents`, `deploy`, `approve`, `cat`, `open`, `copilot`… |

### 🔐 Governance highlights

```
Layer 4  APPROVAL GATES ──── human/delegate sign-off for privileged actions
Layer 3  MCP CALL AUDIT ──── every tool call logged, hash-chained, replayable
Layer 2  RUNTIME ISOLATION ── capability tokens, egress proxy, sandboxed tools
Layer 1  IDENTITY & ACCESS ── RBAC, agent principals, sessions, Telegram mapping
```

- 🟢 **Tier A** trust (≥ 80) → full-auto unlocks · 🟡 **Tier B** → default gates · 🔴 **Tier C** → quarantined
- 🚫 The Copilot **can never approve its own requests** — hard-enforced in code

---

## 📸 Screenshots

<div align="center">

<img src="docs/images/screens.svg" alt="SwarmOS screens: Command Deck, Live Swarm Monitor with dependency DAG, and Copilot action cards" width="100%"/>

*Left: Command Deck · Center: Live Swarm Monitor with dependency DAG & resource lanes · Right: Copilot full-control action cards*

</div>

<details>
<summary>🖼 More visuals (architecture)</summary>
<br/>
<img src="docs/images/architecture.svg" alt="SwarmOS self-hosted gateway architecture: single process with SQLite, MCP proxy, model gateway, no Redis/Postgres"/>
</details>

---

## 🚀 Quick Start

### 1️⃣ Prerequisites

- 📦 **Node.js ≥ 20**
- 🖼 ImageMagick *(optional — only for regenerating PWA icons)*

### 2️⃣ Install & run

```bash
# clone your fork / repo
git clone https://github.com/<you>/swarmos.git
cd swarmos

# install
npm install

# ▶ development server (http://localhost:5173, binds 0.0.0.0)
npm run dev
```

### 3️⃣ Production build — the real PWA ✅

```bash
npm run build     # static bundle (~37 KB gzipped JS)
npm run preview   # serves on http://localhost:4173 with service worker active
```

### 4️⃣ Install on your phone 📱

1. Open the URL on your phone (same network or via your host's preview proxy)
2. Browser menu → **Add to Home Screen** / **Install App** *(or Settings → ℹ️ About → Install app)*
3. 🎉 Launch from the home screen — offline shell included

### 🧪 Smoke tests

```bash
npm run smoke     # boots the real app in happy-dom and renders all 12 modules
```

---

## 🦾 Try the Copilot (it drives the whole app)

Open the **✦ dock** at the bottom and try:

| Command | Result |
| --- | --- |
| `status` | Gateway + fleet summary |
| `create agent Nova` | → confirm action card → agent created |
| `deploy swarm research` | → deploy plan card → live swarm with DAG |
| `approve ap-1` | Releases a gated action **on your explicit instruction** |
| `open analytics` | Navigation |
| `theme light` | Live theming |
| `analyze spend` | Cost report + drill-down |

> 🛡 Every mutation renders as an **action card** (risk level, diff, gate status) and is audited as *“You via Copilot”*.

---

## 🗺 Module Map

```
App Shell (PWA)
├── 🏠 Home / Command Deck
├── 🤖 Agents ─────────── profiles · wizard · brain · tools · memory · trust
├── 🐝 Teams & Swarms ─── topologies · deploy sheet · live DAG monitor
├── 📋 Tasks ──────────── Kanban · dependency graph · @agent dispatch
├── ⚡ Skills Hub ─────── marketplace · editor · synthesized-review queue
├── 🧠 Model Gateway ──── 26 providers · routing policies · budgets
├── 🧩 Plugins ────────── curated MCP + custom servers · scoped grants
├── 💬 Chat ───────────── threads · approvals inline · artifacts
├── ✈️ Telegram Bridge ── command layer · topics · signed buttons
├── 📊 Analytics ──────── KPIs · leaderboard · trust · self-improvement
├── 📁 Artifacts ──────── previews · upload · share · open-in-terminal
├── 💻 Terminal ───────── working swarm CLI
├── ⚙️ Settings ───────── everything, live
└── ✦ Copilot ─────────── available everywhere (full-control operator)
```

---

## 🏗 Architecture

<div align="center">
<img src="docs/images/architecture.svg" alt="Architecture: self-hosted gateway, SQLite, MCP proxy, zero external dependencies" width="100%"/>
</div>

| Layer | Choice |
| --- | --- |
| 🖥 UI | Vanilla ES modules + Vite · mobile-first design system · hash router (deep-linkable) |
| 📱 PWA | Manifest + service worker (offline shell, stale-while-revalidate) · installable · safe-area aware |
| 💾 State | Observable store (demo: `localStorage`; spec: **SQLite WAL**) |
| 🔌 Plugins | MCP via gateway proxy — agents never hold raw credentials |
| 🤖 Frameworks | Adapter interface (FAI) with capability matrix per framework |
| 📡 Realtime | Event envelope with cursors + missed-event replay (spec: `/ws`) |

---

## 🧬 Self-Improving Agent Loop

```
   goal ──▶ PLAN ──▶ ACT ──▶ OBSERVE ──▶ REFLECT
              ▲                              │
              └───── LEARN (ML layer) ◀──────┘
                     ├─ ⚡ skill synthesis   (never auto-activates without policy)
                     ├─ 📝 prompt refinement (eval-gated, rollback on regression)
                     └─ 🔧 tool optimization (contextual bandit, permission-safe)
```

---

## 🛠 Tech Stack

![](https://img.shields.io/badge/-Vite-646CFF?style=flat-square&logo=vite&logoColor=white)
![](https://img.shields.io/badge/-JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![](https://img.shields.io/badge/-Service%20Workers-6C8CFF?style=flat-square&logo=googlechrome&logoColor=white)
![](https://img.shields.io/badge/-SQLite-003B57?style=flat-square&logo=sqlite&logoColor=white)
![](https://img.shields.io/badge/-MCP-22D3EE?style=flat-square&logoColor=white)
![](https://img.shields.io/badge/-Telegram-26A5E4?style=flat-square&logo=telegram&logoColor=white)
![](https://img.shields.io/badge/-happy--dom-34D399?style=flat-square&logoColor=white)

---

## 🗺 Roadmap

- [x] 🏁 **P0 — Foundation**: app shell, 12 modules, PWA, copilot, kanban, terminal *(this release)*
- [ ] 🔌 **P1 — Orchestration**: real gateway + WebSocket live runs, Telegram bot server-side
- [ ] 🦞 **P2 — OpenClaw**: skills runtime, MCP proxy, 6 curated plugin connectors
- [ ] 🧬 **P3 — Intelligence**: self-improvement ML loop, trust scoring engine
- [ ] 🌍 **P4 — Scale**: full 26-provider matrix, all 7 framework adapters, a11y & perf hardening

---

## 🤝 Contributing

Contributions are welcome! 💜

1. 🍴 Fork the repo
2. 🌿 `git checkout -b feat/my-feature`
3. 💾 Commit with clear messages
4. ✅ `npm run smoke` must pass
5. 📬 Open a Pull Request

---

## 📄 License

Released under the **MIT License** — see [LICENSE](LICENSE) for details.

---

<div align="center">

**⭐ Star this repo** if SwarmOS helps you orchestrate agents from anywhere!

Made with ⬡ for agent operators · [Design Spec](docs/DESIGN_SPEC.md) · [Issues](../../issues)

</div>
