/* ============ Local speech hosts, owned by the gateway ============
 * Unit 5 of the Copilot upgrade: open-source voice, local first. What this module adds is the half that
 * did not exist — speech *input* through a host the operator runs, instead of only the browser's
 * network-backed recogniser.
 *
 * Three rules, and every line below exists to keep one of them:
 *
 *   1. **The audio goes where the operator said, and nowhere else.** The host is a row on the gateway,
 *      validated as loopback unless remote hosts were explicitly enabled, and the browser never learns
 *      its address. A modified client cannot redirect a recording.
 *   2. **Nothing spoken is stored.** There is no column for audio and none for a transcript; the audit
 *      row records bytes, duration, engine and outcome — never words. `transcribe()` returns text to the
 *      caller and forgets it.
 *   3. **A failure is never an empty transcript.** "Nothing was said" and "the host did not answer in the
 *      shape we understand" are different facts, and the person who just spoke is owed the difference.
 */
import { db, audit, logEvent } from './db.js';
import {
  TRANSCRIBE_PATHS, HEALTH_PATH, SPEECH_MODES, VOICE_LIMITS, AUDIO_TYPES,
  validateVoiceEndpoint, endpointUrl, audioProblem, readTranscript, engineById, engineCatalogue,
} from '../../../packages/shared/voiceEngines.js';

/** Re-exported so the route table can size its body limit from one place. */
export { VOICE_LIMITS };

const now = () => Date.now();
const fail = (code, message, extra = {}) => {
  throw Object.assign(new Error(message), { code, ...extra });
};
const newId = () => `ve-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** Remote speech hosts are off unless a deployment says otherwise; audio is not a thing to leak by default. */
const allowRemote = () => process.env.MMM_VOICE_ALLOW_REMOTE === '1';

let fetchImpl = (...args) => globalThis.fetch(...args);
export function setServiceFetch(fn) {
  if (typeof fn === 'function') fetchImpl = fn;
}

function parseRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    mode: row.mode,
    engine: row.engine,
    label: row.label || row.engine || row.id,
    url: row.url,
    language: row.language || '',
    model: row.model || '',
    enabled: Boolean(row.enabled),
    remote: Boolean(row.remote),
    createdBy: row.created_by || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastCheckedAt: row.last_checked_at || null,
    lastStatus: row.last_status || '',
    lastDetail: row.last_detail || '',
  };
}

/** The URL, minus credentials (there are none) — but with the host visible, because this is an operator screen. */
export const listEndpoints = ({ kind = null } = {}) => {
  const rows = kind
    ? db.prepare('SELECT * FROM voice_endpoints WHERE kind=? ORDER BY created_at DESC').all(String(kind))
    : db.prepare('SELECT * FROM voice_endpoints ORDER BY created_at DESC').all();
  return rows.map(parseRow);
};

export function getEndpoint(id) {
  const row = db.prepare('SELECT * FROM voice_endpoints WHERE id=?').get(String(id));
  return parseRow(row);
}

function normaliseEndpoint(body = {}) {
  const kind = String(body.kind || 'stt').toLowerCase();
  if (!['stt', 'tts'].includes(kind)) fail('bad-request', 'kind must be “stt” or “tts”');
  const engine = String(body.engine || '').trim();
  const known = engine ? engineById(engine) : null;
  if (engine && !known) fail('bad-request', `“${engine}” is not in the voice engine catalogue`);
  if (known && !known.roles.includes(kind)) fail('bad-request', `${known.id} cannot be used for ${kind}`);
  if (known && known.server !== 'http') {
    fail('bad-request', `${known.id} does not serve HTTP — run a compatible host and point the endpoint at that instead`);
  }
  const mode = String(body.mode || known?.mode || 'whisper.cpp');
  if (kind === 'stt' && !SPEECH_MODES.includes(mode)) {
    fail('bad-request', `mode must be one of ${SPEECH_MODES.join(', ')}`);
  }
  const check = validateVoiceEndpoint(body.url, { allowRemote: allowRemote() });
  if (!check.ok) fail('bad-request', check.reason);
  return {
    kind,
    mode: kind === 'stt' ? mode : '',
    engine: engine || (kind === 'stt' ? 'whisper.cpp' : ''),
    label: String(body.label || '').trim().slice(0, 80),
    url: check.url.href.replace(/\/$/, ''),
    language: String(body.language || '').trim().slice(0, 16),
    model: String(body.model || '').trim().slice(0, 80),
    enabled: body.enabled === undefined ? true : Boolean(body.enabled),
    remote: check.remote ? 1 : 0,
  };
}

export function createEndpoint(body, principal) {
  const record = normaliseEndpoint(body);
  const existing = listEndpoints({ kind: record.kind });
  if (existing.length >= VOICE_LIMITS.endpoints) {
    fail('conflict', `this gateway holds ${existing.length} ${record.kind} endpoints already; remove one first`);
  }
  const dupe = db.prepare('SELECT id FROM voice_endpoints WHERE kind=? AND url=?').get(record.kind, record.url);
  if (dupe) fail('conflict', 'that endpoint is already configured');
  const id = newId();
  db.prepare(`INSERT INTO voice_endpoints (id, kind, mode, engine, label, url, language, model, enabled, remote, created_by, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, record.kind, record.mode, record.engine, record.label, record.url, record.language, record.model,
      record.enabled ? 1 : 0, record.remote, principal?.id || '', now(), now());
  audit(principal?.id || 'system', principal?.via || 'api', 'voice.endpoint.create', { id, kind: record.kind, host: new URL(record.url).host, remote: Boolean(record.remote) }, 'allow', 'ok');
  logEvent('voice', `${record.kind.toUpperCase()} endpoint added: ${record.label || new URL(record.url).host}`, id);
  return getEndpoint(id);
}

