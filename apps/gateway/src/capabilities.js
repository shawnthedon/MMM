/* ============ Copilot capability catalogue ============
 * The one server-side answer to "what can Copilot do on this gateway, for this person, right now?"
 * Phase B, steps 1–3 of the Operator Extension (docs/copilot/PHASE_A_INVENTORY.md §9).
 *
 * Why this file exists
 * --------------------
 * Phase A found three partial, disagreeing answers: a static client table (9 of 10 statuses hard-coded),
 * the client orchestrator's advertised command list, and prose in the model's system prompt. None was
 * derived from anything the server actually serves, so none could be trusted or enforced.
 *
 * Declared by hand, derived at read time
 * --------------------------------------
 * Declared: identity, permission, risk, reversibility, confirmation, audit, timeout, runtime needs. These
 * cannot be introspected — a route cannot tell you that deleting an agent is destructive, or that a screen
 * has no service at all.
 *
 * Derived: whether the route exists (a drift check against the live table), whether each runtime
 * requirement is met (a real probe of the module that owns it), and whether the signed-in principal holds
 * the permission.
 *
 * Two axes, kept apart on purpose
 * ------------------------------
 * `state`  is a fact about the deployment: can this gateway do it at all, and what is missing if not.
 * `allowed` is a fact about the caller: does this principal hold the permission.
 *
 * They are separate because a refusal must not hide a capability ("this exists, you cannot use it") and a
 * capability must not outrun authority ("the key is sealed, but you are an Observer"). An operation is
 * never `available` unless a route serves it and every requirement is met; every other state carries a
 * sentence saying what is missing.
 *
 * Two fields that are easy to confuse, so they are defined once:
 *   • `kind`  — the route class: 'read' for GET, 'mutation' for everything else. It must agree with the
 *               route table's `mutating` flag, and the drift check enforces that.
 *   • `risk`  — the effect on state, money or people: read-only → reversible → consequential → destructive.
 *               A POST that only computes a diff is `kind: 'mutation'` with `risk: 'read-only'`.
 */
import { can } from './rbac.js';
import * as models from './models.js';
import * as voice from './voice.js';
import { browserCapability } from './browser/index.js';
import { evolution } from './evolution/index.js';

/* =========================================================================================
 * 1. Vocabulary — one enum, seven states (approved in Phase A §6.3)
 * =======================================================================================*/

export const STATES = Object.freeze({
  available: {
    label: 'available',
    tone: 'ok',
    definition: 'A real service serves it and every runtime requirement is met. Whether *you* may use it is reported separately as `allowed`, so a refusal never hides a capability.',
  },
  degraded: {
    label: 'degraded',
    tone: 'warn',
    definition: 'A real service serves it, but a dependency is failing right now, so it may refuse or fail.',
  },
  unconfigured: {
    label: 'not configured',
    tone: 'warn',
    definition: 'The operation exists, but an operator prerequisite (a sealed key, a browser engine, a speech host) is missing.',
  },
  unverified: {
    label: 'unverified',
    tone: 'warn',
    definition: 'Implemented and wired, but never exercised against its real dependency on this deployment.',
  },
  demo: {
    label: 'demo',
    tone: 'info',
    definition: 'No backend; the screen shows seeded fixtures and says so.',
  },
  blocked: {
    label: 'blocked',
    tone: 'bad',
    definition: 'Cannot work yet: the runtime, service or model it needs does not exist in this build.',
  },
  'no-service': {
    label: 'no service',
    tone: 'info',
    definition: 'No endpoint and no fixture. The operation is a documented intention, not a capability.',
  },
});

export const STATE_IDS = Object.freeze(Object.keys(STATES));
export const RISKS = Object.freeze(['read-only', 'reversible', 'consequential', 'destructive']);
export const CONFIRMATIONS = Object.freeze(['none', 'confirm', 'approval']);

/* =========================================================================================
 * 2. Runtime requirements — every one is a probe of the module that owns the fact
 * =======================================================================================*/

const REQUIREMENTS = {
  'provider-key': {
    label: 'a provider key sealed by an Owner',
    why: 'No model is called without a sealed key, and a refusal is reported rather than faked.',
    async probe() {
      const rt = models.runtimeStatus();
      return { met: rt.configuredCount > 0, detail: `${rt.configuredCount} of ${rt.providerCount} providers configured` };
    },
  },
  chromium: {
    label: 'a browser engine on the gateway host',
    why: 'The Agent Browser drives real Chromium; the simulated driver is test-only.',
    async probe() {
      const cap = await browserCapability();
      return {
        met: Boolean(cap.engine),
        detail: cap.engine ? `engine ${cap.engine.id} is available` : 'no engine is available (puppeteer-core is not installed)',
      };
    },
  },
  'speech-host': {
    label: 'a local speech host configured on the gateway',
    why: 'Transcription runs on an operator-supplied open-source server; the browser recogniser is a separate, opt-in path.',
    async probe() {
      const cap = voice.capabilities();
      return { met: Boolean(cap.localStt), detail: cap.localStt ? 'a local STT endpoint is enabled' : 'no local STT endpoint is enabled' };
    },
  },
  'evolution-policy': {
    label: 'an evolution policy on every agent',
    why: 'A per-agent level gates which self-modification actions are allowed.',
    async probe() {
      const cap = evolution.capabilities();
      return { met: cap.status === 'available', detail: `${cap.agents.withPolicy} of ${cap.agents.total} agents have a policy` };
    },
  },
};

export const REQUIREMENT_IDS = Object.freeze(Object.keys(REQUIREMENTS));

/* =========================================================================================
 * 3. Declaring an operation
 * =======================================================================================*/

const isGet = (route) => String(route).startsWith('GET ');

/**
 * Freeze one declaration, filling the defaults and refusing anything inconsistent at load time — so a
 * mistake is a startup error, not a capability that quietly lies.
 */
function op(spec) {
  if (!spec.id || !spec.module || !spec.label || !spec.description) {
    throw new Error(`capability ${spec.id || '(no id)'}: id, module, label and description are required`);
  }
  if (!Array.isArray(spec.routes)) throw new Error(`${spec.id}: routes must be an array`);
  if (spec.routes.length) {
    const gets = spec.routes.filter(isGet).length;
    if (gets !== 0 && gets !== spec.routes.length) {
      throw new Error(
        `${spec.id}: routes mix reads and mutations (${spec.routes.join(', ')}). ` +
          'Split them into two operations — a dispatcher acts on one kind at a time.'
      );
    }
  }
  const kind = spec.routes.length ? (isGet(spec.routes[0]) ? 'read' : 'mutation') : (spec.kind || 'mutation');
  const risk = spec.risk || (kind === 'read' ? 'read-only' : 'reversible');
  const confirmation = spec.confirmation || (kind === 'read' ? 'none' : 'confirm');
  if (!RISKS.includes(risk)) throw new Error(`${spec.id}: unknown risk “${risk}”`);
  if (!CONFIRMATIONS.includes(confirmation)) throw new Error(`${spec.id}: unknown confirmation “${confirmation}”`);
  if (risk === 'destructive' && confirmation !== 'approval') {
    throw new Error(`${spec.id}: a destructive operation needs an approval gate, not “${confirmation}”`);
  }
  if (kind === 'read' && (risk !== 'read-only' || confirmation !== 'none')) {
    throw new Error(`${spec.id}: a read must be read-only and need no confirmation`);
  }

  return Object.freeze({
    kind,
    risk,
    confirmation,
    reversible: spec.reversible !== undefined ? spec.reversible : kind !== 'read',
    idempotent: Boolean(spec.idempotent),
    audit: spec.audit || (kind === 'read' ? 'none' : 'per-request'),
    timeoutMs: spec.timeoutMs === undefined ? (kind === 'read' ? 10000 : 15000) : spec.timeoutMs,
    requires: Object.freeze(spec.requires || []),
    unverified: spec.unverified || '',
    note: spec.note || '',
    ...spec,
    kind,
    risk,
    confirmation,
    routes: Object.freeze([...spec.routes]),
  });
}

