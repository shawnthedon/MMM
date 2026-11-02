# Copilot — the conversation is real (M30)

| Field | Value |
| --- | --- |
| Parent spec | `MMM-Copilot-Design-Spec-2026-11-01.md` §2 (conversation), §9 (permissions), §11 (copy) |
| Unit | 1 of 6 — **conversation** (unit 2, agent drafts, shipped as M31: [`agent-drafts.md`](agent-drafts.md)) |
| Baseline | `a140b8d` → branch `arena/db668586-mmm` |
| Files | `apps/gateway/migrations/011_copilot.sql`, `apps/gateway/src/copilot.js`, `apps/gateway/server.js`, `apps/gateway/src/rbac.js`, `apps/gateway/src/chat.js`, `src/copilot/conversation.js`, `src/copilot/panel.js`, `src/copilot/capabilities.js`, `src/copilot.css`, `src/api.js` |
| Evidence | `npm run test:copilot-api` (**19 passed**, real gateway + real loopback OpenAI-compatible provider) · `npm run test:copilot:ui` (**8 passed**) · `npm run test:copilot:browser` (**8 passed** in real Chromium) · `npm run test:copilot` (6, unchanged) · `npm run test:honesty` (13) · `npm test` (41 suites) · `npm run build` |
| Status | **PASS for the conversation scope.** Agent drafts (unit 2) shipped afterwards as M31 and are documented separately; swarm-plan drafts, browser JSON and voice are *not* built yet and the panel says so. |

---

## 1. What changed, and why the old Copilot had to go

The Copilot was 1,282 lines of `switch (mode)`: seven mode tabs, a `SUGGESTIONS` table per mode, and a
`handle()` that matched keywords against reviewed knowledge and live app state. It was honest — every
answer was labelled "deterministic, no model call" — but it could not hold a conversation: no memory of
what you asked, no follow-ups, no way to say something the knowledge pack had not anticipated.

Three things in the build made a real conversation possible without inventing a second model path:

1. `apps/gateway/src/models.js` — one funnel that already owns key unsealing, budget checks, timeouts,
   response caps, cost estimation and the `model_calls` ledger (M29).
2. The provider key is **already sealed on the Models screen**. Copilot asks for nothing new: a second key
   would be a second thing to leak, and a second place to look when the bill arrives.
3. `messages` already exists (M25) with idempotency (`client_id`) and an audit trail.

## 2. Data model (`011_copilot.sql`)

```
threads.owner_id     -- one Copilot conversation per principal; NULL for the older chat threads
messages.model_call_id -- the ledger row that produced this turn; NULL for anything a human typed
settings             -- copilot.provider / copilot.model: which provider the Copilot uses (Owner-set)
```

`owner_id` is what makes a conversation *yours*: the thread id never comes from a request body, so
guessing another principal's id gets you your own thread, not their transcript. `model_call_id` is the
provenance join — every assistant turn points at a row in `model_calls` with its tokens, latency, cost and
status. There is exactly one insert path (`insertMessage`) and it **throws** if an agent turn arrives
without a call id, so a reply cannot exist without the metered call that made it.

Copilot threads are excluded from `GET /threads` (`kind <> 'copilot'`). Mixing them in would have put a
model-written turn inside the Chat screen, whose runtime banner still says, truthfully, that it generates
no replies.

## 3. Routes

| Route | Permission | Notes |
| --- | --- | --- |
| `GET /api/v1/copilot` | `copilot:read` (Observer+) | Your conversation and the runtime status |
| `POST /api/v1/copilot/messages` | `copilot:write` (Operator+) | One turn; 30/min per principal; idempotent on `clientId` |
| `DELETE /api/v1/copilot` | `copilot:write` | Deletes **only your own** turns, returns the count |
| `GET /api/v1/copilot/runtime` | `copilot:read` | What can answer, and why not if it cannot |
| `PUT /api/v1/copilot/model` | `copilot:model` (**Owner**) | Same rank as installing the key it depends on |

Sending is Operator+ because **every turn is a metered call**: it spends money. Reading is Observer,
because reading your own transcript spends nothing. WS topic `copilot` for the fan-out.

## 4. One turn, in order

1. Validate the text; look up (or create) *your* thread.
2. Store your message. It is stored even if the answer fails — losing what you typed because the provider
   was down would be the worst possible behaviour.
3. Resolve the model: the setting, else the first provider with a sealed key and a `default_model`.
4. **No model → refuse.** `409 { code: 'no-model', runtime }`, nothing sent, **no assistant row**. The
   panel shows the server's own words. There is no fallback to the deterministic engine, because a person
   who asked a model a question must not be answered by a keyword matcher wearing the model's name.
5. `models.callModel(...)` with `purpose: 'copilot'`, the system brief, and the stored history.
6. Store the reply with its `callId` and `{ model, promptTokens, completionTokens, costUsd,
   costBasis: 'estimated', latencyMs, callId }`.
