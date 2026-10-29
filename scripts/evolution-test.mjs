/* Self-modification acceptance tests — the 18 criteria from the specification, plus the surface.
 * Run: npm run test:evolution
 *
 * These drive a real gateway over HTTP against a throwaway DATA_DIR, and run real commands in the
 * sandbox (node, inside the experiment workspace). Nothing here writes to the repository: the demo
 * agent under `agents/demo-writer/` is copied into a workspace, never edited in place.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'mmm-evolution-'));
process.env.DATA_DIR = DATA_DIR;
process.env.MMM_QUIET = '1';
process.env.NODE_ENV = 'test';
process.env.MMM_BOOTSTRAP_EMAIL = 'owner@test.local';
process.env.MMM_BOOTSTRAP_PASSWORD = 'OwnerPassw0rd!2026';

const { createGateway } = await import('../apps/gateway/server.js');
const auth = await import('../apps/gateway/src/auth.js');
const { db, verifyAuditChain } = await import('../apps/gateway/src/db.js');

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

/* ---------- HTTP client with a cookie jar ---------- */
const CSRF = auth.CSRF_HEADER;
function client(ip) {
  const jar = {};
  return {
    jar,
    async request(path, { method = 'GET', body } = {}) {
      const h = { 'x-forwarded-for': ip };
      const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) h.cookie = cookie;
      if (jar[CSRF]) h[CSRF] = jar[CSRF];
      if (body !== undefined) h['content-type'] = 'application/json';
      const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      for (const raw of res.headers.getSetCookie?.() || []) {
        const [pair] = raw.split(';');
        const idx = pair.indexOf('=');
        const name = pair.slice(0, idx).trim();
        const value = decodeURIComponent(pair.slice(idx + 1).trim());
        if (value === '' || /Max-Age=0/i.test(raw)) delete jar[name];
        else jar[name] = value;
      }
      const text = await res.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
      return { status: res.status, body: parsed, text };
    },
    async login(email, password) {
      const res = await this.request('/api/v1/auth/login', { method: 'POST', body: { email, password } });
      if (res.status === 200) jar[CSRF] = res.body.csrfToken;
      return res;
    },
  };
}

const owner = client('10.8.0.1');
const reviewer = client('10.8.0.2');
const operator = client('10.8.0.3');
const anon = client('10.8.0.9');
await owner.login('owner@test.local', 'OwnerPassw0rd!2026');

const as = (res) => res.body?.experiment || res.body;
const fileOf = (p) => readFileSync(join(process.cwd(), p), 'utf8');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const repoGreetBefore = sha(fileOf('agents/demo-writer/greet.mjs'));
const repoTestBefore = sha(fileOf('agents/demo-writer/greet.test.mjs'));

/* ---------- fixtures: agents and principals ---------- */
const A = 'demo-writer';       // the author agent
const R = 'demo-reviewer';     // an independent reviewer agent
const SP = 'demo-specialist';  // a freshly created specialist (AC9)

async function createAgent(id, name) {
  const res = await owner.request('/api/v1/agents', { method: 'POST', body: { id, name, framework: 'LangGraph', model: 'none', role: 'writer' } });
  assert([201, 400].includes(res.status), `agent ${id} create: ${res.status} ${res.text.slice(0, 200)}`);
}

await createAgent(A, 'Demo Writer');
await createAgent(R, 'Demo Reviewer');
await createAgent(SP, 'Demo Specialist');

for (const [email, role, name] of [['reviewer@test.local', 'Reviewer', 'Gate Reviewer'], ['operator@test.local', 'Operator', 'Ops']]) {
  const created = await owner.request('/api/v1/principals', { method: 'POST', body: { email, name, role, password: 'OtherPassw0rd!2026' } });
  assert([201, 409].includes(created.status), `principal ${email}: ${created.status}`);
}
await reviewer.login('reviewer@test.local', 'OtherPassw0rd!2026');
await operator.login('operator@test.local', 'OtherPassw0rd!2026');

/* ============================== surface ============================== */

await check('capabilities state the five levels, the sandbox’s real limits and the protected components', async () => {
  const res = await owner.request('/api/v1/evolution/capabilities');
  eq(res.status, 200, 'capabilities status');
  const caps = res.body;
  eq(caps.levels.length, 5, 'five autonomy levels');
  eq(caps.defaultLevel, 1, 'the default is recommend-only');
  assert(caps.protected.length >= 6, 'the protected component list must be published');
  assert(caps.protected.some((p) => /evolution/.test(p.pattern)), 'the module’s own safeguards are protected');
  eq(caps.sandbox.isolation, 'process', 'the sandbox must not claim container isolation');
  assert(caps.sandbox.notEnforced.join(' ').includes('network'), 'the sandbox must say network isolation is not enforced');
  assert(/level 1/.test(caps.note), 'the report must state the default authority');
});

