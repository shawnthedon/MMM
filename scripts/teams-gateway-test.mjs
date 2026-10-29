/* Team membership — real gateway, real HTTP, throwaway DATA_DIR.
 * Run: npm run test:teams
 *
 * The contract under test:
 *   • membership exists once, on the agent row (`agents.team_id`), and every read agrees;
 *   • deleting a team unassigns its members — no agent is deleted, none is silently moved;
 *   • the position a slider shows is dense and real (1..n), and reordering is atomic;
 *   • writes are permissioned, validated and audited;
 *   • the legacy `team_members` join table is gone, so a second copy cannot come back.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'mmm-teams-'));
process.env.DATA_DIR = DATA_DIR;
process.env.MMM_QUIET = '1';
process.env.MMM_BOOTSTRAP_EMAIL = 'owner@test.local';
process.env.MMM_BOOTSTRAP_PASSWORD = 'OwnerPassw0rd!2026';
delete process.env.NODE_ENV;
process.env.NODE_ENV = 'test';

const { createGateway } = await import('../apps/gateway/server.js');
const { db } = await import('../apps/gateway/src/db.js');
const auth = await import('../apps/gateway/src/auth.js');

const gateway = createGateway();
await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${gateway.server.address().port}`;

const results = [];
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    results.push(`FAIL ${name}: ${error.message}`);
  }
}
const assert = (cond, message) => { if (!cond) throw new Error(message); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); };

/* ---------- client with a cookie jar + CSRF ---------- */
const CSRF_COOKIE = auth.CSRF_HEADER;
function client(ip = '10.2.0.1') {
  const jar = {};
  return {
    jar,
    async request(path, { method = 'GET', body, csrf = false } = {}) {
      const headers = { 'x-forwarded-for': ip };
      const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) headers.cookie = cookie;
      if (csrf && jar[CSRF_COOKIE]) headers[auth.CSRF_HEADER] = jar[CSRF_COOKIE];
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      for (const raw of res.headers.getSetCookie?.() || []) {
        const [pair] = raw.split(';');
        const idx = pair.indexOf('=');
        const name = pair.slice(0, idx).trim();
        const value = decodeURIComponent(pair.slice(idx + 1).trim());
        if (value === '' || /Max-Age=0/i.test(raw)) delete jar[name];
        else jar[name] = value;
      }
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      return { status: res.status, body: json, text };
    },
    async login(email, password) {
      const res = await this.request('/api/v1/auth/login', { method: 'POST', body: { email, password } });
      if (res.status === 200) jar[CSRF_COOKIE] = res.body.csrfToken;
      return res;
    },
  };
}

const owner = client('10.2.0.1');
const observer = client('10.2.0.2');
const operator = client('10.2.0.3');

const login = await owner.login('owner@test.local', 'OwnerPassw0rd!2026');
eq(login.status, 200, 'owner login');
for (const [c, role] of [[observer, 'Observer'], [operator, 'Operator']]) {
  const created = await owner.request('/api/v1/principals', {
    method: 'POST', csrf: true,
    body: { email: `${role.toLowerCase()}@test.local`, password: 'TempPassw0rd!9', name: `${role} User`, role },
  });
  eq(created.status, 201, `create ${role}`);
  eq((await c.login(`${role.toLowerCase()}@test.local`, 'TempPassw0rd!9')).status, 200, `${role} login`);
}

// The seeded fixtures are the starting point: three teams, six agents, every agent in a team.
const seeded = await owner.request('/api/v1/dev/seed', { method: 'POST', csrf: true, body: {} });
eq(seeded.status, 200, `seed (${seeded.text})`);

const teamsOf = async (c = owner) => {
  const res = await c.request('/api/v1/teams');
  eq(res.status, 200, 'GET /teams');
  return res.body;
};
/** Any agent that currently belongs to a team — the tests must not assume a particular roster. */
const firstMember = async () => {
  const { teams } = await teamsOf();
  const team = teams.find((t) => t.memberCount > 0);
  assert(team, 'no team has a member');
  return { team, member: team.members[0] };
};
const agentRow = async (id, c = owner) => {
  const res = await c.request(`/api/v1/agents/${id}`);
  eq(res.status, 200, `GET /agents/${id}`);
  return res.body;
};

