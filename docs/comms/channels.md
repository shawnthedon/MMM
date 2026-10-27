# Comms — communication gateways

**Panel:** `#/comms` · **Code:** `src/comms.js` (panel, switchboard, inbound), `src/commsChannels.js`
(catalogue), `src/commsAdapters.js` (per-channel requests + signatures), `src/comms.css`
**Tests:** `npm run test:comms` → 18/18
**Status:** panel, adapters, signature verification, routing and the Copilot seam are implemented.
The **gateway HTTP routes** (`POST /api/v1/comms/:channel/inbound`) are specified here but not yet
served — see [Roadmap](#roadmap).

## Channels

| Channel | Transport | Signature | Works today |
| --- | --- | --- | --- |
| Telegram | Bot API `sendMessage` / webhook updates | `X-Telegram-Bot-Api-Secret-Token` | adapters + inbound verification; live delivery needs a token and network |
| WhatsApp | Meta Cloud API `/{phoneNumberId}/messages` | `X-Hub-Signature-256` (HMAC-SHA256, app secret) + GET `hub.verify_token` handshake | same |
| Discord | Bot API v10 `channels/{id}/messages`, interactions | `X-Signature-Ed25519` + timestamp | same |
| Slack | `chat.postMessage`, Events API | `v0=HMAC-SHA256` over `v0:timestamp:body`, 5-minute replay window | same |
| SMS | Twilio-compatible `/2010-04-01/Accounts/{sid}/Messages.json` (also OpenSMS-style base URL) | `X-Twilio-Signature` = HMAC-SHA1 over URL + sorted params | same |
| Browser | in-app inbox (+ Web Push when VAPID is set) | none — same-origin session | **fully**, no credentials |

## Status model

```
not_configured ──save required fields──▶ configured_unverified ──live test accepted──▶ verified
        ▲                                        │                                     │
        └──────────── credential changed ────────┘        provider rejects test ──▶ failed
```

- Only a **provider-accepted live test** sets `verifiedAt`. Saving a form never does.
- Changing any credential clears `verifiedAt` and `lastTest`.
- `failed` records the provider's own message (status code preserved).
- Inbound secrets (`webhookSecret`, `verifyToken`, `publicKey`, `signingSecret`) are scoped
  `inbound`; without them outbound still works but the panel shows “inbound webhooks cannot verify
  yet” and the inbound handler answers **503** instead of guessing.

## Adapter contract (`src/commsAdapters.js`)

```js
ADAPTERS[channel] = {
  verify(headers, rawBody, config) -> boolean        // inbound authenticity
  buildSend(config, message) -> { url, method, headers, body } | { error }
  healthRequest?(config) -> request                  // credentials check
  parseInbound(json) -> { text, from, chatId } | null
  isSuccess?(res) -> boolean                         // Slack returns 200 + {ok:false}
}
```

`deliver()` executes the built request through an injected `fetch` (10 s timeout, abortable) and
classifies the outcome as `ok` / `not_configured` / `invalid_config` / `timeout` / `network` /
`rejected` (with the provider's message and HTTP status). The same function runs in the tests against
a mock provider, so the only missing piece for live use is real credentials and egress.

## Routing and the command surface

- **Copilot replies:** per-channel toggle.
- **Agents:** each agent can be routed to a channel; `routesFor(agentId)` returns only channels that
  are *enabled* and *configured*.
- **Command surface:** `/status`, `/agents`, `/tasks`, `/ask` (deterministic, from live state) and the
  gated `/approve`, `/copilot` — gated commands are **refused over channels**; they require an in-app
  confirmation (signed buttons only). Commands can be disabled individually.
- **Copilot intents:** `comms status` · `test <channel>` · `route <agent> to <channel>` ·
  `mute <channel>` · `wake <channel>` · `inbox`. The Copilot **refuses to accept credentials in chat**
  and points at the panel.

## Planned gateway routes (not implemented yet)

```
POST /api/v1/comms/:channel/inbound   signature-gated, CSRF-exempt, RBAC comms:write, audited
GET  /api/v1/comms/:channel/verify    provider handshakes (Meta hub.challenge, Slack url_verification)
POST /api/v1/comms/:channel/send      outbound with comms:write; server-side delivery only
GET  /api/v1/comms/status             per-channel status + last test (never secrets)
```

Secrets must live in a gateway table encrypted with `SWARMOS_SECRET`, never in `localStorage` — the
current build keeps them in the browser store and says so in the panel.

## Roadmap

1. `comms_channels` migration + encrypted secret store; move credentials server-side.
2. Inbound routes with the adapters already written; audit every accept/reject.
3. Outbound queue with retry/backoff and per-channel rate limits.
4. Agent event fan-out (task done, approval needed, run failed) through `routesFor()`.
5. Web Push (VAPID) for the browser channel outside an open tab.
6. Provider-specific limits: Meta 24-hour window (templates only outside), Discord 3-second ACK,
   Slack 3-second ack + `response_url`, Twilio signature URL must be the public URL.

See [`credentials.md`](credentials.md) for exactly what to supply per channel and where it goes.
