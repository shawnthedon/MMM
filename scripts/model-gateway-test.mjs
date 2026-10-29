/* Real model gateway contract tests.
 * Exercises authenticated HTTP against an isolated gateway and injects provider responses
 * through the gateway's existing test seam. No external network calls are made.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'mmm-model-gateway-'));
process.env.DATA_DIR = DATA_DIR;
process.env.MMM_QUIET = '1';
process.env.MMM_BOOTSTRAP_EMAIL = 'owner@test.local';
process.env.MMM_BOOTSTRAP_PASSWORD = 'OwnerPassw0rd!2026';
process.env.NODE_ENV = 'test';
delete process.env.MMM_LLM_BASE_URL;
delete process.env.MMM_LLM_API_KEY;
delete process.env.MMM_LLM_MODEL;

const { createGateway } = await import('../apps/gateway/server.js');
const auth = await import('../apps/gateway/src/auth.js');
const gateway = createGateway();
await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${gateway.server.address().port}`;

function client() {
  const jar = {};
  return {
    async request(path, { method = 'GET', body, csrf = false } = {}) {
      const headers = {};
      if (body !== undefined) headers['content-type'] = 'application/json';
      const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) headers.cookie = cookie;
      if (csrf && jar[auth.CSRF_HEADER]) headers[auth.CSRF_HEADER] = jar[auth.CSRF_HEADER];
      const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      for (const raw of response.headers.getSetCookie?.() || []) {
        const [pair] = raw.split(';');
        const idx = pair.indexOf('=');
        jar[pair.slice(0, idx)] = decodeURIComponent(pair.slice(idx + 1));
      }
      const text = await response.text();
      let payload = null;
      try { payload = JSON.parse(text); } catch {}
      return { status: response.status, payload, text };
    },
    async login() {
      const result = await this.request('/api/v1/auth/login', { method: 'POST', body: { email: 'owner@test.local', password: 'OwnerPassw0rd!2026' } });
      if (result.status === 200) jar[auth.CSRF_HEADER] = result.payload.csrfToken;
      return result;
    },
  };
}

const owner = client();
let providerCalls = 0;
let capturedRequest = null;
gateway.setFetch(async (url, init) => {
  providerCalls += 1;
  capturedRequest = { url: String(url), init };
  return new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: 'A real provider response.' } }],
    usage: { prompt_tokens: 11, completion_tokens: 6 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
});

try {
  const login = await owner.login();
  assert.equal(login.status, 200, 'owner login should succeed');

  const unauth = await client().request('/api/v1/chat/completions', { method: 'POST', body: { messages: [{ role: 'user', content: 'hello' }] } });
  assert.equal(unauth.status, 401, 'anonymous model calls must be rejected');

  const missingConfig = await owner.request('/api/v1/chat/completions', {
    method: 'POST', csrf: true, body: { messages: [{ role: 'user', content: 'hello' }] },
  });
  assert.equal(missingConfig.status, 503, 'missing model config must report unconfigured');
  assert.equal(providerCalls, 0, 'must not contact provider without configuration');

  const badMessages = await owner.request('/api/v1/chat/completions', { method: 'POST', csrf: true, body: { messages: [] } });
  assert.equal(badMessages.status, 400, 'empty messages must be rejected');

  process.env.MMM_LLM_BASE_URL = 'https://models.example.test/v1';
  process.env.MMM_LLM_API_KEY = 'test-secret-never-returned';
  process.env.MMM_LLM_MODEL = 'test-model';
  const result = await owner.request('/api/v1/chat/completions', {
    method: 'POST', csrf: true, body: { messages: [{ role: 'user', content: 'hello' }] },
  });
  assert.equal(result.status, 200, 'configured model call should succeed');
  assert.equal(result.payload.message, 'A real provider response.');
  assert.equal(result.payload.usage.promptTokens, 11);
  assert.equal(providerCalls, 1);
  assert.equal(capturedRequest.url, 'https://models.example.test/v1/chat/completions');
  assert.equal(capturedRequest.init.redirect, 'error', 'provider redirects must be rejected');
  assert.equal(capturedRequest.init.headers.authorization, 'Bearer test-secret-never-returned');
  assert.ok(!result.text.includes('test-secret-never-returned'), 'server secret must never be returned');

  process.env.MMM_LLM_BASE_URL = 'http://attacker.example.test/v1';
  const unsafe = await owner.request('/api/v1/chat/completions', {
    method: 'POST', csrf: true, body: { messages: [{ role: 'user', content: 'hello' }] },
  });
  assert.equal(unsafe.status, 503, 'non-local HTTP provider URLs must be rejected');
  assert.equal(providerCalls, 1, 'unsafe URL must not contact provider');

  console.log('MODEL GATEWAY: auth, CSRF, validation, missing config, real provider adapter contract, usage, secret isolation and URL safety passed');
} finally {
  gateway.server.close();
  gateway.wss.close();
  rmSync(DATA_DIR, { recursive: true, force: true });
}
