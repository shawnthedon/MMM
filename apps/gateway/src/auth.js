/* ============ SwarmOS auth — passwords, sessions, scoped tokens, lockout ============
 * Deliberately dependency-free (node:crypto only):
 *   • Passwords: scrypt (memory-hard, built into Node) with per-user salt and stored parameters.
 *     argon2id would be preferable but would add a native dependency; see docs for the trade-off.
 *   • Sessions: random 256-bit bearer secrets; only their SHA-256 is stored. HttpOnly cookie for
 *     the PWA, plus a CSRF token derived with HMAC for cookie-authenticated mutations.
 *   • API tokens: `swk_…`, hashed at rest, scoped to a subset of the holder's permissions.
 *   • Lockout: failed logins are recorded in `auth_attempts`; the window is enforced in-process
 *     and survives restarts because the attempts are persisted.
 */
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db } from './db.js';
import { PERMISSIONS, ROLE_PERMISSIONS, can, permissionsFor, isRole } from './rbac.js';

export const SESSION_COOKIE = 'swarmos_session';
export const CSRF_HEADER = 'x-swarmos-csrf';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const SESSION_TTL_MS = Number(process.env.SWARMOS_SESSION_TTL_MS || 12 * 60 * 60 * 1000);
const LOGIN_WINDOW_MS = Number(process.env.SWARMOS_LOGIN_WINDOW_MS || 5 * 60 * 1000);
const LOGIN_MAX_FAILURES = Number(process.env.SWARMOS_LOGIN_MAX_FAILURES || 5);
const LOCKOUT_MS = Number(process.env.SWARMOS_LOCKOUT_MS || 15 * 60 * 1000);
const MIN_PASSWORD_LENGTH = Number(process.env.SWARMOS_MIN_PASSWORD || 12);

/* ---------- server secret (session pepper + CSRF) ---------- */
let cachedSecret = null;
function serverSecret() {
  if (cachedSecret) return cachedSecret;
  const env = process.env.SWARMOS_AUTH_SECRET;
  if (env && env.length >= 32) {
    cachedSecret = env;
    return cachedSecret;
  }
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('auth.secret');
  if (row?.value && row.value.length >= 32) {
    cachedSecret = row.value;
    return cachedSecret;
  }
  const generated = randomBytes(48).toString('base64url');
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('auth.secret', generated);
  cachedSecret = generated;
  return cachedSecret;
}

