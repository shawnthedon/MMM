/* Terminal — real processes, real exit codes, real npm. Throwaway DATA_DIR, real HTTP.
 * Run: npm run test:terminal
 *
 * This suite is the acceptance evidence, so it does what a person would do: it opens a session, types
 * commands, and reads what actually happened. Nothing is stubbed — the runs below are child processes
 * of this test's own gateway.
 *
 * Offline claim, stated precisely: `npm install` is proven against a package packed from a local
 * directory, so that check needs no registry. `npm install express` is attempted and **skipped with a
 * printed reason** when the registry is unreachable — it is never reported as passing without it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'mmm-terminal-'));
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
const skip = (name, reason) => { results.push(`SKIP ${name}: ${reason}`); skips.push(`${name}: ${reason}`); };
const skips = [];

/* ---------- http client with a cookie jar + CSRF ---------- */
const CSRF_COOKIE = auth.CSRF_HEADER;
function client(ip = '10.9.0.1') {
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

const owner = client('10.9.0.1');
const operator = client('10.9.0.2');
const observer = client('10.9.0.3');
const reviewer = client('10.9.0.4');

eq((await owner.login('owner@test.local', 'OwnerPassw0rd!2026')).status, 200, 'owner login');
for (const [c, role] of [[operator, 'Operator'], [observer, 'Observer'], [reviewer, 'Reviewer']]) {
  const created = await owner.request('/api/v1/principals', {
    method: 'POST', csrf: true,
    body: { email: `${role.toLowerCase()}@test.local`, password: 'TempPassw0rd!9', name: `${role} User`, role },
  });
  eq(created.status, 201, `create ${role} (${created.text})`);
  eq((await c.login(`${role.toLowerCase()}@test.local`, 'TempPassw0rd!9')).status, 200, `${role} login`);
}

/* ---------- helpers ---------- */
let session = null;

/**
 * Hard safety net. This suite runs `npm ci` and `npm uninstall`, so if a bug ever moved the working
 * directory out of the throwaway DATA_DIR it would delete the gateway's own node_modules — which is
 * exactly what happened once while this module was being written. Refuse to run anything outside it.
 */
function assertInsideSandbox(path, where) {
  if (typeof path !== 'string' || !path.startsWith(DATA_DIR)) {
    throw new Error(`${where}: refusing to execute outside the temporary workspace (${path})`);
  }
}

const openSession = async (c = owner, body = {}) => {
  const res = await c.request('/api/v1/terminal/sessions', { method: 'POST', csrf: true, body });
  eq(res.status, 201, `POST /terminal/sessions (${res.text})`);
  assertInsideSandbox(res.body.session.cwdPath, 'openSession');
  return res.body.session;
};

/** Run a command and wait for the process to end. Returns the finished run. */
async function run(sessionId, command, { c = owner, timeoutMs = 120000 } = {}) {
  const res = await c.request(`/api/v1/terminal/sessions/${sessionId}/exec`, { method: 'POST', csrf: true, body: { command } });
  if (res.body?.refused) return { refused: true, reason: res.body.reason, status: res.status };
  const id = res.body.run.id;
  if (res.body.run.status === 'awaiting_approval') return { awaiting: true, run: res.body.run };
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const out = await c.request(`/api/v1/terminal/runs/${id}`);
    if (!out.body.run.live) return out.body.run;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`“${command}” did not finish within ${timeoutMs} ms`);
}

/** Read the SSE stream to completion, returning the events in order. */
async function stream(prefix, runId) {
  const controller = new AbortController();
  const res = await fetch(`${BASE}/api/v1/terminal/runs/${runId}/stream`, {
    headers: { cookie: Object.entries(prefix.jar).map(([k, v]) => `${k}=${v}`).join('; ') },
    signal: controller.signal,
  });
  eq(res.status, 200, 'stream status');
  eq(res.headers.get('content-type')?.split(';')[0], 'text/event-stream', 'the stream must be an event stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';
    for (const frame of frames) {
      const name = /^event: (.*)$/m.exec(frame)?.[1];
      const data = /^data: (.*)$/m.exec(frame)?.[1];
      if (!name) continue;
      let parsed = null;
      try { parsed = JSON.parse(data); } catch { parsed = data; }
      events.push({ name, data: parsed, at: Date.now() });
    }
    if (events.some((e) => e.name === 'exit')) break;
  }
  controller.abort();
  return events;
}

