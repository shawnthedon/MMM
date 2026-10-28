# Comms — communication gateways

**Panel:** `#/comms` · **Gateway:** `apps/gateway/src/comms.js` and `apps/gateway/server.js` ·
**Client:** `src/commsGateway.js` and `src/commsAdapters.js`. The route and encryption details are in
[server-side.md](server-side.md); setup is in [credentials.md](credentials.md).

| Channel | Existing adapter | Inbound | Evidence and limitations |
| --- | --- | --- | --- |
| Telegram | Bot API `sendMessage` | webhook secret header | Controlled mocks; no live provider test |
| WhatsApp | Cloud API `/{phoneNumberId}/messages` | Meta app-secret HMAC-SHA256 and verify-token handshake | Controlled mocks; template selection not exposed |
| Discord | Bot API messages | Ed25519 interaction verification | Controlled tests; full interaction/ack contract not verified |
| Slack | `chat.postMessage` | v0 signing secret and 5-minute window | Controlled mocks; complete provider acknowledgement flow unverified |
| SMS | Twilio Messages API, official `https://api.twilio.com` only | Base64 HMAC-SHA1 over exact public URL and sorted form parameters | Controlled mocks; **OpenSMS is not implemented** |
| Browser | In-app delivery | no public webhook | Not browser automation; Web Push is not implemented |

Saving credentials is not verification. A successfully parsed provider acceptance response sets
`verifiedAt`; it does not prove final delivery. The gateway encrypts configured secrets at rest and
returns masked fields. Demo mode still stores demo credentials in the browser. With a configured
but unauthenticated gateway, writes and sends are blocked rather than silently stored locally.

Comms settings, channel enablement and routing in the panel use gateway write-through when in API
mode. Copilot channel mutations in API mode are blocked until server-side approval binding exists.
The provider webhook routes are public and authenticate their signatures, not a user's session;
`comms:write` protects authenticated settings/sends. Sender identity mapping, uniform rate limits,
external action approvals and production provider conformance still require work.

Run `npm run test:comms`, `npm run test:comms-gateway`, and `npm run test:provider-safety` for
controlled tests. None substitutes for live provider verification.
