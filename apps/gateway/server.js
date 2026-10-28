/* SwarmOS Gateway — HTTP API + WebSocket event stream (zero external deps)
 * Run:  node apps/gateway/server.js        →  http://localhost:8787
 * Test: npm run test:gateway
 *
 * Identity & access (design spec Layer 1):
 *   • session cookie login (scrypt password hashes, HttpOnly + SameSite=Strict, HMAC CSRF)
 *   • scoped bearer tokens (`swk_…`, hash-at-rest) for CLI / bots / integrations
 *   • RBAC: Owner > Admin > Operator > Reviewer > Observer, enforced per route
 *   • every mutation and every denial is written to the hash-chained audit log
 *   • WebSocket upgrades require credentials and are topic-filtered by role
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { db, migrate, logEvent, audit, verifyAuditChain, DATA_DIR, DB_DRIVER } from './src/db.js';
import { seed } from './src/seed.js';
import * as comms from './src/comms.js';
import * as auth from './src/auth.js';
import {
  can,
  permissionsFor,
  roleMatrix,
  ROLES,
  PERMISSIONS,
  canAssignRole,
  canManagePrincipal,
  canDecideApproval,
} from './src/rbac.js';

const PORT = Number(process.env.PORT || 8787);
const BODY_LIMIT = Number(process.env.SWARMOS_BODY_LIMIT || 256 * 1024);
const API_RATE_LIMIT = Number(process.env.SWARMOS_RATE_LIMIT || 600);

/* ---------- CORS ---------- */
/* Cookies are only sent cross-origin when the response names an explicit origin, so the
 * allowlist must be explicit. Wildcards are intentionally not supported together with credentials. */
const ALLOWED_ORIGINS = String(
  process.env.SWARMOS_CORS_ORIGIN ||
    'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return {};
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return { 'Access-Control-Allow-Origin': 'null', Vary: 'Origin' };
  }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': `Content-Type, Idempotency-Key, Authorization, ${auth.CSRF_HEADER}`,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
    'Access-Control-Expose-Headers': 'x-swarmos-request-id, x-swarmos-auth, Retry-After',
    Vary: 'Origin',
  };
}

function baseHeaders(res, req) {
  const rid = res.getHeader('x-swarmos-request-id') || `req-${randomUUID()}`;
  res.setHeader('x-swarmos-request-id', rid);
  res.setHeader('x-swarmos-auth', auth.authMode().mode);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(corsHeaders(req))) res.setHeader(k, v);
  return rid;
}

function json(res, code, body, extra = {}) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...extra });
  res.end(data);
}

function fail(res, code, error, extra = {}) {
  json(res, code, { error }, extra);
}

/**
 * Read the request body. `raw` is always returned so a signature can be checked over the exact
 * bytes the provider signed. Routes that accept provider payloads (form-encoded webhooks) opt into
 * `allowRaw`, otherwise a non-JSON body is still a 400.
 */
function readBody(req, { allowRaw = false } = {}) {
  return new Promise((resolve) => {
    let raw = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      raw += chunk;
      if (raw.length > BODY_LIMIT) {
        tooLarge = true;
        resolve({ ok: false, status: 413, error: `body exceeds ${BODY_LIMIT} bytes` });
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (!raw) return resolve({ ok: true, body: {}, raw: '' });
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          if (allowRaw) return resolve({ ok: true, body: {}, raw });
          return resolve({ ok: false, status: 400, error: 'body must be a JSON object' });
        }
        resolve({ ok: true, body: parsed, raw });
      } catch {
        if (allowRaw) return resolve({ ok: true, body: {}, raw });
        resolve({ ok: false, status: 400, error: 'invalid JSON body' });
      }
    });
    req.on('error', () => resolve({ ok: false, status: 400, error: 'request stream error' }));
  });
}

/* ---------- outbound fetch (replaceable in tests; never faked in production) ---------- */
let gatewayFetch = (...args) => globalThis.fetch(...args);

/* ---------- route table ---------- */
const routes = [];
/**
 * @param {'GET'|'POST'|'PATCH'|'PUT'|'DELETE'} method
 * @param {RegExp} pattern
 * @param {{permission?:string|null, public?:boolean, mutating?:boolean, event?:string}} meta
 * @param {(ctx:object)=>any} handler
 */
const route = (method, pattern, meta, handler) => routes.push({ method, pattern, meta, handler });

/* ---------- WebSocket fanout ---------- */
const clients = new Set();

function subscriptionFilter(topic, principal) {
  if (topic === 'approvals') return can(principal, 'approval:read');
  if (topic === 'audit') return can(principal, 'audit:read');
  return can(principal, 'read');
}

function currentSocketPrincipal(client) {
  let principal = null;
  try { principal = auth.revalidateContext(client.principal); } catch { /* fail closed */ }
  if (!principal) {
    client.ws.close(4401, 'session expired or revoked');
    return null;
  }
  client.principal = principal;
  return principal;
}

function broadcast(topic, payload) {
  const msg = JSON.stringify({ topic, ...payload, ts: Date.now() });
  for (const c of clients) {
    if (c.ws.readyState !== 1) continue;
    if (!currentSocketPrincipal(c)) continue;
    if (!c.topics.has(topic) && !c.topics.has('*')) continue;
    if (!subscriptionFilter(topic, c.principal)) continue;
    try {
      c.ws.send(msg);
    } catch {
      /* drop broken sockets on the next close event */
    }
  }
}