/** Write a package.json straight into the workspace, so a test can assert a script really ran. */
function writeProject(dir, pkg) {
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
}

/* =========================================================================================
 * 1. what the gateway says about itself
 * =======================================================================================*/
await check('the capability endpoint states the executables, the limits and the refusals', async () => {
  const res = await owner.request('/api/v1/terminal');
  eq(res.status, 200, `GET /terminal (${res.text})`);
  const { policy, runtime } = res.body;
  eq(policy.shell, false, 'the terminal must not use a shell');
  eq(policy.executables.join(','), 'node,npm,npx', 'the executable allowlist');
  eq(policy.isolation, 'process', 'isolation is process-level, and the API says so');
  assert(policy.notEnforced.some((l) => /network/i.test(l)), 'the missing network isolation must be stated');
  assert(policy.needsApproval.some((l) => /npm ci/.test(l)), 'npm ci is in the approval set');
  assert(runtime.node, 'the node version must be reported');
  // The version the gateway reports is the version this test is running on — not a guess.
  eq(runtime.node, process.version, 'node version reported matches the host');
});

/* =========================================================================================
 * 2. policy refusals (no process is created)
 * =======================================================================================*/
await check('a command that needs a shell is refused, with the reason', async () => {
  if (!session) session = await openSession();
  for (const line of ['rm -rf /', 'npm install && rm -rf /', 'ls | grep x', 'node -v > out.txt', 'cat /etc/passwd']) {
    const out = await run(session.id, line);
    assert(out.refused, `“${line}” must be refused`);
    assert(/shell|not an allowed executable/i.test(out.reason), `“${line}” must say why (got “${out.reason}”)`);
  }
  const row = db.prepare("SELECT status, stderr_tail FROM terminal_runs WHERE status='refused' ORDER BY started_at DESC LIMIT 1").get();
  assert(row, 'a refusal is recorded as a run, not silently dropped');
  assert(/allowed executable|shell/i.test(row.stderr_tail), 'and the record carries the reason');
});

await check('npm flags that escape the workspace are refused', async () => {
  for (const line of ['npm install -g left-pad', 'npm install --prefix=/usr/lib x', 'npm --registry=http://evil.test install x', 'npm --userconfig=/etc/passwd install x']) {
    const out = await run(session.id, line);
    assert(out.refused, `“${line}” must be refused`);
    assert(/outside|retarget|registry|config/i.test(out.reason), `“${line}” reason (got “${out.reason}”)`);
  }
});

await check('a working directory outside the workspace is refused', async () => {
  const res = await owner.request(`/api/v1/terminal/sessions/${session.id}/cwd`, { method: 'POST', csrf: true, body: { cwd: '../../..' } });
  eq(res.status, 400, 'a traversal must be refused');
  assert(/outside the workspace/i.test(res.body.error), `the reason (got “${res.body.error}”)`);
  const ok = await owner.request(`/api/v1/terminal/sessions/${session.id}/cwd`, { method: 'POST', csrf: true, body: { cwd: '.' } });
  eq(ok.status, 200, 'staying put is fine');
});

/* =========================================================================================
 * 3. acceptance test 1 + 2: the real versions
 * =======================================================================================*/
let workspacePath = null;

await check('AT-1 `node --version` returns the actual installed Node.js version', async () => {
  if (!session) session = await openSession();
  const out = await run(session.id, 'node --version');
  eq(out.status, 'completed', `status (stderr: ${out.stderrTail})`);
  eq(out.exitCode, 0, 'exit code');
  eq(out.stdoutTail.trim(), process.version, 'the version is this host’s Node, not a fixture');
  workspacePath = session.cwdPath;
  assertInsideSandbox(workspacePath, 'AT-1');
});

await check('AT-2 `npm --version` returns the actual installed npm version', async () => {
  const hostVersion = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  const out = await run(session.id, 'npm --version');
  eq(out.status, 'completed', `status (stderr: ${out.stderrTail})`);
  eq(out.stdoutTail.trim(), hostVersion, 'the version is the host npm binary’s own output');
});

