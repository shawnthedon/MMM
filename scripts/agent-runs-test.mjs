import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'mmm-agent-runtime-'));
process.env.DATA_DIR = dataDir;
process.env.MMM_SECRET = 'agent-runtime-test-secret-that-is-long-enough-123456';
process.env.MMM_QUIET = '1';
const { seed } = await import('../apps/gateway/src/seed.js');
const { db } = await import('../apps/gateway/src/db.js');
const models = await import('../apps/gateway/src/models.js');
const runtime = await import('../apps/gateway/src/agentRuntime.js');

let server;
let stopRuntime;
try {
  seed({ reset: true });
  const agent = db.prepare('SELECT * FROM agents ORDER BY id LIMIT 1').get();
  assert.ok(agent, 'fixture agent exists');
  assert.equal(agent.status, 'idle', 'seeded agent starts idle');
  assert.equal(agent.runs, 0, 'seeded agent has no fictional runs');
  db.prepare('UPDATE agents SET tools=\'[]\', model=\'anthropic/claude-sonnet-4\', prompt=\'Answer accurately.\', goal=\'Summarise the test objective.\' WHERE id=?').run(agent.id);

  const principal = { id: 'test-owner', via: 'test' };
  assert.throws(
    () => runtime.queueAgentRun({ agentId: agent.id, principal, objective: 'Say hello.' }),
    (error) => error.code === 'no-provider',
    'unconfigured provider is refused before a run is queued'
  );
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_runs').get().n, 0, 'no-provider refusal creates no run row');

  server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    assert.equal(parsed.model, 'anthropic/claude-sonnet-4');
    res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'agent-runtime-test' });
    res.end(JSON.stringify({
      model: parsed.model,
      choices: [{ message: { role: 'assistant', content: 'Hello from the real agent runtime test.' } }],
      usage: { prompt_tokens: 24, completion_tokens: 9, total_tokens: 33 }
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  models.saveProviderKey('pv-anthropic', {
    apiKey: 'agent-runtime-test-key',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    defaultModel: 'anthropic/claude-sonnet-4'
  }, principal.id, 'test');

  stopRuntime = runtime.startAgentRuntime(() => {});
  const queued = runtime.queueAgentRun({ agentId: agent.id, principal, objective: 'Say hello in one sentence.' });
  assert.equal(queued.status, 'queued', 'run is durably queued');
  const deadline = Date.now() + 8000;
  let finished;
  while (Date.now() < deadline) {
    finished = db.prepare('SELECT * FROM agent_runs WHERE id=?').get(queued.id);
    if (finished.status === 'done' || finished.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(finished.status, 'done', finished.error || 'queued run reaches done');
  assert.match(finished.output, /Hello from the real agent runtime test/);
  assert.equal(finished.tokens_in, 24);
  assert.equal(finished.tokens_out, 9);
  const updated = db.prepare('SELECT * FROM agents WHERE id=?').get(agent.id);
  assert.equal(updated.status, 'idle', 'agent returns to idle after completion');
  assert.equal(updated.runs, 1, 'run count is computed from completed runs');
  assert.equal(updated.success_rate, 1, 'success rate is computed from completed runs');
  assert.ok(updated.cost_today > 0, 'estimated provider cost is recorded');
  assert.ok(updated.last_active >= finished.started_at, 'last active is based on run timestamps');
  console.log('AGENT RUNTIME: no-provider refusal + queued → running → done + persistent output + computed stats passed');
} finally {
  stopRuntime?.();
  if (server) await new Promise((resolve) => server.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
}
