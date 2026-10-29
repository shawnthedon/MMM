# Rename: SwarmOS → MMM

**Date:** 2026-10-29 · **Repo/codename:** `MMM` · **Product name (old):** `SwarmOS`

The product, the repository and every runtime identifier now use one name: **MMM**. There is no
longer a split between "the repo is MMM" and "the app calls itself SwarmOS".

This was a **clean break**, not a compatibility shim: identifiers were renamed outright, and any
instance running before this change resets its session and cached state once. Nothing else is lost —
all server-side data lives in the database, which is renamed in place.

---

## 1. What changed

### Brand (user-visible)

| Place | Before | After |
| --- | --- | --- |
| App title / PWA name | `SwarmOS` | `MMM` |
| Document title | `SwarmOS — Agent Orchestration` | `MMM — Agent Orchestration` |
| Boot splash | `SwarmOS` | `MMM` |
| Sidebar brand | `RELAY / MMM COMMAND CENTER` | unchanged (was already MMM) |
| Default workspace name | `SwarmLab` | `MMM HQ` |
| Terminal banner, comms test messages, bot name | `SwarmOS …` | `MMM …` |
| npm package | `swarmos-pwa` | `mmm-pwa` |
| README / docs / diagrams | `SwarmOS` | `MMM` |

### Runtime identifiers (breaking)

| Identifier | Before | After |
| --- | --- | --- |
| Environment variables | `SWARMOS_*` (19 of them) | `MMM_*` |
| Session cookie | `swarmos_session` | `mmm_session` |
| CSRF header | `x-swarmos-csrf` | `x-mmm-csrf` |
| Request-id header | `x-swarmos-request-id` | `x-mmm-request-id` |
| Delivery header | `x-swarmos-delivery` | `x-mmm-delivery` |
| API token prefix | `swk_…` | `mmm_…` |
| Database file | `data/swarmos.sqlite` | `data/mmm.sqlite` |
| `localStorage` state key | `swarmos-state-v1` | `mmm-state-v1` |
| Gateway config key | `swarmos.gateway` | `mmm.gateway` |
| Service-worker cache prefix | `swarmos-v3` | `mmm-v4` |
| Python/agent draft keys, comms salt, skill package id | `swarmos.*` | `mmm.*` |
| Docker image / paths in docs | `swarmos-gateway`, `/srv/swarmos` | `mmm-gateway`, `/srv/mmm` |

### Deliberately kept

- `swarmos-` as a **legacy cache prefix** in `public/sw.js`. It is never written to again; it exists
  only so the activating worker purges the pre-rename shell instead of leaving a stale app installed.
  Removing it would strand users on old cached assets.
- Any `SwarmOS` string inside **screenshots/diagrams** that contain rasterised text. The banner is
  pure art (no wordmark) so no image needed regenerating; the screen strip is SVG and was renamed.

---

## 2. Upgrading an existing instance (one-time, ~5 minutes)

> Assumption: you run the gateway yourself with the database under `data/`.

1. **Stop the gateway.** Do not run two versions against the same files.
2. **Back up first** (always, before any migration or rename):
   ```bash
   sqlite3 data/swarmos.sqlite ".backup 'backups/pre-rename.sqlite'"
   sqlite3 backups/pre-rename.sqlite "PRAGMA integrity_check;"
   ```
3. **Pull the new code**, install, and rename the database in place:
   ```bash
   git pull
   npm ci --ignore-scripts
   mv data/swarmos.sqlite data/mmm.sqlite
   rm -f data/swarmos.sqlite-shm data/swarmos.sqlite-wal   # old WAL, regenerate on start
   ```
   A WAL/SHM pair from the old name must not be reused — deleting them is safe exactly because the
   main file was shut down cleanly and `.backup` already captured a consistent copy.