/** An operation the application documents but does not serve. Declared so Copilot can refuse it by name. */
function noService(spec) {
  return op({ ...spec, routes: [], kind: spec.kind || 'mutation', risk: spec.risk || 'reversible', confirmation: 'none', reversible: false });
}

/* =========================================================================================
 * 4. The declarations
 * =======================================================================================*/

const PLATFORM = [
  op({
    id: 'system.health',
    module: 'runtime',
    label: 'Read gateway health',
    description: 'Liveness, storage driver and auth mode. Public: it returns no workspace data.',
    routes: ['GET /healthz'],
    permission: 'public',
    timeoutMs: 5000,
  }),
  op({
    id: 'system.capabilities',
    module: 'copilot',
    label: 'Read the capability catalogue',
    description: 'This catalogue: every operation, its permission, risk, state and the reason for that state.',
    routes: ['GET /api/v1/capabilities', 'GET /api/v1/capabilities/*'],
    permission: 'read',
  }),
  op({
    id: 'system.roles',
    module: 'governance',
    label: 'Read the role matrix',
    description: 'The five roles and the permissions each one holds.',
    routes: ['GET /api/v1/roles'],
    permission: 'read',
  }),
  op({
    id: 'summary.read',
    module: 'runtime',
    label: 'Read the workspace summary',
    description: 'Counts of agents, tasks, approvals and pending work.',
    routes: ['GET /api/v1/summary'],
    permission: 'summary:read',
  }),
  op({
    id: 'events.read',
    module: 'governance',
    label: 'Read the event feed',
    description: 'The activity feed, newest first, with a cursor.',
    routes: ['GET /api/v1/events'],
    permission: 'event:read',
  }),
  op({
    id: 'audit.read',
    module: 'governance',
    label: 'Read the audit log',
    description: 'Hash-chained entries: who did what, to which entity, allowed or denied.',
    routes: ['GET /api/v1/audit'],
    permission: 'audit:read',
  }),
  op({
    id: 'audit.verify',
    module: 'governance',
    label: 'Verify the audit chain',
    description: 'Recomputes the hash chain and reports whether any entry was altered.',
    routes: ['GET /api/v1/audit/verify'],
    permission: 'audit:verify',
  }),
];

const IDENTITY = [
  op({
    id: 'principals.list',
    module: 'governance',
    label: 'List principals',
    description: 'People and service identities with their roles.',
    routes: ['GET /api/v1/principals'],
    permission: 'principal:read',
  }),
  op({
    id: 'principals.create',
    module: 'governance',
    label: 'Create a principal',
    description: 'Adds a person or service identity with a role. Audited.',
    routes: ['POST /api/v1/principals'],
    permission: 'principal:write',
    risk: 'consequential',
  }),
  op({
    id: 'principals.update',
    module: 'governance',
    label: 'Update a principal',
    description: 'Changes a name, role or status. A role change is audited and cannot exceed your own rank.',
    routes: ['PATCH /api/v1/principals/*'],
    permission: 'principal:write',
    risk: 'consequential',
  }),
  op({
    id: 'tokens.list',
    module: 'governance',
    label: 'List API tokens',
    description: 'Scoped bearer tokens, hashed at rest; the secret is shown once, on issue.',
    routes: ['GET /api/v1/tokens'],
    permission: 'token:issue',
  }),
  op({
    id: 'tokens.issue',
    module: 'governance',
    label: 'Issue an API token',
    description: 'Creates a scoped token for CLI or integration use.',
    routes: ['POST /api/v1/tokens'],
    permission: 'token:issue',
    risk: 'consequential',
  }),
  op({
    id: 'tokens.revoke',
    module: 'governance',
    label: 'Revoke an API token',
    description: 'Revokes a token immediately; requests using it fail closed on the next call.',
    routes: ['DELETE /api/v1/tokens/*'],
    permission: 'token:issue',
    risk: 'destructive',
    confirmation: 'approval',
    reversible: false,
  }),
];

const AGENTS = [
  op({
    id: 'agents.list',
    module: 'agents',
    label: 'List agents',
    description: 'Agent definitions with team, model routing and status. Numbers that were never measured are not invented.',
    routes: ['GET /api/v1/agents'],
    permission: 'read',
  }),
  op({
    id: 'agents.get',
    module: 'agents',
    label: 'Read one agent',
    description: 'A single agent definition by id.',
    routes: ['GET /api/v1/agents/*'],
    permission: 'read',
  }),
  op({
    id: 'agents.create',
    module: 'agents',
    label: 'Create an agent definition',
    description:
      'Stores an agent definition with status idle. Nothing is deployed, scheduled or started — there is no agent runtime in this build.',
    routes: ['POST /api/v1/agents'],
    permission: 'agent:write',
  }),
  op({
    id: 'agents.update',
    module: 'agents',
    label: 'Update an agent definition',
    description: 'Edits an agent, including its team assignment. A status field is a label, not a process.',
    routes: ['PATCH /api/v1/agents/*'],
    permission: 'agent:write',
  }),
  op({
    id: 'agents.delete',
    module: 'agents',
    label: 'Delete an agent',
    description: 'Removes the definition. Audit history and experiments are kept; task assignment stops working.',
    routes: ['DELETE /api/v1/agents/*'],
    permission: 'agent:write',
    risk: 'destructive',
    confirmation: 'approval',
    reversible: false,
  }),
];

