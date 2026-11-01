/* Swarm-plan drafts: a conversation produces a plan, never a run.
 *
 * Unit 3 of the Copilot upgrade. The rule is the same shape as unit 2, applied to the other artefact a
 * workflow can be: a model writes JSON, the canonical validator decides what it means, submitting opens a
 * real approval gate, and activation — by a *different* principal — writes one `swarms` row through the
 * same `createSwarm` the Swarms screen uses.
 *
 * Three things this module deliberately does not do:
 *
 *   1. It does not define a plan schema. `packages/shared/swarmPlanDraft.js` validates exactly the fields
 *      `swarms.createSwarm` accepts, so a plan a Reviewer approves is always a plan the gateway can save.
 *   2. It does not touch `executed`, `progress`, `status` or spend. Activation calls `createSwarm`, which
 *      sets `executed = 0` and refuses any status that claims execution. There is no scheduler.
 *   3. It does not take a state from the client. Every write recomputes `findings` and `state` from the
 *      validator, so an approval cannot ride a stale verdict.
 */
import { db, audit, logEvent } from './db.js';
import * as models from './models.js';
import * as copilot from './copilot.js';
import * as swarms from './swarms.js';
import {
  normalisePlan, validatePlan, summarisePlan, planInstruction, parsePlanReply, toSwarmBody, PLAN_LIMITS,
} from '../../../packages/shared/swarmPlanDraft.js';
import { DRAFT_STATES, DRAFT_ONLY_STATES } from '../../../packages/shared/agentDraft.js';

const now = () => Date.now();
const fail = (code, message, extra = {}) => {
  throw Object.assign(new Error(message), { code, ...extra });
};
const parse = (value, fallback) => {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
};

const LIMITS = { drafts: 50, planBytes: 24 * 1024 };
export const KIND = 'swarm-plan';

/** Everything the validator may not assume. Read fresh, never passed in by a caller. */
export function validationContext() {
  return {
    teams: db.prepare(`SELECT t.id, t.name, (SELECT COUNT(*) FROM agents a WHERE a.team_id = t.id AND a.deleted_at IS NULL) AS members
                       FROM teams t ORDER BY t.name`).all()
      .map((t) => ({ id: t.id, name: t.name, members: Number(t.members) || 0 })),
    agents: db.prepare('SELECT id, name FROM agents WHERE deleted_at IS NULL').all(),
  };
}

function rowToDraft(row) {
  return {
    id: row.id,
    kind: row.kind || KIND,
    state: row.state,
    stateLabel: DRAFT_STATES[row.state] || row.state,
    source: row.source,
    plan: parse(row.plan, {}),
    findings: parse(row.findings, []),
    conversationId: row.conversation_id || '',
    approvalId: row.approval_id || null,
    swarmId: row.swarm_id || null,
    modelCallId: row.model_call_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at || null,
    activatedAt: row.activated_at || null,
    archivedAt: row.archived_at || null,
  };
}

/** A plan draft belongs to the principal who asked for it; an Owner may read any, nobody may edit another's. */
function draftRow(id, principalId, { role = '' } = {}) {
  const row = db.prepare('SELECT * FROM swarm_plan_drafts WHERE id=?').get(String(id || ''));
  if (!row) fail('not-found', `plan draft “${id}” does not exist`);
  if (row.owner_id !== principalId && role !== 'Owner') fail('not-found', `plan draft “${id}” does not exist`);
  return row;
}

function canEdit(row) {
  // Once a plan is with a reviewer or saved, its content is frozen: an approver must be looking at what
  // will be saved, not at what it used to say.
  if (['awaiting-approval', 'active', 'archived'].includes(row.state)) {
    fail('conflict', `this plan draft is ${DRAFT_STATES[row.state].toLowerCase()} — it can no longer be edited`);
  }
}

function decorate(row, check) {
  const draft = rowToDraft(row);
  return {
    ...draft,
    canSubmit: check.canSubmit,
    canRun: check.canRun,
    summary: check.summary,
    states: DRAFT_ONLY_STATES,
  };
}

