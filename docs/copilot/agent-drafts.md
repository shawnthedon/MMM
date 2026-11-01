# Copilot — agent drafts (M31)

| Field | Value |
| --- | --- |
| Parent spec | `MMM-Copilot-Design-Spec-2026-11-01.md` §3 (agent drafts), §6 (state model), §8 (permissions/approvals), §11 (copy) |
| Unit | 2 of 6 — **agent drafts** (1: conversation, M30; 3: swarm-plan drafts; 4: browser JSON; 5: voice; 6: hardening) |
| Baseline | `75faae4` → branch `arena/09de94d4-mmm` |
| Files | `packages/shared/agentDraft.js`, `apps/gateway/src/agentDrafts.js`, `apps/gateway/migrations/012_agent_drafts.sql`, `apps/gateway/server.js`, `src/copilot/drafts.js`, `src/copilot/panel.js`, `src/copilot.css`, `src/designer.js`, `src/api.js` |
| Evidence | `npm run test:drafts` (**21 passed**, real gateway + real loopback provider) · `npm run test:drafts:ui` (**10 passed**) · `npm run test:copilot` (6) · `npm run test:designer` (18) · `npm run test:auth` (16) · `npm test` green · `npm run build` |
| Status | **PASS for the agent-draft scope.** Swarm-plan drafts, browser JSON and voice are not built and the panel says so. |

---

## 1. The rule

A model may write JSON. A person may edit it. **Nothing becomes an agent until a different human allowed
it through an approval gate**, and activation stores an *idle* definition — no runtime in this repository
can execute an agent, so nothing starts.

That is not a prompt instruction. It is three conditions in code, checked in this order:

1. the route requires `agent:write`;
2. `agentDrafts.activationCheck` refuses unless the draft's `approvals` row is `allowed` **and** was not
   decided by the activating principal (RBAC already keeps `approval:decide` and `agent:write` in
   different roles — Reviewer and Operator — so this is the second lock, not the only one);
3. the canonical validator is re-run at activation time, so a draft that changed after approval cannot
   be activated on a stale verdict.

## 2. One schema, two editors, one verdict

`packages/shared/agentDraft.js` is plain JavaScript with no imports, loaded by the gateway *and* the
client:

- `normaliseSpec()` — coerces anything into the canonical shape, **drops unknown keys and reports them**
  (a field nobody stores must not survive a round trip and imply it was saved);
- `validateSpec(spec, ctx)` — findings with `{field, severity, title, detail}` and a derived state;
- `toAgentRecord()` — what activation stores;
- `toDesignerSeed()` / `fromDesignerDraft()` — the visual builder's shape, both directions;
- `parseDraftReply()` — pulls a JSON object out of a model reply, or explains why it could not;
- `draftInstruction()` — the prompt, which also states the build's limits as facts.

Why one file: two validators means the browser can call a draft "ready" while the server calls it
"invalid", and from the outside that is indistinguishable from a bug.

### States

`Draft · Needs information · Needs setup · Invalid · Blocked · Ready for review · Awaiting approval ·
Active · Archived` — and, declared but never used for a draft, `Running · Completed · Failed · Paused`,
which are properties of a *run*, not of a definition. The gateway recomputes the state on every write, so
a client cannot send one and an edit cannot leave a stale "ready" behind.

| Derived state | Means |
| --- | --- |
| `needs-information` | The definition is incomplete (name, goal, role, model). |
| `needs-setup` | Complete, but something outside the definition is missing — usually a provider key. **Submittable**: the setup item is part of what the reviewer is asked to accept. |
| `invalid` | A blocking error: an unusable name, a duplicate name, a write-capable interaction with the gates removed. |
| `ready-for-review` | Complete, nothing outstanding. |
| `awaiting-approval` | An `approvals` row exists and is pending — or denied, in which case activation is refused with that reason. |
| `active` | Activated once. Frozen: it records what was created. |

Every draft also carries a `blocked` finding — *"No runtime adapter"* — because it is true of every agent
in this build. A definition can be ready to review and still unable to run, and the card says both.

## 3. Routes

| Route | Permission | Notes |
| --- | --- | --- |
| `GET /api/v1/copilot/drafts` | `copilot:read` | Your drafts; an Owner sees all |
| `GET /api/v1/copilot/drafts/:id` | `copilot:read` | 404 for another principal's draft, not 403 — an id is not a capability |
| `POST /api/v1/copilot/drafts` | `copilot:write` | `{text}` → the model writes JSON (10/min per principal). `{spec}` → the builder saving |
| `PATCH /api/v1/copilot/drafts/:id` | `copilot:write` | Edit; state and findings recomputed |
| `POST /api/v1/copilot/drafts/:id/submit` | `copilot:write` | Refused unless `canSubmit`; creates a real `approvals` row (`agent.draft.activate`) |
| `POST /api/v1/copilot/drafts/:id/activate` | `agent:write` | Needs an allowed approval the caller did not decide |
| `POST /api/v1/copilot/drafts/:id/archive` | `copilot:write` | Archived rows stay readable; an active draft cannot be archived |