/* ---------- password hashing ---------- */
export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error(`password must be a string of at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyPassword(stored, password) {
  if (!stored || typeof stored !== 'string' || typeof password !== 'string') return false;
  const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const derived = scryptSync(password, salt, expected.length, { N: Number(n), r: Number(r), p: Number(p) });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function passwordProblem(password) {
  const pw = String(password || '');
  if (pw.length < MIN_PASSWORD_LENGTH) return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'password must contain a letter and a number';
  return null;
}

/* ---------- tokens / hashes ---------- */
const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
export const hashToken = sha256;

function newSecret(prefix) {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

export function csrfFor(sessionToken) {
  return createHmac('sha256', serverSecret()).update(`csrf:${sessionToken}`).digest('base64url');
}

function safeEqualStrings(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  return bufA.length === bufB.length && bufA.length > 0 && timingSafeEqual(bufA, bufB);
}

/* ---------- principals ---------- */
export function safePrincipal(row) {
  if (!row) return null;
  const {
    password_hash: _pw, token_hash: _th, ...rest
  } = row;
  return {
    ...rest,
    scopes: rest.scopes_json ? JSON.parse(rest.scopes_json) : undefined,
    must_change_password: Boolean(rest.must_change_password),
  };
}

export function findPrincipalById(id) {
  return db.prepare('SELECT * FROM principals WHERE id = ?').get(id) || null;
}

export function findPrincipalByEmail(email) {
  const value = String(email || '').trim();
  if (!value) return null;
  return db.prepare('SELECT * FROM principals WHERE lower(email) = lower(?)').get(value) || null;
}

export const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

export function validateEmail(email) {
  const value = normalizeEmail(email);
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? value : null;
}

/** Shape the principal used for permission checks (never includes secrets). */
export function principalContext(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    role: row.role,
    status: row.status || 'active',
    scopes: extra.scopes,
    via: extra.via || 'session',
    tokenId: extra.tokenId || null,
    sessionId: extra.sessionId || null,
    anonymous: Boolean(extra.anonymous),
  };
}

/* ---------- rate limiting / lockout ---------- */
const buckets = new Map(); // key → number[] timestamps

export function rateLimit(key, { limit, windowMs }) {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (!v.some((t) => now - t < windowMs)) buckets.delete(k);
  }
  return { allowed: hits.length <= limit, remaining: Math.max(0, limit - hits.length), retryAfter: Math.ceil(windowMs / 1000) };
}

export function resetRateLimit(key) {
  buckets.delete(key);
}

function recordAttempt({ kind, identifier, ip, outcome, detail = '' }) {
  db.prepare('INSERT INTO auth_attempts (ts, kind, identifier, ip, outcome, detail) VALUES (?,?,?,?,?,?)')
    .run(Date.now(), kind, String(identifier || '').slice(0, 200), String(ip || '').slice(0, 80), outcome, String(detail || '').slice(0, 300));
}

export function lockoutState(identifier) {
  const since = Date.now() - LOGIN_WINDOW_MS;
  const row = db.prepare(
    "SELECT COUNT(*) n, MAX(ts) last FROM auth_attempts WHERE identifier = ? AND kind = 'login' AND outcome = 'failure' AND ts > ?"
  ).get(String(identifier || '').toLowerCase(), since);
  if (row.n < LOGIN_MAX_FAILURES) return { locked: false, failures: row.n };
  const until = row.last + LOCKOUT_MS;
  if (Date.now() >= until) return { locked: false, failures: row.n };
  return { locked: true, failures: row.n, retryAfter: Math.ceil((until - Date.now()) / 1000) };
}

/* ---------- sessions ---------- */
export function createSession(principalId, { ip = '', userAgent = '', ttlMs = SESSION_TTL_MS } = {}) {
  const token = newSecret('sws_');
  const id = sha256(token);
  const now = Date.now();
  const expiresAt = now + ttlMs;
  db.prepare(`INSERT INTO sessions (id, principal_id, created_at, expires_at, last_seen_at, ip, user_agent)
              VALUES (?,?,?,?,?,?,?)`)
    .run(id, principalId, now, expiresAt, now, String(ip).slice(0, 80), String(userAgent).slice(0, 300));
  db.prepare('UPDATE principals SET last_login_at = ? WHERE id = ?').run(now, principalId);
  return { token, id, expiresAt, csrfToken: csrfFor(token) };
}

export function revokeSession(sessionId, reason = 'logout') {
  db.prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL')
    .run(Date.now(), reason, sessionId);
}

export function revokeAllSessions(principalId, reason = 'revoked', exceptSessionId = null) {
  const now = Date.now();
  if (exceptSessionId) {
    db.prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE principal_id = ? AND id <> ? AND revoked_at IS NULL')
      .run(now, reason, principalId, exceptSessionId);
  } else {
    db.prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE principal_id = ? AND revoked_at IS NULL')
      .run(now, reason, principalId);
  }
}

function activeSession(sessionId) {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!row) return { error: 'session not found' };
  if (row.revoked_at) return { error: 'session revoked' };
  if (row.expires_at <= Date.now()) return { error: 'session expired' };
  return { session: row };
}

/* ---------- capability tokens ---------- */
export const TOKEN_SCOPES = Object.keys(PERMISSIONS);

export function createApiToken({ principalId, name = '', scopes = [], expiresInDays = null, createdBy = null }) {
  const requested = Array.isArray(scopes) && scopes.length ? scopes : ['*'];
  const invalid = requested.filter((s) => s !== '*' && !TOKEN_SCOPES.includes(s));
  if (invalid.length) throw new Error(`unknown scope(s): ${invalid.join(', ')}`);
  const holder = findPrincipalById(principalId);
  if (!holder) throw new Error('principal not found');
  // Scopes can never exceed what the holder's role allows.
  const held = ROLE_PERMISSIONS[holder.role] || [];
  const illegal = requested.filter((s) => s !== '*' && !held.includes(s));
  if (illegal.length) throw new Error(`scopes above the principal's role: ${illegal.join(', ')}`);

  const token = newSecret('swk_');
  const id = `tok-${randomBytes(6).toString('hex')}`;
  const now = Date.now();
  const expiresAt = expiresInDays ? now + Number(expiresInDays) * 86400000 : null;
  db.prepare(`INSERT INTO capability_tokens (id, principal_id, name, token_hash, prefix, scopes_json, created_at, created_by, expires_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, principalId, String(name).slice(0, 80), sha256(token), token.slice(0, 12), JSON.stringify(requested), now, createdBy, expiresAt);
  return { id, token, prefix: token.slice(0, 12), scopes: requested, expiresAt };
}

export function revokeApiToken(tokenId, revokedBy = null) {
  const row = db.prepare('SELECT * FROM capability_tokens WHERE id = ?').get(tokenId);
  if (!row) return null;
  if (!row.revoked_at) {
    db.prepare('UPDATE capability_tokens SET revoked_at = ?, revoked_by = ? WHERE id = ?').run(Date.now(), revokedBy, tokenId);
  }
  return row;
}

export function listApiTokens(principalId = null) {
  const rows = principalId
    ? db.prepare('SELECT * FROM capability_tokens WHERE principal_id = ? ORDER BY created_at DESC').all(principalId)
    : db.prepare('SELECT * FROM capability_tokens ORDER BY created_at DESC').all();
  return rows.map((r) => ({
    id: r.id,
    principal_id: r.principal_id,
    name: r.name,
    prefix: r.prefix,
    scopes: JSON.parse(r.scopes_json),
    created_at: r.created_at,
    created_by: r.created_by,
    expires_at: r.expires_at,
    last_used_at: r.last_used_at,
    revoked_at: r.revoked_at,
    revoked_by: r.revoked_by,
    expired: Boolean(r.expires_at && r.expires_at <= Date.now()),
  }));
}

function resolveBearer(secret, ip) {
  const row = db.prepare('SELECT * FROM capability_tokens WHERE token_hash = ?').get(sha256(secret));
  if (!row) return { error: 'unknown token' };
  if (row.revoked_at) return { error: 'token revoked' };
  if (row.expires_at && row.expires_at <= Date.now()) return { error: 'token expired' };
  const holder = findPrincipalById(row.principal_id);
  if (!holder) return { error: 'token owner no longer exists' };
  if (holder.status !== 'active') return { error: 'principal disabled' };
  // Throttle writes: one update per minute is plenty for last_used_at.
  if (!row.last_used_at || Date.now() - row.last_used_at > 60000) {
    db.prepare('UPDATE capability_tokens SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);
  }
  const { allowed } = rateLimit(`tok:${row.id}:${ip}`, { limit: 600, windowMs: 60000 });
  if (!allowed) return { error: 'rate limit exceeded', status: 429 };
  return {
    principal: principalContext(holder, { via: 'bearer', tokenId: row.id, scopes: JSON.parse(row.scopes_json) }),
  };
}

function resolveSessionCookie(secret) {
  const sessionId = sha256(secret);
  const found = activeSession(sessionId);
  if (found.error) return { error: found.error };
  const holder = findPrincipalById(found.session.principal_id);
  if (!holder) return { error: 'principal not found' };
  if (holder.status !== 'active') return { error: 'principal disabled' };
  if (Date.now() - found.session.last_seen_at > 60000) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(Date.now(), sessionId);
  }
  return {
    principal: principalContext(holder, { via: 'cookie', sessionId }),
    session: found.session,
  };
}

/* ---------- request authentication ---------- */
export function authMode() {
  const configured = String(process.env.SWARMOS_AUTH || 'required').toLowerCase();
  const production = process.env.NODE_ENV === 'production';
  if (configured === 'dev-open' && production) {
    return { mode: 'required', warning: 'SWARMOS_AUTH=dev-open refused in production; running in required mode' };
  }
  if (['required', 'dev-open'].includes(configured)) return { mode: configured };
  return { mode: 'required', warning: `unknown SWARMOS_AUTH="${configured}", defaulting to required` };
}

export function parseCookies(header = '') {
  const out = {};
  String(header || '')
    .split(';')
    .forEach((part) => {
      const idx = part.indexOf('=');
      if (idx < 0) return;
      const key = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (key) out[key] = decodeURIComponent(value);
    });
  return out;
}

export function bearerFrom(req) {
  const header = String(req.headers.authorization || '');
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * Resolve the caller. Returns {principal} | {error, status}.
 * Order: Authorization: Bearer → session cookie → (dev-open only) anonymous principal.
 */
export function authenticate(req) {
  const ip = clientIp(req);
  const bearer = bearerFrom(req);
  if (bearer) {
    if (bearer.startsWith('swk_')) {
      const out = resolveBearer(bearer, ip);
      if (out.error) return { error: out.error, status: out.status || 401 };
      return { principal: out.principal };
    }
    if (bearer.startsWith('sws_')) {
      const out = resolveSessionCookie(bearer);
      if (out.error) return { error: out.error, status: 401 };
      return { principal: { ...out.principal, via: 'bearer' }, session: out.session };
    }
    return { error: 'unrecognised credential', status: 401 };
  }

  const cookies = parseCookies(req.headers.cookie);
  const cookieSecret = cookies[SESSION_COOKIE];
  if (cookieSecret) {
    const out = resolveSessionCookie(cookieSecret);
    if (out.error) return { error: out.error, status: 401 };
    return { principal: out.principal, session: out.session };
  }

  const { mode } = authMode();
  if (mode === 'dev-open') {
    const role = isRole(process.env.SWARMOS_DEV_ROLE) ? process.env.SWARMOS_DEV_ROLE : 'Operator';
    return {
      principal: {
        id: 'anonymous',
        name: 'Anonymous (dev-open)',
        type: 'user',
        role,
        status: 'active',
        via: 'dev-open',
        anonymous: true,
      },
    };
  }
  return { error: 'authentication required', status: 401 };
}

/** CSRF applies only to cookie-authenticated mutations. Bearer callers are exempt. */
export function csrfProblem(req, context) {
  if (!context?.principal || context.principal.via !== 'cookie') return null;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return null;
  const provided = req.headers[CSRF_HEADER];
  const cookies = parseCookies(req.headers.cookie);
  const sessionSecret = cookies[SESSION_COOKIE];
  if (!sessionSecret) return 'missing session';
  if (!provided || !safeEqualStrings(provided, csrfFor(sessionSecret))) return 'invalid or missing CSRF token';
  return null;
}

export function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || '';
}

export function sessionCookie(token, { secure = false, maxAgeMs = SESSION_TTL_MS } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export const clearSessionCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

export const wantsSecureCookie = (req) =>
  process.env.SWARMOS_SECURE_COOKIES === '1' ||
  process.env.NODE_ENV === 'production' ||
  String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

/* ---------- login ---------- */
export function login({ email, password, ip, userAgent = '' }) {
  const identifier = normalizeEmail(email);
  const lock = lockoutState(identifier);
  if (lock.locked) {
    recordAttempt({ kind: 'login', identifier, ip, outcome: 'locked', detail: 'window exceeded' });
    return { error: 'too many failed attempts', status: 429, retryAfter: lock.retryAfter };
  }
  const principal = findPrincipalByEmail(identifier);
  const okPassword = Boolean(principal && principal.password_hash && verifyPassword(principal.password_hash, String(password || '')));
  if (!principal || !okPassword) {
    recordAttempt({ kind: 'login', identifier, ip, outcome: 'failure', detail: principal ? 'bad password' : 'unknown account' });
    return { error: 'invalid credentials', status: 401 };
  }
  if (principal.status !== 'active') {
    recordAttempt({ kind: 'login', identifier, ip, outcome: 'failure', detail: `status ${principal.status}` });
    return { error: 'account disabled', status: 403 };
  }
  const session = createSession(principal.id, { ip, userAgent });
  recordAttempt({ kind: 'login', identifier, ip, outcome: 'success' });
  resetRateLimit(`login:${ip}`);
  const context = principalContext(principal, { via: 'cookie', sessionId: session.id });
  return { principal: context, session, record: principal, permissions: permissionsFor(context) };
}

function randomPassword() {
  return `${randomBytes(9).toString('base64url')}a7`;
}

/**
 * Ensure at least one Owner exists. Order of preference:
 *   1. existing Owner (nothing to do)
 *   2. SWARMOS_BOOTSTRAP_EMAIL + SWARMOS_BOOTSTRAP_PASSWORD (or BOOTSTRAP_ADMIN_*)
 *   3. development: generate a password and print it once, flagged must_change_password
 * Production without bootstrap credentials refuses to start: no silent default admin.
 */
export function bootstrapOwner({ quiet = false } = {}) {
  const existing = db.prepare("SELECT id, email FROM principals WHERE role = 'Owner' AND status = 'active'").all();
  if (existing.length) return { created: false, owners: existing.length };

  const email = validateEmail(process.env.SWARMOS_BOOTSTRAP_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || '');
  let password = process.env.SWARMOS_BOOTSTRAP_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || '';
  const production = process.env.NODE_ENV === 'production';

  if (!email || !password) {
    if (production) {
      throw new Error(
        'No Owner principal exists. Set SWARMOS_BOOTSTRAP_EMAIL and SWARMOS_BOOTSTRAP_PASSWORD ' +
          'for the first start (or seed an owner deliberately). Refusing to run without an owner.'
      );
    }
    const generated = randomPassword();
    const id = 'user-owner';
    db.prepare(`INSERT OR REPLACE INTO principals (id, type, name, role, trust, created_at, email, password_hash, status, must_change_password, created_by)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, 'user', 'Owner', 'Owner', 100, Date.now(), 'owner@localhost', hashPassword(generated), 'active', 1, 'bootstrap');
    if (!quiet) {
      console.log(
        [
          '',
          '──────────────────────────────────────────────────────────────',
          ' SwarmOS bootstrap owner created',
          '   email:    owner@localhost',
          `   password: ${generated}`,
          '   (printed once — change it after login; store it in a password manager)',
          ' Set SWARMOS_BOOTSTRAP_EMAIL / SWARMOS_BOOTSTRAP_PASSWORD to choose your own.',
          '──────────────────────────────────────────────────────────────',
          '',
        ].join('\n')
      );
    }
    return { created: true, email: 'owner@localhost', generated: true, printed: !quiet };
  }

  const problem = passwordProblem(password);
  if (problem) throw new Error(`SWARMOS_BOOTSTRAP_PASSWORD rejected: ${problem}`);
  const id = `user-${email.split('@')[0].replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  db.prepare(`INSERT OR REPLACE INTO principals (id, type, name, role, trust, created_at, email, password_hash, status, must_change_password, created_by)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, 'user', 'Owner', 'Owner', 100, Date.now(), email, hashPassword(password), 'active', 0, 'bootstrap');
  return { created: true, email, generated: false };
}

