/* ============ Terminal — real processes, streamed ============
 * The browser cannot execute anything, so the gateway does it: one `spawn()` per run, `shell: false`,
 * a detached process group so Ctrl+C reaches npm's children, and output pushed into a ring buffer
 * that a `text/event-stream` reader can replay from any point.
 *
 * What this module guarantees:
 *   • every run is a real OS process, and the exit code and signal are the child's own;
 *   • output is streamed as it arrives, and a late subscriber replays what it missed;
 *   • one run per session at a time, so `cd`-style surprises cannot interleave;
 *   • destructive commands stop at `awaiting_approval` and only run after a *different* principal
 *     allows the gate (separation of duties is the approvals module's, not re-implemented here);
 *   • everything is recorded: a run row, an audit entry with the argv, and the tail of the output.
 *
 * What it does not guarantee, and says so in `describeTerminalPolicy()`: network isolation, filesystem
 * isolation beyond the working directory, or CPU quotas. The containment is the gateway host.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { db, logEvent, audit } from '../db.js';
import { buildEnv, checkCommand, describeTerminalPolicy } from './policy.js';
import {
  describeRoots, ensureWorkspaceDirectory, listScripts, readProject, resolveInside, rootById, roots,
} from './workspaces.js';

export const LIMITS = Object.freeze({
  outputBytes: 2 * 1024 * 1024,
  tailChars: 8000,
  defaultTimeoutMs: 30 * 60 * 1000,
  maxTimeoutMs: 2 * 60 * 60 * 1000,
  maxRunsPerSession: 200,
  maxSessionsPerPrincipal: 8,
  sessionIdleMs: 12 * 60 * 60 * 1000,
});

const RUNNING = new Set(['running', 'awaiting_approval']);

/* ---------- output buffer ---------- */

class OutputBuffer {
  constructor(cap = LIMITS.outputBytes) {
    this.cap = cap;
    this.chunks = [];
    this.bytes = 0;
    this.seq = 0;
    this.truncated = false;
  }

  push(stream, text) {
    if (!text) return null;
    this.seq += 1;
    const chunk = { seq: this.seq, stream, text, ts: Date.now() };
    this.chunks.push(chunk);
    this.bytes += Buffer.byteLength(text, 'utf8');
    // Drop from the front, but keep the offset so a client can tell it missed something.
    while (this.bytes > this.cap && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.bytes -= Buffer.byteLength(dropped.text, 'utf8');
      this.truncated = true;
    }
    return chunk;
  }

  since(seq = 0) {
    return this.chunks.filter((c) => c.seq > seq);
  }

  text(stream) {
    return this.chunks.filter((c) => c.stream === stream).map((c) => c.text).join('');
  }
}

/* ---------- in-memory run handles ---------- */

const live = new Map(); // runId -> { child, buffer, listeners:Set, timers, env, secrets }
const sessionLive = new Map(); // sessionId -> { cwdAbs, env, secrets, running: runId|null }

const listeners = new Set(); // status fan-out (the server bridges this to the WS topic)

export function onTerminalEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(payload) {
  for (const fn of listeners) {
    try { fn(payload); } catch { /* one broken listener must not stop a run */ }
  }
}

/* ---------- helpers ---------- */

const now = () => Date.now();

/**
 * Refusals *throw*. An earlier version of this file built the error and returned it, which meant every
 * guard below was decorative: `changeDirectory` kept going with an unresolved path (`cwdAbs` became
 * undefined, so `spawn` silently inherited the gateway's own working directory) and an agent without a
 * grant could reach `runForAgent`'s spawn. Guards must stop the line they are on.
 */
function fail(code, message, extra = {}) {
  throw Object.assign(new Error(message), { code, ...extra });
}

const masker = (secrets) => (text) => {
  let out = text;
  for (const value of secrets) {
    if (!value || value.length < 4) continue;
    out = out.split(value).join('••••');
  }
  return out;
};

function sessionRow(id) {
  return db.prepare('SELECT * FROM terminal_sessions WHERE id=?').get(id);
}