const TEAMS = [
  op({ id: 'teams.list', module: 'teams', label: 'List teams', description: 'Teams and their member order.', routes: ['GET /api/v1/teams'], permission: 'read' }),
  op({ id: 'teams.get', module: 'teams', label: 'Read one team', description: 'A team with its members in position order.', routes: ['GET /api/v1/teams/*'], permission: 'read' }),
  op({ id: 'teams.create', module: 'teams', label: 'Create a team', description: 'Creates an empty team.', routes: ['POST /api/v1/teams'], permission: 'swarm:write' }),
  op({ id: 'teams.update', module: 'teams', label: 'Rename a team', description: 'Changes a team name or description.', routes: ['PATCH /api/v1/teams/*'], permission: 'swarm:write' }),
  op({
    id: 'teams.delete',
    module: 'teams',
    label: 'Delete a team',
    description: 'Deletes a team and unassigns its members, reporting how many were unassigned.',
    routes: ['DELETE /api/v1/teams/*'],
    permission: 'swarm:write',
    risk: 'destructive',
    confirmation: 'approval',
    reversible: false,
  }),
  op({ id: 'teams.member.add', module: 'teams', label: 'Add a team member', description: 'Assigns an agent to a team at a position.', routes: ['POST /api/v1/teams/*/members'], permission: 'agent:write' }),
  op({ id: 'teams.member.remove', module: 'teams', label: 'Remove a team member', description: 'Unassigns an agent without deleting it.', routes: ['DELETE /api/v1/teams/*/members/*'], permission: 'agent:write' }),
  op({ id: 'teams.reorder', module: 'teams', label: 'Reorder a team', description: 'Rewrites member positions in one request.', routes: ['POST /api/v1/teams/*/order'], permission: 'agent:write', idempotent: true }),
];

const TASKS = [
  op({ id: 'tasks.list', module: 'tasks', label: 'List tasks', description: 'Kanban cards with column, assignee, priority and dependencies.', routes: ['GET /api/v1/tasks'], permission: 'read' }),
  op({ id: 'tasks.create', module: 'tasks', label: 'Create a task', description: 'Creates a card in a column.', routes: ['POST /api/v1/tasks'], permission: 'task:write' }),
  op({
    id: 'tasks.update',
    module: 'tasks',
    label: 'Update a task',
    description:
      'Moves a card, or changes its assignee, priority, title or description. Server-side dependencies do not exist; the board refuses rather than pretending.',
    routes: ['PATCH /api/v1/tasks/*'],
    permission: 'task:write',
  }),
];

const APPROVALS = [
  op({ id: 'approvals.list', module: 'governance', label: 'List approval gates', description: 'Pending and decided gates, newest first.', routes: ['GET /api/v1/approvals'], permission: 'approval:read' }),
  op({
    id: 'approvals.request',
    module: 'governance',
    label: 'Request an approval gate',
    description: 'Opens a gate for a consequential action. A gate is currently a record: only terminal.run is executed by a decision.',
    routes: ['POST /api/v1/approvals'],
    permission: 'approval:request',
  }),
  op({
    id: 'approvals.decide',
    module: 'governance',
    label: 'Allow or deny an approval gate',
    description: 'A governance decision by a second principal. Separation of duties: you cannot decide a gate you raised. Audited.',
    routes: ['POST /api/v1/approvals/*/*'],
    permission: 'approval:decide',
    risk: 'consequential',
    confirmation: 'none',
    note: 'The decision is the confirmation; a second card would be theatre.',
  }),
];

const SWARMS = [
  op({
    id: 'swarms.list',
    module: 'swarms',
    label: 'List swarm plans',
    description: 'Saved plans with status, budget cap and progress. Every plan is unexecuted: nothing schedules or runs one.',
    routes: ['GET /api/v1/swarms'],
    permission: 'read',
  }),
  op({ id: 'swarms.get', module: 'swarms', label: 'Read one swarm plan', description: 'A plan with its nodes and budget.', routes: ['GET /api/v1/swarms/*'], permission: 'read' }),
  op({
    id: 'swarms.create',
    module: 'swarms',
    label: 'Create a swarm plan',
    description: 'Saves a plan with status planned, zero progress and zero spend. It is an intention, not a run.',
    routes: ['POST /api/v1/swarms'],
    permission: 'swarm:write',
  }),
  op({ id: 'swarms.update', module: 'swarms', label: 'Edit a swarm plan', description: 'Edits a plan name, objective, budget cap or nodes.', routes: ['PATCH /api/v1/swarms/*'], permission: 'swarm:write' }),
  op({
    id: 'swarms.status',
    module: 'swarms',
    label: 'Change a swarm plan status',
    description: 'Moves a plan between planned, paused, cancelled and archived. A status that would claim a run is refused by the API.',
    routes: ['POST /api/v1/swarms/*/status'],
    permission: 'swarm:write',
  }),
  op({
    id: 'swarms.delete',
    module: 'swarms',
    label: 'Delete a swarm plan',
    description: 'Deletes a plan. Nothing was running, so nothing is stopped.',
    routes: ['DELETE /api/v1/swarms/*'],
    permission: 'swarm:write',
    risk: 'destructive',
    confirmation: 'approval',
    reversible: false,
  }),
];

const MODELS_OPS = [
  op({
    id: 'providers.list',
    module: 'models',
    label: 'List model providers',
    description: 'The provider catalogue with configuration state, a fingerprint and a masked hint — never a key.',
    routes: ['GET /api/v1/providers'],
    permission: 'model:read',
  }),
  op({ id: 'providers.get', module: 'models', label: 'Read one provider', description: 'One provider entry, keys sealed and masked.', routes: ['GET /api/v1/providers/*'], permission: 'model:read' }),
  op({
    id: 'providers.key.set',
    module: 'models',
    label: 'Seal a provider key',
    description: 'Stores a provider key encrypted (AES-256-GCM). The value is never returned; a fingerprint and a four-character hint are.',
    routes: ['PUT /api/v1/providers/*/key'],
    permission: 'model:key',
    risk: 'consequential',
    confirmation: 'none',
    note: 'Secrets are typed on the Models screen by an Owner, never into chat or a Copilot card.',
  }),
  op({
    id: 'providers.key.clear',
    module: 'models',
    label: 'Remove a provider key',
    description: 'Removes the sealed key, returning the provider to unconfigured. Calls are refused again.',
    routes: ['DELETE /api/v1/providers/*/key'],
    permission: 'model:key',
    risk: 'destructive',
    confirmation: 'approval',
    reversible: false,
  }),
  op({
    id: 'providers.call',
    module: 'models',
    label: 'Make a test model call',
    description: 'One real, metered request to the provider. Budget caps are enforced before egress; cost is estimated.',
    routes: ['POST /api/v1/providers/*/call'],
    permission: 'model:call',
    risk: 'consequential',
    requires: ['provider-key'],
  }),
  op({
    id: 'models.budget',
    module: 'models',
    label: 'Set budget caps',
    description: 'Daily and per-call caps, enforced before a request leaves the process.',
    routes: ['PUT /api/v1/budget'],
    permission: 'model:key',
    risk: 'consequential',
    idempotent: true,
  }),
  op({
    id: 'models.usage',
    module: 'models',
    label: 'Read usage',
    description: 'Cost and tokens per day from the model ledger. Estimated from a price table, not an invoice.',
    routes: ['GET /api/v1/usage'],
    permission: 'model:read',
  }),
  op({
    id: 'models.calls',
    module: 'models',
    label: 'Read the model call ledger',
    description: 'Every attempt with status, tokens, estimated cost and latency. Prompts and replies are never stored.',
    routes: ['GET /api/v1/model-calls'],
    permission: 'model:read',
  }),
];

