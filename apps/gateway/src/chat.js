/* ============ Chat — a transcript store, not a model client ============
 * The gateway persists threads and messages. It does NOT answer: there is no model runtime wired to
 * this module, and nothing here generates, delays or invents a reply. `runtimeStatus()` says so in
 * one place, the read payload carries it, and the screen renders it — so a conversation can never be
 * mistaken for an agent that answered.
 *
 * Honesty rules encoded here:
 *   • `from` is always the signed-in principal ('me'). A request body cannot assert that an agent
 *     said something; agent rows will only ever be written by a real runtime when one exists.
 *   • `unread` is a stored counter owned by the server, changed only by a write, cleared only by an
 *     explicit read mark.
 *   • The audit trail records that a message was stored and how long it was — never its text.
 */
import { db, logEvent, audit } from './db.js';

export const LIMITS = Object.freeze({
  clientId: 80,
  title: 120,
  body: 8000,
  perThread: 200, // messages returned per thread; `truncated` says when there are older ones
  threads: 200,
});

export const SENDERS = Object.freeze(['me', 'agent', 'system']);

/* One place decides what the app is told about model runtime. */
export function runtimeStatus() {
  return {
    configured: false,
    driver: 'none',
    // Kept in the payload so a screen cannot show a fake "typing…" without contradicting the API.
    generatesReplies: false,
    note: 'No model runtime is configured on this gateway. Messages are stored; no reply is generated.',
  };
}

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

const cleanText = (value, max) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, max);
const int = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

export function messageRow(row) {
  let payload = {};
  try { payload = row.payload ? JSON.parse(row.payload) : {}; } catch { payload = {}; }
  return {
    id: row.id,
    from: row.from_principal,
    agent: row.agent || '',
    text: row.body || '',
    kind: row.kind || 'text',
    payload,
    ts: int(row.ts, 0),
  };
}

function messagesFor(threadId, limit = LIMITS.perThread) {
  const rows = db.prepare('SELECT * FROM messages WHERE thread_id=? ORDER BY ts DESC, id DESC LIMIT ?')
    .all(threadId, limit + 1);
  const truncated = rows.length > limit;
  const messages = rows.slice(0, limit).reverse().map(messageRow);
  return { messages, truncated, messageCount: messageCount(threadId) };
}

const messageCount = (threadId) => db.prepare('SELECT COUNT(*) n FROM messages WHERE thread_id=?').get(threadId).n;

export function threadRow(row, { withMessages = true } = {}) {
  if (!row) return row;
  const base = {
    id: row.id,
    kind: row.kind || 'direct',
    title: row.title || '',
    unread: int(row.unread, 0),
    createdAt: int(row.created_at, 0),
  };
  if (!withMessages) return base;
  const { messages, truncated, messageCount: total } = messagesFor(row.id);
  return { ...base, messages, truncated, messageCount: total };
}

/** Every thread the reader may see, newest activity first. */
export function listThreads({ limit = LIMITS.threads } = {}) {
  const rows = db.prepare(`SELECT t.*, COALESCE(MAX(m.ts), t.created_at) AS last_ts
                           FROM threads t LEFT JOIN messages m ON m.thread_id = t.id
                           GROUP BY t.id ORDER BY last_ts DESC LIMIT ?`).all(limit);
  return { threads: rows.map((row) => threadRow(row)), runtime: runtimeStatus() };
}

export function getThread(id) {
  const row = db.prepare('SELECT * FROM threads WHERE id=?').get(id);
  if (!row) fail('not-found', 'thread not found');
  return { thread: threadRow(row), runtime: runtimeStatus() };
}