export function updateEndpoint(id, body, principal) {
  const current = getEndpoint(id);
  if (!current) fail('not-found', 'no such voice endpoint');
  const merged = {
    kind: body.kind ?? current.kind,
    mode: body.mode ?? current.mode,
    engine: body.engine ?? current.engine,
    label: body.label ?? current.label,
    url: body.url ?? current.url,
    language: body.language ?? current.language,
    model: body.model ?? current.model,
    enabled: body.enabled ?? current.enabled,
  };
  const record = normaliseEndpoint(merged);
  db.prepare(`UPDATE voice_endpoints SET kind=?, mode=?, engine=?, label=?, url=?, language=?, model=?, enabled=?, remote=?, updated_at=? WHERE id=?`)
    .run(record.kind, record.mode, record.engine, record.label, record.url, record.language, record.model,
      record.enabled ? 1 : 0, record.remote, now(), String(id));
  audit(principal?.id || 'system', principal?.via || 'api', 'voice.endpoint.update', { id, host: new URL(record.url).host, enabled: record.enabled }, 'allow', 'ok');
  return getEndpoint(id);
}

export function deleteEndpoint(id, principal) {
  const current = getEndpoint(id);
  if (!current) fail('not-found', 'no such voice endpoint');
  db.prepare('DELETE FROM voice_endpoints WHERE id=?').run(String(id));
  audit(principal?.id || 'system', principal?.via || 'api', 'voice.endpoint.delete', { id, host: new URL(current.url).host }, 'allow', 'ok');
  logEvent('voice', `Endpoint removed: ${current.label}`, String(id));
  return { id: String(id), deleted: true };
}

/** The endpoint `transcribe()` will use when the caller does not name one: the oldest enabled stt row. */
function pickStt(id) {
  if (id) {
    const found = getEndpoint(id);
    if (!found) fail('not-found', 'no such voice endpoint');
    if (found.kind !== 'stt') fail('bad-request', 'that endpoint is not a transcription endpoint');
    if (!found.enabled) fail('no-endpoint', 'that transcription endpoint is disabled');
    return found;
  }
  const rows = listEndpoints({ kind: 'stt' }).filter((e) => e.enabled);
  if (!rows.length) {
    fail('no-endpoint', 'no local transcription host is configured on this gateway', {
      hint: 'Run whisper.cpp (or an OpenAI-compatible wrapper) and add it under Voice → Speech hosts',
    });
  }
  return rows[rows.length - 1];
}

/**
 * Probe one endpoint. A host with no `/health` is `no-health-endpoint`, not `unreachable` — whisper.cpp's
 * server documents no health route, and calling that a failure would train people to ignore the status.
 */
export async function checkEndpoint(id, principal) {
  const endpoint = getEndpoint(id);
  if (!endpoint) fail('not-found', 'no such voice endpoint');
  const target = endpointUrl(endpoint.url, HEALTH_PATH);
  const started = now();
  let status = 'unknown';
  let detail = '';
  try {
    const res = await fetchImpl(target, { signal: AbortSignal.timeout(5000), credentials: 'omit' });
    const body = await res.json().catch(() => ({}));
    if (res.status === 404 || res.status === 405) {
      status = 'no-health-endpoint';
      detail = 'The host answered, but exposes no /health route. Transcription is attempted anyway.';
    } else if (!res.ok) {
      status = 'error';
      detail = `Health check returned HTTP ${res.status}.`;
    } else if (body?.status === 'ok' || body?.ok === true || body?.status === 'healthy') {
      status = 'available';
      detail = `Reachable${body?.engine ? ` · engine: ${body.engine}` : ''}${body?.model ? ` · model: ${body.model}` : ''}.`;
    } else {
      status = 'error';
      detail = 'Health endpoint answered without a recognised status field.';
    }
  } catch (error) {
    status = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'unreachable';
    detail = status === 'timeout'
      ? 'The health check timed out.'
      : `Could not reach the host: ${error?.message || error}.`;
  }
  const elapsed = now() - started;
  db.prepare('UPDATE voice_endpoints SET last_checked_at=?, last_status=?, last_detail=?, updated_at=? WHERE id=?')
    .run(now(), status, detail, now(), endpoint.id);
  audit(principal?.id || 'system', principal?.via || 'api', 'voice.endpoint.check', { id: endpoint.id, status }, 'allow', 'ok');
  return { ...getEndpoint(endpoint.id), lastStatus: status, lastDetail: detail, elapsedMs: elapsed };
}