export function runRow(id) {
  return db.prepare('SELECT * FROM terminal_runs WHERE id=?').get(id);
}

function publicRun(row) {
  if (!row) return null;
  const liveRun = live.get(row.id);
  return {
    id: row.id,
    sessionId: row.session_id,
    command: row.command,
    argv: safeJson(row.argv, []),
    cwd: row.cwd,
    status: row.status,
    exitCode: row.exit_code ?? null,
    signal: row.signal ?? null,
    destructive: Boolean(row.destructive),
    approvalId: row.approval_id || null,
    agentId: row.agent_id || '',
    startedAt: row.started_at,
    endedAt: row.ended_at ?? null,
    durationMs: row.duration_ms ?? null,
    outputBytes: row.output_bytes || 0,
    truncated: Boolean(row.truncated),
    stdoutTail: row.stdout_tail || '',
    stderrTail: row.stderr_tail || '',
    live: Boolean(liveRun && !liveRun.finished),
    heartbeat: liveRun ? liveRun.heartbeatAt : null,
  };
}

function safeJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

/* ---------- sessions ---------- */

function workspaceRow(id) {
  return db.prepare('SELECT * FROM terminal_workspaces WHERE id=?').get(id);
}

const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'workspace';

export function ensureWorkspace({ name = 'default', rootId = null, relPath = null, principal = 'system', trusted = false } = {}) {
  const id = `ws-${slug(name)}`;
  // The directory is named after the workspace, inside a configured root. A request can never name
  // an absolute path — only the deployment config decides where roots live.
  relPath = relPath || slug(name);
  const existing = workspaceRow(id);
  const root = rootById(rootId || roots()[0].id);
  if (existing) {
    ensureWorkspaceDirectory(rootById(existing.root_id).path, existing.rel_path);
    return workspaceRow(id);
  }
  ensureWorkspaceDirectory(root.path, relPath);
  db.prepare(`INSERT INTO terminal_workspaces (id,name,root_id,rel_path,description,trusted,created_by,created_at,last_used_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, name, root.id, relPath, '', trusted ? 1 : 0, principal, now(), now());
  return workspaceRow(id);
}

export function listWorkspaces() {
  const rows = db.prepare('SELECT * FROM terminal_workspaces ORDER BY name COLLATE NOCASE').all();
  return rows.map((row) => {
    const root = rootById(row.root_id);
    const abs = join(root.path, row.rel_path);
    const project = readProject(abs);
    return {
      id: row.id,
      name: row.name,
      rootId: row.root_id,
      relPath: row.rel_path,
      path: abs,
      trusted: Boolean(row.trusted),
      isRepo: Boolean(root.isRepo),
      exists: root.path ? true : false,
      project: project && !project.error
        ? { name: project.name, version: project.version, scripts: Object.keys(project.scripts), hasNodeModules: project.hasNodeModules }
        : null,
      projectError: project?.error || null,
    };
  });
}

/**
 * Open a session. The session owns a working directory and an environment; both belong to the
 * server, so a client can move around but never name a path outside the workspace.
 */
export function createSession({ principal, workspaceId = null, cwd = '.', env = {} } = {}) {
  const open = db.prepare("SELECT COUNT(*) n FROM terminal_sessions WHERE principal_id=? AND status='open'").get(principal.id).n;
  if (open >= LIMITS.maxSessionsPerPrincipal) {
    fail('conflict', `too many open terminal sessions (${open}); close one first`);
  }
  const workspace = workspaceId ? workspaceRow(workspaceId) : ensureWorkspace({ principal: principal.id });
  if (!workspace) fail('not-found', 'workspace not found');
  const root = rootById(workspace.root_id);
  const resolved = resolveInside(root.path, workspace.rel_path, cwd);
  if (!resolved.ok) fail('bad-path', resolved.reason);

  const id = `ts-${randomUUID().slice(0, 8)}`;
  const cleanEnv = sanitiseEnv(env);
  db.prepare(`INSERT INTO terminal_sessions (id,principal_id,workspace_id,cwd,env_keys,status,created_at,last_seen_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, principal.id, workspace.id, resolved.rel, JSON.stringify(Object.keys(cleanEnv)), 'open', now(), now());
  sessionLive.set(id, sessionState(root.path, workspace, resolved, cleanEnv));
  audit(principal.id, principal.via, 'terminal.session.open', { sessionId: id, workspace: workspace.id, cwd: resolved.rel }, 'allow', 'ok');
  return publicSession(sessionRow(id));
}

function sessionState(rootPath, workspace, resolved, env) {
  const secrets = Object.values(env).filter((v) => typeof v === 'string' && v.length >= 4);
  return {
    rootPath,
    workspace,
    workspaceAbs: join(rootPath, workspace.rel_path),
    cwdAbs: resolved.abs, cwdRel: resolved.rel, env, secrets, running: null,
  };
}

function sanitiseEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) continue;
    if (Object.keys(out).length >= 32) break;
    out[key] = String(value ?? '').slice(0, 4096);
  }
  return out;
}