/* ---------- 1. one source of truth ---------- */
await check('membership lives on the agent row and the legacy join table is gone', async () => {
  const legacy = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='team_members'").get();
  eq(legacy, undefined, 'team_members must not exist: two copies of a membership is two truths');
  const cols = db.prepare('PRAGMA table_info(agents)').all().map((c) => c.name);
  assert(cols.includes('team_id'), 'agents.team_id missing');
  assert(cols.includes('team_position'), 'agents.team_position missing');
  const fk = db.prepare('PRAGMA foreign_key_list(agents)').all().find((f) => f.from === 'team_id');
  assert(fk && fk.table === 'teams', 'agents.team_id must reference teams');
  eq(String(fk.on_delete).toUpperCase(), 'SET NULL', 'a vanished team must never take the agent with it');
});

await check('the team list and the agent row agree about who is where', async () => {
  const { teams, unassigned, totalAgents } = await teamsOf();
  assert(teams.length >= 2, 'seeded teams missing');
  let counted = 0;
  for (const team of teams) {
    eq(team.memberCount, team.members.length, `${team.name}: count and list disagree`);
    counted += team.memberCount;
    for (const [index, member] of team.members.entries()) {
      eq(member.position, index + 1, `${member.name} should be at position ${index + 1} — positions are dense and ordered`);
      const row = await agentRow(member.id);
      eq(row.team_id, team.id, `${member.name} row says team ${row.team_id}, list says ${team.id}`);
      eq(row.team_position, member.position, `${member.name} position mismatch`);
    }
  }
  eq(counted + unassigned, totalAgents, 'every agent is either in a team or counted as unassigned');
});

/* ---------- 2. assignment ---------- */
await check('assigning an agent moves it, keeps positions dense and is audited', async () => {
  const before = await teamsOf();
  const from = before.teams.find((t) => t.memberCount > 1);
  const to = before.teams.find((t) => t.id !== from.id);
  const agent = from.members[0];

  const patch = await owner.request(`/api/v1/agents/${agent.id}`, { method: 'PATCH', csrf: true, body: { team_id: to.id } });
  eq(patch.status, 200, `PATCH team (${patch.text})`);
  eq(patch.body.team_id, to.id, 'the write landed on the agent row');
  eq(patch.body.team_position, to.memberCount + 1, 'the agent is appended, not dropped at position 0');

  const after = await teamsOf();
  const oldTeam = after.teams.find((t) => t.id === from.id);
  const newTeam = after.teams.find((t) => t.id === to.id);
  eq(oldTeam.memberCount, from.memberCount - 1, 'the old team lost exactly one member');
  oldTeam.members.forEach((m, i) => eq(m.position, i + 1, 'the old team renumbered with no gap'));
  eq(newTeam.memberCount, to.memberCount + 1, 'the new team gained exactly one member');

  const audit = db.prepare("SELECT * FROM audit_log WHERE event='team.assign' ORDER BY seq DESC LIMIT 1").get();
  assert(audit, 'assignment must be audited');
  assert(!/password|token|secret/i.test(audit.args_redacted), 'audit args must not carry secrets');
});

await check('an agent is in exactly one team at a time', async () => {
  const { teams } = await teamsOf();
  const seen = new Map();
  for (const team of teams) for (const m of team.members) {
    eq(seen.has(m.id), false, `${m.name} appears in both ${seen.get(m.id)} and ${team.name}`);
    seen.set(m.id, team.name);
  }
});

await check('a bad team id is refused instead of silently ignored', async () => {
  const { team, member } = await firstMember();
  const res = await owner.request(`/api/v1/agents/${member.id}`, { method: 'PATCH', csrf: true, body: { team_id: 'tm-does-not-exist' } });
  eq(res.status, 404, 'unknown team must be 404');
  eq((await agentRow(member.id)).team_id, team.id, 'the failed write changed nothing');
});

/* ---------- 3. ordering ---------- */
await check('the position slider reorders a team atomically and refuses a partial order', async () => {
  const { teams } = await teamsOf();
  const team = teams.find((t) => t.memberCount >= 2);
  const reversed = team.members.map((m) => m.id).reverse();
  const res = await owner.request(`/api/v1/teams/${team.id}/order`, { method: 'POST', csrf: true, body: { order: reversed } });
  eq(res.status, 200, `reorder (${res.text})`);
  res.body.members.forEach((m, i) => eq(m.id, reversed[i], `position ${i + 1}`));
  res.body.members.forEach((m, i) => eq(m.position, i + 1, 'positions stay dense after a reorder'));

  const partial = await owner.request(`/api/v1/teams/${team.id}/order`, { method: 'POST', csrf: true, body: { order: [reversed[0]] } });
  eq(partial.status, 400, 'a partial order must be refused, not quietly accepted');
  const after = await owner.request(`/api/v1/teams/${team.id}`);
  after.body.members.forEach((m, i) => eq(m.id, reversed[i], 'a refused reorder changes nothing'));
});

