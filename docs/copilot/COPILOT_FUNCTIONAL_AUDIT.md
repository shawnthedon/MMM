# Copilot Functional Completion & Reliability — Initial Functional Audit

**Status:** audit only. No production behaviour was changed to produce this document.
**Branch:** `arena/790683d5-mmm` @ `9041bff` ("Merge pull request #53", Phase B registry + Phase C dispatcher).
**Date:** 2026-11-04.
**Method:** every claim below was read out of the current source, then checked by running the code
(`node` against `apps/gateway/src/*`, the dispatcher/capability suites, and the full `npm test`).
Where a number is quoted, the command that produced it is named. Nothing here is inferred from a
comment, a doc string, or a previous report — comments are quoted only when the code behind them was
checked too.

---

## 0. Baseline, measured on this commit

| Fact | Value | How |
| --- | --- | --- |
| Full suite | **898 PASS, 0 FAIL, exit 0** | `npm test > /tmp/baseline-test.log` (this commit, clean tree) |
| Suite groups | 25 groups reported, including `DISPATCHER: 36 passed, 0 failed` | same log |
| Registry size | **143 operations** | `capabilities.OPERATIONS.length` |
| Operations with an execution contract | **68** (21 explicit + 47 derived) | `resolveContract(op)` per op |
| Operations without a contract | **75** = 66 route-backed + 9 route-less | same |
| Live states (seed deployment) | `available 120 · unconfigured 10 · unverified 4 · no-service 9` | Phase B probe, still reproduced by `npm run test:capabilities` |
| Registry `confirmation: 'approval'` ops | **19** | `OPERATIONS.filter(o => o.confirmation === 'approval')` |
| Registry `confirmation: 'confirm'` ops | **52** | same |

The suite is green. **Green is not the same as correct**: the findings below are behaviours the suite
currently *asserts*, in several cases asserting the wrong thing (see F2-1 and F9-1). No test was
removed or weakened to write this audit; nothing was edited at all.

---

## 1. Executive findings

Severity is about user-facing trust: does the product claim something the system did not do?

| # | Finding | Severity | Priority |
| --- | --- | --- | --- |
| **F1-1** | 18 of the 19 registry `approval` operations are **not gated at the route**. A principal holding the plain write permission performs them in one request, with no second person, no gate, no single-use spend. The registry declares a control that the security boundary does not implement. | **Critical** | P2 |
| **F1-2** | Two different execution paths exist for "make a change": the Phase C dispatcher (`POST /api/v1/dispatch`) and the deterministic orchestrator calling raw routes directly (`api.createAgent`, …). Only the first is contract-checked, rate-limited and audit-chained as a dispatch. | **High** | P1/P4 |
| **F1-3** | A legacy card path reports success it never verified: `copilotSay(text, actionCard)` returns `{status:'ok', summary:'… executed.'}` after calling a screen-supplied closure, with no service response. It is dead product code but a **live assertion** in `scripts/smoke.mjs:260` ("legacy copilotSay action cards still execute"). | **High** | P1 |
| **F1-4** | `runProposal` converts a handler that returns `undefined` into `{status:'ok', summary:'Action completed.'}`. | **High** | P1 |
| **F1-5** | With no model configured, the panel answers from a deterministic engine over the browser demo store. It is labelled ("demo answer, no model called", "seeded demo state"), so it is not a lie — but the gateway's own conversation route is bypassed, and `gatewayState:'demo'` conflates *no gateway* with *demo data*. | Medium | P1 |
| **F1-6** | 75 of 143 operations cannot be dispatched at all (no contract). 66 of them are backed by a real, working route. | **High** | P3 |
| **F1-7** | Approvals are bound to `action` + `target` only. Not to parameters, not to the Copilot conversation or message, not to an expiry. `approvals.expires_at` and `approvals.policy_id` exist in the schema and are **never written or read**. | **High** | P5 |
| **F1-8** | Separation of duties compares the gate's `principal` **string** — which `POST /api/v1/approvals` accepts from the request body — against the decider's id/name. There is no `requested_by` id column. | **High** | P2/P5 |
| **F1-9** | There is no model/provider connectivity test operation in the registry or the routes (only `POST /providers/:id/call`, which is a real call). P6 asks for one; it must be built, not asserted. | Medium | P6 |
| **F1-10** | The dispatcher's outcome vocabulary is four values (`executed, proposed, refused, failed`). P7 requires eleven distinguishable states. Detail exists in `code`, but there is no mapping and no UI contract for it. | Medium | P7 |

