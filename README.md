# SwarmOS — AI Agent Orchestration Dashboard (PWA Prototype)

Mobile-first **Progressive Web App** prototype for creating, deploying, and governing AI agent teams and swarms. Companion to the full design specification in [`docs/DESIGN_SPEC.md`](docs/DESIGN_SPEC.md).

## ✨ What works in this prototype

| Area | Working features |
| --- | --- |
| **PWA** | Installable (manifest + service worker), offline shell, theme-color, app shortcuts, safe-area aware |
| **Home / Command Deck** | Live stats, spend sparkline, pending-approval banner, live swarms, activity feed |
| **Agent Manager** | Agent list w/ filters, 7 framework badges, 4-step create wizard, detail with Brain/Tools/Skills/Memory, run/pause/clone/delete (guarded) |
| **Teams & Swarms** | Team cards, deploy sheet (objective, budget, topology, gates), live swarm monitor with dependency **DAG**, resource allocation bars |
| **Kanban** | Drag & drop (touch + mouse), 4 columns, task detail sheet, move/reassign/run-with-agent |
| **Skills Hub** | Installed / Marketplace / Mine / **Synthesized** tabs, manifest preview, eval trends, approve/reject agent-written skills |
| **Model Gateway** | All **26 providers** (Frontier → Enterprise) with live toggles, routing policies, budget bars |
| **Plugin Marketplace** | GitHub, Firecrawl, Vercel, Supabase, Airtable, Base44 + custom MCP; install flows with scoped permissions |
| **Chat** | Threads, @agent mentions, simulated streaming replies, inline approval cards that actually resolve gates |
| **Telegram Bridge** | Live bot phone-preview with executable commands (`/status`, `/swarms`, `/budget`, `/ask`…), topics, allowlist |
| **Analytics** | Live KPIs, spend charts, agent leaderboard, trust posture, self-improvement impact, MCP activity |
| **Artifacts & Files** | File browser, content previews, upload, share, open-in-terminal |
| **Terminal** | Working `swarm` CLI: `status`, `agents`, `deploy`, `approve`, `cat`, `open`, `theme`, `copilot`… |
| **Settings** | Live theme/density, autonomy & self-improve policies, **trust-score weight sliders**, notifications, reset demo |
| **Copilot** | Full-control intent engine: `create agent`, `deploy swarm`, `approve`, `open <module>`, `theme`… with confirm **action cards** and a hard self-approval ban |

## 🚀 Run it

```bash
npm install
npm run icons     # rasterize PWA PNG icons (uses ImageMagick if present)
npm run dev       # dev server on http://localhost:5173 (binds 0.0.0.0)
```

Production build (true PWA — service worker active):

```bash
npm run build
npm run preview   # serves the built app on http://localhost:4173 (binds 0.0.0.0)
```

Open the URL on your phone (same network) or via your host's preview proxy, then **Add to Home Screen / Install App**.

## 🏗 Architecture notes

- **Zero build-time framework** — vanilla ES modules + Vite. Tiny, fast, no runtime deps.
- **State**: single observable store persisted to `localStorage` (demo stand-in for the self-hosted gateway's SQLite).
- **Router**: hash-based (`#/agents/ag-researcher`) — every entity is deep-linkable.
- **Service worker**: cached app shell + stale-while-revalidate assets → works offline after first visit.
- **Design system**: implements the spec's tokens (dark/light themes, trust tiers, semantic status colors, 44px touch targets).

## 📐 Design spec

See [`docs/DESIGN_SPEC.md`](docs/DESIGN_SPEC.md) for the complete 12-module specification, four-layer Trust & Governance framework, self-improving agent loop, parallel execution engine, SQLite data model, and provider matrix.

## Roadmap (from spec §25)

- **P0** Foundation (this prototype) → **P1** real gateway + WebSocket live runs
- **P2** OpenClaw skills runtime + MCP proxy → **P3** self-improvement ML loop → **P4** full provider matrix + adapters
