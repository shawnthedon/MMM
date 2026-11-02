/* ============ Browser-script drafts, from the panel's side ============
 * A script is the one artefact whose approval *runs* something, so this module is stricter about what it
 * offers than its two siblings: `Run` appears only for `browser:run` on a script the gateway says is
 * awaiting approval, and the card it feeds shows the gateway's own plain-language preview rather than
 * anything assembled here.
 *
 * The preview comes from the server. Recomputing it in the browser would be a second implementation of
 * "what this step does", and the whole point of the preview is that there is exactly one.
 */
import { api, isApiMode } from '../api.js';
import { can, isAuthenticated } from '../auth.js';
import { DRAFT_STATES } from '../../packages/shared/agentDraft.js';

const state = { scripts: [], error: '', at: null };

export const scriptStates = DRAFT_STATES;
export const getScripts = () => state.scripts.map((s) => ({ ...s }));
export const getError = () => state.error;
export const available = () => isApiMode() && isAuthenticated();

/** What the panel may offer for a script draft, given its state and the reader's permissions. */
export function actionsFor(script) {
  if (!script) return [];
  const list = [];
  if (['ready-for-review', 'needs-setup', 'needs-information', 'invalid', 'blocked'].includes(script.state)) {
    if (script.canSubmit && can('copilot:write')) list.push({ act: 'script-submit', label: 'Submit for approval', tone: 'primary' });
  }
  if (script.state === 'awaiting-approval') {
    if (can('browser:run')) list.push({ act: 'script-run', label: 'Run this script (needs an allowed approval)', tone: 'primary' });
    if (can('approval:decide')) list.push({ act: 'script-open-approvals', label: 'Review the gate', tone: '' });
  }
  if (!['active', 'archived'].includes(script.state) && can('copilot:write')) {
    list.push({ act: 'script-archive', label: 'Archive', tone: '' });
  }
  if (script.taskId) list.push({ act: 'script-open-task', label: 'Open the task', tone: '' });
  return list;
}

export async function load() {
  if (!available()) {
    state.scripts = [];
    state.error = '';
    return { ok: false, reason: 'no-gateway' };
  }
  try {
    const out = await api.scriptList();
    state.scripts = Array.isArray(out.body?.drafts) ? out.body.drafts : [];
    state.error = '';
    state.at = Date.now();
    return { ok: true, scripts: state.scripts };
  } catch (error) {
    state.error = error?.message || 'script drafts could not be read';
    return { ok: false, error: state.error };
  }
}

function remember(script) {
  if (!script?.id) return script;
  const i = state.scripts.findIndex((s) => s.id === script.id);
  if (i >= 0) state.scripts[i] = script;
  else state.scripts.unshift(script);
  return script;
}

/** Ask for a script from a sentence. The script returned is exactly what the gateway validated. */
export async function createFromText(text, { route = '' } = {}) {
  if (!available()) return { ok: false, reason: 'no-gateway', error: 'No gateway is connected, so no script can be drafted.' };
  try {
    const out = await api.scriptFromText({ text, route });
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
      error: error?.message || 'the script draft failed',
      draft: body.draft || null,
      reply: body.reply || null,
      userMessage: body.userMessage || null,
    };
  }
}

export async function submit(id) {
  try {
    const out = await api.scriptSubmit(id);
    return { ok: true, draft: remember(out.body) };
  } catch (error) {
    return { ok: false, error: error?.message || 'the script was not submitted', draft: error?.body?.draft ? remember(error.body.draft) : null };
  }
}

/** Run it. The gateway queues a real browser task; the reply carries its id and first status. */
export async function run(id) {
  try {
    const out = await api.scriptRun(id);
    remember(out.body?.draft);
    return { ok: true, draft: out.body?.draft, task: out.body?.task };
  } catch (error) {
    return { ok: false, error: error?.message || 'the script was not run', draft: error?.body?.draft ? remember(error.body.draft) : null };
  }
}

export async function archive(id) {
  try {
    const out = await api.scriptArchive(id);
    return { ok: true, draft: remember(out.body?.draft) };
  } catch (error) {
    return { ok: false, error: error?.message || 'the script was not archived' };
  }
}

/** Re-read one draft, so the card can show the task's live state rather than a remembered one. */
export async function refresh(id) {
  try {
    const out = await api.scriptGet(id);
    return { ok: true, draft: remember(out.body?.draft) };
  } catch (error) {
    return { ok: false, error: error?.message || 'the script could not be read' };
  }
}

export function reset() {
  state.scripts = [];
  state.error = '';
  state.at = null;
}
