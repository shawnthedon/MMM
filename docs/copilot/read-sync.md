# Read sync — module screens read the gateway

**Status:** implemented for `agents`, `tasks`, `approvals`, `events` (checklist **2.5**).
**Evidence:** `npm run test:readsync` → 12/12, plus an end-to-end check against the real gateway
(`npm run dev:gateway`, sign in, `GET /api/v1/agents|tasks|approvals|events`).

## The rule

> A screen must never show gateway rows as if they were demo fixtures, or the reverse.

Before this change the PWA rendered `localStorage` fixtures while writes went to the gateway, so a
signed-in app could show agents the server had never heard of, and a create could appear twice.

Now every slice carries a provenance value and the UI is not allowed to hide it.

## Provenance

State shape (`src/core.js`):

```js
state.provenance = {
  agents: 'gateway', tasks: 'gateway', approvals: 'gateway', events: 'gateway',
  swarms: 'demo', teams: 'demo', usage: 'demo',
}
```

| Slice | Gateway routes | Provenance when signed in |
| --- | --- | --- |
| `agents` | `GET/POST /api/v1/agents`, `PATCH /api/v1/agents/:id` | `gateway` |
| `tasks` | `GET/POST /api/v1/tasks`, `PATCH /api/v1/tasks/:id` | `gateway` |
| `approvals` | `GET/POST /api/v1/approvals`, `POST /api/v1/approvals/:id/allow\|deny` | `gateway` |
| `events` | `GET /api/v1/events?cursor=` + WS `agents\|tasks\|approvals\|system` | `gateway` |
| `swarms`, `teams`, `usage` | none yet | `demo` (always, even signed in) |

Helpers: `getProvenance()`, `isLive(slice)`, `replaceSlices(patch, label)`, `setPersistFilter(fn)`.

## Data layer (`src/datastore.js`)

- `initDataSync()` is called once at boot after `refreshSession()`; it also subscribes to
  `subscribeAuth`, so sign-in loads data and sign-out releases it.
- `refresh({ silent })` fetches all four collections in parallel through `src/api.js` (cookies +
  CSRF, `cache: 'no-store'`), adapts the snake_case columns (`success_rate`, `column_name`,
  `decider_id`, …) into the shape the views already use, and swaps the slices atomically.
  Concurrent callers share one in-flight request; WS frames and window focus schedule a debounced
  `silent` refresh.
- Backoff-limited WebSocket to `/ws` (`wss` when the gateway is HTTPS, same-origin `/ws` through the
  dev proxy). `1008`/`4401` closes are treated as a refusal and are **not** retried in a loop.
- `releaseGatewayData()` restores the pre-gateway demo snapshot and drops gateway rows on sign-out,
  on an unreachable gateway, or on reset.

## Persistence

Gateway rows are never written to `localStorage['swarmos-state-v1']`: `core.persist()` runs through
the filter installed by the data layer, which swaps gateway slices back to the demo snapshot. A
signed-out browser therefore only ever holds fixtures, and a stale server copy can never resurface
as "demo" data. Verified by `test:readsync` ("gateway rows are never written to localStorage").

## Writes (no ghosts, no duplicates)

`createAgent / updateAgent / createTask / updateTask / decideApproval / requestApproval` call the
API and then adopt the **server's** returned row. A refusal (403/409/401) changes nothing locally:
the local store is only mutated by data the gateway acknowledged. Where the gateway has no endpoint
(`DELETE /agents/:id`, run/dispatch, swarm deploy/pause/cancel) the UI refuses the action and says
why instead of writing a browser-only row.

## Telling the user

- Top-bar chip: `live` (WS open) · `synced` (HTTP only) · `syncing…` · `stale gateway` (last
  refresh failed, rows are the last server copy) · `demo · offline` · `demo`.
- Module headers carry an inline `live gateway` / `demo data` tag; a full-width strip appears only
  when the rows are not the gateway's (with *Retry* or *Sign in*), so a live screen never carries a
  demo disclaimer.
- The chip opens **Where this data comes from** (`src/sourceui.js`): endpoint, principal + role,
  live-stream state, last sync, last live update, and a per-slice table.
- The home screen tags the approval banner and the event feed separately, because those can be live
  while swarms are still simulated.

## Simulation

`src/main.js` refuses to advance a slice the gateway owns, and `core.logEvent()` becomes a no-op
once the event feed is `gateway` — a browser-side line would masquerade as an audited server event.
Swarms remain simulated because the gateway has no swarm store; they are labelled demo.

## Limits (deliberate)

1. No server store for swarms, teams or usage, so those screens are demo-only while signed in.
2. No run/dispatch/delete endpoints — those actions are refused with an explanation.
3. Refresh is a whole-collection refetch; there is no delta/incremental merge yet.
4. No offline mutation queue: offline means read-only (demo rows) plus a labelled stale state.
5. Polling is the fallback when the WebSocket cannot be established (proxy without upgrade support).

## Tests

`scripts/readsync-test.mjs` (happy-dom + stub gateway returning rows that do **not** exist in the
fixtures):

1. demo mode reports demo provenance and never claims a gateway
2. signing in adopts gateway rows for all four collections (fixtures gone, not merged)
3. the agents screen renders gateway rows with a `live gateway` tag and no demo banner
4. the tasks screen puts the gateway card in its server column
5. gateway rows never reach `localStorage`; the demo snapshot stays persisted
6. a create response replaces the client draft with the server copy, exactly once
7. a 403 decision leaves the gate pending and surfaces the server's message
8. `logEvent` cannot append to a gateway-backed feed
9. a failed refresh keeps the rows but labels them *stale*
10. an unreachable gateway falls back to demo, labelled, and returns to live when it recovers
11. signing out restores fixtures and clears gateway provenance
12. demo mode still performs local writes and local events