4. **Rename your environment variables.** In `.env` (or your process manager / secret store):
   ```bash
   SWARMOS_AUTH            → MMM_AUTH
   SWARMOS_AUTH_SECRET     → MMM_AUTH_SECRET
   SWARMOS_BOOTSTRAP_EMAIL → MMM_BOOTSTRAP_EMAIL
   SWARMOS_BOOTSTRAP_PASSWORD → MMM_BOOTSTRAP_PASSWORD
   SWARMOS_CORS_ORIGIN     → MMM_CORS_ORIGIN
   SWARMOS_SECURE_COOKIES  → MMM_SECURE_COOKIES
   SWARMOS_SESSION_TTL_MS  → MMM_SESSION_TTL_MS
   SWARMOS_LOGIN_* / SWARMOS_LOCKOUT_MS / SWARMOS_MIN_PASSWORD → MMM_*
   SWARMOS_BODY_LIMIT / SWARMOS_RATE_LIMIT / SWARMOS_ALLOW_SEED → MMM_*
   SWARMOS_DEV_ROLE / MMM_DEBUG / MMM_QUIET / MMM_SECRET / MMM_COMMS_DISABLE → MMM_*
   ```
   **Keep the same `AUTH_SECRET` value.** Changing it invalidates every CSRF token and any value
   derived from it; keeping it means only cookies need re-issuing.
5. **Start the gateway** (`npm run dev:gateway`) and check the banner:
   ```
   MMM gateway → http://localhost:8787  (ws: /ws, data: ./data, sqlite: …, auth: required)
   ```
   `GET /healthz` must return `ok: true`.
6. **Expect one re-login.** The cookie name changed, so existing sessions are simply absent — that is
   the clean break. Accounts, passwords, roles, audit rows and all data are untouched.
7. **Expect one state reset per browser.** The `localStorage` key changed, so the PWA re-seeds its
   local UI state (theme, drafts, layout) on next load. Server-owned data re-populates from the
   gateway as usual.
8. **Old API tokens are dead.** Tokens began with `swk_`; the gateway now only accepts `mmm_`.
   Re-issue them under **Settings → API tokens** for any CLI or bot integration:
   ```bash
   curl -s -b cookies.txt -H "x-mmm-csrf: $CSRF" -X POST localhost:8787/api/v1/tokens \
     -H 'content-type: application/json' -d '{"name":"ci","scopes":["read"]}'
   ```
9. **Verify** the app is fully live on the new name:
   ```bash
   npm test && npm run build
   grep -rIn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=data -i "swarmos" .
   # only public/sw.js (legacy cache purge) should match
   ```

### If you deploy the static app to Vercel

- Rename the project if you want the subdomain to match (Vercel → project → Settings → Name). The
  old URL keeps working until you change it.
- Re-set any environment variable that referenced `SWARMOS_*` in the Vercel dashboard; the client
  only needs `VITE_GATEWAY_URL`, which was never prefixed.
- The service worker cache bump (`mmm-v4`) forces installed PWAs to refresh their shell on the next
  visit. Users do not need to reinstall.

---

## 3. Why a clean break instead of a compatibility layer

Reading both `SWARMOS_*` and `MMM_*` indefinitely costs a permanent branch in config resolution, two
cookie names to audit, and a database file that may be either name — all of which invite exactly the
class of bug this repository spends its effort avoiding (“which config actually applied?”). The
rename touches a system with real authentication; a deterministic one-time reset is easier to reason
about and to verify than a silent fallback that can mask a misconfiguration.

The one place a legacy identifier **is** kept is the service-worker cache prefix, because there the
legacy name is not configuration — it is cleanup of state that would otherwise persist on user
devices.

---

## 4. Follow-ups (not blocking)

- [ ] Regenerate `docs/design/*.png` screenshots if any captured frame shows the old wordmark.
- [ ] Point the GitHub repo description at MMM (currently still says SwarmOS).
- [ ] Update any external bot usernames (`@MMM_ControlBot` in seed data is a placeholder, not a live bot).
- [ ] Log the rename in `docs/PROGRESS.md` so the next reader knows why the git history says SwarmOS.
