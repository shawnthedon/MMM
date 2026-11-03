/* ============ Operation input contracts ============
 * How a dispatcher call becomes a route call: which route serves the operation, how the path is built, and
 * exactly which fields may reach the handler.
 *
 * Three rules keep this from becoming a second validation system:
 *
 *   1. **Only declared fields are forwarded.** A handler never sees a parameter the contract did not
 *      list, so a caller cannot smuggle `principal`, `permission`, `id` or an unknown column into a write.
 *      The gateway's own handler validation still runs afterwards — this is a gate, not a replacement.
 *   2. **The contract is derived where it can be, and declared where it cannot.** A read with no capture
 *      group has no parameters; a read with one has `id`. Anything else must be written out by hand, and
 *      an operation with no contract is reported as not dispatchable rather than guessed at.
 *   3. **No contract mentions a credential.** Secret-bearing routes (provider keys, voice endpoints) are
 *      deliberately absent: those are typed by a person in the module's own screen, never relayed by a
 *      dispatcher that would have to put the value in a request body and an audit trail.
 */

const ID = { type: 'string', required: true, minLength: 1, maxLength: 64, pattern: '^[\\w.-]+$' };

const field = (type, extra = {}) => ({ type, ...extra });

/** Reusable field shapes. */
const NAME = field('string', { required: true, minLength: 2, maxLength: 80 });
const TEXT = (max = 4000) => field('string', { maxLength: max });
const MONEY = field('number', { min: 0, max: 10000 });

/**
 * Declared contracts. `route` selects one entry from the operation's `routes`; `template` is the path with
 * `{name}` placeholders, filled from the `path` fields.
 */