function publicSession(row) {
  if (!row) return null;
  const state = sessionLive.get(row.id);
  const workspace = workspaceRow(row.workspace_id);
  const project = readProject(state?.cwdAbs || join(rootById(workspace.root_id).path, workspace.rel_path));
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceName: workspace.name,
    cwd: state?.cwdRel ?? row.cwd,
    cwdPath: state?.cwdAbs ?? null,
    // Environment *names* only. Values never leave the process that holds them.
    envKeys: safeJson(row.env_keys, []),
    status: row.status,
    project: project && !project.error
      ? { name: project.name, version: project.version, scripts: Object.keys(project.scripts), hasLockfile: project.hasLockfile, hasNodeModules: project.hasNodeModules }
      : null,
    projectError: project?.error || null,
    runningRunId: state?.running || null,
    createdAt: row.created_at,
  };
}

export function getSession(id) {
  const row = sessionRow(id);
  if (!row) fail('not-found', 'session not found');
  return publicSession(row);
}

export function listSessions({ principal } = {}) {
  const rows = principal
    ? db.prepare('SELECT * FROM terminal_sessions WHERE principal_id=? ORDER BY created_at DESC').all(principal.id)
    : db.prepare('SELECT * FROM terminal_sessions ORDER BY created_at DESC').all();
  return rows.map(publicSession).filter(Boolean);
}

export function setSessionEnv(sessionId, env, principal) {
  const state = sessionLive.get(sessionId);
  const row = sessionRow(sessionId);
  if (!row) fail('not-found', 'session not found');
  if (!state) fail('conflict', 'this session is not open in this process; open a new one');
  state.env = { ...state.env, ...sanitiseEnv(env) };
  state.secrets = Object.values(state.env).filter((v) => typeof v === 'string' && v.length >= 4);
  db.prepare('UPDATE terminal_sessions SET env_keys=? WHERE id=?').run(JSON.stringify(Object.keys(state.env)), sessionId);
  // Values are deliberately not recorded — only that the environment changed.
  audit(principal?.id || 'system', principal?.via || 'api', 'terminal.session.env', { sessionId, keys: Object.keys(env || {}) }, 'allow', 'ok');
  return publicSession(sessionRow(sessionId));
}

export function changeDirectory(sessionId, cwd, principal) {
  const row = sessionRow(sessionId);
  if (!row) fail('not-found', 'session not found');
  const state = sessionLive.get(sessionId);
  if (!state) fail('conflict', 'this session is not open in this process; open a new one');
  const workspace = workspaceRow(row.workspace_id);
  const resolved = resolveInside(state.rootPath, workspace.rel_path, cwd);
  if (!resolved.ok) fail('bad-path', resolved.reason);
  state.cwdAbs = resolved.abs;
  state.cwdRel = resolved.rel;
  db.prepare('UPDATE terminal_sessions SET cwd=?, last_seen_at=? WHERE id=?').run(resolved.rel, now(), sessionId);
  audit(principal?.id || 'system', principal?.via || 'api', 'terminal.cwd', { sessionId, cwd: resolved.rel }, 'allow', 'ok');
  return publicSession(sessionRow(sessionId));
}