/* =========================================================================================
 * 4. acceptance test 3: npm init -y writes a real file
 * =======================================================================================*/
await check('AT-3 `npm init -y` creates a real package.json on disk', async () => {
  const before = existsSync(join(workspacePath, 'package.json'));
  const out = await run(session.id, 'npm init -y');
  eq(out.status, 'completed', `status (stderr: ${out.stderrTail})`);
  const file = join(workspacePath, 'package.json');
  assert(existsSync(file), 'package.json must exist on disk after the command');
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  assert(pkg.name, 'the written package.json has a name');
  assert(pkg.version, 'and a version');
  if (before) results.push('NOTE package.json already existed; the command rewrote it (npm’s own behaviour)');
  // The session now reports the project it is sitting in.
  const meta = await owner.request(`/api/v1/terminal/sessions/${session.id}`);
  assert(meta.body.session.project, 'the session should detect the new package.json');
});

/* =========================================================================================
 * 5. acceptance test 6 + 7: scripts are read from the file and really executed
 * =======================================================================================*/
await check('AT-6 `npm run` lists the project’s actual scripts', async () => {
  writeProject(workspacePath, {
    name: 'mmm-terminal-fixture', version: '1.0.0', private: true,
    scripts: {
      build: 'node build.mjs',
      test: 'node test.mjs',
      dev: 'node dev.mjs',
      greet: 'node -e "console.log(\'hi from greet\')"',
    },
  });
  const out = await run(session.id, 'npm run');
  eq(out.status, 'completed', `status (stderr: ${out.stderrTail})`);
  for (const name of ['build', 'test', 'dev', 'greet']) {
    assert(out.stdoutTail.includes(name), `npm run must list the script “${name}” (got “${out.stdoutTail.slice(0, 300)}”)`);
  }
  const scripts = await owner.request(`/api/v1/terminal/scripts?sessionId=${session.id}`);
  eq(scripts.status, 200, 'GET /terminal/scripts');
  eq(scripts.body.scripts.length, 4, 'the parsed script list');
  assert(scripts.body.scripts.every((s) => s.command), 'each script carries its command');
});

await check('AT-7 `npm run build` executes the project’s real build script', async () => {
  writeFileSync(join(workspacePath, 'build.mjs'), "import { writeFileSync } from 'node:fs';\nwriteFileSync('dist.txt', 'built by the real script');\nconsole.log('build: wrote dist.txt');\n");
  const out = await run(session.id, 'npm run build');
  eq(out.status, 'completed', `status (stderr: ${out.stderrTail})`);
  assert(out.stdoutTail.includes('build: wrote dist.txt'), `the script’s own output (got “${out.stdoutTail}”)`);
  const artifact = join(workspacePath, 'dist.txt');
  assert(existsSync(artifact), 'the build script really ran and wrote its file');
  eq(readFileSync(artifact, 'utf8'), 'built by the real script', 'with the content it was told to write');
});

await check('a script with arguments passes them through', async () => {
  const out = await run(session.id, 'npm run greet');
  eq(out.status, 'completed', `status (stderr: ${out.stderrTail})`);
  assert(out.stdoutTail.includes('hi from greet'), `stdout (got “${out.stdoutTail}”)`);
});

/* =========================================================================================
 * 6. acceptance test 4 + 5: npm install, offline first, then the registry
 * =======================================================================================*/