await check('every agent — including ones created later — has a self-improvement policy', async () => {
  const caps = await owner.request('/api/v1/evolution/capabilities');
  eq(caps.body.agents.total, caps.body.agents.withPolicy, 'every agent must have a policy');
  const list = await owner.request('/api/v1/evolution/agents');
  const specialist = list.body.agents.find((a) => a.id === SP);
  assert(specialist, 'the newest agent must be listed');
  eq(specialist.policy.level, 1, 'a new agent starts at level 1');
  eq(specialist.policy.scope[0], `agents/${SP}/**`, 'its default scope is its own directory');
});

await check('self-modification is readable by an Observer and writable only with the right permission', async () => {
  const observer = client('10.8.0.4');
  await owner.request('/api/v1/principals', { method: 'POST', body: { email: 'watcher2@test.local', name: 'Watcher', role: 'Observer', password: 'WatchPassw0rd!2026' } });
  await observer.login('watcher2@test.local', 'WatchPassw0rd!2026');
  eq((await observer.request('/api/v1/evolution/capabilities')).status, 200, 'Observer reads the policy');
  eq((await observer.request('/api/v1/evolution/experiments', { method: 'POST', body: {} })).status, 403, 'Observer cannot open an experiment');
  eq((await anon.request('/api/v1/evolution/capabilities')).status, 401, 'anonymous is refused');

  // Raising autonomy is an Owner action, never an Operator one.
  const escalate = await operator.request(`/api/v1/evolution/agents/${A}/policy`, { method: 'PATCH', body: { level: 4, confirmHigher: true } });
  eq(escalate.status, 403, 'an Operator cannot raise an agent’s autonomy');
});

/* ============================== AC1 … AC3 ============================== */

let exp = null;
await check('AC1 an authorised agent can inspect permitted code and identify a reproducible defect', async () => {
  const obs = await owner.request(`/api/v1/evolution/agents/${A}/observations`, {
    method: 'POST',
    body: { source: 'test-failure', kind: 'demo-writer', detail: 'greet.test.mjs fails: greet("Ada") returns "hi Ada", the suite expects "Hello, Ada"', evidence: { command: 'node agents/demo-writer/greet.test.mjs', exit: 1 } },
  });
  eq(obs.status, 200, 'observation recorded');

  const created = await owner.request('/api/v1/evolution/experiments', {
    method: 'POST',
    body: {
      agentId: A,
      title: 'Fix the greeting defect',
      problem: 'greet.test.mjs fails because greet() returns “hi Ada” instead of “Hello, Ada”.',
      observationIds: [obs.body.id],
      files: [`agents/${A}/greet.mjs`, `agents/${A}/greet.test.mjs`, `agents/${A}/health.mjs`],
    },
  });
  eq(created.status, 200, `experiment created: ${created.text.slice(0, 200)}`);
  exp = created.body;
  eq(exp.status, 'proposed', 'starts as proposed');
  eq(exp.level, 1, 'records the authority it was opened under');

  const baseline = await owner.request(`/api/v1/evolution/experiments/${exp.id}/file?path=${encodeURIComponent(`agents/${A}/greet.mjs`)}`);
  eq(baseline.status, 200, 'the permitted file is readable');
  assert(/hi \$\{name\}/.test(baseline.body.baseline), 'the defect is visible in the inspected source');
  assert(/Hello, Ada/.test((await owner.request(`/api/v1/evolution/experiments/${exp.id}/file?path=${encodeURIComponent(`agents/${A}/greet.test.mjs`)}`)).body.baseline), 'the expectation is readable too');

  const blocked = await owner.request(`/api/v1/evolution/experiments/${exp.id}/file?path=${encodeURIComponent('apps/gateway/src/rbac.js')}`);
  eq(blocked.status, 403, 'a protected component cannot be inspected through an experiment');

  const diagnosis = await owner.request(`/api/v1/evolution/experiments/${exp.id}/diagnose`, {
    method: 'POST',
    body: {
      problem: 'greet() returns a lowercase greeting without a comma',
      evidence: [{ detail: 'node greet.test.mjs → 3 failing, exit 1', measured: true, source: 'test-failure' }],
      files: [`agents/${A}/greet.mjs`],
      rootCause: 'the template string is “hi ${name}” instead of “Hello, ${name}”',
      solution: 'change the greeting to match the documented behaviour',
      regressions: ['farewell() shares the same style; keep it consistent'],
      tests: ['node agents/demo-writer/greet.test.mjs'],
    },
  });
  eq(diagnosis.status, 200, 'diagnosis accepted');
  assert(/hi \$\{name\}/.test(diagnosis.body.diagnosis.rootCause), 'the root cause is stored');

  const noEvidence = await owner.request(`/api/v1/evolution/experiments/${exp.id}/diagnose`, { method: 'POST', body: { problem: 'it feels slow', evidence: [] } });
  eq(noEvidence.status, 400, 'a diagnosis without evidence is refused');
});

