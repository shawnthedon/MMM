/* MMM gateway — comms service (server-side channels, credentials, delivery, queue, fan-out)
 *
 * Why this exists: the browser panel used to hold provider secrets in localStorage. Here the
 * gateway owns them — encrypted at rest with AES-256-GCM under a key derived from MMM_SECRET,
 * and never returned to a client (the API exposes only `••••last4`). Delivery, retries and inbound
 * webhooks therefore run where the credentials are.
 *
 * Honest contract (same as the panel):
 *   • saving credentials never marks a channel verified — only a provider-accepted send does;
 *   • `send()` reports what the provider actually answered, and a network failure is a failure;
 *   • inbound mail is rejected before parsing unless the adapter's signature check passes;
 *   • nothing is queued, retried or delivered silently: every attempt is a row in comms_messages.
 *
 * Environment:
 *   MMM_SECRET          key material for credential encryption (required in production; when
 *                           absent the gateway generates data/.comms-key and says so)
 *   MMM_COMMS_DISABLE=1 skip the background retry ticker (tests drive processQueue directly)
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { db, DATA_DIR, audit, logEvent } from './db.js';
import { seal, unseal, purposeKeyFor, keySource as secretsKeySource, warnIfGenerated, LEGACY_COMMS_SALT } from './secrets.js';
import {
  CHANNELS, CHANNEL_IDS, channelStatus, getChannel, missingFields, missingInboundFields, maskSecret, defaultComms,
} from '../../../src/commsChannels.js';
import { deliver, adapterFor, capabilities, signatureHelpers } from '../../../src/commsAdapters.js';

const WORKSPACE = 'default';

/**
 * Outbound fetch used when a caller does not inject one. The gateway sets this from its own seam so
 * tests can point provider calls at a local mock — production leaves it null and uses global fetch.
 */
let serviceFetch = null;
export function setServiceFetch(fn) { serviceFetch = fn; }
const fetchFor = (injected) => injected || serviceFetch || undefined;
const SECRET_FIELDS = new Set(
  CHANNELS.flatMap((c) => (c.fields || []).filter((f) => f.secret).map((f) => f.key))
);

/* =========================================================================================
 * Key management
 * =======================================================================================*/
let cachedKey = null;

/**
 * 32-byte AES key for comms configuration, derived with HKDF-SHA256 from the gateway's key material.
 * The material itself lives in `secrets.js` (one owner); this keeps the same derivation info it has
 * always used, so values sealed before that module existed still open.
 */
export function encryptionKey() {
  if (cachedKey) return cachedKey;
  cachedKey = { key: purposeKeyFor('comms-config-v1', { salt: LEGACY_COMMS_SALT }), source: keySource() };
  warnIfGenerated();
  return cachedKey;
}

/** Where the key material came from (env / file / generated) — for diagnostics only. */
export const keySource = () => secretsKeySource();

export function encryptJson(obj) {
  return seal(obj, { purpose: 'comms-config-v1', salt: LEGACY_COMMS_SALT });
}

export function decryptJson(text) {
  const opened = unseal(text, { purpose: 'comms-config-v1', salt: LEGACY_COMMS_SALT });
  return opened && typeof opened === 'object' ? opened : {};
}

/* =========================================================================================
 * Settings
 * =======================================================================================*/
const DEFAULT_SETTINGS = Object.freeze({
  quietHours: '',
  rateLimitPerMin: 20,
  retryLimit: 3,
  commands: Object.fromEntries((defaultComms().commands ? Object.entries(defaultComms().commands) : []).map(([k, v]) => [k, v])),
});

export function getSettings() {
  const row = db.prepare('SELECT * FROM comms_settings WHERE workspace = ?').get(WORKSPACE);
  if (!row) return { ...DEFAULT_SETTINGS };
  let commands = {};
  try { commands = JSON.parse(row.commands_json || '{}'); } catch { commands = {}; }
  return {
    quietHours: row.quiet_hours || '',
    rateLimitPerMin: row.rate_limit_per_min,
    retryLimit: row.retry_limit,
    commands: { ...DEFAULT_SETTINGS.commands, ...commands },
  };
}