---

## 2. Priority One — misleading demo paths

### 2.1 What is genuinely honest (do not "fix" these)

These were checked and are correct. They must survive every later increment.

| Behaviour | Evidence |
| --- | --- |
| A gateway refusal is reported verbatim; the client never synthesises an optimistic result | `src/copilot/actions.js:1-13` and `resultCard()` — comment matches code: no optimistic "done" state |
| A proposal the gateway validated is rendered as a proposal; the Run button appears only when the gateway said `runnable` | `src/copilot/actions.js:cardFor` |
| Parameters never round-trip: confirming names the stored message id | `apps/gateway/src/copilot.js:670-675` (`dispatcher.execute` re-reads stored `action.params`) |
| No model ⇒ no assistant turn is fabricated on the server | `apps/gateway/src/copilot.js:583-590` (`narrate` returns `{reported:false, reply:null, note}`) |
| Demo-state answers say so in their own text | `src/copilot/orchestrator.js:150-190` — "seeded demo state", "demo figures, not metered usage", `Source: local demo store` |
| Built-in-engine replies carry "demo answer, no model called" in the meta line | `src/copilot/panel.js:1136-1139` |
| Swarm records created locally are labelled "not executed", nodes "seeded" | `src/copilot/orchestrator.js:556-560` |
| An existing honesty suite already scans for fabricated capabilities | `scripts/honesty-test.mjs` (193 lines, 12 checks), `scripts/honesty-browser-test.mjs` (127 lines) |

### 2.2 What is misleading

**F1-3 — the legacy card fabricates success.**
`src/copilot/panel.js:2283-2306`:

```js
execute: () => {
  actionCard.run?.();
  return { status: 'ok', summary: `${actionCard.title || 'Action'} executed.`, steps: [...] };
},
```

No service is called and no response is read. `runProposal` (`orchestrator.js:1225`) then records an
episode with `outcome: 'ok'` and renders a result card. Callers in product code: none (the comment
claims `src/terminal.js` and `src/views2.js`; `grep` finds no call site). Callers in tests:
`scripts/smoke.mjs:260` asserts it. **Decision required:** delete the action-card branch and the smoke
assertion with it, or keep it behind an explicitly enabled sandbox flag with a visible label. P1 says
demo mode must be "explicitly enabled and visibly labelled"; dead code with a fake success is neither.

**F1-4 — an undefined handler result becomes success.**
`orchestrator.js:1237`: `result = (await card.execute(card.params)) || { status: 'ok', summary: 'Action completed.' }`.
A handler that forgets to return is reported as a completed action. Fix: a missing result is
`failed` with "the handler returned nothing, so nothing is confirmed".

**F1-2 — two execution paths.**
`src/copilot/panel.js:1306-1312`: when `session.live !== 'live'` the turn goes to `respond()` →
`orchestrator.handle()`. Its `operate`/`build` proposals carry `execute` closures that call
`api.createAgent()` etc. directly (`orchestrator.js:408`, `:528`, `:588`, `:659`), i.e. raw
`POST /api/v1/agents`. The Phase C path (`panel.runAction` → `actions.run` → `/api/v1/dispatch`) is
the only one that gets: contract validation, the 15 s timeout race, the 64 kB result cap, the
per-principal rate limit and the hash-chained `dispatch.<op>` audit row. The orchestrator path gets
the route's RBAC and the route's own audit row — so this is **not a security hole**, but it is a
duplicate implementation of "operate", and P4 ("the model must never bypass the dispatcher") cannot
be answered while it exists.

