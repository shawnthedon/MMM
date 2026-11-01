/* ============ Swarm-plan drafts, from the panel's side ============
 * A workflow in MMM is a swarm plan, so this module talks to `/copilot/plans` and nothing new. The rules
 * mirror `src/copilot/drafts.js` on purpose — same state vocabulary, same "offer only what the row and
 * the role allow" rule — because two artefacts with two different sets of manners would be worse than
 * one artefact with none.
 *
 * What is different, and has to be: saving a plan needs `swarm:write`, not `agent:write`. A Reviewer
 * decides the gate and never saves; an Operator saves and never decides their own.
 */
import { api, isApiMode } from '../api.js';
import { can, isAuthenticated } from '../auth.js';
import { DRAFT_STATES } from '../../packages/shared/agentDraft.js';

const state = { plans: [], error: '', at: null };

export const planStates = DRAFT_STATES;
export const getPlans = () => state.plans.map((p) => ({ ...p }));
export const getError = () => state.error;
export const available = () => isApiMode() && isAuthenticated();

/** What the panel may offer for a plan draft, given its state and the reader's permissions. */
export function actionsFor(plan) {
  if (!plan) return [];
  const list = [];
  if (['ready-for-review', 'needs-setup', 'needs-information', 'invalid'].includes(plan.state)) {
    if (plan.canSubmit && can('copilot:write')) list.push({ act: 'plan-submit', label: 'Submit for approval', tone: 'primary' });
  }
  if (plan.state === 'awaiting-approval') {
    if (can('swarm:write')) list.push({ act: 'plan-save', label: 'Save as a plan (needs an allowed approval)', tone: 'primary' });
    if (can('approval:decide')) list.push({ act: 'plan-open-approvals', label: 'Review the gate', tone: '' });
  }
  if (!['active', 'archived'].includes(plan.state) && can('copilot:write')) {
    list.push({ act: 'plan-archive', label: 'Archive', tone: '' });
  }
  if (plan.swarmId) list.push({ act: 'plan-open-swarm', label: 'Open the plan', tone: '' });
  return list;
}

/** Read the caller's plan drafts. Never throws: a failure becomes `error`, which the panel shows. */
export async function load() {
  if (!available()) {
    state.plans = [];
    state.error = '';
    return { ok: false, reason: 'no-gateway' };
  }
  try {
    const out = await api.planList();
    state.plans = Array.isArray(out.body?.drafts) ? out.body.drafts : [];
    state.error = '';
    state.at = Date.now();
    return { ok: true, plans: state.plans };
  } catch (error) {
    state.error = error?.message || 'plan drafts could not be read';
    return { ok: false, error: state.error };
  }
}

function remember(plan) {
  if (!plan?.id) return plan;
  const i = state.plans.findIndex((p) => p.id === plan.id);
  if (i >= 0) state.plans[i] = plan;
  else state.plans.unshift(plan);
  return plan;
}

/** Ask for a plan from a sentence. The plan returned is exactly what the gateway validated. */
export async function createFromText(text, { route = '' } = {}) {
  if (!available()) return { ok: false, reason: 'no-gateway', error: 'No gateway is connected, so no plan can be drafted.' };
  try {
    const out = await api.planFromText({ text, route });
    remember(out.body?.draft);
    return {
      ok: true, draft: out.body?.draft, usage: out.body?.usage || null,
      reply: out.body?.reply || null, userMessage: out.body?.userMessage || null,
    };
  } catch (error) {
    const body = error?.body || {};
    if (body.draft) remember(body.draft);
    return {
      ok: false,
      reason: error?.status === 409 ? 'no-model' : 'error',
      error: error?.message || 'the plan draft failed',
      draft: body.draft || null,
      reply: body.reply || null,
      userMessage: body.userMessage || null,
    };
  }
}

export async function submit(id) {
  try {
    const out = await api.planSubmit(id);
    return { ok: true, draft: remember(out.body) };
  } catch (error) {
    return { ok: false, error: error?.message || 'the plan was not submitted', draft: error?.body?.draft ? remember(error.body.draft) : null };
  }
}

/** Save the plan as a swarm. The route requires an allowed approval this principal did not decide. */
export async function save(id) {
  try {
    const out = await api.planSave(id);
    remember(out.body?.draft);
    return { ok: true, draft: out.body?.draft, swarm: out.body?.swarm };
  } catch (error) {
    return { ok: false, error: error?.message || 'the plan was not saved', draft: error?.body?.draft ? remember(error.body.draft) : null };
  }
}

export async function archive(id) {
  try {
    const out = await api.planArchive(id);
    return { ok: true, draft: remember(out.body?.draft) };
  } catch (error) {
    return { ok: false, error: error?.message || 'the plan was not archived' };
  }
}

export function reset() {
  state.plans = [];
  state.error = '';
  state.at = null;
}

/** The plan a node-less sentence is about, for the panel's own card. */
export const describe = (plan) => `${plan?.plan?.name || plan?.plan?.objective?.slice(0, 40) || 'untitled plan'}`;
