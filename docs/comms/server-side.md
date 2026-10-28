# Comms: server-side credentials, routes and delivery

The panel, adapters and signature checks existed before this round; what was missing was *where the
secrets live* and *who does the sending*. Both are now the gateway.

```
apps/gateway/migrations/003_comms.sql   comms_channels · comms_messages · comms_settings
apps/gateway/src/comms.js               encryption, channel CRUD, delivery, retry queue, webhooks, fan-out
apps/gateway/server.js                  routes + raw-body capture + provider fetch seam
src/commsGateway.js                     browser client (adopt / save / send / queue / release)
src/comms.js                            panel: gateway path when a session holds comms:read
scripts/comms-gateway-test.mjs          npm run test:comms-gateway (27 checks, real HTTP)
```

## 1. Credentials are server-side, encrypted at rest

| | |
| --- | --- |
| Cipher | AES-256-GCM, random 12-byte IV, auth tag stored with the ciphertext (`v1.<iv>.<tag>.<body>`, base64url) |
| Key | HKDF-SHA256 over `SWARMOS_SECRET` (salt `swarmos-comms-salt`, info `comms-config-v1`) → 32 bytes |
| No `SWARMOS_SECRET` | the gateway generates `data/.comms-key` (mode 600) **and prints a warning**. Never silently "fine" |
| Tampering / wrong key | decryption yields `{}` — the gateway reports "not configured", it never guesses |
| API responses | secrets are returned as `••••last4` only; a client that sends `••••…` back cannot overwrite the stored value |
| Logs | `redact()` scrubs bot tokens, Meta tokens, Slack tokens, bearer headers and phone numbers before a body is stored |
| Audit | channel saves record field **names** and a `credentialsChanged` flag, never values |

`GET /api/v1/comms` also states where secrets live (`encryption.keySource`, `secretsServerSide`) so the
panel can print it instead of claiming it.

## 2. Routes

| method | path | permission | notes |
| --- | --- | --- | --- |
| GET | `/api/v1/comms` | `comms:read` | channels (masked), settings, stats, 20 recent messages, encryption facts |
| PUT | `/api/v1/comms/settings` | `comms:write` | quiet hours, rate limit, retry limit, command switches |
| GET | `/api/v1/comms/messages` | `comms:read` | filter by `channel` / `direction`, `limit` ≤ 200 |
| PUT | `/api/v1/comms/:channel` | `comms:write` | save config / enable / routing; unknown fields ignored |
| DELETE | `/api/v1/comms/:channel` | `comms:write` | removes credentials **and** the verification |
| POST | `/api/v1/comms/:channel/send` | `comms:write` | real delivery; `dedupeKey` makes it idempotent |
| POST | `/api/v1/comms/queue` | `comms:write` | run the retry queue now |
| GET | `/api/v1/comms/:channel/verify` | public | Meta `hub.challenge` (plain text), Slack `challenge` (signed) |
| POST | `/api/v1/comms/:channel/inbound` | public, signature | adapter verifies over the raw body; `x-swarmos-delivery` dedupes |

`comms:read` joins `read` for every role; `comms:write` sits with `agent:write`/`task:write` in the
Operator set. Every comms route writes an audit row (including refusals).

Public routes still record everything: an unsigned inbound call is answered `401` **and** stored as a
`rejected` message with `reason: signature`.

## 3. Delivery, retries, quiet hours

* One row per attempt in `comms_messages` (`queued` → `sent` | `failed`, `attempts`, `next_attempt_at`).
* Verified only by a provider-accepted send. A `4xx` is a failure; it is **not** retried.
* `network` / `timeout` / `rate_limited` / `server_error` are queued and retried with backoff
  `30s, 2m, 5m, 15m…` capped at 1 h, until `retryLimit` (default 3), then `failed`.
* Queue processing checks `rateLimitPerMin` (default 20/minute); immediate sends and concurrent workers do not have a complete enforced rate limit.
* Quiet hours (`22:00-06:00`, wraps midnight) hold outbound mail instead of sending it; the send route
  answers `202` with `reason: quiet_hours`.
