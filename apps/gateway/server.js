/* SwarmOS Gateway — HTTP API + WebSocket event stream (zero external deps)
 * Run: node apps/gateway/server.js   →  http://localhost:8787
 * Auth/RBAC arrives in Phase 3 of the implementation checklist. */
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { db, migrate, logEvent, audit, verifyAuditChain, DATA_DIR } from './src/db.js';
import { seed } from './src/seed.js';

const PORT = Number(process.env.PORT || 8787);
migrate();

const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

function broadcast(topic, payload) {
  const msg = JSON.stringify({ topic, ...payload, ts: Date.now() });
  for (const c of clients) if (c.readyState === 1) c.send(msg);
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });
}

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

/* ---------- core API (Phase 3 slice) ---------- */
route('GET', /^\/healthz$/, () => ({ code: 200, body: { ok: true, db: 'sqlite-wal', dataDir: DATA_DIR, uptime: process.uptime() } }));

route('GET', /^\/api\/v1\/summary$/, () => {
  const one = (sql) => db.prepare(sql).get().n;
  return {
    code: 200,
    body: {
      agents: one('SELECT COUNT(*) n FROM agents WHERE deleted_at IS NULL'),
      running: one("SELECT COUNT(*) n FROM agents WHERE status='running'"),
      teams: one('SELECT COUNT(*) n FROM teams'),
      swarmsLive: one("SELECT COUNT(*) n FROM swarms WHERE status='live'"),
      tasks: one('SELECT COUNT(*) n FROM tasks'),
      approvalsPending: one("SELECT COUNT(*) n FROM approvals WHERE status='pending'"),
      skillsPending: one("SELECT COUNT(*) n FROM skills WHERE status='pending'"),
      events: one('SELECT COUNT(*) n FROM events'),
    },
  };
});