await check('AC8 the platform rejects a plan or an edit that exceeds the authorised scope', async () => {
  const plan = await owner.request(`/api/v1/evolution/experiments/${exp.id}/plan`, {
    method: 'POST',
    body: { outcome: 'the greeting matches the test', files: ['src/main.js'], tests: ['node agents/demo-writer/greet.test.mjs'] },
  });
  eq(plan.status, 400, 'a plan outside the scope is refused');
  assert(/outside the scope/i.test(plan.body.error), `the refusal must explain the scope (${plan.body.error})`);

  const good = await owner.request(`/api/v1/evolution/experiments/${exp.id}/plan`, {
    method: 'POST',
    body: { outcome: 'the greeting matches the documented behaviour', files: [`agents/${A}/greet.mjs`], tests: ['node agents/demo-writer/greet.test.mjs'], risks: ['cosmetic only'], rollback: 'revert the greeting', approvalLevel: 1 },
  });
  eq(good.status, 200, 'a plan inside the scope is accepted');

  const protectedFile = await owner.request('/api/v1/evolution/experiments', {
    method: 'POST',
    body: { agentId: A, title: 'Rewrite the guard', problem: 'the agent wants to edit its own enforcement', files: ['apps/gateway/src/rbac.js'] },
  });
  eq(protectedFile.status, 400, 'an experiment cannot even name a protected component as writable');
  assert(/protected/i.test(protectedFile.body.error), 'the refusal names the protected component');
});

let workspacePath = '';
await check('AC2 the candidate is isolated: level 1 cannot write, level 2 gets a working copy, the repo is untouched', async () => {
  const refused = await owner.request(`/api/v1/evolution/experiments/${exp.id}/workspace`, { method: 'POST', body: {} });
  eq(refused.status, 409, 'level 1 (recommend only) cannot create a working copy');
  assert(/inspect and propose/.test(refused.body.error), 'the refusal explains the level');

  const raised = await owner.request(`/api/v1/evolution/agents/${A}/policy`, { method: 'PATCH', body: { level: 2, confirmHigher: true } });
  eq(raised.status, 200, 'an Owner can raise the level to 2 (modify and test)');
  eq(raised.body.after.level, 2, 'level 2 is stored');

  const ws = await owner.request(`/api/v1/evolution/experiments/${exp.id}/workspace`, { method: 'POST', body: {} });
  eq(ws.status, 200, `working copy created: ${ws.text.slice(0, 200)}`);
  eq(ws.body.status, 'workspace_ready', 'the experiment moves to a working copy');
  assert(ws.body.baseVersion, 'the baseline version is recorded');
  workspacePath = join(DATA_DIR, 'experiments', exp.id);
  assert(existsSync(workspacePath), 'the workspace lives under DATA_DIR, not the repository');
  eq(sha(fileOf('agents/demo-writer/greet.mjs')), repoGreetBefore, 'the repository copy is untouched');
});

await check('AC3 the agent can modify the candidate and produce a readable diff with reasons', async () => {
  const edit = await owner.request(`/api/v1/evolution/experiments/${exp.id}/edit`, {
    method: 'POST',
    body: {
      path: `agents/${A}/greet.mjs`,
      content: 'export function greet(name = \'world\') {\n  return `Hello, ${name}`;\n}\n\nexport function farewell(name = \'world\') {\n  return `Goodbye, ${name}`;\n}\n',
      reason: 'match the documented greeting and keep farewell consistent',
    },
  });
  eq(edit.status, 200, `edit accepted: ${edit.text.slice(0, 200)}`);
  const detail = await owner.request(`/api/v1/evolution/experiments/${exp.id}`);
  assert(detail.body.diff.includes('-  return `hi ${name}`;'), 'the diff shows the removed line');
  assert(detail.body.diff.includes('+  return `Hello, ${name}`;'), 'the diff shows the added line');
  assert(detail.body.diff.startsWith('--- a/'), 'the diff is a unified diff with file headers');
  eq(detail.body.changes[`agents/${A}/greet.mjs`].reason, 'match the documented greeting and keep farewell consistent', 'the reason is stored with the change');
  eq(sha(fileOf('agents/demo-writer/greet.mjs')), repoGreetBefore, 'the live repository still has the defect');

  const noReason = await owner.request(`/api/v1/evolution/experiments/${exp.id}/edit`, { method: 'POST', body: { path: `agents/${A}/greet.mjs`, content: 'x', reason: '' } });
  eq(noReason.status, 400, 'an unexplained change is refused');

  const outside = await owner.request(`/api/v1/evolution/experiments/${exp.id}/edit`, { method: 'POST', body: { path: 'src/main.js', content: '// nope', reason: 'widen the scope' } });
  eq(outside.status, 400, 'an edit outside the scope is refused');
  assert(/outside the scope/i.test(outside.body.error), 'the refusal explains why');

  const protectedEdit = await owner.request(`/api/v1/evolution/experiments/${exp.id}/edit`, { method: 'POST', body: { path: 'apps/gateway/src/evolution/policy.js', content: '// disable the guards', reason: 'make approvals optional' } });
  eq(protectedEdit.status, 403, 'a protected component is refused');
  const after = await owner.request(`/api/v1/evolution/experiments/${exp.id}`);
  assert(after.body.events.some((e) => e.stage === 'recommendation'), 'the attempt is recorded as a recommendation for a human');
});

