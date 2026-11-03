/* ============ Copilot actions: a proposal the person confirms, and the result the gateway returned ============
 * Phase C put a dispatcher behind the Copilot. This module is the client half of it, and it is deliberately
 * thin, because every rule that matters is enforced on the gateway:
 *
 *   • the proposal arrives already checked (state, permission, contract). This code renders it; it does not
 *     decide whether it is allowed, and it never re-sends parameters — `confirmCopilotAction` names the
 *     stored message and says yes, so a client cannot swap the values between review and execution;
 *   • the "Run" button is offered only when the gateway said `runnable`. Anything else shows the gateway's
 *     own sentence for why it cannot run;
 *   • the result card shows the dispatcher's result verbatim: `executed`, the HTTP status the service
 *     answered, and the trace id. There is no optimistic "done" state anywhere in this file.
 */
import { api, ApiError, isApiMode } from '../api.js';

export const available = () => isApiMode();

const CONFIRM_LABEL = {
  approve: 'Confirm & run',
  confirm: 'Confirm & run',
  approval: 'Request approval',
  none: 'Run',
};

/** Turn the server's proposal into the card the panel renders. Never invents a capability. */
export function cardFor(proposal, { mode = 'ask' } = {}) {
  if (!proposal || typeof proposal !== 'object') return null;
  const operationId = proposal.operationId || proposal.requested?.operation || '';
  if (!operationId) return null;
  const validation = proposal.validation || { ok: true, errors: [], message: '' };
  return {
    type: 'action',
    mode,
    title: proposal.label ? `Run “${proposal.label}”` : `Run ${operationId}`,
    operation: operationId,
    messageId: proposal.messageId || '',
    // The dispatcher's fields, kept as they arrived.
    risk: proposal.risk || 'reversible',
    confirmation: proposal.confirmation || 'confirm',
    state: proposal.state || '',
    stateLabel: proposal.stateLabel || proposal.state || '',
    executable: proposal.executable === true,
    runnable: proposal.runnable === true && validation.ok !== false,
    reason: proposal.reason || (!proposal.executable ? proposal.message : '') || '',
    target: proposal.target || '',
    fields: proposal.contract?.fields || [],
    validation,
    effects: proposal.effects || {},
    confirmLabel: CONFIRM_LABEL[proposal.confirmation] || 'Confirm & run',
    approvalGate: null,
    result: null,
  };
}

/** Run it. Resolves with the dispatcher's answer; a refusal is an answer, not an exception. */
export async function run(card, { approvalId = null } = {}) {
  if (!card?.runnable || !card?.messageId) {
    return {
      ok: false,
      executed: false,
      code: 'not-runnable',
      message: card?.reason || 'This proposal was not cleared to run.',
    };
  }
  try {
    const out = await api.confirmCopilotAction(card.messageId, { confirm: true, approvalId });
    const body = out.body || {};
    return {
      ok: Boolean(body.executed),
      executed: Boolean(body.executed),
      code: body.code || null,
      outcome: body.outcome || null,
      message: body.message || '',
      httpStatus: body.httpStatus ?? null,
      traceId: body.traceId || null,
      approval: body.approval || null,
      reported: Boolean(body.reported),
      reportNote: body.reportNote || '',
      reply: body.reply || null,
      data: body.data,
    };
  } catch (error) {
    const body = error instanceof ApiError ? error.body : null;
    return {
      ok: false,
      executed: false,
      code: body?.code || error?.code || 'error',
      outcome: body?.outcome || 'failed',
      message: body?.message || body?.error || error?.message || 'the request failed',
      approval: body?.approval || null,
      httpStatus: error instanceof ApiError ? error.status : null,
      traceId: body?.traceId || null,
      reply: null,
    };
  }
}

/**
 * Ask for an approval gate instead of running: the dispatcher opens one and says which principal must
 * decide. Returns the gate so the card can show it.
 */
export async function requestApproval(card) {
  if (!card?.messageId) return { ok: false, message: 'This proposal is not stored on the gateway.' };
  const out = await run(card);
  return out.approval
    ? { ok: false, pending: true, approval: out.approval, message: out.message }
    : out;
}

/** The card the transcript keeps after a run: the gateway's own result, restated. */
export function resultCard(card, result) {
  const status = result.executed ? 'ok' : result.code === 'approval-required' ? 'blocked' : 'failed';
  const steps = [
    { label: `Gateway dispatched ${card.operation}`, state: 'ok', detail: result.traceId ? `trace ${result.traceId}` : '' },
  ];
  if (result.executed) {
    steps.push({ label: `Service answered ${result.httpStatus ?? 200}`, state: 'ok', detail: result.message });
  } else {
    steps.push({ label: result.code || 'refused', state: 'blocked', detail: result.message });
  }
  if (result.approval) {
    steps.push({
      label: result.approval.status === 'allowed' && result.approval.consumed ? 'Approval spent' : `Approval ${result.approval.status || 'pending'}`,
      state: result.approval.status === 'allowed' ? 'ok' : 'blocked',
      detail: result.approval.id,
    });
  }
  return {
    type: 'result',
    status,
    title: result.executed ? `${card.operation} ran` : `${card.operation} did not run`,
    summary: result.reported
      ? 'The gateway executed this and a model wrote the report below.'
      : result.executed
        ? `The gateway executed this.${result.reportNote ? ` ${result.reportNote}` : ''}`
        : `The gateway refused this. ${result.message}`,
    steps,
    traceId: result.traceId,
  };
}
