/* Gateway identity & access tests — real HTTP/WebSocket against a real gateway process.
 * Run: npm run test:gateway
 * Uses a throwaway DATA_DIR; never touches data/mmm.sqlite.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import WebSocket from 'ws';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'mmm-auth-'));
process.env.DATA_DIR = DATA_DIR;
process.env.MMM_QUIET = '1';
process.env.MMM_BOOTSTRAP_EMAIL = 'owner@test.local';
process.env.MMM_BOOTSTRAP_PASSWORD = 'OwnerPassw0rd!2026';
delete process.env.NODE_ENV; // development semantics, minus the generated-password branch
process.env.NODE_ENV = 'test';

const { createGateway } = await import('../apps/gateway/server.js');
const auth = await import('../apps/gateway/src/auth.js');

const gateway = createGateway();
await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
const PORT = gateway.server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
let failures = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => results.push(`PASS ${name}`))
    .catch((err) => {
      failures += 1;
      results.push(`FAIL ${name}: ${err.message}`);
    });
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

/* ---------- tiny HTTP client with a cookie jar ---------- */
function client(ip = '10.1.0.1') {
  const jar = {};
  return {
    jar,
    async request(path, { method = 'GET', body, headers = {}, csrf = false, cookie } = {}) {
      const h = { 'x-forwarded-for': ip, ...headers };
      const cookieValue = cookie ?? Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookieValue) h.cookie = cookieValue;
      if (csrf && jar[csrfCookieName]) h[auth.CSRF_HEADER] = jar[csrfCookieName];
      if (body !== undefined) h['content-type'] = 'application/json';
      const res = await fetch(BASE + path, {
        method,
        headers: h,
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      const setCookie = res.headers.getSetCookie?.() || [];
      for (const raw of setCookie) {
        const [pair] = raw.split(';');
        const idx = pair.indexOf('=');
        const name = pair.slice(0, idx).trim();
        const value = decodeURIComponent(pair.slice(idx + 1).trim());
        if (value === '' || /Max-Age=0/i.test(raw)) delete jar[name];
        else jar[name] = value;
      }
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, body: json, text, headers: res.headers };
    },
    async login(email, password) {
      const res = await this.request('/api/v1/auth/login', { method: 'POST', body: { email, password } });
      if (res.status === 200) jar[csrfCookieName] = res.body.csrfToken;
      return res;
    },
  };
}
const csrfCookieName = auth.CSRF_HEADER; // csrf token parked alongside cookies for convenience

const owner = client('10.1.0.1');
const observer = client('10.1.0.2');
const operator = client('10.1.0.3');
const reviewer = client('10.1.0.4');
const admin = client('10.1.0.5');
const bot = client('10.1.0.6');

const OWNER_CREDS = { email: 'owner@test.local', password: 'OwnerPassw0rd!2026' };

/* ---------- 1. public health & unauthenticated access ---------- */
await check('health is public and hides operational paths from anonymous callers', async () => {
  const anon = client('10.9.9.9');
  const res = await anon.request('/healthz');
  eq(res.status, 200, 'health status');
  eq(res.body.ok, true, 'health ok flag');
  assert(res.body.auth.mode === 'required', 'auth mode should be required');
  assert(!('dataDir' in res.body), 'anonymous health must not leak dataDir');
  assert(res.headers.get('x-mmm-request-id'), 'request id header missing');
});

await check('every data route rejects anonymous callers with 401', async () => {
  const anon = client('10.9.9.8');
  for (const path of ['/api/v1/agents', '/api/v1/tasks', '/api/v1/approvals', '/api/v1/summary', '/api/v1/audit']) {
    const res = await anon.request(path);
    eq(res.status, 401, `${path} must be 401 for anonymous`);
  }
  const write = await anon.request('/api/v1/agents', { method: 'POST', body: { name: 'x' } });
  eq(write.status, 401, 'anonymous write must be 401');
});