/* ============================== AC4 … AC6 ============================== */

await check('AC4 the sandbox runs the suite and reports the actual result, with output', async () => {
  const run = await owner.request(`/api/v1/evolution/experiments/${exp.id}/test`, { method: 'POST', body: { command: 'node agents/demo-writer/greet.test.mjs' } });
  eq(run.status, 200, `test run accepted: ${run.text.slice(0, 200)}`);
  eq(run.body.tests.passed, true, 'a fixed candidate passes');
  assert(/all passing/.test(run.body.tests.runs.at(-1).stdout), 'the real stdout is stored');
  eq(run.body.testRuns, 1, 'the run is counted');
  const workspace = join(DATA_DIR, 'experiments', exp.id, 'work');
  assert(existsSync(join(workspace, 'agents', 'demo-writer', 'greet.test.mjs')), 'tests run against the candidate copy');
});

await check('AC5 after a failure the agent fixes it within limits; a spent retry budget escalates honestly', async () => {
  const broken = await owner.request(`/api/v1/evolution/experiments/${exp.id}/edit`, {
    method: 'POST',
    body: { path: `agents/${A}/greet.mjs`, content: 'export function greet(name = \'world\') { return `hi ${name}`; }\nexport function farewell(name = \'world\') { return `bye ${name}`; }\n', reason: 're-introduce the defect to prove the failure path' },
  });
  eq(broken.status, 200, 'the candidate can be broken again');
  const failed = await owner.request(`/api/v1/evolution/experiments/${exp.id}/test`, { method: 'POST', body: { command: 'node agents/demo-writer/greet.test.mjs' } });
  eq(failed.status, 200, 'the run completes');
  eq(failed.body.tests.passed, false, 'a failing run is reported as failing');
  eq(failed.body.status, 'test_failed', 'the experiment is marked test_failed');
  assert(/FAIL/.test(failed.body.tests.runs.at(-1).stdout), 'the failing assertion is captured');

  await owner.request(`/api/v1/evolution/experiments/${exp.id}/edit`, {
    method: 'POST',
    body: { path: `agents/${A}/greet.mjs`, content: 'export function greet(name = \'world\') {\n  return `Hello, ${name}`;\n}\n\nexport function farewell(name = \'world\') {\n  return `Goodbye, ${name}`;\n}\n', reason: 'correct the greeting after the failing run' },
  });
  const fixed = await owner.request(`/api/v1/evolution/experiments/${exp.id}/test`, { method: 'POST', body: { command: 'node agents/demo-writer/greet.test.mjs' } });
  eq(fixed.body.tests.passed, true, 'the corrected candidate passes');
  eq(fixed.body.testRuns, 3, 'every attempt is counted (1 pass, 1 fail, 1 pass)');
});

