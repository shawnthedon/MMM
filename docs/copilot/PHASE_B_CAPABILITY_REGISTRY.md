# Copilot — Phase B: the capability registry

| Field | Value |
| --- | --- |
| Scope | Phase B only: the catalogue and its read-only endpoints. No dispatcher, no Copilot wiring, no UI. |
| Files | `apps/gateway/src/capabilities.js` (new), `apps/gateway/server.js` (+22 lines), `scripts/capabilities-gateway-test.mjs` (new), `package.json` (`test:capabilities`, added to `npm test`) |
| Endpoints | `GET /api/v1/capabilities`, `GET /api/v1/capabilities/:id` (permission `read`) |
| Evidence | `npm run test:capabilities` — **21 passed, 0 failed**. `npm test` — **50 suites, 862 assertions, exit 0**. `npm run build` — ✓ 3.31 s |
| Input | [`PHASE_A_INVENTORY.md`](PHASE_A_INVENTORY.md); decisions Q2/Q3 (gateway-side, hand-declared, drift-tested) and Q5 (seven states) |

## What this replaces

Phase A found three answers to "what can Copilot do here?" and they disagreed: a static client table (9 of
10 statuses hard-coded), the client orchestrator's 18 advertised commands, and prose in the model's system
prompt. None was derived from what the server serves, so none could be enforced.

This unit adds **one** answer, on the server, computed at read time.

## Two axes, kept apart

| | Meaning | Source |
| --- | --- | --- |
| `state` | A fact about **this deployment**: can it work, and what is missing if not | live route table + real probes of the owning module |
| `allowed` | A fact about **the caller**: does this principal hold the permission | `rbac.can()` |

They are separate on purpose. A refusal must not hide a capability ("this exists, you cannot use it"), and
a capability must not outrun authority ("the key is sealed, but you are an Observer"). Conflating them was
the first thing the test caught: an early version reported `available` to a principal who could not use the
operation.

## The seven states

`available` · `degraded` · `unconfigured` · `unverified` · `demo` · `blocked` · `no-service`

Each carries a sentence. Nothing is ever `available` without a route and a met requirement; `no-service`
operations claim no route at all and name the service they would need.

## Declared by hand, checked by machine

A route cannot tell you that deleting an agent is destructive, that activation needs an approval, or that
a screen has no service. So the catalogue is written by hand — and because it is, it is checked against the
table it describes.

`coverage()` answers four questions, and the suite fails the build on any of them:

1. does every declared route exist? (a typo would otherwise be a silent capability)
2. is every served route claimed by exactly one operation, or explicitly excused?
3. does the route's permission match the declaration?
4. does the route's `mutating` flag match the operation's `kind`?

On the current table: **156 routes = 151 claims + 5 excused**, zero missing, zero undeclared, zero
mismatched. The five excused routes are the four session-lifecycle routes (a person signs in; Copilot never
handles credentials) and the `dev/seed` test helper.

The invariant is also enforced at load: `op()` throws if an operation mixes GET and non-GET routes, if a
read declares a risk or confirmation, or if a destructive operation does not require an approval gate. A
group that spans reads and writes becomes two operations, because a dispatcher acts on one kind at a time.

## Runtime requirements are probes, not constants

| Requirement | Probed from | If unmet |
| --- | --- | --- |
| `provider-key` | `models.runtimeStatus().configuredCount` | model calls, Copilot turns → `unconfigured` |
| `chromium` | `browserCapability().engine` | browser tasks, script activation → `unconfigured` |
| `speech-host` | `voice.capabilities().localStt` | transcription → `unconfigured` |
| `evolution-policy` | `evolution.capabilities().status` | experiment/health operations → `unconfigured` |

The suite exercises the key gate in **both** directions: seal a key → `copilot.send` becomes `available`;
clear it → back to `unconfigured`.

## Live shape (this checkout, no key, no Chromium, no speech host)

```json
{ "states": { "available": 120, "unconfigured": 10, "unverified": 4, "no-service": 9,
              "degraded": 0, "demo": 0, "blocked": 0 },
  "coverage": { "ok": true, "served": 156, "claims": 151, "unexposed": 5, "missing": [], "undeclared": [], "mismatched": [] },
  "requirements": { "provider-key": { "met": false }, "chromium": { "met": false },
                    "speech-host": { "met": false }, "evolution-policy": { "met": false } } }
```

143 operations in total (134 backed by routes, 9 `no-service`). An Observer reads the same 143, in the same
order, with `allowed: false` where the role lacks the permission — and `POST /api/v1/agents` from that
Observer is refused with `403` naming `Operator`. The catalogue and the enforcement agree; the suite asserts
that for six operations rather than assuming it.

## Honest limits

- **There is no dispatcher.** This unit describes operations; nothing executes through it. Phase B step 4.
- **Nothing in the UI reads it yet.** `src/copilot/capabilities.js` is unchanged, so the Copilot panel still
  uses its own table. Replacing it is a Phase C step, not done here.
- **`unverified` is hand-set** on the four comms operations that have never been exercised against a real
  provider. It is a deployment fact a human records, not something a probe can discover.
- **`degraded` is unused** — nothing currently reports a failing dependency. The state exists so a failing
  dependency has somewhere honest to land, and the vocabulary test pins it.
- **`GET /capabilities` is not free**: it probes four modules per call. It is a read used by a panel, not a
  hot path; it writes no audit rows and the suite asserts that.
- **Two routes were added**, so the table is now 156, not the 154 Phase A measured. The catalogue declares
  itself as `system.capabilities` rather than excusing itself.

## What Phase C will need from this

A dispatcher can key on `id`, validate against `kind`/`risk`/`confirmation`, re-check `permission`
server-side (the same `can()`), honour `idempotent` and `timeoutMs`, and pick the audit row from `audit`.
The catalogue deliberately does not contain a handler reference: choosing *how* an operation runs is the
dispatcher's job, and the route is the only execution path that already exists.