/* ---------- helpers ---------- */
function hydrateAgent(a) {
  if (!a) return a;
  return {
    ...a,
    tools: safeJson(a.tools, []),
    skills: safeJson(a.skills, []),
    memory: safeJson(a.memory, {}),
    framework_config: safeJson(a.framework_config, {}),
    deleted_at: a.deleted_at ?? null,
  };
}
function hydrateTask(t) {
  if (!t) return t;
  return { ...t, deps: safeJson(t.deps, []), column: t.column_name, desc: t.description };
}
function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/* =========================================================================================
 * Public routes
 * =======================================================================================*/
route('GET', /^\/healthz$/, { public: true, permission: null }, ({ principal }) => ({
  code: 200,
  body: {
    ok: true,
    db: 'sqlite-wal',
    driver: DB_DRIVER,
    uptime: Math.round(process.uptime()),
    auth: { mode: auth.authMode().mode, roles: ROLES },
    // Operational paths stay behind authentication.
    ...(principal && can(principal, 'system:diagnostics') ? { dataDir: DATA_DIR } : {}),
  },
}));

route('POST', /^\/api\/v1\/auth\/login$/, { public: true, permission: null, mutating: true }, async (ctx) => {
  const ip = auth.clientIp(ctx.req);
  const ipLimit = auth.rateLimit(`login:${ip}`, { limit: 20, windowMs: 5 * 60 * 1000 });
  if (!ipLimit.allowed) {
    return { code: 429, body: { error: 'too many login attempts from this address' }, headers: { 'Retry-After': String(ipLimit.retryAfter) } };
  }
  const email = String(ctx.body?.email || '');
  const password = String(ctx.body?.password || '');
  if (!email || !password) return { code: 400, body: { error: 'email and password are required' } };

  const out = auth.login({ email, password, ip, userAgent: ctx.req.headers['user-agent'] || '' });
  if (out.error) {
    logEvent('auth', `Failed login for ${auth.normalizeEmail(email).slice(0, 60)}`, '');
    audit(auth.normalizeEmail(email) || 'unknown', 'login', 'auth.login', { ip }, 'deny', 'denied');
    return { code: out.status, body: { error: out.error, ...(out.retryAfter ? { retryAfter: out.retryAfter } : {}) }, headers: out.retryAfter ? { 'Retry-After': String(out.retryAfter) } : {} };
  }
  audit(out.principal.id, 'login', 'auth.login', { ip }, 'allow', 'ok');
  return {
    code: 200,
    body: {
      principal: out.principal,
      permissions: out.permissions,
      csrfToken: out.session.csrfToken,
      expiresAt: out.session.expiresAt,
      mustChangePassword: Boolean(out.record.must_change_password),
    },
    headers: { 'Set-Cookie': auth.sessionCookie(out.session.token, { secure: auth.wantsSecureCookie(ctx.req) }) },
  };
});

/* =========================================================================================
 * Session & identity
 * =======================================================================================*/
route('GET', /^\/api\/v1\/auth\/session$/, { permission: 'read' }, (ctx) => {
  const cookies = auth.parseCookies(ctx.req.headers.cookie);
  const sessionSecret = cookies[auth.SESSION_COOKIE];
  return {
    code: 200,
    body: {
      principal: ctx.principal,
      permissions: permissionsFor(ctx.principal),
      role: ctx.principal.role,
      mode: auth.authMode().mode,
      csrfToken: ctx.principal.via === 'cookie' && sessionSecret ? auth.csrfFor(sessionSecret) : null,
      token: ctx.principal.tokenId ? { id: ctx.principal.tokenId, scopes: ctx.principal.scopes } : null,
    },
  };
});

route('POST', /^\/api\/v1\/auth\/logout$/, { permission: 'read', mutating: true }, (ctx) => {
  if (ctx.principal.sessionId) {
    auth.revokeSession(ctx.principal.sessionId, 'logout');
    audit(ctx.principal.id, ctx.principal.via, 'auth.logout', { session: ctx.principal.sessionId }, 'allow', 'ok');
  }
  return { code: 200, body: { ok: true }, headers: { 'Set-Cookie': auth.clearSessionCookie() } };
});

route('POST', /^\/api\/v1\/auth\/password$/, { permission: 'read', mutating: true }, (ctx) => {
  const out = auth.changePassword(ctx.principal.id, {
    currentPassword: ctx.body?.currentPassword,
    newPassword: ctx.body?.newPassword,
    keepSessionId: ctx.principal.sessionId,
  });
  audit(ctx.principal.id, ctx.principal.via, 'auth.password.change', {}, out.ok ? 'allow' : 'deny', out.ok ? 'ok' : 'denied');
  if (!out.ok) return { code: out.status, body: { error: out.error } };
  return { code: 200, body: { ok: true, note: 'other sessions were revoked' } };
});

route('GET', /^\/api\/v1\/roles$/, { permission: 'read' }, () => ({
  code: 200,
  body: {
    roles: roleMatrix(),
    permissions: PERMISSIONS,
    hierarchy: ROLES,
    notes: [
      'Roles are not a strict ladder: Operator runs agents but cannot decide gates; Reviewer decides gates but cannot run agents.',
      'Capability tokens narrow a principal with scopes; they never widen it.',
      'Approvals require Reviewer or above and enforce separation of duties.',
      'Role changes revoke the principal’s existing sessions immediately.',
    ],
  },
}));

