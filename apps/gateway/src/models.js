/* ============ Model gateway — one real adapter, sealed keys, a metered ledger ============
 * The Models screen used to be a catalogue describing a gateway that did not exist: a per-provider on/off
 * switch, `spend_mtd` typed into fixtures, a key vault that was never built. This module is that gateway,
 * scoped to what can be proven:
 *
 *   • KEYS     — sealed at rest with AES-256-GCM (`secrets.js`), never read back, never logged, never in
 *                an audit row. A read returns a fingerprint and a four-character hint, nothing else.
 *   • CALLS    — one OpenAI-compatible adapter. Real HTTP, real timeout, no redirects, no proxy, size and
 *                time caps. A call either happened and was metered, or it did not happen and the ledger
 *                says why.
 *   • MONEY    — every attempt writes a `model_calls` row. Spend is `SUM(cost_usd) WHERE status='ok'`;
 *                a budget refusal is `status='blocked'` with zero cost, so it can never inflate spend.
 *   • HONESTY  — `runtimeStatus()` states what is real: no model is called unless an Owner sealed a key,
 *                cost is *estimated* from a price table, and an unconfigured provider is `unconfigured`,
 *                not "off".
 *
 * What it deliberately does not do: stream, retry blindly, or trust a provider's response shape. A
 * malformed body is an error with the reason, not an empty success.
 */
import { db, audit, logEvent } from './db.js';
import { seal, unseal, fingerprint, hint, keySource, warnIfGenerated } from './secrets.js';

export const KEY_PURPOSE = 'provider-key-v1';

/** Price table, USD per million tokens. Estimates only — the provider's invoice is the real number. */
const PRICES = Object.freeze({
  'gpt-4o': [2.5, 10],
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4.1': [2, 8],
  'gpt-5': [5, 15],
  'claude': [3, 15],
  'deepseek': [0.27, 1.1],
  'llama': [0.2, 0.6],
  'mistral': [0.4, 1.2],
  'qwen': [0.3, 1.2],
  'default': [1, 3],
});

const LIMITS = {
  key: 512,
  baseUrl: 300,
  model: 120,
  maxTokens: 4096,
  promptChars: 20000,
  timeoutMs: 60000,
  defaultTimeoutMs: 30000,
  responseBytes: 256 * 1024,
  purpose: 60,
  listDays: 90,
};

const fail = (code, message, extra = {}) => {
  throw Object.assign(new Error(message), { code, ...extra });
};

const now = () => Date.now();
const parse = (value, fallback) => {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
};

/** Start of the current UTC day — the window a daily budget applies to. */
export function dayStart(at = now()) {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/* =========================================================================================
 * Budget
 * =======================================================================================*/
export const DEFAULT_BUDGET = Object.freeze({ dailyUsd: 5, perCallUsd: 0.5, enforced: true });

export function getBudget() {
  const row = db.prepare("SELECT value FROM settings WHERE key='models.budget'").get();
  const stored = parse(row?.value, {});
  const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : fallback);
  return {
    dailyUsd: num(stored.dailyUsd, DEFAULT_BUDGET.dailyUsd),
    perCallUsd: num(stored.perCallUsd, DEFAULT_BUDGET.perCallUsd),
    enforced: stored.enforced === undefined ? DEFAULT_BUDGET.enforced : Boolean(stored.enforced),
  };
}

export function setBudget(body = {}, principal = 'system') {
  const current = getBudget();
  const num = (value, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) fail('bad-request', 'a budget must be a number of zero or more');
    if (n > 10000) fail('bad-request', 'a budget above 10000 USD is refused');
    return Math.round(n * 100) / 100;
  };
  const next = {
    dailyUsd: num(body.dailyUsd, current.dailyUsd),
    perCallUsd: num(body.perCallUsd, current.perCallUsd),
    enforced: body.enforced === undefined ? current.enforced : Boolean(body.enforced),
  };
  if (next.perCallUsd > next.dailyUsd) fail('bad-request', 'a per-call cap above the daily cap would never be reachable');
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('models.budget', ?)").run(JSON.stringify(next));
  audit(principal, 'api', 'models.budget', { ...next }, 'allow', 'ok');
  logEvent('model', `Model budget set: ${next.dailyUsd} USD/day, ${next.perCallUsd} USD/call${next.enforced ? '' : ' (not enforced)'}`);
  return next;
}