/* ---------- 2. login, session, CSRF ---------- */
await check('login rejects bad credentials and unknown accounts', async () => {
  const c = client('10.9.9.7');
  const wrong = await c.login(OWNER_CREDS.email, 'not-the-password1');
  eq(wrong.status, 401, 'wrong password');
  const unknown = await c.login('ghost@test.local', 'whatever123456');
  eq(unknown.status, 401, 'unknown account');
  assert(!wrong.text.toLowerCase().includes('password'), 'error must not reveal which factor failed');
});

await check('owner login issues a session cookie, permissions and a CSRF token', async () => {
  const res = await owner.login(OWNER_CREDS.email, OWNER_CREDS.password);
  eq(res.status, 200, 'login status');
  eq(res.body.principal.role, 'Owner', 'role');
  assert(res.body.permissions.includes('dev:seed'), 'owner should hold dev:seed');
  assert(res.body.csrfToken && res.body.csrfToken.length > 20, 'csrf token missing');
  const setCookie = res.headers.getSetCookie().join(';');
  assert(/HttpOnly/i.test(setCookie), 'session cookie must be HttpOnly');
  assert(/SameSite=Strict/i.test(setCookie), 'session cookie must be SameSite=Strict');
});

await check('session endpoint reports identity and CSRF token', async () => {
  const res = await owner.request('/api/v1/auth/session');
  eq(res.status, 200, 'session status');
  eq(res.body.principal.via, 'cookie', 'via');
  assert(res.body.permissions.includes('principal:write'), 'owner permission list');
  assert(res.body.csrfToken, 'csrf token should be exposed for the PWA');
});

await check('cookie mutations require the CSRF header', async () => {
  const blocked = await owner.request('/api/v1/agents', { method: 'POST', body: { name: 'CSRF Probe' } });
  eq(blocked.status, 403, 'missing CSRF must be rejected');
  assert(/CSRF/i.test(blocked.text), 'error should mention CSRF');
  const allowedRes = await owner.request('/api/v1/agents', { method: 'POST', body: { name: 'CSRF Probe' }, csrf: true });
  eq(allowedRes.status, 201, 'CSRF-authenticated write should succeed');
});

await check('body parsing rejects invalid JSON and oversized payloads', async () => {
  const badJson = await owner.request('/api/v1/agents', { method: 'POST', body: '{oops', csrf: true, headers: { 'content-type': 'application/json' } });
  eq(badJson.status, 400, 'invalid JSON');
  const big = await owner.request('/api/v1/agents', { method: 'POST', body: JSON.stringify({ name: 'x'.repeat(300000) }), csrf: true });
  eq(big.status, 413, 'oversized body');
});

/* ---------- 3. RBAC per role ---------- */
async function createPrincipalAsOwner(email, role) {
  const res = await owner.request('/api/v1/principals', {
    method: 'POST',
    csrf: true,
    body: { email, password: 'TempPassw0rd!9', name: role + ' User', role },
  });
  eq(res.status, 201, `create ${role} principal (${res.text})`);
  return res.body;
}

await check('owner can create the other four roles', async () => {
  await createPrincipalAsOwner('observer@test.local', 'Observer');
  await createPrincipalAsOwner('operator@test.local', 'Operator');
  await createPrincipalAsOwner('reviewer@test.local', 'Reviewer');
  await createPrincipalAsOwner('admin@test.local', 'Admin');
  const res = await owner.request('/api/v1/principals');
  eq(res.status, 200, 'list principals');
  assert(res.body.length >= 5, 'principals listed');
  assert(!res.text.includes('password_hash'), 'password hashes must never be serialised');
  assert(!res.text.includes('scrypt$'), 'scrypt material must never be serialised');
});

await check('each role logs in and gets exactly its permissions', async () => {
  eq((await observer.login('observer@test.local', 'TempPassw0rd!9')).status, 200, 'observer login');
  eq((await operator.login('operator@test.local', 'TempPassw0rd!9')).status, 200, 'operator login');
  eq((await reviewer.login('reviewer@test.local', 'TempPassw0rd!9')).status, 200, 'reviewer login');
  eq((await admin.login('admin@test.local', 'TempPassw0rd!9')).status, 200, 'admin login');

  const obsSession = await observer.request('/api/v1/auth/session');
  eq(obsSession.body.principal.role, 'Observer', 'observer role');
  assert(!obsSession.body.permissions.includes('agent:write'), 'observer must not hold agent:write');
  const revSession = await reviewer.request('/api/v1/auth/session');
  assert(revSession.body.permissions.includes('approval:decide'), 'reviewer must hold approval:decide');
  assert(!revSession.body.permissions.includes('agent:write'), 'reviewer must not write agents');
  const opSession = await operator.request('/api/v1/auth/session');
  assert(opSession.body.permissions.includes('agent:write'), 'operator must hold agent:write');
  assert(!opSession.body.permissions.includes('approval:decide'), 'operator must not decide approvals');
});

