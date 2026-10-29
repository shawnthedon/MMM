# MMM De-demo and Blocked-Feature Completion Plan

> **For agentic workers:** Use the plan task-by-task. Every task ends with tests and evidence before proceeding.

**Goal:** Replace shipped simulations with real implementations and unblock MMM features in dependency order.  
**Architecture:** Preserve the existing Vite PWA and Node gateway. Build server-side capabilities behind authenticated, audited routes, then move each client slice from local/demo state to gateway-owned data and real execution.  
**Tech Stack:** Existing JavaScript ES modules, Vite, Node.js HTTP gateway, SQLite, WebSocket, existing test scripts.  
**Spec:** `docs/superpowers/specs/2026-10-29-mmm-de-demo-design.md`

## Global constraints
- No fake/mock implementations in shipped `src/` paths.
- Provider secrets remain server-side and never enter localStorage or logs.
- Keep capability status truthful: `available`, `unverified`, `demo`, `unconfigured`, `blocked`.
- Each slice has a regression test and evidence before the roadmap is marked complete.
- Preserve auth, consent, policy, audit, provenance, and mobile-first design conventions.

## Review Focus
- Missing gateway URL or provider key must never yield a canned answer or fake success.
- Provider timeout, network failure, rate limit, and invalid credentials must return honest errors.
- Unauthorized and CSRF-invalid mutations must be rejected and audited.
- Reloading or opening a second client must not lose or contradict gateway-owned state.
- Offline/local AI must not be labelled available until a real on-device model completes inference.

## Task 1: Establish a no-fake-success gate
- [ ] Inventory every shipped simulation listed in `docs/FEATURE_COMPLETION_ROADMAP.md` §2 and map it to a test.
- [ ] Add focused tests for Chat canned replies, swarm random progress, Telegram fake send, Analytics constants, and simulated Files uploads.
- [ ] Ensure missing dependencies produce disabled controls and explicit `unconfigured` or `blocked` states.
- [ ] Run the focused tests and record the baseline failures before changing behavior.
- [ ] Update the evidence log only with observed test output.

## Task 2: Implement Model Gateway (highest-leverage dependency)
- [ ] Inspect existing migrations, route registration, RBAC permissions, provider safety tests, and environment configuration.
- [ ] Add a new migration for provider configuration/usage only if existing schema cannot support the requirements; never edit an applied migration.
- [ ] Implement server-side provider secret storage/configuration with no secret echoing and strict access controls.
- [ ] Implement provider/model listing and a real completion endpoint with timeout, abort, bounded request size, normalized errors, and supported streaming.
- [ ] Add usage rows only after a successful real provider response; store integer cost units and token counts where returned.
- [ ] Add provider adapter contract tests and a real-call smoke test that skips honestly when credentials are absent.
- [ ] Verify provider safety, gateway auth, audit-chain, build, and focused tests.

## Task 3: Replace Chat simulation
- [ ] Remove the canned reply scheduler and invented cost text from shipped code.
- [ ] Send chat requests through the gateway Model Gateway.
- [ ] Persist threads/messages server-side and load them through the datastore.
- [ ] Add loading, cancellation, timeout, provider error, unconfigured, and empty states.
- [ ] Prove with tests that no local canned response is emitted and real provider errors are surfaced.

## Task 4: Connect Copilot to real execution
- [ ] Preserve consent, capability registry, and policy checks.
- [ ] Route permitted model-backed answers through the gateway.
- [ ] Keep unsupported actions blocked and never silently execute simulated actions.
- [ ] Test consent denial, missing provider configuration, successful real response, and policy denial.

## Task 5: Real agents and Swarms
- [ ] Persist Teams and Swarms through gateway routes and existing tables.
- [ ] Replace random interval progress and hard-coded cost estimates with server-owned job lifecycle and measured usage.
- [ ] Enforce budgets and approval gates before consequential execution.
- [ ] Add bounded worker execution, cancellation, retries, audit, and multi-client state tests.

## Task 6: Complete integrations and persistence
- [ ] Teams and Skills: gateway-owned CRUD and real invocation/validation.
- [ ] Plugins/MCP: real MCP client lifecycle, permission boundaries, and secret-safe configuration; no fake install state.
- [ ] Telegram/Comms: real bot/provider request and delivery receipt; test button disabled until configured.
- [ ] Files: real upload/download/storage metadata and integrity checks; no local fake uploads.
- [ ] Settings: persist and apply each supported setting or mark it unavailable.

## Task 7: Complete Analytics, Training, Local AI, and Voice
- [ ] Derive analytics only from stored, timestamped events and usage.
- [ ] Implement durable training/evaluation jobs with status, results, cancellation, and tests; otherwise keep capability blocked.
- [ ] Implement genuine on-device GGUF inference with model lifecycle, storage checks, cancellation, and offline tests.
- [ ] Keep browser speech clearly identified; wire local speech/cloning only to configured, consented services.
- [ ] Verify with relevant scripts and hardware/runtime-specific evidence.

## Task 8: Remove obsolete demo paths and close out
- [ ] Search shipped code for simulation markers, canned replies, random progress, hard-coded metrics, and fake success toasts.
- [ ] Remove each path only after the replacement tests pass.
- [ ] Update feature and production roadmaps, `PROGRESS.md`, capability states, and evidence log.
- [ ] Run `npm test`, `npm run build`, audit verification, responsive checks, and configured integration smoke tests.
- [ ] Request code review and open a PR with test output and known external setup blockers.

## Execution rule
Do not mark a task complete because code was edited. A task is complete only when the specified tests run and pass and the evidence is recorded. If the environment cannot run a test or a provider is not configured, report it as unverified/unconfigured rather than PASS.
