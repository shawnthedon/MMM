# Copilot — a browser script is a draft, and approving it *is* the run (M33)

| Field | Value |
| --- | --- |
| Parent spec | `MMM-Copilot-Design-Spec-2026-11-01.md` §3 (browser JSON), §9 (permissions), §11 (copy) |
| Unit | 4 of 6 — **Agent Browser JSON** (3: swarm-plan drafts, [`swarm-plan-drafts.md`](swarm-plan-drafts.md); 5: voice) |
| Files | `packages/shared/browserScript.js`, `apps/gateway/migrations/014_browser_script_drafts.sql`, `apps/gateway/src/browserScriptDrafts.js`, `apps/gateway/src/browser/{policy,runner}.js`, `apps/gateway/server.js`, `src/copilot/scripts.js`, `src/copilot/panel.js`, `src/copilot.css`, `src/api.js`, `packages/shared/api-routes.json` |
| Evidence | `npm run test:scripts` (**25 passed**, real gateway + real loopback provider + the simulated engine) · `npm run test:scripts:ui` (**10 passed**) · `npm run test:scripts:browser` (**9 passed** in real Chromium at a phone viewport) · `npm run test:browser` 22 · `npm test` · `npm run build` |
| Status | **PASS for the browser-JSON scope.** A script runs through the Agent Browser that already exists — no second executor, no new actions, no new schema. Unit 5 (open-source voice) landed afterwards — [`voice-input.md`](voice-input.md); unit 6 (hardening) scoped the live events this unit emits — [`hardening.md`](hardening.md). |

---

## 1. The rule that makes this unit different

Units 2 and 3 end at a *stored row*: an idle agent definition, a planned swarm. This unit ends at a **real
browser task**, so the language has to change:

> A model may write JSON. The canonical validator decides what that JSON means. A person may submit it.
> **Activating it — the `browser:run` permission plus an allowed approval this principal did not decide —
> queues one real `browser_tasks` row** through `runner.createTask`, the same function `POST
> /api/v1/browser/tasks` calls. Nothing runs before that gate opens.

That is why the draft cannot be `blocked` and submittable at the same time: activation *is* execution, so a
script with no engine behind it can never reach the gate. The single most likely lie in this area is a card
that says "queued" while no task exists; the test asserts the task row, its owner, its criteria and its
status directly in SQLite.

## 2. One validator, shared with the executor

`packages/shared/browserScript.js` validates the script and derives its plain-language preview. The executor
enforces the same rules independently:

| Refusal in `validateScript` | Refusal in the executor |
| --- | --- |
| scheme not in `http:` / `https:` (`file:`, `javascript:`, `data:`) | `policy.urlProblem()` + `createTask` refuses the `entryUrl` |
| action outside the plan's `allowActions` | `runner` refuses an unknown step |
| `click`/`type`/`extract` with no selector | the driver refuses the operand it needs |
| objective shorter than 10 characters | `createTask` refuses it |

Both are asserted on the *same* script: the draft refuses a `file:` step **and** `POST /browser/tasks` refuses
it identically. A draft stricter than the run it predicts would let a Reviewer approve something the gateway
would reject; a draft looser would let a run do something no one previewed.

The preview is generated from structured fields only:

- `goto` → *Open "https://…"*; `extract` → *Read "heading" from "h1"*; `click` → *Click "Sign in"*;
  `type` → *Type into "search"* — **the typed text is never echoed**, because a password typed into a form
  is the one part of a script that must not appear on a card;
- a step that commits the user (click, submit, sign-in) is flagged `sensitive` and badged *commits you*;
- the model's own prose is **never** a preview line. A reply that includes a friendlier sentence cannot
  soften what a step does, and a test asserts the card's steps are exactly the validator's.

## 3. States

The vocabulary is imported from `packages/shared/agentDraft.js`: `Draft`, `Needs information`, `Needs setup`,
`Invalid`, `Blocked`, `Ready for review`, `Awaiting approval`, `Active`, `Archived`.

The browser's own progress words — `queued`, `running`, `recovering`, `waiting_for_user`, `paused`,
`completed`, `failed`, `blocked`, `timed_out` — are **not** draft states. A draft stores no status, no
progress and no evidence: it reads `browser_tasks` and `browser_evidence` live through `taskSnapshot()` every
time it is serialised. A remembered status would be a status that goes stale, and a stale status is how a
card claims a finished run that is still queued.

`canSubmit` is true only when the validator says `ready-for-review` **and** an engine is available.
`canRun` is true only when the script is `awaiting-approval` and the gates are still open.

## 4. Routes

| Method | Path | Permission | What it does |
| --- | --- | --- | --- |
| GET | `/api/v1/copilot/scripts` | `copilot:read` | the caller's script drafts (an Owner sees all) |
| GET | `/api/v1/copilot/scripts/:id` | `copilot:read` | one draft, re-validated, with its live task snapshot |
| POST | `/api/v1/copilot/scripts` | `copilot:write` | `{text}` → the model writes a script (rate-limited, metered, purpose `copilot.script`); `{script}` → validated as-is, no model |
| PATCH | `/api/v1/copilot/scripts/:id` | `copilot:write` | edit; state and findings recomputed; a client cannot send a state, a task id or a `driver` |
| POST | `…/:id/submit` | `copilot:write` | creates the `approvals` row with action `browser.script.run`, risk `high`, evidence = the preview |
| POST | `…/:id/activate` | **`browser:run`** | queues the real task via `createTask`, refuses a self-decided gate |
| POST | `…/:id/archive` | `copilot:write` | keeps the row, read-only |