await check('read/write/deny matrix behaves per role', async () => {
  eq((await observer.request('/api/v1/agents')).status, 200, 'observer read agents');
  eq((await observer.request('/api/v1/agents', { method: 'POST', body: { name: 'Observer Agent' }, csrf: true })).status, 403, 'observer write agents');
  eq((await observer.request('/api/v1/audit')).status, 403, 'observer read audit');
  eq((await observer.request('/api/v1/principals')).status, 403, 'observer list principals');

  eq((await operator.request('/api/v1/agents', { method: 'POST', body: { name: 'Operator Agent' }, csrf: true })).status, 201, 'operator write agents');
  eq((await operator.request('/api/v1/tasks', { method: 'POST', body: { title: 'Operator Task' }, csrf: true })).status, 201, 'operator write tasks');
  eq((await operator.request('/api/v1/audit')).status, 403, 'operator read audit');
  eq((await operator.request('/api/v1/principals')).status, 403, 'operator list principals');

  eq((await reviewer.request('/api/v1/audit')).status, 200, 'reviewer read audit');
  eq((await reviewer.request('/api/v1/audit/verify')).body.ok, true, 'reviewer verify chain');
  eq((await reviewer.request('/api/v1/agents', { method: 'POST', body: { name: 'Reviewer Agent' }, csrf: true })).status, 403, 'reviewer write agents');

  eq((await admin.request('/api/v1/principals')).status, 200, 'admin list principals');
  eq((await admin.request('/api/v1/dev/seed', { method: 'POST', body: {}, csrf: true })).status, 403, 'admin seed (owner only)');
});

/* ---------- 4. privilege boundaries ---------- */
await check('admin cannot create an Owner or touch an Owner account', async () => {
  const makeOwner = await admin.request('/api/v1/principals', {
    method: 'POST', csrf: true, body: { email: 'rogue@test.local', password: 'TempPassw0rd!9', role: 'Owner' },
  });
  eq(makeOwner.status, 403, 'admin must not create an Owner');

  const ownerRow = (await admin.request('/api/v1/principals')).body.find((p) => p.role === 'Owner');
  const touchOwner = await admin.request(`/api/v1/principals/${ownerRow.id}`, { method: 'PATCH', body: { status: 'disabled' }, csrf: true });
  eq(touchOwner.status, 403, 'admin must not disable an Owner');
});

await check('nobody can change their own role or status', async () => {
  const adminRow = (await owner.request('/api/v1/principals')).body.find((p) => p.email === 'admin@test.local');
  const selfPromote = await admin.request(`/api/v1/principals/${adminRow.id}`, { method: 'PATCH', body: { role: 'Owner' }, csrf: true });
  eq(selfPromote.status, 403, 'self-promotion must be blocked');
  const selfDisable = await admin.request(`/api/v1/principals/${adminRow.id}`, { method: 'PATCH', body: { status: 'disabled' }, csrf: true });
  eq(selfDisable.status, 403, 'self-disable must be blocked');
});

await check('owner can change a role and the target session dies immediately', async () => {
  const before = await reviewer.request('/api/v1/auth/session');
  eq(before.status, 200, 'reviewer session before');
  const row = (await owner.request('/api/v1/principals')).body.find((p) => p.email === 'reviewer@test.local');
  const res = await owner.request(`/api/v1/principals/${row.id}`, { method: 'PATCH', body: { role: 'Observer' }, csrf: true });
  eq(res.status, 200, 'role change');
  const after = await reviewer.request('/api/v1/auth/session');
  eq(after.status, 401, 'demoted principal must lose their session');
  // restore for later tests, then log in again
  await owner.request(`/api/v1/principals/${row.id}`, { method: 'PATCH', body: { role: 'Reviewer' }, csrf: true });
  eq((await reviewer.login('reviewer@test.local', 'TempPassw0rd!9')).status, 200, 'reviewer re-login');
});

