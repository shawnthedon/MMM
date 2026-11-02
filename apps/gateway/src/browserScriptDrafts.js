/* Browser script drafts: a conversation writes a script, a different human allows it, and only then does
 * anything open a page.
 *
 * This is unit 4 of the Copilot upgrade, and it is the first artefact whose activation *executes*. That
 * one fact shapes everything below:
 *
 *   • a script with no available engine is `blocked` and cannot be submitted — an approval nothing could
 *     execute is theatre, and this module will not stage it;
 *   • activation re-validates and then calls `browserRunner.createTask`, the same function
 *     `POST /browser/tasks` calls, so there is exactly one way a task is born;
 *   • the draft never stores a status or a progress number: it reads the `browser_tasks` row live, so the
 *     card cannot show "running" for something that stopped ten minutes ago.
 *
 * The model writes JSON; the validator in `packages/shared/browserScript.js` decides what it means. No
 * page content is ever consulted here, and there is no path from a page to a step.
 */
import { db, audit, logEvent } from './db.js';
import * as models from './models.js';
import * as copilot from './copilot.js';
import { driverCapabilities } from './browser/driver.js';
import { runner as browserRunner } from './browser/index.js';
import {
  normaliseScript, validateScript, previewScript, toTaskBody, summariseScript, scriptInstruction,
  parseScriptReply, SCRIPT_LIMITS,
} from '../../../packages/shared/browserScript.js';
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

const LIMITS = { drafts: 50, scriptBytes: 24 * 1024 };

/**
 * Drivers that could actually run a task right now. Cached for a few seconds: `driverCapabilities()`
 * probes the filesystem and imports puppeteer-core, and the draft list would otherwise pay for that on
 * every row. A stale cache can only make the answer *pessimistic* for a few seconds, never optimistic —
 * activation re-checks the real runner.
 */
let engineCache = { at: 0, engines: [] };
export async function availableEngines({ fresh = false } = {}) {
  const ttl = 5000;
  if (!fresh && now() - engineCache.at < ttl) return engineCache.engines;
  const caps = await driverCapabilities();
  engineCache = {
    at: now(),
    engines: caps.filter((c) => c.available).map((c) => ({ id: c.id, kind: c.kind, label: c.label, reason: c.reason })),
  };
  return engineCache.engines;
}

/** A live snapshot of the task this script became. Read through, never copied into the draft. */
function taskSnapshot(taskId) {
  if (!taskId) return null;
  const row = db.prepare('SELECT * FROM browser_tasks WHERE id=?').get(String(taskId));
  if (!row) return null;
  const evidence = db.prepare('SELECT COUNT(*) n FROM browser_evidence WHERE task_id=?').get(row.id).n;
  return {
    id: row.id,
    status: row.status,
    driver: row.driver,
    simulated: row.driver === 'simulated',
    outcome: row.outcome || '',
    blocker: row.blocker || '',
    blockerKind: row.blocker_kind || '',
    stepIndex: Number(row.step_index) || 0,
    totalSteps: parse(row.plan, []).length,
    currentUrl: row.current_url || '',
    evidenceCount: Number(evidence) || 0,
    startedAt: row.started_at || null,
    endedAt: row.ended_at || null,
  };
}

function decorate(row, check) {
  const script = parse(row.script, {});
  return {
    id: row.id,
    kind: 'browser-script',
    state: row.state,
    stateLabel: DRAFT_STATES[row.state] || row.state,
    source: row.source,
    script,
    // Derived on every read from the structured steps — never from the model's own `describe` prose.
    preview: previewScript(script),
    findings: check.findings,
    conversationId: row.conversation_id || '',
    approvalId: row.approval_id || null,
    taskId: row.task_id || null,
    task: taskSnapshot(row.task_id),
    modelCallId: row.model_call_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at || null,
    activatedAt: row.activated_at || null,
    archivedAt: row.archived_at || null,
    canSubmit: check.canSubmit,
    canRun: check.canRun,
    summary: check.summary,
    engines: check.engines,
    states: DRAFT_ONLY_STATES,
  };
}

