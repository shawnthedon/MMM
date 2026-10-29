# Demo writer agent

A deliberately small, deliberately imperfect agent implementation. It exists so the self-improvement
cycle has a real defect to find:

* `greet.mjs` returns `hi Ada`
* `greet.test.mjs` expects `Hello, Ada` — so the suite fails as shipped
* `health.mjs` is the deployment health check (it passes once the greeting is fixed)

Nothing else in MMM imports these files. The platform copies them into an isolated experiment
workspace (`DATA_DIR/experiments/<id>/`), lets an authorised agent propose a fix there, runs the tests
in the sandbox, and — only after the policy's tests, reviews, health check and approvals pass —
publishes a version under `DATA_DIR/runtime/<agent>/`. **The repository copy is never modified by the
gateway.**

Used by `npm run test:evolution` (acceptance criteria 1–18).