route('GET', /^\/api\/v1\/principals$/, { permission: 'principal:read' }, () => ({
  code: 200,
  body: db.prepare('SELECT id, type, name, role, status, email, trust, created_at, last_login_at, created_by, must_change_password FROM principals ORDER BY created_at').all()
    .map((p) => ({ ...p, must_change_password: Boolean(p.must_change_password) })),
}));

route('POST', /^\/api\/v1\/principals$/, { permission: 'principal:write', mutating: true }, (ctx) => {
  const role = String(ctx.body?.role || 'Observer');
  if (!canAssignRole(ctx.principal, role)) {
    audit(ctx.principal.id, ctx.principal.via, 'principal.create', { role }, 'deny', 'denied');
    return { code: 403, body: { error: `your role cannot assign "${role}"` } };
  }
  try {
    const principal = auth.createPrincipal({
      email: ctx.body?.email,
      password: ctx.body?.password,
      name: ctx.body?.name,
      role,
      type: ctx.body?.type === 'service' ? 'bot' : 'user',
      actor: ctx.principal,
    });
    logEvent('auth', `Principal ${principal.name} (${principal.role}) created by ${ctx.principal.name}`, principal.id);
    audit(ctx.principal.id, ctx.principal.via, 'principal.create', { id: principal.id, role }, 'allow', 'ok');
    return { code: 201, body: principal };
  } catch (err) {
    audit(ctx.principal.id, ctx.principal.via, 'principal.create', {}, 'deny', 'denied');
    return { code: 400, body: { error: err.message } };
  }
});

route('PATCH', /^\/api\/v1\/principals\/([\w-]+)$/, { permission: 'principal:write', mutating: true }, (ctx) => {
  const target = auth.findPrincipalById(ctx.match[1]);
  if (!target) return { code: 404, body: { error: 'principal not found' } };
  if (!canManagePrincipal(ctx.principal, target)) {
    audit(ctx.principal.id, ctx.principal.via, 'principal.update', { id: target.id }, 'deny', 'denied');
    return { code: 403, body: { error: 'not allowed to modify this principal (self-change and equals are blocked)' } };
  }
  const changes = {};
  try {
    if (ctx.body?.role && ctx.body.role !== target.role) {
      if (!canAssignRole(ctx.principal, ctx.body.role)) {
        return { code: 403, body: { error: `your role cannot assign "${ctx.body.role}"` } };
      }
      auth.setPrincipalRole(target.id, ctx.body.role, ctx.principal);
      changes.role = ctx.body.role;
    }
    if (ctx.body?.status && ctx.body.status !== target.status) {
      if (target.role === 'Owner' && ctx.principal.role !== 'Owner') {
        return { code: 403, body: { error: 'only an Owner can change another Owner’s status' } };
      }
      auth.setPrincipalStatus(target.id, ctx.body.status);
      changes.status = ctx.body.status;
    }
  } catch (err) {
    return { code: 400, body: { error: err.message } };
  }
  if (!Object.keys(changes).length) return { code: 400, body: { error: 'nothing to change' } };
  logEvent('auth', `Principal ${target.name} updated: ${JSON.stringify(changes)}`, target.id);
  audit(ctx.principal.id, ctx.principal.via, 'principal.update', { id: target.id, ...changes }, 'allow', 'ok');
  return { code: 200, body: auth.safePrincipal(auth.findPrincipalById(target.id)) };
});

/* =========================================================================================
 * Capability tokens
 * =======================================================================================*/
route('GET', /^\/api\/v1\/tokens$/, { permission: 'token:issue' }, (ctx) => {
  const all = can(ctx.principal, 'token:revoke:any');
  const tokens = auth.listApiTokens(all ? null : ctx.principal.id);
  return { code: 200, body: all ? tokens : tokens.filter((t) => t.principal_id === ctx.principal.id) };
});

route('POST', /^\/api\/v1\/tokens$/, { permission: 'token:issue', mutating: true }, (ctx) => {
  // A token may only be issued to yourself unless you can manage every token in the workspace.
  const targetId = ctx.body?.principalId && can(ctx.principal, 'token:revoke:any') ? ctx.body.principalId : ctx.principal.id;
  try {
    const created = auth.createApiToken({
      principalId: targetId,
      name: ctx.body?.name || 'api token',
      scopes: ctx.body?.scopes,
      expiresInDays: ctx.body?.expiresInDays,
      createdBy: ctx.principal.id,
    });
    audit(ctx.principal.id, ctx.principal.via, 'token.create', { id: created.id, principal: targetId, scopes: created.scopes }, 'allow', 'ok');
    return {
      code: 201,
      body: {
        id: created.id,
        token: created.token,
        prefix: created.prefix,
        scopes: created.scopes,
        expiresAt: created.expiresAt,
        note: 'Store this token now — only its hash is kept and it will not be shown again.',
      },
    };
  } catch (err) {
    audit(ctx.principal.id, ctx.principal.via, 'token.create', {}, 'deny', 'denied');
    return { code: 400, body: { error: err.message } };
  }
});

