# MMM Model Gateway Setup

This configures the first real AI path in MMM: Chat calls an OpenAI-compatible model endpoint through the Node gateway. It does not put provider keys in the browser.

## Required server environment

Set these variables on the machine/container running `apps/gateway/server.js`:

- `MMM_LLM_BASE_URL`: the provider's OpenAI-compatible API base URL, usually ending in `/v1`.
- `MMM_LLM_API_KEY`: the provider key. Keep it server-side; never paste it into the MMM browser UI or commit it to Git.
- `MMM_LLM_MODEL`: the exact model identifier accepted by that provider.

The gateway calls `<MMM_LLM_BASE_URL>/chat/completions`.

Example for an OpenAI-compatible local server running on the same machine as the MMM gateway:

```sh
MMM_LLM_BASE_URL=http://127.0.0.1:1234/v1
MMM_LLM_API_KEY=local-only-placeholder
MMM_LLM_MODEL=your-loaded-model-id
```

Replace the example values with the URL and model ID provided by your runtime. HTTP is accepted only for localhost addresses; non-local providers must use HTTPS. A cloud-hosted MMM gateway cannot use `127.0.0.1` to reach a model running on your phone—those are different machines. On-device inference needs its own local runtime/bridge implementation and is not proven by this configuration alone.

## Current behavior

- When no model is configured, Chat returns an explicit `503` configuration message. It does not generate a canned reply.
- Provider credentials remain on the server and are never returned to the client.
- Provider calls have a timeout, reject redirects, validate message roles and sizes, and write a redacted audit event.
- This first slice is non-streaming and uses the OpenAI-compatible `chat/completions` response shape.
- It does not yet persist chat threads/messages in the gateway database, support provider failover, or prove that a provider key is valid until a real call succeeds.

## Verify

Run:

```sh
npm run test:model-gateway
npm run build
```

The model gateway test uses a controlled provider response through the existing test seam and does not make a paid/external model request. A successful test proves the gateway contract and security boundaries, not that your chosen provider credentials work. After setting the environment, send a real test prompt from Chat and confirm a real response arrives.