await check('AC6 a candidate cannot pass by deleting or weakening the test that catches it', async () => {
  const second = await owner.request('/api/v1/evolution/experiments', {
    method: 'POST',
    body: { agentId: A, title: 'Delete the failing test', problem: 'the greeting test keeps failing, so removing it would make the suite green', files: [`agents/${A}/greet.mjs`, `agents/${A}/greet.test.mjs`] },
  });
  eq(second.status, 200, 'a second experiment can be opened');
  const id = second.body.id;
  await owner.request(`/api/v1/evolution/experiments/${id}/plan`, { method: 'POST', body: { outcome: 'make the suite green by deleting the test', files: [`agents/${A}/greet.test.mjs`], tests: ['node agents/demo-writer/greet.test.mjs'] } });
  eq((await owner.request(`/api/v1/evolution/experiments/${id}/workspace`, { method: 'POST', body: {} })).status, 200, 'workspace created');
  const del = await owner.request(`/api/v1/evolution/experiments/${id}/delete-file`, { method: 'POST', body: { path: `agents/${A}/greet.test.mjs`, reason: 'the test is inconvenient' } });
  eq(del.status, 200, 'the file can be deleted in the candidate');
  const run = await owner.request(`/api/v1/evolution/experiments/${id}/test`, { method: 'POST', body: { command: 'node agents/demo-writer/greet.test.mjs' } });
  eq(run.status, 200, 'the attempt completes');
  eq(run.body.status, 'blocked', 'deleting the test blocks the experiment');
  assert(/removes a test/i.test(run.body.blocker), `the blocker must say what happened (${run.body.blocker})`);
  assert(run.body.tests?.passed !== true, 'it can never be reported as passing');
  const detail = await owner.request(`/api/v1/evolution/experiments/${id}`);
  assert(detail.body.integrity.findings.some((f) => f.kind === 'test-removed'), 'the integrity finding is recorded');
});

/* ============================== AC7 … AC11 ============================== */

await check('AC7 only a separate reviewer can review, and findings are actionable', async () => {
  const self = await owner.request(`/api/v1/evolution/experiments/${exp.id}/review`, { method: 'POST', body: { reviewer: A, verdict: 'approve' } });
  eq(self.status, 409, 'an agent cannot review its own change');
  assert(/independent reviewer/i.test(self.body.error), 'the refusal explains independence');

  const objecting = await owner.request(`/api/v1/evolution/experiments/${exp.id}/review`, {
    method: 'POST',
    body: { reviewer: R, verdict: 'changes-required', findings: ['farewell() now changes behaviour that no test covers'] },
  });
  eq(objecting.status, 200, 'the reviewer can object');
  eq(objecting.body.status, 'review_required', 'an objection keeps the change out of promotion');
  eq(objecting.body.reviews.length, 1, 'the review is recorded');
  eq(objecting.body.reviews[0].independent, true, 'it is marked independent');

  const empty = await owner.request(`/api/v1/evolution/experiments/${exp.id}/review`, { method: 'POST', body: { reviewer: R, verdict: 'changes-required', findings: [] } });
  eq(empty.status, 400, 'a non-approving review must say what is wrong');

  const approve = await owner.request(`/api/v1/evolution/experiments/${exp.id}/review`, {
    method: 'POST',
    body: { reviewer: R, verdict: 'approve', findings: ['checked the farewell change against the module README'] },
  });
  eq(approve.status, 200, 'the reviewer can approve after the objection');
  eq(approve.body.status, 'reviewed', 'the experiment moves to reviewed');

  const unknown = await owner.request(`/api/v1/evolution/experiments/${exp.id}/review`, { method: 'POST', body: { reviewer: 'ghost-agent', verdict: 'approve' } });
  eq(unknown.status, 404, 'an unknown reviewer is refused');
});

await check('AC17 the comparison states the evidence and its limits, and the gates are visible', async () => {
  const compare = await owner.request(`/api/v1/evolution/experiments/${exp.id}/compare`, { method: 'POST', body: {} });
  eq(compare.status, 200, 'comparison runs');
  const c = compare.body.compare;
  assert(c.candidateVersion, 'a candidate version is computed');
  assert(c.evidence.testsPassed === true, 'the passing test run is cited');
  assert(/not a proof/i.test(c.coverage), 'the coverage claim must be bounded');
  assert(c.limitations.length >= 2, 'limitations must be stated');
  assert(['low', 'elevated', 'high'].includes(c.risk.level), 'a risk level is assigned');
  eq(c.risk.level, 'low', `a small in-scope change with passing tests is low risk (${c.risk.reason})`);
});

await check('AC11 a candidate cannot deploy before the approval policy is satisfied', async () => {
  const deploy = await owner.request(`/api/v1/evolution/experiments/${exp.id}/deploy`, { method: 'POST', body: {} });
  eq(deploy.status, 409, 'level 2 cannot deploy');
  assert(/approval/i.test(deploy.body.error), `the refusal must mention approval (${deploy.body.error})`);

  const selfApprove = await owner.request(`/api/v1/evolution/experiments/${exp.id}/approve`, { method: 'POST', body: { decision: 'approve' } });
  eq(selfApprove.status, 409, 'the principal that opened the experiment cannot approve it');

  const approved = await reviewer.request(`/api/v1/evolution/experiments/${exp.id}/approve`, { method: 'POST', body: { decision: 'approve', note: 'diff and tests reviewed' } });
  eq(approved.status, 200, 'an independent Reviewer can approve');
  eq(approved.body.experiment.status, 'approved', 'the experiment is approved');

  const live = await owner.request(`/api/v1/evolution/experiments/${exp.id}/deploy`, { method: 'POST', body: {} });
  eq(live.status, 200, `deployment accepted after approval: ${live.text.slice(0, 200)}`);
  eq(live.body.experiment.status, 'deployed', 'the experiment is deployed');
  assert(live.body.version.id, 'an exact candidate version is referenced');
  const versions = await owner.request(`/api/v1/evolution/agents/${A}/versions`);
  eq(versions.body.active.versionId, live.body.version.id, 'that version is the active one');
  eq(sha(fileOf('agents/demo-writer/greet.mjs')), repoGreetBefore, 'deployment does not touch the repository');
});