/* ---------- 5. approval separation of duties ---------- */
let reviewerGateId = null;
await check('operators request gates, reviewers decide them, operators cannot', async () => {
  const created = await operator.request('/api/v1/approvals', {
    method: 'POST',
    csrf: true,
    body: { action: 'vercel.deploy', target: 'staging', risk: 'medium', evidence: 'diff +12/-3' },
  });
  eq(created.status, 201, 'operator requests a gate');
  const gateId = created.body.id;

  eq((await operator.request(`/api/v1/approvals/${gateId}/allow`, { method: 'POST', csrf: true })).status, 403, 'operator cannot decide');

  const allowed = await reviewer.request(`/api/v1/approvals/${gateId}/allow`, { method: 'POST', csrf: true });
  eq(allowed.status, 200, 'reviewer decides');
  eq(allowed.body.status, 'allowed', 'gate status');
  eq(allowed.body.decider_id, (await reviewer.request('/api/v1/auth/session')).body.principal.id, 'decider recorded');

  const again = await reviewer.request(`/api/v1/approvals/${gateId}/deny`, { method: 'POST', csrf: true });
  eq(again.status, 409, 'resolved gates are immutable');
});

await check('a reviewer cannot approve the gate they requested', async () => {
  const created = await reviewer.request('/api/v1/approvals', {
    method: 'POST', csrf: true, body: { action: 'db.migrate', target: 'staging', risk: 'high' },
  });
  eq(created.status, 201, 'reviewer requests');
  reviewerGateId = created.body.id;
  const self = await reviewer.request(`/api/v1/approvals/${reviewerGateId}/allow`, { method: 'POST', csrf: true });
  eq(self.status, 403, 'self-approval must be 403');
  assert(/separation of duties/i.test(self.text), 'reason should cite separation of duties');
  const byOperator = await operator.request(`/api/v1/approvals/${reviewerGateId}/allow`, { method: 'POST', csrf: true });
  eq(byOperator.status, 403, 'operator still cannot decide');
  const byOwner = await owner.request(`/api/v1/approvals/${reviewerGateId}/allow`, { method: 'POST', csrf: true });
  eq(byOwner.status, 200, 'a different authorised principal may decide');
});

await check('a principal whose name requested the gate cannot decide it', async () => {
  const created = await owner.request('/api/v1/approvals', {
    method: 'POST', csrf: true, body: { action: 'production.publish', target: 'web', principal: 'Reviewer User' },
  });
  eq(created.status, 201, 'gate created');
  const self = await reviewer.request(`/api/v1/approvals/${created.body.id}/allow`, { method: 'POST', csrf: true });
  eq(self.status, 403, 'requester-name match must block');
});

/* ---------- 6. capability tokens ---------- */
let readOnlyToken = null;
await check('scoped API tokens narrow permissions and cannot exceed the role', async () => {
  const res = await operator.request('/api/v1/tokens', { method: 'POST', csrf: true, body: { name: 'reader', scopes: ['read'] } });
  eq(res.status, 201, 'operator issues read token');
  readOnlyToken = res.body.token;
  assert(readOnlyToken.startsWith('mmm_'), 'token prefix');
  assert(res.body.token !== res.body.id, 'token id and secret must differ');

  const bearer = client('10.2.0.1');
  const read = await bearer.request('/api/v1/agents', { headers: { authorization: `Bearer ${readOnlyToken}` } });
  eq(read.status, 200, 'token read works');
  const write = await bearer.request('/api/v1/agents', { method: 'POST', body: { name: 'Token Agent' }, headers: { authorization: `Bearer ${readOnlyToken}` } });
  eq(write.status, 403, 'scope must block the write');
  assert(/lacks permission|scope/i.test(write.text), 'denial reason');

  const tooWide = await operator.request('/api/v1/tokens', { method: 'POST', csrf: true, body: { scopes: ['dev:seed'] } });
  eq(tooWide.status, 400, 'operator cannot mint an owner-only scope');
  const unknownScope = await operator.request('/api/v1/tokens', { method: 'POST', csrf: true, body: { scopes: ['not:a:permission'] } });
  eq(unknownScope.status, 400, 'unknown scopes rejected');
});

