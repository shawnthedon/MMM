# 🗺 SwarmOS — Implementation Roadmap to Production
## Non-Functional Requirements Edition (Quality, Security, Reliability & Operations)

> **Purpose:** the *remainder* of the development journey from working prototype to production-grade platform — focused on the **non-functional features and aspects** of the application: performance, security, privacy, reliability, scalability, accessibility, maintainability, testability, observability, deployability, and cost efficiency.
>
> **Companion document:** [`IMPLEMENTATION_CHECKLIST.md`](IMPLEMENTATION_CHECKLIST.md) covers the *functional* build (features, APIs, integrations, seed data). **This roadmap adds the quality layer every feature must satisfy before it ships.**
>
> **Audience:** beginners growing into production engineers — every to-do says *what, why, how* (with commands and links), and each milestone ends with a measurable **gate**.

**Status legend** `⬜` not started · `🟨` in progress · `✅` done · `⏭` optional

---

## 🧭 How to use this roadmap

1. Run this track **alongside** the functional checklist (weeks 3+ of development). Non-functional work is not a final polish phase — it's a parallel discipline. Each milestone below says which functional phase it pairs with.
2. Every quality attribute has a **measurable target** in the scorecard below. You are done when the *number* is met — not when it "feels fine".
3. Collect proof: paste test output, Lighthouse reports, and load-test numbers into `docs/evidence/<milestone>/`. Future-you will thank present-you.
4. Links: every 🌐 URL in Appendix A is a real source of documentation you will need. Learn to read API docs — it's the core skill of this whole project.

---

## 📏 Non-Functional Requirements (NFR) scorecard

These are the acceptance targets for production. Each milestone improves specific rows.

| # | Attribute | Target (production) | Measured by | Milestone |
| --- | --- | --- | --- | --- |
| N1 | **Performance** | Shell interactive ≤ 2.5 s (mid phone, 4G); route change ≤ 200 ms; initial JS ≤ 250 KB gzip | Lighthouse, WebPageTest | M2 |
| N2 | **Performance (API)** | p95 API latency ≤ 200 ms (CRUD); WS event→UI ≤ 250 ms | k6 / autocannon numbers | M2, M6 |
| N3 | **Reliability** | 99.5% monthly uptime; zero data loss on crash (WAL + journaling); jobs exactly-once-effect | Uptime checks + chaos drills | M4 |
| N4 | **Recoverability** | RTO ≤ 30 min, RPO ≤ 24 h (daily backup); restore drill passes quarterly | Restore drill log | M4 |
| N5 | **Security** | OWASP ASVS **L2** pass; no criticals in dependency scan; secrets never in logs/exports | ASVS checklist + gitleaks + `npm audit` | M3 |
| N6 | **Privacy** | PII redaction on by default; memory “forget” works; data export/delete paths exist | Manual test script | M3 |
| N7 | **Accessibility** | WCAG 2.2 **AA**; axe zero serious/critical; full keyboard + screen-reader path | axe in CI + manual pass | M5 |
| N8 | **Compatibility** | Chrome/Edge/Safari/Firefox (last 2), iOS 16+, Android 11+; PWA installable both platforms | Device test matrix | M5 |
| N9 | **Scalability** | 200 concurrent agent runs on 1 node; 50 WS clients; SQLite p95 < 20 ms list queries | k6 load report | M6 |
| N10 | **Maintainability** | Test coverage ≥ 70% core; lint clean; typed API contract; ≤ 15 min cold setup | CI metrics | M1 |
| N11 | **Observability** | Structured logs everywhere; `/metrics`; 6 golden alerts; runbook for top-5 incidents | Ops review | M7 |
| N12 | **Deployability** | `docker compose up` = working app; zero-downtime-ish updates; rollback drill ≤ 10 min | Release drill | M8 |
| N13 | **Cost efficiency** | Per-task cost tracked to ±5% of provider dashboards; budgets hard-stop works | Cost reconciliation | M2, M6 |
| N14 | **Offline / PWA** | Shell works offline; queued actions sync ≤ 5 s after reconnect | Airplane-mode test | M2 |

---

## 🗺 Roadmap overview (the remaining journey)

| Milestone | Theme | Pairs with functional phase | Est. |
| --- | --- | --- | --- |
| **M1** 🧪 | Test & maintainability engineering | Phase 1–3 | 2 wks |
| **M2** ⚡ | Performance & mobile quality | Phase 3, 9, 14 | 2 wks |
| **M3** 🔐 | Security & privacy engineering | Phase 3, 7, 11 | 2–3 wks |
| **M4** 🛟 | Reliability & resilience | Phase 5, 12, 16 | 2 wks |
| **M5** ♿ | Accessibility & compatibility | Phase 14 | 1–2 wks |
| **M6** 📈 | Scalability & capacity | Phase 5, 6 | 2 wks |
| **M7** 📡 | Observability, SLOs & ops | Phase 16 | 1–2 wks |
| **M8** 🚀 | Deployability & release engineering | Phase 17 | 1–2 wks |
| **M9** 🎓 | Production-readiness review & launch | Phase 18 | 1 wk |

```
weeks:  1   3   5   7   9   11  13  15  17  19
M1 ████████
M2     ████████
M3         ██████████
M4             ████████
M5                 ██████
M6                     ████████
M7                         ██████
M8                             ██████
M9                                 ████
```

---

# M1 🧪 Test & Maintainability Engineering

**Goal:** make the codebase safe to change. Everything later (performance, security, scaling) depends on tests catching regressions.

**Targets:** N10 · coverage ≥ 70% on `apps/gateway/src` core · CI green on every PR · cold setup ≤ 15 min

