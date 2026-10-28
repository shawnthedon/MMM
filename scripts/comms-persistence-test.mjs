/* A comms response can arrive before any core gateway slice; persistence must still filter it. */
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
const win = new Window({ url: 'https://app.test/' });
globalThis.window = win;
globalThis.localStorage = win.localStorage;
globalThis.location = win.location;
globalThis.CustomEvent = win.CustomEvent;
const response = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/api/v1/auth/session')) return response({ principal: { id: 'A', role: 'Owner' }, permissions: ['read', 'comms:read'], csrfToken: 'test' });
  if (String(url).endsWith('/api/v1/comms')) return response({ channels: [{ id: 'telegram', config: { botToken: '••••hidden' } }], recent: [{ text: 'private-unpersisted-record' }] });
  throw new Error('unexpected request');
};
// Installs the persistence filter, without starting core read sync or capturing its demo snapshot.
await import('../src/datastore.js');
const auth = await import('../src/auth.js');
const comms = await import('../src/commsGateway.js');
await auth.configureGateway('https://gateway.test');
assert.equal((await comms.refreshComms()).ok, true);
await new Promise((resolve) => setTimeout(resolve, 320));
const stored = win.localStorage.getItem('swarmos-state-v1');
assert(stored);
assert(!stored.includes('private-unpersisted-record'));
assert(!stored.includes('••••hidden'));
console.log('COMMS PERSISTENCE: gateway records excluded without a core demo snapshot');