**F1-5 — `demo` means "no gateway".**
`src/copilot/panel.js:1194`: `const gatewayState = convo.available() ? st.status : 'demo';` and
`:42 session.gatewayState = 'demo'`. The word `demo` is used for the absence of a gateway, for the
absence of a model, and for seeded fixture data. These are three different facts with three different
honest sentences. The registry already refuses `demo` state for dispatch (`dispatcher.js` RUNNABLE =
`{'available'}`), so nothing executes — but the UI vocabulary conflates them.

### 2.3 Acceptance criteria for the P1 increment (D1)

1. No code path returns a success status without reading a response from the service that was asked to
   act. Enforced by test, not by review.
2. A turn with no model says exactly which of the three facts is true: no gateway / gateway without a
   provider key / provider key present but the call failed — and never answers with engine text
   pretending to be a model reply.
3. Existing demo-mode affordances are either removed or reachable only via an explicitly enabled flag
   whose UI label is visible in the same view.
4. `scripts/honesty-test.mjs` gains checks for (1)–(3), so the rule is regression-tested at source level
   in the same style as the existing 12 checks.

---

## 3. Priority Two — approval and security consistency

### 3.1 The table that matters

For each of the 19 registry operations with `confirmation: 'approval'`, the route handler was located
by verb+pattern in `apps/gateway/server.js` and searched for any approval logic. Result:

| Operation | Route | Route enforces approval? |
| --- | --- | --- |
| `tokens.revoke` | `DELETE /api/v1/tokens/:id` | **no** (L457) |
| `agents.delete` | `DELETE /api/v1/agents/:id` | **no** (L1735) |
| `teams.delete` | `DELETE /api/v1/teams/:id` | **no** (L621) |
| `swarms.delete` | `DELETE /api/v1/swarms/:id` | **no** (L720) |
| `providers.key.clear` | `DELETE /api/v1/providers/:id/key` | **no** (L773) |
| `chat.delete` | `DELETE /api/v1/threads/:id` | **no** (L1720) |
| `copilot.clear` | `DELETE /api/v1/copilot` | **no** (L918) |
| `terminal.session.close` | `DELETE /api/v1/terminal/sessions/:id` | **no** (L1453) |
| `terminal.grant.add` | `POST /api/v1/terminal/grants` | **no** (L1619) |
| `terminal.grant.revoke` | `DELETE /api/v1/terminal/grants/:a/:w` | **no** (L1629) |
| `comms.channel.delete` | `DELETE /api/v1/comms/:name` | **no** (L1884) |
| `voice.endpoint.create` | `POST /api/v1/voice/endpoints` | **no** (L1310) |
| `voice.endpoint.update` | `PATCH /api/v1/voice/endpoints/:id` | **no** (L1320) |
| `voice.endpoint.delete` | `DELETE /api/v1/voice/endpoints/:id` | **no** (L1328) |
| `evolution.policy.set` | `PATCH /api/v1/evolution/agents/:id/policy` | **no** (L2081) |
| `evolution.grants.create` | `POST /api/v1/evolution/grants` | **no** (L2088) |
| `evolution.grants.revoke` | `DELETE /api/v1/evolution/grants/:id` | **no** (L2099) |
| `evolution.rollback` | `POST /api/v1/evolution/agents/:id/rollback` | **no** (L2123) |
| `evolution.experiments.deploy` | `POST /api/v1/evolution/experiments/:id/deploy` | **no** (L2188) |

**19 declared, 0 enforced at the route.** The only approval checks in the codebase live in a different
family of routes — agent drafts, swarm plan drafts and browser script drafts
(`server.js:1047, 1147, 1253`) and the terminal run gate (`server.js:1483`) — and those are enforced by
a bespoke `check.approval` call inside each handler, not by anything the route table can guarantee.

### 3.2 The inverse discrepancy also exists

