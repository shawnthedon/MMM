/* Gateway DB layer — SQLite (WAL), zero external dependencies */
import Database from 'better-sqlite3';
import { mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..', '..', '..');
export const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
export const MIGRATIONS_DIR = join(here, '..', 'migrations');
export const FIXTURES_DIR = join(ROOT, 'fixtures');

mkdirSync(DATA_DIR, { recursive: true });
export const db = new Database(join(DATA_DIR, 'swarmos.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

export function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at INTEGER NOT NULL)`);
  const applied = new Set(db.prepare('SELECT name FROM migrations').all().map((r) => r.name));
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const insert = db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)');
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    db.transaction(() => { db.exec(sql); insert.run(f, Date.now()); })();
    console.log(`migrated: ${f}`);
  }
}

let eventCursor = 0;
try { eventCursor = db.prepare('SELECT COALESCE(MAX(cursor),0) AS c FROM events').get().c; } catch { /* pre-migrate */ }

export function logEvent(type, text, entity = '') {
  const id = `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  eventCursor += 1;
  db.prepare('INSERT INTO events (id, ts, type, text, entity, cursor) VALUES (?,?,?,?,?,?)')
    .run(id, Date.now(), type, text, entity, eventCursor);
  return { id, ts: Date.now(), type, text, entity, cursor: eventCursor };
}

/* ---- hash-chained audit (Layer 3, first slice) ---- */
import { createHash } from 'node:crypto';
export function audit(principalId, via, event, args = {}, decision = 'allow', result = 'ok') {
  const prev = db.prepare('SELECT hash, seq FROM audit_log ORDER BY seq DESC LIMIT 1').get();
  const seq = (prev?.seq ?? 0) + 1;
  const argsRedacted = JSON.stringify(args).replace(/("(?:key|token|secret|password)"\s*:\s*")[^"]+/gi, '$1***');
  const argsHash = createHash('sha256').update(argsRedacted).digest('hex').slice(0, 16);
  const hash = createHash('sha256').update(`${prev?.hash ?? ''}|${seq}|${principalId}|${event}|${argsHash}|${result}`).digest('hex');
  db.prepare(`INSERT INTO audit_log (seq, ts, principal_id, actor_via, event, args_hash, args_redacted, policy_decision, result, prev_hash, hash)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(seq, Date.now(), principalId, via, event, argsHash, argsRedacted, decision, result, prev?.hash ?? '', hash);
  return hash;
}

export function verifyAuditChain() {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY seq').all();
  let prev = '';
  for (const r of rows) {
    const h = createHash('sha256').update(`${prev}|${r.seq}|${r.principal_id}|${r.event}|${r.args_hash}|${r.result}`).digest('hex');
    if (r.prev_hash !== prev || r.hash !== h) return { ok: false, brokenAt: r.seq };
    prev = r.hash;
  }
  return { ok: true, count: rows.length };
}