route('DELETE', /^\/api\/v1\/tokens\/([\w-]+)$/, { permission: 'token:issue', mutating: true }, (ctx) => {
  const row = db.prepare('SELECT * FROM capability_tokens WHERE id = ?').get(ctx.match[1]);
  if (!row) return { code: 404, body: { error: 'token not found' } };
  const own = row.principal_id === ctx.principal.id;
  if (!own && !can(ctx.principal, 'token:revoke:any')) {
    audit(ctx.principal.id, ctx.principal.via, 'token.revoke', { id: row.id }, 'deny', 'denied');
    return { code: 403, body: { error: 'not allowed to revoke another principal’s token' } };
  }
  auth.revokeApiToken(row.id, ctx.principal.id);
  audit(ctx.principal.id, ctx.principal.via, 'token.revoke', { id: row.id }, 'allow', 'ok');
  return { code: 200, body: { ok: true, id: row.id } };
});

/* =========================================================================================
 * Read / operate surface
 * =======================================================================================*/
route('GET', /^\/api\/v1\/summary$/, { permission: 'summary:read' }, () => {
  const one = (sql) => db.prepare(sql).get().n;
  return {
    code: 200,
    body: {
      agents: one('SELECT COUNT(*) n FROM agents WHERE deleted_at IS NULL'),
      running: one("SELECT COUNT(*) n FROM agents WHERE status='running'"),
      teams: one('SELECT COUNT(*) n FROM teams'),
      swarmsLive: one("SELECT COUNT(*) n FROM swarms WHERE status='live'"),
      tasks: one('SELECT COUNT(*) n FROM tasks'),
      approvalsPending: one("SELECT COUNT(*) n FROM approvals WHERE status='pending'"),
      skillsPending: one("SELECT COUNT(*) n FROM skills WHERE status='pending'"),
      events: one('SELECT COUNT(*) n FROM events'),
      principals: one("SELECT COUNT(*) n FROM principals WHERE status='active'"),
    },
  };
});

route('GET', /^\/api\/v1\/agents$/, { permission: 'read' }, () => ({
  code: 200,
  body: db.prepare('SELECT * FROM agents WHERE deleted_at IS NULL ORDER BY last_active DESC').all().map(hydrateAgent),
}));