/* ---------- 4. the named requirement ---------- */
await check('deleting a team unassigns members instead of deleting them', async () => {
  const create = await owner.request('/api/v1/teams', { method: 'POST', csrf: true, body: { name: 'Doomed Cell', description: 'created by the test' } });
  eq(create.status, 201, `create team (${create.text})`);
  const teamId = create.body.id;

  const { teams } = await teamsOf();
  const donor = teams.find((t) => t.memberCount > 1);
  const victims = donor.members.slice(0, 2).map((m) => m.id);
  for (const [index, id] of victims.entries()) {
    const assigned = await owner.request(`/api/v1/teams/${teamId}/members`, { method: 'POST', csrf: true, body: { agentId: id, position: index + 1 } });
    eq(assigned.status, 200, `add member (${assigned.text})`);
  }
  const roster = await owner.request(`/api/v1/teams/${teamId}`);
  eq(roster.body.memberCount, 2, 'two agents to protect');
  const agentsBefore = db.prepare('SELECT COUNT(*) n FROM agents WHERE deleted_at IS NULL').get().n;

  const del = await owner.request(`/api/v1/teams/${teamId}`, { method: 'DELETE', csrf: true });
  eq(del.status, 200, `delete team (${del.text})`);
  eq(del.body.agentsDeleted, 0, 'deleting a team must not report a deleted agent');
  eq(del.body.unassigned.length, 2, 'both members are reported back as unassigned');
  victims.forEach((id) => assert(del.body.unassigned.some((m) => m.id === id), `${id} missing from the unassigned list`));
  assert(/unassigned/i.test(del.body.summary) && /none deleted|No agent was deleted/i.test(del.body.summary),
    'the summary must say the agents were unassigned, not deleted');

  eq(db.prepare('SELECT COUNT(*) n FROM agents WHERE deleted_at IS NULL').get().n, agentsBefore, 'no agent row disappeared');
  for (const id of victims) {
    const row = await agentRow(id);
    eq(row.team_id, null, `${id} must be unassigned (teamId → null)`);
    eq(row.team_position, 0, `${id} must not keep a stale position`);
  }
  const stillThere = await owner.request('/api/v1/teams');
  eq(stillThere.body.teams.some((t) => t.id === teamId), false, 'the team itself is gone');
  victims.forEach((id) => assert(stillThere.body.teams.every((t) => !t.members.some((m) => m.id === id)),
    `${id} must not be silently moved to another team`));

  const audit = db.prepare("SELECT * FROM audit_log WHERE event='team.delete' ORDER BY seq DESC LIMIT 1").get();
  assert(audit, 'deleting a team must be audited');
  assert(/"agentsDeleted":0/.test(audit.args_redacted), 'the audit record must state that no agent was deleted');
});