7. Audit `copilot.reply` with **lengths only** — never the question, never the answer.

History is the last 24 turns / 12,000 characters, oldest first, system rows skipped, and the new message
appears exactly once (the stored row is excluded from the history query, then appended).

## 5. What the panel shows

Two things are decided separately, because they have different answers: **where the reply comes from**
(`live` model / `local` built-in engine) and **what the gateway says about models** (`ready`, `unready`,
`unavailable`, `error`, or `demo` with no gateway). Deriving the second into the first is what keeps the
panel from claiming either a conversation it does not have, or ignorance it does not have:

| Gateway | Reply source | What the panel shows |
| --- | --- | --- |
| none (`demo`) | local engine | Mode tabs, every answer's meta line *"demo answer, no model called"* |
| routes but no sealed key (`unready`) | local engine | Mode tabs **plus** a notice: no provider has a sealed key, no model is called, and this conversation stays in this browser · *Install a provider key* |
| a sealed key (`ready`) | **the model** | Provider · model · `cost estimated` · *New conversation*; no mode tabs (nothing to choose when you can just talk) |
| no Copilot routes (`unavailable`) | local engine | A notice that the gateway has no conversation route, so nothing leaves the browser |
| read failed (`error`) | local engine | The error, and the same statement that answers are local |

- Each **live** reply's meta line carries the model, `in / out` tokens, the estimated cost, latency and
  `call #<id>`; each local reply says, on its own line, that no model was called.
- A gateway without a model is deliberately still *useful*: the deterministic engine, the action cards and
  their gateway writes keep working exactly as before. Only turning the conversation into a model
  conversation requires a key — which is the whole point of not shipping a second key.
- Pending state distinguishes *Working…* (local) from *Waiting for the model…* (live); Stop aborts the
  request instead of leaving a spinner. Clearing takes two taps and deletes on the server.

## 6. The system brief

The prompt states the build's limits as facts, not as suggestions: no agent runtime executes anything, no
workflow engine exists, a draft is a draft until a different principal approves it, and — in capitals,
because models like to be helpful — it must never claim to have performed an action it has not performed.
Since unit 4 it also says that approving a browser script *is* the run, and since unit 5 that whether a
local speech host exists is a deployment fact the model must not assume. Permissions are enforced
by RBAC in `server.js`, never by this text: the brief exists to shape tone, not to hold a lock.

## 7. What the browser proved

`npm run test:copilot:browser` drives real Chromium (390 px, then 320 px) against a real gateway and a
real loopback OpenAI-compatible provider, and performs the loop a person performs:

1. Before a key: the panel is `data-source="local"`, `data-gateway="unready"`, the mode tabs are present,
   the notice reads *"No model is configured, so nothing here is model-written"*, and a question gets a
   built-in answer whose meta line says no model was called. The provider is contacted **zero** times.
2. The key is sealed through the real Models sheet.
3. The panel becomes `data-source="live"`, `data-gateway="ready"`, **no mode buttons exist**, the reply is
   the provider's own text, and its meta line reads `240 in / 40 out · $… est. · call #N`.
4. The provider received `Authorization: Bearer …` for the configured model and the question that was typed.
5. The reply is in `messages` pointing at a `model_calls` row with `purpose='copilot'`, in a `copilot`
   thread owned by a principal.
6. Reload: the question and the answer are still there — they were never in the panel.
7. At 320 px nothing overflows and every visible control is ≥ 44 px; no page errors.

## 8. Honest limits

- **No streaming.** A turn resolves when the whole reply arrives; Stop cancels the request.
- **A live conversation produces drafts, never live objects.** Unit 2 (agent drafts), unit 3 (swarm-plan
  drafts) and unit 4 (browser scripts) landed after this one; each is a validated row behind a real gate,
  and the system brief says so rather than letting the model imply otherwise.
- **A live conversation is model-only.** When the model is what answers, the old deterministic action
  cards are not offered on that turn, because two answers to one message is not a conversation.
- **No streaming and no tool calls.** Multi-turn context only, plus one artefact: **agent drafts** (unit 2,
  [`agent-drafts.md`](agent-drafts.md)). A draft is validated on the gateway and needs another principal's
  approval before it can become an idle definition. Units 3 and 4 landed afterwards — swarm-plan drafts
  ([`swarm-plan-drafts.md`](swarm-plan-drafts.md)), Agent Browser JSON from a sentence
  ([`browser-scripts.md`](browser-scripts.md)) — which runs only through the real approval gate — and local
  voice input ([`voice-input.md`](voice-input.md)).
- **Cost is an estimate** from a price table, never an invoice.
- **The `llm` capability now reads the runtime.** It says `available` only when the gateway reports a
  provider with a sealed key, `not configured` when the gateway exists without one, and `unverified` in
  demo mode. It is a fact about *this install*, not a marketing claim.
