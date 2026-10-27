/* ============ Comms adapters ============
 * One adapter per channel. Each adapter knows three things:
 *   buildSend(config, message) → { url, method, headers, body }   (pure, testable offline)
 *   verify(headers, rawBody, config) → boolean                    (inbound webhook authenticity)
 *   parse(...) / health(...)                                       (optional extras)
 *
 * `deliver()` executes a built request through an injected fetch, so the same code path runs
 * against the real provider and against a local mock server in the tests. Nothing here reports
 * success it did not observe: a 2xx provider response is required, and the caller stores it.
 */
import { getChannel, missingFields } from './commsChannels.js';

/* ---------- small crypto helpers (work in the browser and in Node ≥ 20) ---------- */
const enc = (v) => new TextEncoder().encode(String(v));
const hexToBytes = (hex) => Uint8Array.from(String(hex || '').replace(/[^0-9a-f]/gi, '').match(/.{2}/g)?.map((b) => parseInt(b, 16)) || []);
const bytesToHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const toHex = async (buf) => bytesToHex(buf);

async function hmac(algo, key, data) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto unavailable: cannot sign or verify this channel.');
  const k = await subtle.importKey('raw', typeof key === 'string' ? enc(key) : key, { name: 'HMAC', hash: algo }, false, ['sign']);
  return subtle.sign('HMAC', k, typeof data === 'string' ? enc(data) : data);
}