function draftRow(id, principalId, { role = '' } = {}) {
  const row = db.prepare('SELECT * FROM browser_script_drafts WHERE id=?').get(String(id || ''));
  if (!row) fail('not-found', `script draft “${id}” does not exist`);
  if (row.owner_id !== principalId && role !== 'Owner') fail('not-found', `script draft “${id}” does not exist`);
  return row;
}

function canEdit(row) {
  if (['awaiting-approval', 'active', 'archived'].includes(row.state)) {
    fail('conflict', `this script draft is ${DRAFT_STATES[row.state].toLowerCase()} — it can no longer be edited`);
  }
}

async function validateAndStore(row, patch = {}) {
  const engines = await availableEngines();
  const script = patch.script || parse(row.script, {});
  const check = validateScript(script, { engines });
  db.prepare('UPDATE browser_script_drafts SET script=?, findings=?, state=?, updated_at=? WHERE id=?')
    .run(JSON.stringify(check.script), JSON.stringify(check.findings), check.state, now(), row.id);
  return decorate(db.prepare('SELECT * FROM browser_script_drafts WHERE id=?').get(row.id), check);
}

export async function list({ principalId, role = '', limit = 20 } = {}) {
  const take = Math.min(Math.max(Number(limit) || 20, 1), LIMITS.drafts);
  const engines = await availableEngines();
  const rows = role === 'Owner'
    ? db.prepare('SELECT * FROM browser_script_drafts ORDER BY updated_at DESC LIMIT ?').all(take)
    : db.prepare('SELECT * FROM browser_script_drafts WHERE owner_id=? ORDER BY updated_at DESC LIMIT ?').all(principalId, take);
  return rows.map((row) => decorate(row, validateScript(parse(row.script, {}), { engines })));
}

export async function get(id, { principalId, role = '' } = {}) {
  const row = draftRow(id, principalId, { role });
  const engines = await availableEngines();
  return decorate(row, validateScript(parse(row.script, {}), { engines }));
}

