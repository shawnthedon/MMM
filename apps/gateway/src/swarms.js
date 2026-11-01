/* ============ Swarms — records of a plan, never a running thing ============
 * A swarm in this build is a *plan*: an objective, a team, a budget cap and a node order. Nothing in
 * this repository schedules it, starts a worker for it, or advances it — so this module refuses to
 * pretend otherwise, in three ways:
 *
 *   1. `executed` is a column, and every write sets it to 0. A request cannot set it either: the field
 *      is not in the accepted payload, and an unknown field is refused rather than dropped.
 *   2. `status` moves only between `planned`, `cancelled` and `archived`. `live`, `running`, `paused`
 *      and `completed` are refused with a reason naming what would have to exist first.
 *   3. `progress` and `budget.spent` are always 0 for an unexecuted plan — not "0 for now": a plan that
 *      nothing ran cannot have progress, and writing a plausible number is how the old screen lied.
 *
 * The one thing this module does *not* do is hide the plan. It persists it, lists it, edits it and
 * deletes it, so the screen can show real rows with real timestamps instead of a browser fixture.
 */
import { db, logEvent, audit } from './db.js';

export const SWARM_STATUSES = Object.freeze(['planned', 'cancelled', 'archived']);
/** Statuses that would claim execution. Kept as data so the refusal can name them. */
export const CLAIMED_STATUSES = Object.freeze(['live', 'running', 'paused', 'completed', 'failed', 'deploying']);

const LIMITS = { name: 120, objective: 2000, channel: 40, topology: 40, note: 280, id: 64 };
const MAX_NODES = 24;
const LIST_LIMIT = 200;

const fail = (code, message, extra = {}) => {
  throw Object.assign(new Error(message), { code, ...extra });
};

const now = () => Date.now();
const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

const parse = (value, fallback) => {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
};

/** What a swarm is, stated once, so no screen has to assemble the sentence itself. */
export const runtimeStatus = () => ({
  executed: false,
  scheduler: false,
  worker: false,
  note:
    'A swarm is a saved plan. Nothing in MMM schedules, starts or advances one, so a plan has no ' +
    'progress and no spend until a scheduler exists.',
});

/** The default node order for a plan: the same six roles the graph draws. */
const DEFAULT_NODES = [
  ['n1', 'planner'], ['n2', 'research-a'], ['n3', 'research-b'],
  ['n4', 'analyze'], ['n5', 'writer'], ['n6', 'assembler'],
];

function planNodes(input, teamId) {
  const source = Array.isArray(input) && input.length ? input : DEFAULT_NODES.map(([id, label]) => ({ id, label }));
  if (source.length > MAX_NODES) fail('bad-request', `a plan can hold at most ${MAX_NODES} nodes`);
  const members = teamId
    ? db.prepare('SELECT id FROM agents WHERE deleted_at IS NULL AND team_id=? ORDER BY team_position, name').all(teamId).map((r) => r.id)
    : [];
  return source.slice(0, MAX_NODES).map((node, index) => ({
    id: clean(node.id, 16) || `n${index + 1}`,
    label: clean(node.label, 40) || `node-${index + 1}`,
    // A plan node has an *intended* agent, never an assigned run.
    agent: clean(node.agent, LIMITS.id) || members[index % Math.max(members.length, 1)] || '',
    status: 'planned',
    spent: 0,
    elapsed: '—',
  }));
}

const slug = (name) => String(name || 'swarm').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'swarm';

function newId(base) {
  let id = `sw-${slug(base)}`;
  let n = 2;
  while (db.prepare('SELECT 1 FROM swarms WHERE id=?').get(id)) id = `sw-${slug(base)}-${n++}`;
  return id;
}