/** Spend today, from the ledger. Only calls that happened count. */
export function spendToday(at = now()) {
  const row = db.prepare(
    "SELECT COALESCE(SUM(cost_usd),0) AS usd, COUNT(*) AS calls FROM model_calls WHERE status='ok' AND ts >= ?"
  ).get(dayStart(at));
  return { usd: Math.round(Number(row.usd) * 1e6) / 1e6, calls: Number(row.calls) || 0 };
}

/* =========================================================================================
 * Providers
 * =======================================================================================*/
export const runtimeStatus = () => ({
  adapter: 'openai-compatible',
  streaming: false,
  providerCount: db.prepare('SELECT COUNT(*) n FROM providers').get().n,
  configuredCount: db.prepare("SELECT COUNT(*) n FROM providers WHERE key_sealed<>''").get().n,
  keySource: keySource(),
  costBasis: 'estimated',
  note:
    'A model is called only when an Owner has sealed a provider key on this gateway. Cost is estimated ' +
    'from a price table, not an invoice; prompts and replies are never stored.',
});

function providerRow(id) {
  const row = db.prepare('SELECT * FROM providers WHERE id=?').get(String(id || ''));
  if (!row) fail('not-found', `provider “${id}” is not in the catalogue`);
  return row;
}

/** Public shape. Note what is absent: the sealed key, the plaintext, and any way to recover either. */
export function publicProvider(row) {
  const models = parse(row.models, []);
  const configured = Boolean(row.key_sealed) && Boolean(row.endpoint);
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    auth: row.auth,
    models: Array.isArray(models) ? models : [],
    defaultModel: row.default_model || (Array.isArray(models) ? models[0] : '') || '',
    status: configured ? 'configured' : 'unconfigured',
    endpoint: configured ? row.endpoint : '',
    endpointHost: configured ? hostOf(row.endpoint) : '',
    fingerprint: row.key_fingerprint || '',
    hint: row.key_hint || '',
    configuredAt: row.configured_at || null,
    configuredBy: row.configured_by || '',
    // Real, from the ledger — never the fixture column.
    spendMtd: Math.round(Number(db.prepare(
      "SELECT COALESCE(SUM(cost_usd),0) AS usd FROM model_calls WHERE status='ok' AND provider_id=? AND ts >= ?"
    ).get(row.id, now() - 30 * 86400000).usd) * 1e6) / 1e6,
    callsMtd: Number(db.prepare(
      "SELECT COUNT(*) n FROM model_calls WHERE status='ok' AND provider_id=? AND ts >= ?"
    ).get(row.id, now() - 30 * 86400000).n) || 0,
    lastCallAt: Number(db.prepare(
      "SELECT MAX(ts) AS ts FROM model_calls WHERE status='ok' AND provider_id=?"
    ).get(row.id).ts) || null,
  };
}

export function listProviders() {
  const rows = db.prepare('SELECT * FROM providers ORDER BY category, name COLLATE NOCASE').all();
  const budget = getBudget();
  const spent = spendToday();
  return {
    providers: rows.map(publicProvider),
    budget: { ...budget, spentTodayUsd: spent.usd, callsToday: spent.calls, remainingUsd: Math.max(0, Math.round((budget.dailyUsd - spent.usd) * 1e6) / 1e6) },
    runtime: runtimeStatus(),
  };
}

export const getProvider = (id) => publicProvider(providerRow(id));

function hostOf(url) {
  try { return new URL(String(url)).host; } catch { return ''; }
}

