/* ============ Teams — a view over `agents.team_id` ============
 * Membership exists exactly once: `agents.team_id` (+ a dense `team_position` inside that team).
 * Everything here reads or writes that one column, so the team menu, the agent panel, the agent grid
 * and the designer can never disagree about who belongs where.
 *
 * Deleting a team NEVER deletes an agent and never silently re-homes one: the members are unassigned
 * (`team_id = NULL`, `team_position = 0`) inside the same transaction as the delete, the API returns
 * the list of agents it unassigned, and the caller is expected to say so before confirming.
 *
 * `swarms.team_id` has no ON DELETE action, so a live swarm would block the delete; those rows are
 * detached in the same transaction and reported back as `detachedSwarms`.
 */
import { db, logEvent, audit } from './db.js';

const LIMITS = { name: 120, description: 400, role: 160 };

export const cleanText = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

function fail(code, message, extra = {}) {
  throw Object.assign(new Error(message), { code, ...extra });
}

/** The agent fields this module owns. Anything else is refused rather than silently dropped. */
export const MEMBER_FIELDS = Object.freeze(['team_id', 'team_position']);

export function teamRow(row) {
  if (!row) return row;
  return { ...row, description: row.description || '' };
}

/** Every team with its members, ordered by the position the slider shows. One query, one truth. */
export function listTeams() {
  const teams = db.prepare('SELECT * FROM teams ORDER BY name COLLATE NOCASE').all().map(teamRow);
  const members = db.prepare(`SELECT id,name,role,status,team_id,team_position FROM agents
                               WHERE deleted_at IS NULL AND team_id IS NOT NULL
                               ORDER BY team_position ASC, name COLLATE NOCASE`).all();
  const byTeam = new Map(teams.map((t) => [t.id, []]));
  for (const m of members) {
    if (!byTeam.has(m.team_id)) continue; // a dangling id cannot happen (FK), but never crash on it
    byTeam.get(m.team_id).push({
      id: m.id, name: m.name, role: m.role, status: m.status,
      position: m.team_position, teamId: m.team_id,
    });
  }
  const unassigned = db.prepare(`SELECT COUNT(*) n FROM agents WHERE deleted_at IS NULL AND team_id IS NULL`).get().n;
  return {
    teams: teams.map((t) => {
      const list = byTeam.get(t.id) || [];
      return { ...t, members: list, memberCount: list.length };
    }),
    unassigned,
    totalAgents: db.prepare('SELECT COUNT(*) n FROM agents WHERE deleted_at IS NULL').get().n,
  };
}

export function getTeam(id) {
  const team = db.prepare('SELECT * FROM teams WHERE id=?').get(id);
  if (!team) fail('not-found', 'team not found');
  const members = db.prepare(`SELECT id, name, role, status, team_id, team_position AS position FROM agents
                               WHERE deleted_at IS NULL AND team_id=? ORDER BY team_position ASC, name COLLATE NOCASE`).all(id);
  return { ...teamRow(team), members, memberCount: members.length };
}

const teamIdFor = (name) => {
  const base = String(name || 'team').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'team';
  let id = `tm-${base}`;
  let n = 2;
  while (db.prepare('SELECT 1 FROM teams WHERE id=?').get(id)) id = `tm-${base}-${n++}`;
  return id;
};

export function createTeam({ name, description = '', topology = 'Hierarchical', principal }) {
  const clean = cleanText(name, LIMITS.name);
  if (!clean) fail('bad-request', 'a team name is required');
  if (db.prepare('SELECT 1 FROM teams WHERE name=? COLLATE NOCASE').get(clean)) {
    fail('conflict', `a team called “${clean}” already exists`);
  }
  const id = teamIdFor(clean);
  db.prepare('INSERT INTO teams (id,name,topology,config,health,created_by,description) VALUES (?,?,?,?,?,?,?)')
    .run(id, clean, cleanText(topology, 40) || 'Hierarchical', '{}', 'good', principal || 'system', cleanText(description, LIMITS.description));
  logEvent('team', `Team ${clean} created by ${principal || 'system'}`, id);
  audit(principal || 'system', 'api', 'team.create', { id, name: clean }, 'allow', 'ok');
  return getTeam(id);
}

/** Rename / re-describe a team. Membership is not edited here — that is the agent row. */
export function updateTeam(id, body = {}, principal) {
  const team = db.prepare('SELECT * FROM teams WHERE id=?').get(id);
  if (!team) fail('not-found', 'team not found');
  const fields = [];
  const values = [];
  if ('name' in body) {
    const clean = cleanText(body.name, LIMITS.name);
    if (!clean) fail('bad-request', 'a team name is required');
    const clash = db.prepare('SELECT id FROM teams WHERE name=? COLLATE NOCASE AND id<>?').get(clean, id);
    if (clash) fail('conflict', `a team called “${clean}” already exists`);
    fields.push('name=?'); values.push(clean);
  }
  if ('description' in body) { fields.push('description=?'); values.push(cleanText(body.description, LIMITS.description)); }
  if ('topology' in body) { fields.push('topology=?'); values.push(cleanText(body.topology, 40) || team.topology); }
  if (!fields.length) fail('bad-request', 'no updatable fields (name, description, topology)');
  db.prepare(`UPDATE teams SET ${fields.join(', ')} WHERE id=?`).run(...values, id);
  logEvent('team', `Team ${team.name} updated by ${principal || 'system'}`, id);
  audit(principal || 'system', 'api', 'team.update', { id, fields: Object.keys(body) }, 'allow', 'ok');
  return getTeam(id);
}

/**
 * Delete a team and unassign its members. Returns exactly what happened so the UI can say it:
 * nothing is deleted, nothing is moved, and the caller learns the agent ids that lost their team.
 */