/** Server row → app shape. Budget and nodes are parsed here, once, so no client has to guess. */
export function adaptSwarm(row) {
  if (!row) return row;
  const budget = parse(row.budget, {});
  const nodes = parse(row.nodes, []);
  return {
    id: row.id,
    teamId: row.team_id || null,
    name: row.name,
    objective: row.objective || '',
    status: row.status,
    executed: Number(row.executed) === 1,
    // An unexecuted plan cannot have progress or spend. Compute from `executed`, never trust the column.
    progress: Number(row.executed) === 1 ? Number(row.progress) || 0 : 0,
    budget: {
      cap: Number(budget.cap) || 0,
      spent: Number(row.executed) === 1 ? Number(budget.spent) || 0 : 0,
    },
    nodes: Array.isArray(nodes)
      ? nodes.slice(0, MAX_NODES).map((n) => ({
        id: String(n.id || ''),
        label: String(n.label || ''),
        agent: String(n.agent || ''),
        // A node of an unexecuted plan is `planned`, whatever was stored.
        status: Number(row.executed) === 1 ? String(n.status || 'planned') : 'planned',
        spent: Number(row.executed) === 1 ? Number(n.spent) || 0 : 0,
        elapsed: Number(row.executed) === 1 ? String(n.elapsed || '—') : '—',
      }))
      : [],
    channel: row.channel || 'app',
    startedAt: Number(row.started_at) || 0,
    updatedAt: Number(row.updated_at) || Number(row.started_at) || 0,
    createdBy: row.created_by || 'system',
    note: row.run_note || '',
    runtime: runtimeStatus(),
  };
}

export function listSwarms({ teamId = null } = {}) {
  const rows = teamId
    ? db.prepare('SELECT * FROM swarms WHERE team_id=? ORDER BY updated_at DESC, started_at DESC LIMIT ?').all(teamId, LIST_LIMIT)
    : db.prepare('SELECT * FROM swarms ORDER BY updated_at DESC, started_at DESC LIMIT ?').all(LIST_LIMIT);
  const total = db.prepare('SELECT COUNT(*) n FROM swarms').get().n;
  return { swarms: rows.map(adaptSwarm), total, truncated: total > rows.length, runtime: runtimeStatus() };
}

export function getSwarm(id) {
  const row = db.prepare('SELECT * FROM swarms WHERE id=?').get(String(id || ''));
  if (!row) fail('not-found', 'swarm not found');
  return adaptSwarm(row);
}

const requireTeam = (teamId) => {
  if (!teamId) return null;
  const team = db.prepare('SELECT id,name FROM teams WHERE id=?').get(String(teamId));
  if (!team) fail('not-found', `team “${teamId}” does not exist`);
  return team;
};

function budgetCap(value, fallback = 8) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) fail('bad-request', 'a budget cap must be a number of zero or more');
  if (n > 100000) fail('bad-request', 'a budget cap above 100000 is refused');
  return Math.round(n * 100) / 100;
}

/** Fields a caller may set. Anything else is refused, so `executed: true` cannot slip in. */
const CREATE_FIELDS = ['name', 'objective', 'teamId', 'team_id', 'budgetCap', 'budget', 'channel', 'topology', 'nodes'];
const UPDATE_FIELDS = ['name', 'objective', 'budgetCap', 'budget', 'channel', 'nodes'];

function refuseUnknown(body, allowed) {
  const unknown = Object.keys(body || {}).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    fail('bad-request', `unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')} — a swarm cannot be created as executed or live`);
  }
}