/* ---------- endpoint policy ----------
 * This gateway makes outbound requests on behalf of a user, so the destination is checked, not trusted:
 *   • http(s) only, no credentials in the URL, no query, no fragment;
 *   • plain http only for loopback (a local model server) — anything else must be TLS;
 *   • no redirects followed, a size cap and a timeout on the response.
 */
export function checkEndpoint(raw) {
  const text = String(raw || '').trim();
  if (!text) fail('bad-request', 'an endpoint is required, e.g. https://api.openai.com/v1');
  if (text.length > LIMITS.baseUrl) fail('bad-request', 'that endpoint is too long');
  let url;
  try { url = new URL(text); } catch { fail('bad-request', 'the endpoint is not a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) fail('bad-request', 'the endpoint must be http or https');
  if (url.username || url.password) fail('bad-request', 'credentials must not be embedded in the endpoint URL');
  if (url.search || url.hash) fail('bad-request', 'the endpoint must not carry a query string or fragment');
  const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol === 'http:' && !loopback) {
    fail('bad-request', 'plain http is only allowed for a loopback endpoint; use https for a remote provider');
  }
  return { url: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, host: url.host, loopback };
}

/** Validate a key without storing it. Rejects whitespace and control characters, which are never valid. */
function checkKey(raw) {
  const text = String(raw || '').trim();
  if (!text) fail('bad-request', 'an API key is required');
  if (text.length > LIMITS.key) fail('bad-request', `an API key longer than ${LIMITS.key} characters is refused`);
  if (/[\s\u0000-\u001f\u007f]/.test(text)) fail('bad-request', 'an API key cannot contain whitespace or control characters');
  return text;
}

/**
 * Seal a provider key. The plaintext is used once, here, and never returned: the response carries a
 * fingerprint and a four-character hint so the UI can say *which* key is installed.
 */
export function saveProviderKey(id, body = {}, principal = 'system', via = 'api') {
  const row = providerRow(id);
  const apiKey = checkKey(body.apiKey ?? body.key);
  const endpoint = checkEndpoint(body.baseUrl ?? body.endpoint ?? row.endpoint);
  const model = String(body.defaultModel ?? body.model ?? '').trim().slice(0, LIMITS.model);
  const sealed = seal({ apiKey }, { purpose: KEY_PURPOSE });
  const print = fingerprint(apiKey);
  const tail = hint(apiKey);
  const at = now();
  db.prepare(`UPDATE providers SET key_sealed=?, key_fingerprint=?, key_hint=?, endpoint=?, default_model=?, configured_at=?, configured_by=?, updated_at=?, status='on'
              WHERE id=?`)
    .run(sealed, print, tail, endpoint.url, model || row.default_model || '', at, principal, at, row.id);
  // The audit row records *that* a key was installed and which one — never the key, and never the sealed
  // blob (it is ciphertext, but there is no reason to copy it into a second table).
  audit(principal, via, 'models.key.set', { provider: row.id, fingerprint: print, endpointHost: endpoint.host, model }, 'allow', 'ok');
  logEvent('model', `Provider key sealed for ${row.name} (${print})`);
  warnIfGenerated();
  return getProvider(row.id);
}

export function clearProviderKey(id, principal = 'system', via = 'api') {
  const row = providerRow(id);
  const had = Boolean(row.key_sealed);
  db.prepare(`UPDATE providers SET key_sealed='', key_fingerprint='', key_hint='', configured_at=NULL, configured_by='', updated_at=?, status='off'
              WHERE id=?`).run(now(), row.id);
  if (!had) return { provider: getProvider(row.id), cleared: false };
  audit(principal, via, 'models.key.clear', { provider: row.id, fingerprint: row.key_fingerprint }, 'allow', 'ok');
  logEvent('model', `Provider key removed for ${row.name}`);
  return { provider: getProvider(row.id), cleared: true };
}

/** Read the sealed key back for a call. The plaintext exists only inside `callModel`. */
function openKey(row) {
  const opened = unseal(row.key_sealed, { purpose: KEY_PURPOSE });
  if (!opened?.apiKey) {
    fail('conflict', 'the sealed key cannot be opened with this gateway’s key material — re-enter it');
  }
  return opened.apiKey;
}

/* =========================================================================================
 * Cost
 * =======================================================================================*/
export function priceFor(model) {
  const name = String(model || '').toLowerCase();
  const hit = Object.keys(PRICES).find((k) => k !== 'default' && name.includes(k));
  const [input, output] = PRICES[hit || 'default'];
  return { inputPerMTok: input, outputPerMTok: output, basis: 'estimated' };
}

export function estimateCost(model, promptTokens, completionTokens) {
  const price = priceFor(model);
  const usd = (promptTokens / 1e6) * price.inputPerMTok + (completionTokens / 1e6) * price.outputPerMTok;
  return Math.round(usd * 1e8) / 1e8;
}

/* =========================================================================================
 * The call
 * =======================================================================================*/
function record({ principal, via, providerId, model, purpose, status, errorCode = '', promptTokens = 0, completionTokens = 0, cost = 0, latencyMs = 0, requestId = '', replyChars = 0 }) {
  const ts = now();
  const total = promptTokens + completionTokens;
  const info = db.prepare(`INSERT INTO model_calls
    (ts,principal_id,via,provider_id,model,purpose,status,error_code,prompt_tokens,completion_tokens,total_tokens,cost_usd,cost_estimated,latency_ms,request_id,reply_chars)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ts, principal, via, providerId, model, purpose, status, errorCode, promptTokens, completionTokens, total, cost, 1, latencyMs, requestId, replyChars);
  return Number(info.lastInsertRowid ?? info.changes ?? 0);
}

/**
 * One model call. Everything that can be refused is refused *before* the request leaves the process, and
 * a refusal is written to the ledger with zero cost so the spend number stays a number that happened.
 */
export async function callModel({ providerId, model, messages, purpose = '', maxTokens, principal = 'system', via = 'api', timeoutMs } = {}) {
  const row = providerRow(providerId);
  const label = purpose ? String(purpose).slice(0, LIMITS.purpose) : 'chat';
  const refuse = (code, message, status = 'blocked') => {
    record({ principal, via, providerId: row.id, model: model || row.default_model, purpose: label, status, errorCode: code });
    fail(code, message);
  };

  if (!row.key_sealed || !row.endpoint) {
    refuse('unconfigured', `${row.name} has no sealed key on this gateway, so no model is called`, 'blocked');
  }
  const apiKey = openKey(row); // throws 'conflict' when the material changed

  const chosen = String(model || row.default_model || '').trim();
  if (!chosen) refuse('bad-request', 'no model was chosen and this provider has no default');
  // The catalogue's model list is a suggestion, not a contract — a fixture (or a year-old note) is not
  // evidence about what a provider serves today, so a call is not restricted to it. The provider is
  // the authority: an unknown id comes back as its own error, which is recorded like any other.
  if (chosen.length > LIMITS.model) refuse('bad-request', `a model id longer than ${LIMITS.model} characters is refused`);
  if (/[\s\u0000-\u001f\u007f]/.test(chosen)) refuse('bad-request', 'a model id cannot contain whitespace or control characters');

  const turns = Array.isArray(messages) ? messages : [];
  if (!turns.length) refuse('bad-request', 'a call needs at least one message');
  const clean = turns.slice(0, 50).map((m) => ({
    role: ['system', 'user', 'assistant'].includes(m?.role) ? m.role : 'user',
    content: String(m?.content ?? '').slice(0, LIMITS.promptChars),
  }));
  if (!clean.some((m) => m.content.trim())) refuse('bad-request', 'the message is empty');

  const budget = getBudget();
  const spent = spendToday();
  if (budget.enforced) {
    if (spent.usd >= budget.dailyUsd) {
      refuse('budget-exceeded', `today’s model budget is spent (${spent.usd.toFixed(2)} of ${budget.dailyUsd.toFixed(2)} USD) — nothing was sent`);
    }
    if (budget.perCallUsd <= 0) refuse('budget-exceeded', 'the per-call cap is zero, so no call is allowed');
  }

  const tokens = Math.min(Math.max(Number(maxTokens) || 512, 1), LIMITS.maxTokens);
  const endpoint = checkEndpoint(`${row.endpoint}/chat/completions`);
  const ms = Math.min(Math.max(Number(timeoutMs) || LIMITS.defaultTimeoutMs, 1000), LIMITS.timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const startedAt = Date.now();
  let res;
  try {
    res = await fetch(endpoint.url, {
      method: 'POST',
      redirect: 'manual', // a redirect would send the key somewhere else
      signal: controller.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: chosen, messages: clean, max_tokens: tokens }),
    });
  } catch (error) {
    clearTimeout(timer);
    const timedOut = error?.name === 'AbortError';
    record({ principal, via, providerId: row.id, model: chosen, purpose: label, status: 'error', errorCode: timedOut ? 'timeout' : 'network', latencyMs: Date.now() - startedAt });
    fail(timedOut ? 'timeout' : 'network', timedOut
      ? `the provider did not answer within ${ms} ms — nothing was billed by us, and the ledger records the attempt`
      : `could not reach ${endpoint.host}: ${error.message}`);
  }
  clearTimeout(timer);
  const latencyMs = Date.now() - startedAt;

  if (res.status >= 300 && res.status < 400) {
    record({ principal, via, providerId: row.id, model: chosen, purpose: label, status: 'error', errorCode: 'redirect', latencyMs });
    fail('bad-gateway', `the provider answered with a redirect (HTTP ${res.status}); redirects are not followed, so the key is not sent anywhere else`);
  }
  if (!res.ok) {
    // Read a bounded amount of the error body for the message; never echo an auth header back.
    const text = await res.text().catch(() => '');
    record({ principal, via, providerId: row.id, model: chosen, purpose: label, status: 'error', errorCode: `http-${res.status}`, latencyMs });
    fail('provider-error', `${row.name} answered HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }

  const reader = res.body?.getReader?.();
  let raw = '';
  if (reader) {
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > LIMITS.responseBytes) {
        record({ principal, via, providerId: row.id, model: chosen, purpose: label, status: 'error', errorCode: 'response-too-large', latencyMs });
        try { await reader.cancel(); } catch { /* ignore */ }
        fail('bad-gateway', `the provider response exceeded ${LIMITS.responseBytes} bytes and was abandoned`);
      }
      raw += Buffer.from(value).toString('utf8');
    }
  } else {
    raw = await res.text();
    if (raw.length > LIMITS.responseBytes) fail('bad-gateway', 'the provider response was too large');
  }

  let payload = null;
  try { payload = JSON.parse(raw); } catch {
    record({ principal, via, providerId: row.id, model: chosen, purpose: label, status: 'error', errorCode: 'bad-json', latencyMs });
    fail('bad-gateway', 'the provider did not return JSON — nothing is recorded as a successful call');
  }
  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    record({ principal, via, providerId: row.id, model: chosen, purpose: label, status: 'error', errorCode: 'no-content', latencyMs });
    fail('bad-gateway', 'the provider returned no message content');
  }

  const promptTokens = Number(payload?.usage?.prompt_tokens) || 0;
  const completionTokens = Number(payload?.usage?.completion_tokens) || 0;
  const cost = estimateCost(payload?.model || chosen, promptTokens, completionTokens);
  const id = record({
    principal, via, providerId: row.id, model: payload?.model || chosen, purpose: label, status: 'ok',
    promptTokens, completionTokens, cost, latencyMs, requestId: String(res.headers.get('x-request-id') || '').slice(0, 64),
    replyChars: text.length,
  });

  // The ledger keeps lengths and money, not conversation.
  audit(principal, via, 'models.call', {
    provider: row.id, model: payload?.model || chosen, purpose: label, callId: id,
    tokens: promptTokens + completionTokens, costUsd: cost, estimated: true,
  }, 'allow', 'ok');

  return {
    callId: id,
    text,
    model: payload?.model || chosen,
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    costUsd: cost,
    costBasis: 'estimated',
    latencyMs,
    provider: publicProvider(providerRow(row.id)),
    budget: { ...getBudget(), spentTodayUsd: spendToday().usd },
  };
}

