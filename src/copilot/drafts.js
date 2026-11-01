/* ============ Agent drafts, from the panel's side ============
 * A draft is a definition with an identity, a state and a history — not a card in a chat log. So the
 * client never keeps the truth: it asks the gateway, renders what it is told, and offers only the actions
 * the state allows.
 *
 * Two rules are enforced here rather than trusted to the server rendering:
 *   • a state shown is always one of the canonical states, taken from the row;
 *   • an action is only offered when the row says it is possible *and* the signed-in role could perform
 *     it. Offering a button that will 403 is a small lie that trains people to ignore errors.
 */
import { api, isApiMode } from '../api.js';
import { can, isAuthenticated } from '../auth.js';
import { DRAFT_STATES, toDesignerSeed } from '../../packages/shared/agentDraft.js';

const state = { drafts: [], loading: false, error: '', at: null };

export const draftStates = DRAFT_STATES;

export function getDrafts() {
  return state.drafts.map((d) => ({ ...d }));
}
export const getError = () => state.error;

/** What the panel is allowed to offer for a draft, given its state and the reader's permissions. */
export function actionsFor(draft) {
  if (!draft) return [];
  const list = [];
  if (draft.state === 'ready-for-review' || draft.state === 'needs-setup' || draft.state === 'invalid' || draft.state === 'needs-information') {
    if (draft.canSubmit && can('copilot:write')) list.push({ act: 'draft-submit', label: 'Submit for approval', tone: 'primary' });
  }
  if (draft.state === 'awaiting-approval') {
    if (can('agent:write')) list.push({ act: 'draft-activate', label: 'Activate (needs an allowed approval)', tone: 'primary' });
    if (can('approval:decide')) list.push({ act: 'draft-open-approvals', label: 'Review the gate', tone: '' });
  }
  if (!['active', 'archived'].includes(draft.state) && can('copilot:write')) {
    list.push({ act: 'draft-archive', label: 'Archive', tone: '' });
  }
  if (can('copilot:write')) list.push({ act: 'draft-open-designer', label: 'Open in the builder', tone: '' });
  if (draft.agentId) list.push({ act: 'draft-open-agent', label: 'Open the agent', tone: '' });
  return list;
}

export const available = () => isApiMode() && isAuthenticated();

/** Read the caller's drafts. Never throws: a failure becomes `error`, which the panel shows. */
export async function load() {
  if (!available()) {
    state.drafts = [];
    state.error = '';
    return { ok: false, reason: 'no-gateway' };
  }
  state.loading = true;
  try {
    const out = await api.draftList();
    state.drafts = Array.isArray(out.body?.drafts) ? out.body.drafts : [];
    state.error = '';
    state.at = Date.now();
    return { ok: true, drafts: state.drafts };
  } catch (error) {
    state.error = error?.message || 'drafts could not be read';
    return { ok: false, error: state.error };
  } finally {
    state.loading = false;
  }
}

function remember(draft) {
  if (!draft?.id) return draft;
  const i = state.drafts.findIndex((d) => d.id === draft.id);
  if (i >= 0) state.drafts[i] = draft;
  else state.drafts.unshift(draft);
  return draft;
}

/**
 * Ask for a draft from a sentence. Resolves to `{ok, draft, usage, reply, error, reason}`; the draft is
 * exactly what the gateway validated, never a locally assembled guess.
 */
export async function createFromText(text, { route = '' } = {}) {
  if (!available()) return { ok: false, reason: 'no-gateway', error: 'No gateway is connected, so no draft can be created.' };
  try {
    const out = await api.draftFromText({ text, route });
    remember(out.body?.draft);
    return { ok: true, draft: out.body?.draft, usage: out.body?.usage || null, reply: out.body?.reply || null, userMessage: out.body?.userMessage || null };
  } catch (error) {
    const body = error?.body || {};
    if (body.draft) remember(body.draft);
    return {
      ok: false,
      reason: error?.status === 409 ? 'no-model' : 'error',
      error: error?.message || 'the draft failed',
      draft: body.draft || null,
      reply: body.reply || null,
      userMessage: body.userMessage || null,
      findings: body.findings || null,
    };
  }
}

export async function submit(id) {
  try {
    const out = await api.draftSubmit(id);
    return { ok: true, draft: remember(out.body) };
  } catch (error) {
    return { ok: false, error: error?.message || 'the draft was not submitted', draft: error?.body?.draft ? remember(error.body.draft) : null };
  }
}

export async function activate(id) {
  try {
    const out = await api.draftActivate(id);
    remember(out.body?.draft);
    return { ok: true, draft: out.body?.draft, agent: out.body?.agent };
  } catch (error) {
    return { ok: false, error: error?.message || 'the draft was not activated', draft: error?.body?.draft ? remember(error.body.draft) : null };
  }
}

export async function archive(id) {
  try {
    const out = await api.draftArchive(id);
    return { ok: true, draft: remember(out.body?.draft) };
  } catch (error) {
    return { ok: false, error: error?.message || 'the draft was not archived' };
  }
}

export function reset() {
  state.drafts = [];
  state.error = '';
  state.at = null;
}

/** The seed the visual builder needs. Shared with the server by construction, not by copy. */
export const designerSeed = (draft) => toDesignerSeed(draft?.spec || {});