await check('deleting a team detaches swarms instead of failing on the foreign key', async () => {
  const team = await owner.request('/api/v1/teams', { method: 'POST', csrf: true, body: { name: 'Swarm Host' } });
  eq(team.status, 201, 'create the swarm host team');
  const teamId = team.body.id;
  const { member: agent } = await firstMember();
  await owner.request(`/api/v1/teams/${teamId}/members`, { method: 'POST', csrf: true, body: { agentId: agent.id } });
  db.prepare('INSERT INTO swarms (id,team_id,name,objective,status,progress,budget,nodes,channel,started_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run('sw-team-test', teamId, 'swarm-under-test', '', 'draft', 0, '{}', '[]', '', Date.now(), 'test');
  const del = await owner.request(`/api/v1/teams/${teamId}`, { method: 'DELETE', csrf: true });
  eq(del.status, 200, `delete must succeed (${del.text})`);
  eq(del.body.detachedSwarms.length, 1, 'the swarm is reported as detached');
  const row = db.prepare('SELECT team_id FROM swarms WHERE id=?').get('sw-team-test');
  eq(row.team_id, null, 'the swarm survives with no team');
});

/* ---------- 5. permissions & validation ---------- */
await check('reading is open to an Observer, writing is not', async () => {
  const { teams } = await teamsOf(observer);
  assert(teams.length > 0, 'an Observer can read teams');
  const { member } = await firstMember();
  const deniedCreate = await observer.request('/api/v1/teams', { method: 'POST', csrf: true, body: { name: 'Nope' } });
  eq(deniedCreate.status, 403, 'Observer cannot create a team');
  const deniedRename = await observer.request(`/api/v1/teams/${teams[0].id}`, { method: 'PATCH', csrf: true, body: { name: 'Nope' } });
  eq(deniedRename.status, 403, 'Observer cannot rename a team');
  const deniedDelete = await observer.request(`/api/v1/teams/${teams[0].id}`, { method: 'DELETE', csrf: true });
  eq(deniedDelete.status, 403, 'Observer cannot delete a team');
  const deniedAssign = await observer.request(`/api/v1/agents/${member.id}`, { method: 'PATCH', csrf: true, body: { team_id: null } });
  eq(deniedAssign.status, 403, 'Observer cannot move an agent');
});

await check('an Operator can manage teams but the write is validated', async () => {
  const created = await operator.request('/api/v1/teams', { method: 'POST', csrf: true, body: { name: '  ' } });
  eq(created.status, 400, 'an empty name is refused');
  const ok = await operator.request('/api/v1/teams', { method: 'POST', csrf: true, body: { name: 'Ops Annex' } });
  eq(ok.status, 201, `Operator creates a team (${ok.text})`);
  const dupe = await operator.request('/api/v1/teams', { method: 'POST', csrf: true, body: { name: 'ops annex' } });
  eq(dupe.status, 409, 'a duplicate name is a conflict, not a second team');
  const renamed = await operator.request(`/api/v1/teams/${ok.body.id}`, { method: 'PATCH', csrf: true, body: { name: 'Ops Annex 2', description: 'renamed' } });
  eq(renamed.status, 200, 'rename');
  eq(renamed.body.name, 'Ops Annex 2', 'the new name is stored');
  eq(renamed.body.description, 'renamed', 'the description is stored');
  const missing = await operator.request('/api/v1/teams/tm-not-real', { method: 'PATCH', csrf: true, body: { name: 'x' } });
  eq(missing.status, 404, 'unknown team is 404');
});

await check('anonymous callers cannot read or write teams', async () => {
  const anon = client('10.2.9.9');
  eq((await anon.request('/api/v1/teams')).status, 401, 'GET /teams must be 401');
  eq((await anon.request('/api/v1/teams', { method: 'POST', body: { name: 'x' } })).status, 401, 'POST must be 401');
});

/* ---------- 6. agent identity fields used by the panel ---------- */
await check('the agent panel fields round-trip and are bounded', async () => {
  const { member: agent } = await firstMember();
  const patch = await operator.request(`/api/v1/agents/${agent.id}`, {
    method: 'PATCH', csrf: true,
    body: {
      goal: 'Keep the release notes accurate.',
      prompt: 'You are a careful editor.\n\nEvery claim needs a source.\nNever invent a link.',
      responsibilities: ['Cite every claim', 'Flag contradictions'],
      approval_gates: { beforeToolCall: true, beforeDeploy: false, beforeSpend: true },
      description: 'Reads the release, checks the notes.',
    },
  });
  eq(patch.status, 200, `agent patch (${patch.text})`);
  eq(patch.body.goal, 'Keep the release notes accurate.', 'goal stored');
  assert(patch.body.prompt.includes('\n\n'), 'the multi-line prompt survives intact — it must never be truncated');
  eq(patch.body.prompt.split('\n').length, 4, 'every line of the prompt is stored, including the blank one');
  eq(patch.body.responsibilities.length, 2, 'responsibilities stored');
  eq(patch.body.approval_gates.beforeDeploy, false, 'gates stored');
  const reread = await agentRow(agent.id);
  eq(reread.prompt, patch.body.prompt, 'a re-read returns the same prompt, character for character');

  const empty = await operator.request(`/api/v1/agents/${agent.id}`, { method: 'PATCH', csrf: true, body: { prompt: '' } });
  // An empty prompt is accepted by the API; the panel refuses it before sending. Recorded here so the
  // difference is a decision, not an accident.
  eq(empty.status, 200, 'the API accepts an empty prompt; the panel is the guard');
  db.prepare('UPDATE agents SET prompt=? WHERE id=?').run(reread.prompt, agent.id);
});

/* ---------- report ---------- */
console.log(results.join('\n'));
const passed = results.filter((r) => r.startsWith('PASS')).length;
console.log(`\nTEAM MEMBERSHIP: ${passed} passed, ${failures} failed`);
rmSync(DATA_DIR, { recursive: true, force: true });
gateway.server.close();
process.exit(failures ? 1 : 0);