export function saveSettings(patch = {}, actor = 'system') {
  const current = getSettings();
  const next = {
    quietHours: patch.quietHours === undefined ? current.quietHours : String(patch.quietHours || '').trim(),
    rateLimitPerMin: patch.rateLimitPerMin === undefined
      ? current.rateLimitPerMin
      : Math.max(1, Math.min(600, Number(patch.rateLimitPerMin) || current.rateLimitPerMin)),
    retryLimit: patch.retryLimit === undefined
      ? current.retryLimit
      : Math.max(0, Math.min(10, Number(patch.retryLimit) || 0)),
    commands: { ...current.commands, ...(patch.commands || {}) },
  };
  if (next.quietHours && !/^(?:[01]\d|2[0-3]):[0-5]\d-(?:[01]\d|2[0-3]):[0-5]\d$/.test(next.quietHours)) {
    return { ok: false, error: 'Quiet hours must look like “22:00-06:00”.' };
  }
  db.prepare(`INSERT INTO comms_settings (workspace, quiet_hours, rate_limit_per_min, retry_limit, commands_json, updated_at, updated_by)
              VALUES (?,?,?,?,?,?,?)
              ON CONFLICT(workspace) DO UPDATE SET quiet_hours=excluded.quiet_hours,
                rate_limit_per_min=excluded.rate_limit_per_min, retry_limit=excluded.retry_limit,
                commands_json=excluded.commands_json, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
    .run(WORKSPACE, next.quietHours, next.rateLimitPerMin, next.retryLimit, JSON.stringify(next.commands), Date.now(), actor);
  audit(actor, 'api', 'comms.settings', { quietHours: next.quietHours, rateLimitPerMin: next.rateLimitPerMin, retryLimit: next.retryLimit }, 'allow', 'ok');
  return { ok: true, settings: next };
}

/* =========================================================================================
 * Channels
 * =======================================================================================*/
const parseJson = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };

function rowToRecord(row) {
  if (!row) return null;
  return {
    channel: row.channel,
    workspace: row.workspace,
    config: decryptJson(row.config_ciphertext),
    fields: parseJson(row.config_fields, []),
    enabled: Boolean(row.enabled),
    routing: parseJson(row.routing_json, { copilot: true, agents: [] }),
    verifiedAt: row.verified_at || null,
    lastTest: parseJson(row.last_test_json, null),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

export function readChannel(channelId) {
  return rowToRecord(db.prepare('SELECT * FROM comms_channels WHERE channel = ? AND workspace = ?').get(channelId, WORKSPACE));
}

/** Never leaks a stored value: secrets are replaced with `••••last4`. */
export function maskedConfig(channelId, config = {}) {
  const channel = getChannel(channelId);
  const out = {};
  for (const [k, v] of Object.entries(config)) {
    const isSecret = SECRET_FIELDS.has(k) || (channel?.fields || []).find((f) => f.key === k)?.secret;
    out[k] = isSecret ? maskSecret(v) : v;
  }
  return out;
}

export function channelView(channelId) {
  const channel = getChannel(channelId);
  if (!channel) return null;
  const rec = readChannel(channelId) || { channel: channelId, config: {}, enabled: false, routing: { copilot: true, agents: [] }, verifiedAt: null, lastTest: null };
  const status = channelStatus(channelId, { config: rec.config, verifiedAt: rec.verifiedAt, lastTest: rec.lastTest });
  return {
    id: channelId,
    label: channel.label,
    kind: channel.kind,
    status,
    enabled: rec.enabled,
    verifiedAt: rec.verifiedAt,
    lastTest: rec.lastTest,
    // Configured = every field present, but the answer is derived from field *names*, so a client
    // can render the form without ever seeing a secret.
    configuredFields: rec.fields || Object.keys(rec.config),
    missing: missingFields(channelId, rec.config),
    missingInbound: missingInboundFields(channelId, rec.config),
    config: maskedConfig(channelId, rec.config),
    routing: rec.routing,
    updatedAt: rec.updatedAt || null,
    updatedBy: rec.updatedBy || null,
  };
}

export function listChannels() {
  const settings = getSettings();
  return {
    channels: CHANNEL_IDS.map((id) => channelView(id)),
    settings,
    capabilities: capabilities(),
    encryption: { algorithm: 'aes-256-gcm', keySource: keySource(), secretsServerSide: true },
  };
}

/**
 * Save a channel. Unknown field names are ignored; an empty string clears a field. Any change to
 * credentials clears the previous verification (a saved form proves nothing).
 */
export function saveChannel(channelId, patch = {}, actor = 'system') {
  const channel = getChannel(channelId);
  if (!channel) return { ok: false, code: 404, error: `Unknown channel “${channelId}”.` };
  const current = readChannel(channelId) || { config: {}, enabled: false, routing: { copilot: true, agents: [] } };
  const known = new Set((channel.fields || []).map((f) => f.key));
  const nextConfig = { ...current.config };
  let changed = false;
  for (const [key, value] of Object.entries(patch.config || {})) {
    if (!known.has(key)) continue;
    const clean = String(value ?? '').trim();
    if (clean && clean.startsWith('••••')) continue; // masked round-trip: keep the stored value
    if (clean) {
      if (nextConfig[key] !== clean) changed = true;
      nextConfig[key] = clean;
    } else if (key in nextConfig) {
      delete nextConfig[key];
      changed = true;
    }
  }

  let enabled = current.enabled;
  if (patch.enabled !== undefined) {
    enabled = Boolean(patch.enabled);
    if (enabled) {
      const missing = missingFields(channelId, nextConfig);
      if (missing.length) {
        return { ok: false, code: 400, error: `Cannot enable ${channel.label}: missing ${missing.join(', ')}.`, missing };
      }
    }
  }

  const routing = { ...current.routing, ...(patch.routing || {}) };
  if (routing.agents && !Array.isArray(routing.agents)) return { ok: false, code: 400, error: 'routing.agents must be an array of agent ids.' };
  if (routing.agents) routing.agents = [...new Set(routing.agents.map(String))];

  const verifiedAt = changed ? null : current.verifiedAt || null;
  const lastTest = changed ? null : current.lastTest || null;

  db.prepare(`INSERT INTO comms_channels (channel, workspace, config_ciphertext, config_fields, enabled, routing_json, verified_at, last_test_json, updated_at, updated_by)
              VALUES (?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(channel) DO UPDATE SET config_ciphertext=excluded.config_ciphertext,
                config_fields=excluded.config_fields, enabled=excluded.enabled, routing_json=excluded.routing_json,
                verified_at=excluded.verified_at, last_test_json=excluded.last_test_json,
                updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
    .run(channelId, WORKSPACE, encryptJson(nextConfig), JSON.stringify(Object.keys(nextConfig)), enabled ? 1 : 0,
      JSON.stringify(routing), verifiedAt, lastTest ? JSON.stringify(lastTest) : null, Date.now(), actor);

  // Audit for a channel change records field *names*, never values.
  audit(actor, 'api', 'comms.channel.save', { channel: channelId, fields: Object.keys(nextConfig), enabled, credentialsChanged: changed }, 'allow', 'ok');
  logEvent('comms', `${channel.label} settings saved${changed ? ' (verification cleared)' : ''}`);
  return { ok: true, channel: channelView(channelId) };
}

export function deleteChannel(channelId, actor = 'system') {
  const channel = getChannel(channelId);
  if (!channel) return { ok: false, code: 404, error: `Unknown channel “${channelId}”.` };
  db.prepare('DELETE FROM comms_channels WHERE channel = ? AND workspace = ?').run(channelId, WORKSPACE);
  audit(actor, 'api', 'comms.channel.delete', { channel: channelId }, 'allow', 'ok');
  logEvent('comms', `${channel.label} credentials removed`);
  return { ok: true, channel: channelView(channelId) };
}

/* =========================================================================================
 * Messages: one row per attempt
 * =======================================================================================*/
/** Redact anything that looks like a secret or a phone number before it is stored. */
export function redact(text) {
  return String(text ?? '')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[bot-token]')
    .replace(/\b(EAAG|EAAJ)[A-Za-z0-9]{10,}\b/g, '[meta-token]')
    .replace(/\bxox[abps]-[A-Za-z0-9-]{10,}\b/g, '[slack-token]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi, 'Bearer [redacted]')
    .replace(/\b\+?\d[\d\s().-]{7,}\d\b/g, '[number]')
    .slice(0, 500);
}

const MESSAGE_COLUMNS = `id, ts, channel, direction, body_redacted, status, reason, detail, provider_status, attempts, next_attempt_at, dedupe_key, created_by`;

export function recordMessage({
  channel, direction = 'out', body = '', status, reason = '', detail = '', providerStatus = null,
  attempts = 0, nextAttemptAt = null, dedupeKey = null, createdBy = 'system',
}) {
  const id = `cm-${randomUUID()}`;
  db.prepare(`INSERT INTO comms_messages (id, ts, channel, direction, body_redacted, status, reason, detail, provider_status, attempts, next_attempt_at, dedupe_key, created_by)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, Date.now(), channel, direction, redact(body), status, reason, redact(detail), providerStatus, attempts, nextAttemptAt, dedupeKey, createdBy);
  return getMessage(id);
}

export function getMessage(id) {
  return db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM comms_messages WHERE id = ?`).get(id) || null;
}

export function listMessages({ channel = null, direction = null, limit = 50 } = {}) {
  const clauses = [];
  const args = [];
  if (channel) { clauses.push('channel = ?'); args.push(channel); }
  if (direction) { clauses.push('direction = ?'); args.push(direction); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM comms_messages ${where} ORDER BY ts DESC LIMIT ?`).all(...args, Math.max(1, Math.min(200, Number(limit) || 50)));
}

export function messageStats() {
  const rows = db.prepare('SELECT direction, status, COUNT(*) AS n FROM comms_messages GROUP BY direction, status').all();
  const out = { out: { sent: 0, failed: 0, queued: 0, deferred: 0 }, in: { received: 0, rejected: 0 } };
  for (const r of rows) {
    if (!out[r.direction]) out[r.direction] = {};
    out[r.direction][r.status] = r.n;
  }
  return out;
}

/* =========================================================================================
 * Delivery
 * =======================================================================================*/
const RETRYABLE = new Set(['network', 'timeout', 'rate_limited', 'server_error']);

/** Seconds to wait before attempt n (1-based): 30, 120, 300, 900 … capped at 1 h. */
export const backoffMs = (attempt) => Math.min(3600000, 30000 * Math.pow(4, Math.max(0, attempt - 1)));

/** “22:00-06:00” → true when the local clock is inside that window (wraps midnight). */
export function inQuietHours(quietHours, date = new Date()) {
  const m = String(quietHours || '').match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (!m) return false;
  const [, sh, sm, eh, em] = m.map(Number);
  const now = date.getHours() * 60 + date.getMinutes();
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

const minuteAgo = () => Date.now() - 60000;
const sentInLastMinute = (channel, at = Date.now()) =>
  db.prepare("SELECT COUNT(*) AS n FROM comms_messages WHERE channel = ? AND direction = 'out' AND status = 'sent' AND ts > ?").get(channel, at - 60000).n;

/**
 * Try to deliver one message now. Records the attempt either way and returns what happened.
 * Never turns a failure into a success.
 */
export async function sendChannelMessage(channelId, { text, title = 'MMM', fetchImpl, actor = 'system', dedupeKey = null, queueOnFailure = true } = {}) {
  const channel = getChannel(channelId);
  if (!channel) return { ok: false, code: 404, error: `Unknown channel “${channelId}”.`, reason: 'unknown_channel' };
  if (!String(text || '').trim()) return { ok: false, code: 400, error: 'A message body is required.', reason: 'empty' };

  if (dedupeKey) {
    const seen = db.prepare('SELECT id, status FROM comms_messages WHERE dedupe_key = ?').get(dedupeKey);
    if (seen) return { ok: false, code: 409, error: 'Duplicate message key — already processed.', reason: 'duplicate', messageId: seen.id };
  }

  const rec = readChannel(channelId);
  const config = rec?.config || {};
  if (!rec?.enabled) {
    const row = recordMessage({ channel: channelId, body: text, status: 'failed', reason: 'disabled', detail: `${channel.label} is disabled.`, createdBy: actor, dedupeKey });
    return { ok: false, code: 409, error: `${channel.label} is disabled.`, reason: 'disabled', messageId: row.id };
  }
  const missing = missingFields(channelId, config);
  if (missing.length) {
    const row = recordMessage({ channel: channelId, body: text, status: 'failed', reason: 'unconfigured', detail: `Missing ${missing.join(', ')}.`, createdBy: actor, dedupeKey });
    return { ok: false, code: 503, error: `Missing ${missing.join(', ')}.`, reason: 'unconfigured', messageId: row.id };
  }

  const settings = getSettings();
  if (inQuietHours(settings.quietHours)) {
    const row = recordMessage({
      channel: channelId, body: text, status: 'queued', reason: 'quiet_hours',
      detail: `Quiet hours ${settings.quietHours} — held until they end.`, nextAttemptAt: Date.now() + 60000, createdBy: actor, dedupeKey,
    });
    return { ok: false, code: 202, error: 'Queued: inside quiet hours.', reason: 'quiet_hours', messageId: row.id, queued: true };
  }

  const result = channel.kind === 'local'
    ? { ok: true, local: true, detail: 'Delivered to the in-app inbox.' }
    : await deliver(channelId, config, { text, title }, { fetchImpl: fetchFor(fetchImpl) });

  if (result.ok) {
    const row = recordMessage({
      channel: channelId, body: text, status: 'sent', detail: result.detail || 'Provider accepted the message.',
      providerStatus: result.status ?? null, attempts: 1, createdBy: actor, dedupeKey,
    });
    // Only a provider-accepted send verifies the channel.
    db.prepare('UPDATE comms_channels SET verified_at = ?, last_test_json = ?, updated_at = ? WHERE channel = ? AND workspace = ?')
      .run(Date.now(), JSON.stringify({ at: Date.now(), ok: true, detail: result.detail || '' }), Date.now(), channelId, WORKSPACE);
    logEvent('comms', `${channel.label} delivered (server)`);
    return { ok: true, messageId: row.id, status: result.status ?? null, detail: result.detail, local: Boolean(result.local) };
  }

  const retryable = RETRYABLE.has(result.reason);
  const shouldQueue = queueOnFailure && retryable && settings.retryLimit > 0;
  const row = recordMessage({
    channel: channelId, body: text, status: shouldQueue ? 'queued' : 'failed',
    reason: result.reason || 'failed', detail: result.error || 'Delivery failed.',
    providerStatus: result.status ?? null, attempts: 1,
    nextAttemptAt: shouldQueue ? Date.now() + backoffMs(1) : null, createdBy: actor, dedupeKey,
  });
  db.prepare('UPDATE comms_channels SET last_test_json = ?, updated_at = ? WHERE channel = ? AND workspace = ?')
    .run(JSON.stringify({ at: Date.now(), ok: false, detail: result.error || '', reason: result.reason || null }), Date.now(), channelId, WORKSPACE);
  logEvent('comms', `${channel.label} delivery failed (${result.reason || 'error'})`);
  return { ok: false, code: 502, error: result.error || 'Delivery failed.', reason: result.reason || 'failed', queued: shouldQueue, messageId: row.id };
}

/**
 * Process messages whose retry time has arrived. Respects per-channel rate limits and quiet hours,
 * and stops retrying after `retryLimit` attempts (marking them failed, permanently).
 */
export async function processQueue({ fetchImpl, at = Date.now(), limit = 20 } = {}) {
  const settings = getSettings();
  const due = db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM comms_messages
                          WHERE status = 'queued' AND direction = 'out' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
                          ORDER BY ts ASC LIMIT ?`).all(at, limit);
  const outcome = { considered: due.length, sent: 0, failed: 0, deferred: 0, quiet: inQuietHours(settings.quietHours) };
  if (outcome.quiet) return outcome;

  for (const msg of due) {
    if (sentInLastMinute(msg.channel, at) >= settings.rateLimitPerMin) {
      db.prepare("UPDATE comms_messages SET status = 'deferred', next_attempt_at = ? WHERE id = ?").run(at + 60000, msg.id);
      outcome.deferred += 1;
      continue;
    }
    const rec = readChannel(msg.channel);
    if (!rec?.enabled) {
      db.prepare("UPDATE comms_messages SET status = 'failed', reason = 'disabled', detail = 'Channel disabled before retry.' WHERE id = ?").run(msg.id);
      outcome.failed += 1;
      continue;
    }
    const channel = getChannel(msg.channel);
    const result = channel.kind === 'local'
      ? { ok: true, local: true, detail: 'Delivered to the in-app inbox.' }
      : await deliver(msg.channel, rec.config, { text: msg.body_redacted, title: 'MMM' }, { fetchImpl: fetchFor(fetchImpl) });
    const attempts = msg.attempts + 1;
    if (result.ok) {
      db.prepare("UPDATE comms_messages SET status = 'sent', attempts = ?, detail = ?, provider_status = ?, next_attempt_at = NULL WHERE id = ?")
        .run(attempts, result.detail || 'Retry accepted by the provider.', result.status ?? null, msg.id);
      db.prepare('UPDATE comms_channels SET verified_at = ?, updated_at = ? WHERE channel = ? AND workspace = ?').run(Date.now(), Date.now(), msg.channel, WORKSPACE);
      outcome.sent += 1;
    } else if (RETRYABLE.has(result.reason) && attempts < settings.retryLimit) {
      db.prepare("UPDATE comms_messages SET attempts = ?, reason = ?, detail = ?, next_attempt_at = ? WHERE id = ?")
        .run(attempts, result.reason || 'failed', result.error || 'Delivery failed.', at + backoffMs(attempts), msg.id);
      outcome.deferred += 1;
    } else {
      db.prepare("UPDATE comms_messages SET status = 'failed', attempts = ?, reason = ?, detail = ?, next_attempt_at = NULL WHERE id = ?")
        .run(attempts, result.reason || 'failed', result.error || 'Delivery failed after retries.', msg.id);
      outcome.failed += 1;
    }
  }
  if (outcome.sent || outcome.failed) logEvent('comms', `Queue: ${outcome.sent} sent, ${outcome.failed} failed, ${outcome.deferred} deferred`);
  return outcome;
}

/* =========================================================================================
 * Inbound: signature first, then the command surface
 * =======================================================================================*/
const COMMAND_LIST = [
  { id: '/status', gate: false },
  { id: '/agents', gate: false },
  { id: '/tasks', gate: false },
  { id: '/approve', gate: true },
  { id: '/ask', gate: false },
  { id: '/copilot', gate: true },
];

/** Deterministic answers from gateway rows. The same grammar the panel documents. */
export function runCommand(text, { actor = 'channel' } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, reason: 'empty', reply: 'Empty message.' };
  const cmd = raw.split(/\s+/)[0].toLowerCase();
  const known = COMMAND_LIST.find((c) => c.id === cmd);
  if (!known) return { ok: false, reason: 'unknown_command', reply: `Unknown command “${cmd}”. Known: ${COMMAND_LIST.map((c) => c.id).join(' · ')}` };
  const settings = getSettings();
  if (settings.commands[cmd] === false) return { ok: false, reason: 'blocked', reply: `${cmd} is disabled for channels.` };
  if (known.gate) {
    return { ok: true, gated: true, reply: `${cmd} is gated: open MMM to confirm — channel commands cannot perform gated actions.` };
  }
  if (cmd === '/status') {
    const agents = db.prepare('SELECT status FROM agents WHERE deleted_at IS NULL').all();
    const running = agents.filter((a) => a.status === 'running').length;
    const pending = db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").get().n;
    return { ok: true, reply: `Gateway ${running}/${agents.length} agents active · ${pending} approvals pending` };
  }
  if (cmd === '/agents') {
    const rows = db.prepare("SELECT name, status, trust FROM agents WHERE deleted_at IS NULL ORDER BY name LIMIT 12").all();
    return { ok: true, reply: rows.map((a) => `▸ ${a.name} · ${a.status} · trust ${a.trust}`).join('\n') || 'no agents' };
  }
  if (cmd === '/tasks') {
    const rows = db.prepare('SELECT column_name, COUNT(*) AS n FROM tasks GROUP BY column_name').all();
    const counts = Object.fromEntries(rows.map((r) => [r.column_name, r.n]));
    return { ok: true, reply: `Board: ${['todo', 'doing', 'review', 'done'].map((c) => `${c} ${counts[c] || 0}`).join(' · ')}` };
  }
  if (cmd === '/ask' || cmd === '/copilot') {
    return { ok: true, reply: `${cmd} runs in the app — channel replies are deterministic summaries only.`, actor };
  }
  return { ok: true, reply: `${cmd} acknowledged.` };
}

/**
 * Handle an inbound webhook. Public route: authenticity comes from the adapter's signature check,
 * never from a session. A rejected signature is recorded and nothing is parsed.
 */
export async function handleInbound(channelId, { headers = {}, rawBody = '', json = null, dedupeKey = null } = {}) {
  const channel = getChannel(channelId);
  const adapter = adapterFor(channelId);
  if (!channel || !adapter) return { ok: false, code: 404, error: 'Unknown channel.' };
  const rec = readChannel(channelId);
  if (!rec?.enabled) {
    recordMessage({ channel: channelId, direction: 'in', body: '', status: 'rejected', reason: 'disabled', detail: `${channel.label} is disabled.`, createdBy: 'webhook' });
    return { ok: false, code: 403, error: `${channel.label} is disabled.` };
  }
  if (channel.kind !== 'local') {
    const missing = missingInboundFields(channelId, rec.config);
    if (missing.length) {
      recordMessage({ channel: channelId, direction: 'in', body: '', status: 'rejected', reason: 'unconfigured', detail: `Missing ${missing.join(', ')}.`, createdBy: 'webhook' });
      return { ok: false, code: 503, error: `Inbound verification unavailable: ${missing.join(', ')}.` };
    }
    const formBody = rawBody || (json ? Object.entries(json).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '');
    let verified = false;
    try {
      verified = await adapter.verify(headers, formBody, rec.config);
    } catch (err) {
      return { ok: false, code: 500, error: `Verification error: ${err.message}` };
    }
    if (!verified) {
      recordMessage({ channel: channelId, direction: 'in', body: '', status: 'rejected', reason: 'signature', detail: 'Rejected before parsing.', createdBy: 'webhook' });
      logEvent('comms', `${channel.label} inbound rejected — signature mismatch`);
      audit('webhook', channelId, 'comms.inbound', { channel: channelId }, 'deny', 'signature');
      return { ok: false, code: 401, error: 'Signature verification failed.' };
    }
  }
  if (dedupeKey && db.prepare('SELECT id FROM comms_messages WHERE dedupe_key = ?').get(dedupeKey)) {
    return { ok: true, code: 200, duplicate: true, reply: 'Already processed.' };
  }
  let payload = json;
  if (!payload) {
    if (channelId === 'sms') payload = Object.fromEntries(new URLSearchParams(rawBody));
    else { try { payload = JSON.parse(rawBody); } catch { payload = null; } }
  }
  const parsed = adapter.parseInbound(payload);
  if (!parsed) {
    recordMessage({ channel: channelId, direction: 'in', body: '', status: 'rejected', reason: 'unparsed', detail: 'No message in payload.', createdBy: 'webhook', dedupeKey });
    return { ok: false, code: 400, error: 'No message in payload.' };
  }

  const result = runCommand(parsed.text);
  const inbound = recordMessage({ channel: channelId, direction: 'in', body: parsed.text, status: 'received', detail: result.reply || '', createdBy: 'webhook', dedupeKey });
  audit('webhook', channelId, 'comms.inbound', { channel: channelId, chars: String(parsed.text).length }, 'allow', result.ok ? 'ok' : 'refused');

  // Reply on the same channel, but only if it is actually configured and enabled — a webhook reply
  // is a real outbound message, and the row above already records the inbound half.
  let reply = null;
  if (result.reply && rec.enabled && missingFields(channelId, rec.config).length === 0) {
    reply = await sendChannelMessage(channelId, { text: result.reply, title: 'MMM', actor: 'webhook', dedupeKey: dedupeKey ? `reply:${dedupeKey}` : null });
  }
  return { ok: true, code: 200, parsed, reply: result.reply, delivered: Boolean(reply?.ok), deliveryError: reply?.ok ? null : reply?.error, inboundId: inbound.id };
}

/**
 * Provider verification handshakes (GET):
 *   Meta / WhatsApp  ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…
 *   Slack            ?challenge=… (must be signed with the signing secret)
 */
export async function verifyHandshake(channelId, { query = {}, headers = {} } = {}) {
  const channel = getChannel(channelId);
  const rec = readChannel(channelId);
  if (!channel) return { ok: false, code: 404, error: 'Unknown channel.' };
  if (!rec) return { ok: false, code: 404, error: `${channel.label} has no stored configuration.` };

  if (query['hub.mode'] || query['hub.challenge']) {
    const token = String(query['hub.verify_token'] || '');
    const expected = String(rec.config.verifyToken || '');
    if (!expected) return { ok: false, code: 503, error: 'No verify token stored.' };
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, code: 403, error: 'Verify token mismatch.' };
    if (query['hub.mode'] !== 'subscribe') return { ok: false, code: 400, error: 'hub.mode must be subscribe.' };
    return { ok: true, code: 200, challenge: String(query['hub.challenge'] || ''), contentType: 'text/plain' };
  }

  if (query.challenge) {
    const adapter = adapterFor(channelId);
    const verified = adapter?.verify ? await adapter.verify(headers, '', rec.config) : false;
    if (!verified) return { ok: false, code: 401, error: 'Invalid Slack signature.' };
    return { ok: true, code: 200, challenge: String(query.challenge), contentType: 'text/plain' };
  }

  return { ok: false, code: 400, error: 'Not a verification handshake (expected hub.* or challenge).' };
}

/* =========================================================================================
 * Fan-out: workspace events → routed channels
 * =======================================================================================*/
export const routesForAgent = (agentId = null) => CHANNEL_IDS.filter((id) => {
  const rec = readChannel(id);
  if (!rec?.enabled) return false;
  if (channelStatus(id, rec) === 'not_configured') return false;
  if (!agentId) return Boolean(rec.routing?.copilot);
  return (rec.routing?.agents || []).includes(agentId);
});

/**
 * Enqueue (not "deliver") a workspace event on every channel routed to the agent. Queued rows are
 * picked up by processQueue, so a provider outage delays a message instead of losing or faking it.
 */
export function fanOut({ agentId = null, text, reason = 'event', dedupeKey = null }) {
  const targets = routesForAgent(agentId);
  const queued = [];
  for (const channel of targets) {
    const row = recordMessage({
      channel, body: text, status: 'queued', reason, detail: `Queued for ${channel}.`,
      nextAttemptAt: Date.now(), dedupeKey: dedupeKey ? `${dedupeKey}:${channel}` : null, createdBy: 'fanout',
    });
    queued.push({ channel, messageId: row?.id });
  }
  if (queued.length) logEvent('comms', `Fan-out to ${queued.map((q) => q.channel).join(', ')} (${reason})`);
  return { queued, channels: targets };
}

/* ---------- background ticker (opt-in, unref'd so it never holds a process open) ---------- */
let ticker = null;
export function startQueueTicker({ intervalMs = 60000 } = {}) {
  if (ticker || process.env.MMM_COMMS_DISABLE === '1') return null;
  ticker = setInterval(() => { processQueue().catch(() => {}); }, intervalMs);
  ticker.unref?.();
  return ticker;
}
export function stopQueueTicker() {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

export const commsInternals = { SECRET_FIELDS, DEFAULT_SETTINGS, COMMAND_LIST, signatureHelpers, createHash };