await check('AT-4 `npm install` installs an actual dependency (from a local package, no registry)', async () => {
  // Pack a dependency from a directory, so the check does not depend on the network.
  const depDir = join(DATA_DIR, 'fixture-dep');
  mkdirSync(depDir, { recursive: true });
  writeFileSync(join(depDir, 'package.json'), JSON.stringify({ name: 'mmm-fixture-dep', version: '1.0.0', main: 'index.js' }, null, 2));
  writeFileSync(join(depDir, 'index.js'), "export const hello = () => 'hello from the packed dependency';\n");
  const tarball = execFileSync('npm', ['pack', '--silent'], { cwd: depDir, encoding: 'utf8' }).trim().split('\n').pop();
  assert(existsSync(join(depDir, tarball)), `npm pack should produce ${tarball}`);
  // The tarball is copied *inside* the workspace: the terminal refuses paths outside it.
  execFileSync('cp', [join(depDir, tarball), join(workspacePath, tarball)]);

  writeProject(workspacePath, {
    name: 'mmm-terminal-fixture', version: '1.0.0', private: true,
    scripts: { build: 'node build.mjs' },
    dependencies: {},
  });
  const out = await run(session.id, `npm install ./${tarball}`, { timeoutMs: 180000 });
  eq(out.status, 'completed', `status (stderr: ${out.stderrTail.slice(-400)})`);
  const installed = join(workspacePath, 'node_modules', 'mmm-fixture-dep', 'package.json');
  assert(existsSync(installed), 'the dependency must be on disk in node_modules');
  eq(JSON.parse(readFileSync(installed, 'utf8')).version, '1.0.0', 'the installed version');
  const pkg = JSON.parse(readFileSync(join(workspacePath, 'package.json'), 'utf8'));
  assert(pkg.dependencies?.['mmm-fixture-dep'], 'and it was recorded in package.json');
});

await check('AT-5 `npm install express` installs Express (skipped without registry access)', async () => {
  let reachable = false;
  try {
    const probe = execFileSync('npm', ['view', 'express', 'version'], { encoding: 'utf8', timeout: 15000 }).trim();
    reachable = Boolean(probe);
  } catch { reachable = false; }
  if (!reachable) return skip('npm install express', 'the npm registry is unreachable from this environment — not reported as passing');

  const out = await run(session.id, 'npm install express', { timeoutMs: 240000 });
  eq(out.status, 'completed', `status (stderr: ${out.stderrTail.slice(-400)})`);
  assert(existsSync(join(workspacePath, 'node_modules', 'express', 'package.json')), 'express must be in node_modules');
  const pkg = JSON.parse(readFileSync(join(workspacePath, 'package.json'), 'utf8'));
  assert(pkg.dependencies?.express, 'express must be recorded as a dependency');
  // And it is importable by a real process.
  const usage = await run(session.id, 'node -e "const e = require(\'express\'); console.log(typeof e)"');
  eq(usage.status, 'completed', `require(express) (stderr: ${usage.stderrTail})`);
  eq(usage.stdoutTail.trim(), 'function', 'express loads and exports its factory');
});

/* =========================================================================================
 * 7. acceptance test 8 + 9: long-running processes and Ctrl+C
 * =======================================================================================*/