/** Constant-time-ish string compare (fixed length first, then byte compare). */
export function safeEqual(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

const header = (headers, name) => {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  const key = Object.keys(headers).find((k) => k.toLowerCase() === String(name).toLowerCase());
  return key ? headers[key] : '';
};

/* =========================================================================================
 * Adapters
 * =======================================================================================*/
export const ADAPTERS = {
  telegram: {
    id: 'telegram',
    verify(headers, rawBody, config) {
      const expected = config?.webhookSecret;
      if (!expected) return false;
      return safeEqual(header(headers, 'x-telegram-bot-api-secret-token'), expected);
    },
    buildSend(config, msg) {
      if (!config?.botToken || !config?.chatId) return { error: 'botToken and chatId are required' };
      return {
        url: `https://api.telegram.org/bot${config.botToken}/sendMessage`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { chat_id: config.chatId, text: msg.text, disable_web_page_preview: true },
      };
    },
    healthRequest(config) {
      return { url: `https://api.telegram.org/bot${config.botToken}/getMe`, method: 'GET', headers: {} };
    },
    parseInbound(body) {
      const m = body?.message || body?.edited_message || body?.callback_query?.message;
      if (!m) return null;
      return { text: m.text || body?.callback_query?.data || '', from: m.from?.username || m.chat?.id, chatId: m.chat?.id };
    },
  },

  whatsapp: {
    id: 'whatsapp',
    async verify(headers, rawBody, config) {
      const sig = header(headers, 'x-hub-signature-256');
      if (!sig || !config?.accessToken) return false;
      const digest = await hmac('SHA-256', config.accessToken, rawBody);
      return safeEqual(sig, `sha256=${await toHex(digest)}`);
    },
    buildSend(config, msg) {
      if (!config?.accessToken || !config?.phoneNumberId || !config?.recipient) {
        return { error: 'accessToken, phoneNumberId and recipient are required' };
      }
      const to = String(config.recipient).replace(/[^\d+]/g, '');
      return {
        url: `https://graph.facebook.com/v20.0/${config.phoneNumberId}/messages`,
        method: 'POST',
        headers: { authorization: `Bearer ${config.accessToken}`, 'content-type': 'application/json' },
        body: msg.template
          ? { messaging_product: 'whatsapp', to, type: 'template', template: { name: msg.template, language: { code: msg.locale || 'en' } } }
          : { messaging_product: 'whatsapp', to, type: 'text', text: { body: msg.text } },
      };
    },
    healthRequest(config) {
      return { url: `https://graph.facebook.com/v20.0/${config.phoneNumberId}?fields=verified_name,display_phone_number`, method: 'GET', headers: { authorization: `Bearer ${config.accessToken}` } };
    },
    parseInbound(body) {
      const entry = body?.entry?.[0]?.changes?.[0]?.value;
      const m = entry?.messages?.[0];
      if (!m) return null;
      return { text: m.text?.body || '', from: m.from, chatId: m.from };
    },
    /** Meta requires answering the GET verification handshake. */
    verifyHandshake(query, config) {
      return query?.['hub.mode'] === 'subscribe' && safeEqual(query?.['hub.verify_token'], config?.verifyToken);
    },
  },

  discord: {
    id: 'discord',
    async verify(headers, rawBody, config) {
      const sig = header(headers, 'x-signature-ed25519');
      const ts = header(headers, 'x-signature-timestamp');
      const key = config?.publicKey;
      if (!sig || !ts || !key) return false;
      const subtle = globalThis.crypto?.subtle;
      if (!subtle || !globalThis.crypto?.subtle) return false;
      try {
        const raw = typeof rawBody === 'string' ? enc(rawBody) : rawBody;
        const signed = new Uint8Array([...enc(ts), ...raw]);
        const k = await subtle.importKey('raw', hexToBytes(key), { name: 'Ed25519' }, false, ['verify']);
        return await subtle.verify({ name: 'Ed25519' }, k, hexToBytes(sig), signed);
      } catch {
        return false;
      }
    },
    buildSend(config, msg) {
      if (!config?.botToken || !config?.channelId) return { error: 'botToken and channelId are required' };
      return {
        url: `https://discord.com/api/v10/channels/${config.channelId}/messages`,
        method: 'POST',
        headers: { authorization: `Bot ${config.botToken}`, 'content-type': 'application/json' },
        body: { content: msg.text, allowed_mentions: { parse: [] } },
      };
    },
    healthRequest(config) {
      return { url: 'https://discord.com/api/v10/users/@me', method: 'GET', headers: { authorization: `Bot ${config.botToken}` } };
    },
    parseInbound(body) {
      if (!body || body.type !== 2) return null; // application command only
      const opt = (body.data?.options || []).find((o) => o.name === 'text');
      return { text: opt?.value || '', from: body.member?.user?.username || body.user?.username, chatId: body.channel_id };
    },
    /** Discord ends interaction reply rights after 15 minutes; defer politely. */
    ack: { type: 5 },
  },

  slack: {
    id: 'slack',
    async verify(headers, rawBody, config) {
      const sig = header(headers, 'x-slack-signature');
      const ts = header(headers, 'x-slack-request-timestamp');
      if (!sig || !ts || !config?.signingSecret) return false;
      const skew = Math.abs(Date.now() / 1000 - Number(ts));
      if (!Number.isFinite(skew) || skew > 300) return false; // replay window
      const body = typeof rawBody === 'string' ? rawBody : new TextDecoder().decode(rawBody || new ArrayBuffer(0));
      const digest = await hmac('SHA-256', config.signingSecret, `v0:${ts}:${body}`);
      return safeEqual(sig, `v0=${await toHex(digest)}`);
    },
    buildSend(config, msg) {
      if (!config?.botToken || !config?.channel) return { error: 'botToken and channel are required' };
      return {
        url: 'https://slack.com/api/chat.postMessage',
        method: 'POST',
        headers: { authorization: `Bearer ${config.botToken}`, 'content-type': 'application/json' },
        body: { channel: config.channel, text: msg.text, unfurl_links: false },
      };
    },
    healthRequest(config) {
      return { url: 'https://slack.com/api/auth.test', method: 'POST', headers: { authorization: `Bearer ${config.botToken}`, 'content-type': 'application/json' }, body: {} };
    },
    parseInbound(body) {
      if (!body?.event || body.event.type !== 'message' || body.event.bot_id) return null;
      return { text: body.event.text || '', from: body.event.user, chatId: body.event.channel };
    },
    /** Slack answers are not `ok` via HTTP status: the payload carries ok:false. */
    isSuccess: (res) => res?.status >= 200 && res.status < 300 && (res.json?.ok !== false),
  },

  sms: {
    id: 'sms',
    async verify(headers, rawBody, config) {
      const sig = header(headers, 'x-twilio-signature');
      if (!sig || !config?.authToken) return false;
      // Twilio signs the full URL followed by the alphabetically sorted POST params.
      const params = typeof rawBody === 'string'
        ? Object.fromEntries(new URLSearchParams(rawBody).entries())
        : Object.fromEntries(Object.entries(rawBody || {}).map(([k, v]) => [k, String(v)]));
      const url = config.webhookUrl || '';
      const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
      const digest = await hmac('SHA-1', config.authToken, data);
      return safeEqual(sig, await toHex(digest));
    },
    buildSend(config, msg) {
      if (!config?.accountSid || !config?.authToken || !config?.from || !config?.to) {
        return { error: 'accountSid, authToken, from and to are required' };
      }
      const base = (config.baseUrl || 'https://api.twilio.com').replace(/\/$/, '');
      const auth = typeof btoa === 'function'
        ? btoa(`${config.accountSid}:${config.authToken}`)
        : Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');
      return {
        url: `${base}/2010-04-01/Accounts/${config.accountSid}/Messages.json`,
        method: 'POST',
        headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: config.to, From: config.from, Body: msg.text }).toString(),
      };
    },
    parseInbound(body) {
      if (!body?.Body) return null;
      return { text: body.Body, from: body.From, chatId: body.From };
    },
  },

  browser: {
    id: 'browser',
    verify() { return true; }, // same-origin session only; no webhook
    buildSend(_config, msg) {
      return { local: true, message: { title: msg.title || 'SwarmOS', text: msg.text, ts: Date.now() } };
    },
    parseInbound(body) {
      return body?.text ? { text: body.text, from: 'browser', chatId: 'inbox' } : null;
    },
  },
};

