# Gateway Authentication & RBAC (Governance Layer 1)

| Field | Value |
| --- | --- |
| Parent spec | `Copilot_Master_MMM_V2.md` §11 (governance, security), §12 (contracts); `docs/IMPLEMENTATION_CHECKLIST.md` 3.4 |
| Baseline | `66b1bd3` → branch `arena/8f33bbd7-mmm` |
| Files | `apps/gateway/migrations/002_auth.sql`, `apps/gateway/src/auth.js`, `apps/gateway/src/rbac.js`, `apps/gateway/server.js`, `apps/gateway/src/seed.js`, `apps/gateway/src/db.js`, `src/api.js`, `src/auth.js`, `src/authview.js`, `src/shell.js`, `src/main.js`, `src/copilot/*`, `vite.config.js`, `.env.example` |
| Tests | `npm run test:gateway` (28) · `npm run test:auth` (16) · `npm run smoke` (28) · `npm run test:copilot` (6) |
| Status | **PASS** for the gateway-enforced scope. Limits listed in §8 are deliberate and documented. |

---

## 1. What was actually missing

The Phase 0 report recorded the gateway serving `/api/v1/*` with `Access-Control-Allow-Origin: *`
and no credential of any kind: any caller could create agents, resolve approval gates and seed
data, and the audit log attributed everything to the literal string `api-user`. That also meant
Copilot's approval cards could not be enforced anywhere except the browser.

## 2. Identity model

| Concern | Implementation |
| --- | --- |
| Principals | `principals` table gains `email`, `password_hash`, `status`, `last_login_at`, `token_version`, `must_change_password`, `created_by` (migration `002_auth.sql`). Unique index on `email`. |
| Passwords | `scrypt` (N=16384, r=8, p=1, 32-byte key) with a 16-byte per-user salt, stored as `scrypt$N$r$p$salt$hash`, compared with `timingSafeEqual`. Argon2id would be preferable but needs a native addon — recorded as a trade-off, not hidden. |
| Sessions | 256-bit `sws_…` secret; only its SHA-256 is stored in `sessions`. HttpOnly, `SameSite=Strict`, `Secure` behind TLS, 12 h TTL, `last_seen_at` refreshed at most once a minute, revocation on logout/password change/role change/disable. |
| CSRF | Cookie-authenticated mutations must send `x-swarmos-csrf`; the value is `HMAC-SHA256(serverSecret, "csrf:" + sessionSecret)` and is returned by `/api/v1/auth/session`. Bearer callers are exempt (they are not ambient credentials). |
| Server secret | `SWARMOS_AUTH_SECRET` (≥32 chars) or one generated once and stored in `settings` (`auth.secret`). |
| API tokens | `swk_…` secrets, hashed at rest (`capability_tokens`), explicit `scopes_json`, optional expiry, `prefix` for display, immediate revocation, `last_used_at`. Scopes can only narrow the holder's role. |
| Bootstrap | First start creates an Owner from `SWARMOS_BOOTSTRAP_EMAIL`/`SWARMOS_BOOTSTRAP_PASSWORD`, or in development generates a password and prints it **once** with `must_change_password`. Production without credentials refuses to start — there is no silent default admin. |
| Lockout | 5 failures per email in 5 min → 15 min lock; 20 attempts per address in 5 min → 429. Attempts persisted in `auth_attempts` and written to the audit log. |

## 3. RBAC matrix

Roles are **not** a single ladder — that is the point of the design:

| Permission | Observer | Reviewer | Operator | Admin | Owner |
| --- | :-: | :-: | :-: | :-: | :-: |
| `read`, `summary:read`, `event:read`, `approval:read`, `token:issue` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `approval:request` | – | ✅ | ✅ | ✅ | ✅ |
| `approval:decide` | – | ✅ | – | ✅ | ✅ |
| `audit:read`, `audit:verify` | – | ✅ | – | ✅ | ✅ |
| `agent:write`, `task:write`, `swarm:write` | – | – | ✅ | ✅ | ✅ |
| `principal:read`, `principal:write`, `token:revoke:any`, `system:diagnostics` | – | – | – | ✅ | ✅ |
| `principal:write:privileged`, `dev:seed` | – | – | – | – | ✅ |

