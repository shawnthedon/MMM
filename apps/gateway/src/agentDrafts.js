/* Agent drafts: a conversation produces a definition, never an agent.
 *
 * The rule this module exists to keep: a model may write JSON, and a person may edit it, but nothing
 * becomes an agent until a *different* human allowed it through an approval gate. Everything here is
 * therefore one of four things — store, validate, request approval, activate — and the last one refuses
 * unless the gate says allowed.
 *
 * The state of a draft is never taken from the client. It is recomputed from the canonical validator in
 * `packages/shared/agentDraft.js` on every write, so an edit cannot leave a stale "ready" behind.
 */
import { db, audit, logEvent } from './db.js';
import * as models from './models.js';
import * as copilot from './copilot.js';
import {
  DRAFT_STATES, DRAFT_ONLY_STATES, LIMITS as DRAFT_LIMITS, normaliseSpec, validateSpec,
  toAgentRecord, parseDraftReply, draftInstruction,
} from '../../../packages/shared/agentDraft.js';

const now = () => Date.now();
const fail = (code, message, extra = {}) => {
  throw Object.assign(new Error(message), { code, ...extra });
};
const parse = (value, fallback) => {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
};

const LIMITS = { drafts: 50, specBytes: 16 * 1024 };

/** Everything the validator is not allowed to assume, read fresh from the gateway. */
export function validationContext() {
  const providers = db.prepare('SELECT id,name,default_model,key_sealed,endpoint FROM providers').all().map((p) => ({
    id: p.id,
    name: p.name,
    defaultModel: p.default_model || '',
    configured: Boolean(p.key_sealed) && Boolean(p.endpoint),
    status: Boolean(p.key_sealed) && Boolean(p.endpoint) ? 'configured' : 'unconfigured',
  }));
  return {
    agents: db.prepare('SELECT name FROM agents WHERE deleted_at IS NULL').all(),
    providers,
    skills: db.prepare('SELECT id FROM skills').all(),
    plugins: db.prepare('SELECT id, installed FROM plugins').all(),
    // No adapter exists for any framework. Reporting it as an empty list — rather than a list of the
    // frameworks the designer offers — is what makes "this cannot run" a computed fact.
    runtimes: [],
  };
}

function rowToDraft(row) {
  const spec = parse(row.spec, {});
  const findings = parse(row.findings, []);
  return {
    id: row.id,
    state: row.state,
    stateLabel: DRAFT_STATES[row.state] || row.state,
    source: row.source,
    spec,
    findings,
    conversationId: row.conversation_id || '',
    approvalId: row.approval_id || null,
    agentId: row.agent_id || null,
    modelCallId: row.model_call_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at || null,
    activatedAt: row.activated_at || null,
    archivedAt: row.archived_at || null,
  };
}

/** A draft belongs to the principal who asked for it. An Owner may read any; nobody may edit another's. */
function draftRow(id, principalId, { role = '' } = {}) {
  const row = db.prepare('SELECT * FROM agent_drafts WHERE id=?').get(String(id || ''));
  if (!row) fail('not-found', `draft “${id}” does not exist`);
  if (row.owner_id !== principalId && role !== 'Owner') fail('not-found', `draft “${id}” does not exist`);
  return row;
}

function canEdit(row, principalId, role) {
  // Once a draft is with a reviewer or active, its definition is frozen: a person must not be able to
  // change what an approver is looking at, or what was activated.
  if (['awaiting-approval', 'active', 'archived'].includes(row.state)) {
    fail('conflict', `this draft is ${DRAFT_STATES[row.state].toLowerCase()} — it can no longer be edited`);
  }
  if (row.owner_id !== principalId && role !== 'Owner') fail('forbidden', 'only the person who created a draft may edit it');
}

