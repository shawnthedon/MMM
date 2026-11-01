/* ============ The canonical swarm-plan draft ============
 * A workflow in MMM is a swarm plan — there is no second plan schema and this file does not invent one.
 * It is the *draft* layer over the fields `apps/gateway/src/swarms.js` already accepts, with the same
 * limits, so that a draft a Reviewer approves is a plan the gateway will always be able to save.
 *
 * That is the whole point of putting the rules here rather than in the prompt: `createSwarm` refuses an
 * empty objective, an unknown team, a budget cap that is not a number and more than 24 nodes. If the
 * draft validator did not refuse exactly the same things, a Reviewer could approve a plan that the
 * activation route then rejected — approval as theatre. Every rule below mirrors a refusal in
 * `swarms.js`, and the findings say which one.
 *
 * The state vocabulary is imported from `agentDraft.js`, not redefined: one draft state machine for
 * every artefact the Copilot produces, so "awaiting approval" means the same thing on a card whether it
 * holds an agent or a plan.
 *
 * What is deliberately NOT here: anything that schedules, starts or advances a plan. An approved draft
 * becomes a `swarms` row with `executed = 0`; no scheduler and no worker exist in this build.
 */
import { DRAFT_STATES, DRAFT_ONLY_STATES, parseDraftReply } from './agentDraft.js';

/** Mirrors LIMITS / MAX_NODES in apps/gateway/src/swarms.js. */
export const PLAN_LIMITS = Object.freeze({
  name: 120,
  objective: 2000,
  channel: 40,
  topology: 40,
  nodeLabel: 40,
  nodes: 24,
  budgetCap: 100000,
  instruction: 4000,
});

export const PLAN_CHANNELS = Object.freeze(['app', 'telegram', 'email', 'webhook']);
export const DEFAULT_TOPOLOGY = 'Hierarchical';

/** The six roles the Swarms graph draws, used when a plan names no order (swarms.js does the same). */
export const DEFAULT_NODES = Object.freeze([
  { id: 'n1', label: 'planner' }, { id: 'n2', label: 'research-a' }, { id: 'n3', label: 'research-b' },
  { id: 'n4', label: 'analyze' }, { id: 'n5', label: 'writer' }, { id: 'n6', label: 'assembler' },
]);

const str = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,60}$/i;

/** The fields a plan draft carries — the accepted set of `createSwarm`, and nothing else. */
export function emptyPlan() {
  return {
    v: 1,
    name: '',
    objective: '',
    teamId: null,
    channel: 'app',
    topology: DEFAULT_TOPOLOGY,
    budgetCap: 8,
    nodes: [],
  };
}

/**
 * Coerce anything (a model's JSON, a form, a stale row) into the canonical plan. Unknown keys are
 * dropped and reported: a model that sends `executed: true` or `status: "running"` must not have its
 * attempt quietly preserved, because the next reader would believe it.
 */
export function normalisePlan(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const plan = emptyPlan();
  const dropped = Object.keys(raw).filter((k) => !(k in plan));

  plan.name = str(raw.name, PLAN_LIMITS.name);
  plan.objective = str(raw.objective, PLAN_LIMITS.objective);
  plan.channel = str(raw.channel, PLAN_LIMITS.channel) || 'app';
  plan.topology = str(raw.topology, PLAN_LIMITS.topology) || DEFAULT_TOPOLOGY;
  plan.teamId = typeof raw.teamId === 'string' && ID_RE.test(raw.teamId) ? raw.teamId : null;
  // A cap that is not a finite number is kept as the literal it arrived as, so the validator can call it
  // an error instead of silently resetting it to a plausible 8 and calling the draft ready.
  const cap = Number(raw.budgetCap ?? raw.budget);
  plan.budgetCap = raw.budgetCap === undefined && raw.budget === undefined ? 8 : (Number.isFinite(cap) ? Math.round(cap * 100) / 100 : raw.budgetCap ?? raw.budget);

  const nodes = Array.isArray(raw.nodes) ? raw.nodes.slice(0, PLAN_LIMITS.nodes + 5) : [];
  plan.nodes = nodes.map((node, index) => {
    const n = node && typeof node === 'object' ? node : {};
    return {
      id: str(n.id, 16) || `n${index + 1}`,
      label: str(n.label, PLAN_LIMITS.nodeLabel) || `node-${index + 1}`,
      agent: str(n.agent, 64),
    };
  });
  return { plan, dropped };
}

