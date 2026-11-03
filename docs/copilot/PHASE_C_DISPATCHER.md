# Phase C — The dispatcher, and Copilot that acts

Phase B answered *what can this gateway do?* and stopped there: 143 operations, seven states, and no
executor. Phase C adds the executor, the input contracts it needs, and the Copilot path that uses it — under
one rule that shaped every decision below:

> **Nothing the Copilot says happened happened unless a service said so.**

That rule is why this unit is mostly refusals. A refusal that names its reason is useful; a success that was
never verified is not.

---

## 1. What was there, and what was reused

Nothing was re-implemented. The dispatcher is a *caller* of the existing surface:

| Reused | Where | How |
| --- | --- | --- |
| Every route handler | `apps/gateway/server.js` (156 routes) | `invokeRoute()` finds the route object the HTTP path uses and calls **the same handler** with the **same `ctx` shape** |
| Permission check | `rbac.can()` | called before dispatch *and* again inside `invokeRoute` from the route's own `meta.permission` |
| Route table, drift check | `capabilities.attachRoutes()` / `coverage()` | the dispatcher reads the Phase B registry, so a contract cannot point at a route nobody serves |
| Approval gates | `approvals` table + `POST /api/v1/approvals` handler | a gate is opened by *calling that route* through `invokeRoute`, so the same audit row, event and comms notice happen |
| Audit | `db.audit()` (hash-chained) | one row per attempt, executed or refused |
| Rate limiting | `auth.rateLimit()` | per-principal bucket, plus the route's own limiter |
| Redaction | new `scrub()` / `scrubText()` | key-shaped fields removed at any depth; credential-shaped *strings* redacted too |
| Copilot conversation | `src/copilot.js` (`storeModelTurn`, `publicMessage`, model ledger) | proposals ride on a real model turn; the report is a real model call |

No second RBAC system, no second approval mechanism, no duplicate service code.

---

## 2. The contract layer — `apps/gateway/src/operationContracts.js`

A route is not an API: `PATCH /api/v1/agents/:id` will happily forward any column the caller sends. The
dispatcher needs to know *which* fields an operation accepts, so each operation that may be dispatched
declares one of:

- **declared** — `route`, `template` (`/api/v1/agents/{id}`), `path`, `body`, optional `query`, optional
  `target(params)` used to bind an approval gate to a specific record;
- **derived** — a read with no capture group (no inputs) or exactly one (an `id`). Anything else is *not*
  derived: two wildcards, or a write with no declaration, resolve to `null` and the operation is reported as
  **not dispatchable** rather than guessed at.

Three rules hold:

1. **Only declared fields are forwarded.** Unknown keys are **refused, not dropped** — `{ principal:
   'owner' }` must not look like it worked, and a typo must not look like a field was set.
2. **No contract mentions a credential.** Provider keys and voice endpoints are absent on purpose: a
   dispatcher would have to put the secret in a request body and an audit trail.
3. **A contract must name a route its own operation declares.** The suite asserts this for every contract,
   so a rename in `server.js` cannot silently retarget an operation.

`resolveContract()` is the single source of "may this be dispatched at all".

---

## 3. The dispatcher — `apps/gateway/src/dispatcher.js`

`createDispatcher({ operations, stateOf, invokeRoute, approvals, audit, rateLimit, logEvent })` returns
`describe()`, `execute()` and `catalogue()`. `execute()` runs **one** ordered pipeline:

1. **registered?** an unregistered id can never execute (`unknown-operation`);
2. **service exists?** `routes.length === 0` → `no-service`, with the registry's own note;
3. **deployment state** — only `available` runs. `unconfigured`, `unverified`, `degraded`, `blocked`,
   `demo` and `no-service` each stop it *by name*, with the probe's sentence. `degraded` is deliberately not
   runnable: unknown health is not "fine";
4. **permission** — `rbac.can(principal, operation.permission)` server-side. The client's claims are never
   read, and a top-level `principal`/`role`/`permission` in the request body is ignored;
5. **contract + validation** — `invalid-params` lists each field and each problem;
6. **confirmation** — `confirm: true` for a `confirm` operation; for an `approval` operation a gate bound to
   `dispatch:<operation>` and to the *target*, opened once per (action, target), decided by a different
   principal, spendable **once** (`approvals.consumed_at`, migration `016_dispatch.sql`);
7. **dry run** — described, never executed;
8. **rate limit** — per principal;
9. **invoke** — the real handler, bounded by the operation's `timeoutMs` via `Promise.race`;
10. **report** — `{ ok, executed, outcome, state, httpStatus, data, traceId, requestId, durationMs }`, with
    the service's own status and message. A timeout says it may still be running; a thrown error is
    `service-error` with the message **scrubbed**; a handler response is scrubbed at any depth.

Audit happens on **every** path, including refusals: `dispatch.<operation>` with decision `allow|deny` and
result `ok|timeout|error|<code>`. Arguments recorded are the trace id, risk, target and the *names* of up to
twelve parameter keys — never values.

### Why a refusal is worth this much code

The interesting failure mode is not an error; it is a UI that says "done". So the negative assertions in the
suite outnumber the positive ones: a refused write leaves the row count unchanged, a refused model call adds
no `model_calls` row, a spent gate cannot be replayed, a gate for another target cannot be borrowed, an
approval that was **denied** cannot be used, and a dry run creates nothing.

---

## 4. Gateway surface (additive)

