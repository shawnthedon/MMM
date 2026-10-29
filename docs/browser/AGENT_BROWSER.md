# Agent Browser

Autonomous browsing that can be watched, stopped, and audited — and that refuses to defeat the sites
it visits.

**Status: implemented and proven.** `npm run test:browser` (22 checks, scripted driver),
`npm run test:browser:engine` (7 checks, real Chromium), `npm run test:browser-ui` (8 checks, screen).
A stock checkout has **no engine**, so the panel reports `unconfigured` until you install one.

---

## 1. What it does

An operator (or the Copilot, later) gives the gateway an **objective**, **success criteria** and a
**plan** of steps. The gateway runs the plan one action per tick, in a browser it owns, and only
claims a step happened when the page changed:

```
browser_tasks  ──1:N──► browser_steps   (the timeline you read in the UI)
               ──1:N──► browser_evidence (what was actually observed)
```

Nothing is inferred from "the process is still running". A page that stays open is not progress.

## 2. The invariants (each has an acceptance test)

| Spec | Invariant | Test |
| --- | --- | --- |
| AT-15 | A navigation that never completes is cut by the watchdog | `browser-agent-test.mjs`, `browser-engine-test.mjs` |
| AT-16 | Repeating an action that changes nothing is a loop, and stops | `browser-agent-test.mjs` |
| AT-17 | A dead engine is restarted and the task resumes from its checkpoint | both suites |
| AT-18 | An expired session asks the user to sign in; auth is never retried | both suites |
| AT-19 | A site refusal ends the task `blocked` and keeps the evidence | both suites |
| AT-20 | One action per tick — the gateway stays responsive | `browser-agent-test.mjs` |
| AT-21 | A deadline produces `timed_out` | `browser-agent-test.mjs` |
| AT-22 | Every milestone has evidence that can be re-read | both suites |
| AT-23 | A sensitive action is never blindly retried | `browser-agent-test.mjs` |
| AT-24 | After a restart the agent inspects the page before repeating anything | both suites |
| AT-25 | Action / evidence / tab budgets are enforced | `browser-agent-test.mjs` |
| AT-26 | `completed` requires every success criterion to be verified | both suites |

## 3. States

```
queued ──► running ──► recovering ──► running
             │             └────────► waiting_for_user ──► running (resume / assist)
             ├──────────► paused ──► running
             └──────────► completed · failed · blocked · cancelled · timed_out   (terminal)
```

* **`waiting_for_user`** is a hand-off, not a failure: a login wall, a sensitive action that failed, an
  exhausted recovery ladder, or three consecutive failures.
* **`blocked`** means a site refused the agent (CAPTCHA, 403, rate limit, paywall). Retrying it would be
  circumvention, so the task stops and keeps what it had already verified.
* Terminal states never change again. `stop` on a finished task is a `409`.

## 4. Running it

```bash
# 1. install an engine on the gateway host (not a source dependency)
npm install puppeteer                 # ~180 MB, includes Chromium
#    or point at an existing binary
export MMM_BROWSER_CHROMIUM_PATH=/usr/bin/chromium

# 2. start the gateway
npm run dev:gateway

# 3. open the app → All modules → Agent Browser
```

Environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `MMM_BROWSER_CHROMIUM_PATH` | — | Chromium/Chrome binary. Without it the driver tries `@sparticuz/chromium`, then reports unconfigured. |
| `MMM_BROWSER_PROXY` | — | Proxy for the whole session (`--proxy-server`). Never switched mid-task. |
| `MMM_BROWSER_VIEWPORT` | `390x844` | Viewport, mobile-first like the app. |
| `MMM_BROWSER_TICK_MS` | `400` | How often the runner looks for work. |
| `MMM_BROWSER_ACTION_TIMEOUT_MS` | `20000` | Default per-action budget. |
| `MMM_BROWSER_STALL_MS` | `45000` | "No meaningful progress" threshold. |
| `MMM_BROWSER_DEADLINE_MS` | `7200000` | Default task deadline. |
| `MMM_BROWSER_ALLOW_SIM` | unset | **Tests only.** Enables the scripted driver. Never set in production. |
| `MMM_BROWSER_DISABLE` | unset | `1` disables the ticker (tests advance time by hand). |
| `MMM_BROWSER_RESUME` | `1` | `0` skips re-attaching interrupted tasks on boot. |

## 5. API

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/browser/capabilities` | `browser:read` |
| GET | `/api/v1/browser/tasks?limit=30` | `browser:read` |
| POST | `/api/v1/browser/tasks` | `browser:run` |
| GET | `/api/v1/browser/tasks/:id` | `browser:read` |
| GET | `/api/v1/browser/tasks/:id/evidence/:eid` | `browser:read` |
| POST | `/api/v1/browser/tasks/:id/pause\|resume\|stop\|assist` | `browser:run` |

Create a task:

```jsonc
{
  "objective": "Read the price of the first plan on the pricing page",
  "successCriteria": [{ "key": "price", "expect": "contains:₦4,200" }],
  "entryUrl": "https://example.com/pricing",
  "plan": [
    { "action": "goto", "url": "https://example.com/pricing", "describe": "Open pricing" },
    { "action": "extract", "selector": "[data-price]", "key": "price", "describe": "Read the price" },
    { "action": "screenshot", "describe": "Capture the page" }
  ]
}
```

Criteria checks: `exists:`, `contains:<text>`, `equals:<value>`, `matches:<regex>`, `min:<number>`.
A plan that finishes with **no** criteria is reported as `failed` (`outcome: no-criteria`) — the gateway
will not call an unprovable result a success.

Steps: `goto`, `wait`, `waitFor`, `click`, `type`, `extract`, `screenshot`, `assert`. Mark a step
`"sensitive": true` (payment, submission, deletion) and it is never retried automatically.

## 6. What it deliberately does not do

* No CAPTCHA solving, no credential extraction, no paywall or access-control bypass.
* No fingerprint spoofing, user-agent rotation or stealth patches — the panel says a site may refuse
  the agent, and when it does the task stops.
* No "undetectable" claim anywhere in the code, the API or the UI.
* No simulated session in the shipped path: the scripted driver is refused unless
  `MMM_BROWSER_ALLOW_SIM=1`, and every task it runs is labelled **Simulated**.

## 7. Known gaps

* No engine is bundled — install one on the host.
* No per-principal domain allowlist yet (the honest alternative to stealth).
* Evidence payloads live in SQLite (capped, default 4 MB per task); move them to object storage at scale.
* Downloads are not yet captured; there is no video capture or element annotation.
* One task per tick: a busy gateway queues rather than parallelises (bounded by `maxTabs`, default 4).

## 8. References

* Puppeteer (Apache-2.0, v25) — <https://pptr.dev/guides/what-is-puppeteer>
* Chrome DevTools Protocol — <https://chromedevtools.github.io/devtools-protocol/>
* `robots.txt` (RFC 9309) — <https://www.rfc-editor.org/rfc/rfc9309.html>
* `navigator.webdriver` — <https://developer.mozilla.org/en-US/docs/Web/API/Navigator/webdriver>
* Playwright, if you want a second engine behind the same driver contract —
  <https://playwright.dev/docs/intro>