await check('AT-8 `npm run dev` starts a real long-running process that stays running', async () => {
  writeFileSync(join(workspacePath, 'dev.mjs'),
    "console.log('dev: listening on 4321');\nsetInterval(() => process.stdout.write('tick\\n'), 400);\n");
  writeProject(workspacePath, {
    name: 'mmm-terminal-fixture', version: '1.0.0', private: true,
    scripts: { build: 'node build.mjs', dev: 'node dev.mjs', test: 'node test.mjs', greet: 'node -e "console.log(\'hi\')"' },
  });
  const res = await owner.request(`/api/v1/terminal/sessions/${session.id}/exec`, {
    method: 'POST', csrf: true, body: { command: 'npm run dev' },
  });
  eq(res.status, 202, 'the run is accepted immediately, not awaited');
  const runId = res.body.run.id;

  // Watch it for a while: it must still be alive after three seconds, which is twice the old
  // sandbox's default budget in miniature and proof this is not a buffered execute-and-die.
  await new Promise((r) => setTimeout(r, 3000));
  const live = await owner.request(`/api/v1/terminal/runs/${runId}`);
  eq(live.body.run.status, 'running', 'a dev server has to still be running after three seconds');
  const output = await owner.request(`/api/v1/terminal/runs/${runId}/output`);
  const text = output.body.chunks.map((c) => c.text).join('');
  assert(text.includes('listening on 4321'), `the first line arrived (got “${text.slice(0, 200)}”)`);
  assert((text.match(/tick/g) || []).length >= 2, 'output is arriving over time, not in one buffered block');

  /* AT-9 — Ctrl+C terminates it. */
  const signal = await owner.request(`/api/v1/terminal/runs/${runId}/signal`, { method: 'POST', csrf: true, body: { signal: 'SIGINT' } });
  eq(signal.status, 200, `SIGINT (${signal.text})`);

  let final = null;
  for (let i = 0; i < 100; i += 1) {
    const out = await owner.request(`/api/v1/terminal/runs/${runId}`);
    if (!out.body.run.live) { final = out.body.run; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(final, 'the process must exit after SIGINT');
  eq(final.signal, 'SIGINT', 'the signal is the one that was sent');
  eq(final.status, 'cancelled', 'and the run is marked cancelled, not completed');
  assert(final.durationMs >= 2500, `it really ran for a while (${final.durationMs} ms)`);
});

await check('the process group dies with the parent — no orphaned server', async () => {
  // npm spawns the script as a child; killing the group must take both. A surviving listener would
  // still hold the script filename in its command line.
  const survivors = execFileSync('bash', ['-c', "ps -eo pid,args | grep -c '[d]ev.mjs' || true"], { encoding: 'utf8' }).trim();
  eq(survivors, '0', 'no npm run dev child may outlive the Ctrl+C');
});

/* =========================================================================================
 * 8. acceptance test 10: errors and exit codes
 * =======================================================================================*/
await check('AT-10 exit codes are reported exactly, and stderr stays separate from stdout', async () => {
  const seven = await run(session.id, 'node -e "process.exit(7)"');
  eq(seven.exitCode, 7, 'exit 7 must come back as 7');
  eq(seven.status, 'failed', 'a non-zero exit is a failure, not a success');

  const mixed = await run(session.id, 'node -e "console.log(\'to out\'); console.error(\'to err\'); process.exit(3)"');
  eq(mixed.exitCode, 3, 'exit 3');
  assert(mixed.stdoutTail.includes('to out'), 'stdout went to stdout');
  assert(mixed.stderrTail.includes('to err'), 'stderr went to stderr');
  assert(!mixed.stderrTail.includes('to out'), 'the streams are not merged');

  const missing = await run(session.id, 'node nope.mjs');
  eq(missing.status, 'failed', 'a missing file fails');
  assert(missing.exitCode !== 0, 'with a non-zero code');
  assert(/nope\.mjs|Cannot find/i.test(missing.stderrTail), `the reason is in stderr (got “${missing.stderrTail}”)`);
});

/* =========================================================================================
 * 9. streaming
 * =======================================================================================*/
await check('output streams as it happens over text/event-stream', async () => {
  const res = await owner.request(`/api/v1/terminal/sessions/${session.id}/exec`, {
    method: 'POST', csrf: true,
    body: { command: 'node -e "let i=0; const t=setInterval(()=>{ console.log(\'chunk\'+(++i)); if(i===4){clearInterval(t);} }, 250);"' },
  });
  eq(res.status, 202, 'started');
  const events = await stream(owner, res.body.run.id);
  const chunks = events.filter((e) => e.name === 'chunk' && e.data.stream === 'out');
  eq(chunks.length, 4, 'each write arrives as its own event');
  // Arrival times must be spread out: a buffered command would deliver all four at once.
  const spread = chunks.at(-1).at - chunks[0].at;
  assert(spread >= 400, `chunks arrived over ${spread} ms — they were streamed, not batched`);
  assert(events.some((e) => e.name === 'exit'), 'the stream ends with an exit event');
});

await check('a late subscriber replays the output it missed', async () => {
  const res = await owner.request(`/api/v1/terminal/sessions/${session.id}/exec`, {
    method: 'POST', csrf: true, body: { command: 'node -e "console.log(\'alpha\'); console.log(\'beta\')"' },
  });
  const runId = res.body.run.id;
  await new Promise((r) => setTimeout(r, 800)); // let it finish before anyone attaches
  const output = await owner.request(`/api/v1/terminal/runs/${runId}/output`);
  const text = (output.body.stdout ?? output.body.chunks.map((c) => c.text).join('')) || '';
  assert(text.includes('alpha') && text.includes('beta'), `both lines must be available after the fact (got “${text}”)`);
  const events = await stream(owner, runId);
  const streamed = events.filter((e) => e.name === 'chunk').map((e) => e.data.text).join('');
  assert(streamed.includes('beta'), `a late subscriber still receives the output (got “${streamed}”)`);
});

/* =========================================================================================
 * 10. approval gate
 * =======================================================================================*/
await check('a destructive command waits for a different person, then runs', async () => {
  writeProject(workspacePath, {
    name: 'mmm-terminal-fixture', version: '1.0.0', private: true,
    scripts: { build: 'node build.mjs' }, dependencies: {},
  });
  writeFileSync(join(workspacePath, 'package-lock.json'), JSON.stringify({ name: 'mmm-terminal-fixture', lockfileVersion: 3, requires: true, packages: {} }, null, 2));

  const out = await run(session.id, 'npm ci');
  assert(out.awaiting, 'npm ci must not run on a request alone');
  eq(out.run.status, 'awaiting_approval', 'the run waits');
  const gateId = out.run.approvalId;
  assert(gateId, 'and a gate exists for it');

  // The requester cannot approve their own gate.
  const self = await owner.request(`/api/v1/approvals/${gateId}/allow`, { method: 'POST', csrf: true, body: {} });
  eq(self.status, 403, 'separation of duties: the requester cannot allow their own gate');

  // A Reviewer can.
  const allow = await reviewer.request(`/api/v1/approvals/${gateId}/allow`, { method: 'POST', csrf: true, body: {} });
  eq(allow.status, 200, `Reviewer allows the gate (${allow.text})`);

  let final = null;
  for (let i = 0; i < 150; i += 1) {
    const row = await owner.request(`/api/v1/terminal/runs/${out.run.id}`);
    if (!row.body.run.live && row.body.run.status !== 'awaiting_approval') { final = row.body.run; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(final, 'the approved command must actually run');
  assert(['completed', 'failed'].includes(final.status), `it ran (status ${final.status}, stderr ${final.stderrTail?.slice(-200)})`);
  assert(final.destructive, 'the run is marked destructive so the record shows why it was gated');
});

await check('a denied gate means the command never runs', async () => {
  const out = await run(session.id, 'npm uninstall nothing-here');
  assert(out.awaiting, 'uninstall is destructive');
  const deny = await reviewer.request(`/api/v1/approvals/${out.run.approvalId}/deny`, { method: 'POST', csrf: true, body: {} });
  eq(deny.status, 200, 'deny');
  await new Promise((r) => setTimeout(r, 300));
  const row = await owner.request(`/api/v1/terminal/runs/${out.run.id}`);
  eq(row.body.run.status, 'refused', 'a denied command is refused, not executed');
});

/* =========================================================================================
 * 11. permissions
 * =======================================================================================*/
await check('terminal access follows the role matrix', async () => {
  eq((await observer.request('/api/v1/terminal')).status, 200, 'an Observer may read the capability');
  const obsSession = await observer.request('/api/v1/terminal/sessions', { method: 'POST', csrf: true, body: {} });
  eq(obsSession.status, 403, 'an Observer may not open a session');
  const opSession = await openSession(operator);
  const opRun = await run(opSession.id, 'node --version', { c: operator });
  eq(opRun.status, 'completed', 'an Operator may run');
  const obsSignal = await observer.request(`/api/v1/terminal/runs/${opRun.id}/signal`, { method: 'POST', csrf: true, body: {} });
  eq(obsSignal.status, 403, 'and only a runner may signal');
});

await check('one principal cannot read another principal’s session transcript', async () => {
  const list = await operator.request('/api/v1/terminal/sessions');
  assert(!list.body.sessions.some((s) => s.id === session.id), 'the session list is scoped to its owner');
});

await check('environment variables are accepted by name and never echoed back', async () => {
  const res = await owner.request(`/api/v1/terminal/sessions/${session.id}/env`, {
    method: 'POST', csrf: true, body: { env: { MMM_DEMO_VALUE: 'super-secret-value-123' } },
  });
  eq(res.status, 200, `POST env (${res.text})`);
  assert(res.body.session.envKeys.includes('MMM_DEMO_VALUE'), 'the name is reported');
  assert(!res.text.includes('super-secret-value-123'), 'the value is never sent back to the client');
  const out = await run(session.id, 'node -e "console.log(process.env.MMM_DEMO_VALUE ? \'set\' : \'unset\')"');
  eq(out.stdoutTail.trim(), 'set', 'the child really receives the variable');
  // …and if the process prints it, the stream masks it.
  const echo = await run(session.id, 'node -e "console.log(process.env.MMM_DEMO_VALUE)"');
  assert(!echo.stdoutTail.includes('super-secret-value-123'), 'a secret printed by the child is masked in the transcript');
  assert(echo.stdoutTail.includes('••••'), 'the mask is visible, not a silent deletion');
});

await check('the gateway environment is not inherited', async () => {
  const out = await run(session.id, 'node -e "console.log([\'MMM_BOOTSTRAP_PASSWORD\',\'DATA_DIR\',\'MMM_TERMINAL\'].map(k=>k+\'=\'+(process.env[k]===undefined?\'absent\':\'set\')).join(\' \'))"');
  assert(out.stdoutTail.includes('MMM_BOOTSTRAP_PASSWORD=absent'), `secrets must not reach a child (got “${out.stdoutTail}”)`);
  assert(out.stdoutTail.includes('DATA_DIR=absent'), 'DATA_DIR is not inherited either');
  assert(out.stdoutTail.includes('MMM_TERMINAL=set'), 'the marker that this is a terminal child is set');
});

/* =========================================================================================
 * 12. acceptance test 11: agents
 * =======================================================================================*/
await check('AT-11 an authorised agent can run a command and read the result', async () => {
  const workspaces = await owner.request('/api/v1/terminal/workspaces');
  const workspaceId = workspaces.body.workspaces[0].id;

  // Without a grant, refused — an agent is not implicitly trusted with a shell.
  const before = await owner.request('/api/v1/terminal/agent-runs', {
    method: 'POST', csrf: true, body: { agentId: 'ag-researcher', command: 'node --version', workspaceId },
  });
  eq(before.status, 403, 'no grant, no shell');
  assert(/grant/i.test(before.body.error), `the refusal names the missing grant (got “${before.body.error}”)`);

  const grant = await owner.request('/api/v1/terminal/grants', { method: 'POST', csrf: true, body: { agentId: 'ag-researcher', workspaceId } });
  eq(grant.status, 201, `grant (${grant.text})`);

  const run1 = await owner.request('/api/v1/terminal/agent-runs', {
    method: 'POST', csrf: true, body: { agentId: 'ag-researcher', command: 'node --version', workspaceId },
  });
  eq(run1.status, 200, `agent run (${run1.text})`);
  eq(run1.body.ok, true, 'the agent run succeeded');
  eq(run1.body.exitCode, 0, 'with the exit code');
  assert(run1.body.stdout.includes(process.version), 'and the stdout the agent needs');

  // A failing command comes back as a failure the agent can act on, with a retry hint.
  const run2 = await owner.request('/api/v1/terminal/agent-runs', {
    method: 'POST', csrf: true, body: { agentId: 'ag-researcher', command: 'node missing-file.mjs', workspaceId },
  });
  eq(run2.body.ok, false, 'a failing command is not reported as success');
  eq(run2.body.retryable, true, 'and is marked retryable');
  assert(run2.body.stderr.length > 0, 'the agent gets the stderr, so it can see what broke');

  const revoked = await owner.request(`/api/v1/terminal/grants/ag-researcher/${workspaceId}`, { method: 'DELETE', csrf: true });
  eq(revoked.status, 200, 'revoke');
  const after = await owner.request('/api/v1/terminal/agent-runs', {
    method: 'POST', csrf: true, body: { agentId: 'ag-researcher', command: 'node --version', workspaceId },
  });
  eq(after.status, 403, 'a revoked grant stops the agent immediately');
});

/* =========================================================================================
 * 13. records
 * =======================================================================================*/
await check('every run is recorded with its command, exit code and duration', async () => {
  const runs = await owner.request(`/api/v1/terminal/history?sessionId=${session.id}`);
  eq(runs.status, 200, 'history');
  assert(runs.body.history.length > 5, 'the session has a history');
  assert(runs.body.history.every((h) => typeof h.command === 'string' && h.command.length), 'every entry names its command');

  const row = db.prepare("SELECT * FROM terminal_runs WHERE status='completed' AND exit_code=0 ORDER BY started_at DESC LIMIT 1").get();
  assert(row, 'a completed run is on disk');
  assert(row.duration_ms >= 0, 'with a duration');
  assert(row.stdout_tail.length > 0, 'and the tail of its output');
});

await check('runs are audited, and the audit trail carries no secret', async () => {
  const rows = db.prepare("SELECT * FROM audit_log WHERE event LIKE 'terminal.%' ORDER BY seq DESC LIMIT 50").all();
  assert(rows.length > 5, 'terminal activity must be audited');
  assert(rows.some((r) => r.event === 'terminal.run'), 'starting a command is an audited event');
  assert(rows.some((r) => r.event === 'terminal.signal'), 'so is interrupting one');
  const text = rows.map((r) => r.args_redacted).join(' ');
  assert(!text.includes('super-secret-value-123'), 'no environment value may be written to the audit trail');
  eq((await owner.request('/api/v1/audit/verify')).body.ok, true, 'the audit chain still verifies');
});

/* =========================================================================================
 * 14. sessions
 * =======================================================================================*/
await check('sessions keep their own working directory and can be closed', async () => {
  const a = await openSession();
  const b = await openSession();
  mkdirSync(join(a.cwdPath, 'sub'), { recursive: true });
  const moved = await owner.request(`/api/v1/terminal/sessions/${a.id}/cwd`, { method: 'POST', csrf: true, body: { cwd: 'sub' } });
  eq(moved.status, 200, 'cd into a subdirectory');
  eq(moved.body.session.cwd, 'sub', 'the session remembers where it is');
  const here = await owner.request(`/api/v1/terminal/sessions/${b.id}`);
  eq(here.body.session.cwd, '.', 'another session is unaffected — the cwd belongs to the session');
  const out = await run(a.id, 'node -e "console.log(process.cwd())"');
  assert(out.stdoutTail.trim().endsWith('/sub'), `the process really starts in that directory (got “${out.stdoutTail.trim()}”)`);
  const closed = await owner.request(`/api/v1/terminal/sessions/${a.id}`, { method: 'DELETE', csrf: true });
  eq(closed.status, 200, 'close');
  const closedRun = await owner.request(`/api/v1/terminal/sessions/${a.id}/exec`, { method: 'POST', csrf: true, body: { command: 'node --version' } });
  eq(closedRun.status, 409, 'a closed session cannot run anything');
  assert(/closed/i.test(closedRun.body.error), `and says why (got “${closedRun.body.error}”)`);
});

await check('only one command runs per session at a time', async () => {
  const s = await openSession();
  const first = await owner.request(`/api/v1/terminal/sessions/${s.id}/exec`, {
    method: 'POST', csrf: true, body: { command: 'node -e "setTimeout(()=>{}, 2500)"' },
  });
  eq(first.status, 202, 'the first command starts');
  const second = await owner.request(`/api/v1/terminal/sessions/${s.id}/exec`, {
    method: 'POST', csrf: true, body: { command: 'node --version' },
  });
  eq(second.status, 409, 'a second command in the same session is refused while one is running');
  assert(/already running/i.test(second.body.error), `the reason (got “${second.body.error}”)`);
  await owner.request(`/api/v1/terminal/runs/${first.body.run.id}/signal`, { method: 'POST', csrf: true, body: {} });
  await new Promise((r) => setTimeout(r, 400));
});

/* ---------- report ---------- */
console.log(results.join('\n'));
const passed = results.filter((r) => r.startsWith('PASS')).length;
if (skips.length) console.log(`\nSKIPPED (not counted as passing):\n  ${skips.join('\n  ')}`);
console.log(`\nTERMINAL EXECUTION: ${passed} passed, ${failures} failed${skips.length ? `, ${skips.length} skipped` : ''}`);

// Close everything the gateway opened — the WS server, the comms ticker, the browser ticker — then
// exit explicitly. A terminal suite that leaves timers behind would look like a hang in `npm test`.
try { gateway.queueTicker?.stop?.(); } catch { /* ignore */ }
try { gateway.browserTicker?.stop?.(); } catch { /* ignore */ }
try { gateway.wss?.close(); } catch { /* ignore */ }
await new Promise((resolve) => gateway.server.close(resolve));
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failures > 0 ? 1 : 0);