The registry **under-declares** controls that the routes do enforce:

| Operation | Registry `confirmation` | What the route actually does |
| --- | --- | --- |
| `copilot.drafts.activate` | `none` | requires `agent:write` **and** an allowed approval not decided by the caller (`server.js:1040-1050`) |
| `copilot.plans.activate` | `none` | same pattern (`server.js:1140-1150`) |
| `copilot.scripts.activate` | `none` | same pattern (`server.js:1247-1256`) |
| `terminal.exec` | `confirm` | parks the run as `awaiting_approval` for the destructive set (`server.js:1483`) |

Consequence: `confirmation` in the registry is **not authoritative today**, in either direction. Any
work that relies on it — the Copilot briefing, the UI label, a future gate — inherits that.

### 3.3 Binding, reuse, expiry, separation of duties

| Property | State | Evidence |
| --- | --- | --- |
| Bound to operation | yes | `dispatcher.js` compares gate `action` with `dispatch:<op>` |
| Bound to target | yes | `target = contract.target(params) \|\| operationId` |
| Bound to **parameters** | **no** | nothing hashes or stores the params |
| Single-use | yes (dispatcher only) | `consumed_at` + `consume()` guarded by `consumed_at IS NULL` |
| Expiry | **no** | `approvals.expires_at` exists in `001_init.sql:97`, never written or read anywhere (`grep -rn expires_at apps/gateway` returns only `sessions`, `capability_tokens`, `evolution_grants`) |
| Requester is an **id** | **no** | `approvals.principal` is a display **name**, and `POST /api/v1/approvals` takes `b.principal` straight from the body (`server.js:1807-1808`) |
| No self-approval | partially | `rbac.js:151-170` compares the gate's name string to the actor's id/name; a requester who writes a different name into the body is compared against that name, not their identity |
| Copilot principals cannot decide | yes | `rbac.js:158` rejects non-`user`/`bot` types |
| Non-reusable after a *denied* gate | n/a | a denied gate can never be consumed, correct |
| Approval → conversation link | **no** | the gate's `evidence` is a free string; no `message_id`/`thread_id` column, no message id passed by `copilot.executeAction` |
| Audit chain | yes | `dispatch.<op>` row per attempt on the same hash chain |

### 3.4 Design constraint this imposes (recorded before any code)

Adding a route-level gate naively would let a caller satisfy it with a gate they opened and a name they
typed. So the enforcement increment must, in the same change:

1. add an additive migration recording the **requester id** (and, for Copilot-originated gates, the
   thread/message id) — `002`-style `ALTER TABLE ... ADD COLUMN`, never a rewrite;
2. make `canDecideApproval` prefer the recorded id and fall back to the name only for legacy rows;
3. enforce the gate in **one place** — the request pipeline (`handleRequest`, `server.js:2320`) and
   `invokeRoute` (`server.js:2408`) — driven by a `meta.approval` declaration on the route, so a future
   route cannot forget it;
4. keep the dispatcher's own gate (it must stay the authority for `dispatch:<op>` binding) and make the
   two agree, not duplicate: the dispatcher passes the gate it has already validated, the route
   verifies and **spends** it. One spend, one audit row, no double-count.
5. update the UI flows that call those 18 routes directly (they exist today — `src/api.js:218, 224, 244,
   336, 342, 349-355`) and any test that asserts a one-shot delete.

This is the largest single increment in the initiative. It will be split: mechanism + tests first
(D2a), then the 19 declarations rolled out with UI handling (D2b), so a regression can be bisected.

---

## 4. Priority Three — the 75 contract-less operations

Produced with `resolveContract` over the live registry. The derivation rule
(`operationContracts.js:237-255`) gives a contract automatically only to **read** operations with
**exactly one route** and **at most one wildcard**; everything else needs an explicit contract.

Total 75 = **66 route-backed** + **9 route-less**.

### 4.1 The 9 route-less operations (`no-service` — must stay that way)

