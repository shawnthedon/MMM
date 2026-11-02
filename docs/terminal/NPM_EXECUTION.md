# Report after implementation — npm execution in the integrated terminal (M36)

| Field | Value |
| --- | --- |
| Request | "Enable full NPM command execution in the integrated terminal" — real processes, live stdout/stderr, exit codes, Ctrl+C, cwd persistence, several sessions, history, agent-driven npm with retry, no mandatory cloud dependency, isolation / traversal blocking / secret protection / approval for destructive commands / exec limits / recorded history |
| Preceded by | [`NPM_EXECUTION_GAP.md`](NPM_EXECUTION_GAP.md) — the probe report: most of the request shipped in M26; three gaps (G1–G3) |
| Files changed | `apps/gateway/src/terminal/policy.js`, `apps/gateway/src/terminal/index.js`, `src/terminal.js`, `scripts/terminal-gateway-test.mjs`, `scripts/terminal-ui-test.mjs` |
| Evidence | `npm run test:terminal` — **30 passed, 0 failed** (was 28; the three new assertions fail on the pre-fix tree) · `npm run test:terminal:ui` **12 passed** · `npm test` · `npm run build` |
| Status | **PASS for G1–G3.** No second terminal system, no new table, no new endpoint, no PTY. |

---

## 1. G1 — the environment route can no longer re-open the holes the flag rules close

The policy refused `--registry`, `--prefix`, `--userconfig`, `--script-shell`, `--cache` and `--proxy` **as
flags**, with the reason *"the registry is fixed by the deployment, not by a command"*. npm reads the same
settings from `npm_config_*` in the environment, and the session env route accepted any well-formed key — so
the rule was decorative. The probe proved it: `npm_config_registry` pointing at `127.0.0.1:9` made the next
`npm view` hang against that host.

`sanitiseEnv` now asks `envKeyProblem()` (in `policy.js`, beside the flag rules it mirrors) about every key and
**refuses with the key and the reason**, rather than silently dropping it:

| Refused | Why |
| --- | --- |
| `npm_config_*` (any, any case) | the exact knobs the flag rules block: registry, prefix, userconfig, script-shell, cache, proxy |
| `NODE_OPTIONS` | `--require` on every later command in the session |
| `NODE_PATH`, `NODE_EXTRA_CA_CERTS` | module resolution outside the workspace; trusting an extra CA to intercept the registry |
| `PATH`, `PATHEXT` | decides which `node`/`npm` binary is being run at all |
| `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_*` | native code injection |
| `BASH_ENV`, `ENV`, `SHELL`, `COMSPEC` | shell hooks around the processes npm spawns |

A name that is not a variable name is a `400` too — a silently ignored variable looks exactly like one that
applied. The refusal happens before any mutation, so a rejected key leaves the session's environment untouched
(the suite asserts the key list is byte-identical before and after seven refusals). The capability payload
gained `policy.refusedEnvKeys`, so the screen can say what it will not accept.

## 2. G2 — an agent's run is attributed to the agent

`runCommand` now takes an `agentId` and writes it into `terminal_runs.agent_id` for every path it can produce
(refused, awaiting-approval, started), and `runForAgent` passes it. Before, `POST /terminal/agent-runs`
returned `agentId: ""` and the column stayed empty: the command ran *because an agent asked*, and neither the
history, the audit row nor the screen could say which agent. An approved destructive run keeps the id it was
created with, so the gate does not launder attribution.

## 3. G3 — the terminal can name the npm it runs

`runtime.npm` was read from `MMM_TERMINAL_NPM_VERSION`, which nothing sets, so the capability payload answered
`null` about the tool that runs every command. It is now probed once per gateway process (`npm --version`,
four seconds at most, cached) and reported as:

```json
{ "node": "v22.22.3", "npm": "10.9.8", "npmSource": "probed", "platform": "linux", "arch": "x64" }
```

If the probe fails, `npm` stays `null` **with `npmReason`** — *"could not run npm --version (ENOENT) — set
MMM_TERMINAL_NPM_VERSION if npm lives outside the gateway PATH"* — and an operator pin still wins
(`npmSource: "env"`). The screen prints `node … · npm …` when the gateway could read it and omits it when it
could not, rather than printing "unknown" beside a working npm.

## 4. What the acceptance list looks like now

Every line was verified against a running gateway, most of them first in the probe and then in the suite:

| Criterion | Where it is proven |
| --- | --- |
| real processes, real `npm install` / `npm run` | `test:terminal` (real `npm install` of a packed local package, `npm install express` when the registry answers) · `test:terminal:browser` (real Chromium) |
| live stdout/stderr | SSE `run` · `chunk` · `exit` with `?since=` replay; probe measured 29 ms / 431 ms / 831 ms / exit 837 ms |
| exit codes and signals | `completed` / `failed` / `cancelled` / `timed_out` / `refused` / `blocked`, exact `exitCode` and `signal` |
| Ctrl+C | `POST /runs/:id/signal` → `SIGINT` to the process group, `SIGTERM` → `SIGKILL` escalation |
| cwd persistence | per session, checked again at spawn time; `../../..` → `bad-path` |
| several sessions | 8 per principal, one command per session at a time (`409`) |
| history | `GET /terminal/history` scoped to the caller, newest first, status and exit code |
| agent-driven npm with retry | `/terminal/agent-runs`: grant required, output + exit code returned, `retryable` + `hint` on failure; re-issuing the command is the retry. **New:** the run names the agent |
| no mandatory cloud | everything above is the gateway spawning local processes; `npm install` needs the registry unless the package is cached, and the docs say so |
| isolation | `isolation: 'process'`, `notEnforced` list in the capability payload — deliberately not claimed as a sandbox |
| traversal blocking | `resolveInside` on cwd, `bad-path` for anything outside the workspace |
| secret protection | env values masked `••••` in the transcript, values never stored or returned, audit rows hold key names only |
| approval for destructive commands | `npm ci`, `npm uninstall`, `npm publish`, `npm exec`, `npm link`, `npm audit --force` → `awaiting_approval`; requester cannot allow it (`403` separation of duties); a Reviewer's allow starts the run, a deny leaves it `refused` |
| exec limits | 2 MB output per run with an 8 000-char tail and `truncated`, 30 min default / 2 h max timeout, 200 runs per session, 8 sessions per principal |
| recorded history | `terminal_runs` (command, argv, cwd, status, exit code, signal, duration, bytes — no secrets) plus `terminal.run` / `terminal.run.finish` / `terminal.session.*` audit rows |

## 5. Limits, unchanged and now stated in the payload

- **No PTY.** TTY-only programs will not behave and `npm init`'s interactive prompt cannot be answered;
  `sendInput` reaches stdin but a program that probes `isatty()` will not offer a prompt.
- **Process isolation, not a container.** No filesystem or network namespaces. `npm install` executes project
  code by design; the gateway host is the containment boundary.
- **No shell.** Pipes, redirects, chaining and substitution are refusals with a reason — "full npm execution"
  means every `npm` subcommand the policy allows, not a general shell.
- **The environment list is a denylist of the knobs that reach outside the workspace**, not a proof that no
  other variable affects npm. Anything new that npm starts reading from the environment has to be added here.