Activation writes the agent through the **same `insertAgent`** that `POST /agents` uses, so an
approval-gated agent cannot differ from a directly created one in what it stores.

## 4. What the panel does

- **"Create an agent that triages inbound tickets"** takes the draft path. The model writes JSON, the
  gateway validates it, and the panel renders a **draft card**: name, state in the canonical words, the
  findings that produced that state, and only the actions that state allows.
- **A question stays a question.** "How do agents work here?" is never turned into a definition — the
  intent check runs first and the request pattern is narrow.
- **A reply that is not JSON creates no draft.** The answer says what happened, the call is still
  metered, and the transcript shows the refusal (with its call id).
- **A refusal is shown verbatim.** Clicking Activate before approval, or after a denial, replaces the
  card's error line with the server's own words and leaves the state alone.
- **The builder is the same draft.** `Open in the builder` seeds the Agent Designer from the draft and
  remembers `sourceId`; saving there **PATCHes the draft** (re-validated by the server) rather than
  creating an ungated agent behind the approval gate's back.
- **Nothing is offered that would 403**: `actionsFor()` consults the permission set, so a Reviewer is
  never shown an Activate control they cannot use.

## 5. What was proven

`npm run test:drafts` — 21 checks against a real gateway and a real loopback OpenAI-compatible provider:
no key → 409 and zero drafts; a real JSON reply → `ready-for-review` decided by the validator; the turn
is in the transcript with its call id; a prose reply → 422, **no draft**, the call still metered; a model
that tries `state: "active"`/`agentId` → the server decides the state and the unknown fields are reported
as dropped; an edit recomputes the state; submitting an incomplete draft is refused with the reason;
submit creates a real approvals row; activation before approval → 409; the requester cannot allow their
own draft; a Reviewer cannot activate (no `agent:write`); an Owner who decided cannot activate what it
approved; activation creates exactly one idle agent through the shared insert path and is idempotent
afterwards; a denied approval never activates; an Observer cannot create or read others' drafts; a
builder spec with write capability and no gate is `invalid`; archive keeps the row; everything survives a
restart.

`npm run test:drafts:ui` — 11 checks: a question is not a draft; a request produces a card with the
server's state and findings; Submit appears only when the row allows it; submit moves the card and names
the gate; Activate appears for `agent:write` and creates the agent; a refusal is rendered verbatim
without moving the state; the builder opens seeded from the draft and saving PATCHes the same draft with
**no** agent created; a reload rebuilds the card from the draft the gateway still holds — so the card is a
view of a row, not a picture that dies with the transcript; a Reviewer is not offered Activate; with no
gateway there is no draft route at all.

`npm run test:drafts:browser` — 10 checks in real Chromium against a real gateway and a loopback
OpenAI-compatible provider, at a phone viewport: a key sealed through the Models sheet; “create an agent
that …” typed into the panel produces a card whose state is the validator's (`ready-for-review`) and whose
text carries the blocked-runtime finding; one metered row in `model_calls` with `purpose='copilot.draft'`
and the sealed key as its bearer; Submit creates a real approvals row that the Approvals screen reads;
Activate before the decision is refused in the server's words and creates no agent; a **Reviewer** sees the
gate and allows it; that same Reviewer cannot activate (no `agent:write`); after signing back in as the
Owner a full page reload rebuilds the card from the gateway's row with its live state; Activate creates
exactly **one** idle agent marked `approval_gates.draft`, and no event anywhere claims it ran; a second
activation returns 409 and leaves one agent; at 320 px the card fits with every button ≥ 44 px and no page
errors.

## 6. Honest limits

- **Activation creates a definition, never a run.** No adapter, process host or cancellation exists.
- **Setup findings do not block submission.** A draft can be approved while its provider key is missing;
  the card and the approval evidence both say so. That is deliberate: the approval is about the
  definition, and the model key is a workspace-level fact the reviewer may fix later.
- **No streaming, no regeneration.** A model reply arrives whole; a bad draft is edited, not re-rolled.
- **Drafts are not shared.** One owner per draft; an Owner can read others' but the list is scoped.
  A consequence: a second person does not see the card in *their* Copilot — they meet the draft on the
  Approvals screen, which is where the decision was always meant to happen.
- **Saving from the builder creates a new draft.** The panel's card PATCHes the draft it came from; the
  Agent Designer's Save is the existing designer path, and it is not wired to an existing draft id yet.
- **Not built yet**: swarm-plan drafts (unit 3), Agent Browser JSON (unit 4), open-source voice (unit 5).