route('POST', /^\/api\/v1\/agents$/, { permission: 'agent:write', mutating: true }, (ctx) => {
  const b = ctx.body;
  if (!b?.name || typeof b.name !== 'string' || b.name.length > 120) {
    return { code: 400, body: { error: 'name is required (max 120 chars)' } };
  }
  const id = typeof b.id === 'string' && /^[\w-]{1,64}$/.test(b.id) ? b.id : `ag-${Date.now().toString(36)}`;
  db.prepare(`INSERT INTO agents (id,name,role,framework,model,fallback,status,trust,autonomy,success_rate,cost_today,runs,last_active,tools,skills,prompt,memory,created_by)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, b.name, b.role || '', b.framework || 'LangGraph', b.model || 'anthropic/claude-sonnet-4',
      b.fallback || 'deepseek/deepseek-v3', b.status || 'idle', b.trust ?? 50, b.autonomy ?? 2, 0.85, 0, 0,
      Date.now(), JSON.stringify(b.tools || []), JSON.stringify(b.skills || []), b.prompt || '', '{}', ctx.principal.id);
  const ev = logEvent('agent', `Agent ${b.name} created via API by ${ctx.principal.name}`, id);
  audit(ctx.principal.id, ctx.principal.via, 'agent.create', { id, name: b.name }, 'allow', 'ok');
  broadcast('agents', { type: 'agent.created', entity: id, event: ev });
  return { code: 201, body: hydrateAgent(db.prepare('SELECT * FROM agents WHERE id=?').get(id)) };
});

route('GET', /^\/api\/v1\/agents\/([\w-]+)$/, { permission: 'read' }, (ctx) => {
  const a = db.prepare('SELECT * FROM agents WHERE id=? AND deleted_at IS NULL').get(ctx.match[1]);
  return a ? { code: 200, body: hydrateAgent(a) } : { code: 404, body: { error: 'not found' } };
});

route('PATCH', /^\/api\/v1\/agents\/([\w-]+)$/, { permission: 'agent:write', mutating: true }, (ctx) => {
  const a = db.prepare('SELECT * FROM agents WHERE id=?').get(ctx.match[1]);
  if (!a) return { code: 404, body: { error: 'not found' } };
  const allowed = ['name', 'role', 'framework', 'model', 'fallback', 'status', 'trust', 'autonomy', 'prompt'];
  const fields = allowed.filter((k) => k in ctx.body);
  if (!fields.length) return { code: 400, body: { error: `no updatable fields (${allowed.join(', ')})` } };
  for (const k of fields) db.prepare(`UPDATE agents SET ${k}=? WHERE id=?`).run(ctx.body[k], ctx.match[1]);
  const ev = logEvent('agent', `Agent ${a.name} updated by ${ctx.principal.name}`, ctx.match[1]);
  audit(ctx.principal.id, ctx.principal.via, 'agent.update', { id: ctx.match[1], fields }, 'allow', 'ok');
  broadcast('agents', { type: 'agent.updated', entity: ctx.match[1], event: ev });
  return { code: 200, body: hydrateAgent(db.prepare('SELECT * FROM agents WHERE id=?').get(ctx.match[1])) };
});

route('GET', /^\/api\/v1\/tasks$/, { permission: 'read' }, () => ({
  code: 200,
  body: db.prepare('SELECT * FROM tasks ORDER BY rowid').all().map(hydrateTask),
}));

route('POST', /^\/api\/v1\/tasks$/, { permission: 'task:write', mutating: true }, (ctx) => {
  const b = ctx.body || {};
  if (!b.title || typeof b.title !== 'string') return { code: 400, body: { error: 'title is required' } };
  const id = typeof b.id === 'string' && /^[\w-]{1,64}$/.test(b.id) ? b.id : `tk-${Date.now().toString(36)}`;
  db.prepare('INSERT INTO tasks (id,title,description,column_name,assignee,priority,deps,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, b.title, b.desc || '', b.column || 'todo', b.assignee || null, b.priority || 'med', JSON.stringify(b.deps || []), Date.now());
  const ev = logEvent('task', `Task created: ${b.title} (${ctx.principal.name})`, id);
  audit(ctx.principal.id, ctx.principal.via, 'task.create', { id }, 'allow', 'ok');
  broadcast('tasks', { type: 'task.created', entity: id, event: ev });
  return { code: 201, body: hydrateTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(id)) };
});

route('PATCH', /^\/api\/v1\/tasks\/([\w-]+)$/, { permission: 'task:write', mutating: true }, (ctx) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(ctx.match[1]);
  if (!t) return { code: 404, body: { error: 'not found' } };
  const allowed = ['title', 'description', 'column_name', 'assignee', 'priority'];
  const fields = allowed.filter((k) => k in (ctx.body || {}));
  if (!fields.length) return { code: 400, body: { error: `no updatable fields (${allowed.join(', ')})` } };
  for (const k of fields) db.prepare(`UPDATE tasks SET ${k}=? WHERE id=?`).run(ctx.body[k], ctx.match[1]);
  const ev = logEvent('task', `Task ${t.title} updated by ${ctx.principal.name}`, ctx.match[1]);
  audit(ctx.principal.id, ctx.principal.via, 'task.update', { id: ctx.match[1], fields }, 'allow', 'ok');
  broadcast('tasks', { type: 'task.updated', entity: ctx.match[1], event: ev });
  // Fan-out is enqueue-only: routed channels get a queued row that the retry worker delivers, so a
  // provider outage delays the notice instead of losing it (and never reports a delivery that
  // did not happen).
  try {
    const updated = db.prepare('SELECT * FROM tasks WHERE id=?').get(ctx.match[1]);
    if (updated.column_name === 'done' && ctx.body.column_name === 'done') {
      comms.fanOut({ agentId: updated.assignee || null, text: `Task done: ${updated.title}`, reason: 'task-done', dedupeKey: `task-done:${updated.id}` });
    }
  } catch { /* fan-out is best-effort and must not fail the write */ }
  return { code: 200, body: hydrateTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(ctx.match[1])) };
});

/* ---------- approvals (separation of duties) ---------- */
route('GET', /^\/api\/v1\/approvals$/, { permission: 'approval:read' }, () => ({
  code: 200,
  body: db.prepare('SELECT * FROM approvals ORDER BY created_at DESC').all(),
}));

route('POST', /^\/api\/v1\/approvals$/, { permission: 'approval:request', mutating: true }, (ctx) => {
  const b = ctx.body || {};
  if (!b.action || typeof b.action !== 'string') return { code: 400, body: { error: 'action is required' } };
  const id = typeof b.id === 'string' && /^[\w-]{1,64}$/.test(b.id) ? b.id : `ap-${Date.now().toString(36)}`;
  const risk = ['low', 'medium', 'high'].includes(b.risk) ? b.risk : 'medium';
  db.prepare(`INSERT INTO approvals (id, action, target, risk, principal, evidence, status, created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, b.action, b.target || '', risk, b.principal || ctx.principal.name, b.evidence || '', 'pending', Date.now());
  const ev = logEvent('approval', `Approval requested: ${b.action} · ${b.target || '—'} (${ctx.principal.name})`, id);
  audit(ctx.principal.id, ctx.principal.via, 'approval.request', { id, action: b.action }, 'allow', 'ok');
  broadcast('approvals', { type: 'approval.created', entity: id, event: ev });
  try {
    comms.fanOut({ agentId: b.agentId || null, text: `Approval needed: ${b.action} · ${b.risk} risk`, reason: 'approval-needed', dedupeKey: `approval:${id}` });
  } catch { /* best-effort */ }
  return { code: 201, body: db.prepare('SELECT * FROM approvals WHERE id=?').get(id) };
});

route('POST', /^\/api\/v1\/approvals\/([\w-]+)\/(allow|deny)$/, { permission: 'approval:decide', mutating: true }, (ctx) => {
  const gate = db.prepare('SELECT * FROM approvals WHERE id=?').get(ctx.match[1]);
  if (!gate) return { code: 404, body: { error: 'not found' } };
  if (gate.status !== 'pending') return { code: 409, body: { error: `already ${gate.status}` } };

  const allowed = canDecideApproval(ctx.principal, gate);
  if (!allowed.ok) {
    audit(ctx.principal.id, ctx.principal.via, `approval.${ctx.match[2]}`, { id: gate.id, action: gate.action }, 'deny', 'denied');
    logEvent('approval', `Blocked ${ctx.match[2]} on ${gate.id} by ${ctx.principal.name}: ${allowed.reason}`, gate.id);
    return { code: 403, body: { error: allowed.reason } };
  }
  const status = ctx.match[2] === 'allow' ? 'allowed' : 'denied';
  db.prepare('UPDATE approvals SET status=?, decider_id=?, decided_at=? WHERE id=?').run(status, ctx.principal.id, Date.now(), gate.id);
  const ev = logEvent('approval', `${gate.action} ${status} by ${ctx.principal.name} · ${gate.target}`, gate.id);
  audit(ctx.principal.id, ctx.principal.via, `approval.${ctx.match[2]}`, { id: gate.id, action: gate.action, target: gate.target }, 'allow', 'ok');
  broadcast('approvals', { type: 'approval.resolved', entity: gate.id, event: ev });
  return { code: 200, body: db.prepare('SELECT * FROM approvals WHERE id=?').get(gate.id) };
});

/* =========================================================================================
 * Comms: server-side channels, credentials, delivery, queue
 * =======================================================================================*/
route('GET', /^\/api\/v1\/comms$/, { permission: 'comms:read' }, (ctx) => {
  const out = comms.listChannels();
  return {
    code: 200,
    body: {
      ...out,
      stats: comms.messageStats(),
      recent: comms.listMessages({ limit: 20 }),
      // The browser is told exactly where secrets live, so the panel can say it out loud.
      note: 'Credentials are stored encrypted on this gateway and are never returned to a client.',
      requestedBy: ctx.principal.name,
    },
  };
});

// Settings must be matched before the channel pattern (same method, different resource).
route('PUT', /^\/api\/v1\/comms\/settings$/, { permission: 'comms:write', mutating: true }, (ctx) => {
  const out = comms.saveSettings(ctx.body || {}, ctx.principal.name);
  return { code: out.ok ? 200 : 400, body: out };
});

route('GET', /^\/api\/v1\/comms\/messages$/, { permission: 'comms:read' }, (ctx) => ({
  code: 200,
  body: {
    messages: comms.listMessages({ channel: ctx.query.channel || null, direction: ctx.query.direction || null, limit: ctx.query.limit }),
    stats: comms.messageStats(),
  },
}));

route('PUT', /^\/api\/v1\/comms\/([\w-]+)$/, { permission: 'comms:write', mutating: true }, (ctx) => {
  const out = comms.saveChannel(ctx.match[1], ctx.body || {}, ctx.principal.name);
  if (!out.ok) return { code: out.code || 400, body: out };
  broadcast('comms', { type: 'comms.channel.updated', entity: ctx.match[1] });
  return { code: 200, body: out };
});

route('DELETE', /^\/api\/v1\/comms\/([\w-]+)$/, { permission: 'comms:write', mutating: true }, (ctx) => {
  const out = comms.deleteChannel(ctx.match[1], ctx.principal.name);
  if (!out.ok) return { code: out.code || 400, body: out };
  broadcast('comms', { type: 'comms.channel.cleared', entity: ctx.match[1] });
  return { code: 200, body: out };
});

route('POST', /^\/api\/v1\/comms\/([\w-]+)\/send$/, { permission: 'comms:write', mutating: true }, async (ctx) => {
  const b = ctx.body || {};
  const text = typeof b.text === 'string' ? b.text : '';
  if (!text.trim()) return { code: 400, body: { error: 'text is required' } };
  const out = await comms.sendChannelMessage(ctx.match[1], {
    text,
    title: typeof b.title === 'string' ? b.title : 'SwarmOS',
    actor: ctx.principal.name,
    dedupeKey: typeof b.dedupeKey === 'string' ? b.dedupeKey.slice(0, 120) : null,
    fetchImpl: gatewayFetch,
  });
  audit(ctx.principal.id, ctx.principal.via, 'comms.send', { channel: ctx.match[1], ok: out.ok, reason: out.reason || null }, out.ok ? 'allow' : 'deny', out.ok ? 'ok' : 'failed');
  broadcast('comms', { type: out.ok ? 'comms.sent' : 'comms.failed', entity: ctx.match[1] });
  return { code: out.ok ? 200 : out.code || 502, body: out };
});

route('POST', /^\/api\/v1\/comms\/queue$/, { permission: 'comms:write', mutating: true }, async (ctx) => {
  const out = await comms.processQueue({ fetchImpl: gatewayFetch });
  audit(ctx.principal.id, ctx.principal.via, 'comms.queue.run', out, 'allow', 'ok');
  return { code: 200, body: out };
});

/*
 * Public routes: providers have no session, so authenticity comes from the adapter's signature.
 * Both are CSRF-exempt by construction (`public: true` skips session handling) and are audited.
 */
route('GET', /^\/api\/v1\/comms\/([\w-]+)\/verify$/, { public: true }, async (ctx) => {
  const out = await comms.verifyHandshake(ctx.match[1], { query: ctx.query, headers: ctx.req.headers });
  audit('provider', ctx.match[1], 'comms.verify', { channel: ctx.match[1], ok: out.ok }, out.ok ? 'allow' : 'deny', out.ok ? 'ok' : 'refused');
  if (!out.ok) return { code: out.code, body: { error: out.error } };
  return { code: 200, text: out.challenge };
});

route('POST', /^\/api\/v1\/comms\/([\w-]+)\/inbound$/, { public: true, mutating: true, rawBody: true }, async (ctx) => {
  const headerObj = {};
  for (const [k, v] of Object.entries(ctx.req.headers)) headerObj[k.toLowerCase()] = v;
  const out = await comms.handleInbound(ctx.match[1], {
    headers: headerObj,
    rawBody: ctx.rawBody,
    json: Object.keys(ctx.body || {}).length ? ctx.body : null,
    dedupeKey: typeof headerObj['x-swarmos-delivery'] === 'string' ? headerObj['x-swarmos-delivery'] : null,
  });
  if (!out.ok) return { code: out.code || 400, body: { error: out.error } };
  return { code: 200, body: { ok: true, duplicate: Boolean(out.duplicate), reply: out.reply, delivered: out.delivered, deliveryError: out.deliveryError ?? null } };
});

/* ---------- events / audit ---------- */
route('GET', /^\/api\/v1\/events$/, { permission: 'event:read' }, (ctx) => {
  const since = Number(ctx.query.cursor || 0);
  return {
    code: 200,
    body: db.prepare('SELECT * FROM events WHERE cursor > ? ORDER BY cursor LIMIT 100').all(Number.isFinite(since) ? since : 0),
  };
});

route('GET', /^\/api\/v1\/audit\/verify$/, { permission: 'audit:verify' }, () => ({ code: 200, body: verifyAuditChain() }));

route('GET', /^\/api\/v1\/audit$/, { permission: 'audit:read' }, (ctx) => {
  const limit = Math.min(Number(ctx.query.limit || 50) || 50, 200);
  return {
    code: 200,
    body: db.prepare('SELECT seq, ts, principal_id, actor_via, event, policy_decision, result, args_redacted, hash FROM audit_log ORDER BY seq DESC LIMIT ?').all(limit),
  };
});

route('POST', /^\/api\/v1\/dev\/seed$/, { permission: 'dev:seed', mutating: true }, (ctx) => {
  if (process.env.NODE_ENV === 'production' && process.env.SWARMOS_ALLOW_SEED !== '1') {
    return { code: 403, body: { error: 'seeding is disabled in production (set SWARMOS_ALLOW_SEED=1 to override)' } };
  }
  const counts = seed({ reset: Boolean(ctx.body?.reset || ctx.query.reset === '1') });
  audit(ctx.principal.id, ctx.principal.via, 'dev.seed', { reset: Boolean(ctx.body?.reset) }, 'allow', 'ok');
  broadcast('system', { type: 'system.seeded', payload: counts });
  return { code: 200, body: { ok: true, counts } };
});

/* =========================================================================================
 * Request pipeline
 * =======================================================================================*/
async function handleRequest(req, res) {
  const rid = baseHeaders(res, req);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const query = Object.fromEntries(url.searchParams);

  if (req.method === 'OPTIONS') return json(res, 204, {});

  const requestedPath = url.pathname;
  const routeMatch = routes.find((r) => {
    if (r.method !== req.method) return false;
    return r.pattern.test(requestedPath);
  });
  if (!routeMatch) {
    return json(res, 404, { error: 'not found', requestId: rid, hint: 'GET /healthz or /api/v1/summary with credentials' });
  }

  // Path patterns use capture groups; re-match to get them without global state.
  const match = requestedPath.match(routeMatch.pattern) || [];

  let body = {};
  let rawBody = '';
  if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
    const parsed = await readBody(req, { allowRaw: routeMatch.meta.rawBody === true });
    if (!parsed.ok) return fail(res, parsed.status, parsed.error, { 'x-swarmos-request-id': rid });
    body = parsed.body;
    rawBody = parsed.raw || '';
  }

  const isPublic = routeMatch.meta.public === true;
  let principal = null;
  if (!isPublic) {
    const resolved = auth.authenticate(req);
    if (!resolved.principal) {
      audit('anonymous', 'api', `${req.method} ${requestedPath}`, { path: requestedPath }, 'deny', 'unauthenticated');
      return json(res, 401, { error: resolved.error || 'authentication required', requestId: rid }, {
        'WWW-Authenticate': 'Bearer realm="swarmos"',
      });
    }
    principal = resolved.principal;

    const csrf = auth.csrfProblem(req, { principal });
    if (csrf) {
      audit(principal.id, principal.via, `${req.method} ${requestedPath}`, {}, 'deny', 'csrf-failed');
      return fail(res, 403, `CSRF check failed: ${csrf}`);
    }

    const bucketKey = `api:${principal.id}:${auth.clientIp(req)}`;
    if (!auth.rateLimit(bucketKey, { limit: API_RATE_LIMIT, windowMs: 60000 }).allowed) {
      return json(res, 429, { error: 'rate limit exceeded', requestId: rid }, { 'Retry-After': '60' });
    }

    if (routeMatch.meta.permission && !can(principal, routeMatch.meta.permission)) {
      audit(principal.id, principal.via, `${req.method} ${requestedPath}`, { permission: routeMatch.meta.permission }, 'deny', 'denied');
      return json(res, 403, {
        error: `role "${principal.role}" lacks permission "${routeMatch.meta.permission}"`,
        required: PERMISSIONS[routeMatch.meta.permission],
        requestId: rid,
      });
    }
  } else if (requestedPath === '/healthz') {
    // Health is public but still reports who is asking, when they present valid credentials.
    const resolved = auth.authenticate(req);
    if (resolved.principal) principal = resolved.principal;
  }

  try {
    const out = (await routeMatch.handler({
      req, res, match, query, body, rawBody, principal, requestId: rid,
    })) || { code: 200, body: {} };
    // Providers expect plain text on a verification handshake, not a JSON-encoded string.
    if (out.text !== undefined) {
      res.writeHead(out.code ?? 200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'x-swarmos-request-id': rid,
        ...(out.headers || {}),
      });
      res.end(String(out.text));
      return;
    }
    json(res, out.code ?? 200, out.body ?? {}, { 'x-swarmos-request-id': rid, ...(out.headers || {}) });
  } catch (err) {
    audit(principal?.id || 'anonymous', principal?.via || 'api', `${req.method} ${requestedPath}`, {}, 'allow', 'error');
    json(res, 500, { error: 'internal error', requestId: rid, detail: process.env.SWARMOS_DEBUG === '1' ? err.message : undefined });
  }
}

