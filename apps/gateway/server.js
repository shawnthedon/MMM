/* MMM Gateway — HTTP API + WebSocket event stream (zero external deps)
 * Run:  node apps/gateway/server.js        →  http://localhost:8787
 * Test: npm run test:gateway
 *
 * Identity & access (design spec Layer 1):
 *   • session cookie login (scrypt password hashes, HttpOnly + SameSite=Strict, HMAC CSRF)
 *   • scoped bearer tokens (`mmm_…`, hash-at-rest) for CLI / bots / integrations
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
import { runner as browserRunner, browserCapability, setBrowserBroadcast } from './src/browser/index.js';
import { evolution, setEvolutionBroadcast, ensurePoliciesForAllAgents } from './src/evolution/index.js';
import * as teams from './src/teams.js';
import * as swarms from './src/swarms.js';
import * as models from './src/models.js';
import * as chat from './src/chat.js';
import * as terminal from './src/terminal/index.js';
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
const BODY_LIMIT = Number(process.env.MMM_BODY_LIMIT || 256 * 1024);
const API_RATE_LIMIT = Number(process.env.MMM_RATE_LIMIT || 600);

/* ---------- CORS ---------- */
/* Cookies are only sent cross-origin when the response names an explicit origin, so the
 * allowlist must be explicit. Wildcards are intentionally not supported together with credentials. */
const ALLOWED_ORIGINS = String(
  process.env.MMM_CORS_ORIGIN ||
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
    'Access-Control-Expose-Headers': 'x-mmm-request-id, x-mmm-auth, Retry-After',
    Vary: 'Origin',
  };
}