const CHAT = [
  op({ id: 'chat.threads', module: 'chat', label: 'List chat threads', description: 'Threads with the last message and unread count.', routes: ['GET /api/v1/threads'], permission: 'chat:read' }),
  op({ id: 'chat.thread', module: 'chat', label: 'Read one chat thread', description: 'A thread with its messages.', routes: ['GET /api/v1/threads/*'], permission: 'chat:read' }),
  op({ id: 'chat.create', module: 'chat', label: 'Create a chat thread', description: 'Opens a new thread.', routes: ['POST /api/v1/threads'], permission: 'chat:write' }),
  op({
    id: 'chat.send',
    module: 'chat',
    label: 'Send a chat message',
    description: 'Stores a message; idempotent by clientId. Nothing answers: there is no model runtime on this path.',
    routes: ['POST /api/v1/threads/*/messages'],
    permission: 'chat:write',
    idempotent: true,
  }),
  op({ id: 'chat.read', module: 'chat', label: 'Mark a thread read', description: 'A read receipt, which is a write.', routes: ['POST /api/v1/threads/*/read'], permission: 'chat:write', idempotent: true }),
  op({
    id: 'chat.delete',
    module: 'chat',
    label: 'Delete a chat thread',
    description: 'Deletes a thread and its messages.',
    routes: ['DELETE /api/v1/threads/*'],
    permission: 'chat:write',
    risk: 'destructive',
    confirmation: 'approval',
    reversible: false,
  }),
];

const COPILOT = [
  op({ id: 'copilot.conversation', module: 'copilot', label: 'Read the Copilot conversation', description: 'The stored turns for this principal.', routes: ['GET /api/v1/copilot'], permission: 'copilot:read' }),
  op({
    id: 'copilot.runtime',
    module: 'copilot',
    label: 'Read the Copilot runtime',
    description: 'Whether a model can answer at all, which provider, and whether cost is estimated.',
    routes: ['GET /api/v1/copilot/runtime'],
    permission: 'copilot:read',
  }),
  op({
    id: 'copilot.model',
    module: 'copilot',
    label: 'Choose the Copilot model',
    description: 'Pins a provider and model for this deployment; “auto” uses the first configured provider.',
    routes: ['PUT /api/v1/copilot/model'],
    permission: 'copilot:model',
    risk: 'consequential',
    idempotent: true,
  }),
  op({
    id: 'copilot.send',
    module: 'copilot',
    label: 'Send a Copilot turn',
    description:
      'One metered model call through the gateway, stored and linked to its ledger row. No tools and no actions: the model can answer, not act.',
    routes: ['POST /api/v1/copilot/messages'],
    permission: 'copilot:write',
    risk: 'consequential',
    requires: ['provider-key'],
    idempotent: true,
  }),
  op({
    id: 'copilot.clear',
    module: 'copilot',
    label: 'Clear the Copilot conversation',
    description: 'Deletes this principal’s Copilot turns.',
    routes: ['DELETE /api/v1/copilot'],
    permission: 'copilot:write',
    risk: 'destructive',
    confirmation: 'approval',
    reversible: false,
  }),
];

const BROWSER = [
  op({
    id: 'browser.capabilities',
    module: 'browser',
    label: 'Read browser capability',
    description: 'Which drivers exist and whether a real engine is installed.',
    routes: ['GET /api/v1/browser/capabilities'],
    permission: 'browser:read',
  }),
  op({ id: 'browser.tasks', module: 'browser', label: 'List browser tasks', description: 'Browser tasks with status, driver and progress.', routes: ['GET /api/v1/browser/tasks'], permission: 'browser:read' }),
  op({ id: 'browser.task', module: 'browser', label: 'Read one browser task', description: 'A task with its steps and evidence references.', routes: ['GET /api/v1/browser/tasks/*'], permission: 'browser:read' }),
  op({ id: 'browser.evidence', module: 'browser', label: 'Read browser evidence', description: 'A screenshot or extract captured by a step.', routes: ['GET /api/v1/browser/tasks/*/evidence/*'], permission: 'browser:read' }),
  op({
    id: 'browser.start',
    module: 'browser',
    label: 'Start a browser task',
    description: 'Queues real automation with 8 actions: goto, wait, waitFor, click, type, extract, screenshot, assert.',
    routes: ['POST /api/v1/browser/tasks'],
    permission: 'browser:run',
    risk: 'consequential',
    requires: ['chromium'],
  }),
  op({
    id: 'browser.control',
    module: 'browser',
    label: 'Pause, resume, stop or assist a browser task',
    description: 'Intervenes in a running task; assist performs one step by hand.',
    routes: ['POST /api/v1/browser/tasks/*/*'],
    permission: 'browser:run',
    requires: ['chromium'],
    idempotent: true,
  }),
];

const TERMINAL = [
  op({
    id: 'terminal.policy',
    module: 'terminal',
    label: 'Read the terminal policy',
    description: 'Which executables are allowed, whether a shell exists, and the output and time limits.',
    routes: ['GET /api/v1/terminal'],
    permission: 'terminal:read',
  }),
  op({
    id: 'terminal.list',
    module: 'terminal',
    label: 'List terminal state',
    description: 'Workspaces, sessions, run history and saved scripts.',
    routes: [
      'GET /api/v1/terminal/workspaces',
      'GET /api/v1/terminal/sessions',
      'GET /api/v1/terminal/sessions/*',
      'GET /api/v1/terminal/history',
      'GET /api/v1/terminal/scripts',
    ],
    permission: 'terminal:read',
  }),
  op({
    id: 'terminal.run.read',
    module: 'terminal',
    label: 'Read a terminal run',
    description: 'Run metadata, captured output, or the live output stream.',
    routes: ['GET /api/v1/terminal/runs/*', 'GET /api/v1/terminal/runs/*/output', 'GET /api/v1/terminal/runs/*/stream'],
    permission: 'terminal:read',
  }),
  op({
    id: 'terminal.grants.list',
    module: 'terminal',
    label: 'List terminal grants',
    description: 'Which agents may run commands, and where.',
    routes: ['GET /api/v1/terminal/grants'],
    permission: 'terminal:read',
  }),
  op({
    id: 'terminal.session.create',
    module: 'terminal',
    label: 'Open a terminal session',
    description: 'Creates a workspace and a session with a persistent working directory.',
    routes: ['POST /api/v1/terminal/workspaces', 'POST /api/v1/terminal/sessions'],
    permission: 'terminal:run',
  }),
  op({
    id: 'terminal.session.configure',
    module: 'terminal',
    label: 'Change a session cwd or env',
    description: 'Sets the working directory or environment for later commands in a session.',
    routes: ['POST /api/v1/terminal/sessions/*/cwd', 'POST /api/v1/terminal/sessions/*/env'],
    permission: 'terminal:run',
    idempotent: true,
  }),
  op({
    id: 'terminal.exec',
    module: 'terminal',
    label: 'Run a command',
    description: 'Runs a real child process: node, npm or npx, never a shell. A destructive npm command opens an approval gate first.',
    routes: ['POST /api/v1/terminal/sessions/*/exec', 'POST /api/v1/terminal/agent-runs'],
    permission: 'terminal:run',
    risk: 'consequential',
    timeoutMs: 1800000,
  }),
  op({
    id: 'terminal.input',
    module: 'terminal',
    label: 'Write to a running process',
    description: 'Sends stdin to a run that is waiting for input.',
    routes: ['POST /api/v1/terminal/runs/*/input'],
    permission: 'terminal:run',
  }),
  op({
    id: 'terminal.signal',
    module: 'terminal',
    label: 'Signal a running process',
    description: 'Ctrl+C or a kill signal; the exit code is recorded.',
    routes: ['POST /api/v1/terminal/runs/*/signal'],
    permission: 'terminal:signal',
    risk: 'consequential',
  }),
  op({
    id: 'terminal.session.close',
    module: 'terminal',
    label: 'Close a terminal session',
    description: 'Ends a session; running children are terminated.',
    routes: ['DELETE /api/v1/terminal/sessions/*'],
    permission: 'terminal:run',
    risk: 'destructive',
    confirmation: 'approval',
    reversible: false,
  }),
  op({
    id: 'terminal.grant.add',
    module: 'terminal',
    label: 'Grant an agent terminal access',
    description: 'Lets an authorised agent run commands through the same path as a person.',
    routes: ['POST /api/v1/terminal/grants'],
    permission: 'terminal:grant',
    risk: 'consequential',
    confirmation: 'approval',
  }),
  op({
    id: 'terminal.grant.revoke',
    module: 'terminal',
    label: 'Revoke an agent terminal grant',
    description: 'Removes an agent’s ability to run commands.',
    routes: ['DELETE /api/v1/terminal/grants/*/*'],
    permission: 'terminal:grant',
    risk: 'destructive',
    confirmation: 'approval',
    reversible: false,
  }),
];

