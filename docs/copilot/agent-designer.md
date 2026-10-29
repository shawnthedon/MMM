# Agent Designer — the agent-creation module

**Route:** `#/designer` · **Code:** `src/designer.js`, `src/designer.css`, `src/designerSummary.js`
**Evidence:** `npm run test:designer` → 18/18 · smoke renders the route · real save verified against the gateway.

The module implements the *Agent Creation Module — Design Specification v1.0* to the extent the
repository can honestly support it. Everything that cannot work is refused or reported, never
simulated: the designer produces a real, stored **agent definition** and says plainly that it
cannot start one.

## Shortcuts (all four entry points)

| Where | Control | What it does |
| --- | --- | --- |
| New-agent flow (wizard sheet) | *Open the Agent Designer instead* | Closes the wizard and opens the designer **seeded with the name, role, framework, model and autonomy** already chosen; the hand-off is recorded as an assumption. |
| Quick create sheet | *Design an agent* | Opens the designer on the Goal step. |
| All modules sheet | *Agent Designer* button + module tile | Opens the designer; the tile is part of `routes`, so it also gets a page title and tab handling. |
| Agents screen | *Designer* button next to *New* | Opens the designer. |

Copilot also answers for it: knowledge entry `ui.agent.designer` and `describeScreen('designer')`
report the draft name, framework/model, step and both validation states.

## Steps

1. **Goal** — free-text goal, optional name/role, six starter templates, and *Propose a
   configuration*. The proposal is a **deterministic keyword match on the device** (no model call);
   each inferred choice is listed as an assumption, and template entries that are not in the
   catalogue are dropped with a note.
2. **Components** — dependency map of runtime, AI brain (primary + fallback), behaviour, memory,
   interaction, tools/connectors, knowledge, permissions/gates and storage. Each node shows
   **compatibility** and **availability** as separate chips, the plain-language purpose, and any
   missing dependency. Optional nodes can be added or removed.
3. **Configure** — per-node inspector: framework; provider/model/fallback; preset, autonomy and
   step/time/cost limits; memory layers, scope and retention; interaction capabilities; skills and
   connectors; knowledge sources; derived permission scopes and gate settings; storage destination.
4. **Validate** — two groups, deliberately separate:
   - **Definition checks** — what this app can actually store (name, goal, runtime/model present,
     workspace autonomy cap, gates for write scopes, catalogue membership, indexed knowledge).
   - **Activation checks** — what running it would additionally need (installed adapter, provider
     credentials, memory backend, media services, tool executor, retrieval, artifact route,
     scheduler, role permission).
   Every finding names the missing dependency, its practical effect and a fix action.
5. **Activate (summary)** — capabilities, permissions, budget, storage and readiness. *Save
   definition* writes the record; *Why can't it run?* opens the blocker list.

## Validation states

Spec §8.2 labels, used verbatim in the UI: **Ready · Needs setup · Warning · Blocked ·
Unavailable · Not checked**. A capability is only "Ready" when every layer it needs is present;
unknown compatibility is reported as *Not checked*, never as success.

Blocking rules that stop saving: missing goal, missing/invalid/duplicate name, missing model,
`Scheduled / proactive` preset, a blocked interaction capability, ungated write scopes, and (in
gateway mode) no session, no `agent:write` or an agent list the gateway is not serving.

## Honest boundaries (what the module will not do)

| Capability | State here | Why |
| --- | --- | --- |
| Execute / "activate" an agent | **Blocked** | No framework adapter, host process, scheduler or cancellation path exists in this repository. |
| Provider calls | **Needs setup** | No provider client, no secret store, no provider route on the gateway. Model capability metadata is not declared anywhere, so compatibility stays *Not checked*. |
| Voice in/out, image in/out | **Blocked at selection** | No capture, transcription, synthesis or vision client; the checkboxes are disabled with the reason attached. |
| Scheduled / proactive behaviour | **Blocked at selection** | No scheduler or trigger service. |
| Persistent memory / knowledge retrieval | **Blocked for activation** | No memory backend (the spec leaves the first backend as an open decision), no ingestion, no vector store. Conversation context lives in this browser only. |
| Tools & connectors | **Recorded, not callable** | No executor and no credential store; scopes are derived from the catalogue and shown in the summary. |
| Artifacts | **Needs setup** | The gateway has a `files` table but no artifact route; fixture files are metadata only. |
| Budget/limits | **Advisory** | Stored on the definition and shown, but the gateway has no budget fields, so nothing enforces them. |

## What saving does

`toAgentRecord()` builds the record the app already understands (`name, role, framework, model,
fallback, status: 'idle', trust: 50, autonomy, tools, skills, prompt, memory`), so a designed agent
behaves like any other in Agents/Tasks/Copilot.

- **Gateway mode** (signed in, `agents` live, `agent:write`): `POST /api/v1/agents` through
  `src/datastore.js`, and the **server's** row is adopted (no duplicate, no client-side guess).
- **Demo mode**: written to the local store and tagged with an event; the toast says it is
  browser-only.
- **Refused**: if the gateway is not serving agents (or the role cannot write) nothing is written
  anywhere — the designer never creates a row the server does not have.

The draft itself is persisted to `localStorage['mmm.agentDraft.v1']` (name/goal/components only,
no credentials) and cleared after a successful save. *Discard* deletes it after a confirmation.

## Spec items not implemented (deliberate)

1. **"Agent Creation is the default module"** (spec §4) is a product decision, not a technical one:
   the app still lands on the Command Deck. Changing the landing route silently would break every
   deep link and test; it needs an explicit decision.
2. **Graph canvas with draggable nodes and inspectable edges** — the map is a dependency list with
   connectors, which is keyboard- and screen-reader-accessible by construction. A canvas would need
   a non-canvas equivalent anyway (spec §6.5).
3. **Test/sandbox run before activation** (spec §5.1 step 8) — impossible while no runtime exists;
   shown as unavailable rather than as a button that does nothing.
4. **Versioned edit of an existing agent with a diff** (spec §5.4) — the designer starts from a new
   draft; editing an existing agent still uses the Agent Manager fields, which write through the
   gateway.
5. **Connector manifests, rate limits, idempotency, health checks** (spec §7.6) — the catalogue has
   names/scopes/tools only; the designer does not invent the rest.

## Tests

`scripts/designer-test.mjs` (happy-dom, stub gateway): route + first step · each of the three
shortcuts (and the wizard hand-off) · template fill + assumptions · local proposal · definition vs
activation separation · blocked capabilities refused · disabled scheduled preset · ungated writes
and duplicate names block saving · demo save writes one idle row and clears the draft · unsaveable
draft writes nothing · gateway save POSTs with CSRF and adopts the server copy · no row when the
gateway is not serving agents · draft persistence · Copilot description · activation explanation.
