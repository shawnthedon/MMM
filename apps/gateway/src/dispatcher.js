/* ============ The dispatcher ============
 * One function that turns "run operation X with these parameters, as this principal" into either a call on
 * the route that already implements X, or a refusal that names what stopped it. It is the only way Copilot
 * acts, and the only place where a Copilot turn turns into a side effect.
 *
 * What this is not
 * ----------------
 * It is not a second implementation of anything. `invokeRoute` is injected by server.js and calls the *same
 * handler* the HTTP route calls, with the *same* principal the session produced — so every authorisation,
 * ownership check, approval gate, policy limit and broadcast inside those handlers still runs. The dispatcher
 * adds the checks that a caller can get wrong, and it adds them in front:
 *
 *   1. resolve the operation against the registry (an unknown id cannot execute, ever);
 *   2. read its state — a capability this deployment cannot serve is refused with that state's own name;
 *   3. re-check the permission server-side with the gateway's own `can()` (client claims are never read);
 *   4. validate parameters against the declared contract, refusing unknown keys instead of dropping them;
 *   5. require an explicit confirmation, or a *decided* approval bound to this operation and this target;
 *   6. apply a per-principal limit, then call the route;
 *   7. bound the call in time and map a failure to a structured result that leaks no secret;
 *   8. write one audit row per attempt, executed or refused.
 *
 * The order matters: state and permission are checked before parameters are even parsed, so a refused call
 * cannot use validation messages to learn the shape of an operation it may not use.
 */
import { can } from './rbac.js';
import { resolveContract, validateParams, buildPath, describeFieldErrors } from './operationContracts.js';

/** States in which an operation may run. `degraded` is deliberately absent: unknown health is not "fine". */
const RUNNABLE = new Set(['available']);

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_RESULT_BYTES = 64 * 1024;
const SECRET_KEY = /^(key|apikey|api_key|secret|password|token|sealed|key_sealed|ciphertext|authorization)$/i;
const MAX_KEYS_IN_AUDIT = 12;

/**
 * Credential-shaped text, for the places a secret hides in a *string* rather than under a key: an error
 * message from an upstream, a URL a service echoed back. Both are removed before anything is returned.
 */
const SECRET_TEXT = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{6,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[=:]\s*["']?[^\s"',;]{4,}/gi,
  /\bmmm_[A-Za-z0-9_-]{8,}/g,
];

export function scrubText(value, max = 400) {
  let out = String(value ?? '');
  for (const pattern of SECRET_TEXT) out = out.replace(pattern, '[redacted]');
  return out.slice(0, max);
}

/** Remove anything that smells like a credential from a handler's response, at any depth. */
export function scrub(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubText(value, 4000);
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => scrub(v, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY.test(k)) continue;
    out[k] = scrub(v, depth + 1);
  }
  return out;
}