const COMMS = [
  op({ id: 'comms.list', module: 'comms', label: 'List comms channels', description: 'Channels with configuration state and masked credentials.', routes: ['GET /api/v1/comms'], permission: 'comms:read' }),
  op({ id: 'comms.messages', module: 'comms', label: 'Read comms messages and deliveries', description: 'Delivery rows with status, attempts and errors.', routes: ['GET /api/v1/comms/messages'], permission: 'comms:read' }),
  op({
    id: 'comms.configure',
    module: 'comms',
    label: 'Configure a comms channel',
    description: 'Stores credentials encrypted on the gateway and sets quiet hours, rate limits and routing.',
    routes: ['PUT /api/v1/comms/*', 'PUT /api/v1/comms/settings'],
    permission: 'comms:write',
    risk: 'consequential',
    unverified: 'No live provider has been exercised on this deployment; delivery is proven against a local stub only.',
  }),
  op({
    id: 'comms.channel.delete',
    module: 'comms',
    label: 'Remove a comms channel',
    description: 'Deletes a channel configuration and its encrypted credentials.',
    routes: ['DELETE /api/v1/comms/*'],
    permission: 'comms:write',
    risk: 'destructive',
    confirmation: 'approval',
    reversible: false,
    unverified: 'Not exercised against a live provider configuration.',
  }),
  op({
    id: 'comms.send',
    module: 'comms',
    label: 'Send a message to a channel',
    description: 'Delivers through the configured provider, or queues it. Redaction and idempotency apply.',
    routes: ['POST /api/v1/comms/*/send'],
    permission: 'comms:write',
    risk: 'consequential',
    unverified: 'Delivery to a real provider has never been exercised here; “accepted” is not “delivered”.',
  }),
  op({
    id: 'comms.queue',
    module: 'comms',
    label: 'Process the comms queue',
    description: 'Runs the retry queue once, honouring backoff and quiet hours.',
    routes: ['POST /api/v1/comms/queue'],
    permission: 'comms:write',
    idempotent: true,
    unverified: 'The queue worker is exercised against a stub provider only.',
  }),
  op({
    id: 'comms.inbound',
    module: 'comms',
    label: 'Receive an inbound channel message',
    description: 'Provider webhook, signature-gated with replay dedupe. Public by design: the signature is the credential.',
    routes: ['POST /api/v1/comms/*/inbound'],
    permission: 'public',
    confirmation: 'none',
    risk: 'consequential',
    note: 'Called by the provider, never by Copilot.',
  }),
  op({
    id: 'comms.verify',
    module: 'comms',
    label: 'Complete a channel handshake',
    description: 'Provider verification callback. Public by design.',
    routes: ['GET /api/v1/comms/*/verify'],
    permission: 'public',
    note: 'Called by the provider, never by Copilot.',
  }),
];

const VOICE = [
  op({
    id: 'voice.capabilities',
    module: 'voice',
    label: 'Read voice capability',
    description: 'Whether a local speech host is configured, which engines are catalogued, and whether remote hosts are allowed.',
    routes: ['GET /api/v1/voice'],
    permission: 'voice:read',
  }),
  op({ id: 'voice.endpoints', module: 'voice', label: 'List voice endpoints', description: 'Operator-supplied open-source speech servers.', routes: ['GET /api/v1/voice/endpoints'], permission: 'voice:read' }),
  op({
    id: 'voice.endpoint.create',
    module: 'voice',
    label: 'Add a voice endpoint',
    description: 'Registers a local speech server (STT or TTS) by URL. Plain http is refused off-loopback.',
    routes: ['POST /api/v1/voice/endpoints'],
    permission: 'voice:configure',
    risk: 'consequential',
    confirmation: 'approval',
  }),
  op({
    id: 'voice.endpoint.update',
    module: 'voice',
    label: 'Update a voice endpoint',
    description: 'Changes an endpoint’s URL, model or enabled flag.',
    routes: ['PATCH /api/v1/voice/endpoints/*'],
    permission: 'voice:configure',
    risk: 'consequential',
    confirmation: 'approval',
  }),
  op({
    id: 'voice.endpoint.delete',
    module: 'voice',
    label: 'Remove a voice endpoint',
    description: 'Deletes a speech endpoint; voice returns to unconfigured.',
    routes: ['DELETE /api/v1/voice/endpoints/*'],
    permission: 'voice:configure',
    risk: 'destructive',
    confirmation: 'approval',
    reversible: false,
  }),
  op({
    id: 'voice.endpoint.check',
    module: 'voice',
    label: 'Check a voice endpoint',
    description: 'Probes the endpoint and records latency and health.',
    routes: ['POST /api/v1/voice/endpoints/*/check'],
    permission: 'voice:read',
    risk: 'read-only',
    confirmation: 'none',
    note: 'POST because it performs a live probe, but it changes no user-visible state.',
  }),
  op({
    id: 'voice.transcribe',
    module: 'voice',
    label: 'Transcribe audio',
    description: 'Sends audio to the configured local host and returns text. No proprietary STT is used.',
    routes: ['POST /api/v1/voice/transcribe'],
    permission: 'voice:transcribe',
    requires: ['speech-host'],
    risk: 'read-only',
    confirmation: 'none',
    timeoutMs: 60000,
    note: 'A POST that returns text and stores nothing.',
  }),
];