export const adapterFor = (channelId) => ADAPTERS[channelId] || null;

/* =========================================================================================
 * Delivery
 * =======================================================================================*/
/**
 * Attempt a real delivery. Returns an honest outcome — `ok` only when the provider accepted it.
 * @param {{channel: string, config: object, message: {text: string, title?: string, template?: string}}} args
 * @param {Function} fetchImpl injected for tests
 */
export async function buildRequest(channelId, config, message) {
  const adapter = adapterFor(channelId);
  const channel = getChannel(channelId);
  if (!adapter || !channel) return { ok: false, error: `Unknown channel “${channelId}”.` };
  const missing = missingFields(channelId, config);
  if (missing.length) {
    return { ok: false, reason: 'not_configured', error: `Missing ${missing.join(', ')} — the channel cannot send yet.` };
  }
  try {
    const built = adapter.buildSend(config, message);
    if (built.error) return { ok: false, reason: 'invalid_config', error: built.error };
    return { ok: true, request: built, adapter, channel };
  } catch (err) {
    return { ok: false, reason: 'build_failed', error: err.message };
  }
}

export async function deliver(channelId, config, message, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const built = await buildRequest(channelId, config, message);
  if (!built.ok) return built;
  const { request, adapter } = built;

  if (request.local) return { ok: true, local: true, deliveredAt: Date.now(), detail: 'Delivered to the in-app inbox.' };

  let res;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    res = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body && typeof request.body === 'string' ? request.body : request.body ? JSON.stringify(request.body) : undefined,
      signal: controller?.signal,
    });
  } catch (err) {
    return { ok: false, reason: err.name === 'AbortError' ? 'timeout' : 'network', error: `Request failed: ${err.message}` };
  } finally {
    if (timer) clearTimeout(timer);
  }

  let json = null;
  try { json = await res.json(); } catch { json = null; }
  const status = res.status;
  const accepted = adapter.isSuccess ? adapter.isSuccess({ status, json }) : status >= 200 && status < 300;
  if (!accepted) {
    return {
      ok: false,
      reason: 'rejected',
      status,
      error: (json && (json.description || json.error?.message || json.message || json.error)) || `Provider returned ${status}.`,
    };
  }
  return { ok: true, status, json, deliveredAt: Date.now(), detail: `Provider accepted the message (HTTP ${status}).` };
}

/** Whether the adapter can verify inbound calls for this channel (browser cannot/should not). */
export const canVerify = (channelId) => channelId !== 'browser';

/** Documented capability matrix, used by the panel and the tests. */
export const capabilities = () => Object.fromEntries(Object.keys(ADAPTERS).map((id) => [id, {
  outbound: Boolean(ADAPTERS[id].buildSend),
  inbound: Boolean(ADAPTERS[id].parseInbound),
  signature: id !== 'browser',
  local: id === 'browser',
}]));

export const signatureHelpers = { hmac, toHex, safeEqual, header };