/** A result that is honest about size rather than silently truncated. */
function bounded(body) {
  let json;
  try {
    json = JSON.stringify(body);
  } catch {
    return { body: null, truncated: true };
  }
  if (json.length <= MAX_RESULT_BYTES) return { body, truncated: false };
  return {
    body: { truncated: true, bytes: json.length, note: 'the response was larger than the dispatcher returns' },
    truncated: true,
  };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {object} deps
 * @param {Array<object>} deps.operations  the Phase B registry (`capabilities.OPERATIONS`)
 * @param {(id: string, principal: object) => Promise<{state:string,stateLabel:string,reason:string}>} deps.stateOf
 * @param {(call: object) => Promise<{code:number,body:object}>} deps.invokeRoute  runs the real route handler
 * @param {{find:Function, open:Function, consume:Function}} deps.approvals  the existing approvals table
 * @param {Function} deps.audit  the gateway's hash-chained audit writer
 * @param {Function} [deps.logEvent]  the activity feed (best effort, never the record)
 * @param {Function} [deps.rateLimit]  the gateway's own limiter (`auth.rateLimit`)
 * @param {() => number} [deps.now]
 * @param {(operation: object) => number} [deps.timeoutFor]  test seam for the timeout path
 */
export function createDispatcher({
  operations = [],
  stateOf,
  invokeRoute,
  approvals,
  audit,
  logEvent = () => {},
  rateLimit = null,
  now = Date.now,
  timeoutFor = (operation) => operation.timeoutMs || DEFAULT_TIMEOUT_MS,
  limits = { opsPerMinute: 120 },
} = {}) {
  if (typeof stateOf !== 'function') throw new Error('dispatcher needs stateOf()');
  if (typeof invokeRoute !== 'function') throw new Error('dispatcher needs invokeRoute()');
  if (!approvals || typeof approvals.find !== 'function' || typeof approvals.open !== 'function' || typeof approvals.consume !== 'function') {
    throw new Error('dispatcher needs approvals { find, open, consume }');
  }
  if (typeof audit !== 'function') throw new Error('dispatcher needs audit()');

  const byId = new Map(operations.map((o) => [o.id, o]));

  function record(principal, operationId, decision, result, extra = {}) {
    try {
      audit(principal?.id || 'anonymous', principal?.via || 'dispatch', `dispatch.${operationId}`, extra, decision, result);
    } catch {
      /* An audit failure must not become a 500 with a half-run operation behind it: the decision is
       * already made and the caller is told it; the missing row is a bug to fix, not a reason to retry. */
    }
  }

  const refusal = (started, traceId, operationId, code, message, extra = {}) => ({
    ok: false,
    executed: false,
    outcome: 'refused',
    operationId,
    code,
    message,
    traceId,
    durationMs: now() - started,
    ...extra,
  });

  /**
   * No side effects beyond reading probes. This is what the panel shows before anything happens, and what
   * the tests use to prove a refused operation never touched a service.
   */
  async function describe({ operationId, params = {}, principal }) {
    const id = String(operationId || '');
    const operation = byId.get(id);
    if (!operation) {
      return {
        ok: false,
        executable: false,
        executed: false,
        outcome: 'proposed',
        operationId: id,
        code: 'unknown-operation',
        message: `“${id}” is not a registered operation. Nothing was executed.`,
      };
    }

    const contract = resolveContract(operation);
    const state = await stateOf(operation.id, principal);
    const allowed = operation.permission === 'public' ? true : can(principal, operation.permission);
    const validation = contract ? validateParams(contract, params) : { ok: false, value: null, errors: [] };
    const target = contract && typeof contract.target === 'function' && validation.value
      ? safeTarget(contract, validation.value)
      : null;

    const executable = Boolean(contract) && RUNNABLE.has(state.state) && allowed;
    const reason = !contract
      ? 'No input contract is declared for this operation yet, so the dispatcher will not guess at it.'
      : !RUNNABLE.has(state.state)
        ? `${state.reason || `The capability is ${state.stateLabel}.`}`
        : !allowed
          ? `Your role does not hold “${operation.permission}”.`
          : '';

    return {
      ok: executable && validation.ok,
      executable,
      executed: false,
      outcome: 'proposed',
      operationId: operation.id,
      module: operation.module,
      label: operation.label,
      description: operation.description,
      kind: operation.kind,
      risk: operation.risk,
      state: state.state,
      stateLabel: state.stateLabel,
      permission: operation.permission,
      allowed,
      confirmation: operation.confirmation,
      reversible: operation.reversible,
      idempotent: operation.idempotent,
      audit: operation.audit,
      reason,
      target,
      contract: contract
        ? { derived: Boolean(contract.derived), route: contract.route, fields: [...Object.keys(contract.path || {}), ...Object.keys(contract.body || {})] }
        : null,
      validation: {
        ok: validation.ok,
        errors: validation.errors,
        message: validation.ok ? '' : describeFieldErrors(validation.errors),
      },
      effects: {
        audit: operation.audit,
        requiresApproval: operation.confirmation === 'approval',
        requiresConfirmation: operation.confirmation === 'confirm',
        timeoutMs: timeoutFor(operation),
      },
      message: executable
        ? `Ready: ${operation.label.toLowerCase()}. Nothing has run yet.`
        : reason,
    };
  }

  function safeTarget(contract, value) {
    try {
      return contract.target(value.path) || null;
    } catch {
      return null;
    }
  }

  /** The one execution path. Everything Copilot does goes through here. */
  async function execute({
    operationId,
    params = {},
    principal,
    confirmed = false,
    approvalId = null,
    dryRun = false,
    reason = '',
  } = {}) {
    const started = now();
    const traceId = `dx-${started.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const id = String(operationId || '');
    const operation = byId.get(id);

    const refuse = (code, message, extra = {}) => {
      record(principal, operation?.id || id || '(none)', 'deny', code, {
        code,
        risk: operation?.risk,
        keys: isPlainObject(params) ? Object.keys(params).slice(0, MAX_KEYS_IN_AUDIT) : [],
        traceId,
      });
      return refusal(started, traceId, operation?.id || id, code, message, extra);
    };

    /* 1. registered? ------------------------------------------------------- */
    if (!operation) {
      return refuse('unknown-operation', `“${id}” is not a registered operation. Nothing was executed.`);
    }

    /* 2. is there a service at all? ---------------------------------------- */
    if (operation.routes.length === 0) {
      return refuse('no-service', `${operation.label}: ${operation.note || 'no implementing service exists.'} Nothing was executed.`, {
        state: 'no-service',
        stateLabel: 'No service',
      });
    }

    /* 3. can this deployment serve it? ------------------------------------- */
    const state = await stateOf(operation.id, principal);
    if (!RUNNABLE.has(state.state)) {
      const code = ['unconfigured', 'unverified', 'degraded', 'blocked', 'demo', 'no-service'].includes(state.state)
        ? state.state
        : 'unavailable';
      return refuse(code, `${operation.label}: ${state.reason || `the capability is ${state.stateLabel}`} Nothing was executed.`, {
        state: state.state,
        stateLabel: state.stateLabel,
      });
    }

    /* 4. may this principal use it? (never the caller's own claim) --------- */
    const allowed = operation.permission === 'public' ? true : can(principal, operation.permission);
    if (!allowed) {
      return refuse('forbidden', `Your role${principal?.role ? ` (${principal.role})` : ''} does not hold “${operation.permission}”. Nothing was executed.`, {
        state: state.state,
        stateLabel: state.stateLabel,
        permission: operation.permission,
      });
    }

    /* 5. is there a contract, and are the parameters in it? ---------------- */
    const contract = resolveContract(operation);
    if (!contract) {
      return refuse('no-contract', `${operation.label} has no declared input contract, so the dispatcher will not guess at its parameters. Nothing was executed.`, {
        state: state.state,
        stateLabel: state.stateLabel,
      });
    }
    const validation = validateParams(contract, params);
    if (!validation.ok) {
      return refuse('invalid-params', `That request does not match ${operation.id}: ${describeFieldErrors(validation.errors)}`, {
        state: state.state,
        stateLabel: state.stateLabel,
        fields: validation.errors,
      });
    }
    const { path: pathValues, body, query } = validation.value;
    const target = typeof contract.target === 'function' ? safeTarget(contract, validation.value) : null;

    /* 6. confirmation, then approval — two separate gates ------------------ */
    if (operation.confirmation === 'confirm' && !confirmed) {
      return refuse('confirmation-required', `${operation.label} changes state. Re-send it with confirm: true. Nothing was executed.`, {
        state: state.state,
        stateLabel: state.stateLabel,
        risk: operation.risk,
      });
    }

    let gate = null;
    if (operation.confirmation === 'approval') {
      const action = `dispatch:${operation.id}`;
      const approvalTarget = target || operation.id;
      if (!approvalId) {
        // One open gate per (action, target), so a retry loop cannot fill the approvals table.
        const existing = approvals.find({ action, target: approvalTarget, status: 'pending' });
        let opened = existing;
        if (!opened) {
          try {
            opened = await approvals.open({
              action,
              target: approvalTarget,
              risk: operation.risk === 'destructive' ? 'high' : 'medium',
              principal: principal?.name || principal?.id || 'unknown',
              evidence: `Dispatcher: ${operation.label}${reason ? ` — ${String(reason).slice(0, 200)}` : ''}`,
              requestedBy: principal,
            });
          } catch (error) {
            return refuse(
              error?.code === 'approval-forbidden' ? 'approval-forbidden' : 'approval-unavailable',
              `${operation.label} needs an approval, and an approval gate could not be opened: ${String(error?.message || 'the approvals service refused').slice(0, 200)} Nothing was executed.`,
              { state: state.state, stateLabel: state.stateLabel }
            );
          }
        }
        record(principal, operation.id, 'deny', 'approval-required', { action, target: approvalTarget, approvalId: opened.id, traceId });
        return {
          ok: false,
          executed: false,
          outcome: 'refused',
          operationId: operation.id,
          state: state.state,
          stateLabel: state.stateLabel,
          code: 'approval-required',
          message: `${operation.label} needs an approval from a different principal. Gate ${opened.id} is open and ${existing ? 'still pending' : 'waiting'}; re-send with approvalId once it is allowed. Nothing was executed.`,
          approval: { id: opened.id, status: opened.status, action, target: approvalTarget },
          traceId,
          durationMs: now() - started,
        };
      }

      const row = approvals.find({ id: approvalId });
      if (!row) return refuse('invalid-approval', `No approval “${approvalId}” exists. Nothing was executed.`, { state: state.state });
      if (row.action !== action) {
        return refuse('invalid-approval', `Approval ${row.id} is for “${row.action}”, not “${action}”. Nothing was executed.`, { state: state.state });
      }
      if (row.target !== approvalTarget) {
        return refuse('invalid-approval', `Approval ${row.id} is for “${row.target}”, not “${approvalTarget}”. Nothing was executed.`, { state: state.state });
      }
      if (row.status !== 'allowed') {
        return refuse('approval-not-allowed', `Approval ${row.id} is ${row.status}. Nothing was executed.`, {
          state: state.state,
          approval: { id: row.id, status: row.status },
        });
      }
      if (row.consumed_at !== null && row.consumed_at !== undefined) {
        return refuse('approval-consumed', `Approval ${row.id} has already been used once. Nothing was executed.`, { state: state.state });
      }
      gate = row;
    }

    /* 7. a dry run stops before the side effect --------------------------- */
    if (dryRun) {
      const described = await describe({ operationId: operation.id, params, principal });
      return { ...described, executed: false, outcome: 'proposed', traceId, durationMs: now() - started };
    }

    /* 8. per-principal execution limit ------------------------------------ */
    if (rateLimit) {
      const bucket = `dispatch:${principal?.id || 'anonymous'}`;
      const out = rateLimit(bucket, { limit: limits.opsPerMinute, windowMs: 60000 });
      if (!out.allowed) {
        return refuse('rate-limited', `Too many dispatched operations this minute (limit ${limits.opsPerMinute}). Nothing was executed.`, {
          state: state.state,
          stateLabel: state.stateLabel,
        });
      }
    }

    /* 9. execute through the real route handler --------------------------- */
    let pathBuilt;
    try {
      pathBuilt = buildPath(contract.template, pathValues);
    } catch (error) {
      return refuse('no-contract', `${operation.label}: ${error.message}. Nothing was executed.`, { state: state.state });
    }

    const timeoutMs = timeoutFor(operation);
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ __timeout: true }), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });

    let out;
    try {
      out = await Promise.race([
        invokeRoute({
          operation,
          route: contract.route,
          method: contract.route.split(' ')[0],
          path: pathBuilt,
          body,
          query,
          principal,
          requestId: traceId,
        }),
        timeout,
      ]);
    } catch (error) {
      clearTimeout(timer);
      const code = typeof error?.code === 'string' ? error.code : 'service-error';
      const message = scrubText(error?.message || 'the service failed', 400);
      record(principal, operation.id, 'allow', 'error', { code, traceId, target });
      return {
        ok: false,
        executed: false,
        outcome: 'failed',
        operationId: operation.id,
        state: state.state,
        stateLabel: state.stateLabel,
        code,
        message: `${operation.label} failed: ${message}`,
        traceId,
        durationMs: now() - started,
      };
    }
    clearTimeout(timer);

    if (out && out.__timeout) {
      record(principal, operation.id, 'allow', 'timeout', { traceId, target, timeoutMs });
      return {
        ok: false,
        executed: false,
        outcome: 'failed',
        operationId: operation.id,
        state: state.state,
        stateLabel: state.stateLabel,
        code: 'timeout',
        message: `${operation.label} did not answer within ${timeoutMs} ms. If it reached the service it may still finish there; nothing is being reported as done.`,
        timeoutMs,
        traceId,
        durationMs: now() - started,
      };
    }

    const status = Number(out?.code ?? 200);
    const payload = scrub(out?.body ?? out ?? {});
    const requestId = payload?.requestId || traceId;

    if (status >= 400) {
      const code = String(payload?.code || '').slice(0, 60) || (status === 403 ? 'forbidden' : status === 404 ? 'not-found' : 'service-refused');
      const message = scrubText(payload?.error || 'the service refused the operation', 400);
      record(principal, operation.id, 'deny', code, { status, code, traceId, target });
      return {
        ok: false,
        executed: false,
        outcome: status === 403 || status === 409 ? 'refused' : 'failed',
        operationId: operation.id,
        state: state.state,
        stateLabel: state.stateLabel,
        httpStatus: status,
        code,
        message: `${operation.label}: ${message}`,
        traceId,
        durationMs: now() - started,
      };
    }

    /* 10. the service answered: report what it said, not what we hoped ---- */
    let consumed = null;
    if (gate) {
      consumed = approvals.consume(gate.id, principal?.id || 'dispatcher', traceId);
    }
    const boundedOut = bounded(payload);
    record(principal, operation.id, 'allow', 'ok', { status, traceId, target, approvalId: gate?.id, truncated: boundedOut.truncated });
    try {
      logEvent('dispatch', `${operation.label} executed by ${principal?.name || principal?.id || 'unknown'} (${operation.id})`, target || '');
    } catch {
      /* the feed is best effort; the audit row is the record */
    }

    return {
      ok: true,
      executed: true,
      outcome: 'executed',
      operationId: operation.id,
      module: operation.module,
      label: operation.label,
      state: state.state,
      stateLabel: state.stateLabel,
      risk: operation.risk,
      permission: operation.permission,
      httpStatus: status,
      data: boundedOut.body,
      truncated: boundedOut.truncated,
      approval: gate ? { id: gate.id, consumed: Boolean(consumed) } : null,
      target,
      requestId,
      traceId,
      durationMs: now() - started,
      message: `${operation.label} was executed by the gateway and the service answered ${status}.`,
    };
  }

  return {
    describe,
    execute,
    /** The registry as seen by one principal: every operation, its state, whether it may run here. */
    async catalogue(principal) {
      const rows = [];
      for (const operation of operations) {
        const state = await stateOf(operation.id, principal);
        const allowed = operation.permission === 'public' ? true : can(principal, operation.permission);
        const contract = resolveContract(operation);
        rows.push({
          id: operation.id,
          module: operation.module,
          label: operation.label,
          kind: operation.kind,
          risk: operation.risk,
          confirmation: operation.confirmation,
          permission: operation.permission,
          state: state.state,
          stateLabel: state.stateLabel,
          reason: state.reason || '',
          allowed,
          dispatchable: Boolean(contract) && RUNNABLE.has(state.state) && allowed,
          executableNow: Boolean(contract) && RUNNABLE.has(state.state) && allowed,
          fields: contract ? [...Object.keys(contract.path || {}), ...Object.keys(contract.body || {})] : null,
        });
      }
      const counts = rows.reduce((acc, r) => {
        acc.total += 1;
        if (r.dispatchable) acc.dispatchable += 1;
        else if (!r.allowed) acc['permission-restricted'] += 1;
        else if (!STATE_ORDER.includes(r.state)) acc.other += 1;
        else acc[r.state] += 1;
        return acc;
      }, { total: 0, dispatchable: 0, unconfigured: 0, unverified: 0, degraded: 0, blocked: 0, demo: 0, 'no-service': 0, 'permission-restricted': 0, other: 0 });
      return { operations: rows, counts };
    },
    get operationCount() {
      return byId.size;
    },
    isRegistered: (id) => byId.has(String(id || '')),
  };
}

const STATE_ORDER = ['unconfigured', 'unverified', 'degraded', 'blocked', 'demo', 'no-service'];