const EVOLUTION = [
  op({
    id: 'evolution.capabilities',
    module: 'evolution',
    label: 'Read self-modification capability',
    description: 'Levels, protected paths, sandbox isolation and experiment counts.',
    routes: ['GET /api/v1/evolution/capabilities'],
    permission: 'evolution:read',
  }),
  op({ id: 'evolution.agents', module: 'evolution', label: 'List agents with evolution policies', description: 'Every agent and the level it is allowed.', routes: ['GET /api/v1/evolution/agents'], permission: 'evolution:read' }),
  op({ id: 'evolution.policy.read', module: 'evolution', label: 'Read an agent’s evolution policy', description: 'The level and what that level permits.', routes: ['GET /api/v1/evolution/agents/*/policy'], permission: 'evolution:read' }),
  op({
    id: 'evolution.policy.set',
    module: 'evolution',
    label: 'Set an agent’s evolution level',
    description: 'Changes what an agent may change about itself. Needs an Owner, and no agent can change its own level.',
    routes: ['PATCH /api/v1/evolution/agents/*/policy'],
    permission: 'evolution:policy',
    risk: 'consequential',
    confirmation: 'approval',
  }),
  op({ id: 'evolution.grants.list', module: 'evolution', label: 'List evolution grants', description: 'Extra permissions granted to an agent beyond its level.', routes: ['GET /api/v1/evolution/agents/*/grants'], permission: 'evolution:read' }),
  op({
    id: 'evolution.grants.create',
    module: 'evolution',
    label: 'Grant an evolution permission',
    description: 'Extends an agent’s scope for a bounded purpose.',
    routes: ['POST /api/v1/evolution/grants'],
    permission: 'evolution:policy',
    risk: 'consequential',
    confirmation: 'approval',
  }),
  op({
    id: 'evolution.grants.revoke',
    module: 'evolution',
    label: 'Revoke an evolution grant',
    description: 'Removes an extended scope.',
    routes: ['DELETE /api/v1/evolution/grants/*'],
    permission: 'evolution:policy',
    risk: 'destructive',
    confirmation: 'approval',
    reversible: false,
  }),
  op({ id: 'evolution.observations.read', module: 'evolution', label: 'Read observations', description: 'What an agent noticed about its own behaviour.', routes: ['GET /api/v1/evolution/agents/*/observations'], permission: 'evolution:read' }),
  op({
    id: 'evolution.observations.record',
    module: 'evolution',
    label: 'Record an observation',
    description: 'Stores something an agent or an operator noticed, as input to a later experiment.',
    routes: ['POST /api/v1/evolution/agents/*/observations'],
    permission: 'evolution:run',
  }),
  op({ id: 'evolution.versions', module: 'evolution', label: 'List an agent’s versions', description: 'Promoted versions with their diffs and approval references.', routes: ['GET /api/v1/evolution/agents/*/versions'], permission: 'evolution:read' }),
  op({
    id: 'evolution.health',
    module: 'evolution',
    label: 'Run an agent health check',
    description: 'Executes the health check after a promotion.',
    routes: ['POST /api/v1/evolution/agents/*/health'],
    permission: 'evolution:run',
    risk: 'consequential',
    requires: ['evolution-policy'],
  }),
  op({
    id: 'evolution.rollback',
    module: 'evolution',
    label: 'Roll back an agent version',
    description: 'Restores the previous version. Versioned and audited.',
    routes: ['POST /api/v1/evolution/agents/*/rollback'],
    permission: 'evolution:deploy',
    risk: 'destructive',
    confirmation: 'approval',
    reversible: false,
  }),
  op({
    id: 'evolution.experiments.list',
    module: 'evolution',
    label: 'List experiments',
    description: 'Self-modification experiments with status and outcome.',
    routes: ['GET /api/v1/evolution/experiments', 'GET /api/v1/evolution/experiments/*'],
    permission: 'evolution:read',
  }),
  op({
    id: 'evolution.experiments.file',
    module: 'evolution',
    label: 'Read an experiment file',
    description: 'The current content of a file in the isolated workspace.',
    routes: ['GET /api/v1/evolution/experiments/*/file'],
    permission: 'evolution:read',
  }),
  op({
    id: 'evolution.experiments.create',
    module: 'evolution',
    label: 'Open an experiment',
    description: 'Creates an isolated candidate workspace under the agent’s policy.',
    routes: ['POST /api/v1/evolution/experiments'],
    permission: 'evolution:run',
    risk: 'consequential',
    requires: ['evolution-policy'],
  }),
  op({
    id: 'evolution.experiments.edit',
    module: 'evolution',
    label: 'Plan, stage, edit or diagnose a candidate',
    description: 'Works inside the candidate only. Protected paths are refused, and no model writes the patch for you.',
    routes: [
      'POST /api/v1/evolution/experiments/*/plan',
      'POST /api/v1/evolution/experiments/*/workspace',
      'POST /api/v1/evolution/experiments/*/edit',
      'POST /api/v1/evolution/experiments/*/stage',
      'POST /api/v1/evolution/experiments/*/delete-file',
      'POST /api/v1/evolution/experiments/*/diagnose',
    ],
    permission: 'evolution:run',
    requires: ['evolution-policy'],
  }),
  op({
    id: 'evolution.experiments.test',
    module: 'evolution',
    label: 'Run the test suite against a candidate',
    description: 'Real sandboxed runs of the repository’s tests. The sandbox is process isolation, not a container.',
    routes: ['POST /api/v1/evolution/experiments/*/test'],
    permission: 'evolution:run',
    risk: 'consequential',
    requires: ['evolution-policy'],
    timeoutMs: 600000,
  }),
  op({
    id: 'evolution.experiments.compare',
    module: 'evolution',
    label: 'Compare a candidate with the current version',
    description: 'Computes the diff and a risk classification. Records no change of its own.',
    routes: ['POST /api/v1/evolution/experiments/*/compare'],
    permission: 'evolution:run',
    risk: 'read-only',
    confirmation: 'none',
  }),
  op({
    id: 'evolution.experiments.review',
    module: 'evolution',
    label: 'Review a candidate',
    description: 'An independent review of the diff and test evidence.',
    routes: ['POST /api/v1/evolution/experiments/*/review'],
    permission: 'evolution:review',
    risk: 'consequential',
    confirmation: 'none',
    note: 'The review is the decision; a confirmation card would duplicate it.',
  }),
  op({
    id: 'evolution.experiments.request-approval',
    module: 'evolution',
    label: 'Request approval to promote',
    description: 'Opens the gate a different principal must decide.',
    routes: ['POST /api/v1/evolution/experiments/*/request-approval'],
    permission: 'evolution:run',
  }),
  op({
    id: 'evolution.experiments.approve',
    module: 'evolution',
    label: 'Approve a candidate',
    description: 'A second principal allows promotion. Separation of duties applies.',
    routes: ['POST /api/v1/evolution/experiments/*/approve'],
    permission: 'evolution:approve',
    risk: 'consequential',
    confirmation: 'none',
    note: 'Approval is itself the gate.',
  }),
  op({
    id: 'evolution.experiments.deploy',
    module: 'evolution',
    label: 'Promote a candidate',
    description: 'Writes the reviewed diff into the workspace as a new version.',
    routes: ['POST /api/v1/evolution/experiments/*/deploy'],
    permission: 'evolution:deploy',
    risk: 'destructive',
    confirmation: 'approval',
    reversible: false,
  }),
  op({
    id: 'evolution.experiments.cancel',
    module: 'evolution',
    label: 'Cancel an experiment',
    description: 'Stops the experiment and removes its workspace.',
    routes: ['POST /api/v1/evolution/experiments/*/cancel'],
    permission: 'evolution:run',
  }),
];