/* ============================== AC12 … AC14 ============================== */

await check('AC12 an eligible low-risk candidate is deployed automatically under a level-4 policy', async () => {
  const policy = await owner.request(`/api/v1/evolution/agents/${A}/policy`, {
    method: 'PATCH',
    body: { level: 4, confirmHigher: true, allowAutoStage: true, allowAutoDeploy: true, healthCheck: { command: 'node agents/demo-writer/health.mjs' } },
  });
  eq(policy.status, 200, 'the Owner can grant bounded deployment');
  eq(policy.body.after.level, 4, 'level 4 stored');

  const created = await owner.request('/api/v1/evolution/experiments', {
    method: 'POST',
    body: { agentId: A, title: 'Polish the farewell wording', problem: 'the farewell wording differs from the documented style used by the greeting', files: [`agents/${A}/greet.mjs`, `agents/${A}/greet.test.mjs`, `agents/${A}/health.mjs`] },
  });
  const id = created.body.id;
  await owner.request(`/api/v1/evolution/experiments/${id}/plan`, { method: 'POST', body: { outcome: 'keep the farewell wording consistent with the greeting style', files: [`agents/${A}/greet.mjs`], tests: ['node agents/demo-writer/greet.test.mjs'] } });
  await owner.request(`/api/v1/evolution/experiments/${id}/workspace`, { method: 'POST', body: {} });
  await owner.request(`/api/v1/evolution/experiments/${id}/edit`, {
    method: 'POST',
    body: { path: `agents/${A}/greet.mjs`, content: 'export function greet(name = \'world\') {\n  return `Hello, ${name}`;\n}\n\nexport function farewell(name = \'world\') {\n  return `Goodbye, ${name}`;\n}\n', reason: 'same wording as the deployed greeting' },
  });
  const tested = await owner.request(`/api/v1/evolution/experiments/${id}/test`, { method: 'POST', body: { command: 'node agents/demo-writer/greet.test.mjs' } });
  eq(tested.body.tests.passed, true, 'tests pass');
  await owner.request(`/api/v1/evolution/experiments/${id}/review`, { method: 'POST', body: { reviewer: R, verdict: 'approve', findings: ['wording only, matches the README'] } });
  const compared = await owner.request(`/api/v1/evolution/experiments/${id}/compare`, { method: 'POST', body: {} });
  eq(compared.body.compare.risk.level, 'low', 'the change is low risk');

  const deployed = await owner.request(`/api/v1/evolution/experiments/${id}/deploy`, { method: 'POST', body: {} });
  eq(deployed.status, 200, `automatic deployment: ${deployed.text.slice(0, 300)}`);
  eq(deployed.body.experiment.status, 'deployed', 'it is deployed without a human approval step');
  eq(deployed.body.experiment.approval.decision, undefined, 'no approval decision was recorded — none was needed');
  assert(deployed.body.experiment.tests.preflightHealth?.ok === true, 'the pre-flight health check ran and passed');
});

await check('AC13 a failing health check stops promotion and rolls the agent back automatically', async () => {
  const before = await owner.request(`/api/v1/evolution/agents/${A}/versions`);
  const previousVersion = before.body.active.versionId;
  assert(previousVersion, 'a previous version exists');

  // The operator tightens the health check after the deployment. The next check fails, and the
  // platform restores the last known-good version instead of leaving the agent broken.
  await owner.request(`/api/v1/evolution/agents/${A}/policy`, { method: 'PATCH', body: { healthCheck: { command: 'node missing-health.mjs' } } });
  const health = await owner.request(`/api/v1/evolution/agents/${A}/health`, { method: 'POST', body: {} });
  eq(health.status, 200, 'the health check runs');
  eq(health.body.ok, false, 'the failing check is reported honestly');
  assert(health.body.rolledBack, 'a rollback was triggered');
  assert(health.body.rolledBack.automatic === true, 'the rollback is marked automatic');
  const after = await owner.request(`/api/v1/evolution/agents/${A}/versions`);
  assert(after.body.active.versionId !== previousVersion, 'the active version changed');
  eq(after.body.versions.filter((v) => v.status === 'rolled_back').length >= 1, true, 'the failed version is recorded as rolled back');
});

