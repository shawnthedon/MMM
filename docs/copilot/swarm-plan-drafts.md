# Copilot — a workflow is a swarm plan, and a plan is not a run (M32)

| Field | Value |
| --- | --- |
| Parent spec | `MMM-Copilot-Design-Spec-2026-11-01.md` §3 (workflow drafts), §9 (permissions), §11 (copy) |
| Unit | 3 of 6 — **workflow / swarm-plan drafts** (unit 2, agent drafts: [`agent-drafts.md`](agent-drafts.md)) |
| Files | `packages/shared/swarmPlanDraft.js`, `apps/gateway/migrations/013_swarm_plan_drafts.sql`, `apps/gateway/src/swarmPlanDrafts.js`, `apps/gateway/server.js`, `src/copilot/plans.js`, `src/copilot/panel.js`, `src/copilot.css`, `src/api.js`, `packages/shared/api-routes.json` |
| Evidence | `npm run test:plans` (**24 passed**, real gateway + real loopback provider) · `npm run test:plans:ui` (**10 passed**) · `npm run test:plans:browser` (**10 passed** in real Chromium at a phone viewport) · `npm run test:drafts` 21 · `npm test` · `npm run build` |
| Status | **PASS for the plan-draft scope.** Nothing in this unit schedules, starts or advances a plan; Agent Browser JSON and voice are units 4–5 and are not built. |

---

## 1. The rule

A workflow in MMM **is** a swarm plan. There is no workflow schema, no second plan table and no second
runner. So unit 3 is not "a new artefact type" — it is the same draft model applied to the artefact that
already existed:

> A model may write JSON. The **canonical validator** decides what that JSON means. A person may edit it.
> **Submitting** opens a real approval gate in the shared `approvals` table. **Saving** requires
> `swarm:write` *and* an allowed approval that this principal did not decide — and it writes one `swarms`
> row through `createSwarm`, which sets `executed = 0`, `progress = 0` and `spent = 0`.

The one thing the card says, every time, in its own words: **nothing runs this plan.** No scheduler, no
worker, no cancellation exists in this build.

## 2. One validator that is never stricter than the save

`packages/shared/swarmPlanDraft.js` validates exactly what `apps/gateway/src/swarms.js` accepts. That is
the whole reason it is a shared file rather than prompt text:

| Refusal in `createSwarm` | Finding in `validatePlan` | State |
| --- | --- | --- |
| `an objective is required` | `error` · *No objective* | `invalid` |
| `team “x” does not exist` (404) | `error` · *That team does not exist* | `invalid` |
| `a budget cap must be a number of zero or more` | `error` · *Budget cap is not a number* | `invalid` |
| `a budget cap above 100000 is refused` | `error` · *Budget cap above the limit* | `invalid` |
| `a plan can hold at most 24 nodes` | `error` · *Too many nodes* | `invalid` |
| *(accepted)* duplicate node ids | `warning` · *Two nodes share an id* | unchanged |
| *(accepted)* no node order → default order | `warning` · *No node order* | unchanged |
| *(nothing)* | `blocked` · *Nothing executes this plan* | never changes the state |

The duplicate-id row is the interesting one: `createSwarm` stores duplicate ids without complaint, so the
validator may only warn. A draft validator that refused them would make the draft stricter than the save
it predicts — and a Reviewer would then be unable to approve a plan the gateway would happily store. The
mirror rule cuts both ways, and it is asserted in a test.

An approval is not evidence that something was checked; it is evidence that a person looked. If activation
could still fail after an `allow`, the approval would be theatre.

## 3. States

The vocabulary is **imported** from `packages/shared/agentDraft.js`, not redefined: `Draft`, `Needs
information`, `Needs setup`, `Invalid`, `Blocked`, `Ready for review`, `Awaiting approval`, `Active`,
`Archived`. `Running/Completed/Failed/Paused` exist in the vocabulary and are never applied to a plan
draft, because they describe a run and there are none.

`canSubmit` is true only for `ready-for-review` and `needs-setup`. `canRun` is **always false** —
`validatePlan` always emits the blocked execution finding, so the field cannot accidentally become true.

## 4. Routes

| Method | Path | Permission | What it does |
| --- | --- | --- | --- |
| GET | `/api/v1/copilot/plans` | `copilot:read` | the caller's plan drafts (an Owner sees all) |
| GET | `/api/v1/copilot/plans/:id` | `copilot:read` | one draft, re-validated |
| POST | `/api/v1/copilot/plans` | `copilot:write` | `{text}` → the model writes a plan (rate-limited, metered); `{plan}` → a plan object, no model |
| PATCH | `/api/v1/copilot/plans/:id` | `copilot:write` | edit; state and findings recomputed, a client cannot send a state |
| POST | `…/:id/submit` | `copilot:write` | creates the `approvals` row with action `swarm.plan.save` |
| POST | `…/:id/activate` | **`swarm:write`** | saves the plan via `createSwarm`, refuses a self-decided gate |
| POST | `…/:id/archive` | `copilot:write` | keeps the row, read-only |