`telegram.send`, `agents.run`, `swarms.execute`, `skills.activate`, `files.upload`,
`analytics.series`, `plugins.connect`, `training.validate`, `local.inference`.

No route, no service. P3 forbids artificial contracts: these keep `no-service`, and the honest report
counts them as **not implemented**. `local.inference` in particular must never be reported as working
without a verified local endpoint (P6).

### 4.2 The 66 route-backed operations, by module

| Module | n | Operations | Proposed classification |
| --- | --- | --- | --- |
| copilot | 4 | `system.capabilities`(r), `copilot.model`, `copilot.send`, `copilot.clear` | A (read) / B (needs a provider key) |
| governance | 4 | `principals.create`, `principals.update`, `tokens.issue`, `tokens.revoke` | A |
| models | 2 | `providers.key.set`, `providers.key.clear` | E (secret-bearing) / A |
| chat | 2 | `chat.read`, `chat.delete` | A |
| browser | 3 | `browser.evidence`(r), `browser.start`, `browser.control` | A / C (needs a browser engine) |
| terminal | 10 | `terminal.list`(r), `terminal.run.read`(r), `terminal.session.create`, `.configure`, `terminal.exec`, `terminal.input`, `terminal.signal`, `terminal.session.close`, `terminal.grant.add`, `terminal.grant.revoke` | A |
| comms | 6 | `comms.configure`, `comms.channel.delete`, `comms.send`, `comms.queue`, `comms.inbound`, `telegram.send` | A / B (needs a configured channel) / E (inbound webhook) / D (no route) |
| voice | 5 | `voice.endpoint.create/update/delete/check`, `voice.transcribe` | A / B (needs an endpoint) |
| evolution | 16 | policy/grants/observations/health/rollback + 9 experiment steps | A, with `experiments.test` at C |
| agent-drafts | 5 | `copilot.drafts.create/update/submit/activate/archive` | A |
| swarm-plan-drafts | 5 | `copilot.plans.*` | A |
| browser-script-drafts | 5 | `copilot.scripts.*` | A |

Reads with no contract are all one of: more than one route, or two wildcards —
`system.capabilities` (2 routes), `terminal.list` (5), `terminal.run.read` (3),
`evolution.experiments.list` (2), `browser.evidence` (1 route, 2 wildcards). These five are the
cheapest legitimate contracts in the repo and are the natural first slice of P3.

Classification vocabulary (P3): **A** implemented & dispatchable · **B** implemented awaiting
configuration · **C** implemented awaiting verification · **D** not implemented · **E** intentionally
excluded (with the reason recorded).

### 4.3 The honesty rule for the coverage report

A contract does not create a service. After P3 the report must state, separately:

- operations with a contract (`… of 143`);
- of those, how many are **`available` and therefore runnable in this deployment**;
- how many are `unconfigured` / `unverified` (contract present, refusal guaranteed);
- how many remain contract-less, split into A/B/C/D/E.

An inflated "N of 143" that counts `unconfigured` operations as coverage is exactly what P3 calls an
inflated count. The number that answers "can Copilot control this?" is the `available` one.

---

## 5. Priority Four — multi-step execution

**Absent.** There is no plan/multi-step executor anywhere: the Copilot produces exactly one proposal per
turn (`copilot.js:extractAction`, one action), `dispatcher.execute` executes exactly one operation, and
`copilot.executeAction` refuses a replayed message id (`copilot.js:655-665`). Duplicate-execution
protection therefore exists at *one* operation, and its analogue at the *plan* level does not.

Also absent: max steps, max wall time, spend ceiling, per-step permission, cancellation, failure
recovery, and a partial-result outcome (`partial` does not exist in the vocabulary — see P7).

What **does** exist and must be reused rather than re-implemented: the dispatcher's per-call timeout,
result cap, rate limit, contract validation, and audit row; the `swarms` tables for plan *storage*
(a swarm plan is a stored plan, not a scheduler — `swarms.execute` is `no-service` and must remain so);
`approvals` for gates.