function validateAndStore(row, patch = {}) {
  const plan = patch.plan || parse(row.plan, {});
  const check = validatePlan(plan, validationContext());
  db.prepare('UPDATE swarm_plan_drafts SET plan=?, findings=?, state=?, updated_at=? WHERE id=?')
    .run(JSON.stringify(check.plan), JSON.stringify(check.findings), check.state, now(), row.id);
  return decorate(db.prepare('SELECT * FROM swarm_plan_drafts WHERE id=?').get(row.id), check);
}

export function list({ principalId, role = '', limit = 20 } = {}) {
  const take = Math.min(Math.max(Number(limit) || 20, 1), LIMITS.drafts);
  const rows = role === 'Owner'
    ? db.prepare('SELECT * FROM swarm_plan_drafts ORDER BY updated_at DESC LIMIT ?').all(take)
    : db.prepare('SELECT * FROM swarm_plan_drafts WHERE owner_id=? ORDER BY updated_at DESC LIMIT ?').all(principalId, take);
  return rows.map((row) => decorate(row, validatePlan(parse(row.plan, {}), validationContext())));
}

export function get(id, { principalId, role = '' } = {}) {
  const row = draftRow(id, principalId, { role });
  return decorate(row, validatePlan(parse(row.plan, {}), validationContext()));
}