function validateAndStore(row, patch = {}) {
  const spec = patch.spec || parse(row.spec, {});
  const check = validateSpec(spec, validationContext());
  const updatedAt = now();
  db.prepare('UPDATE agent_drafts SET spec=?, findings=?, state=?, updated_at=? WHERE id=?')
    .run(JSON.stringify(check.spec), JSON.stringify(check.findings), check.state, updatedAt, row.id);
  return { ...rowToDraft(db.prepare('SELECT * FROM agent_drafts WHERE id=?').get(row.id)), canSubmit: check.canSubmit, canRun: check.canRun, summary: check.summary };
}

export function list({ principalId, role = '', limit = 20 } = {}) {
  const take = Math.min(Math.max(Number(limit) || 20, 1), LIMITS.drafts);
  const rows = role === 'Owner'
    ? db.prepare('SELECT * FROM agent_drafts ORDER BY updated_at DESC LIMIT ?').all(take)
    : db.prepare('SELECT * FROM agent_drafts WHERE owner_id=? ORDER BY updated_at DESC LIMIT ?').all(principalId, take);
  return rows.map(rowToDraft);
}

export function get(id, { principalId, role = '' } = {}) {
  const row = draftRow(id, principalId, { role });
  const spec = parse(row.spec, {});
  const check = validateSpec(spec, validationContext());
  return { ...rowToDraft(row), canSubmit: check.canSubmit, canRun: check.canRun, summary: check.summary, states: DRAFT_ONLY_STATES };
}

