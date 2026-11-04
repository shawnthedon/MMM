/* ============ MMM RBAC — role matrix and permission checks ============
 * Layer 1 of the governance model (design spec §"Layer 1 — Identity & Access").
 * Five roles, ordered. A permission names the minimum role that holds it; capability tokens can
 * narrow that further through scopes, never widen it.
 */

export const ROLES = ['Observer', 'Reviewer', 'Operator', 'Admin', 'Owner'];
export const RANK = Object.freeze({ Observer: 1, Reviewer: 2, Operator: 3, Admin: 4, Owner: 5 });
export const DEFAULT_ROLE = 'Observer';

/**
 * Permission catalogue. The value is the *lowest role that conventionally holds it* and is used
 * for error messages only — authorisation is decided by the explicit sets in ROLE_PERMISSIONS,
 * because the five roles are not a strict threshold (an Operator runs agents but may not decide
 * approval gates; a Reviewer decides gates but may not run anything).
 */
export const PERMISSIONS = Object.freeze({
  // read-only surface
  'read': 'Observer',
  'approval:read': 'Observer',
  'summary:read': 'Observer',
  'event:read': 'Observer',
  'token:issue': 'Observer',
  'comms:read': 'Observer',
  'browser:read': 'Observer',
  'evolution:read': 'Observer',
  'chat:read': 'Observer',
  'terminal:read': 'Observer',
  'model:read': 'Observer',
  'copilot:read': 'Observer',
  // Speech: reading what hosts are configured is read-only; changing one is an owner act, because an
  // endpoint decides where a recording is sent. Transcribing is operating, like any other run.
  'voice:read': 'Observer',
  // Files: reading a directory listing is read-only; writing, moving or deleting is operating; enrolling
  // a new root is an owner act, because a root is the boundary every other path check is measured against.
  'file:read': 'Observer',
  'file:write': 'Operator',
  'file:configure': 'Owner',
  'voice:transcribe': 'Operator',
  'voice:configure': 'Owner',
  // review surface
  'approval:request': 'Observer',
  'approval:decide': 'Reviewer',
  'evolution:review': 'Reviewer',
  'evolution:approve': 'Reviewer',
  'audit:read': 'Reviewer',
  'audit:verify': 'Reviewer',
  // operational surface
  'agent:write': 'Operator',
  'task:write': 'Operator',
  'swarm:write': 'Operator',
  'comms:write': 'Operator',
  'browser:run': 'Operator',
  'evolution:run': 'Operator',
  'chat:write': 'Operator',
  'terminal:run': 'Operator',
  'terminal:signal': 'Operator',
  'terminal:grant': 'Owner',
  'model:call': 'Operator',
  'model:key': 'Owner',
  // Talking to the Copilot spends money, so it needs the same rank as any other model call.
  'copilot:write': 'Operator',
  'copilot:model': 'Owner',
  // administration
  'evolution:deploy': 'Admin',
  'principal:read': 'Admin',
  'principal:write': 'Admin',
  'token:revoke:any': 'Admin',
  'system:diagnostics': 'Admin',
  // owner only
  'principal:write:privileged': 'Owner',
  'evolution:policy': 'Owner',
  'dev:seed': 'Owner',
});

const READ_ONLY = ['read', 'summary:read', 'event:read', 'approval:read', 'token:issue', 'comms:read', 'browser:read', 'evolution:read', 'chat:read', 'terminal:read', 'model:read', 'copilot:read', 'voice:read', 'file:read'];
const REVIEW = ['audit:read', 'audit:verify', 'evolution:review', 'evolution:approve'];
const OPERATE = ['agent:write', 'task:write', 'swarm:write', 'comms:write', 'browser:run', 'evolution:run', 'chat:write', 'terminal:run', 'terminal:signal', 'model:call', 'copilot:write', 'voice:transcribe', 'file:write'];