Non-goal, recorded explicitly: P4 must not turn a swarm plan into a running scheduler. The operator
constraint says workflows are swarm plans, not a new schema, and `swarms.execute` has no service.

---

## 6. Priority Five — approval integration with the conversation

| Required | State |
| --- | --- |
| Gate links to the originating conversation + message | **missing** (no column, nothing passed) |
| Copilot shows operation, target, params, risk on the gate | partial — the proposal card shows them; the *gate* row does not store params |
| Gate status visible to Copilot | partial — `executeAction` returns `approval` on refusal; there is no read of "what is waiting on me" scoped to a thread |
| Rejection / expiry / cancellation handled | rejection: refused path exists; **expiry: no gate ever expires**; cancellation: no gate cancel exists |
| Approved operation executes exactly once | yes at the dispatcher (`consumed_at`) |
| Auditable proposal → approval → execution chain | partial — the dispatcher audits `dispatch.<op>` with the approval id; the proposal's message id is in `messages.payload`, not in the audit row |

---

## 7. Priority Six — control surface

| Domain | Real operations | Gap |
| --- | --- | --- |
| Agents | create/update/delete/read, drafts → approval → activate | delete is declared `approval` but ungated (F1-1) |
| Tasks | full CRUD, assignment | no contract issues found |
| Teams / swarms | teams CRUD; swarm **plans** only (`swarms.execute` = `no-service`) | must keep saying "plan", never "running" |
| Models / gateways | providers list/get/key/call, `model:call` | **no connectivity-test operation exists** (only a real call) |
| Local AI | `local.inference` = `no-service` | must remain unclaimed absent a verified endpoint |
| Admin / diagnostics | `system.health`, `audit:verify`, `system.capabilities` (contract-less read) | diagnostics are CLI-only for the audit chain |

---

## 8. Priority Seven — error transparency

The dispatcher's `outcome` has four values: `executed`, `proposed`, `refused`, `failed`
(`dispatcher.js:129,150,178,341,376,429,446,469,497`). The refusal `code` set is rich
(`unknown-operation, no-service, unconfigured, unverified, degraded, blocked, demo, forbidden,
no-contract, invalid-params, confirmation-required, approval-required, approval-forbidden,
approval-unavailable, approval-not-allowed, approval-consumed, invalid-approval, rate-limited,
timeout, service-error`), and every success carries `operationId, httpStatus, target, requestId,
traceId, durationMs, approval`.

Mapping to the eleven states P7 requires:

| Required state | Derived from today |
| --- | --- |
| success | `executed` |
| failure | `failed` |
| permission denied | `refused` + `forbidden` |
| approval required | `refused` + `approval-required` |
| approval rejected | `refused` + `approval-forbidden` / `invalid-approval` (rejection is not distinguished from "this approval is not yours") |
| service unavailable | `refused` + `no-service` |
| missing config | `refused` + `unconfigured` |
| invalid params | `refused` + `invalid-params` |
| timeout | `failed` + `timeout` |
| cancelled | **absent** |
| partial | **absent** (needs P4) |

So P7 is a mapping + vocabulary increment plus two genuinely missing states, not a rewrite. Secrets are
already scrubbed before a result leaves the dispatcher (`scrub`/`scrubText`, dispatcher tests assert it).

---

## 9. Priority Nine — test matrix

Required scenarios, mapped to what exists on this commit. "Missing" means no test asserts it against a
real gateway + database.