- [ ] **1.1 Adopt TypeScript (incrementally, beginner-safe)**
  - **Why:** types catch mistakes *while you type* and document the API contract for free.
  - **How:** `npm i -D typescript && npx tsc --init` → set `"strict": true, "checkJs": true, "allowJs": true`. Rename files to `.ts` opportunistically (start with `packages/shared/`). Keep `// @ts-check` in remaining `.js` files.
  - Docs: 🌐 https://www.typescriptlang.org/docs (start with “Handbook for JS Programmers”)

- [ ] **1.2 Set up the test pyramid**
  - **Unit (Vitest):** pure logic — policy matcher, trust formula, DAG sort, cost accounting.
    ```bash
    npm i -D vitest && npx vitest init
    ```
    🌐 https://vitest.dev/guide/
  - **Integration (Vitest + real SQLite):** API routes against a throwaway DB per test file (`DATA_DIR=/tmp/test-$$`).
  - **E2E (Playwright):** mobile viewport `390×844` golden paths.
    ```bash
    npm i -D @playwright/test && npx playwright install chromium webkit
    ```
    🌐 https://playwright.dev/docs/intro
  - **Contract mocking (MSW):** mock provider/Telegram/MCP HTTP in tests so CI needs no real keys. 🌐 https://mswjs.io/docs/

- [ ] **1.3 Coverage + quality gates in CI**
  - `vitest run --coverage` (provider: `@vitest/coverage-v8`); fail under 70% on `src/gateway/**` core dirs.
  - ESLint (`typescript-eslint`) + Prettier + `npm audit --audit-level=high` + **gitleaks** secret scan in CI.
    🌐 https://docs.github.com/en/actions · https://github.com/gitleaks/gitleaks
  - Branch protection on `main`: require CI + 1 review.

- [ ] **1.4 API contract as the single source of truth**
  - Keep `packages/shared/api-routes.json` + generate OpenAPI from Fastify schemas (`@fastify/swagger`). Serve Swagger UI at `/docs` (dev only).
  - 🌐 https://fastify.dev/docs/latest/ · https://github.com/fastify/fastify-swagger

- [ ] **1.5 “15-minute cold start” audit**
  - On a clean VM/container: clone → `npm install` → `npm run migrate` → `npm run seed` → `npm run dev`. Time it. Fix whatever hurt (missing engines field, unclear README steps, missing `.env.example`).
  - Add `engines: { "node": ">=20" }` to `package.json` and a `preinstall` Node version check.

**✅ Gate (M1):** CI runs lint + unit + integration + build on every PR; coverage ≥ 70% core; a brand-new machine reaches the running app in ≤ 15 min following only the README.

---

# M2 ⚡ Performance & Mobile Quality

**Goal:** the app feels instant on a mid-range phone over 4G — and stays that way forever (budgets enforced automatically).

**Targets:** N1, N2 (API part), N13 (cost tracking), N14

- [ ] **2.1 Establish the performance baseline (measure before optimizing!)**
  - Install Lighthouse (Chrome DevTools → Lighthouse tab, or CLI):
    ```bash
    npm i -D lighthouse && npx lighthouse http://localhost:4173 --form-factor=mobile --screenEmulation.mobile --output html --output-path docs/evidence/M2/lighthouse-baseline.html
    ```
  - 🌐 https://developer.chrome.com/docs/lighthouse · https://web.dev/articles/vitals (LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1)
  - Save the report. Every number below compares against it.

- [ ] **2.2 Front-end performance budget (bundle)**
  - Vite already code-splits — make it deliberate:
    - Route-level `import()` for heavy views (charts, terminal) — lazy-load `xterm` and chart code only when their route opens.
    - Audit with `npx vite-bundle-visualizer` (rollup-plugin-visualizer). 🌐 https://github.com/btd/rollup-plugin-visualizer
    - Budget in CI: fail if initial JS > 250 KB gzip (script compares `dist/assets/*.js` sizes).
  - Images: compress `docs/images/banner.png` (squoosh) 🌐 https://squoosh.app ; serve SVG icons; add `width/height` to `<img>` (CLS!).