/** Create a script draft from a script object (the API's direct path — no model, no provider). */
export async function create({ principalId, via = 'api', script, source = 'api', conversationId = '', modelCallId = null } = {}) {
  const { script: clean, dropped } = normaliseScript(script);
  if (JSON.stringify(clean).length > LIMITS.scriptBytes) fail('bad-request', 'that script is too large to store as a draft');
  const engines = await availableEngines();
  const check = validateScript(clean, { engines });
  const id = `bs-${now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(`INSERT INTO browser_script_drafts (id,owner_id,conversation_id,source,state,script,findings,approval_id,task_id,model_call_id,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,NULL,NULL,?,?,?)`)
    .run(id, principalId, conversationId, source, check.state, JSON.stringify(check.script), JSON.stringify(check.findings), modelCallId, now(), now());
  audit(principalId, via, 'copilot.script.create', { id, state: check.state, dropped: dropped.length }, 'allow', 'ok');
  logEvent('copilot', `Browser script draft created (${DRAFT_STATES[check.state]}) by ${principalId}`, id);
  return { ...decorate(db.prepare('SELECT * FROM browser_script_drafts WHERE id=?').get(id), check), dropped };
}

export async function update(id, { principalId, role = '', via = 'api', script } = {}) {
  const row = draftRow(id, principalId, { role });
  canEdit(row);
  if (row.owner_id !== principalId && role !== 'Owner') fail('forbidden', 'only the person who created a script draft may edit it');
  if (script && JSON.stringify(script).length > LIMITS.scriptBytes) fail('bad-request', 'that script is too large to store as a draft');
  const patch = script ? { script: normaliseScript(script).script } : {};
  const out = await validateAndStore(row, patch);
  audit(principalId, via, 'copilot.script.update', { id, state: out.state }, 'allow', 'ok');
  return out;
}

export async function archive(id, { principalId, role = '', via = 'api' } = {}) {
  const row = draftRow(id, principalId, { role });
  if (row.state === 'active') fail('conflict', 'this script has already run — stop or archive the browser task, not the draft');
  if (row.state === 'archived') return get(id, { principalId, role });
  db.prepare('UPDATE browser_script_drafts SET state=?, archived_at=?, updated_at=? WHERE id=?').run('archived', now(), now(), row.id);
  audit(principalId, via, 'copilot.script.archive', { id }, 'allow', 'ok');
  return get(id, { principalId, role });
}

/**
 * Ask for approval. A real `approvals` row with an action that says what activation does — run a browser
 * task, not save a definition.
 */
export async function submit(id, { principalId, role = '', via = 'api', name = '' } = {}) {
  const row = draftRow(id, principalId, { role });
  if (row.state === 'awaiting-approval') return get(id, { principalId, role });
  if (row.state === 'active') fail('conflict', 'this script draft has already run');
  if (row.state === 'archived') fail('conflict', 'an archived script draft cannot be submitted');
  const current = await validateAndStore(row);
  if (!current.canSubmit) {
    fail('conflict', `this script draft is ${current.stateLabel.toLowerCase()}, so it cannot be submitted for approval`, { draft: current });
  }
  const approvalId = `ap-${now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  const preview = current.preview.slice(0, 4).map((p) => p.sentence).join(' → ');
  db.prepare(`INSERT INTO approvals (id, action, target, risk, principal, evidence, status, created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(
      approvalId, 'browser.script.run', id, 'high', name || principalId,
      `Script “${current.script.objective.slice(0, 80)}” · ${current.script.steps.length} step(s) · ${preview}`,
      'pending', now()
    );
  db.prepare('UPDATE browser_script_drafts SET state=?, approval_id=?, submitted_at=?, updated_at=? WHERE id=?')
    .run('awaiting-approval', approvalId, now(), now(), id);
  audit(principalId, via, 'copilot.script.submit', { id, approvalId }, 'allow', 'ok');
  logEvent('copilot', `Browser script draft submitted for approval by ${name || principalId}`, id);
  return { ...(await get(id, { principalId, role })), approval: db.prepare('SELECT * FROM approvals WHERE id=?').get(approvalId) };
}

/**
 * Whether this script may run, and why not. Pure read plus a fresh engine probe — the caller (the route)
 * queues the task, so a task has exactly one birth path (`browserRunner.createTask`).
 */
export async function activationCheck(id, { principalId, role = '' } = {}) {
  const row = draftRow(id, principalId, { role });
  const draft = await get(id, { principalId, role });
  if (row.state === 'active') fail('conflict', 'this script draft has already run', { draft });
  if (row.state !== 'awaiting-approval') {
    fail('conflict', `this script draft is ${draft.stateLabel.toLowerCase()} — submit it for approval first`, { draft });
  }
  const approval = db.prepare('SELECT * FROM approvals WHERE id=?').get(row.approval_id || '');
  if (!approval) fail('conflict', 'this script draft has no approval row, so it cannot run', { draft });
  if (approval.status === 'denied') fail('forbidden', 'the approval for this script was denied', { draft, approval });
  if (approval.status !== 'allowed') fail('conflict', 'the approval for this script is still pending', { draft, approval });
  const engines = await availableEngines({ fresh: true });
  const check = validateScript(parse(row.script, {}), { engines });
  if (!check.canSubmit) {
    fail('conflict', `the script is ${check.state} now, so running it would queue an invalid task`, { draft, findings: check.findings });
  }
  return { row, draft, approval, body: toTaskBody(check.script) };
}

/** Mark a draft active after the route queued its task. The only state an activation can set. */
export function markActive(id, { taskId, principalId, via = 'api' }) {
  db.prepare('UPDATE browser_script_drafts SET state=?, task_id=?, activated_at=?, updated_at=? WHERE id=?')
    .run('active', taskId, now(), now(), id);
  audit(principalId, via, 'copilot.script.activate', { id, taskId }, 'allow', 'ok');
  logEvent('copilot', `Browser script approved and queued → ${taskId}`, id);
  return id;
}

/**
 * The one write path for a task — the same function `POST /browser/tasks` calls.
 *
 * `toTaskBody` returns the HTTP body's shape (`successCriteria`), while `createTask` takes `criteria`;
 * the mapping is done here, once, because losing it silently would queue every task with no criteria and
 * every run would then end as "no-criteria". That is exactly the bug this line exists to prevent.
 */
export async function queueTask(body, principalId) {
  return browserRunner.createTask({
    ownerId: principalId,
    objective: body.objective,
    entryUrl: body.entryUrl,
    criteria: body.successCriteria,
    plan: body.plan,
    driver: 'auto',
  });
}

/**
 * Turn one conversational turn into a script draft. The model writes JSON, the validator decides, and the
 * turn is stored like any other so the transcript explains where the script came from. A reply that
 * cannot be read as a script stores no draft and says so — and is still metered.
 */
export async function fromConversation({ principalId, via = 'api', text, route = '', clientId = '' } = {}) {
  const body = String(text || '').trim();
  if (!body) fail('bad-request', 'say what the browser should do');
  if (body.length > SCRIPT_LIMITS.instruction) fail('bad-request', `a script instruction longer than ${SCRIPT_LIMITS.instruction} characters is refused`);

  const resolved = copilot.resolveModel();
  if (!resolved.configured) {
    fail('no-model', `${resolved.reason} Nothing was sent anywhere and no script was drafted.`, { runtime: copilot.runtimeStatus() });
  }

  const thread = copilot.conversationFor(principalId);
  const userRow = copilot.storeUserTurn(thread.id, { text: body, clientId, principalId, via });
  const messages = [
    { role: 'system', content: scriptInstruction() },
    ...copilot.historyFor(thread.id, { excludeId: userRow.id }),
    { role: 'user', content: body },
  ];

  let out;
  try {
    out = await models.callModel({
      providerId: resolved.providerId, model: resolved.model, messages,
      purpose: 'copilot.script', maxTokens: 1200, principal: principalId, via,
    });
  } catch (error) {
    const runtime = copilot.runtimeStatus();
    if (error.code === 'budget-exceeded' || error.code === 'unconfigured') fail(error.code, error.message, { runtime });
    fail(error.code === 'timeout' ? 'timeout' : 'bad-gateway', error.message, { runtime });
  }

  const parsed = parseScriptReply(out.text);
  const usage = {
    model: out.model, promptTokens: out.usage.promptTokens, completionTokens: out.usage.completionTokens,
    costUsd: out.costUsd, costBasis: out.costBasis, latencyMs: out.latencyMs, callId: out.callId,
  };

  if (!parsed.ok) {
    const replyRow = copilot.storeModelTurn(thread.id, {
      text: `I could not turn that into a browser script: ${parsed.reason}. Nothing was created and nothing ran. Try naming the page and what to read from it, e.g. “open example.com/pricing and tell me the Pro price”.`,
      callId: out.callId, payload: { ...usage, scriptError: parsed.reason },
    });
    fail('unusable-draft', `the model’s reply could not be read as a browser script (${parsed.reason})`, {
      runtime: copilot.runtimeStatus(), usage, reply: copilot.publicMessage(replyRow), userMessage: copilot.publicMessage(userRow),
    });
  }

  const created = await create({
    principalId, via, script: parsed.value, source: 'copilot', conversationId: thread.id, modelCallId: out.callId,
  });
  const replyRow = copilot.storeModelTurn(thread.id, {
    text: summariseScript(created.script, created.state),
    callId: out.callId,
    payload: { ...usage, draftId: created.id, draftKind: 'browser-script', draftState: created.state },
  });
  return {
    draft: created,
    usage,
    runtime: copilot.runtimeStatus(),
    userMessage: copilot.publicMessage(userRow),
    reply: copilot.publicMessage(replyRow),
  };
}

export { DRAFT_STATES, DRAFT_ONLY_STATES, LIMITS as SCRIPT_DRAFT_LIMITS };
