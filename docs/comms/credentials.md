# Comms credentials — what to supply, where it goes

Nothing here is needed to use the panel: an unconfigured channel simply reports
`Not configured`. Fill a channel's outbound fields to move it to **Configured · unverified**, then run
**Send test** to reach **Send accepted**. Provider acceptance is not a delivery receipt.

## Where the values go

* **Signed in to a gateway with `comms:write`** — the values are POSTed once, encrypted with
  AES-256-GCM under a key derived from `SWARMOS_SECRET`, and stored in `comms_channels`. The browser
  only ever receives `••••last4`. Delivery, retries and webhooks run on the gateway
  ([details](server-side.md)).
* **No gateway session** — they stay in this browser's store, and the panel says so.

Set `SWARMOS_SECRET` on the gateway before production: without it the gateway generates
`data/.comms-key` and warns that the key is local to that machine.

## Redirect URLs to register with each provider

| Provider | What to register |
| --- | --- |
| Telegram | `setWebhook https://<host>/api/v1/comms/telegram/inbound` with `secret_token` = `webhookSecret` |
| WhatsApp | callback `https://<host>/api/v1/comms/whatsapp/inbound`, verify token = `verifyToken` |
| Slack | Events URL `https://<host>/api/v1/comms/slack/inbound`, Interactivity same URL |
| Discord | Interactions endpoint `https://<host>/api/v1/comms/discord/inbound` |
| SMS (Twilio) | messaging webhook `https://<host>/api/v1/comms/sms/inbound` (form-encoded) |

The host must be reachable over HTTPS from the provider. `localhost` works only through a tunnel; the
gateway's CORS allowlist does not apply to these public routes, but the signature check does.

## Telegram
| Field | Where to get it | Required |
| --- | --- | --- |
| `botToken` | @BotFather → `/newbot` (or `/token`) | yes |
| `chatId` | the target chat/group id (send a message, use `getUpdates`) | yes |
| `webhookSecret` | any random string; Telegram echoes it on every update | for inbound |
| `publicBase` | HTTPS URL Meta/Telegram can reach (tunnel is fine) | for webhooks |

Env names: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_CHAT_ID`.

## WhatsApp (Meta Cloud API)
| Field | Where to get it | Required |
| --- | --- | --- |
| `accessToken` | Business settings → System users → permanent token | yes |
| `phoneNumberId` | WhatsApp → API setup | yes |
| `recipient` | destination number, E.164 | yes |
| `verifyToken` | your own string, echoed in Meta's GET handshake | for inbound |
| `appSecret` | Meta app secret, distinct from the access token; verifies body signatures | for inbound |
| `wabaId` | WhatsApp Business Account id | for templates |

Env: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_VERIFY_TOKEN`.
Note: outside the 24-hour customer-service window only **pre-approved templates** can be sent; the
adapter already supports `message.template`.

## Discord
| Field | Where to get it | Required |
| --- | --- | --- |
| `botToken` | Developer portal → Bot → Reset token | yes |
| `channelId` | right-click channel → Copy ID (developer mode) | yes |
| `applicationId` | General information | optional |
| `publicKey` | General information (for interaction signatures) | for inbound |

Env: `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`.
Note: interactions must be ACKed within 3 seconds (`{type: 5}` deferred response is wired).

## Slack
| Field | Where to get it | Required |
| --- | --- | --- |
| `botToken` | OAuth & permissions → Bot user token (`xoxb-…`) | yes |
| `channel` | `#ops` or a channel id | yes |
| `signingSecret` | Basic information → App credentials | for inbound |
| `appToken` | socket mode only (`xapp-…`) | optional |

Env: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_CHANNEL`.
Note: Slack returns HTTP 200 with `{"ok":false}` on failure — the adapter treats that as failure.

> The environment-variable names below describe intended mappings; the gateway does not automatically import provider credentials from those variables. Configure channels through the authenticated gateway panel/API.

## SMS (Twilio; OpenSMS not implemented)
| Field | Where to get it | Required |
| --- | --- | --- |
| `accountSid` | console dashboard | yes |
| `authToken` | console dashboard (also verifies webhooks) | yes |
| `from` | a provisioned sender number | yes |
| `to` | on-call number | yes |
| `baseUrl` | only `https://api.twilio.com` is allowed (default) | optional |
| `webhookUrl` | the exact public URL Twilio posts to — part of the signature | for inbound |

Env: `SMS_BASE_URL`, `SMS_ACCOUNT_SID`, `SMS_AUTH_TOKEN`, `SMS_FROM`.
Note: Twilio signs URL + params sorted alphabetically; the URL must match exactly (scheme, host, path).

## Browser
| Field | Where to get it | Required |
| --- | --- | --- |
| `vapidPublic` | generate a VAPID key pair | only for push outside the open tab |
| `quietHours` | your policy, e.g. `22:00-07:00` | optional |

The in-app inbox works with no configuration at all.

## Storage and handling rules

1. **Never paste secrets into the Copilot** — it refuses them by design; use the panel.
2. The panel masks stored secrets (`••••last4`) and never echoes the value back.
3. Any credential change clears the verification badge until a new live test passes.
4. Current build: credentials are stored in the browser's local store for the signed-in workspace.
   The planned `comms_channels` table stores them server-side encrypted with `SWARMOS_SECRET`, and
   then the browser copy is deleted — see the roadmap in [`channels.md`](channels.md).
5. Rotate a token → save the new value → run **Send test** before re-enabling the channel.