/**
 * Validate a plan draft against everything the gateway would refuse at save time.
 *
 * `ctx` is what the validator may not assume:
 *   teams  — the gateway's teams (id, name, and how many agents they have)
 *   agents — existing agents (id, name), for a node that names one
 */
export function validatePlan(planInput, ctx = {}) {
  const { plan } = normalisePlan(planInput);
  const findings = [];
  const add = (severity, field, title, detail) => findings.push({
    id: `plan-${field}-${findings.length}`, field, severity, title, detail,
  });

  const teams = Array.isArray(ctx.teams) ? ctx.teams : [];
  const agents = Array.isArray(ctx.agents) ? ctx.agents : [];

  /* ---- the definition: what createSwarm accepts ---- */
  if (!plan.objective) {
    add('error', 'objective', 'No objective',
      'A swarm plan is an objective. The gateway refuses a plan without one, so this cannot be submitted until it has one.');
  } else if (plan.objective.length > PLAN_LIMITS.objective) {
    add('error', 'objective', 'Objective too long', `Keep it under ${PLAN_LIMITS.objective} characters.`);
  }

  if (typeof plan.budgetCap !== 'number' || !Number.isFinite(plan.budgetCap)) {
    add('error', 'budgetCap', 'Budget cap is not a number',
      'The gateway refuses a plan whose cap is not a number of zero or more. Say a figure, e.g. 8.');
  } else if (plan.budgetCap < 0) {
    add('error', 'budgetCap', 'Budget cap is negative', 'A cap of zero or more is required; a negative cap is refused.');
  } else if (plan.budgetCap > PLAN_LIMITS.budgetCap) {
    add('error', 'budgetCap', 'Budget cap above the limit', `A cap above ${PLAN_LIMITS.budgetCap} is refused by the gateway.`);
  } else if (plan.budgetCap === 0) {
    add('warning', 'budgetCap', 'Budget cap is zero',
      'The plan is saved with a cap of zero: whatever runs it later would have no budget at all.');
  }

  if (plan.nodes.length > PLAN_LIMITS.nodes) {
    add('error', 'nodes', 'Too many nodes', `A plan can hold at most ${PLAN_LIMITS.nodes} nodes.`);
  }
  if (new Set(plan.nodes.map((n) => n.id)).size !== plan.nodes.length) {
    // A warning, not an error, and deliberately so: `createSwarm` stores duplicate ids without complaint,
    // and a draft validator that refused them would make this file stricter than the save it predicts.
    add('warning', 'nodes', 'Two nodes share an id',
      'The plan saves as written, but a node order is a graph: two nodes with the same id cannot be told apart. Rename one.');
  }
  if (!plan.nodes.length) {
    add('warning', 'nodes', 'No node order',
      `Saving would apply the default ${DEFAULT_NODES.length}-role order (planner, research, analyze, writer, assembler).`);
  }

  if (plan.teamId) {
    const team = teams.find((t) => t.id === plan.teamId);
    if (!team) {
      // An error, not a setup item: createSwarm refuses an unknown team with a 404, so approving this
      // draft would produce an approval that activation could never honour.
      add('error', 'teamId', 'That team does not exist',
        `The gateway would refuse this plan: no team “${plan.teamId}”. Pick one that exists, or drop the team.`);
    } else if (Number(team.members) === 0) {
      add('warning', 'teamId', 'The team has no agents',
        `“${team.name}” has no agents, so the nodes would be saved with no one to assign them to.`);
    }
  }

  const unknown = plan.nodes.filter((n) => n.agent && !agents.some((a) => a.id === n.agent));
  if (unknown.length) {
    add('warning', 'nodes', 'A node names an agent that does not exist',
      `${unknown.map((n) => `${n.label} → ${n.agent}`).join(', ')}. The plan would record the name as written; nothing checks it at run time because nothing runs.`);
  }

  if (plan.channel !== 'app' && !PLAN_CHANNELS.includes(plan.channel)) {
    add('warning', 'channel', 'Unrecognised channel',
      `“${plan.channel}” is not one of ${PLAN_CHANNELS.join(', ')}. It is stored as written; no integration exists for it.`);
  }

  /* ---- the always-true part: a plan is not a run ---- */
  add('blocked', 'execution', 'Nothing executes this plan',
    'No scheduler and no worker exist in this build. Approving stores the plan as a `planned` swarm row with zero progress and zero spend; nothing starts it.');

  const errors = findings.filter((f) => f.severity === 'error');
  const setup = findings.filter((f) => f.severity === 'setup');
  const info = findings.filter((f) => f.severity === 'info');
  const blocked = findings.filter((f) => f.severity === 'blocked');

  let state;
  if (errors.length) state = 'invalid';
  else if (info.length) state = 'needs-information';
  else if (setup.length) state = 'needs-setup';
  else state = 'ready-for-review';

  return {
    plan,
    findings,
    state,
    stateLabel: DRAFT_STATES[state] || state,
    // Same rule as an agent draft: what the gateway would refuse may not be submitted, and a warning is
    // the reviewer's to weigh.
    canSubmit: state === 'ready-for-review' || state === 'needs-setup',
    canRun: blocked.length === 0,
    summary: {
      errors: errors.length, setup: setup.length,
      warnings: findings.filter((f) => f.severity === 'warning').length, info: info.length,
    },
  };
}