await check('bearer calls skip CSRF but respect revocation and expiry', async () => {
  const bearer = client('10.2.0.2');
  const noCsrf = await bearer.request('/api/v1/tasks', { method: 'POST', body: { title: 'Bearer Task' }, headers: { authorization: `Bearer ${readOnlyToken}` } });
  eq(noCsrf.status, 403, 'scope check still applies (no CSRF needed)');

  const tokens = await operator.request('/api/v1/tokens');
  eq(tokens.status, 200, 'operator lists own tokens');
  const mine = tokens.body.find((t) => t.prefix === readOnlyToken.slice(0, 12));
  assert(mine, 'token listed');
  eq((await operator.request(`/api/v1/tokens/${mine.id}`, { method: 'DELETE', csrf: true })).status, 200, 'revoke token');
  const afterRevoke = await bearer.request('/api/v1/agents', { headers: { authorization: `Bearer ${readOnlyToken}` } });
  eq(afterRevoke.status, 401, 'revoked token must fail');

  const expired = await operator.request('/api/v1/tokens', { method: 'POST', csrf: true, body: { name: 'expired', scopes: ['read'], expiresInDays: -1 } });
  eq(expired.status, 201, 'expired-in-the-past token creation is allowed for testing');
  const expiredUse = await bearer.request('/api/v1/agents', { headers: { authorization: `Bearer ${expired.body.token}` } });
  eq(expiredUse.status, 401, 'expired token must fail');

  const junk = await bearer.request('/api/v1/agents', { headers: { authorization: 'Bearer mmm_not-a-real-token' } });
  eq(junk.status, 401, 'unknown token must fail');
});

await check('a principal cannot revoke another principal’s token without the admin permission', async () => {
  const created = await admin.request('/api/v1/tokens', { method: 'POST', csrf: true, body: { name: 'admin-token', scopes: ['read'] } });
  eq(created.status, 201, 'admin token');
  const other = (await admin.request('/api/v1/tokens')).body.find((t) => t.prefix === created.body.token.slice(0, 12));
  const tryRevoke = await operator.request(`/api/v1/tokens/${other.id}`, { method: 'DELETE', csrf: true });
  eq(tryRevoke.status, 403, 'operator must not revoke admin tokens');
  eq((await admin.request(`/api/v1/tokens/${other.id}`, { method: 'DELETE', csrf: true })).status, 200, 'admin revokes own token');
});

/* ---------- 7. lockout & rate limiting ---------- */
await check('repeated failures lock the account briefly and are audited', async () => {
  const attacker = client('10.3.0.1');
  await createPrincipalAsOwner('lockme@test.local', 'Observer');
  const statuses = [];
  for (let i = 0; i < 6; i += 1) {
    const res = await attacker.login('lockme@test.local', `wrong-password-${i}`);
    statuses.push(res.status);
  }
  assert(statuses.slice(0, 5).every((s) => s === 401), `first five failures are 401 (got ${statuses})`);
  eq(statuses[5], 429, 'sixth attempt is locked');
  const locked = await attacker.login('lockme@test.local', 'TempPassw0rd!9');
  eq(locked.status, 429, 'correct password is refused while locked');
  assert(locked.body.retryAfter > 0, 'retryAfter provided');

  const auditRows = await reviewer.request('/api/v1/audit?limit=200');
  assert(auditRows.body.some((r) => r.event === 'auth.login' && r.policy_decision === 'deny'), 'failed logins must be audited');
});

await check('per-address login flood is rate limited', async () => {
  const flooder = client('10.3.0.2');
  let last = null;
  for (let i = 0; i < 22; i += 1) last = await flooder.login(`flood${i}@test.local`, 'nope-nope-1');
  eq(last.status, 429, 'flood must be throttled');
});