export function deleteTeam(id, principal) {
  const team = db.prepare('SELECT * FROM teams WHERE id=?').get(id);
  if (!team) fail('not-found', 'team not found');
  const members = db.prepare('SELECT id,name FROM agents WHERE deleted_at IS NULL AND team_id=?').all(id);
  const swarms = db.prepare('SELECT id,name FROM swarms WHERE team_id=?').all(id);
  const run = db.transaction(() => {
    db.prepare('UPDATE agents SET team_id=NULL, team_position=0 WHERE team_id=?').run(id);
    db.prepare('UPDATE swarms SET team_id=NULL WHERE team_id=?').run(id);
    db.prepare('DELETE FROM teams WHERE id=?').run(id);
  });
  run();
  logEvent('team', `Team ${team.name} deleted by ${principal || 'system'} — ${members.length} agent(s) unassigned, none deleted`, id);
  audit(principal || 'system', 'api', 'team.delete', {
    id, name: team.name, unassigned: members.map((m) => m.id), agentsDeleted: 0,
  }, 'allow', 'ok');
  return {
    deleted: id,
    name: team.name,
    unassigned: members,
    agentsDeleted: 0,
    detachedSwarms: swarms,
    summary: members.length
      ? `${members.length} agent${members.length === 1 ? '' : 's'} unassigned (teamId → null). No agent was deleted or moved to another team.`
      : 'No agents were assigned. Nothing was deleted or moved.',
  };
}

/** Put an agent in a team, or take it out (`team_id = null`). Refuses rather than guessing. */
export function assignAgent(agentId, teamId, position = null, principal) {
  const agent = db.prepare('SELECT id,name,team_id FROM agents WHERE id=? AND deleted_at IS NULL').get(agentId);
  if (!agent) fail('not-found', 'agent not found');
  let next = null;
  if (teamId !== null && teamId !== undefined && teamId !== '') {
    next = db.prepare('SELECT id,name FROM teams WHERE id=?').get(String(teamId));
    if (!next) fail('not-found', 'team not found');
  }
  const previous = agent.team_id || null;
  db.transaction(() => {
    // Clear the position first: a stale number from the old team must never decide the new order.
    db.prepare('UPDATE agents SET team_id=?, team_position=0 WHERE id=?').run(next ? next.id : null, agentId);
    if (next) {
      const wanted = position !== null && Number.isFinite(Number(position)) ? Number(position) : Number.MAX_SAFE_INTEGER;
      moveTo(agentId, wanted);
      compact(next.id);
    } else {
      db.prepare('UPDATE agents SET team_position=0 WHERE id=?').run(agentId);
    }
    if (previous && previous !== (next ? next.id : null)) compact(previous);
  })();
  const where = next ? `team ${next.name}` : agent.team_id ? 'no team (unassigned)' : 'no team';
  logEvent('team', `Agent ${agent.name} → ${where} by ${principal || 'system'}`, agentId);
  audit(principal || 'system', 'api', 'team.assign', { agentId, teamId: next ? next.id : null }, 'allow', 'ok');
  const row = db.prepare('SELECT team_id, team_position FROM agents WHERE id=?').get(agentId);
  return { agentId, teamId: row.team_id, teamName: next ? next.name : null, position: row.team_position };
}

/** Renumber a team from scratch so positions are always 1..n with no gaps. */
function compact(teamId) {
  if (!teamId) return;
  const rows = db.prepare('SELECT id FROM agents WHERE deleted_at IS NULL AND team_id=? ORDER BY team_position ASC, name COLLATE NOCASE').all(teamId);
  const update = db.prepare('UPDATE agents SET team_position=? WHERE id=?');
  rows.forEach((row, index) => update.run(index + 1, row.id));
}

/** Move the agent to a 1-based position inside its current team. */
export function moveTo(agentId, position) {
  const agent = db.prepare('SELECT id,team_id FROM agents WHERE id=?').get(agentId);
  if (!agent?.team_id) return;
  const rows = db.prepare('SELECT id FROM agents WHERE deleted_at IS NULL AND team_id=? ORDER BY team_position ASC, name COLLATE NOCASE').all(agent.team_id)
    .map((r) => r.id)
    .filter((id) => id !== agentId);
  const wanted = Number(position);
  const target = Number.isFinite(wanted)
    ? Math.min(Math.max(1, Math.round(wanted)), rows.length + 1)
    : rows.length + 1;
  rows.splice(target - 1, 0, agentId);
  const update = db.prepare('UPDATE agents SET team_position=? WHERE id=?');
  rows.forEach((id, index) => update.run(index + 1, id));
}

/** Reorder a whole team in one transaction (what the position slider sends). */
export function reorderTeam(id, order = [], principal) {
  const team = db.prepare('SELECT id,name FROM teams WHERE id=?').get(id);
  if (!team) fail('not-found', 'team not found');
  if (!Array.isArray(order) || !order.length) fail('bad-request', 'order must be a non-empty array of agent ids');
  const current = db.prepare('SELECT id FROM agents WHERE deleted_at IS NULL AND team_id=?').all(id).map((r) => r.id);
  const unknown = order.filter((agentId) => !current.includes(agentId));
  if (unknown.length) fail('bad-request', `not in this team: ${unknown.join(', ')}`);
  const missing = current.filter((agentId) => !order.includes(agentId));
  if (missing.length) fail('bad-request', `order must list every member (missing: ${missing.join(', ')})`);
  const update = db.prepare('UPDATE agents SET team_position=? WHERE id=?');
  db.transaction(() => order.forEach((agentId, index) => update.run(index + 1, agentId)))();
  audit(principal || 'system', 'api', 'team.reorder', { id, order }, 'allow', 'ok');
  return getTeam(id);
}

export const TEAM_LIMITS = LIMITS;
