/* ============ Self-modification — the improvement cycle ============
 * One experiment walks ten stages, and every stage is a recorded fact rather than a claim:
 *
 *   observe → diagnose → plan → working copy → modify → test → review → compare → promote → monitor
 *
 * What this module refuses to do, by design:
 *   • write to the live source tree (candidates live under DATA_DIR; promotion publishes a version);
 *   • let an agent move its own autonomy level, approve its own change, or review itself;
 *   • let a candidate pass by deleting or weakening the tests that catch it;
 *   • let a candidate deploy before the configured tests, reviews, health check and policy allow it;
 *   • trust anything an agent says about its results — the sandbox output is stored verbatim.
 *
 * Honest limits: the sandbox is process isolation (see sandbox.js), the swarm here is a set of agent
 * records rather than a running runtime, and "continuous improvement" (level 5) grants authority, not
 * an always-on scheduler — an operator or a task trigger still starts the experiment.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  LEVELS, LEVEL_IDS, DEFAULT_LEVEL, levelOf, canAt, classifyRisk, checkWriteScope, classifyPath,
  checkTestIntegrity, EXPERIMENT_STATUS as S, STATUS_LABEL, isTerminal, isTestFile, PROTECTED_PATHS,
  MAX_FILES_PER_EXPERIMENT, MAX_DIFF_LINES, normalisePath,
} from './policy.js';
import { runInSandbox, describeSandbox, summariseRun } from './sandbox.js';
import {
  createWorkspace, readManifest, readCandidate, readBaseline, writeCandidate, deleteCandidate,
  diffWorkspace, compareTrees, experimentRoot, publishVersion, activateVersion, activeVersion,
  snapshot, removeWorkspace,
} from './workspace.js';

const shortId = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const sha = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

export const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

export function shapePolicy(row) {
  if (!row) return null;
  const level = levelOf(row.level);
  return {
    agentId: row.agent_id,
    enabled: Boolean(row.enabled),
    level: level.id,
    levelLabel: level.label,
    levelSummary: level.summary,
    capabilities: { ...level.can },
    scope: parse(row.scope, []),
    allowTests: Boolean(row.allow_tests),
    allowAutoStage: Boolean(row.allow_auto_stage),
    allowAutoDeploy: Boolean(row.allow_auto_deploy),
    requireReviews: Boolean(row.require_reviews),
    healthCheck: parse(row.health_check, {}),
    limits: {
      maxExperimentsPerDay: row.max_experiments_per_day,
      maxTestRuns: row.max_test_runs,
      maxRuntimeMs: row.max_runtime_ms,
    },
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

export function shapeExperiment(row, { events = [], reviews = [] } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agent_id,
    title: row.title,
    problem: row.problem,
    objective: row.objective,
    observationIds: parse(row.observation_ids, []),
    diagnosis: parse(row.diagnosis, {}),
    plan: parse(row.plan, {}),
    status: row.status,
    statusLabel: STATUS_LABEL[row.status] || row.status,
    terminal: isTerminal(row.status),
    level: row.level,
    levelLabel: levelOf(row.level).label,
    risk: row.risk,
    baseVersion: row.base_version,
    hasWorkspace: Boolean(row.workspace),
    files: parse(row.files, []),
    changes: parse(row.changes, {}),
    diff: row.diff,
    diffLines: row.diff_lines,
    tests: parse(row.tests, {}),
    testRuns: row.test_runs,
    integrity: parse(row.integrity, {}),
    reviewRequired: Boolean(row.review_required),
    reviews,
    compare: parse(row.compare, {}),
    approval: parse(row.approval, {}),
    blocker: row.blocker,
    versionId: row.version_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
    events,
  };
}

export function createEvolutionRunner({
  db, dataDir, repoRoot, logEvent = () => {}, audit = () => {}, broadcast = () => {}, now = () => Date.now(),
  runSandbox = runInSandbox,
} = {}) {
  /* ---------------- helpers ---------------- */

  const agentRow = (id) => db.prepare('SELECT * FROM agents WHERE id = ? AND deleted_at IS NULL').get(id);
  const getRow = (id) => db.prepare('SELECT * FROM evolution_experiments WHERE id = ?').get(id);

  function events(experimentId) {
    return db.prepare('SELECT * FROM evolution_events WHERE experiment_id = ? ORDER BY seq').all(experimentId)
      .map((e) => ({ ...e, data: parse(e.data, {}) }));
  }

  function reviewsFor(experimentId) {
    return db.prepare('SELECT * FROM evolution_reviews WHERE experiment_id = ? ORDER BY created_at').all(experimentId)
      .map((r) => ({ ...r, findings: parse(r.findings, []), independent: Boolean(r.independent) }));
  }

  /** One effective verdict per reviewer: a reviewer may revise after an objection, and the latest wins. */
  function effectiveReviews(experimentId) {
    const latest = new Map();
    for (const review of reviewsFor(experimentId)) latest.set(String(review.reviewer), review);
    return [...latest.values()];
  }

  function record(row, stage, detail, { status = 'info', actor = 'system', data = {} } = {}) {
    const last = db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM evolution_events WHERE experiment_id = ?').get(row.id);
    db.prepare(`INSERT INTO evolution_events (id, experiment_id, seq, ts, stage, status, actor, detail, data)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(shortId('ev'), row.id, (last?.s || 0) + 1, now(), stage, status, actor, String(detail).slice(0, 500), JSON.stringify(data));
    broadcast('evolution', { type: `experiment.${stage}`, experimentId: row.id, agentId: row.agent_id, status, detail: String(detail).slice(0, 160) });
  }

  function save(row, patch) {
    const fields = Object.keys(patch);
    if (!fields.length) return row;
    db.prepare(`UPDATE evolution_experiments SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...fields.map((f) => patch[f]), now(), row.id);
    return getRow(row.id);
  }

  function stop(row, status, blocker, actor = 'system', detail = '') {
    save(row, { status, blocker: blocker || '', ended_at: now() });
    record(row, status, detail || blocker || STATUS_LABEL[status], { status: status === S.REJECTED || status === S.BLOCKED ? 'bad' : 'warn', actor });
    logEvent('evolution', `${row.agent_id} · ${row.title}: ${STATUS_LABEL[status]}${blocker ? ` — ${blocker.slice(0, 80)}` : ''}`, row.id);
    return getExperiment(row.id);
  }

  /* ---------------- policy: every agent has one ---------------- */

  function defaultScope(agentId) {
    return [`agents/${agentId}/**`];
  }

  function ensurePolicy(agentId) {
    const existing = db.prepare('SELECT * FROM evolution_policies WHERE agent_id = ?').get(agentId);
    if (existing) return shapePolicy(existing);
    db.prepare(`INSERT INTO evolution_policies (agent_id, enabled, level, scope, allow_tests, allow_auto_stage, allow_auto_deploy,
                 require_reviews, health_check, max_experiments_per_day, max_test_runs, max_runtime_ms, updated_by, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(agentId, 1, DEFAULT_LEVEL, JSON.stringify(defaultScope(agentId)), 1, 0, 0, 1, '{}', 5, 4, 120000, 'system', now());
    return shapePolicy(db.prepare('SELECT * FROM evolution_policies WHERE agent_id = ?').get(agentId));
  }

  /** Every agent — including the ones seeded before this module existed — gets a policy. */
  function schedulePoliciesForAllAgents() {
    const agents = db.prepare('SELECT id FROM agents WHERE deleted_at IS NULL').all();
    let created = 0;
    for (const agent of agents) {
      const before = db.prepare('SELECT 1 AS x FROM evolution_policies WHERE agent_id = ?').get(agent.id);
      ensurePolicy(agent.id);
      if (!before) created += 1;
    }
    return { agents: agents.length, created };
  }

  function grantsFor(agentId) {
    return db.prepare(`SELECT * FROM evolution_grants WHERE agent_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`)
      .all(agentId, now())
      .map((g) => ({ ...g, scope: parse(g.scope, []) }));
  }

  function listAgents() {
    const agents = db.prepare('SELECT id, name, role, status, autonomy FROM agents WHERE deleted_at IS NULL ORDER BY name').all();
    return agents.map((agent) => {
      const policy = ensurePolicy(agent.id);
      const active = db.prepare(`SELECT id, title, status FROM evolution_experiments WHERE agent_id = ? AND status NOT IN ('deployed','rolled_back','rejected','cancelled','blocked') ORDER BY created_at DESC LIMIT 1`).get(agent.id);
      const versions = db.prepare('SELECT COUNT(*) AS n FROM evolution_versions WHERE agent_id = ?').get(agent.id).n;
      return {
        ...agent,
        policy,
        grants: grantsFor(agent.id),
        activeExperiment: active || null,
        versions,
        activeVersion: activeVersion(dataDir, agent.id),
      };
    });
  }

  function setPolicy(agentId, patch = {}, actor = 'system') {
    ensurePolicy(agentId);
    const current = db.prepare('SELECT * FROM evolution_policies WHERE agent_id = ?').get(agentId);
    const fields = [];
    const values = [];
    const auditDetails = {};

    if (patch.level !== undefined) {
      const level = Number(patch.level);
      if (!LEVEL_IDS.includes(level)) throw fail('bad-level', 'the autonomy level must be 1–5');
      if (level > 2 && patch.confirmHigher !== true) {
        throw fail('confirm-required', `raising an agent to level ${level} (${levelOf(level).label}) needs an explicit confirmation from an owner`, { level });
      }
      fields.push('level'); values.push(level); auditDetails.level = level;
    }
    if (patch.enabled !== undefined) { fields.push('enabled'); values.push(patch.enabled ? 1 : 0); auditDetails.enabled = Boolean(patch.enabled); }
    if (patch.scope !== undefined) {
      if (!Array.isArray(patch.scope) || !patch.scope.length) throw fail('bad-scope', 'scope must be a non-empty list of globs');
      for (const glob of patch.scope) {
        if (typeof glob !== 'string' || glob.length > 120) throw fail('bad-scope', 'each scope entry must be a string shorter than 120 characters');
        const probe = glob.replace(/\*\*?/g, 'x').replace(/\?/g, 'x');
        try { normalisePath(probe); } catch { throw fail('bad-scope', `scope “${glob}” is not a relative path pattern`); }
        if (classifyPath(probe).kind === 'protected') {
          throw fail('protected', `scope “${glob}” points at a protected component; autonomy cannot be widened over the controls that govern it`);
        }
      }
      fields.push('scope'); values.push(JSON.stringify(patch.scope)); auditDetails.scope = patch.scope;
    }
    if (patch.allowTests !== undefined) { fields.push('allow_tests'); values.push(patch.allowTests ? 1 : 0); }
    if (patch.allowAutoStage !== undefined) { fields.push('allow_auto_stage'); values.push(patch.allowAutoStage ? 1 : 0); }
    if (patch.allowAutoDeploy !== undefined) { fields.push('allow_auto_deploy'); values.push(patch.allowAutoDeploy ? 1 : 0); }
    if (patch.requireReviews !== undefined) { fields.push('require_reviews'); values.push(patch.requireReviews ? 1 : 0); }
    if (patch.healthCheck !== undefined) {
      const command = String(patch.healthCheck?.command || '').trim();
      if (command.length > 200) throw fail('bad-health', 'the health check command is too long');
      fields.push('health_check'); values.push(JSON.stringify(command ? { command } : {})); auditDetails.health = command;
    }
    if (patch.limits) {
      if (patch.limits.maxExperimentsPerDay !== undefined) { fields.push('max_experiments_per_day'); values.push(Math.min(Math.max(Number(patch.limits.maxExperimentsPerDay) || 1, 1), 50)); }
      if (patch.limits.maxTestRuns !== undefined) { fields.push('max_test_runs'); values.push(Math.min(Math.max(Number(patch.limits.maxTestRuns) || 1, 1), 20)); }
      if (patch.limits.maxRuntimeMs !== undefined) { fields.push('max_runtime_ms'); values.push(Math.min(Math.max(Number(patch.limits.maxRuntimeMs) || 60000, 5000), 900000)); }
    }
    if (!fields.length) throw fail('no-fields', 'nothing to update');
    fields.push('updated_by'); values.push(actor);
    fields.push('updated_at'); values.push(now());
    db.prepare(`UPDATE evolution_policies SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE agent_id = ?`).run(...values, agentId);
    audit(actor, 'app', 'evolution.policy.update', { agentId, ...auditDetails }, 'allow', 'ok');
    logEvent('evolution', `Self-improvement policy for ${agentId} updated by ${actor}`, agentId);
    broadcast('evolution', { type: 'policy.updated', agentId });
    return { before: shapePolicy(current), after: shapePolicy(db.prepare('SELECT * FROM evolution_policies WHERE agent_id = ?').get(agentId)) };
  }

  function createGrant({ agentId, ownerAgentId = '*', scope = [], reason = '', expiresAt = null }, actor) {
    if (!agentRow(agentId)) throw fail('not-found', 'unknown agent');
    if (!Array.isArray(scope) || !scope.length) throw fail('bad-scope', 'a grant needs at least one path glob');
    for (const glob of scope) {
      const probe = glob.replace(/\*\*?/g, 'x').replace(/\?/g, 'x');
      if (classifyPath(probe).kind === 'protected') throw fail('protected', 'a grant can never cover a protected component');
    }
    const id = shortId('grant');
    db.prepare(`INSERT INTO evolution_grants (id, agent_id, owner_agent_id, scope, reason, created_by, created_at, expires_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, agentId, ownerAgentId, JSON.stringify(scope), String(reason).slice(0, 300), actor, now(), expiresAt || null);
    audit(actor, 'app', 'evolution.grant.create', { agentId, ownerAgentId, scope }, 'allow', 'ok');
    record({ id: `grant:${id}`, agent_id: agentId }, 'grant', `Access granted to ${ownerAgentId === '*' ? 'platform code' : ownerAgentId} for ${scope.join(', ')}`, { actor });
    return db.prepare('SELECT * FROM evolution_grants WHERE id = ?').get(id);
  }

  function revokeGrant(id, actor) {
    const grant = db.prepare('SELECT * FROM evolution_grants WHERE id = ?').get(id);
    if (!grant) throw fail('not-found', 'unknown grant');
    db.prepare('UPDATE evolution_grants SET revoked_at = ? WHERE id = ?').run(now(), id);
    audit(actor, 'app', 'evolution.grant.revoke', { id, agentId: grant.agent_id }, 'allow', 'ok');
    return { id, revoked: true };
  }

  /* ---------------- stage 1: observe ---------------- */

  function recordObservation(agentId, { source, kind = '', detail = '', evidence = {}, measured = true } = {}, actor = 'system') {
    if (!agentRow(agentId)) throw fail('not-found', 'unknown agent');
    const allowed = ['task-failure', 'test-failure', 'retry', 'user-correction', 'peer-review', 'metric'];
    if (!allowed.includes(source)) throw fail('bad-source', `source must be one of ${allowed.join(', ')}`);
    if (String(detail || '').trim().length < 5) throw fail('bad-detail', 'describe what was observed');
    const id = shortId('obs');
    db.prepare(`INSERT INTO evolution_observations (id, agent_id, source, kind, detail, evidence, measured, created_by, created_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, agentId, source, String(kind).slice(0, 80), String(detail).slice(0, 1000), JSON.stringify(evidence || {}), measured ? 1 : 0, actor, now());
    return { id, agentId, source, kind, detail, measured: Boolean(measured), createdAt: now() };
  }

  function listObservations(agentId, limit = 40) {
    return db.prepare('SELECT * FROM evolution_observations WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?').all(agentId, Math.min(limit, 200))
      .map((o) => ({ ...o, evidence: parse(o.evidence, {}), measured: Boolean(o.measured) }));
  }

  /* ---------------- create / read ---------------- */

  function dailyCount(agentId) {
    const since = now() - 24 * 60 * 60 * 1000;
    return db.prepare('SELECT COUNT(*) AS n FROM evolution_experiments WHERE agent_id = ? AND created_at > ?').get(agentId, since).n;
  }

  function createExperiment({
    agentId, title, problem, objective = '', observationIds = [], files = [], plan = {}, actor = 'system',
  }) {
    if (!agentRow(agentId)) throw fail('not-found', 'unknown agent');
    const policy = ensurePolicy(agentId);
    if (!policy.enabled) throw fail('disabled', 'self-modification is disabled for this agent');
    if (String(title || '').trim().length < 6) throw fail('bad-title', 'give the experiment a title (6+ characters)');
    if (String(problem || '').trim().length < 20) throw fail('bad-problem', 'describe the problem in at least 20 characters');
    if (!Array.isArray(files) || !files.length) throw fail('bad-files', 'name at least one file the experiment may read or change');
    if (files.length > MAX_FILES_PER_EXPERIMENT) throw fail('too-many-files', `an experiment may name at most ${MAX_FILES_PER_EXPERIMENT} files`);
    if (dailyCount(agentId) >= policy.limits.maxExperimentsPerDay) {
      throw fail('quota', `this agent already ran ${policy.limits.maxExperimentsPerDay} experiments in the last 24 hours`);
    }

    // Every path is validated now, so a plan that exceeds the grant is rejected before any work.
    const grants = grantsFor(agentId);
    const inspected = [];
    const refused = [];
    for (const path of files) {
      let clean;
      try { clean = normalisePath(path); } catch (error) { refused.push({ path, reason: error.message }); continue; }
      const cls = classifyPath(clean);
      if (cls.kind === 'protected') {
        refused.push({ path: clean, reason: `protected: ${cls.reason} — an agent may recommend a change here but not open a candidate` });
        continue;
      }
      const writable = checkWriteScope(clean, { scope: policy.scope, grants });
      inspected.push({ path: clean, writable: writable.ok, reason: writable.ok ? '' : writable.reason });
    }
    if (refused.length) {
      throw fail('out-of-scope', `the experiment names files it may not touch:\n${refused.map((r) => `• ${r.path} — ${r.reason}`).join('\n')}`, { refused });
    }

    // Observations must exist and be measured; an assumed problem is not evidence.
    if (observationIds.length) {
      const found = observationIds
        .map((id) => db.prepare('SELECT * FROM evolution_observations WHERE id = ? AND agent_id = ?').get(id, agentId))
        .filter(Boolean);
      if (found.length !== observationIds.length) throw fail('bad-observation', 'one or more observation ids do not belong to this agent');
      if (!found.some((o) => o.measured)) throw fail('assumption-only', 'every linked observation is an assumption; record measured evidence first');
    }

    const id = shortId('exp');
    db.prepare(`INSERT INTO evolution_experiments
      (id, agent_id, title, problem, objective, observation_ids, plan, status, level, risk, files, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, agentId, String(title).slice(0, 160), String(problem).slice(0, 2000), String(objective).slice(0, 1000),
        JSON.stringify(observationIds), JSON.stringify(plan || {}), S.PROPOSED, policy.level, 'unknown',
        JSON.stringify(inspected), actor, now(), now());
    const row = getRow(id);
    record(row, 'proposed', `Experiment opened at autonomy level ${policy.level} (${levelOf(policy.level).label}) with ${inspected.length} file(s) in scope`, { actor, data: { files: inspected } });
    audit(actor, 'app', 'evolution.experiment.create', { id, agentId, files: inspected.length, level: policy.level }, 'allow', 'ok');
    logEvent('evolution', `${agentId} opened experiment “${title}”`, id);
    return getExperiment(id);
  }

  function getExperiment(id) {
    const row = getRow(id);
    if (!row) return null;
    return { ...shapeExperiment(row, { events: events(id), reviews: reviewsFor(id) }), sandbox: describeSandbox() };
  }

  function listExperiments({ agentId = '', limit = 40 } = {}) {
    const rows = agentId
      ? db.prepare('SELECT * FROM evolution_experiments WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?').all(agentId, Math.min(limit, 200))
      : db.prepare('SELECT * FROM evolution_experiments ORDER BY created_at DESC LIMIT ?').all(Math.min(limit, 200));
    return rows.map((row) => shapeExperiment(row));
  }

  /** The authority in force right now. An owner raising or lowering a level applies to open experiments,
   *  and the experiment keeps the level it was opened under as history. */
  function activeLevel(row) {
    try { return ensurePolicy(row.agent_id).level; } catch { return row.level; }
  }

  function requireExperiment(id) {
    const row = getRow(id);
    if (!row) throw fail('not-found', 'unknown experiment');
    return row;
  }

  function requireStage(row, stages, action) {
    if (isTerminal(row.status)) throw fail('terminal', `this experiment is already ${STATUS_LABEL[row.status] || row.status}; open a new one`);
    if (!stages.includes(row.status)) {
      throw fail('wrong-stage', `${action} is not available from “${STATUS_LABEL[row.status] || row.status}”`);
    }
  }

  /* ---------------- stage 2: diagnose ---------------- */

  function diagnose(id, {
    problem, evidence = [], files = [], rootCause = '', solution = '', regressions = [], tests = [],
  } = {}, actor = 'system') {
    const row = requireExperiment(id);
    requireStage(row, [S.PROPOSED], 'a diagnosis');
    if (String(problem || '').trim().length < 10) throw fail('bad-diagnosis', 'state the observed problem');
    if (!Array.isArray(evidence) || !evidence.length) {
      throw fail('no-evidence', 'a diagnosis needs evidence; “it feels slow” is not evidence');
    }
    const linked = parse(row.observation_ids, []);
    if (!linked.length && evidence.every((e) => e.measured === false)) {
      throw fail('assumption-only', 'every piece of evidence is marked unmeasured — record a measurement first');
    }
    const diagnosis = {
      problem: String(problem).slice(0, 1000),
      evidence: evidence.slice(0, 20).map((e) => ({ detail: String(e.detail || e).slice(0, 500), measured: e.measured !== false, source: String(e.source || '').slice(0, 60) })),
      files: files.map((f) => String(f).slice(0, 200)),
      rootCause: String(rootCause).slice(0, 1000),
      solution: String(solution).slice(0, 1500),
      regressions: regressions.map((r) => String(r).slice(0, 300)),
      tests: tests.map((t) => String(t).slice(0, 300)),
    };
    save(row, { diagnosis: JSON.stringify(diagnosis) });
    record(row, 'diagnose', `Diagnosis recorded with ${diagnosis.evidence.length} piece(s) of evidence`, { actor, data: { rootCause: diagnosis.rootCause } });
    return getExperiment(id);
  }

  /* ---------------- stage 3: plan ---------------- */

  function planExperiment(id, {
    outcome, files, dependencies = [], tests = [], limits = {}, risks = [], rollback = '', approvalLevel = 0,
  } = {}, actor = 'system') {
    const row = requireExperiment(id);
    requireStage(row, [S.PROPOSED], 'a plan');
    if (String(outcome || '').trim().length < 10) throw fail('bad-plan', 'state the intended outcome');
    if (!Array.isArray(files) || !files.length) throw fail('bad-plan', 'list the files the plan expects to change');
    const policy = ensurePolicy(row.agent_id);
    const grants = grantsFor(row.agent_id);
    const blocked = files.map((f) => ({ path: f, verdict: checkWriteScope(f, { scope: policy.scope, grants }) }))
      .filter((entry) => !entry.verdict.ok);
    if (blocked.length) {
      throw fail('out-of-scope', `the plan exceeds this agent’s scope:\n${blocked.map((b) => `• ${b.path} — ${b.verdict.reason}`).join('\n')}`);
    }
    if (Number(approvalLevel) > policy.level) {
      throw fail('level', `the plan asks for approval level ${approvalLevel} but this agent has level ${policy.level}`);
    }
    const plan = {
      outcome: String(outcome).slice(0, 1000),
      files: files.map((f) => String(f).slice(0, 200)),
      dependencies: dependencies.map((d) => String(d).slice(0, 200)),
      tests: tests.map((t) => String(t).slice(0, 300)),
      limits: { maxTestRuns: Math.min(Number(limits.maxTestRuns) || policy.limits.maxTestRuns, 20), runtimeMs: Math.min(Number(limits.runtimeMs) || policy.limits.maxRuntimeMs, 900000) },
      risks: risks.map((r) => String(r).slice(0, 300)),
      rollback: String(rollback).slice(0, 500),
      approvalLevel: Number(approvalLevel) || policy.level,
      plannedAt: now(),
    };
    save(row, { plan: JSON.stringify(plan), objective: String(outcome).slice(0, 1000) });
    record(row, 'plan', `Plan recorded: ${plan.files.length} file(s), ${plan.tests.length} check(s), approval level ${plan.approvalLevel}`, { actor });
    return getExperiment(id);
  }

  /* ---------------- stage 4: isolated working copy ---------------- */

  function createWorkingCopy(id, actor = 'system') {
    const row = requireExperiment(id);
    const level = activeLevel(row);
    if (!canAt(level, 'workspace')) {
      throw fail('level', `level ${level} (${levelOf(level).label}) can inspect and propose but not create a working copy`);
    }
    requireStage(row, [S.PROPOSED], 'a working copy');
    const files = parse(row.files, []).map((f) => f.path);
    const workspace = createWorkspace(dataDir, id, files, { sourceRoot: repoRoot });
    save(row, { workspace: workspace.root, base_version: workspace.baselineVersion, status: S.WORKSPACE_READY });
    record(row, 'workspace', `Isolated working copy created from ${files.length} file(s); baseline ${workspace.baselineVersion.slice(0, 12)}`, { actor, data: { files: Object.keys(workspace.files) } });
    return getExperiment(id);
  }

  /* ---------------- stage 5: rewrite ---------------- */

  function scopeFor(row) {
    const policy = ensurePolicy(row.agent_id);
    const grants = grantsFor(row.agent_id);
    return { policy, grants, writable: [...policy.scope, ...grants.flatMap((g) => g.scope)] };
  }

  function editFile(id, { path, content, reason = '' } = {}, actor = 'system') {
    const row = requireExperiment(id);
    if (!canAt(activeLevel(row), 'modify')) throw fail('level', `level ${activeLevel(row)} cannot modify a candidate`);
    requireStage(row, [S.WORKSPACE_READY, S.MODIFIED, S.TEST_FAILED, S.REVIEW_REQUIRED, S.REVIEWED, S.COMPARED], 'an edit');
    const { policy, grants } = scopeFor(row);
    const verdict = checkWriteScope(path, { scope: policy.scope, grants });
    if (!verdict.ok) {
      // A protected target is a recommendation for a human, never a candidate change.
      if (verdict.code === 'protected') {
        record(row, 'recommendation', `The agent proposed a change to a protected component (${normalisePath(path)}) — recorded for human review instead of applied.`, { actor, status: 'warn' });
        throw fail('protected', verdict.reason, { recommendation: true });
      }
      throw fail(verdict.code, verdict.reason);
    }
    if (typeof content !== 'string') throw fail('bad-content', 'file content must be a string');
    if (String(reason).trim().length < 5) throw fail('no-reason', 'every change needs a reason a reviewer can check');
    const changed = writeCandidate(dataDir, id, verdict.path, content);
    const manifest = readManifest(dataDir, id);
    const known = parse(row.files, []);
    if (!known.some((f) => f.path === verdict.path) && known.length >= MAX_FILES_PER_EXPERIMENT) {
      throw fail('too-many-files', `this experiment already touches ${MAX_FILES_PER_EXPERIMENT} files`);
    }
    const nextFiles = known.map((f) => (f.path === verdict.path ? { ...f, writable: true, reason: String(reason).slice(0, 300) } : f));
    if (!nextFiles.some((f) => f.path === verdict.path)) {
      nextFiles.push({ path: verdict.path, writable: true, reason: String(reason).slice(0, 300), added: !manifest.files[verdict.path]?.existed });
    }
    const diff = diffWorkspace(dataDir, id, Object.fromEntries(nextFiles.map((f) => [f.path, f.reason])));
    save(row, { files: JSON.stringify(nextFiles), changes: JSON.stringify(diff.changes), diff: diff.diff, diff_lines: diff.diffLines, status: S.MODIFIED, blocker: '' });
    record(row, 'modify', `Changed ${verdict.path}: ${String(reason).slice(0, 120)}`, { actor, data: { added: changed.bytes, diffLines: diff.diffLines } });
    return { experiment: getExperiment(id), change: diff.changes[verdict.path], diffLines: diff.diffLines };
  }

  function deleteFile(id, { path, reason = '' } = {}, actor = 'system') {
    const row = requireExperiment(id);
    if (!canAt(activeLevel(row), 'modify')) throw fail('level', `level ${activeLevel(row)} cannot modify a candidate`);
    const { policy, grants } = scopeFor(row);
    const verdict = checkWriteScope(path, { scope: policy.scope, grants });
    if (!verdict.ok) throw fail(verdict.code, verdict.reason);
    if (String(reason).trim().length < 5) throw fail('no-reason', 'deleting a file needs a reason a reviewer can check');
    deleteCandidate(dataDir, id, verdict.path);
    const known = parse(row.files, []).map((f) => (f.path === verdict.path ? { ...f, reason: String(reason).slice(0, 300), writable: true } : f));
    const diff = diffWorkspace(dataDir, id, Object.fromEntries(known.map((f) => [f.path, f.reason])));
    save(row, { files: JSON.stringify(known), changes: JSON.stringify(diff.changes), diff: diff.diff, diff_lines: diff.diffLines, status: S.MODIFIED });
    record(row, 'modify', `Deleted ${verdict.path}: ${reason}`, { actor, status: 'warn' });
    return { experiment: getExperiment(id), diffLines: diff.diffLines };
  }

  function readFileForReview(id, path) {
    const row = requireExperiment(id);
    const clean = normalisePath(path);
    if (classifyPath(clean).kind === 'protected') throw fail('protected', 'protected components are not part of an experiment');
    if (!row.workspace) {
      // Before a working copy exists the agent inspects the live file read-only — that is what makes
      // "identify a defect" possible without granting any write access.
      const source = resolve(repoRoot, clean);
      const allowed = source.startsWith(resolve(repoRoot) + '/');
      const exists = allowed && existsSync(source);
      return {
        path: clean,
        source: 'repository',
        baseline: exists ? readFileSync(source, 'utf8') : null,
        candidate: null,
        test: isTestFile(clean),
      };
    }
    return {
      path: clean,
      source: 'workspace',
      baseline: readBaseline(dataDir, row.id, clean),
      candidate: readCandidate(dataDir, row.id, clean),
      test: isTestFile(clean),
    };
  }

  /* ---------------- stage 6: test ---------------- */

  async function testExperiment(id, { command, actor = 'system' } = {}) {
    const row = requireExperiment(id);
    const policy = ensurePolicy(row.agent_id);
    if (!canAt(activeLevel(row), 'test')) throw fail('level', `level ${activeLevel(row)} cannot run tests`);
    if (!policy.allowTests) throw fail('disabled', 'tests are disabled by this agent’s policy');
    requireStage(row, [S.WORKSPACE_READY, S.MODIFIED, S.TEST_FAILED], 'a test run');
    if (row.test_runs >= policy.limits.maxTestRuns) {
      return stop(row, S.TEST_FAILED, `Test budget exhausted after ${row.test_runs} run(s) — escalation, not another retry.`, actor);
    }

    const { baseline, candidate } = compareTrees(dataDir, id);
    const integrity = checkTestIntegrity({ baseline, candidate });
    if (!integrity.ok) {
      save(row, { integrity: JSON.stringify(integrity), status: S.BLOCKED });
      record(row, 'integrity', integrity.blocking.map((f) => f.detail).join(' '), { status: 'bad', actor, data: integrity });
      return stop(row, S.BLOCKED, `The candidate removes a test (${integrity.blocking[0].path}). A fix may not delete the test that catches it.`, actor);
    }

    const chosen = command || (parse(row.plan, {}).tests?.[0] || '');
    if (!chosen) throw fail('no-command', 'no test command was given or planned');

    const workspace = join(experimentRoot(dataDir, id), 'work');
    save(row, { status: S.TESTING, integrity: JSON.stringify(integrity), test_runs: row.test_runs + 1, blocker: '' });
    record(row, 'test', `Running ${chosen}`, { actor });
    const run = await runSandbox({ command: chosen, workspace, timeoutMs: policy.limits.maxRuntimeMs });

    const previous = parse(row.tests, {});
    const summary = {
      passed: run.ok,
      command: chosen,
      runs: [...(previous.runs || []), {
        at: now(), ok: run.ok, code: run.code, timedOut: run.timedOut, durationMs: run.durationMs,
        stdout: (run.stdout || '').slice(-4000), stderr: (run.stderr || '').slice(-4000), command: chosen,
      }].slice(-10),
      lastSummary: summariseRun(run),
      passedAt: run.ok ? now() : previous.passedAt || null,
    };
    const nextStatus = run.ok
      ? (policy.requireReviews ? S.REVIEW_REQUIRED : S.COMPARED)
      : S.TEST_FAILED;
    save(row, { tests: JSON.stringify(summary), status: nextStatus, review_required: policy.requireReviews ? 1 : 0 });
    record(row, 'test', `${summariseRun(run)}${run.timedOut ? ' — killed at the time limit' : ''}`, { actor, status: run.ok ? 'ok' : 'bad', data: { code: run.code, durationMs: run.durationMs } });
    if (!run.ok && summary.runs.length >= policy.limits.maxTestRuns) {
      return stop(getRow(id), S.TEST_FAILED, `Tests failed ${summary.runs.length} times; the retry budget is spent.`, actor);
    }
    return getExperiment(id);
  }

  /* ---------------- stage 7: peer review ---------------- */

  function reviewExperiment(id, { reviewer, verdict, findings = [], reviewerKind = 'agent' } = {}, actor = 'system') {
    const row = requireExperiment(id);
    requireStage(row, [S.REVIEW_REQUIRED, S.REVIEWED, S.TEST_FAILED, S.MODIFIED], 'a review');
    if (!reviewer) throw fail('bad-review', 'name the reviewing agent or person');
    if (String(reviewer) === String(row.agent_id)) {
      throw fail('self-review', 'an agent cannot review its own change; assign an independent reviewer');
    }
    if (reviewerKind === 'agent' && !agentRow(reviewer)) throw fail('not-found', 'unknown reviewer agent');
    if (!['approve', 'changes-required', 'reject'].includes(verdict)) throw fail('bad-verdict', 'verdict must be approve, changes-required or reject');
    if (verdict !== 'approve' && (!Array.isArray(findings) || !findings.length)) {
      throw fail('no-findings', 'a non-approving review must say what is wrong');
    }
    const integrity = parse(row.integrity, { findings: [] });
    if (verdict === 'approve' && integrity.findings?.length && !findings.length) {
      // The candidate changed the tests; an approval has to say what the reviewer checked.
      throw fail('no-findings', 'this candidate changes test evidence; the approving review must record what was checked');
    }

    const id2 = shortId('rev');
    db.prepare(`INSERT INTO evolution_reviews (id, experiment_id, reviewer, reviewer_kind, verdict, findings, independent, created_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(id2, id, String(reviewer).slice(0, 80), reviewerKind, verdict, JSON.stringify(findings.map((f) => String(f).slice(0, 500))), reviewer === row.agent_id ? 0 : 1, now());
    const all = effectiveReviews(id);
    const approvals = all.filter((r) => r.verdict === 'approve').length;
    const blocking = all.filter((r) => r.verdict !== 'approve');
    const policy = ensurePolicy(row.agent_id);
    const nextStatus = blocking.length ? S.REVIEW_REQUIRED : S.REVIEWED;
    save(row, { reviews: JSON.stringify(all), status: nextStatus, review_required: blocking.length || !policy.requireReviews ? 0 : 1 });
    record(row, 'review', `${reviewer} reviewed: ${verdict}${findings.length ? ` — ${findings.slice(0, 2).join('; ')}` : ''}`, { actor, status: verdict === 'approve' ? 'ok' : 'warn', data: { approvals } });
    return getExperiment(id);
  }

  /* ---------------- stage 8: compare ---------------- */

  function compareExperiment(id, actor = 'system') {
    const row = requireExperiment(id);
    requireStage(row, [S.REVIEWED, S.REVIEW_REQUIRED, S.TEST_FAILED, S.MODIFIED], 'a comparison');
    const policy = ensurePolicy(row.agent_id);
    const tests = parse(row.tests, {});
    const diff = diffWorkspace(dataDir, id, Object.fromEntries(parse(row.files, []).map((f) => [f.path, f.reason])));
    const integrity = parse(row.integrity, { findings: [] });
    const risk = classifyRisk({ changes: diff.changes, integrity, diffLines: diff.diffLines, testsPassed: Boolean(tests.passed), scope: policy.scope });
    const reviews = reviewsFor(id);
    const approvals = reviews.filter((r) => r.verdict === 'approve').length;
    const objects = reviews.filter((r) => r.verdict !== 'approve').length;

    const compare = {
      baselineVersion: row.base_version,
      candidateVersion: sha(`${row.base_version}|${JSON.stringify(diff.changes)}|${row.tests}`),
      problemResolved: Boolean(tests.passed) && Boolean(parse(row.plan, {}).outcome),
      evidence: {
        testsPassed: Boolean(tests.passed),
        testRuns: row.test_runs,
        lastSummary: tests.lastSummary || 'no test run',
        approvals,
        objections: objects,
        diffFiles: diff.files.length,
        diffLines: diff.diffLines,
      },
      coverage: tests.passed
        ? `The recorded check(s) passed: ${tests.command || 'unspecified'}. This is the evidence we have — it is not a proof that nothing else regressed.`
        : 'No passing test run is recorded, so there is no evidence the problem is resolved.',
      risk,
      limitations: [
        'Only the files in this experiment were exercised.',
        'The sandbox is process isolation, not a container (no network isolation).',
        objects ? `${objects} reviewer(s) objected; the change is not promotable until they are resolved.` : '',
      ].filter(Boolean),
    };
    save(row, { compare: JSON.stringify(compare), risk: risk.level, diff: diff.diff, diff_lines: diff.diffLines, changes: JSON.stringify(diff.changes), status: S.COMPARED });
    record(row, 'compare', `Compared with baseline ${row.base_version.slice(0, 12)}: risk ${risk.level} (${risk.reason})`, { actor, data: { risk: risk.level, approvals } });
    return getExperiment(id);
  }

  /* ---------------- stage 9: promote ---------------- */

  function gates(row) {
    const policy = ensurePolicy(row.agent_id);
    const tests = parse(row.tests, {});
    const integrity = parse(row.integrity, { findings: [] });
    const compare = parse(row.compare, {});
    const reviews = effectiveReviews(row.id);
    const approvals = reviews.filter((r) => r.verdict === 'approve').length;
    const objections = reviews.filter((r) => r.verdict !== 'approve').length;
    const approval = parse(row.approval, {});
    const risk = compare.risk || { level: 'unknown', reason: 'not compared yet' };

    // Hard blockers cannot be waved through by an approval: the evidence itself is missing or unsafe.
    const blockers = [];
    if (!tests.passed) blockers.push('no passing test run is recorded');
    if (!compare.candidateVersion) blockers.push('the candidate has not been compared with the baseline');
    if (policy.requireReviews && approvals < 1) blockers.push('no independent reviewer has approved');
    if (objections) blockers.push(`${objections} reviewer(s) raised an objection`);
    if ((integrity.blocking || []).length) blockers.push('the candidate deletes a test — that is not a fix and cannot be approved');

    // Soft blockers need a human decision, which an approval supplies.
    const soft = [];
    if ((integrity.findings || []).length) soft.push('the candidate changes test evidence; a human must accept it explicitly');
    if (risk.level !== 'low') soft.push(`risk is ${risk.level}: ${risk.reason}`);

    const healthConfigured = Boolean(policy.healthCheck?.command);
    const canAutoStage = policy.level >= 3 && policy.allowAutoStage && !approval.pending;
    const canAutoDeploy = policy.level >= 4 && policy.allowAutoDeploy
      && risk.level === 'low' && !approval.pending && healthConfigured;

    return {
      policy, tests, integrity, compare, approvals, objections, blockers, soft, risk,
      healthConfigured,
      stageAllowed: blockers.length === 0 && policy.level >= 3,
      deployAllowed: blockers.length === 0 && risk.level === 'low' && healthConfigured && policy.level >= 4,
      needsHumanApproval: blockers.length > 0 || Boolean(approval.pending) || risk.level !== 'low' || !healthConfigured,
      reasons: {
        noHealth: healthConfigured ? '' : 'no health check is configured, so a deployment could not be monitored or rolled back automatically',
        risk: risk.level === 'low' ? '' : `risk is ${risk.level}: ${risk.reason}`,
        level: policy.level < 3 ? `level ${policy.level} cannot stage` : '',
      },
      canAutoStage,
      canAutoDeploy,
    };
  }

  function requestApproval(id, { actor = 'system', note = '' } = {}) {
    const row = requireExperiment(id);
    if (isTerminal(row.status)) throw fail('terminal', 'this experiment is finished');
    const g = gates(row);
    save(row, {
      approval: JSON.stringify({ pending: true, requestedBy: actor, requestedAt: now(), note: String(note).slice(0, 300), blockers: g.blockers }),
      status: S.REVIEW_REQUIRED,
    });
    record(row, 'approval-requested', `Approval requested${g.blockers.length ? ` with open blockers: ${g.blockers.join('; ')}` : ''}`, { actor, status: 'warn' });
    return getExperiment(id);
  }

  function approve(id, { decision, note = '', principal } = {}, actor = 'system') {
    const row = requireExperiment(id);
    if (isTerminal(row.status)) throw fail('terminal', 'this experiment is finished');
    const approver = principal || actor;
    if (String(approver) === String(row.created_by) || String(approver) === String(row.agent_id)) {
      throw fail('self-approval', 'the person or agent that opened the experiment cannot approve it (separation of duties)');
    }
    if (!['approve', 'reject'].includes(decision)) throw fail('bad-decision', 'decision must be approve or reject');
    const approval = { ...parse(row.approval, {}), pending: false, decidedBy: approver, decidedAt: now(), decision, note: String(note).slice(0, 500) };
    save(row, { approval: JSON.stringify(approval) });
    record(row, 'approval', `${approver} ${decision === 'approve' ? 'approved' : 'rejected'} the candidate${note ? `: ${note}` : ''}`, { actor, status: decision === 'approve' ? 'ok' : 'bad' });
    audit(actor, 'app', 'evolution.approve', { id, decision }, decision === 'approve' ? 'allow' : 'deny', 'ok');
    if (decision === 'reject') return stop(getRow(id), S.REJECTED, 'Rejected at approval', actor);
    save(getRow(id), { status: S.APPROVED });
    // Approving is not deploying. Deployment stays a separate authority (evolution:deploy, or the
    // agent's own level-4 policy for a low-risk candidate with a passing health check).
    return { experiment: getExperiment(id), approval };
  }

  function publish(row, status, actor) {
    const versionId = `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const published = publishVersion(dataDir, row.agent_id, versionId, null, { fromExperiment: row.id });
    const evidence = {
      experimentId: row.id,
      tests: parse(row.tests, {}).lastSummary || '',
      reviews: effectiveReviews(row.id).map((r) => ({ reviewer: r.reviewer, verdict: r.verdict })),
      compare: parse(row.compare, {}).evidence || {},
      diffLines: row.diff_lines,
      risk: parse(row.compare, {}).risk || {},
    };
    db.prepare(`INSERT INTO evolution_versions (id, agent_id, experiment_id, version, status, path, files_hash, files, evidence, health, created_by, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(versionId, row.agent_id, row.id, versionId, status, published.path, published.filesHash,
        JSON.stringify(published.files), JSON.stringify(evidence), '{}', actor, now());
    save(row, { version_id: versionId, status: status === 'deployed' ? S.DEPLOYED : S.STAGED });
    record(row, status === 'deployed' ? 'deploy' : 'stage', `${status === 'deployed' ? 'Deployed' : 'Staged'} ${versionId} (${published.filesHash.slice(0, 10)}) with ${row.diff_lines} diff line(s)`, { actor, data: { versionId } });
    return db.prepare('SELECT * FROM evolution_versions WHERE id = ?').get(versionId);
  }

  async function promote(id, { target = 'stage', actor = 'system', afterApproval = false } = {}) {
    const row = requireExperiment(id);
    if (isTerminal(row.status)) throw fail('terminal', 'this experiment is finished');
    const g = gates(row);
    const approval = parse(row.approval, {});

    if (target === 'stage') {
      if (g.blockers.length) throw fail('blocked', `cannot stage: ${g.blockers.join('; ')}`);
      if (g.policy.level < 3 || !policyAllows(row, 'stage')) {
        const experiment = requestApproval(id, { actor, note: 'staging needs approval at this level' });
        return { experiment, version: null, approvalRequired: true, reason: 'staging needs approval at this level' };
      }
      const version = publish(row, 'staged', actor);
      return { experiment: getExperiment(id), version, approvalRequired: false };
    }

    if (target === 'deploy') {
      if (g.blockers.length) throw fail('blocked', `cannot deploy: ${g.blockers.join('; ')}`);
      const humanApproved = approval.decision === 'approve';
      const autoDeploy = g.canAutoDeploy && !afterApproval;
      if (!humanApproved && !autoDeploy) {
        if (!afterApproval) {
          requestApproval(id, { actor, note: g.reasons.risk || g.reasons.noHealth || 'deployment needs approval at this level' });
          throw fail('approval-required', `deployment needs approval: ${g.blockers.length ? g.blockers.join('; ') : g.reasons.risk || g.reasons.noHealth || 'policy requires it'}`);
        }
        throw fail('approval-required', 'approval was recorded without a decision');
      }
      const risk = g.risk;
      // Pre-flight health: the same check that will monitor the deployment, run against the candidate
      // before it goes live. A candidate whose health check fails is never promoted.
      if (g.healthConfigured) {
        const workspace = join(experimentRoot(dataDir, row.id), 'work');
        const pre = await runSandbox({ command: g.policy.healthCheck.command, workspace, timeoutMs: g.policy.limits.maxRuntimeMs });
        save(row, { tests: JSON.stringify({ ...parse(row.tests, {}), preflightHealth: { ok: pre.ok, summary: summariseRun(pre), at: now() } }) });
        record(row, 'health', `Pre-flight health ${summariseRun(pre)}`, { actor, status: pre.ok ? 'ok' : 'bad' });
        if (!pre.ok) throw fail('health', `the pre-flight health check failed (${summariseRun(pre)}); the candidate was not deployed`);
      }
      const version = publish(row, 'deployed', actor);
      activateVersion(dataDir, row.agent_id, version.id);
      db.prepare('UPDATE evolution_versions SET status = ?, deployed_at = ? WHERE id = ?').run('deployed', now(), version.id);
      // Anything previously deployed becomes superseded, so the previous known-good version is findable.
      db.prepare(`UPDATE evolution_versions SET status = 'superseded' WHERE agent_id = ? AND id != ? AND status = 'deployed'`).run(row.agent_id, version.id);
      save(getRow(id), { status: S.DEPLOYED, ended_at: now(), blocker: '' });
      record(getRow(id), 'deployed', `Version ${version.id} is live for ${row.agent_id} (risk ${risk.level})`, { actor, status: 'ok' });
      audit(actor, 'app', 'evolution.deploy', { agentId: row.agent_id, versionId: version.id, risk: risk.level }, 'allow', 'ok');
      logEvent('evolution', `${row.agent_id} deployed ${version.id}`, row.agent_id);
      return { experiment: getExperiment(id), version };
    }

    throw fail('bad-target', 'target must be stage or deploy');
  }

  const policyAllows = (row, ability) => {
    const policy = ensurePolicy(row.agent_id);
    if (ability === 'stage') return policy.allowAutoStage;
    if (ability === 'deploy') return policy.allowAutoDeploy;
    return false;
  };

  /* ---------------- stage 10: monitor, health, rollback ---------------- */

  async function healthCheck(agentId, { actor = 'system', autoRollback = true } = {}) {
    const policy = ensurePolicy(agentId);
    const command = policy.healthCheck?.command;
    const current = activeVersion(dataDir, agentId);
    if (!current) throw fail('no-deployment', 'no version is deployed for this agent');
    if (!command) {
      return { agentId, versionId: current.versionId, configured: false, ok: false, note: 'no health check is configured, so health cannot be asserted' };
    }
    const workspace = join(dataDir, 'runtime', agentId, 'current', 'files');
    const run = await runSandbox({ command, workspace, timeoutMs: policy.limits.maxRuntimeMs });
    const health = { configured: true, ok: run.ok, command, summary: summariseRun(run), checkedAt: now(), code: run.code, durationMs: run.durationMs };
    db.prepare('UPDATE evolution_versions SET health = ? WHERE id = ?').run(JSON.stringify(health), current.versionId);
    const experiment = db.prepare('SELECT * FROM evolution_experiments WHERE version_id = ?').get(current.versionId);
    if (experiment) record(experiment, 'health', `Health check ${health.summary}`, { actor, status: run.ok ? 'ok' : 'bad' });

    if (!run.ok && autoRollback) {
      const rolled = rollback(agentId, { actor, reason: `health check failed: ${run.stdout || run.stderr || 'non-zero exit'}`.slice(0, 300), automatic: true });
      return { ...health, agentId, versionId: current.versionId, rolledBack: rolled };
    }
    return { agentId, versionId: current.versionId, configured: true, ...health };
  }

  function rollback(agentId, { actor = 'system', reason = '', automatic = false, versionId = '' } = {}) {
    const target = versionId
      ? db.prepare('SELECT * FROM evolution_versions WHERE id = ? AND agent_id = ?').get(versionId, agentId)
      : db.prepare(`SELECT * FROM evolution_versions WHERE agent_id = ? AND status IN ('superseded','rolled_back') ORDER BY created_at DESC LIMIT 1`).get(agentId);
    if (!target) throw fail('no-previous', 'there is no previous known-good version to roll back to');
    activateVersion(dataDir, agentId, target.id);
    db.prepare(`UPDATE evolution_versions SET status = 'deployed', deployed_at = ? WHERE id = ?`).run(now(), target.id);
    db.prepare(`UPDATE evolution_versions SET status = 'rolled_back', rolled_back_at = ? WHERE agent_id = ? AND status = 'deployed' AND id != ?`).run(now(), agentId, target.id);
    const experiment = db.prepare('SELECT * FROM evolution_experiments WHERE version_id = ?').get(target.id)
      || db.prepare('SELECT * FROM evolution_experiments WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1').get(agentId);
    if (experiment) {
      save(experiment, { status: S.ROLLED_BACK, ended_at: now(), blocker: `rolled back to ${target.id}${reason ? `: ${reason}` : ''}` });
      record(experiment, 'rollback', `${automatic ? 'Automatic rollback' : 'Rolled back'} to ${target.id}${reason ? ` — ${reason}` : ''}`, { actor, status: 'warn' });
    }
    audit(actor, 'app', 'evolution.rollback', { agentId, versionId: target.id, automatic, reason }, 'allow', 'ok');
    logEvent('evolution', `${agentId} rolled back to ${target.id}${automatic ? ' (health)' : ''}`, agentId);
    return { agentId, versionId: target.id, automatic, reason };
  }

  function listVersions(agentId, limit = 30) {
    const rows = db.prepare('SELECT * FROM evolution_versions WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?').all(agentId, Math.min(limit, 100));
    return rows.map((v) => ({ ...v, files: parse(v.files, {}), evidence: parse(v.evidence, {}), health: parse(v.health, {}), createdAt: iso(v.created_at), deployedAt: iso(v.deployed_at), rolledBackAt: iso(v.rolled_back_at) }));
  }

  function cancel(id, actor = 'system', reason = '') {
    const row = requireExperiment(id);
    if (isTerminal(row.status)) throw fail('terminal', 'this experiment is already finished');
    if (row.workspace) removeWorkspace(dataDir, id);
    return stop(row, S.CANCELLED, reason || 'stopped by an operator', actor);
  }

  /* ---------------- capability report ---------------- */

  function capabilities() {
    const agents = db.prepare('SELECT COUNT(*) AS n FROM agents WHERE deleted_at IS NULL').get().n;
    const withPolicy = db.prepare('SELECT COUNT(*) AS n FROM evolution_policies').get().n;
    const byLevel = db.prepare('SELECT level, COUNT(*) AS n FROM evolution_policies GROUP BY level').all();
    const counts = db.prepare('SELECT status, COUNT(*) AS n FROM evolution_experiments GROUP BY status').all();
    return {
      status: agents > 0 && withPolicy >= agents ? 'available' : 'partial',
      levels: LEVEL_IDS.map((id) => ({ ...LEVELS[id] })),
      defaultLevel: DEFAULT_LEVEL,
      protected: PROTECTED_PATHS.map((p) => ({ pattern: String(p.re), reason: p.reason })),
      sandbox: describeSandbox(),
      agents: { total: agents, withPolicy, byLevel },
      experiments: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      limits: {
        maxFiles: MAX_FILES_PER_EXPERIMENT,
        maxDiffLines: MAX_DIFF_LINES,
        maxTestRuns: 4,
        quotas: 'per-agent experiments per day, test runs per experiment, wall-clock per run',
      },
      note: 'Every agent has a policy. The default is level 1 (recommend only): inspect and propose, never write. Raising a level needs an Owner and an explicit confirmation, and no agent can change its own level.',
    };
  }

  return {
    ensurePolicy, schedulePoliciesForAllAgents, listAgents, setPolicy, grantsFor, createGrant, revokeGrant,
    recordObservation, listObservations,
    createExperiment, getExperiment, listExperiments,
    diagnose, planExperiment, createWorkingCopy, editFile, deleteFile, readFileForReview,
    testExperiment, reviewExperiment, compareExperiment, gates, requestApproval, approve, promote,
    healthCheck, rollback, listVersions, cancel, capabilities, activeVersion: (agentId) => activeVersion(dataDir, agentId),
    _internals: { events, reviewsFor, publish, approvalGate: gates, defaultScope },
  };
}
