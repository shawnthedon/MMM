# MMM De-demo and Blocked-Feature Completion — Design

**Date:** 2026-10-29  
**Status:** Execution design  
**Source of truth:** `docs/PRODUCTION_ROADMAP.md` for sequence and `docs/FEATURE_COMPLETION_ROADMAP.md` for module acceptance criteria.

## Intent
Turn MMM from a UI-heavy prototype into a truthful, usable application by implementing blocked capabilities and replacing every shipped simulation with a real service path. Prioritise the dependency chain that unlocks the most features, while keeping the app safe when required credentials or runtimes are absent.

## Goals
- No canned AI responses, random progress, fabricated analytics, fake successful sends, or pretend uploads in shipped application paths.
- Implement real provider calls, persistence, execution, metering, and integrations in small reviewable slices.
- Every feature reports one honest capability state: `available`, `unverified`, `demo`, `unconfigured`, or `blocked`.
- Preserve the existing UI and design system unless a change is required to make status, errors, loading, and disabled states truthful.
- Add regression tests and evidence for each slice; update the roadmap and progress log only after verification.

## Non-goals
- Do not claim every external integration is live without its credentials, service, and an actual successful verification.
- Do not introduce mock implementations into `src/` or production code paths.
- Do not delete the existing governance, audit, consent, provenance, or capability-status mechanisms to make screens appear complete.
- Do not replace the existing architecture wholesale.

## Approaches considered
1. **Big-bang rewrite:** replace all demo paths at once. Rejected because the changes cross many dependent subsystems, are hard to verify, and increase regression risk.
2. **UI-first cleanup:** hide or relabel demo controls before building their execution paths. Rejected as the primary strategy because it does not deliver the requested capabilities.
3. **Dependency-ordered vertical slices (selected):** first stop false success, then build the real model execution foundation, then wire dependent features and integrations one slice at a time. Each slice includes tests and evidence. This best matches the repository's own roadmaps and reduces repeated work.

## Execution order
1. **Truthfulness and baseline:** identify every fake-success path; ensure absent dependencies are disabled or clearly marked; add tests that prevent false claims.
2. **Model Gateway (M09 / L5 foundation):** provider configuration and secure server-side secret handling; real provider requests, timeouts, cancellation, streaming where supported, normalized errors, and usage records only after actual responses.
3. **Chat and Copilot (M10–M11 / L4):** replace canned replies and deterministic answer simulation with model-backed execution while preserving consent and policy gates.
4. **Agent execution and Swarms (M01, M03–M04):** real run lifecycle, server-owned progress, bounded execution, budget checks, and audit records.
5. **Persistence and integrations:** Teams, Skills, Plugins/MCP, Telegram/Comms, Files, Settings.
6. **Analytics and operations:** derive metrics from stored events; add real evaluation/training jobs and evidence.
7. **Local AI and Voice:** deliver actual on-device GGUF inference and configured speech engines; clearly separate browser speech from unavailable local services.
8. **Final demo-path removal:** remove obsolete simulation code only after replacement paths and tests pass; update documentation and production gates.

## Constraints and safety
- Provider keys must never enter browser JavaScript, localStorage, URLs, logs, or chat.
- External side effects require explicit configuration and appropriate user confirmation/approval.
- Money and budgets use integer units; usage is recorded only for real provider calls.
- Every route enforces permissions, CSRF on mutations, audit logging, input limits, and consistent error handling.
- Do not mark capabilities `available` without an integration test or captured real-call evidence.
- Keep the current mobile-first UI and accessible disabled/error/loading states.
- Missing external credentials or host capabilities are configuration blockers, not reasons to ship a mock.

## Definition of done
For each module: a failing regression test exists first; the implementation uses the real execution path; focused tests and the full relevant suite pass; no fake success remains in that module; error/offline/unconfigured states are truthful; the roadmap and evidence log are updated; and a reviewable commit/PR is available. A module is not complete solely because its screen renders.