/** Create a plan draft from a plan object (the API's direct path). */
export function create({ principalId, via = 'api', plan, source = 'api', conversationId = '', modelCallId = null } = {}) {
  const { plan: clean, dropped } = normalisePlan(plan);
  if (JSON.stringify(clean).length > LIMITS.planBytes) fail('bad-request', 'that plan is too large to store as a draft');
  const check = validatePlan(clean, validationContext());
  const id = `pd-${now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(`INSERT INTO swarm_plan_drafts (id,owner_id,conversation_id,kind,source,state,plan,findings,approval_id,swarm_id,model_call_id,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,NULL,NULL,?,?,?)`)
    .run(id, principalId, conversationId, KIND, source, check.state, JSON.stringify(check.plan), JSON.stringify(check.findings), modelCallId, now(), now());
  audit(principalId, via, 'copilot.plan.create', { id, state: check.state, dropped: dropped.length }, 'allow', 'ok');
  logEvent('copilot', `Swarm-plan draft created (${DRAFT_STATES[check.state]}) by ${principalId}`, id);
  return { ...decorate(db.prepare('SELECT * FROM swarm_plan_drafts WHERE id=?').get(id), check), dropped };
}

/** Edit a plan draft. State and findings are recomputed; a client cannot send a state of its own. */
export function update(id, { principalId, role = '', via = 'api', plan } = {}) {
  const row = draftRow(id, principalId, { role });
  canEdit(row);
  if (row.owner_id !== principalId && role !== 'Owner') fail('forbidden', 'only the person who created a plan draft may edit it');
  if (plan && JSON.stringify(plan).length > LIMITS.planBytes) fail('bad-request', 'that plan is too large to store as a draft');
  const patch = plan ? { plan: normalisePlan(plan).plan } : {};
  const out = validateAndStore(row, patch);
  audit(principalId, via, 'copilot.plan.update', { id, state: out.state }, 'allow', 'ok');
  return out;
}

export function archive(id, { principalId, role = '', via = 'api' } = {}) {
  const row = draftRow(id, principalId, { role });
  if (row.state === 'active') fail('conflict', 'this plan was already saved as a swarm — archive the swarm, not the draft');
  if (row.state === 'archived') return decorate(row, validatePlan(parse(row.plan, {}), validationContext()));
  db.prepare('UPDATE swarm_plan_drafts SET state=?, archived_at=?, updated_at=? WHERE id=?').run('archived', now(), now(), row.id);
  audit(principalId, via, 'copilot.plan.archive', { id }, 'allow', 'ok');
  return decorate(db.prepare('SELECT * FROM swarm_plan_drafts WHERE id=?').get(row.id), validatePlan(parse(row.plan, {}), validationContext()));
}

/**
 * Ask for approval. The row goes into the same `approvals` table the Approvals screen reads, with an
 * action name that says what activation will do — saving a plan, not starting one.
 */
export function submit(id, { principalId, role = '', via = 'api', name = '' } = {}) {
  const row = draftRow(id, principalId, { role });
  if (row.state === 'awaiting-approval') return get(id, { principalId, role });
  if (row.state === 'active') fail('conflict', 'this plan draft has already been saved as a swarm');
  if (row.state === 'archived') fail('conflict', 'an archived plan draft cannot be submitted');
  const current = validateAndStore(row);
  if (!current.canSubmit) {
    fail('conflict', `this plan draft is ${current.stateLabel.toLowerCase()}, so it cannot be submitted for approval`, { draft: current });
  }
  const approvalId = `ap-${now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  const plan = current.plan;
  db.prepare(`INSERT INTO approvals (id, action, target, risk, principal, evidence, status, created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(
      approvalId, 'swarm.plan.save', id, 'medium', name || principalId,
      `Plan “${plan.name || plan.objective.slice(0, 40)}” · ${plan.nodes.length || 'default'} node(s) · cap ${plan.budgetCap} · saving stores a planned swarm and starts nothing`,
      'pending', now()
    );
  db.prepare('UPDATE swarm_plan_drafts SET state=?, approval_id=?, submitted_at=?, updated_at=? WHERE id=?')
    .run('awaiting-approval', approvalId, now(), now(), id);
  audit(principalId, via, 'copilot.plan.submit', { id, approvalId }, 'allow', 'ok');
  logEvent('copilot', `Swarm-plan draft submitted for approval by ${name || principalId}`, id);
  return { ...get(id, { principalId, role }), approval: db.prepare('SELECT * FROM approvals WHERE id=?').get(approvalId) };
}

/**
 * Whether this plan may be saved as a swarm, and why not. Pure read: the route performs the save, so
 * activation has exactly one write path (and it is `createSwarm`, not a second insert).
 */
export function activationCheck(id, { principalId, role = '' } = {}) {
  const row = draftRow(id, principalId, { role });
  const draft = get(id, { principalId, role });
  if (row.state === 'active') fail('conflict', 'this plan draft has already been saved as a swarm', { draft });
  if (row.state !== 'awaiting-approval') {
    fail('conflict', `this plan draft is ${draft.stateLabel.toLowerCase()} — submit it for approval first`, { draft });
  }
  const approval = db.prepare('SELECT * FROM approvals WHERE id=?').get(row.approval_id || '');
  if (!approval) fail('conflict', 'this plan draft has no approval row, so it cannot be saved', { draft });
  if (approval.status === 'denied') fail('forbidden', 'the approval for this plan was denied', { draft, approval });
  if (approval.status !== 'allowed') fail('conflict', 'the approval for this plan is still pending', { draft, approval });
  const check = validatePlan(parse(row.plan, {}), validationContext());
  if (!check.canSubmit) {
    fail('conflict', `the plan is ${check.state} now, so saving it would store an invalid swarm`, { draft, findings: check.findings });
  }
  return { row, draft, approval, plan: check.plan };
}

/** Mark a plan draft active after the route saved its swarm. The only state an activation can set. */
export function markActive(id, { swarmId, principalId, via = 'api' }) {
  db.prepare('UPDATE swarm_plan_drafts SET state=?, swarm_id=?, activated_at=?, updated_at=? WHERE id=?')
    .run('active', swarmId, now(), now(), id);
  audit(principalId, via, 'copilot.plan.activate', { id, swarmId }, 'allow', 'ok');
  logEvent('copilot', `Swarm-plan draft saved as a swarm plan → ${swarmId} (not executed)`, id);
  return decorate(db.prepare('SELECT * FROM swarm_plan_drafts WHERE id=?').get(id), validatePlan(parse(db.prepare('SELECT * FROM swarm_plan_drafts WHERE id=?').get(id).plan, {}), validationContext()));
}

/** The one write path for saving a plan: `swarms.createSwarm`, which sets `executed = 0` and nothing else. */
export function saveAsSwarm(plan, principalId) {
  // `toSwarmBody` emits only the fields `createSwarm` accepts — no `v`, no state, no execution claim. The
  // alternative (sending the whole draft plan and hoping) is how a draft-only field would end up refused
  // by the very route activation depends on.
  return swarms.createSwarm(toSwarmBody(plan), principalId);
}

/**
 * Turn one conversational turn into a plan draft. The model writes JSON, the validator decides, and the
 * turn is stored like any other so the transcript explains where the plan came from. A reply that cannot
 * be read as a plan stores no draft and says so.
 */
export async function fromConversation({ principalId, via = 'api', text, route = '', clientId = '' } = {}) {
  const body = String(text || '').trim();
  if (!body) fail('bad-request', 'say what the workflow should do');
  if (body.length > PLAN_LIMITS.instruction) fail('bad-request', `a plan instruction longer than ${PLAN_LIMITS.instruction} characters is refused`);

  const resolved = copilot.resolveModel();
  if (!resolved.configured) {
    fail('no-model', `${resolved.reason} Nothing was sent anywhere and no plan was drafted.`, { runtime: copilot.runtimeStatus() });
  }

  const thread = copilot.conversationFor(principalId);
  const userRow = copilot.storeUserTurn(thread.id, { text: body, clientId, principalId, via });
  const messages = [
    { role: 'system', content: planInstruction() },
    ...copilot.historyFor(thread.id, { excludeId: userRow.id }),
    { role: 'user', content: body },
  ];

  let out;
  try {
    out = await models.callModel({
      providerId: resolved.providerId, model: resolved.model, messages,
      purpose: 'copilot.plan', maxTokens: 900, principal: principalId, via,
    });
  } catch (error) {
    const runtime = copilot.runtimeStatus();
    if (error.code === 'budget-exceeded' || error.code === 'unconfigured') fail(error.code, error.message, { runtime });
    fail(error.code === 'timeout' ? 'timeout' : 'bad-gateway', error.message, { runtime });
  }

  const parsed = parsePlanReply(out.text);
  const usage = {
    model: out.model, promptTokens: out.usage.promptTokens, completionTokens: out.usage.completionTokens,
    costUsd: out.costUsd, costBasis: out.costBasis, latencyMs: out.latencyMs, callId: out.callId,
  };

  if (!parsed.ok) {
    // The refusal is a real turn with a real call id, so the transcript and the ledger agree — and no
    // plan is invented from a reply that could not be read.
    const replyRow = copilot.storeModelTurn(thread.id, {
      text: `I could not turn that into a plan: ${parsed.reason}. Nothing was created. Try describing the workflow in one sentence, e.g. “a plan that researches a topic and drafts a brief”.`,
      callId: out.callId, payload: { ...usage, planError: parsed.reason },
    });
    fail('unusable-draft', `the model’s reply could not be read as a plan (${parsed.reason})`, {
      runtime: copilot.runtimeStatus(), usage, reply: copilot.publicMessage(replyRow), userMessage: copilot.publicMessage(userRow),
    });
  }

  const created = create({
    principalId, via, plan: parsed.value, source: 'copilot', conversationId: thread.id, modelCallId: out.callId,
  });
  const replyRow = copilot.storeModelTurn(thread.id, {
    text: summarisePlan(created.plan, created.state),
    callId: out.callId,
    payload: { ...usage, draftId: created.id, draftKind: KIND, draftState: created.state },
  });
  return {
    draft: created,
    usage,
    runtime: copilot.runtimeStatus(),
    userMessage: copilot.publicMessage(userRow),
    reply: copilot.publicMessage(replyRow),
  };
}

export { DRAFT_STATES, DRAFT_ONLY_STATES, KIND as DRAFT_KIND };