export function createThread({ title, kind = 'direct', principal }) {
  const name = cleanText(title, LIMITS.title);
  if (!name) fail('bad-request', 'a thread needs a title');
  if (!['direct', 'channel'].includes(kind)) fail('bad-request', `unknown thread kind "${kind}"`);
  const base = 'th';
  let id = `${base}-${Date.now().toString(36)}`;
  for (let n = 2; db.prepare('SELECT 1 FROM threads WHERE id=?').get(id); n += 1) id = `${base}-${Date.now().toString(36)}-${n}`;
  db.prepare('INSERT INTO threads (id,kind,title,unread,created_at) VALUES (?,?,?,?,?)').run(id, kind, name, 0, Date.now());
  audit(principal || 'system', 'api', 'chat.thread.create', { id, kind }, 'allow', 'ok');
  logEvent('chat', `Chat opened: ${name}`, id);
  return threadRow(db.prepare('SELECT * FROM threads WHERE id=?').get(id));
}

/**
 * Append a message from the signed-in principal. `from` is not taken from the request: a client
 * cannot claim an agent spoke, because no runtime is attached to answer yet.
 */
export function appendMessage(threadId, { text, from = 'me', kind = 'text', payload = {}, clientId = '', principal } = {}) {
  const thread = db.prepare('SELECT * FROM threads WHERE id=?').get(threadId);
  if (!thread) fail('not-found', 'thread not found');
  if (!['me', 'system'].includes(from)) {
    fail('bad-request', `cannot store a "${from}" message: messages from an agent must come from a runtime, not a request body`);
  }
  if (kind !== 'text') fail('bad-request', `unsupported message kind "${kind}"`);
  const body = cleanText(text, LIMITS.body);
  if (!body) fail('bad-request', 'a message needs text');

  // A retried write must not become a second message. The key is the client's, the decision is here.
  const key = cleanText(clientId, LIMITS.clientId);
  if (key) {
    const existing = db.prepare('SELECT * FROM messages WHERE thread_id=? AND client_id=?').get(threadId, key);
    if (existing) {
      return { message: messageRow(existing), duplicate: true, runtime: runtimeStatus() };
    }
  }

  const id = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const ts = Date.now();
  db.transaction(() => {
    db.prepare('INSERT INTO messages (id,thread_id,from_principal,agent,body,kind,payload,ts,client_id) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, threadId, from, '', body, 'text', JSON.stringify(payload || {}), ts, key);
    // A message from anyone other than the reader raises the counter; the reader's own does not.
    if (from !== 'me') db.prepare('UPDATE threads SET unread = unread + 1 WHERE id=?').run(threadId);
  })();
  audit(principal || 'system', 'api', 'chat.message', { threadId, id, length: body.length, clientId: key || undefined }, 'allow', 'ok');
  return { message: messageRow(db.prepare('SELECT * FROM messages WHERE id=?').get(id)), duplicate: false, runtime: runtimeStatus() };
}

/** Clear the unread counter. Explicit, idempotent, and it never touches message rows. */
export function markRead(threadId, principal) {
  const thread = db.prepare('SELECT * FROM threads WHERE id=?').get(threadId);
  if (!thread) fail('not-found', 'thread not found');
  const before = int(thread.unread, 0);
  if (before !== 0) db.prepare('UPDATE threads SET unread=0 WHERE id=?').run(threadId);
  if (before !== 0) audit(principal || 'system', 'api', 'chat.read', { threadId, cleared: before }, 'allow', 'ok');
  return { id: threadId, unread: 0, cleared: before };
}

export function deleteThread(threadId, principal) {
  const thread = db.prepare('SELECT * FROM threads WHERE id=?').get(threadId);
  if (!thread) fail('not-found', 'thread not found');
  const removed = messageCount(threadId);
  // Messages go with the thread (the schema cascades); deleting them explicitly keeps the count that
  // is returned and audited exactly right instead of inferred.
  db.transaction(() => {
    db.prepare('DELETE FROM messages WHERE thread_id=?').run(threadId);
    db.prepare('DELETE FROM threads WHERE id=?').run(threadId);
  })();
  audit(principal || 'system', 'api', 'chat.thread.delete', { threadId, messagesDeleted: removed }, 'allow', 'ok');
  return { deleted: threadId, messagesDeleted: removed };
}