await check('AC14 an authorised user can roll back and inspect the audit record', async () => {
  const versions = await owner.request(`/api/v1/evolution/agents/${A}/versions`);
  const target = versions.body.versions.find((v) => v.status !== 'deployed');
  assert(target, 'there is an earlier version to restore');
  const rollback = await owner.request(`/api/v1/evolution/agents/${A}/rollback`, { method: 'POST', body: { reason: 'restore the reviewed version' } });
  eq(rollback.status, 200, `rollback accepted: ${rollback.text.slice(0, 200)}`);
  eq(rollback.body.versionId, target.id, 'the earlier version is restored');

  const auditLog = await owner.request('/api/v1/audit?limit=200');
  const entries = auditLog.body.filter((e) => String(e.event).startsWith('evolution.'));
  assert(entries.some((e) => e.event === 'evolution.rollback'), 'the rollback is in the audit log');
  assert(entries.some((e) => e.event === 'evolution.deploy'), 'the deployment is in the audit log');
  assert(entries.some((e) => e.event === 'evolution.policy.update'), 'policy changes are audited');
  const chain = verifyAuditChain();
  eq(chain.ok, true, `the audit chain still verifies (${chain.reason || 'ok'})`);
});

/* ============================== AC9, AC15, AC16, AC18 ============================== */

await check('AC9 a newly created specialist inherits only its own scope and the default authority', async () => {
  const policy = await owner.request(`/api/v1/evolution/agents/${SP}/policy`);
  eq(policy.body.level, 1, 'a new agent starts at level 1');
  eq(policy.body.scope.length, 1, 'one scope entry');
  eq(policy.body.scope[0], `agents/${SP}/**`, 'only its own directory');

  const created = await owner.request('/api/v1/evolution/experiments', {
    method: 'POST',
    body: { agentId: SP, title: 'Try to touch the author’s code', problem: 'the specialist should not be able to edit another agent without a grant', files: [`agents/${A}/greet.mjs`] },
  });
  eq(created.status, 200, 'the experiment opens (inspection is allowed)');
  const plan = await owner.request(`/api/v1/evolution/experiments/${created.body.id}/plan`, {
    method: 'POST',
    body: { outcome: 'rewrite the author agent’s greeting', files: [`agents/${A}/greet.mjs`], tests: [] },
  });
  eq(plan.status, 400, 'writing outside its own scope is refused');
  assert(/outside the scope/i.test(plan.body.error), 'the refusal names the scope');

  const grant = await owner.request('/api/v1/evolution/grants', {
    method: 'POST',
    body: { agentId: SP, ownerAgentId: A, scope: [`agents/${A}/**`], reason: 'assigned to help the writer agent' },
  });
  eq(grant.status, 200, 'an Owner can grant cross-agent access explicitly');
  const replan = await owner.request(`/api/v1/evolution/experiments/${created.body.id}/plan`, {
    method: 'POST',
    body: { outcome: 'rewrite the author agent’s greeting to match the tests', files: [`agents/${A}/greet.mjs`], tests: ['node agents/demo-writer/greet.test.mjs'] },
  });
  eq(replan.status, 200, 'with a grant the same plan is allowed');
  await owner.request(`/api/v1/evolution/experiments/${created.body.id}/cancel`, { method: 'POST', body: {} });
});

await check('AC15 an agent cannot widen its own authority or disable the enforcement', async () => {
  // Scope cannot be pointed at the guards, even by an Owner, and a level change needs confirmation.
  const toProtected = await owner.request(`/api/v1/evolution/agents/${A}/policy`, { method: 'PATCH', body: { scope: ['apps/gateway/src/evolution/**'] } });
  eq(toProtected.status, 403, 'scope cannot target the safeguards');
  assert(/protected/i.test(toProtected.body.error), 'the refusal says why');

  const noConfirm = await owner.request(`/api/v1/evolution/agents/${A}/policy`, { method: 'PATCH', body: { level: 5 } });
  eq(noConfirm.status, 400, 'raising authority requires an explicit confirmation');
  assert(/confirmation/i.test(noConfirm.body.error), 'the refusal explains the confirmation');

  const auditLog = await owner.request('/api/v1/audit?limit=200');
  assert(auditLog.body.some((e) => e.event === 'evolution.denied'), 'denied attempts are audited');

  // The sandbox refuses to run anything outside its allowlist — an agent cannot shell out of it.
  const shell = await owner.request(`/api/v1/evolution/experiments/${exp.id}/test`, { method: 'POST', body: { command: 'sh -c "cat /etc/passwd"' } });
  eq(shell.status, 409, 'the experiment is finished, so the command cannot run at all');
  const caps = await owner.request('/api/v1/evolution/capabilities');
  assert(caps.body.protected.length > 5, 'the protected list is part of the platform, not of an agent');
});