- [ ] **2.3 Rendering performance**
  - Lists > 100 rows (events, logs, usage): virtualize (`virtual-list` pattern or 🌐 https://github.com/TanStack/virtual).
  - Kanban/DAG: reuse the prototype's pointer-drag, but throttle `elementFromPoint` to `requestAnimationFrame`; animate only `transform/opacity`.
  - Debounce search inputs (150 ms); memoize expensive renders (skip re-render when `state.rev` unchanged for that slice — prototype already sketches this).
  - Respect `prefers-reduced-motion` (already tokenized in `styles.css`).

- [ ] **2.4 Network & API performance**
  - HTTP: enable gzip/brotli (`@fastify/compress` 🌐 https://github.com/fastify/fastify-compress), cache headers for hashed assets (`immutable, max-age=1y`), `ETag` on GETs.
  - WS: batch high-frequency events (flush ≤ 10/s), send only changed fields; document backpressure policy (drop-oldest for `analytics.*`, guaranteed for `approvals.*`).
  - SQLite: add indexes for hot queries (`tasks(column)`, `runs(agent_id, started_at)`, `events(ts)`); verify with `EXPLAIN QUERY PLAN` 🌐 https://www.sqlite.org/eqp.html

- [ ] **2.5 Cost & latency accounting (N13)**
  - Every model call records `tokens_in/out, cost_usd, latency_ms` from provider usage fields; nightly reconciliation job compares sums vs. a manual provider-dashboard entry (keep it honest ±5%).
  - Price table `fixtures/prices.json` updated from each provider's pricing page (Appendix A links).

- [ ] **2.6 Offline quality (N14)**
  - Service worker: app shell cached on install; navigation network-first → cache fallback; assets stale-while-revalidate (see prototype `public/sw.js` — production-harden it).
  - Offline **action queue**: mutations get client `Idempotency-Key`s, queue in IndexedDB, sync on `online` (retry w/ backoff). Show queue count banner.
  - 🌐 https://web.dev/learn/pwa · https://developer.chrome.com/docs/workbox (useful patterns; vanilla SW is fine too)
  - Test ritual: load app → DevTools → Network → Offline → reload → navigate → make a queued edit → go Online → watch it sync.

**✅ Gate (M2):** mobile Lighthouse Performance ≥ 90 and PWA checks all green; budgets enforced in CI (build fails on regression); airplane-mode test passes; cost ledger matches provider dashboard within 5%.

---

# M3 🔐 Security & Privacy Engineering

**Goal:** pass OWASP ASVS Level 2, keep secrets and PII safe, and make the governance layer adversarially tested.

**Targets:** N5, N6 (and all four governance layers solid)

- [ ] **3.1 Learn the map (1–2 hours of reading — do this first)**
  - OWASP Top 10 (risks): 🌐 https://owasp.org/www-project-top-ten/
  - OWASP ASVS (verification checklist — we target **L2**): 🌐 https://owasp.org/www-project-application-security-verification-standard/
  - OWASP Cheat Sheets (practical recipes): 🌐 https://cheatsheetseries.owasp.org (start: *Secrets Management*, *Authentication*, *Input Validation*, *SQL Injection*)

- [ ] **3.2 Transport & headers**
  - TLS everywhere (Caddy auto-HTTPS — M8); HSTS; security headers via `@fastify/helmet`:
    ```js
    // apps/gateway/src/app.js
    import helmet from '@fastify/helmet';
    app.register(helmet, {
      contentSecurityPolicy: {
        directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'", 'wss:'] },
      },
      hsts: { maxAge: 15552000 },
    });
    ```
    🌐 https://helmetjs.github.io · https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP
  - CORS: explicit allowlist (`PUBLIC_URL` only). Never `*` with credentials.

- [ ] **3.3 Authentication hardening**
  - Passwords: **argon2id** (`npm i argon2`) 🌐 https://github.com/ranisalt/node-argon2 — params: memory 19 MiB+, iterations 2+, parallelism 1.
  - Login rate limiting + lockout backoff (`@fastify/rate-limit`) 🌐 https://github.com/fastify/fastify-rate-limit
  - Sessions: HTTP-only, `Secure`, `SameSite=Strict` cookies; rotate on login; absolute + idle expiry; “signed out everywhere” button.
  - 2FA (TOTP) for Owner/Admin roles — `otplib` 🌐 https://github.com/yeojz/otplib

- [ ] **3.4 Authorization & injection**
  - RBAC middleware on **every** route (default deny — make the default explicit).
  - Parameterized SQL only (better-sqlite3 prepared statements) — zero string concatenation into SQL. 🌐 https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html
  - Validate every request body/params with schemas (Zod or Fastify JSON Schema). 🌐 https://zod.dev
  - File paths: resolve + enforce prefix under `data/artifacts` (block `../` traversal).

- [ ] **3.5 Secrets & the vault**
  - Encrypt provider keys/bot tokens at rest: AES-256-GCM (Node `node:crypto`) or libsodium secretbox 🌐 https://github.com/jedisct1/libsodium-wrappers — master key from `MASTER_KEY` env (32-byte base64), never stored in the DB.
  - Masked display (`sk-…abc`), rotation endpoint, `*.env` chmod 600, `.env` in `.gitignore` (done).
  - Run **gitleaks** locally + CI; scrub the sample token incident from history awareness (tokens in old chat logs are dead — already revoked ✅).

- [ ] **3.6 Supply chain**
  - `npm audit` in CI (fail high+); Dependabot 🌐 https://docs.github.com/en/code-security/dependabot/dependabot-version-updates
  - Lockfile committed (`package-lock.json` ✅); `npm ci` in CI/Docker (never bare `npm install`).
  - Pin Docker base images by digest; prefer official `node:20-alpine` 🌐 https://hub.docker.com/_/node

- [ ] **3.7 Application-layer abuse defenses**
  - Rate limit per principal + per IP on expensive routes (runs, chat, terminal).
  - Prompt-injection scanner on tool/MCP results crossing trust boundaries (regex + LLM-classifier for high-risk tools); content from the web is rendered as untrusted (no HTML injection in markdown — sanitize with `marked` + DOMPurify 🌐 https://github.com/cure53/DOMPurify).
  - Approval-gate adversarial tests: try approving own request (copilot/agent), replay Telegram button, exceed spend cap, call ungranted tool — **each must fail**.

- [ ] **3.8 Privacy**
  - PII redaction pipeline (regex + NER-lite) on logs, memory, analytics exports; configurable in Settings.
  - “Forget this memory” + data export (JSON) + delete-account paths (even in self-hosted mode — owners need them).
  - Write a one-page `docs/PRIVACY.md` (what's stored, where, retention, how to wipe).

- [ ] **3.9 Verification (the gate evidence)**
  - Walk the ASVS L2 checklist with `docs/evidence/M3/asvs.md` — mark each item Pass/Fail/NA with notes.
  - Optional third-party: OWASP ZAP baseline scan against staging 🌐 https://www.zaproxy.org/getting-started/ ; bug-bounty-style self pen-test with the *RedTeam-Alpha* agent cell (eat your own dog food!).

**✅ Gate (M3):** ASVS L2 recorded with zero outstanding high findings; gitleaks + `npm audit` clean in CI; all adversarial gate tests pass; secrets demonstrably absent from logs/exports.

---

# M4 🛟 Reliability & Resilience

**Goal:** crashes, flaky networks, and bad deploys don't lose data or strand jobs.

**Targets:** N3, N4

- [ ] **4.1 Failure policy: timeouts, retries, circuit breakers**
  - Every external call (provider, MCP, Telegram) gets: timeout (e.g. 30 s), retry with **exponential backoff + jitter** (e.g. 3 tries), and a **circuit breaker** (open after N failures in window; half-open probe).
  - Implement a tiny shared `withResilience(fn, opts)` helper; reuse everywhere. Pattern guide: 🌐 https://github.com/aws-powertools/patterns (retry/breaker sections) & 🌐 https://cheatsheetseries.owasp.org/cheatsheets/Software_Supply_Chain_Security_Cheat_Sheet.html (for pinning)
  - Map provider error classes: `rate_limited` (retry slow), `auth` (open breaker + alert), `schema_invalid` (fallback ladder per routing policy).

- [ ] **4.2 Crash safety for the queue & DB**
  - Jobs: leases + heartbeat + reclaim-on-start (functional Phase 3.5) — now **test it**: kill -9 the gateway mid-job and confirm the job re-runs or completes without duplication (idempotency keys make effects exactly-once).
  - SQLite: keep `journal_mode=WAL`; add `PRAGMA busy_timeout=5000`; nightly `PRAGMA optimize` + weekly `VACUUM`. 🌐 https://www.sqlite.org/wal.html · https://www.sqlite.org/pragma.html
  - Graceful shutdown: SIGTERM handler drains in-flight jobs (≤ 10 s), closes WS with reconnect hint, checkpoints DB.

- [ ] **4.3 Health checks & watchdogs**
  - `/healthz` (process up) + `/readyz` (DB, queue, disk, plugin subprocesses). Wire both into uptime monitoring (M7).
  - Plugin watchdog: auto-restart with backoff; circuit-break a plugin after repeated crashes; surface in UI Plugins tab.

- [ ] **4.4 Backup & restore (make it boring)**
  ```bash
  npm run backup                 # sqlite .backup API + artifacts tar
  npm run restore -- backups/<t> # practice on a scratch machine!
  ```
  - Automate daily (cron / Task Scheduler); retain 7 daily + 4 weekly; optional offsite via S3-compatible storage (rclone 🌐 https://rclone.org).
  - **Quarterly restore drill** — put it in the calendar; log duration against RTO ≤ 30 min.

- [ ] **4.5 Chaos experiments (scheduled, small, controlled)**
  - Script each: (a) kill gateway mid-run (b) kill MCP subprocess mid-call (c) block provider DNS/endpoint (d) fill disk to 95% (e) clock skew test on lease expiry. Each has an expected outcome written *before* running. Store results in `docs/evidence/M4/chaos.md`.
  - 🌐 https://principlesofchaos.org (read the intro — mindset, not tooling)

- [ ] **4.6 Data integrity checks**
  - `npm run audit:verify` (hash chain) in nightly cron; orphaned-file check (files w/o journal rows); referential sweep (tasks → deleted agents).

**✅ Gate (M4):** kill -9 mid-job loses nothing; restore drill ≤ 30 min RTO; chaos runs documented with expected-vs-actual; nightly integrity checks green for 2 weeks.

---

# M5 ♿ Accessibility & Compatibility

**Goal:** WCAG 2.2 AA — usable with a screen reader, a keyboard, and on old phones.

**Targets:** N7, N8

- [ ] **5.1 Learn the standard (short version)**
  - WCAG 2.2 (AA = the bar): 🌐 https://www.w3.org/TR/WCAG22/
  - Practical track: 🌐 https://web.dev/learn/accessibility (free, ~2 h)
  - POUR: **P**erceivable · **O**perable · **U**nderstandable · **R**obust — check everything against these four words.

- [ ] **5.2 Automate what can be automated**
  ```bash
  npm i -D @axe-core/playwright   # axe inside your e2e runs
  ```
  - Add axe assertions to every Playwright page object; fail on `serious`/`critical`.
  - 🌐 https://github.com/dequelabs/axe-core · https://www.npmjs.com/package/@axe-core/playwright

- [ ] **5.3 The manual passes (do each once per release)**
  - [ ] **Keyboard-only:** Tab through every screen — visible focus ring everywhere (CSS already has `:focus-visible`), logical order, no traps, Esc closes sheets, Enter activates. Skip-link to `main`.
  - [ ] **Screen reader (VoiceOver iOS / NVDA):** every icon button has `aria-label`; streaming chat uses `aria-live="polite"`; approval prompts announced; status never color-only (icons+text — prototype does this ✅).
  - [ ] **Zoom/reflow:** 200% text zoom, no horizontal scroll at 320 px width.
  - [ ] **Motion:** `prefers-reduced-motion` disables shimmer/DAG animation (already tokenized ✅).
  - [ ] **Contrast:** text ≥ 4.5:1, large text/icons ≥ 3:1 — verify tokens with a contrast checker 🌐 https://webaim.org/resources/contrastchecker/

- [ ] **5.4 Compatibility matrix (test on real devices)**
  - Chrome/Edge (last 2) · Firefox (last 2) · Safari desktop · **iOS Safari 16+** · **Android Chrome 11+**.
  - PWA install: iOS “Add to Home Screen” (apple-touch-icon ✅) and Android install prompt (`beforeinstallprompt` ✅). Check standalone display + safe-area insets on notched devices.
  - Known-beware list: iOS input zoom (use ≥ 16 px inputs), `100dvh` fallback, backdrop-filter support.

- [ ] **5.5 i18n readiness (even if shipping English-only)**
  - Externalize strings to `locales/en.json` (key-based); `Intl.DateTimeFormat/NumberFormat` for dates/money; `lang="en"` on `<html>`; layout tolerant to 30% text expansion; RTL test with a pseudo-locale.

**✅ Gate (M5):** axe zero serious/critical in CI; keyboard + screen-reader golden path recorded on video; device matrix signed off; 200% zoom clean.

---

# M6 📈 Scalability & Capacity

**Goal:** handle the spec's load envelope on one self-hosted node — and know exactly when you'll outgrow it.

**Targets:** N9 (200 concurrent runs, 50 WS clients, SQLite p95 < 20 ms)

- [ ] **6.1 Load-test with k6 (industry-standard, beginner-friendly)**
  ```bash
  # install: https://k6.io/docs/get-started/installation/
  k6 run --vus 50 --duration 2m load/api-crud.js       # CRUD p95 < 200ms
  k6 run --vus 200 --duration 5m load/agent-runs.js    # 200 concurrent runs
  k6 run --vus 50  --duration 5m load/ws-fanout.js     # 50 WS clients
  ```
  - 🌐 https://k6.io/docs/get-started/first-test/ · https://grafana.com/docs/k6/latest/testing-guides/test-types/stress-test/
  - Record every run's summary JSON in `docs/evidence/M6/`. Baseline first, then tune, then prove.

- [ ] **6.2 Database tuning**
  - Indexes on every foreign key + hot filters (`tasks(column)`, `runs(status, started_at)`, `audit_log(ts)`, `events(cursor)`); check with `EXPLAIN QUERY PLAN` 🌐 https://www.sqlite.org/eqp.html
  - Pagination everywhere (`LIMIT/OFFSET` or keyset `WHERE id > ?` for big tables — keyset preferred for events).
  - Connection policy: single writer + `busy_timeout`; batch event inserts in transactions.
  - When SQLite is genuinely not enough (it rarely is at this scale): read replicas via Litestream 🌐 https://litestream.io or export path to Postgres — **document the trigger thresholds** (e.g. > 5k writes/s sustained) rather than migrating early.

- [ ] **6.3 Application-level scaling levers**
  - Bounded queues + backpressure for run scheduling (fair-share per team).
  - Concurrency caps per provider (respect rate limits — maintain `provider_rate_limits.json`).
  - Caching: semantic cache for model calls (Phase 6 functional), in-process LRU for read-heavy GETs (`lru-cache` 🌐 https://github.com/isaacs/node-lru-cache).
  - WS: rooms by topic; drop `analytics.*` bursts under pressure (never `approvals.*`).

- [ ] **6.4 Capacity planning sheet**
  - From load results, fill in: max agents/node, max WS clients, disk growth/day (events + artifacts), $/1k runs. Put it in `docs/CAPACITY.md` with a “scale-out trigger” column (what number means you need a bigger box / second node).

**✅ Gate (M6):** k6 reports meet N9 numbers on the target VPS (not just your laptop); `CAPACITY.md` filled; p95 API < 200 ms and SQLite queries < 20 ms at target load.

---

# M7 📡 Observability, SLOs & Operations

**Goal:** when something breaks at 3 a.m., the system tells you *what, where, and how bad* — before users do.

**Targets:** N11

- [ ] **7.1 Structured logging everywhere**
  - `pino` JSON logs with shared fields: `ts, level, req_id, principal, run_id, event`. Pretty-print in dev (`pino-pretty`).
  ```bash
  npm i pino pino-pretty
  ```
  - 🌐 https://github.com/pinojs/pino · redaction config for secrets/PII (`redact: ['req.headers.authorization', ...]`).
  - Rotate files (`pino-roll` or logrotate); retention from Settings (N5 privacy ties in).

- [ ] **7.2 Metrics (`/metrics`, Prometheus text format)**
  - `prom-client` 🌐 https://github.com/siimon/prom-client — start with these golden metrics:
    - `http_request_duration_seconds` (histogram, by route)
    - `runs_active`, `runs_completed_total{status}`
    - `jobs_queue_depth`, `jobs_failed_total`
    - `provider_requests_total{provider,status}`, `provider_latency_seconds`
    - `ws_clients`, `approvals_pending`
    - `budget_utilization_ratio{scope}`
  - Even without Prometheus, `/metrics` powers the in-app Analytics and any future scraper. (Optional: Grafana + Prometheus via Docker — 🌐 https://grafana.com/docs/grafana/latest/setup-grafana/installation/docker/)

- [ ] **7.3 Distributed traces (optional but cheap)**
  - OpenTelemetry SDK → console/OTLP exporter; trace a request across API → queue → agent run → MCP call. 🌐 https://opentelemetry.io/docs/instrumentation/js/ · Jaeger all-in-one for viewing 🌐 https://www.jaegertracing.io/docs/getting-started/

- [ ] **7.4 SLOs + alerting (the 6 golden alerts)**
  | Alert | Condition | First responder |
  | --- | --- | --- |
  | Gateway down | `/healthz` fails 2 checks | RUNBOOK §1 |
  | Queue backlog | `jobs_queue_depth` > 100 for 5 min | RUNBOOK §2 |
  | Provider errors | error ratio > 10% / 10 min | RUNBOOK §3 |
  | Budget hard-stop | `budget_utilization` ≥ 1 | RUNBOOK §4 |
  | Disk pressure | data volume > 85% | RUNBOOK §5 |
  | Trust event | agent quarantined / chain verify fail | RUNBOOK §6 |
  - SLO example: 99.5% of `/healthz` 200s per month (error budget = 3.6 h/month). Post in `docs/SLO.md`.
  - Uptime checks (external, free tier): UptimeRobot 🌐 https://uptimerobot.com · Healthchecks.io 🌐 https://healthchecks.io (also for cron backup heartbeats!)

- [ ] **7.5 Runbook (`docs/RUNBOOK.md`)**
  - For each alert: **symptom → where to look (log query / metric) → mitigation → escalation**. Include: provider outage (flip routing policy to fallbacks), queue stuck (requeue job), budget runaway (hard-stop + rotate key), suspected compromise (revoke tokens, `audit:verify`, snapshot).
  - `diagnostics bundle` button (Settings) exports redacted logs + config + versions for support.

**✅ Gate (M7):** all 6 alerts configured and **fired once in a drill**; metrics visible; runbook tested on a staged incident; SLO doc posted.

---

# M8 🚀 Deployability & Release Engineering

**Goal:** ship updates safely — and roll back faster than you can panic.

**Targets:** N12

- [ ] **8.1 Containerize (single artifact)**
  - Multi-stage Dockerfile (build web → run gateway serving `dist/` + data volume):
    ```dockerfile
    FROM node:20-alpine AS build
    WORKDIR /app; COPY package*.json ./
    RUN npm ci; COPY . .; RUN npm run build
    FROM node:20-alpine
    WORKDIR /app; COPY package*.json ./
    RUN npm ci --omit=dev; COPY --from=build /app/apps/web/dist ./dist
    ENV NODE_ENV=production
    EXPOSE 8787; CMD ["node", "apps/gateway/server.js"]
    ```
  - `docker compose.yml` with named volume `./data:/data`, `restart: unless-stopped`, `env_file: .env`.
  - 🌐 https://docs.docker.com/build/building/best-practices/ · https://docs.docker.com/compose/

- [ ] **8.2 Reverse proxy + TLS**
  - **Caddy** (automatic HTTPS — beginner best choice):
    ```
    your-domain.example {
      reverse_proxy 127.0.0.1:8787
    }
    ```
    🌐 https://caddyserver.com/docs/getting-started
  - Alternatives: nginx 🌐 https://nginx.org/en/docs/ · Cloudflare Tunnel (no open ports) 🌐 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
  - Verify: SSL Labs A rating 🌐 https://www.ssllabs.com/ssltest/

- [ ] **8.3 Environments & config hygiene**
  - `.env.example` complete + documented; production checklist: strong `MASTER_KEY`, `SESSION_SECRET`, `BOOTSTRAP_ADMIN_*`, `ALLOW_DEV_SEED=false`, `NODE_ENV=production`, file perms 600.
  - Never run dev tools in prod images (no devDependencies, no `/docs` swagger, no seed endpoint).

- [ ] **8.4 Release procedure (write it, then rehearse it)**
  ```
  1. CI green on main → tag vX.Y.Z
  2. On server: npm run backup        (always first!)
  3. git fetch && git checkout vX.Y.Z
  4. npm ci --omit=dev && npm run migrate && npm run build
  5. docker compose up -d --no-deps swarmos
  6. curl -f https://your-domain/healthz && smoke the golden path
  7. Rollback if fail: git checkout prev-tag && npm run restore -- backups/<t> && compose up
  ```
  - Rehearse **rollback** once on staging; measure it (target ≤ 10 min).
  - Blue/green lite: run a second container on another port and flip the Caddy proxy for near-zero downtime.

- [ ] **8.5 Server baseline**
  - UFW: allow 22/80/443 only; SSH keys only; unattended-upgrades; disk monitoring (M7 alert).
  - 🌐 https://ubuntu.com/server/docs/security-hardening (or your distro's hardening guide)

**✅ Gate (M8):** `docker compose up` works from a clean VPS with only `.env` + Caddy; release + rollback rehearsed ≤ 10 min; SSL Labs A; no dev tooling reachable in prod.

---

# M9 🎓 Production-Readiness Review & Launch

**Goal:** a deliberate, evidence-based "go" decision — then a calm first month.

- [ ] **9.1 The NFR audit (one sitting, whole team)**
  - Walk the scorecard (N1–N14) with `docs/evidence/` open. Every row: ✅ with a link to proof, or ❌ with a blocking issue filed.
  - Security: ASVS L2 sheet, gitleaks + npm audit clean, adversarial gate tests.
  - Restore drill less than 30 days old. Chaos results reviewed. Load numbers match target hardware.

- [ ] **9.2 Docs freeze**
  - README quick-start validated by someone who has never seen the project (task them literally).
  - RUNBOOK, SLO, CAPACITY, PRIVACY published in `docs/`.
  - Known-issues list (honest gaps > pretending perfection).

- [ ] **9.3 Support model**
  - Who gets paged (GitHub Issues → Telegram alerts); response expectations; where users report bugs; feedback template.

- [ ] **9.4 Soft launch → GA**
  - 2–5 real users for 1–2 weeks watching: run success rate, gate hit rate, provider errors, cost accuracy, crash-free sessions.
  - Fix blockers → GA tag `v1.0.0` → announce.

- [ ] **9.5 The first month (operating rhythm)**
  - Weekly: audit highlights, trust movements, synthesized-skill queue, spend review.
  - Monthly: dependency updates (Dependabot PRs), price-table refresh, one chaos drill, one restore-heartbeat check.
  - Quarterly: restore drill, access review (roles/tokens), ASVS spot-check, NFR scorecard re-measure.

**✅ Gate (M9):** scorecard all green with evidence; `v1.0.0` tagged; operating rhythm scheduled; first-month metrics reviewed.

---

# 📚 Appendix A — Resource Library (every URL you'll need)

> Learn to navigate docs like a pro: find **Quickstart** → copy the smallest working example → read **Errors/Rate limits** before scaling up.

## 🤖 LLM provider APIs & docs
| Provider | Docs / API | Notes |
| --- | --- | --- |
| OpenAI (GPT-5, o3) | https://platform.openai.com/docs · https://platform.openai.com/api-keys | Streaming, tool calls, usage per response |
| Anthropic (Claude) | https://docs.anthropic.com · https://console.anthropic.com/ | Messages API, tool use, prompt caching |
| Google Gemini | https://ai.google.dev/gemini-api/docs | OpenAI-compatible endpoint available |
| xAI Grok | https://docs.x.ai | OpenAI-compatible |
| OpenRouter | https://openrouter.ai/docs | One API, many models — great for fallbacks |
| Together AI | https://docs.together.ai | Open-source model hosting |
| Mistral | https://docs.mistral.ai | La Plateforme |
| Cohere | https://docs.cohere.com | Command R+ |
| AI21 | https://docs.ai21.com | Jamba |
| Zhipu GLM | https://open.bigmodel.cn/dev/api | Chinese-language model family |
| DeepSeek | https://platform.deepseek.com/api-docs | V3 / R1 |
| Qwen (DashScope) | https://help.aliyun.com/zh/model-studio | Alibaba Model Studio |
| MiniMax | https://platform.minimaxi.com/document | |
| Moonshot (Kimi) | https://platform.moonshot.ai/docs | |
| Perplexity | https://docs.perplexity.ai | Sonar — search-grounded |
| Groq | https://console.groq.com/docs | Very fast inference |
| Azure OpenAI | https://learn.microsoft.com/azure/ai-services/openai/ | Enterprise |
| AWS Bedrock | https://docs.aws.amazon.com/bedrock/ | Enterprise |
| GCP Vertex AI | https://cloud.google.com/vertex-ai/generative-ai/docs | Enterprise |
| IBM watsonx | https://www.ibm.com/docs/en/watsonx | Enterprise |
| Pricing (for `prices.json`) | each provider's pricing page linked from its docs footer | update monthly |

## 🖥 Local / self-hosted inference
| Tool | URL | Notes |
| --- | --- | --- |
| Ollama | https://docs.ollama.com · https://github.com/ollama/ollama | Easiest local models |
| LM Studio | https://lmstudio.ai/docs | GUI + OpenAI-compatible server |
| llama.cpp | https://github.com/ggml-org/llama.cpp | GGUF models, `llama-server` |
| vLLM | https://docs.vllm.ai | High-throughput serving |
| LocalAI | https://localai.io/docs | Drop-in OpenAI-compatible |
| TabbyAPI | https://github.com/theroyallab/tabbyAPI | EXL2 models |

## 🧩 MCP & plugin integrations
| Item | URL |
| --- | --- |
| Model Context Protocol (spec + docs) | https://modelcontextprotocol.io |
| MCP TypeScript SDK | https://github.com/modelcontextprotocol/typescript-sdk |
| MCP Python SDK | https://github.com/modelcontextprotocol/python-sdk |
| GitHub REST API | https://docs.github.com/en/rest |
| GitHub GraphQL | https://docs.github.com/en/graphql |
| GitHub fine-grained PATs | https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens |
| Supabase docs + JS client | https://supabase.com/docs · https://github.com/supabase/supabase-js |
| Firecrawl docs | https://docs.firecrawl.dev · https://github.com/mendableai/firecrawl |
| Vercel REST API | https://vercel.com/docs/rest-api |
| Airtable Web API | https://airtable.com/developers/web/api/introduction |
| Base44 | https://base44.com (API reference in your Base44 workspace docs) |

## 🤖 Agent frameworks
| Framework | URL | Notes |
| --- | --- | --- |
| OpenAI Swarm / Agents SDK | https://github.com/openai/swarm · https://github.com/openai/openai-agents-python | Swarm is educational; Agents SDK is successor |
| CrewAI | https://docs.crewai.com · https://github.com/crewAIInc/crewAI | Python — sidecar runner |
| LangGraph | https://langchain-ai.github.io/langgraph/ · https://github.com/langchain-ai/langgraph | Graph + checkpointing |
| SwarmZero | https://swarmzero.ai · https://github.com/swarmzero | Verify repo — search GitHub |
| AutoPentest | https://github.com/search?q=autopentest | Multiple projects — pick & pin |
| A.I.M.A (aimacode) | https://github.com/aimacode/aima-python | Russell & Norvig reference code |
| Project Nautilus | https://github.com/search?q=project+nautilus+agent | Confirm exact upstream before adopting |

## 💬 Messaging
| Item | URL |
| --- | --- |
| Telegram Bot API | https://core.telegram.org/bots/api |
| Long polling (`getUpdates`) | https://core.telegram.org/bots/api#getting-updates |
| Inline buttons & deep links | https://core.telegram.org/bots/inline |
| BotFather commands | https://core.telegram.org/bots#botfather |

## 📱 PWA, web platform & performance
| Item | URL |
| --- | --- |
| PWA learning path | https://web.dev/learn/pwa |
| Web App Manifest | https://developer.mozilla.org/en-US/docs/Web/Manifest |
| Service Workers | https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API |
| Workbox (SW toolkit) | https://developer.chrome.com/docs/workbox |
| Core Web Vitals | https://web.dev/articles/vitals |
| Lighthouse | https://developer.chrome.com/docs/lighthouse |
| WebPageTest | https://www.webpagetest.org |
| Squoosh (image compression) | https://squoosh.app |

## 🔐 Security & privacy
| Item | URL |
| --- | --- |
| OWASP Top 10 | https://owasp.org/www-project-top-ten/ |
| OWASP ASVS (our L2 target) | https://owasp.org/www-project-application-security-verification-standard/ |
| OWASP Cheat Sheets | https://cheatsheetseries.owasp.org |
| OWASP ZAP (scanner) | https://www.zaproxy.org/getting-started/ |
| Node argon2 | https://github.com/ranisalt/node-argon2 |
| libsodium-wrappers | https://github.com/jedisct1/libsodium-wrappers |
| helmet | https://helmetjs.github.io |
| rate-limit | https://github.com/fastify/fastify-rate-limit |
| DOMPurify | https://github.com/cure53/DOMPurify |
| Gitleaks | https://github.com/gitleaks/gitleaks |
| zod | https://zod.dev |

## ♿ Accessibility
| Item | URL |
| --- | --- |
| WCAG 2.2 | https://www.w3.org/TR/WCAG22/ |
| web.dev accessibility course | https://web.dev/learn/accessibility |
| axe-core | https://github.com/dequelabs/axe-core |
| axe + Playwright | https://www.npmjs.com/package/@axe-core/playwright |
| WebAIM contrast checker | https://webaim.org/resources/contrastchecker/ |
| ARIA Authoring Practices | https://www.w3.org/WAI/ARIA/apg/ |

## 🧪 Testing & load
| Item | URL |
| --- | --- |
| Vitest | https://vitest.dev |
| Playwright | https://playwright.dev |
| MSW (API mocking) | https://mswjs.io |
| k6 (load testing) | https://k6.io/docs/get-started/ |
| Artillery (alt load tool) | https://www.artillery.io/docs |
| Testing Library | https://testing-library.com/docs |

## 🛠 Backend, data & realtime
| Item | URL |
| --- | --- |
| Fastify | https://fastify.dev/docs/latest/ |
| better-sqlite3 | https://github.com/WiseLibs/better-sqlite3 |
| Node built-in `node:sqlite` | https://nodejs.org/api/sqlite.html |
| SQLite WAL mode | https://www.sqlite.org/wal.html |
| `EXPLAIN QUERY PLAN` | https://www.sqlite.org/eqp.html |
| sqlite-vec (vectors) | https://github.com/asg017/sqlite-vec |
| Litestream (replication) | https://litestream.io |
| ws (WebSockets) | https://github.com/websockets/ws |
| node-pty | https://github.com/microsoft/node-pty |
| xterm.js | https://xtermjs.org |
| lru-cache | https://github.com/isaacs/node-lru-cache |

## 📡 Observability & ops
| Item | URL |
| --- | --- |
| pino | https://github.com/pinojs/pino |
| prom-client | https://github.com/siimon/prom-client |
| OpenTelemetry (JS) | https://opentelemetry.io/docs/instrumentation/js/ |
| Grafana (Docker) | https://grafana.com/docs/grafana/latest/setup-grafana/installation/docker/ |
| UptimeRobot | https://uptimerobot.com |
| Healthchecks.io (cron heartbeats) | https://healthchecks.io |
| Principles of Chaos | https://principlesofchaos.org |

## 🚀 Deployment & supply chain
| Item | URL |
| --- | --- |
| Docker best practices | https://docs.docker.com/build/building/best-practices/ |
| Docker Compose | https://docs.docker.com/compose/ |
| Caddy (auto-HTTPS) | https://caddyserver.com/docs/getting-started |
| Cloudflare Tunnel | https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/ |
| SSL Labs test | https://www.ssllabs.com/ssltest/ |
| GitHub Actions | https://docs.github.com/en/actions |
| Dependabot | https://docs.github.com/en/code-security/dependabot |
| rclone (offsite backup) | https://rclone.org |

## 📖 Language & craft
| Item | URL |
| --- | --- |
| TypeScript handbook (for JS devs) | https://www.typescriptlang.org/docs/handbook/intro.html |
| Node.js docs | https://nodejs.org/api/ |
| MDN Web Docs | https://developer.mozilla.org |
| Vite docs | https://vite.dev/guide/ |

---

# 📚 Appendix B — Tooling install quick reference

```bash
# core (already in repo)
npm i -D typescript vitest @vitest/coverage-v8 @playwright/test @axe-core/playwright
npx playwright install chromium webkit

# quality & security
npm i -D eslint prettier typescript-eslint lighthouse
npm i -D rollup-plugin-visualizer
npm i argon2 helmet @fastify/helmet @fastify/rate-limit @fastify/compress @fastify/swagger
npm i zod dompurify marked lru-cache

# gateway runtime
npm i fastify ws better-sqlite3 pino pino-pretty prom-client node-pty
npm i @fastify/websocket @fastify/cookie @fastify/multipart

# external tools
# ImageMagick   https://imagemagick.org
# k6            https://k6.io/docs/get-started/installation/
# gitleaks      https://github.com/gitleaks/gitleaks
# Caddy         https://caddyserver.com/docs/get-started/
# Docker        https://docs.docker.com/get-docker/
```

---

# 📚 Appendix C — Evidence checklist (print this)

| Evidence file | Proves | Milestone |
| --- | --- | --- |
| `evidence/M1/ci-green.txt` + coverage report | N10 | M1 |
| `evidence/M2/lighthouse-baseline.html` + `final.html` | N1 | M2 |
| `evidence/M2/airplane-test.mp4` (or notes) | N14 | M2 |
| `evidence/M3/asvs.md` + gitleaks/npm audit output | N5 | M3 |
| `evidence/M3/adversarial-gates.md` | N5 governance | M3 |
| `evidence/M4/restore-drill.md` + `chaos.md` | N3, N4 | M4 |
| `evidence/M5/axe-report.html` + keyboard/SR notes | N7 | M5 |
| `evidence/M5/device-matrix.md` | N8 | M5 |
| `evidence/M6/k6-*.json` + `CAPACITY.md` | N9 | M6 |
| `evidence/M7/alert-drill.md` + dashboard screenshots | N11 | M7 |
| `evidence/M8/release-rollback-drill.md` | N12 | M8 |
| `evidence/M9/scorecard-signed.md` | N1–N14 | M9 |

---

*Start with M1 today — type-safety and tests make every later milestone twice as fast. When the Appendix C folder is full, you're production.* ✅