| Route | Permission | What it does |
| --- | --- | --- |
| `GET /api/v1/dispatch` | `read` | every operation as *this principal* sees it: state, allowed, dispatchable, fields, counts. `?state=` / `?module=` / `?dispatchable=true` filter |
| `POST /api/v1/dispatch` | `read` (per-operation permission enforced inside) | `{ operation, params, confirm, approvalId, dryRun, reason }` |
| `POST /api/v1/copilot/actions/:messageId` | `copilot:write` | confirm one action the Copilot prepared |

All three are listed in `capabilities.UNEXPOSED` with a reason, so the Phase B drift check stays honest: these
are the mechanism, not capabilities. They are registered routes with CSRF and rate limiting like every other
mutating endpoint.

---

## 5. Copilot integration — `apps/gateway/src/copilot.js`

The model still has no tools, no shell and no hands. What changed:

- **A live brief, per turn.** `actionBrief(principal)` reads the dispatcher's catalogue and puts three
  *separate* groups in the system prompt: **can be requested now** (id, risk, confirmation, fields), **not
  allowed for your role** (named, with "do not offer"), and **this deployment cannot serve** (with each
  state's own reason). A fourth group — available but not dispatchable (no contract) — is listed as such.
  A model that merges permission with state gives the person the wrong advice; the brief never does.
- **One way to ask.** The prompt defines a single trailing marker:
  `<<<MMM-ACTION {"operation":"agents.create","params":{...}}>>>`. `extractAction()` parses it, strips it
  from the visible prose, and hands it to `dispatcher.describe()` — *not* `execute()`. An id that is not in
  the brief, a forbidden operation, or a missing contract comes back `executable: false` with the gateway's
  sentence, and is **not stored** as runnable.
- **Stored, not re-sent.** An executable proposal is saved on the assistant message's payload (`action`). The
  confirmation names only that message id — the parameters never travel back from the client — so what was
  reviewed is exactly what runs. Proposals expire after 30 minutes and are single-use.
- **The report is a report.** `executeAction()` calls `dispatcher.execute()`, records the outcome, and then
  asks the model to narrate the result JSON in two sentences. That narration is a real metered call
  (`purpose: 'copilot-report'`) stored with its `call_id`. If no model is configured, **no assistant message
  is written**; the dispatcher's result is returned as data with a note saying why.
- **Demo paths removed where they lied.** The knowledge pack and the module header claimed the front end
  never calls the gateway and that nothing can execute; both are now accurate.

Client side: `src/copilot/actions.js` (+ `panel.js` card `action`) renders the proposal with the state, risk,
target, fields and audit expectation, offers exactly one button, and shows the *result card* built from the
dispatcher's answer — status, HTTP status, trace id, approval id. There is no optimistic "done" state
anywhere in it.

---

## 6. Evidence

`npm run test:dispatch` — **36 assertions, 0 failures**, against a real gateway with a real SQLite database
and a loopback model stub, over HTTP as Owner, Admin, Reviewer, Operator and Observer:

| Phase C requirement | Assertion |
| --- | --- |
| success | `agents.create` with confirm → 201, row exists, trace id, audit row |
| unauthorised | Observer → 403 naming `agent:write`, no row written |
| unregistered | `agents.launch` → `unknown-operation`, still audited |
| unconfigured | `providers.call` → 424 `unconfigured`, **no `model_calls` row** |
| unverified | `comms.send` → 424 `unverified` with the registry's sentence |
| degraded | unit: state stops it, `invokeRoute` never called |
| input validation | unknown keys (`principal`, `permission`), short name, wrong type — each named |
| timeout | unit: `Promise.race` returns in 25 ms, message says it may still finish |
| service error | real 404 surfaced as `not-found`; unit: thrown error scrubbed of `sk-live-…` |
| approval required | gate opened, target bound, record untouched |
| approval denied / allowed | denied → `approval-not-allowed`; allowed → executed once → replay `approval-consumed` |
| audit | ≥15 `dispatch.*` rows, allow+deny, chain still verifies, no password/key in the log |
| role + autonomy | Observer reads; Admin cannot `evolution.policy.set` although state is `available` |
| bypass prevention | forged body claims ignored; route and dispatcher refuse the same principal; anonymous 401 |
| Copilot accuracy | proposal validated and **not executed**; confirm executes once; replay 409; forbidden proposal not runnable; no model → no fabricated turn; brief matches the registry |

`npm test` — **51 suites, 898 assertions, exit 0**; `npm run build` green. No existing test was weakened.

---

## 7. Known limits (stated, not hidden)

1. **The direct routes are still the direct routes.** `DELETE /api/v1/teams/:id` does not itself require the
   approval the registry says the *operation* needs; only the dispatcher enforces it. Tightening the raw
   handlers changes the Teams screen's flow and is a Phase D decision, not a silent edit here.
2. **Contracts cover ~30 of 143 operations.** The rest are reported as not dispatchable, by name, with the
   reason. Reads with no parameters are derived; multi-wildcard reads are not.
3. **No contract for secret-bearing routes** (provider keys, voice endpoints) — by design.
4. **The model gets no tool results mid-turn.** It proposes once per turn; it cannot loop, and it cannot see
   the result until the person's next message (or the report call, which is gateway-driven).
5. **`degraded` is still unused in production** — no probe currently reports it. It is exercised by the unit
   test so that the refusal path exists *before* a dependency fails, not after.
6. **The built-in demo engine still answers when no model is configured.** Every such reply is labelled "demo
   answer, no model called", and its proposals run against seeded local state only — never against the
   gateway. With a gateway session, the dispatcher path is the only path that writes.
7. **Approval gates opened by the dispatcher are visible on the Approvals screen** (same table) but the
   Approvals screen does not link back to the Copilot message that requested one.