/* ---------- the three draft pipelines: seven operations each, from one literal definition ---------- */

const DRAFT_PIPELINES = [
  {
    slug: 'drafts',
    module: 'agent-drafts',
    noun: 'agent draft',
    activate: { permission: 'agent:write', description: 'Activates an approved draft, storing an idle agent definition. Nothing is deployed or started.' },
  },
  {
    slug: 'plans',
    module: 'swarm-plan-drafts',
    noun: 'swarm-plan draft',
    activate: { permission: 'swarm:write', description: 'Activates an approved plan, storing a plan with status planned, zero progress and zero spend. Nothing executes it.' },
  },
  {
    slug: 'scripts',
    module: 'browser-script-drafts',
    noun: 'browser-script draft',
    activate: {
      permission: 'browser:run',
      description: 'Activating an approved script queues one real browser task, which runs on the gateway host.',
      requires: ['chromium'],
    },
  },
];

function draftOperations(pipeline) {
  const base = `/api/v1/copilot/${pipeline.slug}`;
  const id = (suffix) => `copilot.${pipeline.slug}.${suffix}`;
  const n = pipeline.noun;
  return [
    op({ id: id('list'), module: pipeline.module, label: `List ${n}s`, description: `Stored ${n}s with state and owner.`, routes: [`GET ${base}`], permission: 'copilot:read' }),
    op({ id: id('get'), module: pipeline.module, label: `Read one ${n}`, description: `A single ${n} with its validation findings.`, routes: [`GET ${base}/*`], permission: 'copilot:read' }),
    op({ id: id('create'), module: pipeline.module, label: `Create a ${n}`, description: `Validated by the gateway. A draft is not an agent and not an execution.`, routes: [`POST ${base}`], permission: 'copilot:write' }),
    op({ id: id('update'), module: pipeline.module, label: `Edit a ${n}`, description: 'Edits an open draft. Ownership is enforced by the gateway.', routes: [`PATCH ${base}/*`], permission: 'copilot:write' }),
    op({ id: id('submit'), module: pipeline.module, label: `Submit a ${n} for approval`, description: 'Validates and opens an approval gate for a different principal.', routes: [`POST ${base}/*/submit`], permission: 'copilot:write' }),
    op({
      id: id('activate'),
      module: pipeline.module,
      label: `Activate an approved ${n}`,
      description: pipeline.activate.description,
      routes: [`POST ${base}/*/activate`],
      permission: pipeline.activate.permission,
      risk: 'consequential',
      confirmation: 'none',
      requires: pipeline.activate.requires || [],
      note: 'Activation requires the approval that was already decided; a second card would be theatre.',
    }),
    op({ id: id('archive'), module: pipeline.module, label: `Archive a ${n}`, description: 'Archives a draft.', routes: [`POST ${base}/*/archive`], permission: 'copilot:write' }),
  ];
}

/* ---------- documented operations with no service behind them ---------- */

const NO_SERVICE = [
  noService({
    id: 'agents.run',
    module: 'agents',
    label: 'Start or stop an agent',
    description: 'There is no agent runtime, no scheduler and no run endpoint. An agent is a stored definition.',
    permission: 'agent:write',
    note: 'The swipe gesture and PATCH /agents/:id change a status label; that is not a run, and Copilot must not call it one.',
  }),
  noService({
    id: 'swarms.execute',
    module: 'swarms',
    label: 'Deploy or run a swarm plan',
    description: 'Nothing schedules or executes a plan. A plan is a saved intention with zero progress and zero spend.',
    permission: 'swarm:write',
    note: 'POST /swarms/:id/deploy is listed as planned in packages/shared/api-routes.json and does not exist.',
  }),
  noService({
    id: 'skills.activate',
    module: 'skills',
    label: 'Activate a skill',
    description: 'No skills endpoint exists; the Skills Hub catalogue is local to the browser.',
    permission: 'agent:write',
  }),
  noService({
    id: 'files.upload',
    module: 'files',
    label: 'Upload or list artifacts',
    description: 'The files table exists but no route serves it. The Artifacts screen writes into local state.',
    permission: 'read',
  }),
  noService({
    id: 'analytics.series',
    module: 'analytics',
    label: 'Read an analytics series',
    description: 'Only /usage and /model-calls exist. There is no per-metric series endpoint, and the leaderboard figures are fixtures.',
    permission: 'model:read',
  }),
  noService({
    id: 'plugins.connect',
    module: 'plugins',
    label: 'Connect an MCP plugin',
    description: 'There is no MCP client: no transport, no server process, no tool invocation.',
    permission: 'agent:write',
  }),
  noService({
    id: 'training.validate',
    module: 'training',
    label: 'Validate a training dataset',
    description: 'Only bounded inline JSONL syntax inspection exists. There is no training backend, validator or job runner.',
    permission: 'read',
  }),
  noService({
    id: 'local.inference',
    module: 'local',
    label: 'Run a model on this device',
    description: 'The on-device runtime is a phase-2 spike; there is no model manager and no offline inference.',
    permission: 'read',
  }),
  noService({
    id: 'telegram.send',
    module: 'comms',
    label: 'Send through Telegram',
    description: 'Telegram is a comms channel on the gateway. The legacy screen that claimed otherwise now redirects to Comms.',
    permission: 'comms:write',
    note: 'Use comms.send with the telegram channel once its credentials are configured.',
  }),
];

export const OPERATIONS = Object.freeze([
  ...PLATFORM,
  ...IDENTITY,
  ...AGENTS,
  ...TEAMS,
  ...TASKS,
  ...APPROVALS,
  ...SWARMS,
  ...MODELS_OPS,
  ...CHAT,
  ...COPILOT,
  ...BROWSER,
  ...TERMINAL,
  ...COMMS,
  ...VOICE,
  ...EVOLUTION,
  ...DRAFT_PIPELINES.flatMap(draftOperations),
  ...NO_SERVICE,
]);