route('GET', /^\/api\/v1\/agents$/, () => ({ code: 200, body: db.prepare('SELECT * FROM agents WHERE deleted_at IS NULL ORDER BY last_active DESC').all().map(hydrateAgent) }));
route('POST', /^\/api\/v1\/agents$/, async (req, res, m, q, body) => {
  const b = body;
  const id = b.id || `ag-${Date.now().toString(36)}`;
  db.prepare(`INSERT INTO agents (id,name,role,framework,model,fallback,status,trust,autonomy,success_rate,cost_today,runs,last_active,tools,skills,prompt,memory,created_by)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, b.name || 'New Agent', b.role || '', b.framework || 'LangGraph', b.model || 'anthropic/claude-sonnet-4',
      b.fallback || 'deepseek/deepseek-v3', b.status || 'idle', b.trust ?? 50, b.autonomy ?? 2, 0.85, 0, 0,
      Date.now(), JSON.stringify(b.tools || []), JSON.stringify(b.skills || []), b.prompt || '', '{}', 'api');
  const ev = logEvent('agent', `Agent ${b.name} created via API`, id);
  audit('api-user', 'api', 'agent.create', { id, name: b.name });
  broadcast('agents', { type: 'agent.created', entity: id, event: ev });
  return { code: 201, body: hydrateAgent(db.prepare('SELECT * FROM agents WHERE id=?').get(id)) };
});
route('GET', /^\/api\/v1\/agents\/([\w-]+)$/, (req, res, m) => {
  const a = db.prepare('SELECT * FROM agents WHERE id=? AND deleted_at IS NULL').get(m[1]);
  return a ? { code: 200, body: hydrateAgent(a) } : { code: 404, body: { error: 'not found' } };
});
route('PATCH', /^\/api\/v1\/agents\/([\w-]+)$/, (req, res, m, q, b) => {
  const a = db.prepare('SELECT * FROM agents WHERE id=?').get(m[1]);
  if (!a) return { code: 404, body: { error: 'not found' } };
  const allowed = ['name', 'role', 'framework', 'model', 'fallback', 'status', 'trust', 'autonomy', 'prompt'];
  for (const k of allowed) if (k in b) db.prepare(`UPDATE agents SET ${k}=? WHERE id=?`).run(b[k], m[1]);
  const ev = logEvent('agent', `Agent ${a.name} updated`, m[1]);
  audit('api-user', 'api', 'agent.update', { id: m[1], fields: Object.keys(b) });
  broadcast('agents', { type: 'agent.updated', entity: m[1], event: ev });
  return { code: 200, body: hydrateAgent(db.prepare('SELECT * FROM agents WHERE id=?').get(m[1])) };
});

route('GET', /^\/api\/v1\/tasks$/, () => db.prepare('SELECT * FROM tasks ORDER BY rowid').all().map(hydrateTask));
route('POST', /^\/api\/v1\/tasks$/, async (req, res, m, q, b) => {
  const id = b.id || `tk-${Date.now().toString(36)}`;
  db.prepare('INSERT INTO tasks (id,title,description,column_name,assignee,priority,deps,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, b.title || 'Untitled', b.desc || '', b.column || 'todo', b.assignee || null, b.priority || 'med', JSON.stringify(b.deps || []), Date.now());
  const ev = logEvent('task', `Task created: ${b.title}`, id);
  broadcast('tasks', { type: 'task.created', entity: id, event: ev });
  return { code: 201, body: hydrateTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(id)) };
});
route('PATCH', /^\/api\/v1\/tasks\/([\w-]+)$/, (req, res, m, q, b) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(m[1]);
  if (!t) return { code: 404, body: { error: 'not found' } };
  for (const k of ['title', 'description', 'column_name', 'assignee', 'priority']) if (k in b) db.prepare(`UPDATE tasks SET ${k}=? WHERE id=?`).run(b[k], m[1]);
  const ev = logEvent('task', `Task ${t.title} updated`, m[1]);
  broadcast('tasks', { type: 'task.updated', entity: m[1], event: ev });
  return { code: 200, body: hydrateTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(m[1])) };
});

route('GET', /^\/api\/v1\/approvals$/, () => db.prepare('SELECT * FROM approvals ORDER BY created_at DESC').all());
route('POST', /^\/api\/v1\/approvals\/([\w-]+)\/(allow|deny)$/, (req, res, m, b) => {
  const a = db.prepare('SELECT * FROM approvals WHERE id=?').get(m[1]);
  if (!a) return { code: 404, body: { error: 'not found' } };
  if (a.status !== 'pending') return { code: 409, body: { error: `already ${a.status}` } };
  const status = m[2] === 'allow' ? 'allowed' : 'denied';
  db.prepare('UPDATE approvals SET status=?, decider_id=?, decided_at=? WHERE id=?').run(status, 'api-user', Date.now(), m[1]);
  const ev = logEvent('approval', `${a.action} ${status} via API · ${a.target}`, m[1]);
  audit('api-user', 'api', `approval.${m[2]}`, { id: m[1], action: a.action });
  broadcast('approvals', { type: 'approval.resolved', entity: m[1], event: ev });
  return { code: 200, body: db.prepare('SELECT * FROM approvals WHERE id=?').get(m[1]) };
});

route('GET', /^\/api\/v1\/events$/, (req, res, m, q) => {
  const since = Number(q.cursor || 0);
  return { code: 200, body: db.prepare('SELECT * FROM events WHERE cursor > ? ORDER BY cursor LIMIT 100').all(since) };
});

route('GET', /^\/api\/v1\/audit\/verify$/, () => ({ code: 200, body: verifyAuditChain() }));

route('POST', /^\/api\/v1\/dev\/seed$/, (req, res, m, q, b) => {
  const counts = seed({ reset: Boolean(b?.reset || q.reset === '1') });
  broadcast('system', { type: 'system.seeded', payload: counts });
  return { code: 200, body: { ok: true, counts } };
});

/* ---------- helpers ---------- */
function hydrateAgent(a) {
  return { ...a, tools: JSON.parse(a.tools), skills: JSON.parse(a.skills), memory: JSON.parse(a.memory), framework_config: JSON.parse(a.framework_config), deleted_at: a.deleted_at ?? null };
}
function hydrateTask(t) {
  return { ...t, deps: JSON.parse(t.deps), column: t.column_name, desc: t.description };
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const q = Object.fromEntries(url.searchParams);
  if (req.method === 'OPTIONS') return json(res, 204, {});

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.pattern);
    if (!m) continue;
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
    try {
      const out = await r.handler(req, res, m, q, body);
      return json(res, out.code, out.body);
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }
  json(res, 404, { error: 'not found', hint: 'see /api/v1/summary' });
});

server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.send(JSON.stringify({ topic: 'system', type: 'hello', ts: Date.now(), clients: clients.size }));
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SwarmOS gateway → http://localhost:${PORT}  (ws: /ws, data: ${DATA_DIR})`);
});