await check('AC16 resource limits stop a runaway experiment and a retry loop', async () => {
  await owner.request(`/api/v1/evolution/agents/${SP}/policy`, {
    method: 'PATCH',
    body: { level: 2, confirmHigher: true, limits: { maxTestRuns: 1, maxRuntimeMs: 1500 } },
  });
  const created = await owner.request('/api/v1/evolution/experiments', {
    method: 'POST',
    body: { agentId: SP, title: 'Runaway loop', problem: 'a candidate that never terminates must be killed, not waited on', files: [`agents/${SP}/loop.mjs`] },
  });
  const id = created.body.id;
  await owner.request(`/api/v1/evolution/experiments/${id}/plan`, { method: 'POST', body: { outcome: 'prove the sandbox kills a runaway candidate', files: [`agents/${SP}/loop.mjs`], tests: ['node agents/demo-specialist/loop.mjs'] } });
  await owner.request(`/api/v1/evolution/experiments/${id}/workspace`, { method: 'POST', body: {} });
  await owner.request(`/api/v1/evolution/experiments/${id}/edit`, { method: 'POST', body: { path: `agents/${SP}/loop.mjs`, content: 'console.log("spinning");\nwhile (true) {}\n', reason: 'a deliberately non-terminating candidate' } });
  const started = Date.now();
  const run = await owner.request(`/api/v1/evolution/experiments/${id}/test`, { method: 'POST', body: { command: 'node agents/demo-specialist/loop.mjs' } });
  const elapsed = Date.now() - started;
  eq(run.status, 200, 'the run finishes');
  eq(run.body.tests.passed, false, 'a killed run is not a pass');
  eq(run.body.tests.runs.at(-1).timedOut, true, 'the timeout is recorded');
  assert(elapsed < 20000, `the sandbox must kill it promptly (took ${elapsed}ms)`);
  eq(run.body.status, 'test_failed', 'the experiment stops as failed');
  assert(/budget/i.test(run.body.blocker), `the retry budget escalation must be explicit (${run.body.blocker})`);
});

await check('AC18 the experiment can be reproduced from its recorded version, configuration and evidence', async () => {
  const detail = await owner.request(`/api/v1/evolution/experiments/${exp.id}`);
  const e = detail.body;
  assert(e.baseVersion, 'the baseline version is recorded');
  assert(e.plan.tests.length, 'the plan records the checks that were run');
  assert(e.tests.command === 'node agents/demo-writer/greet.test.mjs', 'the exact command is recorded');
  assert(e.tests.runs.length >= 3, 'every run is kept, including the failures');
  assert(e.tests.runs.some((r) => r.ok === false), 'a failed run is part of the record');
  const files = await owner.request(`/api/v1/evolution/experiments/${exp.id}/file?path=${encodeURIComponent(`agents/${A}/greet.mjs`)}`);
  assert(files.body.baseline.includes('hi ${name}'), 'the baseline content is reproducible');
  assert(files.body.candidate.includes('Hello, ${name}'), 'the candidate content is reproducible');

  // The same baseline in a new experiment is byte-identical, so a replay starts from the same place.
  const replay = await owner.request('/api/v1/evolution/experiments', {
    method: 'POST',
    body: { agentId: A, title: 'Replay the fix from the same baseline', problem: 'confirm the recorded baseline reproduces byte for byte', files: [`agents/${A}/greet.mjs`, `agents/${A}/greet.test.mjs`, `agents/${A}/health.mjs`] },
  });
  await owner.request(`/api/v1/evolution/experiments/${replay.body.id}/workspace`, { method: 'POST', body: {} });
  const replayed = await owner.request(`/api/v1/evolution/experiments/${replay.body.id}`);
  eq(replayed.body.baseVersion, e.baseVersion, 'the baseline version matches the original experiment');
  await owner.request(`/api/v1/evolution/experiments/${replay.body.id}/cancel`, { method: 'POST', body: {} });
});

/* ---------- report ---------- */
await new Promise((resolve) => gateway.server.close(resolve));
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(results.join('\n'));
const passed = results.filter((r) => r.startsWith('PASS')).length;
console.log(`\nSELF-MODIFICATION ACCEPTANCE: ${passed} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
