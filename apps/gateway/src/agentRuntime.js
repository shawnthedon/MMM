/* MMM agent runtime — durable queue, real model calls, truthful run statistics. */
import { randomUUID } from 'node:crypto';
import { db, audit, logEvent } from './db.js';
import * as models from './models.js';

const providerForModel = (model) => {
  const id = String(model || '').toLowerCase().split('/')[0];
  const map = {
    anthropic: 'pv-anthropic', openai: 'pv-openai', google: 'pv-google', gemini: 'pv-google',
    xai: 'pv-xai', groq: 'pv-groq', deepseek: 'pv-deepseek', mistral: 'pv-mistral',
    qwen: 'pv-qwen', openrouter: 'pv-openrouter', together: 'pv-together', cohere: 'pv-cohere',
    ollama: 'pv-ollama', lmstudio: 'pv-lmstudio', llamacpp: 'pv-llamacpp', vllm: 'pv-vllm',
    localai: 'pv-localai', minimax: 'pv-minimax', moonshot: 'pv-moonshot',
  };
  return map[id] || '';
};

const safeJson = (value, fallback) => {
  try { return JSON.parse(value || ''); } catch { return fallback; }
};

export function providerForAgentModel(model) {
  const providerId = providerForModel(model);
  if (!providerId) return { providerId: '', provider: null, reason: `No provider mapping exists for model “${model}”. Choose a supported provider model in the agent settings.` };
  try {
    const provider = models.getProvider(providerId);
    if (provider.status !== 'configured') return { providerId, provider, reason: `${provider.name} is not configured. Add its API key in Models before running this agent.` };
    return { providerId, provider, reason: '' };
  } catch {
    return { providerId, provider: null, reason: `Provider ${providerId} is not present in the gateway catalogue.` };
  }
}

export function listAgentRuns(agentId, limit = 20) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  return db.prepare('SELECT * FROM agent_runs WHERE agent_id=? ORDER BY created_at DESC LIMIT ?').all(agentId, n);
}

export function queueAgentRun({ agentId, principal, objective = '' } = {}) {
  const agent = db.prepare('SELECT * FROM agents WHERE id=? AND deleted_at IS NULL').get(agentId);
  if (!agent) throw Object.assign(new Error('agent not found'), { code: 'not-found' });
  const goal = String(objective || agent.goal || agent.role || '').trim().slice(0, 4000);
  if (!goal) throw Object.assign(new Error('Give the agent an objective before running it.'), { code: 'bad-request' });
  const { providerId, reason } = providerForAgentModel(agent.model);
  if (reason) throw Object.assign(new Error(reason), { code: 'no-provider' });
  const id = `run-${randomUUID()}`;
  const now = Date.now();
  db.prepare(`INSERT INTO agent_runs (id,agent_id,principal_id,objective,status,model_id,provider_id,created_at)
              VALUES (?,?,?,?, 'queued',?,?,?)`).run(id, agentId, principal.id, goal, agent.model, providerId, now);
  db.prepare("UPDATE agents SET status='queued' WHERE id=? AND status<>'running'").run(agentId);
  audit(principal.id, principal.via || 'app', 'agent.run.queued', { agentId, runId: id, model: agent.model }, 'allow', 'ok');
  logEvent('agent', `Run queued for ${agent.name}`, id);
  return db.prepare('SELECT * FROM agent_runs WHERE id=?').get(id);
}

function refreshStats(agentId) {
  const day = new Date(); day.setUTCHours(0,0,0,0);
  db.prepare(`UPDATE agents SET
    runs=(SELECT COUNT(*) FROM agent_runs WHERE agent_id=? AND status='done'),
    success_rate=COALESCE((SELECT AVG(CASE WHEN status='done' THEN 1.0 ELSE 0.0 END) FROM agent_runs WHERE agent_id=? AND status IN ('done','failed')),0),
    cost_today=COALESCE((SELECT SUM(cost_micros)/1000000.0 FROM agent_runs WHERE agent_id=? AND created_at>=?),0),
    last_active=COALESCE((SELECT MAX(COALESCE(ended_at,started_at)) FROM agent_runs WHERE agent_id=?),last_active)
    WHERE id=?`).run(agentId,agentId,agentId,day.getTime(),agentId,agentId);
}