* The background ticker (`processQueue` every 60 s) is `unref()`'d and disabled with
  `SWARMOS_COMMS_DISABLE=1`, so tests drive it explicitly.

## 4. Inbound

Signature first, then parse — never the other way round. Supported today:

* Telegram `X-Telegram-Bot-Api-Secret-Token` (shared secret, constant-time compare)
* Meta/WhatsApp `X-Hub-Signature-256` = HMAC-SHA256 of the **raw** body keyed with the Meta app secret (not the access token)
* Slack `X-Slack-Signature` `v0=` HMAC over `v0:timestamp:body` with a 5-minute replay window
* Discord interactions: Ed25519 (adapter rejects honestly — no key material is bundled)
* Twilio SMS: signature over the sorted form params (form-encoded bodies are accepted)

Commands are deterministic and read real gateway rows (`/status`, `/agents`, `/tasks`). Gated commands
(`/approve`, `/copilot`) are refused over a channel with an explanation. Replies go out on the same
channel through the same delivery path, so a failed reply is reported, not swallowed.

## 5. Fan-out

`task.updated → done` and `approval.created` enqueue a message on every enabled channel routed to
that agent (`routing.agents`, or `routing.copilot` for workspace-level notices). Fan-out is
**enqueue-only** — the queue worker does the delivery, so a provider outage delays a notice rather
than losing or faking it. Dedupe keys (`task-done:<id>`, `approval:<id>`) stop repeats.

## 6. Browser behaviour

* `canReadGatewayComms()` = gateway configured **and** session authenticated **and** `comms:read`.
  Then `refreshComms()` adopts the server's channels: statuses verbatim, config masked, `provenance.comms
  = 'gateway'`.
* `saveChannelConfig` / `sendTest` / the panel's Save and Test buttons go through the gateway; refusals
  are surfaced as `Gateway refused: …`.
* Signing out (`releaseComms`) drops the adopted rows so a stale "verified" badge cannot survive, and
  the persist filter refuses to write gateway-owned comms to `localStorage`.
* Browser-only credential storage is available only in demo mode. With a configured but unauthenticated or unauthorized gateway, mutations and sends are blocked.

## 7. What is still not done

* **Outbound queue is in-process.** A restart keeps queued rows (they are in SQLite) but the retry
  ticker only runs while the gateway is up; there is no separate worker or scheduled job.
* **Rate limits are incomplete:** direct sends bypass the queue counter; provider-side rate-limit headers are not parsed.
* **Discord interactions** need Ed25519 verification with the app public key: the adapter refuses
  instead of pretending, so Discord inbound is not usable yet.
* **Web Push (VAPID)** for the browser channel is not implemented; the "browser" channel delivers
  into the in-app inbox only.
* **Secrets rotation** requires re-saving the field (no multi-key ring yet).
* Delivery of a **template** message (WhatsApp 24-hour window) is available in the adapter
  (`msg.template`) but the panel does not expose template selection.
* Live provider verification requires authorised credentials, reachable provider networks and completed production security review; mock tests are not delivery evidence. OpenSMS and browser control are not implemented.

## 8. Evidence

```bash
npm run test:comms-gateway   # 28 checks: RBAC, encryption at rest, masking, save≠verify, delivery
                             # outcomes, retry/backoff/limits, quiet hours, dedupe, redaction,
                             # signature gating, replay, handshakes, fan-out, audit, settings
npm run test:comms           # 23 checks: panel + adapters + the browser gateway path
```

Credentials you would need for a live end-to-end check are listed in
[`credentials.md`](credentials.md).

## 9. 2026-10-28 hardening

SMS outbound is restricted to the official HTTPS Twilio endpoint; redirects are refused to avoid exposing credentials or reaching arbitrary hosts. OpenSMS uses a different Bearer/JSON API and is **not** implemented. Existing non-Twilio `baseUrl` values remain stored but sending them fails closed. Twilio inbound now requires the exact configured public webhook URL and base64 signature; WhatsApp requires the separate Meta app secret. Existing WhatsApp configurations need this new field before inbound can be accepted.