/* =========================================================================================
 * Server lifecycle
 * =======================================================================================*/
export function createGateway() {
  migrate();
  const bootstrap = auth.bootstrapOwner({ quiet: process.env.SWARMOS_QUIET === '1' });
  const mode = auth.authMode();

  const server = http.createServer(handleRequest);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();

    // Browsers send Origin on WebSocket handshakes; CORS does not protect WS upgrades.
    const origin = req.headers.origin;
    if (origin) {
      let sameOrigin = false;
      try {
        const parsed = new URL(origin);
        sameOrigin = ['http:', 'https:'].includes(parsed.protocol) && parsed.host === req.headers.host && parsed.origin === origin;
      } catch { /* invalid origins are rejected */ }
      if (!sameOrigin && !ALLOWED_ORIGINS.includes(origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return socket.destroy();
      }
    }

    const queryToken = url.searchParams.get('token');
    const synthetic = {
      headers: {
        ...req.headers,
        ...(queryToken ? { authorization: `Bearer ${queryToken}` } : {}),
      },
      socket: req.socket,
      method: 'GET',
    };
    const resolved = auth.authenticate(synthetic);
    if (!resolved.principal) {
      socket.write(`HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nWWW-Authenticate: Bearer realm="swarmos"\r\n\r\n${JSON.stringify({ error: 'authentication required for /ws' })}`);
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client = { ws, principal: resolved.principal, topics: new Set(['*']), msgWindow: [] };
      clients.add(client);
      ws.on('close', () => clients.delete(client));
      ws.on('error', () => clients.delete(client));
      ws.on('message', (raw) => {
        if (!currentSocketPrincipal(client)) return;
        const now = Date.now();
        client.msgWindow = client.msgWindow.filter((t) => now - t < 60000);
        client.msgWindow.push(now);
        if (client.msgWindow.length > 60) {
          ws.close(1008, 'rate limit');
          return;
        }
        let msg = null;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg?.type === 'ping') {
          ws.send(JSON.stringify({ topic: 'system', type: 'pong', ts: Date.now() }));
          return;
        }
        if (msg?.type === 'subscribe' && Array.isArray(msg.topics)) {
          const wanted = msg.topics.filter((t) => typeof t === 'string' && ['agents', 'tasks', 'approvals', 'system', 'audit', '*'].includes(t));
          const refused = wanted.filter((t) => t !== '*' && !subscriptionFilter(t, client.principal));
          client.topics = new Set(wanted.filter((t) => !refused.includes(t)));
          ws.send(JSON.stringify({ topic: 'system', type: 'subscribed', topics: [...client.topics], refused, ts: Date.now() }));
        }
      });
      ws.send(JSON.stringify({
        topic: 'system',
        type: 'hello',
        ts: Date.now(),
        clients: clients.size,
        principal: { id: client.principal.id, role: client.principal.role, via: client.principal.via },
      }));
    });
  });

  // The retry worker is off in tests (SWARMOS_COMMS_DISABLE=1) and unref'd, so it never holds a
  // process open — `processQueue` is driven explicitly instead.
  const queueTicker = comms.startQueueTicker();

  return {
    server,
    wss,
    bootstrap,
    authMode: mode.mode,
    authWarning: mode.warning,
    queueTicker,
    /** Test seam: route provider calls to a local mock instead of the network. */
    setFetch(fn) { gatewayFetch = fn; comms.setServiceFetch(fn); },
  };
}

export async function startGateway({ port = PORT } = {}) {
  const gateway = createGateway();
  await new Promise((resolve, reject) => {
    gateway.server.once('error', reject);
    gateway.server.listen(port, '0.0.0.0', resolve);
  });
  const address = gateway.server.address();
  console.log(
    `SwarmOS gateway → http://localhost:${address.port}  (ws: /ws, data: ${DATA_DIR}, ` +
      `sqlite: ${DB_DRIVER}, auth: ${gateway.authMode})`
  );
  if (gateway.authWarning) console.warn(`auth: ${gateway.authWarning}`);
  if (gateway.authMode === 'dev-open') {
    console.warn('auth: dev-open — anonymous callers are accepted with the SWARMOS_DEV_ROLE role. Never expose this.');
  }
  return gateway;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  startGateway().catch((err) => {
    console.error(`gateway failed to start: ${err.message}`);
    process.exit(1);
  });
}
