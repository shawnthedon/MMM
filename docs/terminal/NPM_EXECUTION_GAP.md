# Report before implementation — "Full NPM command execution in the integrated terminal"

| Field | Value |
| --- | --- |
| Request | Real npm/node execution in the terminal screen: real processes, live stdout/stderr, exit codes, Ctrl+C, cwd persistence, multiple sessions, history, agent-driven npm with retry, **no mandatory cloud dependency**, isolation / traversal blocking / secret protection / approval for destructive commands / exec limits / recorded history |
| Method | Two throwaway probes against a **running gateway** on a temp `DATA_DIR`, real `npm` against the real registry, an Owner + a Reviewer principal. No production code was read first — the code was read only to explain what the probe observed. |
| Verdict | **Most of this shipped in M26 and is verified below.** Three real gaps remain (one of them a genuine bypass of a rule the terminal claims to enforce). Implementation plan in §5. |
| Status | **Report only.** No source change in this PR, per "report before implementing". |

---

## 1. What the probe actually did

A gateway on a free port, `MMM_TERMINAL_ROOTS` pointed at a temporary directory, a workspace named `probe`
with a real `package.json`, one session, and then the requests a screen or an agent would send. Every number
below is from that run on 2026-11-02, node `v22.22.3`.

## 2. What already works (with the evidence)

| # | Criterion | Observed |
| --- | --- | --- |
| 1 | **Real processes** | `npm run hello` → `completed`, exit `0`, output `> probe@1.0.0 hello` … `hello from npm run` |
| 2 | **Real npm install** | `npm install --no-audit --no-fund left-pad@1.3.0` → `completed`, exit `0`, `added 1 package in 376ms`, plus npm's own deprecation warning on **stderr** |
| 3 | **Live stdout while running** | SSE `/runs/:id/stream`: first stdout chunk at **29 ms**, the delayed line at **431 ms**, the `stderr` line at **831 ms**, exit event at **837 ms** — output arrives before the process ends, not as one blob |
| 4 | **Exit codes and stderr kept apart** | `process.exit(3)` → `status: failed`, `exitCode: 3`, `stdoutTail: "one\ntwo\n"`, `stderrTail: "err\n"` |
| 5 | **Ctrl+C** | `setInterval` process + `POST /runs/:id/signal {SIGINT}` → `status: cancelled`, `signal: SIGINT`, no orphan |
| 6 | **cwd persists** | `POST /sessions/:id/cwd {cwd:"sub"}` → session `cwd: "sub"`; the next child printed `/…/roots/probe/sub`; `../../..` → **400 `bad-path`** |
| 7 | **Multiple sessions** | two sessions on one workspace, both `201`, `GET /terminal/sessions` → 2, each with its own cwd (cap: 8 per principal) |
| 8 | **History** | `GET /terminal/history?sessionId=…` returns command + status + exit code, newest first, scoped to the caller |
| 9 | **Agent-driven npm with retry** | grant required (`403 agent … has no terminal grant` without one); `npm run hello` → `ok: true`, exit 0, stdout returned; a failing run → `retryable: true`, `hint: "failed: read stderr, fix the cause, then retry"`; re-issuing the command and reading stdout **is** the retry (same policy, same gate) |
| 10 | **Approval for destructive commands** | `npm ci` → `202 awaiting_approval` + `ap-…`; the requester allowing it → **403 separation of duties**; a Reviewer allowing it → the run **starts** (exit 1 here, no lockfile — honest); a Reviewer denying it → `refused` and nothing spawns; an agent's `npm ci` → `needsApproval: true` |
| 11 | **Secret protection** | session env value `super-secret-value-42` printed by a child came back as `••••` in the stored output; env is accepted by name and never echoed back; the env-key list — not values — is what the session row stores |
| 12 | **Exec limits** | 2 MB output buffer with an 8 000-char tail and `truncated: true`, 30 min default / 2 h max timeout, 200 runs per session, 8 sessions per principal, one command per session at a time |
| 13 | **Recorded history** | audit rows exist for `terminal.session.open`, `terminal.session.env`, `terminal.run` (`deny`/`denied` for a refused command, `allow`/`pending-approval` for a gated one) and `terminal.run.finish`; `terminal_runs` stores command, argv, cwd, status, exit code, signal, duration and byte count — no secret |