/* ---------- account management ---------- */
export function createPrincipal({ email, password, name, role = 'Observer', type = 'user', actor = null, mustChange = true }) {
  const normalized = validateEmail(email);
  if (!normalized) throw new Error('a valid email is required');
  if (!isRole(role)) throw new Error(`unknown role "${role}"`);
  if (findPrincipalByEmail(normalized)) throw new Error('email already registered');
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  const id = `user-${normalized.split('@')[0].replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${randomBytes(2).toString('hex')}`;
  db.prepare(`INSERT INTO principals (id, type, name, role, trust, created_at, email, password_hash, status, must_change_password, created_by)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, type, String(name || normalized).slice(0, 80), role, 50, Date.now(), normalized, hashPassword(password), 'active', mustChange ? 1 : 0, actor?.id || null);
  return safePrincipal(findPrincipalById(id));
}

export function setPrincipalRole(id, role, actor) {
  if (!isRole(role)) throw new Error(`unknown role "${role}"`);
  db.prepare('UPDATE principals SET role = ?, token_version = token_version + 1 WHERE id = ?').run(role, id);
  // Role changes invalidate existing sessions so a demotion takes effect immediately.
  revokeAllSessions(id, 'role-changed');
  return safePrincipal(findPrincipalById(id));
}

export function setPrincipalStatus(id, status) {
  if (!['active', 'disabled'].includes(status)) throw new Error('status must be active or disabled');
  db.prepare('UPDATE principals SET status = ?, token_version = token_version + 1 WHERE id = ?').run(status, id);
  if (status === 'disabled') revokeAllSessions(id, 'disabled');
  return safePrincipal(findPrincipalById(id));
}

export function changePassword(principalId, { currentPassword, newPassword, keepSessionId = null }) {
  const row = findPrincipalById(principalId);
  if (!row) return { error: 'principal not found', status: 404 };
  if (row.password_hash && !verifyPassword(row.password_hash, String(currentPassword || ''))) {
    return { error: 'current password is incorrect', status: 403 };
  }
  const problem = passwordProblem(newPassword);
  if (problem) return { error: problem, status: 400 };
  db.prepare('UPDATE principals SET password_hash = ?, must_change_password = 0, token_version = token_version + 1 WHERE id = ?')
    .run(hashPassword(newPassword), principalId);
  revokeAllSessions(principalId, 'password-changed', keepSessionId);
  return { ok: true };
}

export { can, permissionsFor };