/* ---------- 8. password lifecycle ---------- */
await check('password change revokes other sessions and old passwords stop working', async () => {
  const second = client('10.4.0.1');
  eq((await second.login('operator@test.local', 'TempPassw0rd!9')).status, 200, 'second operator session');
  const change = await operator.request('/api/v1/auth/password', {
    method: 'POST', csrf: true, body: { currentPassword: 'TempPassw0rd!9', newPassword: 'NewPassw0rd!77' },
  });
  eq(change.status, 200, 'password change');
  eq((await second.request('/api/v1/auth/session')).status, 401, 'other session revoked');
  eq((await operator.request('/api/v1/auth/session')).status, 200, 'current session kept');
  const oldPw = await client('10.4.0.2').login('operator@test.local', 'TempPassw0rd!9');
  eq(oldPw.status, 401, 'old password rejected');
  const newPw = await client('10.4.0.3').login('operator@test.local', 'NewPassw0rd!77');
  eq(newPw.status, 200, 'new password works');
  const weak = await operator.request('/api/v1/auth/password', { method: 'POST', csrf: true, body: { currentPassword: 'NewPassw0rd!77', newPassword: 'short' } });
  eq(weak.status, 400, 'weak password rejected');
});

await check('disabled principals lose access immediately', async () => {
  const row = (await owner.request('/api/v1/principals')).body.find((p) => p.email === 'observer@test.local');
  eq((await owner.request(`/api/v1/principals/${row.id}`, { method: 'PATCH', body: { status: 'disabled' }, csrf: true })).status, 200, 'disable');
  eq((await observer.request('/api/v1/agents')).status, 401, 'existing session rejected');
  eq((await client('10.4.1.1').login('observer@test.local', 'TempPassw0rd!9')).status, 403, 'login refused');
});

/* ---------- 9. audit integrity & seed safety ---------- */
await check('audit chain verifies and records denials with actor + via', async () => {
  const verify = await owner.request('/api/v1/audit/verify');
  eq(verify.body.ok, true, 'chain integrity');
  assert(verify.body.count > 20, 'audit has entries');
  const rows = (await owner.request('/api/v1/audit?limit=200')).body;
  const denied = rows.filter((r) => r.policy_decision === 'deny');
  assert(denied.length >= 5, 'denials are audited');
  assert(denied.some((r) => r.event.startsWith('POST') || r.event.startsWith('GET')), 'denied route attempts captured');
  assert(rows.some((r) => r.event === 'approval.allow' && r.actor_via === 'cookie'), 'approval decision attributed');
  assert(!JSON.stringify(rows).includes('OwnerPassw0rd'), 'audit must not contain passwords');
});

await check('seeding never deletes identities or credentials', async () => {
  const before = (await owner.request('/api/v1/principals')).body.length;
  const seeded = await owner.request('/api/v1/dev/seed', { method: 'POST', body: { reset: true }, csrf: true });
  eq(seeded.status, 200, 'owner can seed');
  const after = (await owner.request('/api/v1/principals')).body;
  eq(after.length, before, 'principal count unchanged by reset');
  const me = await owner.request('/api/v1/auth/session');
  eq(me.status, 200, 'owner session survives a reset seed');
});

/* ---------- 10. CORS + WebSocket ---------- */
await check('CORS only echoes allowlisted origins with credentials', async () => {
  const good = await client('10.5.0.1').request('/healthz', { headers: { origin: 'http://localhost:5173' } });
  eq(good.headers.get('access-control-allow-origin'), 'http://localhost:5173', 'allowed origin echoed');
  eq(good.headers.get('access-control-allow-credentials'), 'true', 'credentials allowed for allowlisted origin');
  const bad = await client('10.5.0.2').request('/healthz', { headers: { origin: 'http://evil.example' } });
  eq(bad.headers.get('access-control-allow-origin'), 'null', 'unknown origin must not be reflected');
  assert(!bad.headers.get('access-control-allow-credentials'), 'no credentials header for unknown origin');
});