async function executeOne(broadcast) {
  const job = db.prepare("SELECT * FROM agent_runs WHERE status='queued' ORDER BY created_at LIMIT 1").get();
  if (!job) return false;
  const claimed = db.prepare("UPDATE agent_runs SET status='running',started_at=? WHERE id=? AND status='queued'").run(Date.now(),job.id);
  if (!claimed.changes) return false;
  db.prepare("UPDATE agents SET status='running' WHERE id=?").run(job.agent_id);
  broadcast('agents',{type:'agent.run.started',entity:job.agent_id,runId:job.id});
  try {
    const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(job.agent_id);
    if (!agent) throw new Error('Agent was deleted before the run started.');
    const prompt = String(agent.prompt || '').slice(0,8000);
    const messages = [
      { role:'system', content:`You are ${agent.name}, an AI agent in MMM. Role: ${agent.role || 'assistant'}. Goal: ${agent.goal || 'complete the assigned objective'}. Follow the agent instructions below. Do not claim to use tools or perform external actions. If the objective requires unavailable tools, explain the limitation.\n\nAgent instructions:\n${prompt || 'Be accurate, concise, and complete.'}` },
      { role:'user', content:job.objective },
    ];
    const result = await models.callModel({
      providerId:job.provider_id, model:job.model_id, messages, purpose:'agent-run',
      principal:job.principal_id, via:'agent-runtime', maxTokens:1200,
    });
    db.prepare(`UPDATE agent_runs SET status='done',ended_at=?,tokens_in=?,tokens_out=?,cost_micros=?,output=?,error=NULL WHERE id=?`)
      .run(Date.now(),result.usage.promptTokens,result.usage.completionTokens,Math.round(result.costUsd*1e6),String(result.text).slice(0,20000),job.id);
    audit(job.principal_id,'agent-runtime','agent.run.completed',{agentId:job.agent_id,runId:job.id,model:job.model_id},'allow','ok');
    logEvent('agent',`Run completed for ${agent.name}`,job.id);
  } catch(error) {
    db.prepare("UPDATE agent_runs SET status='failed',ended_at=?,error=? WHERE id=?")
      .run(Date.now(),String(error?.message || error).slice(0,500),job.id);
    audit(job.principal_id,'agent-runtime','agent.run.failed',{agentId:job.agent_id,runId:job.id,code:error?.code || 'error'},'deny','error');
    logEvent('agent',`Run failed: ${String(error?.message || error).slice(0,180)}`,job.id);
  } finally {
    refreshStats(job.agent_id);
    const stillRunning = db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE agent_id=? AND status='running'").get(job.agent_id).n;
    db.prepare('UPDATE agents SET status=? WHERE id=?').run(stillRunning ? 'running' : 'idle',job.agent_id);
    broadcast('agents',{type:'agent.run.finished',entity:job.agent_id,runId:job.id});
  }
  return true;
}

export function startAgentRuntime(broadcast = () => {}) {
  // A process restart must not leave a run looking permanently alive. Queued runs remain durable.
  const interruptedAgents = db.prepare("SELECT DISTINCT agent_id FROM agent_runs WHERE status='running'").all().map((r) => r.agent_id);
  db.prepare("UPDATE agent_runs SET status='failed',ended_at=?,error='Gateway restarted while this run was active.' WHERE status='running'").run(Date.now());
  for (const id of interruptedAgents) { refreshStats(id); db.prepare("UPDATE agents SET status='idle' WHERE id=?").run(id); }
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await executeOne(broadcast); } catch { /* run failures are recorded by executeOne */ }
    finally { busy = false; }
  }, 350);
  timer.unref?.();
  return () => clearInterval(timer);
}