/** Explicit role → permission sets (the authoritative check). */
export const ROLE_PERMISSIONS = Object.freeze({
  Observer: [...READ_ONLY],
  // Reviews gates and reads the audit trail; cannot operate agents or tasks.
  Reviewer: [...READ_ONLY, 'approval:request', 'approval:decide', ...REVIEW],
  // Operates agents/tasks/swarms and can ask for a gate, but cannot grant one or read the audit log.
  Operator: [...READ_ONLY, 'approval:request', ...OPERATE],
  // Both operational and review powers, plus principal administration.
  Admin: [...READ_ONLY, 'approval:request', 'approval:decide', ...REVIEW, ...OPERATE,
    'principal:read', 'principal:write', 'token:revoke:any', 'system:diagnostics', 'evolution:deploy'],
  Owner: Object.keys(PERMISSIONS),
});

export const PERMISSION_LIST = Object.keys(PERMISSIONS);

export const isRole = (role) => Object.prototype.hasOwnProperty.call(RANK, role);
export const rankOf = (role) => RANK[role] ?? 0;

export function roleAtLeast(role, minimum) {
  return rankOf(role) >= rankOf(minimum);
}

export function isPrivilegedRole(role) {
  return role === 'Owner' || role === 'Admin';
}

/**
 * Effective permission check.
 * @param {{role:string, type?:string, status?:string, scopes?:string[]|null}} principal
 * @param {string} permission
 */
export function can(principal, permission) {
  if (!principal) return false;
  if (principal.status && principal.status !== 'active') return false;
  if (!PERMISSIONS[permission]) return false;
  const held = ROLE_PERMISSIONS[principal.role];
  if (!held || !held.includes(permission)) return false;
  // A token's scopes narrow the principal's role; they never widen it.
  if (Array.isArray(principal.scopes)) {
    if (principal.scopes.includes('*')) return true;
    if (!principal.scopes.includes(permission)) return false;
  }
  return true;
}

/** Permissions this principal actually holds, for `/auth/session` and the UI. */
export function permissionsFor(principal) {
  return PERMISSION_LIST.filter((p) => can(principal, p));
}

/** Every role that actually holds a permission (not the same as its minimum-role hint). */
export function rolesHolding(permission) {
  return ROLES.filter((role) => (ROLE_PERMISSIONS[role] || []).includes(permission));
}

/** Subjects an actor may assign: never at or above their own rank, except Owner. */
export function canAssignRole(actor, role) {
  if (!actor || !isRole(role)) return false;
  if (!can(actor, 'principal:write')) return false;
  if (actor.rank >= RANK.Owner) return true;
  return RANK[role] < RANK[actor.role];
}

/** May this actor modify/disable that target principal? */
export function canManagePrincipal(actor, target) {
  if (!actor || !target) return false;
  if (actor.id === target.id) return false; // no self-role/self-status changes
  if (!can(actor, 'principal:write')) return false;
  if (actor.role === 'Owner') return true;
  return RANK[target.role] < RANK[actor.role];
}

/**
 * Separation of duties: whoever asked for a gate cannot grant it, and Copilot/agent principals
 * can never decide gates on their own.
 */
export function canDecideApproval(actor, approval) {
  if (!actor || !approval) return { ok: false, reason: 'missing actor or approval' };
  if (!can(actor, 'approval:decide')) return { ok: false, reason: 'role lacks approval:decide' };
  if (!['user', 'bot'].includes(actor.type || 'user')) {
    return { ok: false, reason: 'only human (or bot) principals may decide approvals' };
  }
  const requester = String(approval.principal || '').trim().toLowerCase();
  const names = [String(actor.id || '').toLowerCase(), String(actor.name || '').toLowerCase()].filter(Boolean);
  if (requester && names.includes(requester)) {
    return { ok: false, reason: 'separation of duties: you requested this gate' };
  }
  if (requester === 'copilot' && actor.type === 'copilot') {
    return { ok: false, reason: 'copilot cannot approve its own request' };
  }
  return { ok: true };
}

/** Full matrix, for `/api/v1/roles` and documentation. */
export function roleMatrix() {
  return ROLES.map((role) => ({
    role,
    rank: RANK[role],
    permissions: [...(ROLE_PERMISSIONS[role] || [])],
  }));
}