export function closeSession(sessionId, principal) {
  const row = sessionRow(sessionId);
  if (!row) fail('not-found', 'session not found');
  const state = sessionLive.get(sessionId);
  if (state?.running) interrupt(state.running, { principal, reason: 'session closed' });
  db.prepare("UPDATE terminal_sessions SET status='closed', closed_at=? WHERE id=?").run(now(), sessionId);
  sessionLive.delete(sessionId);
  audit(principal?.id || 'system', principal?.via || 'api', 'terminal.session.close', { sessionId }, 'allow', 'ok');
  return { closed: sessionId };
}

/* ---------- running ---------- */

function insertRun({ sessionId, principal, agentId, command, argv, cwd, destructive, approvalId }) {
  const id = `tr-${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO terminal_runs
    (id,session_id,principal_id,agent_id,command,argv,cwd,status,approval_id,destructive,started_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, sessionId || null, principal.id, agentId || '', command,
      JSON.stringify(argv || []), cwd || '', approvalId ? 'awaiting_approval' : 'running',
      approvalId || null, destructive ? 1 : 0, now());
  return id;
}

/**
 * Start a command in a session.
 * @returns {{ run: object, approval?: object }}
 */
export function runCommand(sessionId, line, { principal, timeoutMs = null } = {}) {
  const row = sessionRow(sessionId);
  if (!row) fail('not-found', 'session not found');
  if (row.status !== 'open') fail('conflict', 'this session is closed');
  const state = sessionLive.get(sessionId);
  if (!state) fail('conflict', 'this session is not open in this process; open a new one');
  if (state.running) {
    const current = runRow(state.running);
    fail('conflict', `a command is already running in this session (${current?.command || 'unknown'}); stop it first or open another session`);
  }

  const verdict = checkCommand(line, { workspaceAbs: state.workspaceAbs });
  if (!verdict.ok) {
    // A refusal is still a record: it is what an operator needs to see when a command "did nothing".
    const id = insertRun({ sessionId, principal, command: line, argv: [], cwd: state.cwdRel, destructive: false });
    db.prepare('UPDATE terminal_runs SET status=?, ended_at=?, duration_ms=?, stderr_tail=? WHERE id=?')
      .run('refused', now(), 0, String(verdict.reason).slice(0, LIMITS.tailChars), id);
    audit(principal.id, principal.via, 'terminal.run', { sessionId, command: line, refused: verdict.reason }, 'deny', 'denied');
    return { run: publicRun(runRow(id)), refused: true, reason: verdict.reason };
  }

  if (verdict.destructive) {
    return { run: requestApproval({ sessionId, principal, line, verdict, state }) };
  }
  return { run: startProcess({ sessionId, principal, line, verdict, state, timeoutMs }) };
}

function requestApproval({ sessionId, principal, line, verdict, state }) {
  const approvalId = `ap-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
  db.prepare(`INSERT INTO approvals (id, action, target, risk, principal, evidence, status, created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(approvalId, 'terminal.run', `${state.cwdRel} · ${line}`.slice(0, 200),
      verdict.risk === 'low' ? 'medium' : 'high', principal.name,
      `Destructive command in the terminal. ${verdict.reasons.join('; ')}. Working directory: ${state.cwdRel}.`,
      'pending', now());
  const id = insertRun({ sessionId, principal, command: line, argv: verdict.argv, cwd: state.cwdRel, destructive: true, approvalId });
  logEvent('approval', `Terminal command needs approval: ${line} (${principal.name})`, approvalId);
  audit(principal.id, principal.via, 'terminal.run', { sessionId, runId: id, command: line, approval: approvalId, reasons: verdict.reasons }, 'allow', 'pending-approval');
  emit({ type: 'terminal.run', runId: id, sessionId, status: 'awaiting_approval' });
  return publicRun(runRow(id));
}

/** A denied gate: the run is closed as `refused` and never executes. */
export function cancelApproval(approvalId, { principal } = {}) {
  const row = db.prepare("SELECT * FROM terminal_runs WHERE approval_id=? AND status='awaiting_approval'").get(approvalId);
  if (!row) return null;
  db.prepare("UPDATE terminal_runs SET status='refused', ended_at=?, stderr_tail=? WHERE id=?")
    .run(now(), 'the approval was denied, so the command did not run', row.id);
  audit(principal?.id || 'system', principal?.via || 'api', 'terminal.run', { runId: row.id, approval: approvalId, denied: true }, 'deny', 'denied');
  emit({ type: 'terminal.run', runId: row.id, sessionId: row.session_id, status: 'refused' });
  return publicRun(runRow(row.id));
}

/** Called by the approvals route after a gate is allowed: the run starts exactly here. */
export function startApprovedRun(approvalId, { principal } = {}) {
  const row = db.prepare("SELECT * FROM terminal_runs WHERE approval_id=? AND status='awaiting_approval'").get(approvalId);
  if (!row) return null;
  const sessionId = row.session_id;
  const session = sessionRow(sessionId);
  const state = sessionLive.get(sessionId);
  if (!session || !state) {
    db.prepare("UPDATE terminal_runs SET status='blocked', ended_at=?, stderr_tail=? WHERE id=?")
      .run(now(), 'the session was closed while this command waited for approval', row.id);
    return publicRun(runRow(row.id));
  }
  const verdict = checkCommand(row.command, { workspaceAbs: state.workspaceAbs });
  if (!verdict.ok) {
    db.prepare("UPDATE terminal_runs SET status='refused', ended_at=?, stderr_tail=? WHERE id=?")
      .run(now(), verdict.reason, row.id);
    return publicRun(runRow(row.id));
  }
  // Re-issue under the original owner, but attribute the approval to the decider.
  const owner = db.prepare('SELECT id, name, role FROM principals WHERE id=?').get(row.principal_id)
    || { id: row.principal_id, name: row.principal_id, role: 'Operator' };
  db.prepare("UPDATE terminal_runs SET status='queued' WHERE id=?").run(row.id);
  startProcess({
    sessionId,
    principal: { id: owner.id, name: owner.name, via: 'api' },
    line: row.command,
    verdict,
    state,
    existingRunId: row.id,
    approver: principal?.id || null,
  });
  return publicRun(runRow(row.id));
}

function startProcess({ sessionId, principal, line, verdict, state, existingRunId = null, timeoutMs = null, approver = null }) {
  const runId = existingRunId || insertRun({
    sessionId, principal, command: line, argv: verdict.argv, cwd: state.cwdRel, destructive: Boolean(verdict.destructive),
  });

  const home = join(state.rootPath, '.terminal-home');
  mkdirSync(home, { recursive: true });
  const env = buildEnv({ sessionEnv: state.env, home, workspace: state.cwdAbs });
  const mask = masker(state.secrets);
  const buffer = new OutputBuffer();
  const budget = Math.min(Math.max(Number(timeoutMs) || LIMITS.defaultTimeoutMs, 1000), LIMITS.maxTimeoutMs);

  const handle = {
    id: runId,
    sessionId,
    buffer,
    listeners: new Set(),
    finished: false,
    heartbeatAt: now(),
    env,
    child: null,
  };

  const push = (stream, raw) => {
    const chunk = buffer.push(stream, mask(String(raw)));
    if (!chunk) return;
    handle.heartbeatAt = now();
    for (const fn of handle.listeners) {
      try { fn(chunk); } catch { /* a dead reader must not kill the run */ }
    }
    emit({ type: 'terminal.output', runId, sessionId, seq: chunk.seq });
  };

  // Defence in depth for the class of bug above: a spawn with an undefined cwd silently inherits the
  // gateway's own directory, which is exactly where a command must never run.
  const cwd = state.cwdAbs;
  if (typeof cwd !== 'string' || !cwd.startsWith('/') || !state.workspaceAbs || !cwd.startsWith(resolve(state.workspaceAbs))) {
    db.prepare('UPDATE terminal_runs SET status=?, ended_at=?, duration_ms=?, stderr_tail=? WHERE id=?')
      .run('blocked', now(), 0, 'the session has no resolved working directory inside its workspace', runId);
    emit({ type: 'terminal.run', runId, sessionId, status: 'blocked' });
    return publicRun(runRow(runId));
  }

  let child;
  try {
    child = spawn(verdict.argv[0], verdict.argv.slice(1), {
      cwd,
      env,
      shell: false,
      detached: true, // own process group: Ctrl+C can reach npm's grandchildren
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    db.prepare('UPDATE terminal_runs SET status=?, ended_at=?, duration_ms=?, stderr_tail=? WHERE id=?')
      .run('failed', now(), 0, String(error.message).slice(0, LIMITS.tailChars), runId);
    emit({ type: 'terminal.run', runId, sessionId, status: 'failed' });
    return publicRun(runRow(runId));
  }

  handle.child = child;
  live.set(runId, handle);
  state.running = runId;
  db.prepare("UPDATE terminal_runs SET status='running' WHERE id=?").run(runId);
  emit({ type: 'terminal.run', runId, sessionId, status: 'running', command: line });

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (text) => push('out', text));
  child.stderr?.on('data', (text) => push('err', text));
  // Nothing is written to stdin unless the client sends it; closing it lets npm exit on EOF rather
  // than waiting forever for a tty that is not there.
  child.stdin?.on('error', () => { /* EPIPE when the child ignores stdin */ });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    push('sys', `\n[mmm] time limit reached after ${Math.round(budget / 1000)}s — sending SIGTERM\n`);
    killGroup(child, 'SIGTERM');
    setTimeout(() => { if (!handle.finished) killGroup(child, 'SIGKILL'); }, 5000).unref?.();
  }, budget);
  timer.unref?.();

  const finish = (code, signal) => {
    if (handle.finished) return;
    handle.finished = true;
    clearTimeout(timer);
    live.delete(runId);
    if (state.running === runId) state.running = null;
    const ended = now();
    const started = runRow(runId)?.started_at ?? ended;
    const status = timedOut ? 'timed_out' : signal ? 'cancelled' : code === 0 ? 'completed' : 'failed';
    db.prepare(`UPDATE terminal_runs SET status=?, exit_code=?, signal=?, ended_at=?, duration_ms=?,
                output_bytes=?, truncated=?, stdout_tail=?, stderr_tail=? WHERE id=?`)
      .run(status, code ?? null, signal ?? null, ended, ended - started, buffer.bytes, buffer.truncated ? 1 : 0,
        buffer.text('out').slice(-LIMITS.tailChars), buffer.text('err').slice(-LIMITS.tailChars), runId);
    push('sys', `\n[mmm] ${status}${code !== null && code !== undefined ? ` · exit ${code}` : ''}${signal ? ` · ${signal}` : ''} · ${Math.round((ended - started) / 100) / 10}s\n`);
    audit(principal.id, principal.via, 'terminal.run.finish', {
      runId, sessionId, command: line, status, exitCode: code ?? null, signal: signal ?? null, approver,
    }, 'allow', 'ok');
    emit({ type: 'terminal.run', runId, sessionId, status, exitCode: code ?? null, signal: signal ?? null });
    for (const fn of handle.listeners) {
      try { fn({ seq: buffer.seq, stream: 'exit', text: '', status, code: code ?? null, signal: signal ?? null }); } catch { /* ignore */ }
    }
    handle.listeners.clear();
  };

  child.on('error', (error) => {
    push('err', `${error.message}\n`);
    finish(null, null);
  });
  child.on('close', (code, signal) => finish(code, signal));

  return publicRun(runRow(runId));
}

function killGroup(child, signal) {
  try { process.kill(-child.pid, signal); } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

export function sendInput(runId, text) {
  const handle = live.get(runId);
  if (!handle || handle.finished) fail('not-found', 'that command is not running');
  if (!handle.child?.stdin || handle.child.stdin.destroyed) fail('conflict', 'this process is not reading stdin');
  const value = String(text ?? '');
  if (value.length > 4096) fail('bad-request', 'input is capped at 4096 characters per write');
  handle.child.stdin.write(value);
  return { runId, written: value.length };
}

/** SIGINT to the process group — what Ctrl+C means. */
export function interrupt(runId, { principal, reason = 'interrupt' } = {}) {
  const handle = live.get(runId);
  if (!handle || handle.finished) fail('not-found', 'that command is not running');
  handle.buffer.push('sys', '\n[mmm] interrupt (SIGINT)\n');
  killGroup(handle.child, 'SIGINT');
  audit(principal?.id || 'system', principal?.via || 'api', 'terminal.signal', { runId, signal: 'SIGINT', reason }, 'allow', 'ok');
  emit({ type: 'terminal.signal', runId, signal: 'SIGINT' });
  return { runId, signal: 'SIGINT' };
}

export function signalRun(runId, signal, { principal } = {}) {
  if (signal === 'SIGINT') return interrupt(runId, { principal });
  const handle = live.get(runId);
  if (!handle || handle.finished) fail('not-found', 'that command is not running');
  if (!['SIGTERM', 'SIGKILL'].includes(signal)) fail('bad-request', `unsupported signal “${signal}”`);
  killGroup(handle.child, signal);
  audit(principal?.id || 'system', principal?.via || 'api', 'terminal.signal', { runId, signal }, 'allow', 'ok');
  return { runId, signal };
}

/** Attach a live reader. Returns an unsubscribe function. */
export function subscribeRun(runId, onChunk) {
  const handle = live.get(runId);
  if (!handle) return null;
  handle.listeners.add(onChunk);
  return () => handle.listeners.delete(onChunk);
}

export function getRun(runId) {
  const row = runRow(runId);
  if (!row) fail('not-found', 'run not found');
  return publicRun(row);
}

export function runOutput(runId, { since = 0 } = {}) {
  const row = runRow(runId);
  if (!row) fail('not-found', 'run not found');
  const handle = live.get(runId);
  const chunks = handle ? handle.buffer.since(since) : [];
  return {
    run: publicRun(row),
    chunks,
    // When the process is gone the buffer is gone too; the stored tail is the honest fallback.
    replay: handle ? 'memory' : 'tail',
    stdout: handle ? undefined : row.stdout_tail,
    stderr: handle ? undefined : row.stderr_tail,
  };
}

export function listRuns({ sessionId, limit = 50 } = {}) {
  const rows = sessionId
    ? db.prepare('SELECT * FROM terminal_runs WHERE session_id=? ORDER BY started_at DESC LIMIT ?').all(sessionId, limit)
    : db.prepare('SELECT * FROM terminal_runs ORDER BY started_at DESC LIMIT ?').all(limit);
  return rows.map(publicRun);
}

export function history({ sessionId = null, principal = null, limit = 100 } = {}) {
  const clauses = [];
  const params = [];
  if (sessionId) { clauses.push('session_id=?'); params.push(sessionId); }
  if (principal) { clauses.push('principal_id=?'); params.push(principal.id); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);
  const rows = db.prepare(`SELECT command, started_at, status, exit_code FROM terminal_runs ${where}
                            ORDER BY started_at DESC LIMIT ?`).all(...params);
  // Consecutive duplicates collapse: recalling the same command five times is not five entries.
  const out = [];
  for (const row of rows) if (out[0]?.command !== row.command) out.push({ command: row.command, at: row.started_at, status: row.status, exitCode: row.exit_code ?? null });
  return out;
}

/* ---------- agents ---------- */

export function grantAgent({ agentId, workspaceId, grantedBy }) {
  if (!agentId || !workspaceId) fail('bad-request', 'agentId and workspaceId are required');
  db.prepare(`INSERT OR REPLACE INTO terminal_agent_grants (agent_id, workspace_id, granted_by, created_at, revoked_at)
              VALUES (?,?,?,?,NULL)`).run(agentId, workspaceId, grantedBy || '', now());
  audit(grantedBy || 'system', 'api', 'terminal.grant', { agentId, workspaceId }, 'allow', 'ok');
  return listGrants();
}

export function revokeAgent({ agentId, workspaceId, revokedBy }) {
  db.prepare('UPDATE terminal_agent_grants SET revoked_at=? WHERE agent_id=? AND workspace_id=?')
    .run(now(), agentId, workspaceId);
  audit(revokedBy || 'system', 'api', 'terminal.grant.revoke', { agentId, workspaceId }, 'allow', 'ok');
  return listGrants();
}

export function listGrants() {
  return db.prepare('SELECT * FROM terminal_agent_grants WHERE revoked_at IS NULL').all()
    .map((r) => ({ agentId: r.agent_id, workspaceId: r.workspace_id, grantedBy: r.granted_by, createdAt: r.created_at }));
}

export function agentMayRun(agentId) {
  if (!agentId) return false;
  if (process.env.MMM_TERMINAL_AGENTS === 'off') return false;
  return Boolean(db.prepare('SELECT 1 AS ok FROM terminal_agent_grants WHERE agent_id=? AND revoked_at IS NULL').get(agentId));
}

/**
 * Run a command to completion for an agent and hand back the structured result, so the agent can
 * read the error and decide whether to retry. Bounded by the wall clock, like any other run.
 */
export async function runForAgent({ agentId, command, workspaceId = null, cwd = '.', timeoutMs = null, principal }) {
  if (!agentMayRun(agentId)) {
    fail('forbidden', `agent “${agentId}” has no terminal grant; an Owner must grant one first`);
  }
  const workspace = workspaceId ? workspaceRow(workspaceId)
    : db.prepare('SELECT w.* FROM terminal_workspaces w JOIN terminal_agent_grants g ON g.workspace_id = w.id WHERE g.agent_id=? AND g.revoked_at IS NULL LIMIT 1').get(agentId);
  if (!workspace) fail('forbidden', `agent “${agentId}” has no workspace grant`);
  const agentPrincipal = { id: agentId, name: agentId, role: 'Operator', via: 'agent' };
  const session = createSession({ principal: agentPrincipal, workspaceId: workspace.id, cwd });
  try {
    const started = runCommand(session.id, command, { principal: agentPrincipal, timeoutMs });
    if (started.refused) return { ok: false, refused: true, reason: started.reason, run: started.run };
    if (started.run.status === 'awaiting_approval') {
      return { ok: false, needsApproval: true, approvalId: started.run.approvalId, run: started.run };
    }
    const settled = await waitFor(runIdOf(started.run), Math.min(Number(timeoutMs) || LIMITS.defaultTimeoutMs, LIMITS.maxTimeoutMs) + 5000);
    const row = runRow(settled);
    return {
      ok: row.status === 'completed',
      run: publicRun(row),
      stdout: row.stdout_tail,
      stderr: row.stderr_tail,
      exitCode: row.exit_code ?? null,
      signal: row.signal ?? null,
      durationMs: row.duration_ms ?? null,
      // Enough for an agent to decide what to do next without fetching anything else.
      hint: row.status === 'completed' ? 'ok' : `${row.status}: read stderr, fix the cause, then retry`,
      retryable: ['failed', 'timed_out', 'cancelled'].includes(row.status),
    };
  } finally {
    closeSession(session.id, principal || agentPrincipal);
  }
}

const runIdOf = (run) => run.id;

function waitFor(runId, timeoutMs) {
  return new Promise((resolve) => {
    const handle = live.get(runId);
    if (!handle) return resolve(runId);
    const done = () => { off?.(); clearTimeout(timer); resolve(runId); };
    const timer = setTimeout(done, timeoutMs);
    const off = subscribeRun(runId, (chunk) => { if (chunk.stream === 'exit') done(); });
    if (!handle.listeners.size) done();
  });
}

/* ---------- capability description ---------- */

export function describe() {
  return {
    policy: describeTerminalPolicy(),
    roots: describeRoots(),
    workspaces: listWorkspaces(),
    agentGrants: listGrants(),
    runtime: runtimeVersions(),
  };
}

/**
 * What the host actually has. Reported, never assumed: the screen shows these numbers or shows that
 * it could not get them.
 */
export function runtimeVersions() {
  return {
    node: process.version,
    npm: process.env.MMM_TERMINAL_NPM_VERSION || null,
    platform: process.platform,
    arch: process.arch,
  };
}

export { listScripts, readProject, resolveInside, describeRoots };