/* =========================================================================================
 * Ledger
 * =======================================================================================*/
export function usageSummary({ days = 14 } = {}) {
  const window = Math.min(Math.max(Number(days) || 14, 1), LIMITS.listDays);
  const since = dayStart(now() - (window - 1) * 86400000);
  const byDay = db.prepare(
    `SELECT ts, cost_usd, total_tokens, status FROM model_calls WHERE ts >= ? ORDER BY ts ASC`
  ).all(since).reduce((acc, row) => {
    const key = new Date(row.ts).toISOString().slice(0, 10);
    const bucket = (acc[key] ||= { day: key, usd: 0, tokens: 0, calls: 0, blocked: 0, errors: 0 });
    if (row.status === 'ok') { bucket.usd += Number(row.cost_usd) || 0; bucket.tokens += Number(row.total_tokens) || 0; bucket.calls += 1; }
    else if (row.status === 'blocked') bucket.blocked += 1;
    else bucket.errors += 1;
    return acc;
  }, {});
  const byProvider = db.prepare(
    `SELECT provider_id, COUNT(*) AS calls, COALESCE(SUM(cost_usd),0) AS usd
       FROM model_calls WHERE status='ok' AND ts >= ? GROUP BY provider_id ORDER BY usd DESC`
  ).all(since);
  const totals = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN status='ok' THEN cost_usd ELSE 0 END),0) AS usd,
       COALESCE(SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END),0) AS calls,
       COALESCE(SUM(CASE WHEN status='ok' THEN total_tokens ELSE 0 END),0) AS tokens,
       COALESCE(SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END),0) AS blocked,
       COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END),0) AS errors
     FROM model_calls WHERE ts >= ?`
  ).get(since);
  return {
    windowDays: window,
    since,
    days: Object.values(byDay).map((d) => ({ ...d, usd: Math.round(d.usd * 1e6) / 1e6 })),
    byProvider: byProvider.map((p) => ({ providerId: p.provider_id, calls: Number(p.calls), usd: Math.round(Number(p.usd) * 1e6) / 1e6 })),
    totals: {
      usd: Math.round(Number(totals.usd) * 1e6) / 1e6,
      calls: Number(totals.calls),
      tokens: Number(totals.tokens),
      blocked: Number(totals.blocked),
      errors: Number(totals.errors),
    },
    budget: { ...getBudget(), spentTodayUsd: spendToday().usd },
    today: spendToday(),
    costBasis: 'estimated',
    runtime: runtimeStatus(),
  };
}

/** Recent calls, without prompts or replies — the ledger is a meter, not a transcript. */
export function recentCalls({ limit = 20 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 200);
  return {
    calls: db.prepare(
      `SELECT id, ts, principal_id, provider_id, model, purpose, status, error_code, total_tokens, cost_usd, latency_ms
         FROM model_calls ORDER BY id DESC LIMIT ?`
    ).all(n).map((r) => ({
      id: r.id, ts: r.ts, principal: r.principal_id, providerId: r.provider_id, model: r.model,
      purpose: r.purpose, status: r.status, error: r.error_code, tokens: r.total_tokens,
      costUsd: r.cost_usd, latencyMs: r.latency_ms,
    })),
    runtime: runtimeStatus(),
  };
}