/**
 * The body `createSwarm` accepts, and only that. `executed`, `status`, `progress` and `spent` are absent
 * by construction rather than removed afterwards — a field that is never built cannot be smuggled in.
 */
export function toSwarmBody(planInput) {
  const { plan } = normalisePlan(planInput);
  const nodes = (plan.nodes.length ? plan.nodes : DEFAULT_NODES.map((n) => ({ ...n, agent: '' })))
    .slice(0, PLAN_LIMITS.nodes)
    .map((n, index) => ({ id: n.id || `n${index + 1}`, label: n.label || `node-${index + 1}`, agent: n.agent || '' }));
  return {
    name: plan.name || '',
    objective: plan.objective,
    teamId: plan.teamId,
    channel: plan.channel,
    topology: plan.topology,
    budgetCap: plan.budgetCap,
    nodes,
  };
}

/** One sentence a reviewer can read: what this plan is, and what approving it will store. */
export function summarisePlan(planInput, state = '') {
  const { plan } = normalisePlan(planInput);
  const nodes = plan.nodes.length ? `${plan.nodes.length} node${plan.nodes.length === 1 ? '' : 's'}` : 'the default node order';
  const label = DRAFT_STATES[state] || DRAFT_STATES[validatePlan(plan).state] || 'Draft';
  return `I drafted the plan “${plan.name || plan.objective.slice(0, 40) || 'untitled'}”. State: ${label}. `
    + `It has ${nodes} and a cap of ${plan.budgetCap}; saving it stores a planned swarm and starts nothing.`;
}

export function planInstruction() {
  return [
    'You turn a person’s description of a workflow into a swarm PLAN, as JSON and nothing else.',
    'A plan is an objective plus a node order. It is not a run and has no progress, spend or status.',
    'Reply with a single JSON object with exactly these keys:',
    '  name (string, <=120), objective (string, <=2000, what the plan achieves), teamId (string or null),',
    `  channel (one of ${PLAN_CHANNELS.join('|')}), topology (string, <=40), budgetCap (number, 0–${PLAN_LIMITS.budgetCap}),`,
    '  nodes (array of at most 24 objects: {id, label, agent}, where agent is an existing agent id or "").',
    'Omit or leave empty any key you cannot fill from the description. Never invent a team id, an agent id or',
    'a node; leave it out instead. Do not include commentary, markdown or code fences — JSON only.',
    'Facts about this build you must not contradict: no scheduler and no worker exist, so a plan never runs;',
    `saving a plan stores a swarm row with status "planned", zero progress and zero spend; a human approval`,
    'that you cannot grant is required before any plan is saved from a draft.',
  ].join('\n');
}

/** Pull a JSON object out of a model reply — the same reader every draft kind uses. */
export const parsePlanReply = parseDraftReply;

export { DRAFT_STATES, DRAFT_ONLY_STATES };