function buildForm(endpoint, audio, mimeType) {
  const form = new FormData();
  const type = mimeType.split(';')[0].trim().toLowerCase();
  const ext = type.includes('webm') ? 'webm' : type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a'
    : type.includes('mpeg') ? 'mp3' : type.includes('flac') ? 'flac' : 'wav';
  form.append('file', new Blob([audio], { type }), `clip.${ext}`);
  if (endpoint.mode === 'whisper.cpp') {
    // whisper.cpp's /inference takes `response_format`; language is a *server* flag there, so sending a
    // `language` field would be inventing an API. It is only sent in the OpenAI-shaped mode.
    form.append('response_format', 'json');
    form.append('temperature', '0.0');
  } else {
    form.append('model', endpoint.model || 'whisper-1');
    form.append('response_format', 'json');
    if (endpoint.language) form.append('language', endpoint.language);
  }
  return form;
}

/**
 * Send one clip to a local host and return its transcript. Nothing is written to the database except an
 * audit row describing the request — no audio, no text, no id that could be joined back to what was said.
 */
export async function transcribe({ audio, mimeType, endpointId = null, language = '', principal = null } = {}) {
  const endpoint = pickStt(endpointId);
  const bytes = audio?.length ?? audio?.byteLength ?? 0;
  const problem = audioProblem(mimeType, bytes);
  if (problem) {
    audit(principal?.id || 'system', principal?.via || 'api', 'voice.transcribe', { endpointId: endpoint.id, bytes }, 'deny', 'audio-refused');
    fail('audio-refused', problem);
  }

  const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
  const target = endpointUrl(endpoint.url, TRANSCRIBE_PATHS[endpoint.mode] || TRANSCRIBE_PATHS['whisper.cpp']);
  const started = now();
  let res;
  try {
    res = await fetchImpl(target, {
      method: 'POST',
      body: buildForm(endpoint, buffer, mimeType),
      signal: AbortSignal.timeout(VOICE_LIMITS.timeoutMs),
      credentials: 'omit',
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    audit(principal?.id || 'system', principal?.via || 'api', 'voice.transcribe', { endpointId: endpoint.id, bytes }, 'deny', timedOut ? 'timeout' : 'unreachable');
    fail(timedOut ? 'timeout' : 'unreachable',
      timedOut
        ? `The speech host did not answer within ${VOICE_LIMITS.timeoutMs / 1000} s.`
        : `Could not reach the speech host: ${error?.message || error}.`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    audit(principal?.id || 'system', principal?.via || 'api', 'voice.transcribe', { endpointId: endpoint.id, bytes }, 'deny', `host-${res.status}`);
    fail('host-error', `The speech host returned HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}.`, { status: res.status });
  }

  let payload = null;
  const type = res.headers?.get?.('content-type') || '';
  if (type.includes('application/json')) {
    payload = await res.json().catch(() => null);
  } else {
    // whisper.cpp answers `text/plain` when asked for `txt`; accept a JSON body that lied about its type,
    // but never guess at prose.
    const text = await res.text().catch(() => '');
    try { payload = JSON.parse(text); } catch { payload = { note: 'non-json', text: undefined }; }
  }
  const read = readTranscript(payload);
  const elapsedMs = now() - started;
  if (!read.ok) {
    audit(principal?.id || 'system', principal?.via || 'api', 'voice.transcribe', { endpointId: endpoint.id, bytes }, 'deny', 'bad-response');
    fail('bad-response', read.reason);
  }

  audit(principal?.id || 'system', principal?.via || 'api', 'voice.transcribe', {
    endpointId: endpoint.id, engine: endpoint.engine, mode: endpoint.mode, bytes, elapsedMs, empty: read.empty,
  }, 'allow', read.empty ? 'empty' : 'ok');

  return {
    text: read.text,
    empty: read.empty,
    language: read.language || language || endpoint.language || '',
    engine: endpoint.engine || endpoint.mode,
    endpointId: endpoint.id,
    endpointLabel: endpoint.label,
    bytes,
    elapsedMs,
    // Said out loud in the payload, so no caller has to infer it: the audio went to a host on this network.
    stayedLocal: !endpoint.remote,
  };
}

/** What voice this gateway can do right now — the one thing the panel asks before offering a mic path. */
export function capabilities() {
  const stt = listEndpoints({ kind: 'stt' });
  const tts = listEndpoints({ kind: 'tts' });
  const enabledStt = stt.filter((e) => e.enabled);
  return {
    localStt: enabledStt.length > 0,
    localTts: tts.filter((e) => e.enabled).length > 0,
    reason: enabledStt.length
      ? `${enabledStt.length} local transcription host(s) reachable as configured.`
      : 'No local transcription host is configured, so speech input must fall back to the browser service or to typing.',
    endpoints: { stt, tts },
    engines: engineCatalogue(),
    limits: { ...VOICE_LIMITS, audioTypes: [...AUDIO_TYPES] },
    allowRemoteHosts: allowRemote(),
  };
}