An Operator runs work but cannot grant gates; a Reviewer grants gates but cannot run work.
`GET /api/v1/roles` returns this matrix live.

### Guards that are enforced in code

- **No self-elevation**: an actor cannot change their own role or status (`canManagePrincipal`).
- **No equals**: Admin cannot create, promote to, or modify an Owner.
- **Separation of duties**: whoever requested a gate cannot decide it (matched by principal id *and*
  display name, so impersonation via a `principal` label fails); only `user`/`bot` principals may
  decide — a Copilot or agent principal never can.
- **Demotion is immediate**: role/status change bumps `token_version` and revokes live sessions.
- **Token ceiling**: scopes are validated against the holder's role at mint time.
- **Resolved gates are immutable** (409), so a decision cannot be flipped afterwards.

## 4. Route map (deny by default)

`GET /healthz` and `POST /api/v1/auth/login` are the only public routes. Everything else declares
an explicit permission; an unknown path returns 404 **after** authentication, so probing does not
reveal the API shape to anonymous callers.

```
POST /api/v1/auth/login            public (throttled, audited)
GET  /api/v1/auth/session          read        → principal, permissions, CSRF token
POST /api/v1/auth/logout           read
POST /api/v1/auth/password         read        (revokes other sessions)
GET  /api/v1/roles                 read
GET  /api/v1/principals            principal:read
POST /api/v1/principals            principal:write  (+ canAssignRole)
PATCH/api/v1/principals/:id        principal:write  (+ canManagePrincipal)
GET  /api/v1/tokens                token:issue
POST /api/v1/tokens                token:issue      (scopes ⊆ role)
DELETE/api/v1/tokens/:id           token:issue      (+ token:revoke:any for others)
GET  /api/v1/summary               summary:read
GET|POST /api/v1/agents            read | agent:write
GET|PATCH /api/v1/agents/:id       read | agent:write
GET|POST /api/v1/tasks             read | task:write
PATCH/api/v1/tasks/:id             task:write
GET  /api/v1/approvals             approval:read
POST /api/v1/approvals             approval:request
POST /api/v1/approvals/:id/allow   approval:decide  (+ separation of duties)
POST /api/v1/approvals/:id/deny    approval:decide  (+ separation of duties)
GET  /api/v1/events?cursor=        event:read
GET  /api/v1/audit                 audit:read
GET  /api/v1/audit/verify          audit:verify
POST /api/v1/dev/seed              dev:seed   (also blocked in production unless SWARMOS_ALLOW_SEED=1)
WS   /ws                           authenticated; topic-filtered by permission
```

## 5. Transport & hardening

- **CORS is an explicit allowlist** (`SWARMOS_CORS_ORIGIN`, default the local Vite origins) and
  echoes the origin **with** `Access-Control-Allow-Credentials`. Unknown origins get `null` rather
  than a wildcard, because `*` cannot carry cookies.
- **Bodies** are capped (256 KB), must be JSON objects, and malformed JSON is a 400 instead of a
  silently empty object.
- **Rate limits**: 600 authenticated requests/min per principal+address; login has its own bucket.
- **Responses** carry `x-swarmos-request-id`, `x-swarmos-auth`, `nosniff`, `no-referrer`,
  `Cache-Control: no-store`.
- **Health** no longer leaks `dataDir` to anonymous callers (only `system:diagnostics` sees it).
- **Audit** records every mutation *and* every denial (role, via, route, permission), with the
  existing hash chain verified by `npm run test:gateway` and `GET /api/v1/audit/verify`.
- **Seeding** no longer deletes identity/credential tables and does not invent password-less users;
  the demo data reset is limited to content tables.

## 6. Client integration (PWA)

- `src/api.js` — transport: `credentials: 'include'`, CSRF header injected for mutations, typed
  `ApiError` with `status`/`code`/`requestId`, 8 s timeout, no silent retries.
- `src/auth.js` — session cache (`status`: `demo | checking | anonymous | authenticated | unreachable`),
  permissions, `can()` for UI affordances only, revalidation on tab focus, and configuration of the
  gateway URL. **No credential is ever written to localStorage**; only the gateway URL is.
- `src/authview.js` + `#/login` route — sign-in form with inline errors, account card (role,
  permission chips, password change, sign out), gateway configuration, and always-available
  "Continue without a gateway" that is labelled **unenforced**.