/** Routes the gateway serves that are deliberately not capabilities, each with a reason. */
export const UNEXPOSED = Object.freeze([
  { route: 'POST /api/v1/auth/login', reason: 'Session lifecycle: the client signs in; Copilot never handles credentials.' },
  { route: 'POST /api/v1/auth/logout', reason: 'Session lifecycle.' },
  { route: 'POST /api/v1/auth/password', reason: 'Session lifecycle: a password is typed by the person, never by Copilot.' },
  { route: 'GET /api/v1/auth/session', reason: 'Session lifecycle: the client reads its own session.' },
  { route: 'POST /api/v1/dev/seed', reason: 'Test helper that re-seeds the database. Not an operator capability.' },
  { route: 'GET /api/v1/dispatch', reason: 'The dispatcher’s own view of the registry: it is how a capability is run, not one of them.' },
  { route: 'POST /api/v1/dispatch', reason: 'The dispatcher’s entry point. Every operation it may run carries its own permission, checked inside the dispatcher.' },
  { route: 'POST /api/v1/copilot/actions/*', reason: 'Confirms an action the Copilot prepared; it delegates to the dispatcher, which decides what may run.' },
]);

/* =========================================================================================
 * 5. Drift — the declared catalogue against the routes the server really serves
 * =======================================================================================*/

/** `^\/api\/v1\/agents\/([\w-]+)$` → `GET /api/v1/agents/*` */
export function routeKey(method, source) {
  const normalised = String(source)
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\\\//g, '/')
    .replace(/\([^)]*\)/g, '*');
  return `${String(method).toUpperCase()} ${normalised}`;
}

const keyOf = (route) => {
  const [method, ...rest] = String(route).split(' ');
  return routeKey(method, rest.join(' '));
};

let liveRoutes = null;

/** Called once by server.js after every route is registered. */
export function attachRoutes(routes) {
  liveRoutes = (routes || []).map((r) => ({
    key: routeKey(r.method, r.pattern.source),
    permission: r.meta?.public ? 'public' : r.meta?.permission || null,
    mutating: Boolean(r.meta?.mutating),
  }));
}

export const routesAttached = () => Boolean(liveRoutes);

/**
 * Compare the declaration with the table. Four questions, each with an assertion behind it:
 *   • does every declared route exist?              (a typo would otherwise be a silent capability)
 *   • is every served route claimed or excused?     (a new route must not escape the catalogue)
 *   • does the route's permission match the claim?  (authority drift)
 *   • does the route's mutation flag match the kind?
 */
export function coverage() {
  if (!liveRoutes) {
    return { ok: false, error: 'routes-not-attached', served: 0, declared: 0, missing: [], undeclared: [], mismatched: [], staleExcuses: [] };
  }
  const served = new Map(liveRoutes.map((r) => [r.key, r]));
  const claimed = new Map();
  const missing = [];
  const mismatched = [];

  for (const operation of OPERATIONS) {
    for (const declared of operation.routes) {
      const key = keyOf(declared);
      if (claimed.has(key)) {
        mismatched.push({ route: key, issue: `claimed twice: ${claimed.get(key)} and ${operation.id}` });
        continue;
      }
      claimed.set(key, operation.id);
      const route = served.get(key);
      if (!route) {
        missing.push({ route: key, operation: operation.id });
        continue;
      }
      if (route.permission && operation.permission !== route.permission) {
        mismatched.push({ route: key, operation: operation.id, issue: `route permission “${route.permission}” vs declared “${operation.permission}”` });
      }
      const routeIsMutation = route.mutating;
      const declaredMutation = operation.kind === 'mutation';
      if (routeIsMutation !== declaredMutation) {
        mismatched.push({ route: key, operation: operation.id, issue: `route mutating=${routeIsMutation} vs declared kind=${operation.kind}` });
      }
    }
  }

  const excused = new Map(UNEXPOSED.map((u) => [keyOf(u.route), u.reason]));
  const undeclared = liveRoutes.filter((r) => !claimed.has(r.key) && !excused.has(r.key)).map((r) => r.key);
  const staleExcuses = [...excused.keys()].filter((k) => !served.has(k));

  return {
    ok: missing.length === 0 && undeclared.length === 0 && mismatched.length === 0 && staleExcuses.length === 0,
    served: liveRoutes.length,
    declared: OPERATIONS.filter((o) => o.routes.length).length,
    claims: [...claimed.keys()].length,
    unexposed: excused.size,
    missing,
    undeclared,
    mismatched,
    staleExcuses,
  };
}

/* =========================================================================================
 * 6. Reading the catalogue — state is computed, never asserted
 * =======================================================================================*/

function stateOf(operation, requirements, permissionHeld) {
  if (operation.routes.length === 0) {
    return { state: 'no-service', reason: operation.note || 'No service serves this operation.' };
  }
  if (operation.unverified) return { state: 'unverified', reason: operation.unverified };
  const unmet = operation.requires.filter((id) => !requirements[id]?.met);
  if (unmet.length) {
    return {
      state: 'unconfigured',
      reason: `Needs ${unmet.map((id) => REQUIREMENTS[id].label).join(' and ')} — ${unmet.map((id) => requirements[id].detail).join('; ')}.`,
    };
  }
  if (!permissionHeld) {
    return { state: 'available', reason: 'This gateway can serve it, but your role does not hold the permission.' };
  }
  return { state: 'available', reason: '' };
}

async function probeRequirements(operations) {
  const needed = [...new Set(operations.flatMap((o) => o.requires))].sort();
  const out = {};
  for (const id of needed) {
    try {
      const res = await REQUIREMENTS[id].probe();
      out[id] = { id, label: REQUIREMENTS[id].label, why: REQUIREMENTS[id].why, met: Boolean(res.met), detail: res.detail };
    } catch (error) {
      out[id] = { id, label: REQUIREMENTS[id].label, why: REQUIREMENTS[id].why, met: false, detail: `probe failed: ${error.message}` };
    }
  }
  return out;
}

/** Role-filtered view. `principal === null` (unauthenticated) yields allowed:false everywhere but `public`. */
export async function catalogue(principal) {
  const requirements = await probeRequirements(OPERATIONS);

  const operations = OPERATIONS.map((operation) => {
    const allowed = operation.permission === 'public' ? true : can(principal, operation.permission);
    const { state, reason } = stateOf(operation, requirements, allowed);
    return {
      id: operation.id,
      module: operation.module,
      label: operation.label,
      description: operation.description,
      kind: operation.kind,
      risk: operation.risk,
      confirmation: operation.confirmation,
      reversible: operation.reversible,
      idempotent: operation.idempotent,
      audit: operation.audit,
      timeoutMs: operation.timeoutMs,
      permission: operation.permission,
      allowed,
      state,
      stateLabel: STATES[state].label,
      tone: STATES[state].tone,
      reason,
      routes: [...operation.routes],
      requires: [...operation.requires],
      note: operation.note,
    };
  });

  const states = Object.fromEntries(STATE_IDS.map((s) => [s, 0]));
  for (const o of operations) states[o.state] += 1;

  return {
    version: 1,
    vocabulary: STATES,
    states,
    requirements,
    operations,
    coverage: coverage(),
    note:
      'An operation is available only when a real route serves it, your role holds its permission, and every ' +
      'runtime requirement is met. Anything else says what is missing. Declared in ' +
      'apps/gateway/src/capabilities.js and drift-checked against the live route table.',
  };
}

/** One operation, or null. An operation the caller may not use still appears, with allowed:false. */
export async function one(id, principal) {
  const all = await catalogue(principal);
  return all.operations.find((o) => o.id === id) || null;
}