export const CONTRACTS = Object.freeze({
  /* ---------- agents ---------- */
  'agents.create': {
    route: 'POST /api/v1/agents',
    template: '/api/v1/agents',
    body: {
      name: field('string', { required: true, minLength: 2, maxLength: 40, pattern: '^[\\w .-]+$' }),
      role: TEXT(120),
      framework: TEXT(40),
      model: TEXT(120),
      fallback: TEXT(120),
      prompt: TEXT(4000),
      trust: field('number', { min: 0, max: 100 }),
      teamId: TEXT(64),
      status: field('string', { enum: ['idle', 'paused'] }),
      tools: field('array', { of: 'string', maxItems: 20 }),
      skills: field('array', { of: 'string', maxItems: 20 }),
    },
  },
  'agents.update': {
    route: 'PATCH /api/v1/agents/*',
    template: '/api/v1/agents/{id}',
    path: { id: ID },
    body: {
      name: field('string', { minLength: 2, maxLength: 40, pattern: '^[\\w .-]+$' }),
      role: TEXT(120),
      framework: TEXT(40),
      model: TEXT(120),
      fallback: TEXT(120),
      prompt: TEXT(4000),
      trust: field('number', { min: 0, max: 100 }),
      goal: TEXT(400),
      teamId: TEXT(64),
      teamPosition: field('number', { min: 0, max: 999 }),
      // A status label. It is not a run: there is no agent runtime, and the route stores a string.
      status: field('string', { enum: ['idle', 'paused', 'running'] }),
    },
  },
  'agents.delete': {
    route: 'DELETE /api/v1/agents/*',
    template: '/api/v1/agents/{id}',
    path: { id: ID },
    target: (params) => `agent:${params.id}`,
  },

  /* ---------- tasks ---------- */
  'tasks.create': {
    route: 'POST /api/v1/tasks',
    template: '/api/v1/tasks',
    body: {
      title: field('string', { required: true, minLength: 1, maxLength: 200 }),
      desc: TEXT(2000),
      column: field('string', { enum: ['todo', 'doing', 'review', 'done'] }),
      assignee: TEXT(64),
      priority: field('string', { enum: ['low', 'med', 'high'] }),
      deps: field('array', { of: 'string', maxItems: 20 }),
    },
  },
  'tasks.update': {
    route: 'PATCH /api/v1/tasks/*',
    template: '/api/v1/tasks/{id}',
    path: { id: ID },
    body: {
      title: field('string', { minLength: 1, maxLength: 200 }),
      description: TEXT(2000),
      column_name: field('string', { enum: ['todo', 'doing', 'review', 'done'] }),
      assignee: TEXT(64),
      priority: field('string', { enum: ['low', 'med', 'high'] }),
    },
    atLeastOneBodyField: true,
  },

  /* ---------- teams ---------- */
  'teams.create': {
    route: 'POST /api/v1/teams',
    template: '/api/v1/teams',
    body: { name: NAME, description: TEXT(400), topology: TEXT(40) },
  },
  'teams.update': {
    route: 'PATCH /api/v1/teams/*',
    template: '/api/v1/teams/{id}',
    path: { id: ID },
    body: { name: field('string', { minLength: 2, maxLength: 80 }), description: TEXT(400) },
    atLeastOneBodyField: true,
  },
  'teams.delete': {
    route: 'DELETE /api/v1/teams/*',
    template: '/api/v1/teams/{id}',
    path: { id: ID },
    target: (params) => `team:${params.id}`,
  },
  'teams.member.add': {
    route: 'POST /api/v1/teams/*/members',
    template: '/api/v1/teams/{teamId}/members',
    path: { teamId: ID },
    body: { agentId: field('string', { required: true, maxLength: 64 }), position: field('number', { min: 0, max: 999 }) },
  },
  'teams.member.remove': {
    route: 'DELETE /api/v1/teams/*/members/*',
    template: '/api/v1/teams/{teamId}/members/{agentId}',
    path: { teamId: ID, agentId: ID },
  },
  'teams.reorder': {
    route: 'POST /api/v1/teams/*/order',
    template: '/api/v1/teams/{teamId}/order',
    path: { teamId: ID },
    body: { order: field('array', { required: true, of: 'string', maxItems: 100 }) },
  },

  /* ---------- approvals ---------- */
  'approvals.request': {
    route: 'POST /api/v1/approvals',
    template: '/api/v1/approvals',
    body: {
      action: field('string', { required: true, minLength: 3, maxLength: 120 }),
      target: TEXT(200),
      risk: field('string', { enum: ['low', 'medium', 'high'] }),
      evidence: TEXT(1000),
      agentId: TEXT(64),
    },
    // `principal` is deliberately absent: the gateway records who asked, and a body field that could claim
    // someone else requested the gate is the one thing separation of duties cannot tolerate.
  },
  'approvals.decide': {
    route: 'POST /api/v1/approvals/*/*',
    template: '/api/v1/approvals/{id}/{decision}',
    path: { id: ID, decision: field('string', { required: true, enum: ['allow', 'deny'] }) },
    target: (params) => `approval:${params.id}`,
  },

  /* ---------- swarm plans ---------- */
  'swarms.create': {
    route: 'POST /api/v1/swarms',
    template: '/api/v1/swarms',
    body: {
      objective: field('string', { required: true, minLength: 4, maxLength: 500 }),
      name: TEXT(80),
      budgetCap: MONEY,
      channel: TEXT(40),
      teamId: TEXT(64),
      nodes: field('array', { of: 'object', maxItems: 40 }),
    },
  },
  'swarms.update': {
    route: 'PATCH /api/v1/swarms/*',
    template: '/api/v1/swarms/{id}',
    path: { id: ID },
    body: { name: TEXT(80), objective: TEXT(500), budgetCap: MONEY, channel: TEXT(40) },
    atLeastOneBodyField: true,
  },
  'swarms.status': {
    route: 'POST /api/v1/swarms/*/status',
    template: '/api/v1/swarms/{id}/status',
    path: { id: ID },
    body: { status: field('string', { required: true, enum: ['planned', 'paused', 'cancelled', 'archived'] }) },
  },
  'swarms.delete': {
    route: 'DELETE /api/v1/swarms/*',
    template: '/api/v1/swarms/{id}',
    path: { id: ID },
    target: (params) => `swarm:${params.id}`,
  },

  /* ---------- chat ---------- */
  'chat.create': {
    route: 'POST /api/v1/threads',
    template: '/api/v1/threads',
    body: { title: field('string', { required: true, minLength: 1, maxLength: 120 }), kind: field('string', { enum: ['direct', 'channel'] }) },
  },
  'chat.send': {
    route: 'POST /api/v1/threads/*/messages',
    template: '/api/v1/threads/{threadId}/messages',
    path: { threadId: ID },
    body: { text: field('string', { required: true, minLength: 1, maxLength: 4000 }), clientId: TEXT(64) },
  },

  /* ---------- models ---------- */
  'providers.call': {
    route: 'POST /api/v1/providers/*/call',
    template: '/api/v1/providers/{id}/call',
    path: { id: ID },
    body: {
      model: TEXT(120),
      messages: field('array', { of: 'object', maxItems: 50 }),
      purpose: TEXT(60),
      maxTokens: field('number', { min: 1, max: 8192 }),
      timeoutMs: field('number', { min: 1000, max: 60000 }),
    },
  },
  'models.budget': {
    route: 'PUT /api/v1/budget',
    template: '/api/v1/budget',
    body: { dailyUsd: MONEY, perCallUsd: MONEY, enforced: field('boolean') },
    atLeastOneBodyField: true,
  },
});

const pathOf = (route) => String(route).split(' ').slice(1).join(' ');

/**
 * Resolve the contract for an operation. Explicit declarations win; otherwise a read is derived, because a
 * GET with no capture group genuinely has no input and a GET with one genuinely has an id.
 *
 * Returns `null` when there is nothing honest to derive — the operation is visible in the catalogue but not
 * dispatchable, and the dispatcher says exactly that instead of guessing at its parameters.
 */