- Top bar shows `demo` / `signed out` / `offline` / the role.
- A 401 from any call dispatches `swarmos:unauthenticated`, which routes back to sign-in.
- Dev convenience: `npm run dev` proxies `/api`, `/healthz` and `/ws` to `:8787`, so "Use this
  origin (dev proxy)" gives a same-origin session cookie (no CORS, works behind a preview proxy).

## 7. Copilot now acts through the runtime

- Capability `actions` is recomputed per read: `available` (signed in with write permission —
  "server-enforced", audited), `blocked` (role lacks write), `unconfigured` (not signed in /
  gateway unreachable) or `demo` (no gateway).
- Agent creation, task creation and approval decisions POST to the gateway when a session exists;
  results report the gateway id, the authorising role and the audit entry, or the server's refusal
  verbatim (`403` → `blocked`, with the request id).
- Nothing falls back to the demo store after a server failure: a refused action leaves no local
  copy, which is the failure mode that causes ghost state.
- Swarm deployment stays local and says so — `POST /swarms/:id/deploy` is still a planned route.
- Read intents (`status`, `list agents`, `list tasks`, `pending approvals`) prefer the gateway and
  state the source (`gateway (authoritative)` vs `local demo store — <reason>`).

## 8. Known limitations (deliberate, not accidental)

1. **No 2FA, SSO/OIDC, email password reset, or session/device list UI.** Owners are seeded by env.
2. **scrypt, not argon2id** (no native dependency). Parameters are stored with each hash, so a
   future upgrade can rehash on next login.
3. **Rate limiting is in-process**, so it is per-node; a clustered gateway would need shared state.
4. **RBAC is role-based, not per-object** (no row-level ACLs, no per-team scoping). Approval gates
   carry separation of duties but no risk-based thresholds yet.
5. **The PWA reads demo data while writes go to the gateway** — full read sync (checklist 2.5) is
   still open, so a signed-in app can show local agents that the gateway does not have. Copilot
   labels its source every time, but the module screens do not yet.
6. **TLS termination is external.** `SWARMOS_SECURE_COOKIES=1` must be set behind HTTPS;
   the gateway itself only speaks HTTP.
7. **WS tokens in query strings** are accepted for CLI convenience (`?token=`); prefer the cookie.

## 9. Acceptance evidence

```
npm run test:gateway   → 28/28
  public health hides dataDir · anonymous 401 on every data route
  login rejects bad/unknown credentials without leaking which factor failed
  session cookie is HttpOnly + SameSite=Strict · CSRF required for cookie writes
  invalid JSON 400 · oversized body 413
  per-role allow/deny matrix (Observer/Reviewer/Operator/Admin/Owner)
  admin cannot create or modify an Owner · no self-elevation or self-disable
  role change kills the target's session immediately
  operator requests gates but cannot decide · reviewer cannot decide their own gate
  reviewer-name impersonation blocked · resolved gates immutable (409)
  scoped bearer tokens narrow rights, cannot exceed role, respect revoke/expiry
  other principals' tokens cannot be revoked without admin right
  5 failures lock the account (429 + retryAfter) and are audited · per-IP flood throttled
  password change revokes other sessions and invalidates the old password
  disabled principals lose access immediately
  audit chain verifies (>20 entries, denials attributed, no passwords in it)
  seeding keeps identities and the owner session intact
  CORS echoes only allowlisted origins with credentials
  WebSocket rejects anonymous upgrades, identifies the principal, refuses unheld topics

npm run test:auth      → 16/16   (client: demo mode, gating, CSRF, 403/401 handling, no secret in storage)
npm run smoke          → 28/28   (existing UI still boots and renders)
npm run test:copilot   → 6/6
```

## 10. Next

1. Read sync (checklist 2.5): load agents/tasks/approvals from the gateway into the views and drop
   the demo mirror when signed in.
2. Argon2id via `@node-rs/argon2` (or keep scrypt and document): rehash-on-login path is ready.
3. 2FA/TOTP + session/device management, password reset by an Owner-issued one-time link.
4. `POST /swarms/:id/deploy|pause|cancel` so swarm deployment becomes server-enforced too.
