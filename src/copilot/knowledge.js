/* ============ Copilot knowledge pack — versioned, source-linked, read-only ============
 * Grounding rule (master spec §4.4): every entry states where the claim came from and how
 * strongly it is supported. Statuses:
 *   verified  — checked directly in this repository or a successful test at BUILD commit
 *   observed  — read from live runtime state at answer time
 *   inferred  — plausible explanation, not confirmed
 *   unknown   — no evidence available; never fabricate
 * This pack is a static snapshot. It is NOT an ingestion pipeline (that is Phase 2 work).
 */
import { getState } from '../core.js';
import { getDesignerSummary } from '../designerSummary.js';

export const PACK = {
  version: 'repo:66b1bd3',
  built: '2026-10-26',
  scope: 'MMM V2 / MMM repository as cloned for Phase 0 discovery',
};

/** @typedef {{id:string,title:string,type:string,module:string,tags:string[],status:'verified'|'observed'|'inferred'|'unknown',body:string,sources:{label:string,ref:string}[],updated:string,version:string,sensitivity:'internal'|'public'}} Entry */

/** @type {Entry[]} */
export const KNOWLEDGE = [
  {
    id: 'app.overview',
    title: 'What MMM (MMM V2) is',
    type: 'concept',
    module: 'product',
    tags: ['overview', 'product', 'mmm', 'mmm', 'scope', 'what'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-26',
    sensitivity: 'public',
    body:
      'MMM is a mobile-first control plane for AI agent operations: agent profiles, teams, swarms, tasks, skills, MCP plugins, a model-routing catalogue, trust/governance, artifacts and an embedded Copilot.\n' +
      'It ships as an installable PWA (Vite build) and is designed to run against one self-hosted gateway process (Node HTTP + WebSocket) with SQLite storage and a filesystem artifact directory.\n' +
      'Today the PWA renders seeded demo state from the browser; the gateway exists but the front end does not call it yet.',
    sources: [
      { label: 'README.md — product summary', ref: 'README.md' },
      { label: 'docs/DESIGN_SPEC.md §1 Executive Summary', ref: 'docs/DESIGN_SPEC.md' },
      { label: 'docs/PROGRESS.md — phase tracker', ref: 'docs/PROGRESS.md' },
    ],
  },
  {
    id: 'ui.navigation',
    title: 'Navigation model and routes',
    type: 'procedure',
    module: 'ui',
    tags: ['navigation', 'tabs', 'routes', 'screens', 'where', 'open'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-27',
    sensitivity: 'public',
    body:
      'Hash router: one route at a time in <main id="view">, rendered from the `views` registry.\n' +
      'Modules: home, agents, teams (teams + swarms + DAG monitor), tasks (Kanban), chat, skills, models, plugins, telegram, analytics, artifacts (File Manager), terminal, settings.\n' +
      'Bottom tab bar holds four module slots plus the Copilot launcher in the centre: Home · Agents · ✦ Copilot · Tasks · More. “More” lists every remaining module.\n' +
      'Chat is not a tab: it is the 💬 header button immediately left of the notifications bell (it highlights while #/chat is open). The header also carries the account chip, notifications and settings, and the workspace mark without its name text.',
    sources: [
      { label: 'src/shell.js — routes, TABS, tab bar', ref: 'src/shell.js' },
      { label: 'src/main.js — hash router', ref: 'src/main.js' },
    ],
  },
  {
    id: 'ui.copilot.launcher',
    title: 'Where the Copilot lives and how it opens',
    type: 'procedure',
    module: 'copilot',
    tags: ['copilot', 'fab', 'launcher', 'panel', 'open', 'close', 'keyboard'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-26',
    sensitivity: 'public',
    body:
      'The launcher is the central action of the bottom navigation (not a floating button over content). It has the accessible name “Open Copilot” and reflects open state through aria-expanded.\n' +
      'Press it to open the floating panel. Escape closes it; the close button also closes it; on narrow screens the backdrop closes it. Your draft prompt, active mode and conversation survive closing and reopening.\n' +
      'Keyboard focus is trapped inside the panel while it is open and returns to the launcher when it closes. A global “Copilot” action is also registered for other screens and the terminal.',
    sources: [
      { label: 'src/shell.js — tab bar launcher', ref: 'src/shell.js' },
      { label: 'src/copilot/panel.js — panel, focus trap, draft', ref: 'src/copilot/panel.js' },
    ],
  },
  {
    id: 'ui.copilot.modes',
    title: 'Copilot modes and what each one can do',
    type: 'concept',
    module: 'copilot',
    tags: ['copilot', 'modes', 'ask', 'operate', 'build', 'knowledge', 'training', 'voice', 'activity'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-26',
    sensitivity: 'public',
    body:
      'Ask — grounded explanations about the app, this screen, settings and behaviour.\n' +
      'Operate — propose and run authorised app actions on the demo store (agents, tasks, swarms, approvals, theme, navigation).\n' +
      'Build — inspect agent/team/skill definitions and propose new agents from a reviewed template.\n' +
      'Knowledge — search the versioned, source-linked knowledge pack; shows verification status and freshness.\n' +
      'Training / Voice — no backend or verified engine exists, so these modes only report the blocker and run real local dataset checks.\n' +
      'Activity — recent Copilot actions from episodic memory plus the app event feed and pending approvals.\n' +
      'Mode selection is not authorisation: every consequential action needs explicit confirmation, and when a gateway session exists the server re-checks the permission and records an audit entry.',
    sources: [
      { label: 'src/copilot/orchestrator.js — MODES', ref: 'src/copilot/orchestrator.js' },
      { label: 'src/copilot/capabilities.js — capability registry', ref: 'src/copilot/capabilities.js' },
    ],
  },
  {
    id: 'ui.copilot.holographic',
    title: 'Holographic empty state rules',
    type: 'concept',
    module: 'copilot',
    tags: ['copilot', 'holographic', 'empty', 'blank', 'motion', 'reduced-motion', 'css'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-26',
    sensitivity: 'public',
    body:
      'The decorative holographic layer is shown only when the work area has no substantive content. “Blank” is derived from real UI state: an empty conversation with no pending request, not a timer.\n' +
      'The first message, card or approval fades the layer out (opacity only, so there is no layout shift); it never sits behind dense text, tables, logs or approvals. The layer is aria-hidden, pointer-events:none, and its animation pauses when not blank.\n' +
      'With prefers-reduced-motion: reduce the gradient stops animating and the transition becomes near-instant.',
    sources: [
      { label: 'src/copilot/panel.js — isBlank()', ref: 'src/copilot/panel.js' },
      { label: 'src/copilot.css — .cp-holo', ref: 'src/copilot.css' },
    ],
  },
  {
    id: 'data.store',
    title: 'Where app state lives',
    type: 'reference',
    module: 'data',
    tags: ['state', 'storage', 'localstorage', 'persistence', 'database', 'sqlite'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-26',
    sensitivity: 'internal',
    body:
      'The PWA keeps one mutable state object in memory and mirrors it to localStorage under the key mmm-state-v1, debounced ~250 ms.\n' +
      'It holds settings, gateway info, agents, teams, swarms, tasks, approvals, threads, files, events, usage, telegram and terminal lines. Terminal history is capped at 200 lines and events at 80.\n' +
      'The server-side source of truth is SQLite (WAL) via the gateway, but the browser store is not synchronised with it yet. Clearing site data resets the app to seeded fixtures.',
    sources: [
      { label: 'src/core.js — load/persist/commit', ref: 'src/core.js' },
      { label: 'apps/gateway/src/db.js', ref: 'apps/gateway/src/db.js' },
    ],
  },
  {
    id: 'data.demo',
    title: 'Demo data vs live data',
    type: 'concept',
    module: 'data',
    tags: ['demo', 'simulated', 'fixtures', 'seed', 'reset', 'live'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-26',
    sensitivity: 'internal',
    body:
      'On first load the app seeds a fixture set (agents, swarms, tasks, approvals, files, events, provider catalogue). Nothing advances it: the 4.2 s simulation ticker was deleted in M27, so what you see is what is stored.\n' +
      'Fixtures can be restored with `npm run seed -- --reset` (gateway) or by clearing the browser store. Nothing in the PWA is a live agent run today.\n' +
      'The Copilot panel labels this explicitly with a “Demo data” runtime chip and shows whether the gateway health endpoint answered.',
    sources: [
      { label: 'src/core.js — seed()', ref: 'src/core.js' },
      { label: 'src/main.js — simulation tick', ref: 'src/main.js' },
      { label: 'fixtures/*.json', ref: 'fixtures/' },
    ],
  },
  {
    id: 'gateway.api',
    title: 'Gateway HTTP API surface',
    type: 'reference',
    module: 'gateway',
    tags: ['gateway', 'api', 'endpoints', 'rest', 'port', '8787', 'health'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-26',
    sensitivity: 'internal',
    body:
      'Run with `npm run dev:gateway`; listens on PORT or 8787 and allows any origin (Access-Control-Allow-Origin: *).\n' +
      'GET /healthz · GET /api/v1/summary · GET|POST /api/v1/agents · GET|PATCH /api/v1/agents/:id · GET|POST /api/v1/tasks · PATCH /api/v1/tasks/:id · GET /api/v1/approvals · POST /api/v1/approvals/:id/allow|deny · GET /api/v1/events?cursor= · GET /api/v1/audit/verify · POST /api/v1/dev/seed.\n' +
      'WebSocket /ws broadcasts { topic, type, entity?, payload?, ts, cursor? } for agents, tasks, approvals and system.',
    sources: [
      { label: 'apps/gateway/server.js', ref: 'apps/gateway/server.js' },
      { label: 'packages/shared/api-routes.json', ref: 'packages/shared/api-routes.json' },
    ],
  },
  {
    id: 'gateway.auth',
    title: 'Gateway authentication and session model',
    type: 'reference',
    module: 'gateway',
    tags: ['auth', 'authentication', 'login', 'session', 'cookie', 'csrf', 'password', 'scrypt', 'lockout', 'security'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-27',
    sensitivity: 'internal',
    body:
      'Every data route now requires a credential; GET /healthz, POST /api/v1/auth/login and provider webhook/verification routes are public (webhooks require their configured signature). Health reports nothing operational to an anonymous caller.\n' +
      'Sessions: POST /api/v1/auth/login with email + password (override with --user/-u and --data for curl). The reply sets an HttpOnly, SameSite=Strict cookie (Secure behind TLS) and returns the principal, its permission list and an HMAC CSRF token. Mutations made with the cookie must send x-mmm-csrf.\n' +
      'Passwords are stored as scrypt hashes with a per-user salt (N=16384, r=8, p=1) in the principals table. Argon2id would be stronger but needs a native dependency; that trade-off is documented rather than hidden.\n' +
      'API tokens: POST /api/v1/tokens issues mmm_… secrets that are hashed at rest, carry explicit scopes (a subset of the holder’s permissions) and optional expiry. Bearer callers skip CSRF. Revocation is immediate.\n' +
      'Lockout: 5 failed logins within 5 minutes lock that email for 15 minutes; 20 attempts per address per 5 minutes are throttled. Attempts are persisted in auth_attempts and audited.\n' +
      'Bootstrap: the first start creates an Owner from MMM_BOOTSTRAP_EMAIL / MMM_BOOTSTRAP_PASSWORD, or (in development) prints a generated password once. Production refuses to start without an owner.\n' +
      'Not implemented: 2FA, SSO/OIDC, email password reset, per-object ACLs, and multi-node rate limiting.',
    sources: [
      { label: 'apps/gateway/src/auth.js', ref: 'apps/gateway/src/auth.js' },
      { label: 'apps/gateway/migrations/002_auth.sql', ref: 'apps/gateway/migrations/002_auth.sql' },
      { label: 'scripts/gateway-auth-test.mjs — 28 acceptance checks', ref: 'scripts/gateway-auth-test.mjs' },
    ],
  },
  {
    id: 'gateway.roles',
    title: 'RBAC roles, permissions and separation of duties',
    type: 'reference',
    module: 'governance',
    tags: ['rbac', 'roles', 'permissions', 'owner', 'admin', 'operator', 'reviewer', 'observer', 'approval', 'separation'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-27',
    sensitivity: 'internal',
    body:
      'Five roles: Owner > Admin > Operator / Reviewer > Observer. They are deliberately not a single ladder: an Operator runs agents, tasks and swarms but cannot decide approval gates; a Reviewer decides gates and reads the audit trail but cannot run agents.\n' +
      'Owner: everything, including seeding demo data and principal administration. Admin: operations + review + principal/token administration, but cannot create or modify an Owner. Operator: read + agent/task/swarm writes + request approvals. Reviewer: read + decide approvals + read/verify the audit log. Observer: read-only.\n' +
      'Guards: nobody can change their own role or status; a token’s scopes can never exceed the holder’s role; role or status changes revoke that principal’s sessions immediately; separation of duties blocks a principal from deciding a gate they requested; only user/bot principals may decide gates, never copilot or agent principals.\n' +
      'Every denial is written to the hash-chained audit log with actor, role, route and permission. GET /api/v1/roles returns the live matrix.',
    sources: [
      { label: 'apps/gateway/src/rbac.js', ref: 'apps/gateway/src/rbac.js' },
      { label: 'apps/gateway/server.js — route permission map', ref: 'apps/gateway/server.js' },
      { label: 'docs/copilot/copilot-governance-auth.md', ref: 'docs/copilot/copilot-governance-auth.md' },
    ],
  },
  {
    id: 'gateway.audit',
    title: 'Audit chain',
    type: 'reference',
    module: 'governance',
    tags: ['audit', 'hash', 'chain', 'verify', 'evidence'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-26',
    sensitivity: 'internal',
    body:
      'The gateway writes an append-only audit_log whose rows are hash-chained. Verify integrity with `npm run audit:verify` (calls verifyAuditChain from the db module) or GET /api/v1/audit/verify.\n' +
      'This chain covers gateway mutations only. Copilot actions taken in the browser demo store are recorded in Copilot episodic memory, not the hash chain.',
    sources: [
      { label: 'apps/gateway/src/db.js — audit', ref: 'apps/gateway/src/db.js' },
      { label: 'package.json — audit:verify', ref: 'package.json' },
    ],
  },
  {
    id: 'proc.agent.create',
    title: 'Procedure: create an agent',
    type: 'procedure',
    module: 'agents',
    tags: ['agent', 'create', 'procedure', 'preconditions', 'validation', 'evidence'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-26',
    sensitivity: 'public',
    body:
      '1. Preconditions: write access to the chosen scope; a model/provider already present in the catalogue; a name unique among agents.\n' +
      '2. Define: name, role/objective, framework adapter, primary model + fallback, tools/skills allowlist, memory policy, autonomy level, prompt.\n' +
      '3. Validate: name non-empty and unique; framework and model exist in the catalogue; autonomy within the workspace cap.\n' +
      '4. Propose and review — Copilot shows a reversible-risk card with the exact values; nothing is written until you confirm.\n' +
      '5. Evidence of success: the agent appears in the Agents list with status `idle` and a new event “Agent <name> created”. A created agent is not “running”.\n' +
      '6. Rollback: delete the agent (or discard the demo state by clearing site data / re-seeding fixtures).\n' +
      'In Copilot Operate/Build mode use: create agent <name> [as <role>].',
    sources: [
      { label: 'src/copilot/orchestrator.js — createAgent()', ref: 'src/copilot/orchestrator.js' },
      { label: 'src/views1.js — agent views', ref: 'src/views1.js' },
    ],
  },
  {
    id: 'ui.agent.designer',
    title: 'Agent Designer (agent creation module)',
    type: 'module',
    module: 'designer',
    tags: ['agent', 'designer', 'create', 'builder', 'validation', 'components', 'permissions', 'goal'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-27',
    sensitivity: 'public',
    body:
      'Five steps: Goal → Components → Configure → Validate → Activate (summary).\n' +
      'Goal: a sentence about what the agent should do, plus optional name/role and six starter templates. “Propose a configuration” is a deterministic keyword match on this device — no model is called — and every inferred choice is listed as an assumption.\n' +
      'Components: a dependency map of runtime, AI brain (primary + fallback), behaviour, memory, interaction, tools/connectors, knowledge, permissions/gates and storage. Each node shows compatibility and availability separately (spec §8.2). Optional nodes can be added or removed.\n' +
      'Configure: per-node controls (framework, model + fallback, preset + autonomy + limits, memory layers/scope/retention, interaction capabilities, skills and connectors, source files, derived scopes and gates, storage).\n' +
      'Validate: “Definition checks” (what the app can store) are separated from “Activation checks” (what running it would need). Errors block saving; warnings and setup items do not. Every finding names the missing dependency, its practical effect and a fix action.\n' +
      'Activate: summary rail (capabilities, permissions, budget, storage). “Save definition” writes an idle agent record (gateway when signed in, browser otherwise). “Activate & run” is unavailable and explains why.\n' +
      'Honest limits: no framework adapter, provider client, credential store, memory backend, tool executor, scheduler or artifact route exists in this repository, so nothing can be started. Voice/image interaction and the scheduled preset are disabled at selection time because they cannot work. Knowledge files are metadata only and are never indexed.\n' +
      'Shortcuts: Agents → Designer, the New-agent wizard footer, Quick create, and All modules.',
    sources: [
      { label: 'src/designer.js — builder, validation, save', ref: 'src/designer.js' },
      { label: 'src/designer.css — designer styles', ref: 'src/designer.css' },
      { label: 'docs/copilot/agent-designer.md — design + limits', ref: 'docs/copilot/agent-designer.md' },
    ],
  },
  {
    id: 'proc.swarm.deploy',
    title: 'Procedure: deploy a swarm',
    type: 'procedure',
    module: 'swarms',
    tags: ['swarm', 'deploy', 'team', 'procedure', 'budget', 'rollback'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-26',
    sensitivity: 'public',
    body:
      '1. Preconditions: a team with at least one agent; a budget cap; an objective written as an expected output.\n' +
      '2. Compose nodes (planner → workers → assembler) with dependencies; choose hierarchical or flat topology.\n' +
      '3. Check cost: cap × expected runtime, plus fallback-provider pricing.\n' +
      '4. This is a consequential action: review the card (objective, team, topology, budget, gate) and confirm twice. Approval is bound to those exact values; editing them re-arms review.\n' +
      '5. Evidence: a swarm node with status `live`, nodes transitioning queued → running → done, and event “Swarm deployed”.\n' +
      '6. Rollback: stop the swarm; budget already spent is not recoverable.\n' +
      'A swarm is a seeded plan with status “planned”. No scheduler, worker or agent executes it, nothing advances its progress, and no money is spent.',
    sources: [
      { label: 'src/copilot/orchestrator.js — deploySwarm()', ref: 'src/copilot/orchestrator.js' },
      { label: 'src/main.js — simulation', ref: 'src/main.js' },
    ],
  },
  {
    id: 'proc.approval',
    title: 'Procedure: resolve an approval gate',
    type: 'procedure',
    module: 'governance',
    tags: ['approval', 'gate', 'allow', 'deny', 'risk', 'self-approval'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-26',
    sensitivity: 'internal',
    body:
      '1. Read the gate: action, target, requesting principal, risk, evidence and expected effects.\n' +
      '2. Check the evidence is sufficient for the exact target — a diff for a deploy, a DDL statement for a migration.\n' +
      '3. Risk classes: read-only (no gate), reversible (confirm once), consequential (confirm twice + preview).\n' +
      '4. Decide allow-once or deny. Copilot never decides for you and cannot approve a request it raised itself.\n' +
      '5. Evidence: approval status becomes allowed/denied and an event records “<action> <status> by you via Copilot”.\n' +
      'Enforcement: the gateway re-checks approval:decide, applies separation of duties against the requester, and writes the decision to the hash-chained audit log. Without a gateway session the decision stays local and is labelled as unenforced.',
    sources: [
      { label: 'src/copilot/orchestrator.js — decideApproval()', ref: 'src/copilot/orchestrator.js' },
      { label: 'src/shell.js — notifications sheet', ref: 'src/shell.js' },
    ],
  },
  {
    id: 'proc.diagnose',
    title: 'Procedure: diagnose the app',
    type: 'procedure',
    module: 'ops',
    tags: ['diagnose', 'troubleshoot', 'offline', 'gateway', 'error', 'recovery', 'storage'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-26',
    sensitivity: 'internal',
    body:
      'Copilot runs real checks, never canned success:\n' +
      '• Browser connectivity — navigator.onLine.\n' +
      '• App store — presence, revision and size of mmm-state-v1 (missing key means fixtures are in use).\n' +
      '• Gateway — fetch <gateway>/healthz with a 1.5 s abort; reports reachable, unreachable or unknown.\n' +
      '• Pending approvals — counted from live store state.\n' +
      '• Service worker — checks registration where the browser exposes getRegistration.\n' +
      'Recovery: unreachable gateway is expected unless you run `npm run dev:gateway`; a stale or broken store can be reset by clearing site data (destroys demo edits).',
    sources: [
      { label: 'src/copilot/orchestrator.js — runDiagnostics()', ref: 'src/copilot/orchestrator.js' },
      { label: 'src/copilot/runtime.js — probeGateway()', ref: 'src/copilot/runtime.js' },
    ],
  },
  {
    id: 'files.artifacts',
    title: 'File Manager and artifacts',
    type: 'reference',
    module: 'files',
    tags: ['files', 'artifacts', 'dataset', 'upload', 'storage', 'folder'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-26',
    sensitivity: 'internal',
    body:
      'The Artifacts screen lists entries from state.files: path, type, size, createdBy, timestamp and inline text content. Text artifacts (md/csv/yaml/log) open in a viewer.\n' +
      'There is no binary upload, no object storage and no MIME sniffing; image entries carry a placeholder description only. Server artifacts live in the gateway artifact directory when the gateway is used.\n' +
      'Copilot treats file contents as untrusted input: they never become instructions or permissions.',
    sources: [
      { label: 'src/core.js — files seed', ref: 'src/core.js' },
      { label: 'src/views2.js — artifacts view', ref: 'src/views2.js' },
    ],
  },
  {
    id: 'training.methods',
    title: 'Training methods are not interchangeable',
    type: 'concept',
    module: 'training',
    tags: ['training', 'fine-tune', 'lora', 'inference', 'retrieval', 'rag', 'dataset', 'blocked'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-26',
    sensitivity: 'internal',
    body:
      'Inference only — use a model with its weights unchanged. Retrieval-augmented — fetch relevant data at task time; this is not training. Fine-tuning — update parameters with a training recipe. LoRA/adapters — parameter-efficient tuning. Full training — expensive and only with a backend that supports it. Task pipelines (vision/audio/voice) — only when model and data contract match.\n' +
      'Pointing a model at a folder is none of these. Training also requires a compatible method, dataset contract, compute runtime, validation and a saved output.\n' +
      'BLOCKED in this repo: there is no training worker, job queue, dataset decoder or model registry. Copilot reports that instead of showing simulated progress.',
    sources: [
      { label: 'docs/PROGRESS.md — Phase 4/5 ⬜', ref: 'docs/PROGRESS.md' },
      { label: 'src/copilot/capabilities.js — training capability', ref: 'src/copilot/capabilities.js' },
    ],
  },
  {
    id: 'training.dataset.check',
    title: 'What local dataset validation can and cannot do',
    type: 'limitation',
    module: 'training',
    tags: ['dataset', 'validation', 'files', 'audio', 'images', 'licence', 'duplicates'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-26',
    sensitivity: 'internal',
    body:
      'Available now: File Manager metadata counts, types, sizes, empty-file and duplicate-path checks; bounded JSONL object syntax inspection for up to ten inline text artifacts. This does not establish model-specific schema or content safety.\n' +
      'Not available without a backend: audio decode/duration/sample-rate checks, image decoding and dimension checks, corruption scans, exact-duplicate hashing, annotation schema validation, licence/consent verification, and any compute/time estimate that would be defensible.\n' +
      'Copilot labels each line as checked or unchecked so the checklist cannot be mistaken for a full audit.',
    sources: [
      { label: 'src/copilot/orchestrator.js — inspectDataset()', ref: 'src/copilot/orchestrator.js' },
      { label: 'src/core.js — state.files', ref: 'src/core.js' },
    ],
  },
  {
    id: 'voice.candidates',
    title: 'Voice engines and singing — unverified',
    type: 'limitation',
    module: 'voice',
    tags: ['voice', 'cloning', 'tts', 'singing', 'opennvoice', 'neutts', 'consent', 'licence', 'blocked'],
    status: 'unknown',
    version: PACK.version,
    updated: '2026-10-26',
    sensitivity: 'internal',
    body:
      'NeuTTS and OpenVoice upstream repositories were reviewed; NeuTTS Air is listed as Apache-2.0 and OpenVoice V1/V2 as MIT by their projects. Weight/dependency licensing and actual mobile/browser execution are not verified; neither engine is integrated here. Local TTS remains unidentified.\n' +
      'Voice cloning and text-to-speech do not imply singing. A request such as “now sing, could this be love” must either go through a verified singing-capable component or be reported unsupported — it is currently unsupported.\n' +
      'Any implementation needs a consent/ownership confirmation, protected voice profiles, deletion controls and synthetic-output labelling. There is no storage or engine for that yet.',
    sources: [
      { label: 'Master spec §8.1–8.4', ref: 'Copilot_Master_MMM_V2.md §8' },
      { label: 'src/copilot/capabilities.js — voice capability', ref: 'src/copilot/capabilities.js' },
    ],
  },
  {
    id: 'comms.channels',
    title: 'Communication channels — actual status',
    type: 'limitation',
    module: 'comms',
    tags: ['telegram', 'whatsapp', 'slack', 'discord', 'signal', 'imessage', 'channels', 'gateway'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-26',
    sensitivity: 'internal',
    body:
      'Comms has gateway-side Telegram, WhatsApp, Slack, Discord and Twilio request adapters and signature-gated inbound routes; tests use controlled mocks, not live providers.\n' +
      'Signal and iMessage have no adapters here. Provider availability and terms must be independently checked; the implemented provider adapters have not been verified against live accounts.\n' +
      'Inbound routes expose deterministic summaries and reject gated channel commands. Sender identity mapping, robust delivery controls and operation-bound approvals remain incomplete.',
    sources: [
      { label: 'src/views2.js — Telegram view', ref: 'src/views2.js' },
      { label: 'docs/PROGRESS.md — Phase 10 ⬜', ref: 'docs/PROGRESS.md' },
    ],
  },
  {
    id: 'comms.opensms',
    title: 'OpenSMS integration preconditions',
    type: 'limitation',
    module: 'comms',
    tags: ['opensms', 'sms', 'android', 'api-key', 'proxy', 'consent', 'blocked'],
    status: 'unknown',
    version: PACK.version,
    updated: '2026-10-26',
    sensitivity: 'internal',
    body:
      'The master spec records a source review of github.com/daslearning-org/OpenSMS (Apache-2.0, Kivy Android app, FastAPI service, POST /sms/ on port 9292, Bearer auth, Start/Stop Server owned by the app, an unauthenticated /control/ route that does not actually start or stop the server). That review could not be re-verified here.\n' +
      'Architecture: MMM V2 is a browser/PWA layer; it cannot inherit Python classes or Android runtime permissions. The only sound design is a thin typed adapter over the authenticated HTTP API, with OpenSMS remaining the authority for SMS permissions, API keys and server lifecycle.\n' +
      'Prerequisites before any send path: a server-side secret store + proxy (never the key in browser JS), verified reachability (an HTTPS-hosted PWA cannot safely call plain http:// on a LAN), recipient preview, approval policy, rate limits and audit. No remote start/stop will be offered until an authenticated least-privilege bridge is designed and tested on a device.',
    sources: [
      { label: 'Master spec §9.2 (vendor source review)', ref: 'Copilot_Master_MMM_V2.md §9.2' },
      { label: 'src/copilot/capabilities.js — opensms capability', ref: 'src/copilot/capabilities.js' },
    ],
  },
  {
    id: 'browser.control',
    title: 'Autonomous browsing runs on the gateway, with limits',
    type: 'concept',
    module: 'browser',
    tags: ['browser', 'stealth', 'automation', 'playwright', 'puppeteer', 'policy', 'evidence'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-29',
    sensitivity: 'internal',
    body:
      'The Agent Browser exists and runs in the gateway: the gateway owns the task, one action runs per tick, and a deadline, action/evidence budgets, a stall watchdog, loop detection, a bounded recovery ladder and checkpoints keep it bounded. "Completed" requires every success criterion to be verified; a CAPTCHA, 403, paywall or other refusal ends the task as blocked, and a login wall asks the operator to sign in.\n' +
      'The Chromium driver is optional: until puppeteer-core and a Chromium binary exist on the host the panel reports unconfigured and offers no start button. The scripted test driver is refused unless MMM_BROWSER_ALLOW_SIM=1 and every task it runs is labelled Simulated.\n' +
      'Policy: authorised automation only. There is no CAPTCHA solving, fingerprint or user-agent spoofing, credential extraction or access-control bypass, and no claim to be undetectable.',
    sources: [
      { label: 'docs/browser/AGENT_BROWSER.md', ref: 'docs/browser/AGENT_BROWSER.md' },
      { label: 'apps/gateway/src/browser/ — policy, watchdog, loops, runner', ref: 'apps/gateway/src/browser/' },
      { label: 'src/copilot/capabilities.js — browser capability', ref: 'src/copilot/capabilities.js' },
    ],
  },
  {
    id: 'evolution.selfmod',
    title: 'Self-modification is a capability, not a command',
    type: 'concept',
    module: 'evolution',
    tags: ['self-improvement', 'self-modification', 'evolution', 'autonomy', 'sandbox', 'rollback', 'audit', 'review'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-29',
    sensitivity: 'internal',
    body:
      'Every agent can inspect code it is authorised to read, diagnose a defect and propose the smallest change. What it may do is decided by the gateway from data the agent cannot write: a policy row with one of five autonomy levels (default L1 recommend), an authorised file scope, quotas and a health command.\n' +
      'The cycle is ten stages: observe, diagnose, plan, isolated copy, rewrite, test, peer review, compare, promote, monitor. A candidate lives under DATA_DIR/experiments/<id>/ — the gateway never writes the repository — and is tested in a sandbox with a rebuilt environment (no secrets), a command allowlist, a timeout and capped output. A different agent must review it; self-review and self-approval are refused; approving never deploys.\n' +
      'Permissions, authentication, RBAC, the audit layer, migrations, CI, package files, secrets and the safeguards themselves are protected: an agent may recommend a change there, never make one, at any level. Versions live under DATA_DIR/runtime/<agent>/<version>/, the last known-good version survives the experiment, and a rollback keeps the audit trail — it cannot reverse migrations or external side effects.\n' +
      'Honest limits: the sandbox is process isolation (no kernel network isolation) and says so; there is no model-driven patch author; reproduction is files plus manifest, not an image digest.',
    sources: [
      { label: 'docs/evolution/SELF_MODIFICATION.md', ref: 'docs/evolution/SELF_MODIFICATION.md' },
      { label: 'apps/gateway/src/evolution/policy.js — levels and protected paths', ref: 'apps/gateway/src/evolution/policy.js' },
      { label: 'docs/FEATURE_COMPLETION_ROADMAP.md — M23', ref: 'docs/FEATURE_COMPLETION_ROADMAP.md' },
    ],
  },
  {
    id: 'models.catalogue',
    title: 'Model gateway: one sealed key, one adapter, a metered ledger',
    type: 'reference',
    module: 'models',
    tags: ['model', 'provider', 'routing', 'fallback', 'llm', 'anthropic', 'openai', 'ollama', 'cost', 'budget', 'key'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-11-01',
    sensitivity: 'internal',
    body:
      'The Models screen is a real gateway since M29, over a 26-provider catalogue (frontier clouds, mid-tier clouds, local/self-hosted, specialised, enterprise). A provider is “configured” only when an Owner has sealed a key on the gateway; otherwise it is “unconfigured”, no key store, and no button that would pretend to try.\n' +
      'One OpenAI-compatible adapter: the gateway POSTs to {baseUrl}/chat/completions with the key in an Authorization header, never follows a redirect, applies a timeout and a 256 KB response cap, and refuses plain http off loopback. The key is sealed with AES-256-GCM (key material from MMM_SECRET or a 0600 file) and is never returned — a read gives a 16-hex fingerprint and a hint like ••••abcd.\n' +
      'Every attempt is written to the model_calls ledger as ok, blocked or error, with token counts, latency and an ESTIMATED cost from a price table (not an invoice). Spend is SUM(cost_usd) over ok rows only, so a refusal can never inflate it; the daily and per-call budgets are checked before the request leaves the process (HTTP 402 + a blocked row, provider contacted zero times). Prompts and replies are never stored — only reply_chars.\n' +
      'Not built: streaming (a long completion blocks), retries or fallback, and routing — the routing policies on the screen are notes labelled “not enforced”. Copilot is the first caller (M30): a conversation turn goes through this funnel with purpose “copilot”, and the reply is stored with the id of the call that produced it. Chat still calls nothing and says so.',
    sources: [
      { label: 'apps/gateway/src/models.js — the funnel and the ledger', ref: 'apps/gateway/src/models.js' },
      { label: 'apps/gateway/src/secrets.js — sealed key material', ref: 'apps/gateway/src/secrets.js' },
      { label: 'apps/gateway/migrations/010_model_calls.sql — ledger schema', ref: 'apps/gateway/migrations/010_model_calls.sql' },
      { label: 'src/views2.js — the screen reads the ledger', ref: 'src/views2.js' },
    ],
  },
  {
    id: 'copilot.conversation',
    title: 'Copilot conversations: a model when one is configured, the built-in engine when not',
    type: 'reference',
    module: 'copilot',
    tags: ['copilot', 'conversation', 'model', 'llm', 'chat', 'history', 'cost', 'transcript', 'memory'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-11-01',
    sensitivity: 'internal',
    body:
      'Two things decide who answers. Where the reply comes from is either a model or the built-in engine; what the gateway says is one of ready (a provider with a sealed key), unready (a gateway but no key), unavailable (a gateway with no Copilot route), error, or demo (no gateway at all). Only “ready” makes the conversation a model conversation.\n' +
      'With a model: a turn is stored on the gateway before the call, every reply carries the id of the model call that produced it with its token counts, latency and an estimated cost, the transcript survives a reload and is scoped to the signed-in principal, and the last 24 turns are sent as history so follow-ups work. With no model: answers come from this knowledge pack and live app state, the mode tabs stay, and every answer says on its own line that no model was called.\n' +
      'When the gateway has no model, nothing is sent anywhere — the conversation stays in this browser. When it has one but the call fails, the turn is marked failed with the server’s own reason and no answer is invented.\n' +
      'Artefacts: asking for an agent produces a DRAFT (M31) — a definition with a canonical state, validated on the gateway, which a Reviewer must approve before it can become an agent. Activation stores an idle definition; no runtime in this build can execute it. The draft can be opened in the Agent Designer, and saving there updates the same draft rather than creating a second agent.\n' +
      'Not built yet: streaming, tool calls, swarm-plan drafts and Agent Browser JSON from conversation. The Copilot can discuss those but cannot produce them, and the system brief states the limit rather than letting the model imply otherwise.',
    sources: [
      { label: 'apps/gateway/src/copilot.js — the turn, the refusal, the ledger join', ref: 'apps/gateway/src/copilot.js' },
      { label: 'src/copilot/conversation.js — the client conversation', ref: 'src/copilot/conversation.js' },
      { label: 'docs/copilot/conversation.md', ref: 'docs/copilot/conversation.md' },
    ],
  },
  {
    id: 'memory.layers',
    title: 'How Copilot memory works today',
    type: 'concept',
    module: 'copilot',
    tags: ['memory', 'context', 'episodic', 'preferences', 'draft', 'privacy', 'retention'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-26',
    sensitivity: 'internal',
    body:
      'Authoritative knowledge — the bundled, versioned knowledge pack behind Knowledge mode.\n' +
      'Working memory — current conversation, selected mode and unsent draft, restored when the panel reopens.\n' +
      'Episodic memory — one record per Copilot action (intent, outcome, evidence, references, timestamp), capped at 50 entries, shown in Activity mode.\n' +
      'Preferences — default mode and panel detail preference, per browser.\n' +
      'Not implemented: semantic memory, server-side procedural memory, cross-device continuity, and retention enforcement beyond the episode cap. Everything is scoped to this browser/workspace; nothing is shared with other users.\n' +
      'Secret-looking strings (API keys, bearer tokens, passwords) are redacted before anything is written.',
    sources: [
      { label: 'src/copilot/memory.js', ref: 'src/copilot/memory.js' },
      { label: 'src/copilot/orchestrator.js — episode recording', ref: 'src/copilot/orchestrator.js' },
    ],
  },
  {
    id: 'gov.risk-classes',
    title: 'Risk classes used by Copilot',
    type: 'concept',
    module: 'governance',
    tags: ['risk', 'governance', 'approval', 'confirm', 'consequential', 'policy'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-26',
    sensitivity: 'internal',
    body:
      'read-only — inspect, explain, search, diagnose. No card, no mutation.\n' +
      'reversible — create an agent/task, change theme, navigate. A confirm card is shown; the action is local and undoable.\n' +
      'consequential — deploy a swarm, resolve an approval gate, clear Copilot memory. Two-step confirmation with a preview of target, effects, permissions and rollback limits.\n' +
      'Every proposal shows its risk class, and expires five minutes after creation or when its parameters change materially (edit re-arms review).',
    sources: [
      { label: 'src/copilot/orchestrator.js — risk + proposal builder', ref: 'src/copilot/orchestrator.js' },
    ],
  },
  {
    id: 'gov.secrets',
    title: 'Secret handling rules',
    type: 'policy',
    module: 'governance',
    tags: ['secrets', 'keys', 'redaction', 'privacy', 'security', 'tokens'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-26',
    sensitivity: 'internal',
    body:
      'Never place API keys, bearer tokens, passwords, session cookies or private keys in the app store, Copilot memory, a knowledge entry, a URL, a log line or a card. Copilot redacts secret-like patterns before persisting anything and does not echo them back.\n' +
      'Gateway Comms encrypts channel credentials at rest and returns masked values; demo-mode credentials remain browser-local. OpenSMS still needs a dedicated secure server adapter and topology.',
    sources: [
      { label: 'src/copilot/memory.js — redact()', ref: 'src/copilot/memory.js' },
      { label: 'Master spec §11.2', ref: 'Copilot_Master_MMM_V2.md §11.2' },
    ],
  },
  {
    id: 'comms.gateways',
    title: 'Comms: communication gateways (Telegram, WhatsApp, Discord, Slack, SMS, Browser)',
    type: 'reference',
    module: 'comms',
    tags: ['comms', 'telegram', 'whatsapp', 'discord', 'slack', 'sms', 'browser', 'gateway', 'channel', 'inbox', 'webhook'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-27',
    sensitivity: 'public',
    body:
      'Comms (#/comms) owns every communication gateway: Telegram, WhatsApp Cloud API, Discord, Slack, SMS (Twilio; OpenSMS is not implemented) and Browser. Telegram is no longer a separate module — it is the first channel inside Comms.\n' +
      'Each channel has: connection credentials (masked on read, cleared verification on change), routing (Copilot replies plus which agents report there), a command surface (/status, /agents, /tasks, /ask, and gated /approve, /copilot), delivery and safety settings (signature scheme, rate limit, redaction), an inbound endpoint and a real “Send test”.\n' +
      'Status is honest: not_configured until every required outbound field exists; configured_unverified after saving; verified only when the provider accepted a live test. The Browser channel delivers into the in-app inbox and is the only one that works without credentials. Saving credentials never grants permissions and never claims a bot is polling.\n' +
      'Copilot can inspect comms; gateway-mode Copilot channel mutations are blocked pending server-bound governance. Gateway inbound routes exist and require signatures; live provider delivery has not been verified here.',
    sources: [
      { label: 'src/comms.js', ref: 'src/comms.js' },
      { label: 'src/commsChannels.js', ref: 'src/commsChannels.js' },
      { label: 'src/commsAdapters.js', ref: 'src/commsAdapters.js' },
      { label: 'docs/comms/channels.md', ref: 'docs/comms/channels.md' },
    ],
  },
  {
    id: 'skills.import',
    title: 'Importing skills (formats, scanning, quarantine)',
    type: 'howto',
    module: 'skills',
    tags: ['skills', 'import', 'importing', 'skill.md', 'manifest', 'yaml', 'zip', 'package', 'quarantine', 'scan'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-27',
    sensitivity: 'public',
    body:
      'Skills Hub → Import (next to New) accepts: SKILL.md with YAML frontmatter, skill.json manifests, registry JSON ' +
      '(array or {"skills":[...]}), skill.yaml, MMM portable packages (schema mmm.skill.package.v1) and .zip/.skill ' +
      'bundles that may contain several skills.\n' +
      'Every package goes through: parse → schema check → quarantine → scan → dependency resolution → permission review → ' +
      'preview → install or reject → audit log. The scan blocks embedded API keys, private keys, instruction-injection text, ' +
      'piped shell downloads, zip path traversal and oversize bodies; it warns about external hosts, undeclared execution text, ' +
      'missing dependencies, duplicate/older versions and missing licences.\n' +
      'Installed skills land as pending (quarantined) and must be approved in Skills → Imported. An import NEVER grants a tool ' +
      'or permission and never makes a skill executable — there is no skills runtime on the gateway.',
    sources: [
      { label: 'MMMV2 skills interoperability spec §7', ref: 'MMMV2_skills_interoperability_design_spec_no_client_server_2026-10-23.md' },
      { label: 'src/skillsImport.js', ref: 'src/skillsImport.js' },
    ],
  },
  {
    id: 'skills.matrix',
    title: 'Skills Matrix: typed relationships and the graph',
    type: 'howto',
    module: 'skills',
    tags: ['skills', 'matrix', 'graph', 'relationships', 'depends_on', 'complements', 'conflicts', 'cycle', 'network'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-27',
    sensitivity: 'public',
    body:
      'The Skills Matrix (#/matrix) shows how skills relate. Open it from the graph icon next to Import in the Skills Hub, ' +
      'from any skill drawer, or from the sidebar.\n' +
      'Eight typed relationships: depends_on, complements, inherits_from, composes_with, triggers, conflicts_with, supersedes, ' +
      'related_to. Each has its own line style and a legend; the table under the graph is the accessible equivalent.\n' +
      'Valid links save with a version bump and are undoable; self-links, duplicates and cycles in ordered types are rejected. ' +
      'Links are configuration only: the matrix has no runtime telemetry, so it reports “not instrumented” rather than ' +
      'animating invented execution.',
    sources: [
      { label: 'MMMV2 skills interoperability spec §6', ref: 'MMMV2_skills_interoperability_design_spec_no_client_server_2026-10-23.md' },
      { label: 'src/skillsMatrix.js', ref: 'src/skillsMatrix.js' },
    ],
  },
  {
    id: 'roadmap.status',
    title: 'What is actually built vs planned',
    type: 'reference',
    module: 'product',
    tags: ['roadmap', 'progress', 'status', 'planned', 'implemented', 'gap'],
    status: 'verified',
    version: PACK.version,
    updated: '2026-10-26',
    sensitivity: 'public',
    body:
      'Built: PWA shell and 13 module views, demo state + fixtures, SQLite schema/migrations, gateway API with WebSocket broadcast and hash-chained audit, gateway authentication + RBAC (sessions, scoped tokens, lockout, separation of duties), sign-in UI and an API client, terminal, four test suites, design/progress docs, and the Copilot FAB + panel + modes + knowledge + memory + capability reporting.\n' +
      'Not built: real LLM calls, agent execution, swarm scheduling, skills runtime, MCP integrations, complete API-backed data sync (agents, tasks, approvals, events and comms are wired; other slices are demo), training, voice, OpenSMS, browser control, analytics from real telemetry.\n' +
      'Source of truth for the tracker is docs/PROGRESS.md; this entry summarises it and should be re-verified when that file changes.',
    sources: [
      { label: 'docs/PROGRESS.md', ref: 'docs/PROGRESS.md' },
      { label: 'docs/IMPLEMENTATION_CHECKLIST.md', ref: 'docs/IMPLEMENTATION_CHECKLIST.md' },
    ],
  },
];

const STOP = new Set(
  ('a an the is are was were be been do does did can could should would will shall may might must ' +
    'i you we they it this that these those to of for on in at by with from as and or not no yes ' +
    'how what why when where who which whom whose about into over under than then there here ' +
    'me my our your their its please show tell give').split(' ')
);

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9.+#_-]+/)
    .map((t) => t.replace(/^[._-]+|[._-]+$/g, ''))
    .filter((t) => t.length > 1 && !STOP.has(t));
}

const FIELD_WEIGHTS = [
  ['title', 6],
  ['id', 5],
  ['tags', 4],
  ['module', 3],
  ['type', 2],
  ['body', 1],
];

function score(entry, tokens) {
  let total = 0;
  const hay = {
    title: entry.title.toLowerCase(),
    id: entry.id.toLowerCase(),
    tags: entry.tags.join(' ').toLowerCase(),
    module: entry.module.toLowerCase(),
    type: entry.type.toLowerCase(),
    body: entry.body.toLowerCase(),
  };
  for (const token of tokens) {
    let hit = false;
    for (const [field, weight] of FIELD_WEIGHTS) {
      const value = hay[field];
      if (!value) continue;
      if (value === token) {
        total += weight * 2;
        hit = true;
      } else if (value.includes(token)) {
        total += weight;
        hit = true;
      }
    }
    if (hit) total += 1;
  }
  // require the strongest token to actually match, otherwise everything scores noise
  return total;
}

function snippet(body, tokens, max = 190) {
  const lower = body.toLowerCase();
  let idx = -1;
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i >= 0 && (idx < 0 || i < idx)) idx = i;
  }
  if (idx < 0) return body.slice(0, max) + (body.length > max ? '…' : '');
  const start = Math.max(0, idx - 60);
  const slice = body.slice(start, start + max);
  return (start > 0 ? '…' : '') + slice + (start + max < body.length ? '…' : '');
}

/**
 * Hybrid-ish retrieval: deterministic keyword scoring with field weights, module boost and
 * metadata filters. No vector store exists in this repo, so none is claimed.
 */
export function searchKnowledge(query, { module: moduleFilter, limit = 5 } = {}) {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const scored = [];
  for (const entry of KNOWLEDGE) {
    if (moduleFilter && entry.module !== moduleFilter) continue;
    const s = score(entry, tokens);
    if (s <= 0) continue;
    // coverage guard: at least one token must hit title/tags/module, not only body prose
    const meta = `${entry.title} ${entry.tags.join(' ')} ${entry.module} ${entry.id}`.toLowerCase();
    if (!tokens.some((t) => meta.includes(t))) continue;
    scored.push({ entry, score: s });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title));
  return scored.slice(0, limit).map(({ entry, score: s }) => ({
    id: entry.id,
    title: entry.title,
    module: entry.module,
    type: entry.type,
    status: entry.status,
    updated: entry.updated,
    version: entry.version,
    body: entry.body,
    excerpt: snippet(entry.body, tokens),
    sources: entry.sources,
    score: s,
  }));
}

export function getEntry(id) {
  return KNOWLEDGE.find((e) => e.id === id) || null;
}

export function knowledgeStats() {
  const byStatus = KNOWLEDGE.reduce((acc, e) => {
    acc[e.status] = (acc[e.status] || 0) + 1;
    return acc;
  }, {});
  const sources = new Set();
  KNOWLEDGE.forEach((e) => e.sources.forEach((s) => sources.add(s.ref)));
  return { total: KNOWLEDGE.length, byStatus, sources: sources.size, version: PACK.version, built: PACK.built };
}

/** Live, non-knowledge context: the screen the user is on right now. */
export function describeScreen(route) {
  const s = getState();
  const map = {
    home: () =>
      `Command Deck. ${s.agents.filter((a) => a.status === 'running').length} of ${s.agents.length} agents report running, ${s.swarms.filter((w) => w.status === 'live').length} swarm(s) live, ${s.approvals.filter((a) => a.status === 'pending').length} approval(s) pending.`,
    agents: () => `Agent Manager: ${s.agents.length} agents (${s.agents.map((a) => a.name).join(', ')}).`,
    teams: () => `Teams & Swarms: ${s.teams.length} teams, ${s.swarms.length} swarm instances.`,
    tasks: () => {
      const counts = ['todo', 'doing', 'review', 'done'].map((c) => `${c} ${s.tasks.filter((t) => t.column === c).length}`).join(', ');
      const ids = new Set(s.tasks.map((t) => t.id));
      const edges = s.tasks.reduce((n, t) => n + (t.deps || []).filter((d) => ids.has(d)).length, 0);
      const blocked = s.tasks.filter((t) => (t.deps || []).some((d) => s.tasks.find((x) => x.id === d)?.column !== 'done'));
      const prefs = s.board || {};
      const zoom = Math.round((prefs.zoom || 1) * 100);
      const wires = prefs.wires === true ? 'on' : prefs.wires === false ? 'off' : 'auto';
      return `Kanban: ${s.tasks.length} cards (${counts}). ${edges} dependency link(s), ${blocked.length} card(s) waiting on an unfinished blocker${blocked.length ? ` (${blocked.slice(0, 3).map((t) => `“${t.title}”`).join(', ')})` : ''}. Zoom ${zoom}%, wires ${wires}. Moves, assignments, priorities, renames, dependency links and deletes all go through src/kanban.js, and every move asks for confirmation first.`;
    },
    chat: () => `Chat: ${s.threads.length} threads (${s.threads.map((t) => t.title).join(', ')}).`,
    skills: () => `Skills Hub: ${s.skills.length} skills (${s.skills.filter((k) => k.installed !== false).length} installed, ${s.skills.filter((k) => k.origin === 'marketplace').length} in the marketplace, ${s.skills.filter((k) => k.status === 'pending').length} awaiting review), ${(s.relations || []).length} typed relationships. Import (next to New) accepts SKILL.md, manifests, registries, YAML, packages and zip bundles; installed imports stay quarantined until approved and never grant tools.`,
    matrix: () => `Skills Matrix: ${s.skills.length} skills, ${(s.relations || []).length} typed links, version v${s.matrixVersion || 1}. Relationships are configuration only — no runtime events exist, so nothing is shown as executed.`,
    models: () => {
      const configured = (s.providers || []).filter((p) => p.status === 'configured' || p.status === 'on').length;
      const spend = s.provenance?.providers === 'gateway' ? 'the ledger' : 'no ledger (demo)';
      return `Model gateway: ${s.providers.length} providers, ${configured} configured, ${s.policies.length} routing policies that are not enforced. Spend comes from ${spend}.`;
    },
    plugins: () => `Plugin Marketplace: MCP servers and tool plugins.`,
    telegram: () => `Telegram Bridge: now part of Comms (#/comms) as the Telegram channel — the bridge opens the channel settings; no bot transport is running.`,
    local: () => 'Local AI: on-device GGUF preflight. No model is bundled or downloaded and no inference runs on this screen. A separate experimental local-runtime spike accepts a user-provided model; mobile-device validation and the production feature remain unfinished, with no cloud fallback.',
    comms: () => {
      const comms = s.comms || {};
      const chans = Object.entries(comms.channels || {});
      const verified = chans.filter(([, r]) => r.verifiedAt).length;
      const enabled = chans.filter(([, r]) => r.enabled).length;
      return `Comms: ${chans.length} gateways, ${enabled} enabled, ${verified} verified by a live test. Browser inbox: ${(comms.inbox || []).length} message(s). Cloud channels need credentials and outbound network; nothing is claimed delivered until the provider accepts it.`;
    },
    analytics: () => `Analytics: spend, usage and agent leaderboard from demo data.`,
    artifacts: () => `Artifacts & Files: ${s.files.length} entries, ${(s.files.reduce((a, f) => a + f.size, 0) / 1024).toFixed(0)} KB of metadata.`,
    terminal: () => `Terminal: local command shell; it can hand prompts to Copilot.`,
    settings: () => `Settings: theme, density, autonomy level, Copilot mode and memory toggles.`,
    designer: () => {
      const d = getDesignerSummary();
      if (!d.started) return 'Agent Designer: no draft yet. Open it from Agents → Designer, Quick create or All modules.';
      return `Agent Designer: draft “${d.name || 'untitled'}” (${d.framework}, ${d.model}) on step ${d.step + 1}. Definition checks: ${d.definition}; activation: ${d.activation}. ${d.canSave ? 'The definition can be saved' : 'Blocking definition errors remain'} — saving writes an idle definition only, because no runtime exists to start it.`;
    },
  };
  return (map[route] || (() => `Module “${route}”.`))();
}