function rawUpgrade(cookieHeader, origin = null) {
  return new Promise((resolve) => {
    const socket = net.connect(PORT, '127.0.0.1', () => {
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
          (cookieHeader ? `Cookie: ${cookieHeader}\r\n` : '') +
          (origin ? `Origin: ${origin}\r\n` : '') +
          '\r\n'
      );
    });
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\r\n')) {
        resolve(data.split('\r\n')[0]);
        socket.destroy();
      }
    });
    socket.on('error', () => resolve('error'));
    setTimeout(() => {
      resolve(data.split('\r\n')[0] || 'timeout');
      socket.destroy();
    }, 1500);
  });
}

await check('WebSocket requires credentials', async () => {
  const anonymous = await rawUpgrade(null);
  assert(/401/.test(anonymous), `anonymous upgrade must be 401 (got "${anonymous}")`);
  const withCookie = await rawUpgrade(`${auth.SESSION_COOKIE}=${owner.jar[auth.SESSION_COOKIE]}`);
  assert(/101/.test(withCookie), `authenticated upgrade must be 101 (got "${withCookie}")`);
});

await check('WebSocket hello identifies the principal and refuses topics above its role', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, {
    headers: { cookie: `${auth.SESSION_COOKIE}=${operator.jar[auth.SESSION_COOKIE]}` },
  });
  const messages = [];
  await new Promise((resolve, reject) => {
    ws.on('message', (raw) => {
      messages.push(JSON.parse(String(raw)));
      if (messages.length === 1) ws.send(JSON.stringify({ type: 'subscribe', topics: ['agents', 'audit'] }));
      if (messages.length >= 2) resolve();
    });
    ws.on('error', reject);
    setTimeout(() => resolve(), 2000);
  });
  ws.close();
  const hello = messages.find((m) => m.type === 'hello');
  assert(hello, 'hello frame missing');
  eq(hello.principal.role, 'Operator', 'ws principal role');
  const sub = messages.find((m) => m.type === 'subscribed');
  assert(sub, 'subscribe acknowledgement missing');
  assert(sub.topics.includes('agents'), 'agents topic granted');
  assert(sub.refused.includes('audit'), 'audit topic refused for operator');
});

await check('WebSocket rejects a hostile browser origin', async () => {
  const cookie = `${auth.SESSION_COOKIE}=${owner.jar[auth.SESSION_COOKIE]}`;
  assert(/403/.test(await rawUpgrade(cookie, 'http://evil.example')), 'hostile origin denied');
  assert(/101/.test(await rawUpgrade(cookie, 'http://localhost:5173')), 'allowlisted origin accepted');
  assert(/101/.test(await rawUpgrade(cookie, BASE)), 'same origin accepted');
});

await check('revoked WebSocket session cannot receive later broadcasts', async () => {
  const fresh = client('10.8.9.1');
  eq((await fresh.login('operator@test.local', 'NewPassw0rd!77')).status, 200, 'fresh operator session');
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: `${auth.SESSION_COOKIE}=${fresh.jar[auth.SESSION_COOKIE]}` } });
  const seen = [];
  const hello = new Promise((resolve, reject) => { ws.on('message', (raw) => { const msg = JSON.parse(String(raw)); seen.push(msg); if (msg.type === 'hello') resolve(); }); ws.on('error', reject); });
  await hello;
  const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
  eq((await fresh.request('/api/v1/auth/logout', { method: 'POST', body: {}, csrf: true })).status, 200, 'session revoked');
  const created = await owner.request('/api/v1/agents', { method: 'POST', body: { name: 'Revocation broadcast test' }, csrf: true });
  eq(created.status, 201, 'broadcast triggered');
  const code = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve('timeout'), 1500))]);
  eq(code, 4401, 'revoked client closed on broadcast');
  assert(!seen.some((msg) => msg.type === 'agent.created'), 'no event delivered after revocation');
  ws.terminate();
});

/* ---------- finish ---------- */
gateway.server.close();
gateway.wss.close();
rmSync(DATA_DIR, { recursive: true, force: true });

console.log(results.join('\n'));
if (failures) {
  console.error(`\n${failures} gateway auth test(s) failed`);
  process.exit(1);
}
console.log(`\nGATEWAY AUTH + RBAC: ${results.length}/${results.length} PASSED`);
process.exit(0);