export function createSwarm(body = {}, principal = 'system') {
  refuseUnknown(body, CREATE_FIELDS);
  const objective = clean(body.objective, LIMITS.objective);
  if (!objective) fail('bad-request', 'an objective is required');
  const name = clean(body.name, LIMITS.name) || slug(objective).slice(0, 32);
  const teamId = body.teamId ?? body.team_id ?? null;
  const team = requireTeam(teamId);
  const cap = budgetCap(body.budgetCap ?? body.budget?.cap ?? body.budget, 8);
  const channel = clean(body.channel, LIMITS.channel) || 'app';
  const id = newId(name);
  const ts = now();
  const nodes = planNodes(body.nodes, team?.id || null);
  db.prepare(`INSERT INTO swarms (id,team_id,name,objective,status,progress,budget,nodes,channel,started_at,created_by,executed,updated_at,run_note)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, team?.id || null, name, objective, 'planned', 0,
      JSON.stringify({ cap, spent: 0, topology: clean(body.topology, LIMITS.topology) || 'Hierarchical' }),
      JSON.stringify(nodes), channel, ts, principal, 0, ts, '');
  logEvent('swarm', `Swarm plan saved by ${principal} (not executed)`, id);
  audit(principal, 'api', 'swarm.create', { id, teamId: team?.id || null, nodes: nodes.length, executed: false }, 'allow', 'ok');
  return getSwarm(id);
}

export function updateSwarm(id, body = {}, principal = 'system') {
  refuseUnknown(body, UPDATE_FIELDS);
  const row = db.prepare('SELECT * FROM swarms WHERE id=?').get(String(id || ''));
  if (!row) fail('not-found', 'swarm not found');
  if (row.status === 'archived') fail('conflict', 'an archived plan is read-only; save a new one instead');
  const fields = [];
  const values = [];
  if ('name' in body) {
    const name = clean(body.name, LIMITS.name);
    if (!name) fail('bad-request', 'a name cannot be empty');
    fields.push('name=?'); values.push(name);
  }
  if ('objective' in body) {
    const objective = clean(body.objective, LIMITS.objective);
    if (!objective) fail('bad-request', 'an objective cannot be empty');
    fields.push('objective=?'); values.push(objective);
  }
  if ('channel' in body) { fields.push('channel=?'); values.push(clean(body.channel, LIMITS.channel) || row.channel); }
  if ('budgetCap' in body || 'budget' in body) {
    const current = parse(row.budget, {});
    const cap = budgetCap(body.budgetCap ?? body.budget?.cap ?? body.budget, Number(current.cap) || 0);
    fields.push('budget=?');
    // Never carry a spend forward: an unexecuted plan has none.
    values.push(JSON.stringify({ ...current, cap, spent: 0 }));
  }
  if ('nodes' in body) {
    fields.push('nodes=?');
    values.push(JSON.stringify(planNodes(body.nodes, row.team_id)));
  }
  if (!fields.length) fail('bad-request', 'no updatable fields (name, objective, channel, budgetCap, nodes)');
  fields.push('updated_at=?'); values.push(now());
  db.prepare(`UPDATE swarms SET ${fields.join(', ')} WHERE id=?`).run(...values, row.id);
  logEvent('swarm', `Swarm plan updated by ${principal} (not executed)`, row.id);
  audit(principal, 'api', 'swarm.update', { id: row.id, fields: Object.keys(body) }, 'allow', 'ok');
  return getSwarm(row.id);
}

/**
 * Move a plan's status. The allowed set is deliberately small: a plan can be cancelled (it will not be
 * used) or archived (kept, read-only), and a cancelled plan can be re-opened. Nothing here starts
 * anything, and asking for a status that would claim execution is refused with the reason.
 */
export function setSwarmStatus(id, status, principal = 'system') {
  const row = db.prepare('SELECT * FROM swarms WHERE id=?').get(String(id || ''));
  if (!row) fail('not-found', 'swarm not found');
  const next = clean(status, 20).toLowerCase();
  if (CLAIMED_STATUSES.includes(next)) {
    fail('conflict',
      `a swarm cannot be set to “${next}”: nothing in MMM executes a swarm. The plan can be cancelled or archived instead.`);
  }
  if (!SWARM_STATUSES.includes(next)) {
    fail('bad-request', `status must be one of ${SWARM_STATUSES.join(', ')}`);
  }
  if (Number(row.executed) === 1) {
    fail('conflict', 'this swarm has run, so its status is owned by the runner; it cannot be edited here');
  }
  if (row.status === next) return getSwarm(row.id);
  if (row.status === 'archived' && next !== 'archived') {
    fail('conflict', 'an archived plan cannot be re-opened; copy it into a new one');
  }
  db.prepare('UPDATE swarms SET status=?, updated_at=? WHERE id=?').run(next, now(), row.id);
  logEvent('swarm', `Swarm plan marked ${next} by ${principal} (nothing was running)`, row.id);
  audit(principal, 'api', 'swarm.status', { id: row.id, from: row.status, to: next }, 'allow', 'ok');
  return getSwarm(row.id);
}

export function deleteSwarm(id, principal = 'system') {
  const row = db.prepare('SELECT * FROM swarms WHERE id=?').get(String(id || ''));
  if (!row) fail('not-found', 'swarm not found');
  if (Number(row.executed) === 1) {
    fail('conflict', 'a swarm that has run keeps its record; archive it instead of deleting it');
  }
  db.prepare('DELETE FROM swarms WHERE id=?').run(row.id);
  logEvent('swarm', `Swarm plan deleted by ${principal}`, row.id);
  audit(principal, 'api', 'swarm.delete', { id: row.id, name: row.name, executed: false }, 'allow', 'ok');
  return { id: row.id, name: row.name, deleted: true };
}