export function resolveContract(operation) {
  const explicit = CONTRACTS[operation.id];
  if (explicit) return { ...explicit, derived: false };

  if (operation.kind !== 'read' || operation.routes.length !== 1) return null;
  const only = operation.routes[0];
  const stars = (only.match(/\*/g) || []).length;
  if (stars === 0) return { route: only, template: pathOf(only), derived: true, body: {}, path: {} };
  if (stars === 1) {
    return {
      route: only,
      template: pathOf(only).replace('*', '{id}'),
      derived: true,
      path: { id: ID },
      body: {},
    };
  }
  return null;
}

/* =========================================================================================
 * Validation
 * =======================================================================================*/

const TYPES = ['string', 'number', 'boolean', 'object', 'array'];

function checkField(name, spec, value, errors) {
  const where = name;
  if (value === undefined || value === null) {
    if (spec.required) errors.push({ field: where, problem: 'required' });
    return undefined;
  }
  if (!TYPES.includes(spec.type)) {
    errors.push({ field: where, problem: `contract declares an unknown type “${spec.type}”` });
    return undefined;
  }
  if (spec.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push({ field: where, problem: 'must be a number' });
      return undefined;
    }
    if (spec.min !== undefined && value < spec.min) errors.push({ field: where, problem: `must be at least ${spec.min}` });
    if (spec.max !== undefined && value > spec.max) errors.push({ field: where, problem: `must be at most ${spec.max}` });
  } else if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') errors.push({ field: where, problem: 'must be true or false' });
  } else if (spec.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push({ field: where, problem: 'must be an array' });
    } else {
      if (spec.maxItems !== undefined && value.length > spec.maxItems) errors.push({ field: where, problem: `at most ${spec.maxItems} items` });
      if (spec.of === 'string' && value.some((v) => typeof v !== 'string')) errors.push({ field: where, problem: 'must contain only strings' });
      if (spec.of === 'object' && value.some((v) => typeof v !== 'object' || v === null || Array.isArray(v))) {
        errors.push({ field: where, problem: 'must contain only objects' });
      }
    }
  } else if (spec.type === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) errors.push({ field: where, problem: 'must be an object' });
  } else {
    if (typeof value !== 'string') {
      errors.push({ field: where, problem: 'must be a string' });
      return undefined;
    }
    if (spec.minLength !== undefined && value.length < spec.minLength) errors.push({ field: where, problem: `at least ${spec.minLength} characters` });
    if (spec.maxLength !== undefined && value.length > spec.maxLength) errors.push({ field: where, problem: `at most ${spec.maxLength} characters` });
    if (spec.pattern && !new RegExp(spec.pattern).test(value)) errors.push({ field: where, problem: 'contains characters that are not allowed' });
    if (spec.enum && !spec.enum.includes(value)) errors.push({ field: where, problem: `must be one of ${spec.enum.join(', ')}` });
  }
  return value;
}

/**
 * Validate a caller's params against a contract.
 *
 * Unknown keys are refused rather than dropped: silently ignoring `{ principal: 'owner' }` would leave the
 * caller believing it did something, and silently ignoring a typo would leave them believing a field was
 * set. Both are worse than a 400 that names the key.
 */
export function validateParams(contract, params) {
  const errors = [];
  if (params === undefined || params === null) params = {};
  if (typeof params !== 'object' || Array.isArray(params)) {
    return { ok: false, value: null, errors: [{ field: '(params)', problem: 'must be an object' }] };
  }

  const path = {};
  const body = {};
  const query = {};
  const declared = new Set();

  for (const group of ['path', 'body', 'query']) {
    const spec = contract[group] || {};
    for (const [name, rule] of Object.entries(spec)) {
      declared.add(name);
      const value = checkField(name, rule, params[name], errors);
      if (value !== undefined && value !== null) {
        if (group === 'path') path[name] = value;
        else if (group === 'query') query[name] = value;
        else body[name] = value;
      }
    }
  }

  const unknown = Object.keys(params).filter((k) => !declared.has(k));
  for (const key of unknown) errors.push({ field: key, problem: 'not a parameter of this operation' });

  if (contract.atLeastOneBodyField && Object.keys(body).length === 0 && errors.length === 0) {
    errors.push({ field: '(body)', problem: `at least one of ${Object.keys(contract.body).join(', ')} is required` });
  }

  return { ok: errors.length === 0, value: errors.length ? null : { path, body, query }, errors };
}

/** Fill `{name}` placeholders. Missing values are a contract bug, so they throw rather than produce `/undefined`. */
export function buildPath(template, pathValues) {
  return String(template).replace(/\{(\w+)\}/g, (_, name) => {
    const value = pathValues[name];
    if (value === undefined) throw new Error(`contract is missing path parameter “${name}”`);
    return encodeURIComponent(String(value));
  });
}

/** The sentence a refusal uses for a set of field errors. */
export function describeFieldErrors(errors) {
  return errors.map((e) => `${e.field}: ${e.problem}`).join('; ');
}