/** Create a draft from a spec a person wrote (the visual builder's save-back path). */
export function create({ principalId, via = 'api', spec, source = 'designer', conversationId = '', modelCallId = null } = {}) {
  const { spec: clean, dropped } = normaliseSpec(spec);
  if (JSON.stringify(clean).length > LIMITS.specBytes) fail('bad-request', 'that definition is too large to store as a draft');
  const check = validateSpec(clean, validationContext());
  const id = `dr-${now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(`INSERT INTO agent_drafts (id,owner_id,conversation_id,source,state,spec,findings,approval_id,agent_id,model_call_id,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,NULL,NULL,?,?,?)`)
    .run(id, principalId, conversationId, source, check.state, JSON.stringify(check.spec), JSON.stringify(check.findings), modelCallId, now(), now());
  audit(principalId, via, 'copilot.draft.create', { id, state: check.state, dropped: dropped.length }, 'allow', 'ok');
  logEvent('copilot', `Agent draft created (${DRAFT_STATES[check.state]}) by ${principalId}`, id);
  return { ...rowToDraft(db.prepare('SELECT * FROM agent_drafts WHERE id=?').get(id)), canSubmit: check.canSubmit, canRun: check.canRun, summary: check.summary, dropped };
}

/** Edit a draft. The state and findings are recomputed; a client cannot send a state of its own. */
export function update(id, { principalId, role = '', via = 'api', spec } = {}) {
  const row = draftRow(id, principalId, { role });
  canEdit(row, principalId, role);
  if (spec && JSON.stringify(spec).length > LIMITS.specBytes) fail('bad-request', 'that definition is too large to store as a draft');
  const patch = spec ? { spec: normaliseSpec(spec).spec } : {};
  const out = validateAndStore(row, patch);
  audit(principalId, via, 'copilot.draft.update', { id, state: out.state }, 'allow', 'ok');
  return out;
}

/** Reopen an archived draft as a fresh one — archiving is not a delete, and history stays readable. */
export function duplicate(id, { principalId, role = '', via = 'api' } = {}) {
  const row = draftRow(id, principalId, { role });
  return create({ principalId, via, spec: parse(row.spec, {}), source: 'copilot', conversationId: row.conversation_id || '' });
}

export function archive(id, { principalId, role = '', via = 'api' } = {}) {
  const row = draftRow(id, principalId, { role });
  if (row.state === 'active') fail('conflict', 'an activated draft is a record of what was created — archive it from the agent, not here');
  if (row.state === 'archived') return rowToDraft(row);
  db.prepare('UPDATE agent_drafts SET state=?, archived_at=?, updated_at=? WHERE id=?').run('archived', now(), now(), row.id);
  audit(principalId, via, 'copilot.draft.archive', { id }, 'allow', 'ok');
  return rowToDraft(db.prepare('SELECT * FROM agent_drafts WHERE id=?').get(row.id));
}

/**
 * Ask for approval. This creates a real `approvals` row — the same table the Approvals screen reads and
 * the same one a Reviewer decides — so there is no second, softer gate hiding behind the Copilot.
 */
export function submit(id, { principalId, role = '', via = 'api', name = '' } = {}) {
  const row = draftRow(id, principalId, { role });
  if (row.state === 'awaiting-approval') return get(id, { principalId, role });
  if (row.state === 'active') fail('conflict', 'this draft is already active');
  if (row.state === 'archived') fail('conflict', 'an archived draft cannot be submitted');
  const current = validateAndStore(row);
  if (!current.canSubmit) {
    fail('conflict', `this draft is ${current.stateLabel.toLowerCase()}, so it cannot be submitted for approval`, { draft: current });
  }
  const approvalId = `ap-${now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  db.prepare(`INSERT INTO approvals (id, action, target, risk, principal, evidence, status, created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(
      approvalId, 'agent.draft.activate', id, 'medium', name || principalId,
      `Draft “${current.spec.name}” · autonomy L${current.spec.autonomy} · model ${current.spec.model || 'none'}`,
      'pending', now()
    );
  db.prepare('UPDATE agent_drafts SET state=?, approval_id=?, submitted_at=?, updated_at=? WHERE id=?')
    .run('awaiting-approval', approvalId, now(), now(), id);
  audit(principalId, via, 'copilot.draft.submit', { id, approvalId }, 'allow', 'ok');
  logEvent('copilot', `Agent draft submitted for approval by ${name || principalId}`, id);
  return { ...get(id, { principalId, role }), approval: db.prepare('SELECT * FROM approvals WHERE id=?').get(approvalId) };
}

/**
 * Whether this draft may be turned into an agent, and why not. Pure read: the caller (the route) decides
 * and does the insert, so activation has exactly one write path in the codebase.
 */
export function activationCheck(id, { principalId, role = '' } = {}) {
  const row = draftRow(id, principalId, { role });
  const draft = get(id, { principalId, role });
  if (row.state === 'active') fail('conflict', 'this draft has already been activated', { draft });
  if (row.state !== 'awaiting-approval') {
    fail('conflict', `this draft is ${draft.stateLabel.toLowerCase()} — submit it for approval first`, { draft });
  }
  const approval = db.prepare('SELECT * FROM approvals WHERE id=?').get(row.approval_id || '');
  if (!approval) fail('conflict', 'this draft has no approval row, so it cannot be activated', { draft });
  if (approval.status === 'denied') fail('forbidden', 'the approval for this draft was denied', { draft, approval });
  if (approval.status !== 'allowed') fail('conflict', 'the approval for this draft is still pending', { draft, approval });
  const check = validateSpec(parse(row.spec, {}), validationContext());
  if (!check.canSubmit) fail('conflict', `the draft is ${check.state} now, so activation would store an invalid agent`, { draft, findings: check.findings });
  return { row, draft, approval, record: toAgentRecord(check.spec) };
}

/** Mark a draft active after the route created its agent. The only state an activation can set. */
export function markActive(id, { agentId, principalId, via = 'api' }) {
  db.prepare('UPDATE agent_drafts SET state=?, agent_id=?, activated_at=?, updated_at=? WHERE id=?')
    .run('active', agentId, now(), now(), id);
  audit(principalId, via, 'copilot.draft.activate', { id, agentId }, 'allow', 'ok');
  logEvent('copilot', `Agent draft activated → ${agentId}`, id);
  return rowToDraft(db.prepare('SELECT * FROM agent_drafts WHERE id=?').get(id));
}

/**
 * Turn one conversational turn into a draft: the model writes JSON, the canonical validator decides what
 * it means, and the turn is stored like any other so the transcript explains where the draft came from.
 * A model reply that is not usable JSON is reported as such — and stores no draft at all.
 */
export async function fromConversation({ principalId, via = 'api', text, route = '', clientId = '' } = {}) {
  const body = String(text || '').trim();
  if (!body) fail('bad-request', 'say what the agent should do');
  if (body.length > DRAFT_LIMITS.instruction) fail('bad-request', `a draft instruction longer than ${DRAFT_LIMITS.instruction} characters is refused`);

  const resolved = copilot.resolveModel();
  if (!resolved.configured) {
    fail('no-model', `${resolved.reason} Nothing was sent anywhere and no draft was created.`, { runtime: copilot.runtimeStatus() });
  }

  const thread = copilot.conversationFor(principalId);
  const userRow = copilot.storeUserTurn(thread.id, { text: body, clientId, principalId, via });
  const history = copilot.historyFor(thread.id, { excludeId: userRow.id });
  const messages = [
    { role: 'system', content: draftInstruction() },
    ...history,
    { role: 'user', content: body },
  ];

  let out;
  try {
    out = await models.callModel({
      providerId: resolved.providerId, model: resolved.model, messages,
      purpose: 'copilot.draft', maxTokens: 900, principal: principalId, via,
    });
  } catch (error) {
    const runtime = copilot.runtimeStatus();
    if (error.code === 'budget-exceeded' || error.code === 'unconfigured') {
      fail(error.code, error.message, { runtime });
    }
    fail(error.code === 'timeout' ? 'timeout' : 'bad-gateway', error.message, { runtime });
  }

  const parsed = parseDraftReply(out.text);
  const usage = {
    model: out.model, promptTokens: out.usage.promptTokens, completionTokens: out.usage.completionTokens,
    costUsd: out.costUsd, costBasis: out.costBasis, latencyMs: out.latencyMs, callId: out.callId,
  };

  if (!parsed.ok) {
    // The refusal is a real turn with a real call id, so the ledger and the transcript agree about what
    // happened, and no draft is invented from a reply that could not be read.
    const replyRow = copilot.storeModelTurn(thread.id, {
      text: `I could not turn that into a draft: ${parsed.reason}. Nothing was created. Try describing the agent in one sentence, e.g. “an agent that triages inbound support tickets”.`,
      callId: out.callId, payload: { ...usage, draftError: parsed.reason },
    });
    fail('unusable-draft', `the model’s reply could not be read as a draft (${parsed.reason})`, {
      runtime: copilot.runtimeStatus(), usage, reply: copilot.publicMessage(replyRow), userMessage: copilot.publicMessage(userRow),
    });
  }

  const created = create({
    principalId, via, spec: parsed.value, source: 'copilot', conversationId: thread.id, modelCallId: out.callId,
  });
  const replyRow = copilot.storeModelTurn(thread.id, {
    text: summarise(created),
    callId: out.callId,
    payload: { ...usage, draftId: created.id, draftState: created.state },
  });
  return {
    draft: created,
    usage,
    runtime: copilot.runtimeStatus(),
    userMessage: copilot.publicMessage(userRow),
    reply: copilot.publicMessage(replyRow),
  };
}

function summarise(draft) {
  const s = draft.spec;
  const bits = [`I drafted ${s.name ? `“${s.name}”` : 'an agent'}${s.goal ? ` — ${s.goal}` : ''}.`];
  bits.push(`State: ${draft.stateLabel}.`);
  if (draft.summary?.errors) bits.push(`${draft.summary.errors} blocking issue(s).`);
  if (draft.summary?.setup) bits.push(`${draft.summary.setup} thing(s) need setup.`);
  bits.push('It is a draft: nothing was created, and activation needs a human approval.');
  return bits.join(' ');
}

/**
 * Routing-only owner lookup for live events. Deliberately *not* part of the serialised draft: the websocket
 * needs to know whose socket may hear about a row, and nobody needs to learn it from a response body.
 */
export function ownerOf(id) {
  const row = db.prepare('SELECT owner_id FROM agent_drafts WHERE id=?').get(String(id || ''));
  return row?.owner_id || '';
}
