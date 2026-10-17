/* Export the canonical demo seed (src/core.js) into fixtures/*.json
 * so the gateway database can be restored to the exact sample state. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'fixtures');
mkdirSync(out, { recursive: true });

const { seed } = await import(join(root, 'src', 'core.js'));
const s = seed();

const files = {
  'agents.json': s.agents,
  'teams.json': s.teams,
  'swarms.json': s.swarms,
  'tasks.json': s.tasks,
  'skills.json': s.skills,
  'plugins.json': s.plugins,
  'providers.json': s.providers,
  'policies.json': s.policies,
  'approvals.json': s.approvals,
  'threads.json': s.threads,
  'files.json': s.files,
  'events.json': s.events.map((e, i) => ({ ...e, seq: s.events.length - i })),
  'settings.json': { ...s.settings, gateway: s.gateway },
};

for (const [name, data] of Object.entries(files)) {
  writeFileSync(join(out, name), JSON.stringify(data, null, 2) + '\n');
  console.log(`fixtures/${name}  (${Array.isArray(data) ? data.length : 1} records)`);
}
console.log('done — commit fixtures/ so `npm run seed` restores this exact demo.');