`draftFail` maps: `not-found` 404 (another principal's draft is never a 403), `forbidden` 403,
`conflict`/`no-engine`/`no-model` 409, `budget-exceeded` 402, `timeout` 504, `unusable-draft` 422. The rate
limit applies only to the model path — a script object from a form calls no provider.

## 5. What the panel does

- **Intent first, and narrow.** `wantsScript()` needs a browsing verb *and* a place to browse; a question
  ("how do I scrape a site?") stays a question, and "build an agent that checks pricing" is still an agent
  because the agent and plan patterns are checked after this one only for their own words.
- **A script card**: objective and canonical state, the page it opens, the validator's numbered preview with
  the committing step tinted, the findings, and one sentence saying that approving it runs it once.
- **Only the actions the row and role allow.** `Submit` when `canSubmit`; `Run this script` only with
  `browser:run` on an `awaiting-approval` draft; `Review the gate` for `approval:decide`; `Archive` while it
  is neither active nor archived; `Open the task` once a task exists.
- **The card never advances itself.** Every reply renders the server's next state or the server's refusal
  verbatim, inside `role="alert"`, leaving the state where the server left it.
- **The task is reported, not predicted.** After a run the card shows the task's real `status`, step index,
  evidence count, outcome and blocker, and says *simulated engine — not a real browser* when that is what
  ran.
- **A reload rebuilds the card** from `GET /copilot/scripts` via `payload.draftKind === 'browser-script'` and
  `payload.draftId`, so the card returns with the task's **live** state rather than the state it had when the
  turn was written.

## 6. What was proven

`npm run test:scripts` — 25 checks against a real gateway, a real loopback OpenAI-compatible provider and the
simulated engine:

- no key → 409 `no-model`, nothing created, provider never contacted;
- a real JSON reply → `ready-for-review` decided by the validator, preview derived from the steps, metered
  under `copilot.script`, the turn stored with its call id;
- the model's prose cannot add, remove or soften a preview line;
- a `type` step never previews the text it types (a secret stays out of the card and out of the transcript);
- a non-JSON reply → 422 `unusable-draft`, **no draft**, still metered, and the reply says nothing ran;
- `file:`, `javascript:`, an unknown action and a selector-less click are refused — and `POST
  /browser/tasks` refuses them identically;
- no engine → `blocked`, submit refused, nothing queued;
- submit creates a real `approvals` row: action `browser.script.run`, risk `high`, evidence = the preview;
  self-approval 403, a Reviewer without `browser:run` 403, an Observer 403/404;
- running before the decision → 409 and no task; running as the decider → 403; running for a different
  principal → 201, **exactly one** real task owned by that principal, queued with the criteria the script
  declared;
- the draft reports the task's live state, a failed run is reported as failed with the step timeline that
  includes the failure, and a run that verifies its criteria reports `verified` with the observation that
  proved it;
- a second run → 409, no second task; a denied gate never runs; an active draft cannot be edited or
  archived; drafts and their tasks survive a restart.

`npm run test:scripts:ui` — 10 checks: a question drafts nothing; "open … and check …" produces a script
card and neither an agent nor a plan; the steps are the gateway's preview with the committing step marked;
Submit only when the row says so; `Run` only with `browser:run` on an awaiting-approval draft and never on
behalf of a role that cannot; a run renders the task's real status **including a failure** and never claims
success; a refusal is rendered verbatim without moving the state; a blocked script offers only archiving; a
reload rebuilds the card with the task's live status; with no gateway there is no script route at all.

`npm run test:scripts:browser` — 9 checks in real Chromium at a phone viewport: a key sealed through the
Models sheet; the request typed into the panel; one metered `copilot.script` row while **zero** browser tasks
exist; Submit → a real approvals row whose evidence is the preview; running before the decision refused with
no task; a **Reviewer** allowing the gate and being refused the run (no `browser:run`); the Owner signing
back in, a full reload rebuilding the card with its live state; running queueing exactly one task owned by
the runner with its criteria carried through, status `queued`, and the card showing `queued`; a second run
409; and the card fitting 320 px with 44 px buttons and no page errors.

## 7. Honest limits

- **The gateway host decides what can run.** `availableEngines()` reports the Puppeteer/Chromium engine when
  a browser binary is present and the simulated pages driver only when `MMM_BROWSER_ALLOW_SIM=1`. With
  neither, every script is `blocked` and nothing can be submitted — the card says so instead of pretending.
- **A run is a real run.** Activating a script with Chromium available opens real pages on the gateway host.
  There is no dry-run mode, which is exactly why the preview is generated from the script and not from the
  model.
- **The simulated driver is a test fixture.** Its pages come from the task's `sim` column, which `POST
  /browser/tasks` accepts only when `MMM_BROWSER_ALLOW_SIM=1`. Every card that shows a simulated run says
  *simulated engine — not a real browser*.
- **The script vocabulary is the existing one.** This unit adds no action, no field and no selector dialect:
  it validates `goto`, `extract`, `click`, `type` and the criteria the Agent Browser already observes.
- **Built after this unit**: open-source voice (unit 5, [`voice-input.md`](voice-input.md)) and the hardening
  pass (unit 6, [`hardening.md`](hardening.md)). The selection/handoff behaviour
  is the same as unit 2's.
