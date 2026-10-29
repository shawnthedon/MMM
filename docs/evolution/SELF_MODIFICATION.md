# Autonomous self-modification and code evolution

Every agent in MMM is **capable** of controlled self-modification: it can inspect code it is authorised
to read, diagnose a reproducible defect, propose the smallest change, and — if its policy allows — build
and test that change in an isolated copy. It cannot promote its own work, widen its own authority, or
edit the checks that limit it.

Capability is not authority. What an agent may do is decided by the **gateway**, from data the agent
cannot write: a policy row, a permission check, a review verdict, an approval, a health check and an
audit log. The agent's instructions only describe the workflow. The platform enforces it.

- Screen: **Self-Improvement** (`#/evolution`, or *Policy, experiments & rollback* on an agent's page).
- Tests: `npm run test:evolution` (20 backend checks) and `npm run test:evolution:ui` (10 panel checks).
- Code: `apps/gateway/src/evolution/`, `apps/gateway/migrations/005_evolution.sql`, `src/evolution.js`.

---

## 1. The cycle, and where each stage is enforced

| # | Stage | What happens | Enforced by |
| --- | --- | --- | --- |
| 1 | **Observe** | An experiment starts from a recorded observation. Assumptions are stored with `measured: 0` and are never accepted as a justification. | `runner.createExperiment`, `recordObservation` |
| 2 | **Diagnose** | Problem, root cause, proposed solution and the evidence that supports them. A diagnosis without measured evidence is refused. | `runner.diagnose` |
| 3 | **Plan** | Intended outcome, the exact files, the test command, the risks and the rollback story. | `runner.planExperiment` |
| 4 | **Isolated copy** | A working copy of the baseline is created under `DATA_DIR/experiments/<id>/work`. The repository is not touched — ever. | `workspace.createWorkspace` |
| 5 | **Rewrite** | One file at a time, each with a reason a reviewer can check. Path must match the agent's authorised scope and must not be protected. | `policy.checkWriteScope`, `runner.editFile` |
| 6 | **Test** | The allowed command runs in the sandbox with a rebuilt environment, a timeout, capped heap and truncated output. The real exit code, stdout and duration are stored. | `sandbox.runInSandbox`, `policy.checkSandboxCommand` |
| 7 | **Peer review** | A different agent reviews the diff and returns findings. Self-review and self-approval are refused. A later verdict supersedes an earlier one. | `runner.review`, `effectiveReviews` |
| 8 | **Compare** | Candidate against the last known-good version: test evidence, approvals, objections, diff size, risk, and the **limits of that evidence**. | `runner.compare`, `policy.classifyRisk` |
| 9 | **Promote** | Stage → approval → deploy, each a separate authority. A deployment publishes a new version and records it. | `runner.stage/deploy`, approval gate |
| 10 | **Monitor** | The health check runs; a failure stops promotion and rolls the agent back automatically. Every version remains inspectable. | `runner.healthCheck`, `runner.rollback` |

## 2. Autonomy levels

| Level | Name | May do | May not |
| --- | --- | --- | --- |
| 1 | Recommend | Read authorised code, diagnose, propose a patch | Write anything |
| 2 | Modify and test | Isolated copy, edit, run permitted tests | Stage or deploy |
| 3 | Automatically stage | Modify, test, collect the required reviews, stage a passing candidate | Deploy to production |
| 4 | Bounded autonomous deployment | Deploy **low-risk** candidates inside its scope once every test, review, security and health condition passes | Deploy high-impact or sensitive changes |
| 5 | Supervised continuous | Continuously raise opportunities and run bounded experiments under a pre-approved policy | Bypass approval for high-impact or security-sensitive changes |

The default for every agent, including every newly created specialist, is **level 1**. Raising a level
requires the `evolution:policy` permission (Owner), an explicit `confirmHigher: true` for levels above 2,
and is written to the audit log. **No level, including level 5, permits editing the policy that
authorises itself** — that row is owned by the platform and only a principal with `evolution:policy`
can change it.

## 3. Permissions

| Permission | Who holds it in the seeded RBAC | Grants |
| --- | --- | --- |
| `evolution:read` | Observer and above | Policies, experiments, diffs, evidence, versions, audit |
| `evolution:run` | Operator and above | Record observations, open experiments, edit a candidate, run tests, stage |
| `evolution:review` | Reviewer and above | Submit a peer review |
| `evolution:approve` | Reviewer and above | Approve or reject a promotion |
| `evolution:deploy` | Admin and above | Deploy, and roll back |
| `evolution:policy` | Owner only | Change autonomy, scope, limits and grants |

Reviewing and approving are separated from deploying on purpose: approving a candidate never deploys it.
Self-approval is refused by the gateway even when one principal holds both permissions.

## 4. Protected boundaries

These are **recommend-only** for an agent: it can argue that `rbac.js` is wrong, but the platform refuses
to put the change in a candidate. Removing a check requires a human change, reviewed like any other code.

- `apps/gateway/src/evolution/` — the safeguards themselves
- `apps/gateway/src/auth.js`, `rbac.js`, `db.js`, `apps/gateway/server.js` — sessions, permissions, the
  hash-chained audit log, the request pipeline
- `apps/gateway/migrations/` — the schema, including this module's own tables
- `package.json`, `.github/`, `public/sw.js`, `.env*`, `.git/`, the shared test harness

High-impact but allowed, and therefore always reviewed and never auto-deployed on a scripted test alone:
other gateway source, the UI in `src/`, served assets, test suites and documentation.

## 5. The sandbox — what it actually is

`GET /api/v1/evolution/capabilities` returns the truth, and the screen renders it verbatim as
"Enforced" and "Not enforced — stated, not hidden".

**Enforced**

- `cwd` is the experiment workspace; the repository is read-only to it
- the environment is rebuilt from scratch: no secrets, no `DATA_DIR`, no `MMM_*` variables, no ambient
  credentials; test-only values replace production ones
- the command must match the allowlist (`node --check`, `node <script>`, `npm run test*`)
- wall-clock timeout with `SIGKILL`, output truncated at 64 KB, Node heap capped at 256 MB

**Not enforced**

- kernel network isolation — the sandbox inherits the host network
- filesystem isolation outside the workspace
- CPU quotas beyond the wall clock

For defence in depth, run the gateway in a container without ambient credentials. A container runtime is
the next step (see §10) and will change `isolation` from `process` to `container`; until it does, the
API and the screen keep saying `process`.

## 6. Versioning, promotion and rollback

- A **workspace** is `DATA_DIR/experiments/<id>/{baseline,work,manifest.json}` and is deleted when the
  experiment ends, unless its evidence is needed for reproduction.
- A **version** is `DATA_DIR/runtime/<agent>/<version>/files/` plus `current.json`. Promotion publishes a
  version; the previous version stays on disk, so a rollback is a pointer move, not a rewrite.
- **The last known-good version is preserved throughout**, including while a candidate is being tested.
- A rollback is available to `evolution:deploy` holders, is recorded with actor and reason, and keeps
  every audit record. It is **not** a time machine: reverting source does not reverse database
  migrations or external side effects. Irreversible changes are flagged at plan time and in the
  comparison, and need their own recovery plan.

## 7. Limits (AC16)

Per agent, configurable by an Owner: `maxExperimentsPerDay` (default 5), `maxTestRuns` per experiment
(default 4), `maxRuntimeMs` per run (default 120 s, hard cap 15 min). Per experiment, fixed: 40 files,
256 KB per file, 4 MB total, 3 000 diff lines. Exceeding any of these stops the experiment with a typed
error and a recorded reason — it never silently truncates and never loops.

## 8. Hostile input

- **Prompt injection**: code comments, test output, documentation, issue text and peer messages are data,
  not instructions. Findings a reviewer reports are shown to a human as text and are never executed.
- **Peers are untrusted**: a review from another agent is advisory. It cannot widen scope, and a reviewer
  that approves its own change is refused.
- **Cross-agent edits** need an explicit grant (`evolution_grants`): agent, owning agent, scope, reason,
  expiry. Reading, modifying and activating are three different rights.
- **Specialists inherit only their task's permissions** and cannot be used to escape a parent's
  restrictions; a new agent gets the default policy, not its creator's.

## 9. API

```
GET    /api/v1/evolution/capabilities                     evolution:read
GET    /api/v1/evolution/agents                           evolution:read
GET    /api/v1/evolution/agents/:id/policy                evolution:read
PATCH  /api/v1/evolution/agents/:id/policy                evolution:policy
GET    /api/v1/evolution/agents/:id/grants                evolution:read
POST   /api/v1/evolution/grants                           evolution:policy
DELETE /api/v1/evolution/grants/:id                       evolution:policy
GET    /api/v1/evolution/agents/:id/observations          evolution:read
POST   /api/v1/evolution/agents/:id/observations          evolution:run
GET    /api/v1/evolution/agents/:id/versions              evolution:read
POST   /api/v1/evolution/agents/:id/health                evolution:run
POST   /api/v1/evolution/agents/:id/rollback              evolution:deploy
GET    /api/v1/evolution/experiments[?agentId=]           evolution:read
POST   /api/v1/evolution/experiments                      evolution:run
GET    /api/v1/evolution/experiments/:id                  evolution:read
GET    /api/v1/evolution/experiments/:id/file?path=       evolution:read
POST   /api/v1/evolution/experiments/:id/{diagnose,plan,workspace,edit,delete-file,
       test,review,compare,stage,request-approval,approve,deploy,cancel}
```

WebSocket topic: `evolution` (broadcast on every state change), gated by `evolution:read`.

Error mapping: unknown experiment `404`, protected scope `403`, malformed path `400`, and `409` for
`self-review`, `self-approval`, `level`, `disabled`, `quota`, `approval-required`, `blocked`,
`wrong-stage`, `terminal` and `health`.

## 10. Honest limitations, and the hardening path

| Limitation | Consequence today | Next step |
| --- | --- | --- |
| Process sandbox, not a container | A test script could read world-readable files and reach the network | Container or microVM per experiment; then change `isolation` to `container` |
| No automatic patch generation | An authorised human or agent operator supplies the edit; the platform validates it | Optional model-driven patch author, still subject to every gate in §1 |
| Reproduction is files + manifest | A candidate is reproducible from its version, config and evidence, not from a container image digest | Pin the image and the lockfile hash in `manifest.json` |
| No cost accounting | Test runs are bounded by time, not by spend | Meter sandbox minutes per agent |
| Health checks are command-based | A passing command is evidence, not proof of production health | Wire real probes and error-rate windows |
| Single-writer experiments | Two experiments on one agent serialise | Keep it; concurrent candidates on one agent invite races |

## 11. Running it

```bash
npm install --ignore-scripts --no-audit --no-fund
npm run migrate                  # applies 005_evolution.sql
npm run dev:gateway              # the cycle runs here
npm run test:evolution           # 20 acceptance checks (AC1–AC18)
npm run test:evolution:ui        # 9 panel checks
npm run dev                      # then open #/evolution
```

The acceptance suite uses a real gateway on a temporary `DATA_DIR` and real sandboxed `node` runs
against `agents/demo-writer/`, a fixture whose test suite genuinely fails until the defect is fixed. It
asserts, among other things, that the fixture is byte-identical afterwards: **the tests never "fix" the
repository.**