No mandatory cloud dependency: everything above is the gateway spawning local processes. `npm install`
needs the registry unless the package is already in npm's cache, and M26's docs already say so.

## 3. The three gaps the probe found

### G1 — the env route bypasses the flag denylist (the serious one)

The policy refuses `npm --registry`, `--prefix`, `--userconfig`, `--script-shell`, `--cache` and `-g` **as
flags**, with the stated reason *"the registry is fixed by the deployment, not by a command"*. The session
env route accepts any well-formed key, so the same knobs come back as environment variables and the rule
stops being true:

```
POST /terminal/sessions/:id/env
  { npm_config_registry: "http://127.0.0.1:9/", NODE_OPTIONS: "--require /tmp/nope.js",
    PATH: "/tmp", npm_config_prefix: "/tmp", LD_PRELOAD: "/tmp/x.so" }
→ 200, envKeys: ["npm_config_registry","NODE_OPTIONS","PATH","npm_config_prefix","LD_PRELOAD"]
```

`npm_config_registry` redirects the registry (the following `npm view` hung against `127.0.0.1:9` instead of
answering from the real registry). `NODE_OPTIONS=--require …` and `LD_PRELOAD` inject code into **every**
later run in that session, and `PATH` decides which binary `npm` even is — which quietly falsifies the
"node, npm, npx only" claim in the capability payload.

### G2 — an agent's run is not attributed to the agent

`POST /terminal/agent-runs` returns the run with `agentId: ""`, and the `terminal_runs.agent_id` column
stays empty. The command ran *because an agent asked for it*, but the history, the audit row and the
terminal screen cannot say which agent. That is the opposite of the "recorded history" criterion.

### G3 — the terminal cannot report the npm version

`GET /api/v1/terminal` → `runtime: { node: "v22.22.3", npm: null, … }`. `npm` is read from
`process.env.MMM_TERMINAL_NPM_VERSION`, which nothing sets, so the capability payload says "unknown" about a
tool that is installed and working. A screen that cannot name its toolchain cannot claim to be a terminal.

## 4. What this report deliberately does **not** claim

- **No PTY.** TTY-only programs will not behave; `npm init`'s interactive prompt cannot be answered. Adding
  a PTY is a different unit with its own security surface (terminal escape sequences into a web UI).
- **Process isolation, not a container.** No filesystem or network namespaces; the capability endpoint
  already says `isolation: 'process'` and lists what is not enforced.
- **No shell.** `&&`, `|`, `>` and `$(…)` are refusals, by design. "Full npm command execution" here means
  every `npm` subcommand the policy allows, not a general shell.
- **No second terminal system.** The fixes below extend `apps/gateway/src/terminal/*`; nothing new is built
  beside it.

## 5. Implementation plan (next PR)

1. **G1** — `sanitiseEnv` refuses, with an explicit reason per key, the variables that re-open the holes the
   flag denylist closes: `npm_config_*` / `NPM_CONFIG_*` (registry, prefix, userconfig, globalconfig,
   script-shell, cache, proxy, https-proxy), `NODE_OPTIONS`, `NODE_PATH`, `PATH`, `LD_PRELOAD`,
   `LD_LIBRARY_PATH`, `BASH_ENV`, `ENV`. Refusal is a `400` naming the key and the reason — never a silent
   drop, because a silently ignored `PATH` would look like it applied.
2. **G2** — pass the agent id into the run row for `/agent-runs`, so `terminal_runs.agent_id`, the run
   response, the history and the terminal screen can all name the agent that asked.
3. **G3** — probe `npm --version` once, lazily, with a short timeout and a cache, and report
   `{ npm, source: 'probed' | 'unknown', reason }`; `null` stays possible but is then explained.
4. **Tests** — extend `scripts/terminal-test.mjs` with the three refusals and the two new facts (an agent's
   run carries its id; the capability payload either names npm's version or says why not), then re-run
   `test:terminal` (28), `test:terminal:ui` (12), `test:terminal:browser` (15), `npm test`, `npm run build`.
5. **Docs** — `docs/terminal/NPM_EXECUTION.md` (design + limits), `PROGRESS`, and the M26 paragraph that
   currently claims the flag denylist is complete.

Success for the implementation = the three refusals are asserted in the gateway suite, the agent id appears
in `terminal_runs`, the capability payload names npm's version (or its reason), and every existing terminal
suite still passes unchanged.