function baseHeaders(res, req) {
  const rid = res.getHeader('x-mmm-request-id') || `req-${randomUUID()}`;
  res.setHeader('x-mmm-request-id', rid);
  res.setHeader('x-mmm-auth', auth.authMode().mode);
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
  if (topic === 'browser') return can(principal, 'browser:read');
  if (topic === 'evolution') return can(principal, 'evolution:read');
  if (topic === 'chat') return can(principal, 'chat:read');
  if (topic === 'terminal') return can(principal, 'terminal:read');
  if (topic === 'models') return can(principal, 'model:read');
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
    description: a.description || '',
    goal: a.goal || '',
    responsibilities: safeJson(a.responsibilities, []),
    approval_gates: safeJson(a.approval_gates, {}),
    team_id: a.team_id ?? null,
    team_position: Number(a.team_position) || 0,
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
      // No swarm is ever `live`: a plan has no runner. The count that is meaningful is how many plans
      // exist, so the summary says that rather than a number that must always be zero.
      swarms: one('SELECT COUNT(*) n FROM swarms'),
      swarmsExecuted: one('SELECT COUNT(*) n FROM swarms WHERE executed=1'),
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
  const teamId = b.teamId ?? b.team_id ?? null;
  if (teamId) teams.getTeam(teamId); // 404 rather than a dangling foreign key
  const position = Number.isFinite(Number(b.teamPosition ?? b.team_position)) ? Number(b.teamPosition ?? b.team_position) : null;
  db.prepare(`INSERT INTO agents (id,name,role,description,goal,framework,model,fallback,status,trust,autonomy,success_rate,cost_today,runs,last_active,tools,skills,prompt,memory,created_by,team_id,team_position,responsibilities,approval_gates)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, b.name, b.role || '', String(b.description || '').slice(0, 400), String(b.goal || '').slice(0, 600), b.framework || 'LangGraph', b.model || 'anthropic/claude-sonnet-4',
      b.fallback || 'deepseek/deepseek-v3', b.status || 'idle', b.trust ?? 50, b.autonomy ?? 2, 0.85, 0, 0,
      Date.now(), JSON.stringify(b.tools || []), JSON.stringify(b.skills || []), b.prompt || '', '{}', ctx.principal.id,
      teamId, 0, JSON.stringify(Array.isArray(b.responsibilities) ? b.responsibilities : []), JSON.stringify(b.approvalGates || {}));
  if (teamId) teams.assignAgent(id, teamId, position, ctx.principal.id);
  try { evolution.ensurePolicy(id); } catch { /* policy is created lazily on first use */ }
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
  const allowed = ['name', 'role', 'description', 'goal', 'framework', 'model', 'fallback', 'status', 'trust', 'autonomy', 'prompt', 'responsibilities', 'approval_gates'];
  const fields = allowed.filter((k) => k in ctx.body);
  const touchesTeam = 'team_id' in ctx.body || 'teamId' in ctx.body;
  const movesPosition = 'team_position' in ctx.body || 'teamPosition' in ctx.body;
  if (!fields.length && !touchesTeam && !movesPosition) {
    return { code: 400, body: { error: `no updatable fields (${allowed.join(', ')}, team_id, team_position)` } };
  }
  if (fields.includes('name')) {
    const name = String(ctx.body.name ?? '').trim();
    if (!name || name.length > 120) return { code: 400, body: { error: 'name must be 1–120 characters' } };
  }
  try {
    for (const k of fields) {
      let value = ctx.body[k];
      if (k === 'responsibilities') value = JSON.stringify(Array.isArray(value) ? value.map((v) => String(v).slice(0, 300)).slice(0, 40) : []);
      if (k === 'approval_gates') value = JSON.stringify(value && typeof value === 'object' ? value : {});
      if (k === 'description') value = String(value ?? '').slice(0, 400);
      if (k === 'goal') value = String(value ?? '').slice(0, 600);
      db.prepare(`UPDATE agents SET ${k}=? WHERE id=?`).run(value, ctx.match[1]);
    }
    // Membership is deliberately not written directly: assignAgent keeps positions dense, moves the
    // row inside its own transaction and records the change, so two views cannot disagree.
    if (touchesTeam) {
      const teamId = ctx.body.team_id !== undefined ? ctx.body.team_id : ctx.body.teamId;
      const position = ctx.body.team_position ?? ctx.body.teamPosition;
      teams.assignAgent(ctx.match[1], teamId ?? null, position ?? null, ctx.principal.id);
    } else if (movesPosition) {
      teams.moveTo(ctx.match[1], ctx.body.team_position ?? ctx.body.teamPosition);
    }
  } catch (error) {
    const code = error?.code === 'not-found' ? 404 : 400;
    return { code, body: { error: error.message, code: error.code || 'error' } };
  }
  const ev = logEvent('agent', `Agent ${a.name} updated by ${ctx.principal.name}`, ctx.match[1]);
  audit(ctx.principal.id, ctx.principal.via, 'agent.update', { id: ctx.match[1], fields, teamChanged: touchesTeam }, 'allow', 'ok');
  broadcast('agents', { type: 'agent.updated', entity: ctx.match[1], event: ev });
  return { code: 200, body: hydrateAgent(db.prepare('SELECT * FROM agents WHERE id=?').get(ctx.match[1])) };
});

/* ---- Teams: a view over `agents.team_id` (see src/teams.js) ----
 * Teams share the `agents` WebSocket topic on purpose: membership lives on the agent row, so any
 * change to a team is a change to agent rows and the app should re-read both together.
 */
const teamFail = (error) => {
  const code = error?.code || 'error';
  const status = code === 'not-found' ? 404 : code === 'conflict' ? 409 : 400;
  return { code: status, body: { error: error.message, code } };
};

route('GET', /^\/api\/v1\/teams$/, { permission: 'read' }, () => ({ code: 200, body: teams.listTeams() }));

route('GET', /^\/api\/v1\/teams\/([\w-]+)$/, { permission: 'read' }, (ctx) => {
  try {
    return { code: 200, body: teams.getTeam(ctx.match[1]) };
  } catch (error) {
    return teamFail(error);
  }
});

route('POST', /^\/api\/v1\/teams$/, { permission: 'swarm:write', mutating: true }, (ctx) => {
  try {
    const team = teams.createTeam({ ...(ctx.body || {}), principal: ctx.principal.id });
    broadcast('agents', { type: 'team.created', entity: team.id });
    return { code: 201, body: team };
  } catch (error) {
    return teamFail(error);
  }
});

route('PATCH', /^\/api\/v1\/teams\/([\w-]+)$/, { permission: 'swarm:write', mutating: true }, (ctx) => {
  try {
    const team = teams.updateTeam(ctx.match[1], ctx.body || {}, ctx.principal.id);
    broadcast('agents', { type: 'team.updated', entity: team.id });
    return { code: 200, body: team };
  } catch (error) {
    return teamFail(error);
  }
});

/**
 * Delete a team. Its members are unassigned in the same transaction — never deleted, never silently
 * moved — and the response says exactly who lost their team so the caller can report it truthfully.
 */
route('DELETE', /^\/api\/v1\/teams\/([\w-]+)$/, { permission: 'swarm:write', mutating: true }, (ctx) => {
  try {
    const result = teams.deleteTeam(ctx.match[1], ctx.principal.id);
    broadcast('agents', { type: 'team.deleted', entity: ctx.match[1], unassigned: result.unassigned.map((m) => m.id) });
    return { code: 200, body: result };
  } catch (error) {
    return teamFail(error);
  }
});

route('POST', /^\/api\/v1\/teams\/([\w-]+)\/order$/, { permission: 'agent:write', mutating: true }, (ctx) => {
  try {
    const team = teams.reorderTeam(ctx.match[1], ctx.body?.order || [], ctx.principal.id);
    broadcast('agents', { type: 'team.reordered', entity: ctx.match[1] });
    return { code: 200, body: team };
  } catch (error) {
    return teamFail(error);
  }
});

route('POST', /^\/api\/v1\/teams\/([\w-]+)\/members$/, { permission: 'agent:write', mutating: true }, (ctx) => {
  try {
    const agentId = String(ctx.body?.agentId || '');
    if (!agentId) return { code: 400, body: { error: 'agentId is required' } };
    const result = teams.assignAgent(agentId, ctx.match[1], ctx.body?.position ?? null, ctx.principal.id);
    broadcast('agents', { type: 'team.member.added', entity: ctx.match[1], agentId });
    return { code: 200, body: result };
  } catch (error) {
    return teamFail(error);
  }
});

route('DELETE', /^\/api\/v1\/teams\/([\w-]+)\/members\/([\w-]+)$/, { permission: 'agent:write', mutating: true }, (ctx) => {
  try {
    const result = teams.assignAgent(ctx.match[2], null, null, ctx.principal.id);
    broadcast('agents', { type: 'team.member.removed', entity: ctx.match[1], agentId: ctx.match[2] });
    return { code: 200, body: result };
  } catch (error) {
    return teamFail(error);
  }
});

/* ---- Swarms: saved plans, never a running thing (see src/swarms.js) ----
 * Every response carries `runtime`, and every mutation is refused if it would claim execution. The
 * topic is `swarms`, filtered on `read`, so a client that may list plans is told when one changes.
 */
const swarmFail = (error) => {
  const code = error?.code || 'error';
  const status = code === 'not-found' ? 404 : code === 'conflict' ? 409 : 400;
  return { code: status, body: { error: error.message, code } };
};

route('GET', /^\/api\/v1\/swarms$/, { permission: 'read' }, (ctx) => {
  try {
    return { code: 200, body: swarms.listSwarms({ teamId: ctx.query.teamId || null }) };
  } catch (error) {
    return swarmFail(error);
  }
});

route('GET', /^\/api\/v1\/swarms\/([\w-]+)$/, { permission: 'read' }, (ctx) => {
  try {
    return { code: 200, body: { swarm: swarms.getSwarm(ctx.match[1]), runtime: swarms.runtimeStatus() } };
  } catch (error) {
    return swarmFail(error);
  }
});

route('POST', /^\/api\/v1\/swarms$/, { permission: 'swarm:write', mutating: true }, (ctx) => {
  try {
    const swarm = swarms.createSwarm(ctx.body || {}, ctx.principal.id);
    broadcast('swarms', { type: 'swarm.created', entity: swarm.id });
    return { code: 201, body: { swarm } };
  } catch (error) {
    return swarmFail(error);
  }
});

route('PATCH', /^\/api\/v1\/swarms\/([\w-]+)$/, { permission: 'swarm:write', mutating: true }, (ctx) => {
  try {
    const swarm = swarms.updateSwarm(ctx.match[1], ctx.body || {}, ctx.principal.id);
    broadcast('swarms', { type: 'swarm.updated', entity: swarm.id });
    return { code: 200, body: { swarm } };
  } catch (error) {
    return swarmFail(error);
  }
});

/** A status change is a plan decision, not process control: planned ⇄ cancelled, → archived. */
route('POST', /^\/api\/v1\/swarms\/([\w-]+)\/status$/, { permission: 'swarm:write', mutating: true }, (ctx) => {
  try {
    const swarm = swarms.setSwarmStatus(ctx.match[1], ctx.body?.status, ctx.principal.id);
    broadcast('swarms', { type: 'swarm.status', entity: swarm.id, status: swarm.status });
    return { code: 200, body: { swarm } };
  } catch (error) {
    return swarmFail(error);
  }
});

route('DELETE', /^\/api\/v1\/swarms\/([\w-]+)$/, { permission: 'swarm:write', mutating: true }, (ctx) => {
  try {
    const result = swarms.deleteSwarm(ctx.match[1], ctx.principal.id);
    broadcast('swarms', { type: 'swarm.deleted', entity: result.id });
    return { code: 200, body: result };
  } catch (error) {
    return swarmFail(error);
  }
});

/* ---- Model gateway: sealed keys, one adapter, a metered ledger (see src/models.js) ----
 * Reading is `model:read`; spending money is `model:call`; installing or removing a key, and setting the
 * budget, is `model:key` — Owner only. A key is never returned by any route: the read carries a
 * fingerprint and a four-character hint, and nothing else.
 */
const modelFail = (error) => {
  const code = error?.code || 'error';
  const status = code === 'not-found' ? 404
    : code === 'conflict' ? 409
      : code === 'budget-exceeded' ? 402
        : code === 'timeout' ? 504
          : code === 'network' || code === 'bad-gateway' ? 502
            : code === 'provider-error' ? 502
              : 400;
  return { code: status, body: { error: error.message, code } };
};

route('GET', /^\/api\/v1\/providers$/, { permission: 'model:read' }, () => {
  try {
    return { code: 200, body: models.listProviders() };
  } catch (error) {
    return modelFail(error);
  }
});

route('GET', /^\/api\/v1\/providers\/([\w-]+)$/, { permission: 'model:read' }, (ctx) => {
  try {
    return { code: 200, body: { provider: models.getProvider(ctx.match[1]), runtime: models.runtimeStatus() } };
  } catch (error) {
    return modelFail(error);
  }
});

route('PUT', /^\/api\/v1\/providers\/([\w-]+)\/key$/, { permission: 'model:key', mutating: true }, (ctx) => {
  try {
    const provider = models.saveProviderKey(ctx.match[1], ctx.body || {}, ctx.principal.id, ctx.principal.via);
    broadcast('models', { type: 'models.key.set', entity: provider.id, fingerprint: provider.fingerprint });
    return { code: 200, body: { provider } };
  } catch (error) {
    return modelFail(error);
  }
});

route('DELETE', /^\/api\/v1\/providers\/([\w-]+)\/key$/, { permission: 'model:key', mutating: true }, (ctx) => {
  try {
    const out = models.clearProviderKey(ctx.match[1], ctx.principal.id, ctx.principal.via);
    broadcast('models', { type: 'models.key.clear', entity: out.provider.id });
    return { code: 200, body: out };
  } catch (error) {
    return modelFail(error);
  }
});

/** The one route that spends money. Every attempt — allowed, refused or failed — reaches the ledger. */
route('POST', /^\/api\/v1\/providers\/([\w-]+)\/call$/, { permission: 'model:call', mutating: true }, async (ctx) => {
  try {
    const body = ctx.body || {};
    const out = await models.callModel({
      providerId: ctx.match[1],
      model: body.model,
      messages: body.messages,
      purpose: body.purpose,
      maxTokens: body.maxTokens,
      timeoutMs: body.timeoutMs,
      principal: ctx.principal.id,
      via: ctx.principal.via,
    });
    broadcast('models', { type: 'models.call', entity: ctx.match[1], callId: out.callId, costUsd: out.costUsd });
    return { code: 200, body: out };
  } catch (error) {
    return modelFail(error);
  }
});

route('GET', /^\/api\/v1\/usage$/, { permission: 'model:read' }, (ctx) => {
  try {
    return { code: 200, body: models.usageSummary({ days: ctx.query.days }) };
  } catch (error) {
    return modelFail(error);
  }
});

route('GET', /^\/api\/v1\/model-calls$/, { permission: 'model:read' }, (ctx) => {
  try {
    return { code: 200, body: models.recentCalls({ limit: ctx.query.limit }) };
  } catch (error) {
    return modelFail(error);
  }
});

route('PUT', /^\/api\/v1\/budget$/, { permission: 'model:key', mutating: true }, (ctx) => {
  try {
    const budget = models.setBudget(ctx.body || {}, ctx.principal.id);
    broadcast('models', { type: 'models.budget', entity: 'budget' });
    return { code: 200, body: { budget } };
  } catch (error) {
    return modelFail(error);
  }
});

/* ---- Terminal: real processes on the gateway host (see src/terminal/index.js) ----
 * The browser cannot execute anything, so execution lives here. Every route is permissioned, every
 * run is audited, and the destructive set stops at an approval gate rather than a warning.
 */
const terminalFail = (error) => {
  const code = error?.code || 'error';
  const status = code === 'not-found' ? 404
    : code === 'conflict' ? 409
      : code === 'forbidden' ? 403
        : code === 'not-allowed' ? 403
          : code === 'bad-path' ? 400
            : 400;
  return { code: status, body: { error: error.message, code } };
};

route('GET', /^\/api\/v1\/terminal$/, { permission: 'terminal:read' }, () => ({ code: 200, body: terminal.describe() }));

route('GET', /^\/api\/v1\/terminal\/workspaces$/, { permission: 'terminal:read' }, () => ({ code: 200, body: { workspaces: terminal.listWorkspaces() } }));

route('POST', /^\/api\/v1\/terminal\/workspaces$/, { permission: 'terminal:run', mutating: true }, (ctx) => {
  try {
    const b = ctx.body || {};
    const name = String(b.name || '').trim();
    if (!name) return { code: 400, body: { error: 'a workspace needs a name' } };
    // Creating a workspace creates a directory inside a configured root — never at an arbitrary path.
    const workspace = terminal.ensureWorkspace({
      name,
      rootId: b.rootId || null,
      relPath: b.relPath || name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      principal: ctx.principal.id,
    });
    broadcast('terminal', { type: 'terminal.workspace', id: workspace.id });
    return { code: 201, body: { workspace } };
  } catch (error) {
    return terminalFail(error);
  }
});

route('GET', /^\/api\/v1\/terminal\/sessions$/, { permission: 'terminal:read' }, (ctx) => ({
  code: 200,
  body: { sessions: terminal.listSessions({ principal: ctx.principal }) },
}));

route('POST', /^\/api\/v1\/terminal\/sessions$/, { permission: 'terminal:run', mutating: true }, (ctx) => {
  try {
    const session = terminal.createSession({
      principal: ctx.principal,
      workspaceId: ctx.body?.workspaceId || null,
      cwd: ctx.body?.cwd || '.',
      env: ctx.body?.env || {},
    });
    broadcast('terminal', { type: 'terminal.session', id: session.id });
    return { code: 201, body: { session } };
  } catch (error) {
    return terminalFail(error);
  }
});

route('GET', /^\/api\/v1\/terminal\/sessions\/([\w-]+)$/, { permission: 'terminal:read' }, (ctx) => {
  try {
    return { code: 200, body: { session: terminal.getSession(ctx.match[1]) } };
  } catch (error) {
    return terminalFail(error);
  }
});

route('DELETE', /^\/api\/v1\/terminal\/sessions\/([\w-]+)$/, { permission: 'terminal:run', mutating: true }, (ctx) => {
  try {
    const out = terminal.closeSession(ctx.match[1], ctx.principal);
    broadcast('terminal', { type: 'terminal.session.closed', id: ctx.match[1] });
    return { code: 200, body: out };
  } catch (error) {
    return terminalFail(error);
  }
});

route('POST', /^\/api\/v1\/terminal\/sessions\/([\w-]+)\/cwd$/, { permission: 'terminal:run', mutating: true }, (ctx) => {
  try {
    return { code: 200, body: { session: terminal.changeDirectory(ctx.match[1], ctx.body?.cwd || '.', ctx.principal) } };
  } catch (error) {
    return terminalFail(error);
  }
});

route('POST', /^\/api\/v1\/terminal\/sessions\/([\w-]+)\/env$/, { permission: 'terminal:run', mutating: true }, (ctx) => {
  try {
    return { code: 200, body: { session: terminal.setSessionEnv(ctx.match[1], ctx.body?.env || {}, ctx.principal) } };
  } catch (error) {
    return terminalFail(error);
  }
});

/** Run a command. 202 for a started run, 200 when it was refused or is waiting for approval. */
route('POST', /^\/api\/v1\/terminal\/sessions\/([\w-]+)\/exec$/, { permission: 'terminal:run', mutating: true }, (ctx) => {
  try {
    const command = String(ctx.body?.command || ctx.body?.line || '').trim();
    if (!command) return { code: 400, body: { error: 'a command is required' } };
    const out = terminal.runCommand(ctx.match[1], command, { principal: ctx.principal, timeoutMs: ctx.body?.timeoutMs ?? null });
    return { code: out.refused ? 200 : out.run.status === 'awaiting_approval' ? 202 : 202, body: out };
  } catch (error) {
    return terminalFail(error);
  }
});

route('GET', /^\/api\/v1\/terminal\/runs\/([\w-]+)$/, { permission: 'terminal:read' }, (ctx) => {
  try {
    return { code: 200, body: { run: terminal.getRun(ctx.match[1]) } };
  } catch (error) {
    return terminalFail(error);
  }
});

route('GET', /^\/api\/v1\/terminal\/runs\/([\w-]+)\/output$/, { permission: 'terminal:read' }, (ctx) => {
  try {
    return { code: 200, body: terminal.runOutput(ctx.match[1], { since: Number(ctx.query.since || 0) }) };
  } catch (error) {
    return terminalFail(error);
  }
});

/**
 * Server-sent events. The route takes the response over (`handled: true`), replays everything after
 * `?since=` from the in-memory buffer, then streams as the child writes. When the run ends it emits a
 * final `exit` event and closes, so a client never sits on a promise that will not resolve.
 */
route('GET', /^\/api\/v1\/terminal\/runs\/([\w-]+)\/stream$/, { permission: 'terminal:read' }, (ctx) => {
  const runId = ctx.match[1];
  const res = ctx.res;
  let run;
  try {
    run = terminal.getRun(runId);
  } catch (error) {
    return terminalFail(error);
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
  };
  send('run', run);

  const since = Number(ctx.query.since || 0);
  const replay = terminal.runOutput(runId, { since });
  for (const chunk of replay.chunks) send('chunk', chunk);
  if (replay.replay === 'tail') {
    if (replay.stdout) send('chunk', { seq: 1, stream: 'out', text: replay.stdout, ts: Date.now() });
    if (replay.stderr) send('chunk', { seq: 2, stream: 'err', text: replay.stderr, ts: Date.now() });
    send('exit', { status: run.status, code: run.exitCode, signal: run.signal, replay: 'tail' });
    res.end();
    return { handled: true };
  }

  const unsubscribe = terminal.subscribeRun(runId, (chunk) => {
    if (chunk.stream === 'exit') {
      send('exit', { status: chunk.status, code: chunk.code, signal: chunk.signal });
      cleanup();
      try { res.end(); } catch { /* ignore */ }
      return;
    }
    send('chunk', chunk);
  });
  if (!unsubscribe) {
    send('exit', { status: run.status, code: run.exitCode, signal: run.signal, replay: 'tail' });
    res.end();
    return { handled: true };
  }
  const heartbeat = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch { /* ignore */ } }, 15000);
  heartbeat.unref?.();
  function cleanup() {
    clearInterval(heartbeat);
    try { unsubscribe(); } catch { /* ignore */ }
  }
  ctx.req.on('close', cleanup);
  return { handled: true };
});

route('POST', /^\/api\/v1\/terminal\/runs\/([\w-]+)\/input$/, { permission: 'terminal:run', mutating: true }, (ctx) => {
  try {
    return { code: 200, body: terminal.sendInput(ctx.match[1], ctx.body?.text ?? '') };
  } catch (error) {
    return terminalFail(error);
  }
});

/** Ctrl+C. SIGINT goes to the process group, so npm's own children die with it. */
route('POST', /^\/api\/v1\/terminal\/runs\/([\w-]+)\/signal$/, { permission: 'terminal:signal', mutating: true }, (ctx) => {
  try {
    const signal = String(ctx.body?.signal || 'SIGINT').toUpperCase();
    return { code: 200, body: terminal.signalRun(ctx.match[1], signal, { principal: ctx.principal }) };
  } catch (error) {
    return terminalFail(error);
  }
});

route('GET', /^\/api\/v1\/terminal\/history$/, { permission: 'terminal:read' }, (ctx) => ({
  code: 200,
  body: { history: terminal.history({ sessionId: ctx.query.sessionId || null, principal: ctx.principal, limit: 100 }) },
}));

route('GET', /^\/api\/v1\/terminal\/scripts$/, { permission: 'terminal:read' }, (ctx) => {
  try {
    const sessionId = ctx.query.sessionId;
    if (!sessionId) return { code: 400, body: { error: 'sessionId is required' } };
    const session = terminal.getSession(sessionId);
    return { code: 200, body: { cwd: session.cwd, project: session.project, ...terminal.listScripts(session.cwdPath) } };
  } catch (error) {
    return terminalFail(error);
  }
});

/** Agent grants: an Owner says which agent may run in which workspace. Nothing is implicit. */
route('GET', /^\/api\/v1\/terminal\/grants$/, { permission: 'terminal:read' }, () => ({ code: 200, body: { grants: terminal.listGrants() } }));

route('POST', /^\/api\/v1\/terminal\/grants$/, { permission: 'terminal:grant', mutating: true }, (ctx) => {
  try {
    const grants = terminal.grantAgent({ agentId: ctx.body?.agentId, workspaceId: ctx.body?.workspaceId, grantedBy: ctx.principal.id });
    broadcast('terminal', { type: 'terminal.grant' });
    return { code: 201, body: { grants } };
  } catch (error) {
    return terminalFail(error);
  }
});

route('DELETE', /^\/api\/v1\/terminal\/grants\/([\w-]+)\/([\w-]+)$/, { permission: 'terminal:grant', mutating: true }, (ctx) => {
  const grants = terminal.revokeAgent({ agentId: ctx.match[1], workspaceId: ctx.match[2], revokedBy: ctx.principal.id });
  return { code: 200, body: { grants } };
});

/**
 * What an agent calls. Same policy, same approval gate, but it waits and hands back the result so the
 * agent can read stderr and retry instead of guessing.
 */
route('POST', /^\/api\/v1\/terminal\/agent-runs$/, { permission: 'terminal:run', mutating: true }, async (ctx) => {
  try {
    const agentId = String(ctx.body?.agentId || '');
    const command = String(ctx.body?.command || '').trim();
    if (!agentId || !command) return { code: 400, body: { error: 'agentId and command are required' } };
    const result = await terminal.runForAgent({
      agentId,
      command,
      workspaceId: ctx.body?.workspaceId || null,
      cwd: ctx.body?.cwd || '.',
      timeoutMs: ctx.body?.timeoutMs ?? null,
      principal: ctx.principal,
    });
    return { code: 200, body: result };
  } catch (error) {
    return terminalFail(error);
  }
});

/* ---- Chat: a transcript store (see src/chat.js) ----
 * No route here generates a reply. Every read carries `runtime: { configured: false }` so the screen
 * cannot show a conversation as if an agent had answered.
 */
const chatFail = (error) => {
  const code = error?.code || 'error';
  const status = code === 'not-found' ? 404 : code === 'conflict' ? 409 : 400;
  return { code: status, body: { error: error.message, code } };
};

route('GET', /^\/api\/v1\/threads$/, { permission: 'chat:read' }, () => ({ code: 200, body: chat.listThreads() }));

route('GET', /^\/api\/v1\/threads\/([\w-]+)$/, { permission: 'chat:read' }, (ctx) => {
  try {
    return { code: 200, body: chat.getThread(ctx.match[1]) };
  } catch (error) {
    return chatFail(error);
  }
});

route('POST', /^\/api\/v1\/threads$/, { permission: 'chat:write', mutating: true }, (ctx) => {
  try {
    const thread = chat.createThread({ ...(ctx.body || {}), principal: ctx.principal.id });
    broadcast('chat', { type: 'thread.created', entity: thread.id });
    return { code: 201, body: { thread, runtime: chat.runtimeStatus() } };
  } catch (error) {
    return chatFail(error);
  }
});

/**
 * Append a message. `from` is decided here, not by the caller: a request body cannot claim an agent
 * spoke, because no runtime is attached to answer. The reply to this route never contains one.
 */
route('POST', /^\/api\/v1\/threads\/([\w-]+)\/messages$/, { permission: 'chat:write', mutating: true }, (ctx) => {
  try {
    const out = chat.appendMessage(ctx.match[1], {
      text: ctx.body?.text,
      from: ctx.body?.from ?? 'me',
      kind: ctx.body?.kind ?? 'text',
      payload: ctx.body?.payload ?? {},
      clientId: ctx.body?.clientId ?? '',
      principal: ctx.principal.id,
    });
    // A duplicate key is not a second message: report it, and do not broadcast a "new" one.
    if (out.duplicate) return { code: 200, body: out };
    broadcast('chat', { type: 'thread.message', entity: ctx.match[1], messageId: out.message.id });
    return { code: 201, body: out };
  } catch (error) {
    return chatFail(error);
  }
});

route('POST', /^\/api\/v1\/threads\/([\w-]+)\/read$/, { permission: 'chat:write', mutating: true }, (ctx) => {
  try {
    const out = chat.markRead(ctx.match[1], ctx.principal.id);
    if (out.cleared) broadcast('chat', { type: 'thread.read', entity: ctx.match[1] });
    return { code: 200, body: out };
  } catch (error) {
    return chatFail(error);
  }
});

route('DELETE', /^\/api\/v1\/threads\/([\w-]+)$/, { permission: 'chat:write', mutating: true }, (ctx) => {
  try {
    const out = chat.deleteThread(ctx.match[1], ctx.principal.id);
    broadcast('chat', { type: 'thread.deleted', entity: ctx.match[1] });
    return { code: 200, body: out };
  } catch (error) {
    return chatFail(error);
  }
});

/**
 * Soft-delete an agent. The row is kept (deleted_at) so audit, experiments and history stay readable;
 * the agent loses its team in the same transaction, and anything that referenced it keeps its text.
 */
route('DELETE', /^\/api\/v1\/agents\/([\w-]+)$/, { permission: 'agent:write', mutating: true }, (ctx) => {
  const a = db.prepare('SELECT * FROM agents WHERE id=? AND deleted_at IS NULL').get(ctx.match[1]);
  if (!a) return { code: 404, body: { error: 'not found' } };
  const team = a.team_id ? db.prepare('SELECT name FROM teams WHERE id=?').get(a.team_id) : null;
  db.transaction(() => {
    db.prepare('UPDATE agents SET deleted_at=?, team_id=NULL, team_position=0 WHERE id=?').run(Date.now(), ctx.match[1]);
  })();
  const ev = logEvent('agent', `Agent ${a.name} deleted by ${ctx.principal.name} (soft delete, kept for audit)`, ctx.match[1]);
  audit(ctx.principal.id, ctx.principal.via, 'agent.delete', { id: ctx.match[1], name: a.name, team: a.team_id }, 'allow', 'ok');
  broadcast('agents', { type: 'agent.deleted', entity: ctx.match[1], event: ev });
  return {
    code: 200,
    body: {
      id: ctx.match[1],
      name: a.name,
      softDeleted: true,
      unassignedFrom: team ? team.name : null,
      summary: `Agent ${a.name} removed from the workspace. The row is kept for audit and experiments; it was also unassigned from ${team ? team.name : 'no team'}.`,
    },
  };
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
  // A terminal run that was waiting on this gate starts now — by the decider's decision, not by a
  // timer. A denied gate leaves the run parked, and the screen says so.
  if (gate.action === 'terminal.run') {
    try {
      if (status === 'allowed') terminal.startApprovedRun(gate.id, { principal: ctx.principal });
      else terminal.cancelApproval(gate.id, { principal: ctx.principal });
    } catch { /* the run stays awaiting_approval rather than silently disappearing */ }
  }
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
    title: typeof b.title === 'string' ? b.title : 'MMM',
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
    dedupeKey: typeof headerObj['x-mmm-delivery'] === 'string' ? headerObj['x-mmm-delivery'] : null,
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

/* =========================================================================================
 * Self-modification — the improvement cycle, its gates and its evidence
 * =======================================================================================*/
const evo = (fn) => async (ctx) => {
  try {
    return { code: 200, body: await fn(ctx) };
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : '';
    const status = code === 'not-found' ? 404
      : code === 'protected' ? 403
        : ['self-review', 'self-approval', 'level', 'disabled', 'quota', 'approval-required', 'blocked', 'wrong-stage', 'terminal'].includes(code) ? 409
          : code === 'bad-path' ? 400
            : 400;
    if (code === 'level' || code === 'self-approval' || code === 'self-review' || code === 'protected') {
      audit(ctx.principal.id, ctx.principal.via, 'evolution.denied', { path: ctx.req.url, reason: code }, 'deny', 'denied');
    }
    return { code: status, body: { error: error.message, code: code || 'error', ...(error.refused ? { refused: error.refused } : {}) } };
  }
};

route('GET', /^\/api\/v1\/evolution\/capabilities$/, { permission: 'evolution:read' }, async () => ({ code: 200, body: evolution.capabilities() }));

route('GET', /^\/api\/v1\/evolution\/agents$/, { permission: 'evolution:read' }, evo(() => ({ agents: evolution.listAgents() })));

route('GET', /^\/api\/v1\/evolution\/agents\/([\w-]+)\/policy$/, { permission: 'evolution:read' }, evo((ctx) => evolution.ensurePolicy(ctx.match[1])));

route('PATCH', /^\/api\/v1\/evolution\/agents\/([\w-]+)\/policy$/, { permission: 'evolution:policy', mutating: true }, evo((ctx) => {
  const out = evolution.setPolicy(ctx.match[1], ctx.body || {}, ctx.principal.id);
  return out;
}));

route('GET', /^\/api\/v1\/evolution\/agents\/([\w-]+)\/grants$/, { permission: 'evolution:read' }, evo((ctx) => ({ grants: evolution.grantsFor(ctx.match[1]) })));

route('POST', /^\/api\/v1\/evolution\/grants$/, { permission: 'evolution:policy', mutating: true }, evo((ctx) => {
  const grant = evolution.createGrant({
    agentId: ctx.body?.agentId,
    ownerAgentId: ctx.body?.ownerAgentId || '*',
    scope: ctx.body?.scope || [],
    reason: ctx.body?.reason || '',
    expiresAt: ctx.body?.expiresAt || null,
  }, ctx.principal.id);
  return grant;
}));

route('DELETE', /^\/api\/v1\/evolution\/grants\/([\w-]+)$/, { permission: 'evolution:policy', mutating: true }, evo((ctx) => evolution.revokeGrant(ctx.match[1], ctx.principal.id)));

route('GET', /^\/api\/v1\/evolution\/agents\/([\w-]+)\/observations$/, { permission: 'evolution:read' }, evo((ctx) => ({ observations: evolution.listObservations(ctx.match[1]) })));

route('POST', /^\/api\/v1\/evolution\/agents\/([\w-]+)\/observations$/, { permission: 'evolution:run', mutating: true }, evo((ctx) => {
  const out = evolution.recordObservation(ctx.match[1], {
    source: ctx.body?.source,
    kind: ctx.body?.kind || '',
    detail: ctx.body?.detail,
    evidence: ctx.body?.evidence || {},
    measured: ctx.body?.measured !== false,
  }, ctx.principal.id);
  broadcast('evolution', { type: 'observation.recorded', agentId: ctx.match[1], id: out.id });
  return out;
}));

route('GET', /^\/api\/v1\/evolution\/agents\/([\w-]+)\/versions$/, { permission: 'evolution:read' }, evo((ctx) => ({
  versions: evolution.listVersions(ctx.match[1]),
  active: evolution.activeVersion(ctx.match[1]),
})));

route('POST', /^\/api\/v1\/evolution\/agents\/([\w-]+)\/health$/, { permission: 'evolution:run', mutating: true }, evo((ctx) =>
  evolution.healthCheck(ctx.match[1], { actor: ctx.principal.id })));

route('POST', /^\/api\/v1\/evolution\/agents\/([\w-]+)\/rollback$/, { permission: 'evolution:deploy', mutating: true }, evo((ctx) =>
  evolution.rollback(ctx.match[1], { actor: ctx.principal.id, reason: ctx.body?.reason || '' })));

route('GET', /^\/api\/v1\/evolution\/experiments$/, { permission: 'evolution:read' }, (ctx) => ({
  code: 200,
  body: { experiments: evolution.listExperiments({ agentId: ctx.query.agentId || '', limit: Number(ctx.query.limit) || 40 }) },
}));

route('POST', /^\/api\/v1\/evolution\/experiments$/, { permission: 'evolution:run', mutating: true }, evo((ctx) => evolution.createExperiment({
  agentId: ctx.body?.agentId,
  title: ctx.body?.title,
  problem: ctx.body?.problem,
  objective: ctx.body?.objective || '',
  observationIds: ctx.body?.observationIds || [],
  files: ctx.body?.files || [],
  plan: ctx.body?.plan || {},
  actor: ctx.principal.id,
})));

route('GET', /^\/api\/v1\/evolution\/experiments\/([\w-]+)$/, { permission: 'evolution:read' }, (ctx) => {
  const experiment = evolution.getExperiment(ctx.match[1]);
  return experiment ? { code: 200, body: experiment } : { code: 404, body: { error: 'not found' } };
});

route('GET', /^\/api\/v1\/evolution\/experiments\/([\w-]+)\/file$/, { permission: 'evolution:read' }, evo((ctx) =>
  evolution.readFileForReview(ctx.match[1], ctx.query.path || '')));

route('POST', /^\/api\/v1\/evolution\/experiments\/([\w-]+)\/diagnose$/, { permission: 'evolution:run', mutating: true }, evo((ctx) =>
  evolution.diagnose(ctx.match[1], ctx.body || {}, ctx.principal.id)));

route('POST', /^\/api\/v1\/evolution\/experiments\/([\w-]+)\/plan$/, { permission: 'evolution:run', mutating: true }, evo((ctx) =>
  evolution.planExperiment(ctx.match[1], ctx.body || {}, ctx.principal.id)));

route('POST', /^\/api\/v1\/evolution\/experiments\/([\w-]+)\/workspace$/, { permission: 'evolution:run', mutating: true }, evo((ctx) =>
  evolution.createWorkingCopy(ctx.match[1], ctx.principal.id)));

route('POST', /^\/api\/v1\/evolution\/experiments\/([\w-]+)\/edit$/, { permission: 'evolution:run', mutating: true }, evo((ctx) =>
  evolution.editFile(ctx.match[1], { path: ctx.body?.path, content: ctx.body?.content, reason: ctx.body?.reason }, ctx.principal.id)));

route('POST', /^\/api\/v1\/evolution\/experiments\/([\w-]+)\/delete-file$/, { permission: 'evolution:run', mutating: true }, evo((ctx) =>
  evolution.deleteFile(ctx.match[1], { path: ctx.body?.path, reason: ctx.body?.reason }, ctx.principal.id)));

route('POST', /^\/api\/v1\/evolution\/experiments\/([\w-]+)\/test$/, { permission: 'evolution:run', mutating: true }, evo((ctx) =>
  evolution.testExperiment(ctx.match[1], { command: ctx.body?.command, actor: ctx.principal.id })));

route('POST', /^\/api\/v1\/evolution\/experiments\/([\w-]+)\/review$/, { permission: 'evolution:review', mutating: true }, evo((ctx) =>
  evolution.reviewExperiment(ctx.match[1], {
    reviewer: ctx.body?.reviewer,
    reviewerKind: ctx.body?.reviewerKind || 'agent',
    verdict: ctx.body?.verdict,
    findings: ctx.body?.findings || [],
  }, ctx.principal.id)));

route('POST', /^\/api\/v1\/evolution\/experiments\/([\w-]+)\/compare$/, { permission: 'evolution:run', mutating: true }, evo((ctx) =>
  evolution.compareExperiment(ctx.match[1], ctx.principal.id)));

route('POST', /^\/api\/v1\/evolution\/experiments\/([\w-]+)\/request-approval$/, { permission: 'evolution:run', mutating: true }, evo((ctx) =>
  evolution.requestApproval(ctx.match[1], { actor: ctx.principal.id, note: ctx.body?.note || '' })));

route('POST', /^\/api\/v1\/evolution\/experiments\/([\w-]+)\/approve$/, { permission: 'evolution:approve', mutating: true }, evo((ctx) =>
  evolution.approve(ctx.match[1], { decision: ctx.body?.decision, note: ctx.body?.note || '', principal: ctx.principal.id }, ctx.principal.id)));

route('POST', /^\/api\/v1\/evolution\/experiments\/([\w-]+)\/stage$/, { permission: 'evolution:run', mutating: true }, evo((ctx) =>
  evolution.promote(ctx.match[1], { target: 'stage', actor: ctx.principal.id })));

route('POST', /^\/api\/v1\/evolution\/experiments\/([\w-]+)\/deploy$/, { permission: 'evolution:deploy', mutating: true }, evo((ctx) =>
  evolution.promote(ctx.match[1], { target: 'deploy', actor: ctx.principal.id })));

route('POST', /^\/api\/v1\/evolution\/experiments\/([\w-]+)\/cancel$/, { permission: 'evolution:run', mutating: true }, evo((ctx) =>
  evolution.cancel(ctx.match[1], ctx.principal.id, ctx.body?.reason || '')));

/* =========================================================================================
 * Agent Browser — long-running autonomous browsing with a watchdog and evidence
 * =======================================================================================*/
route('GET', /^\/api\/v1\/browser\/capabilities$/, { permission: 'browser:read' }, async () => ({
  code: 200,
  body: await browserCapability(),
}));

route('GET', /^\/api\/v1\/browser\/tasks$/, { permission: 'browser:read' }, (ctx) => ({
  code: 200,
  body: { tasks: browserRunner.listTasks(Number(ctx.query.limit) || 50) },
}));

route('POST', /^\/api\/v1\/browser\/tasks$/, { permission: 'browser:run', mutating: true }, async (ctx) => {
  const limit = auth.rateLimit(`browser:create:${ctx.principal.id}`, { limit: 20, windowMs: 60 * 1000 });
  if (!limit.allowed) return { code: 429, body: { error: 'too many tasks created; wait a moment' }, headers: { 'Retry-After': String(limit.retryAfter) } };
  try {
    const task = await browserRunner.createTask({
      ownerId: ctx.principal.id,
      objective: ctx.body?.objective,
      criteria: ctx.body?.successCriteria,
      plan: ctx.body?.plan,
      entryUrl: ctx.body?.entryUrl,
      sim: ctx.body?.sim,
      driver: ctx.body?.driver,
      deadlineMs: ctx.body?.deadlineMs,
    });
    audit(ctx.principal.id, ctx.principal.via, 'browser.task.create', { taskId: task.id, steps: task.plan.length }, 'allow', 'ok');
    return { code: 201, body: { task } };
  } catch (error) {
    if (error.code === 'no-engine') return { code: 409, body: { error: error.message, hint: 'Install a browser engine on the gateway host — see GET /api/v1/browser/capabilities' } };
    return { code: 400, body: { error: String(error.message || error) } };
  }
});

route('GET', /^\/api\/v1\/browser\/tasks\/([\w-]+)$/, { permission: 'browser:read' }, (ctx) => {
  const detail = browserRunner.getTaskDetail(ctx.match[1]);
  if (!detail) return { code: 404, body: { error: 'task not found' } };
  return { code: 200, body: detail };
});

route('POST', /^\/api\/v1\/browser\/tasks\/([\w-]+)\/(pause|resume|stop|assist)$/, { permission: 'browser:run', mutating: true }, (ctx) => {
  const out = browserRunner.control(ctx.match[1], ctx.match[2], ctx.principal.id);
  if (out.error) return { code: out.code, body: { error: out.error } };
  audit(ctx.principal.id, ctx.principal.via, `browser.task.${ctx.match[2]}`, { taskId: ctx.match[1] }, 'allow', 'ok');
  broadcast('browser', { type: `task.${ctx.match[2]}`, taskId: ctx.match[1] });
  return { code: 200, body: { task: out.task } };
});

route('GET', /^\/api\/v1\/browser\/tasks\/([\w-]+)\/evidence\/([\w-]+)$/, { permission: 'browser:read' }, (ctx) => {
  const row = browserRunner.getEvidence(ctx.match[1], ctx.match[2]);
  if (!row) return { code: 404, body: { error: 'evidence not found' } };
  return { code: 200, body: row };
});

route('POST', /^\/api\/v1\/dev\/seed$/, { permission: 'dev:seed', mutating: true }, (ctx) => {
  if (process.env.NODE_ENV === 'production' && process.env.MMM_ALLOW_SEED !== '1') {
    return { code: 403, body: { error: 'seeding is disabled in production (set MMM_ALLOW_SEED=1 to override)' } };
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
    if (!parsed.ok) return fail(res, parsed.status, parsed.error, { 'x-mmm-request-id': rid });
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
        'WWW-Authenticate': 'Bearer realm="mmm"',
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
    // A streaming route owns the response: it has already written headers and will keep writing.
    if (out && out.handled === true) return;
    // Providers expect plain text on a verification handshake, not a JSON-encoded string.
    if (out.text !== undefined) {
      res.writeHead(out.code ?? 200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'x-mmm-request-id': rid,
        ...(out.headers || {}),
      });
      res.end(String(out.text));
      return;
    }
    json(res, out.code ?? 200, out.body ?? {}, { 'x-mmm-request-id': rid, ...(out.headers || {}) });
  } catch (err) {
    audit(principal?.id || 'anonymous', principal?.via || 'api', `${req.method} ${requestedPath}`, {}, 'allow', 'error');
    json(res, 500, { error: 'internal error', requestId: rid, detail: process.env.MMM_DEBUG === '1' ? err.message : undefined });
  }
}

/* =========================================================================================
 * Server lifecycle
 * =======================================================================================*/
export function createGateway() {
  migrate();
  const bootstrap = auth.bootstrapOwner({ quiet: process.env.MMM_QUIET === '1' });
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
      socket.write(`HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nWWW-Authenticate: Bearer realm="mmm"\r\n\r\n${JSON.stringify({ error: 'authentication required for /ws' })}`);
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
          const wanted = msg.topics.filter((t) => typeof t === 'string' && ['agents', 'tasks', 'approvals', 'browser', 'evolution', 'chat', 'terminal', 'swarms', 'models', 'system', 'audit', '*'].includes(t));
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

  // The retry worker is off in tests (MMM_COMMS_DISABLE=1) and unref'd, so it never holds a
  // process open — `processQueue` is driven explicitly instead.
  const queueTicker = comms.startQueueTicker();

  // Browser tasks: the fan-out first, then the ticker that advances them, then re-attach whatever was
  // running when the process last stopped (it resumes from its checkpoint, after inspecting the page).
  setBrowserBroadcast(broadcast);
  setEvolutionBroadcast(broadcast);
  // Terminal status fan-out: the screen follows runs without polling every run separately.
  terminal.onTerminalEvent((payload) => broadcast('terminal', payload));
  // Every agent — seeded, imported or created yesterday — gets a self-improvement policy. The default
  // is level 1: inspect and recommend, never write.
  let evolutionPolicies = { agents: 0, created: 0 };
  try { evolutionPolicies = ensurePoliciesForAllAgents(); } catch { /* migrations not ready in some tests */ }
  const browserTicker = browserRunner.startTicker();
  if (process.env.MMM_BROWSER_RESUME !== '0') {
    browserRunner.resumeInterrupted().catch(() => {});
  }

  return {
    server,
    wss,
    bootstrap,
    authMode: mode.mode,
    authWarning: mode.warning,
    queueTicker,
    browserTicker,
    evolutionPolicies,
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
    `MMM gateway → http://localhost:${address.port}  (ws: /ws, data: ${DATA_DIR}, ` +
      `sqlite: ${DB_DRIVER}, auth: ${gateway.authMode})`
  );
  if (gateway.authWarning) console.warn(`auth: ${gateway.authWarning}`);
  if (gateway.authMode === 'dev-open') {
    console.warn('auth: dev-open — anonymous callers are accepted with the MMM_DEV_ROLE role. Never expose this.');
  }
  return gateway;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const stop = () => {
    try { browserRunner.shutdown(); } catch { /* nothing left to close */ }
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  startGateway().catch((err) => {
    console.error(`gateway failed to start: ${err.message}`);
    process.exit(1);
  });
}