`draftFail` maps: `not-found` 404 (another principal's draft is never a 403 — an id is not a capability),
`forbidden` 403, `conflict`/`no-model` 409, `budget-exceeded` 402, `timeout` 504, `unusable-draft` 422.

The model path sets `purpose: 'copilot.plan'` on the metered call, so the ledger can tell a plan draft from
an agent draft. The rate limit applies **only** to the model path: a plan object from a form calls no
provider, and throttling it would be a limit on typing.

## 5. What the panel does

- **Intent first.** `wantsPlan()` runs before `wantsDraft()`: "create a swarm of agents that researches"
  contains words that would otherwise match the agent pattern, and a workflow request must not silently
  become one agent. A question ("how do swarms work?") stays a question in both.
- **A plan card**, not a chat bubble: name and canonical state, the objective, node count, cap, channel,
  the first nodes in order, the validator's findings, and one sentence stating that saving stores a
  `planned` swarm with no progress and no spend.
- **Only the actions the row and the role allow.** `Submit` when `canSubmit`; `Save as a plan` only for
  `swarm:write`; `Review the gate` for `approval:decide`; `Archive` while it is neither active nor
  archived; `Open the plan` once it has a swarm id. A Reviewer sees the gate and is never offered the save.
- **The card never advances itself.** Every reply renders the server's next state, or the server's refusal
  verbatim, leaving the state where the server left it.
- **A reload rebuilds the card** from `GET /copilot/plans` using `payload.draftKind === 'swarm-plan'` and
  `payload.draftId` on the stored assistant turn — so a plan card is a view of a row, not a picture.

## 6. What was proven

`npm run test:plans` — 24 checks against a real gateway and a real loopback OpenAI-compatible provider:

- no key → 409 `no-model`, zero plan drafts, provider never contacted;
- a real JSON reply → `ready-for-review` decided by the validator, nodes and cap stored, `canRun` false,
  the call metered under `copilot.plan`;
- the turn is in the transcript with its call id, and the summary says nothing starts;
- a prose reply → 422 `unusable-draft`, **no plan draft**, the call still metered;
- a model that sends `executed: true`, `status: "running"`, `progress: 80`, `budget.spent`, `swarmId`,
  `state` and `ownerId` → all seven are dropped **and reported**, none is stored, and no execution claim
  survives anywhere in the plan;
- the five cases the gateway refuses (no objective, a team that does not exist, a cap that is not a number,
  a cap/draft with too many nodes…) are `invalid` and not submittable, **and `POST /swarms` refuses them
  too** — the comparison is made per case, not asserted;
- duplicate node ids are a warning because `POST /swarms` accepts them (the mirror rule, pinned);
- an edit recomputes the state; submitting an invalid plan is refused with the reason; submit creates a
  real approvals row with `action: 'swarm.plan.save'` whose evidence says "starts nothing";
- saving before the decision → 409 and no swarm; the requester cannot allow their own gate; the Reviewer
  allows it and is refused the save (no `swarm:write`); an Owner who decided cannot save what it approved;
- saving by another principal writes **one** swarm: `status: planned`, `executed: false`, `progress: 0`,
  `spent: 0`, `cap: 6`, four nodes all `planned`, `runtime.scheduler: false`, and no event claiming a run;
- a second save → 409, no duplicate; an active plan draft cannot be edited or archived;
- a denied gate never saves; an Observer cannot create or read another principal's plan draft;
- plan drafts and their swarms survive a gateway restart.

`npm run test:plans:ui` — 10 checks: a question is not a plan; "draft a plan that …" produces a plan card
and **not** an agent draft; "create a swarm of agents that …" is a plan, not one agent; Submit only when the
row says so; the Owner is offered the save and the Reviewer is not (and is pointed at the gate); saving
turns the card active and says zero progress, zero spend, nothing can start it; a refusal is rendered
verbatim without moving the state; an invalid plan offers only archiving; a reload rebuilds the card from
the gateway's row; with no gateway there is no plan route at all.

`npm run test:plans:browser` — 10 checks in real Chromium at a phone viewport: a key sealed through the
Models sheet; the request typed into the panel; one metered `copilot.plan` row; Submit → a real approvals
row the Approvals screen reads; saving before the decision refused with no swarm saved; a **Reviewer**
allowing the gate and being refused the save; the Owner signing back in, a full reload rebuilding the card
with its live state; saving creating exactly one planned, unexecuted swarm with zero progress and zero
spend; the Swarms screen showing the plan with a row that does not claim a run; a second save 409; and the
card fitting 320 px with 44 px buttons and no page errors.

## 7. Honest limits

- **Saving stores a plan. Nothing ever runs it.** There is no scheduler, worker, queue or cancellation in
  this build; `swarms.runtimeStatus()` is attached to every payload and says so.
- **A plan has no progress and no spend**, computed from `executed`, never trusted from a column.
- **The node→agent assignment is advisory.** `createSwarm` cycles team members over nodes; an agent id a
  node names that does not exist is a warning on the card, not a refusal, because nothing checks it at run
  time (there is no run time).
- **Plan drafts are not shared.** Like agent drafts, a second person meets the plan on the Approvals
  screen, not in their own Copilot.
- **Not built yet**: Agent Browser JSON from conversation (unit 4), open-source voice (unit 5), hardening
  (unit 6). The Copilot discusses those and cannot produce them.
