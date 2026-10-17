/* Seed loader — restores all sample data, objects & instances from fixtures/ */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { db, FIXTURES_DIR, logEvent, migrate, audit } from './db.js';

const j = (name) => JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8'));

export function seed({ reset = false } = {}) {
  migrate();
  if (reset) {
    const tables = ['audit_log', 'jobs', 'settings', 'files', 'messages', 'threads', 'model_policies', 'providers',
      'plugins', 'skills', 'events', 'approvals', 'tasks', 'swarms', 'team_members', 'teams', 'agents', 'principals'];
    db.transaction(() => { for (const t of tables) db.prepare(`DELETE FROM ${t}`).run(); })();
  }

  const counts = {};

  db.transaction(() => {
    // principals
    const pIns = db.prepare(`INSERT OR REPLACE INTO principals (id,type,name,role,trust,created_at) VALUES (?,?,?,?,?,?)`);
    pIns.run('user-maya', 'user', 'Maya', 'Owner', 100, Date.now());
    for (const a of j('agents.json')) {
      db.prepare(`INSERT OR REPLACE INTO agents
        (id,name,role,framework,framework_config,model,fallback,status,trust,autonomy,success_rate,cost_today,runs,last_active,tools,skills,prompt,memory,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(a.id, a.name, a.role, a.framework, '{}', a.model, a.fallback, a.status, a.trust, a.autonomy,
          a.successRate, a.costToday, a.runs, a.lastActive, JSON.stringify(a.tools), JSON.stringify(a.skills),
          a.prompt, JSON.stringify(a.memory), 'seed');
    }
    counts.agents = j('agents.json').length;

    for (const t of j('teams.json')) {
      db.prepare('INSERT OR REPLACE INTO teams (id,name,topology,config,health,created_by) VALUES (?,?,?,?,?,?)')
        .run(t.id, t.name, t.topology, '{}', t.health, 'seed');
      for (const m of t.members) db.prepare('INSERT OR REPLACE INTO team_members (team_id,agent_id,role) VALUES (?,?,?)').run(t.id, m, 'member');
    }
    counts.teams = j('teams.json').length;

    for (const w of j('swarms.json')) {
      db.prepare('INSERT OR REPLACE INTO swarms (id,team_id,name,objective,status,progress,budget,nodes,channel,started_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(w.id, w.teamId, w.name, w.objective, w.status, w.progress, JSON.stringify(w.budget), JSON.stringify(w.nodes), w.channel, w.startedAt, 'seed');
    }
    counts.swarms = j('swarms.json').length;

    const tIns = db.prepare(`INSERT OR REPLACE INTO tasks (id,swarm_id,title,description,column_name,assignee,priority,deps,cost_actual,created_at)
                             VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const t of j('tasks.json')) tIns.run(t.id, t.swarmId ?? null, t.title, t.desc ?? '', t.column, t.assignee, t.priority, JSON.stringify(t.deps ?? []), 0, Date.now());
    counts.tasks = j('tasks.json').length;

    const apIns = db.prepare(`INSERT OR REPLACE INTO approvals (id,action,target,risk,principal,evidence,status,created_at) VALUES (?,?,?,?,?,?,?,?)`);
    for (const a of j('approvals.json')) apIns.run(a.id, a.action, a.target, a.risk, a.principal, a.evidence, a.status, a.createdAt);
    counts.approvals = j('approvals.json').length;

    const skIns = db.prepare(`INSERT OR REPLACE INTO skills (id,name,version,origin,status,perms,tools,success,invokes,description) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const s of j('skills.json')) skIns.run(s.id, s.name, s.version, s.origin, s.status, JSON.stringify(s.perms), JSON.stringify(s.tools), s.success, s.invokes, s.desc);
    counts.skills = j('skills.json').length;

    const plIns = db.prepare(`INSERT OR REPLACE INTO plugins (id,name,category,installed,verified,calls_today,scopes,tools) VALUES (?,?,?,?,?,?,?,?)`);
    for (const p of j('plugins.json')) plIns.run(p.id, p.name, p.category, p.installed ? 1 : 0, p.verified ? 1 : 0, p.callsToday, JSON.stringify(p.scopes), JSON.stringify(p.tools));
    counts.plugins = j('plugins.json').length;

    const pvIns = db.prepare(`INSERT OR REPLACE INTO providers (id,category,name,status,auth,models,latency,spend_mtd) VALUES (?,?,?,?,?,?,?,?)`);
    for (const p of j('providers.json')) pvIns.run(p.id, p.category, p.name, p.status, p.auth, JSON.stringify(p.models), p.latency, p.spendMTD);
    counts.providers = j('providers.json').length;

    const poIns = db.prepare(`INSERT OR REPLACE INTO model_policies (id,name,priority,rules) VALUES (?,?,?,?)`);
    for (const p of j('policies.json')) poIns.run(p.id, p.name, p.priority, p.rules);
    counts.policies = j('policies.json').length;

    const thIns = db.prepare(`INSERT OR REPLACE INTO threads (id,kind,title,unread,created_at) VALUES (?,?,?,?,?)`);
    const mIns = db.prepare(`INSERT OR REPLACE INTO messages (id,thread_id,from_principal,agent,body,kind,payload,ts) VALUES (?,?,?,?,?,?,?,?)`);
    for (const t of j('threads.json')) {
      thIns.run(t.id, t.kind, t.title, t.unread ?? 0, Date.now());
      for (const m of t.messages) mIns.run(m.id, t.id, m.from, m.agent ?? '', m.text, 'text', '{}', m.ts);
    }
    counts.threads = j('threads.json').length;

    const fIns = db.prepare(`INSERT OR REPLACE INTO files (id,path,type,size,content,created_by,created_at) VALUES (?,?,?,?,?,?,?)`);
    for (const f of j('files.json')) fIns.run(f.id, f.path, f.type, f.size, f.content, f.createdBy, f.ts);
    counts.files = j('files.json').length;

    const stIns = db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`);
    stIns.run('workspace', JSON.stringify(j('settings.json')));
    counts.settings = 1;

    // seed events (keeps live demo feed)
    for (const e of j('events.json')) {
      db.prepare('INSERT OR REPLACE INTO events (id,ts,type,text,entity,cursor) VALUES (?,?,?,?,?,?)')
        .run(e.id, e.ts, e.type, e.text, '', e.seq ?? 0);
    }
    counts.events = j('events.json').length;
  })();

  logEvent('system', `Seed ${reset ? '(reset) ' : ''}loaded: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  audit('system', 'cli', 'dev.seed', { reset }, 'allow', 'ok');
  return counts;
}

// CLI: node apps/gateway/src/seed.js [--reset]
if (import.meta.url === `file://${process.argv[1]}`) {
  const counts = seed({ reset: process.argv.includes('--reset') });
  console.log('seed complete:', counts);
}