| # | Scenario | Status |
| --- | --- | --- |
| 1 | success executes once | covered — `scripts/dispatcher-gateway-test.mjs` |
| 2 | failure surfaces without leaking internals | covered |
| 3 | permission denied | covered (route and dispatcher) |
| 4 | approval required opens one gate | covered |
| 5 | approval rejected cannot execute | covered |
| 6 | approval is single-use, replay refused | covered |
| 7 | approval for another op/target cannot be borrowed | covered |
| 8 | service unavailable / no-service | covered (`capabilities-gateway-test.mjs`) |
| 9 | missing config (unconfigured) | covered |
| 10 | invalid params refused before the route | covered |
| 11 | timeout reported as unfinished | covered |
| 12 | **approval expiry** | **missing** (no expiry exists) |
| 13 | **cancellation** | **missing** (no cancelled state) |
| 14 | **multi-step partial failure** | **missing** (no multi-step executor) |
| 15 | **route-level gate cannot be bypassed by calling the route directly** | **missing — and currently false** |

Mocked unit tests already exist for isolated modules; they are not counted above as integration proof.
Tests that need provider credentials cannot run here and will be reported as unverified, never as
passing.

---

## 10. Work plan (increments, each its own PR)

Ordered so the largest blast radius is taken in small, bisectable steps, and so the trust fixes land
before the surface expansion.

| ID | Scope | Touches | Proves |
| --- | --- | --- | --- |
| **D1** | P1: remove the fabricated-success paths, honest no-model vocabulary, extend `honesty-test` | `panel.js`, `orchestrator.js`, `smoke.mjs`, `honesty-test.mjs` | no success without a service response |
| **D2a** | P2 mechanism: `meta.approval` gate enforced in pipeline + `invokeRoute`, requester-id column, expiry column use, SoD by id, single spend shared with the dispatcher | new migration, `server.js`, `rbac.js`, dispatcher adapter | gate cannot be bypassed; one spend; denied/expired refused |
| **D2b** | P2 rollout: the 19 declarations + the 4 under-declared ones, UI flow handling, tests per route | `capabilities.js`, `server.js` routes, `src/api.js`, screens | declared == enforced, with UI that still works |
| **D3** | P3: 5 multi-route reads + module-by-module contracts, and the honest coverage report | `operationContracts.js`, `capabilities.js` report, tests | each new contract validated against the real route |
| **D4** | P5: approval ↔ conversation/message link, params hash in the gate, expiry, rejection visibility | migration, `copilot.js`, `panel.js` | proposal→approval→execution chain traceable |
| **D5** | P7: state vocabulary mapping (11 states) end to end | dispatcher, copilot, panel | every result renders its true state |
| **D6** | P4: bounded multi-step execution over the dispatcher | new module + guardrails | max steps/time/spend, cancel, partial, no bypass |
| **D7** | P6: control-surface completion, incl. a real provider connectivity test and local-AI verification | registry + routes | blockers reported, nothing fabricated |

D6 depends on D5 (needs `partial`/`cancelled`) and D4 (needs gates per step). D3 is independent and can
run in parallel with D2a.

### Do not break

- `npm test` must stay green **without deleting or weakening an assertion**; where an assertion encodes
  a behaviour this initiative removes (F1-3), the assertion is replaced by a stricter one, and the PR
  says so.
- The dispatcher remains the only path that carries contract validation, timeout, caps, rate limit and
  the `dispatch.<op>` audit row. Routes gain a gate; they do not gain a second dispatch implementation.
- Registry state semantics stay as Phase B declared them: `degraded` is refused as declared,
  `unverified` is never silently treated as available, `no-service` never gains a contract.
- Migrations are additive only.
- No unrelated UI redesign; mobile-first and 44 px targets preserved in any card touched.

---

## 11. What this audit could not verify

Stated plainly, because the report that follows must not imply otherwise:

1. **No provider is configured in this sandbox.** Model-backed Copilot turns, `copilot.send`, narration
   and provider connectivity are unverified — code-read only.
2. **No browser engine was installed**, so `browser.start` / `browser.control` cannot be exercised end
   to end here.
3. **No local inference endpoint exists**, so `local.inference` stays `no-service` and no claim about it
   is made.
4. **No voice/STT/TTS endpoint is configured**; `voice.transcribe` is unverified.
5. Everything in §3 was verified by reading the route table programmatically and grepping each handler
   block — not by calling every route. D2b will verify by calling them.
