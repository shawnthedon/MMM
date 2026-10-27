/* Comms panel + gateway tests.
 * Run: npm run test:comms
 *
 * What is verified here, and why it matters:
 *   • the More panel no longer lists Chat, Skills Matrix or Telegram, and Comms is there;
 *   • the panel exposes all six gateways and each opens advanced settings;
 *   • a channel is never “verified” just because credentials were saved;
 *   • a live test only reports success when the provider accepted it (mock fetch, real code path);
 *   • inbound webhooks are rejected unless the signature verifies (Telegram secret token, Slack v0
 *     HMAC, WhatsApp sha256, Twilio HMAC-SHA1);
 *   • gated commands cannot be executed from a channel;
 *   • the Copilot can inspect, test, route, mute and wake channels — and refuses to take secrets.
 */
import { Window } from 'happy-dom';
import { createHmac } from 'node:crypto';

const win = new Window({ url: 'http://localhost:5173/#/home' });
for (const k of ['document', 'navigator', 'location', 'localStorage', 'history', 'HTMLElement',
  'Event', 'CustomEvent', 'KeyboardEvent', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame', 'Blob', 'URLSearchParams']) {
  const value = win[k] ?? win;
  try {
    Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
  } catch {
    try { globalThis[k] = value; } catch {}
  }
}
globalThis.window = win;
globalThis.document = win.document;
globalThis.localStorage = win.localStorage;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
win.matchMedia = globalThis.matchMedia;
win.document.body.innerHTML = '<div id="app"><div id="view"></div><div id="sheet-root"></div><div id="toast-root"></div></div>';

/* ---------- mock provider ---------- */
let providerMode = 'ok';       // 'ok' | 'reject' | 'network'
let lastRequest = null;
globalThis.fetch = async (url, options = {}) => {
  const path = String(url);
  if (!/^https?:/.test(path)) return new Response('{}', { status: 404 });
  lastRequest = { url: path, method: options.method, headers: options.headers, body: options.body };
  if (providerMode === 'network') throw new Error('getaddrinfo ENOTFOUND provider.invalid');
  if (providerMode === 'reject') {
    return new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found', error: { message: 'chat not found' } }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, delivered: true }), { status: 200, headers: { 'content-type': 'application/json' } });
};

/* ---------- harness ---------- */
const results = [];
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (err) {
    failures += 1;
    results.push(`FAIL ${name}: ${err.message}`);
  }
}
const assert = (cond, message) => { if (!cond) throw new Error(message); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

await import('../src/main.js');
await sleep(140);

const nav = await import('../src/main.js');
const core = await import('../src/core.js');
const shell = await import('../src/shell.js');
const channels = await import('../src/commsChannels.js');
const adapters = await import('../src/commsAdapters.js');
const comms = await import('../src/comms.js');

const doc = win.document;
const view = () => doc.getElementById('view');
const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
const q = (sel, root = doc) => root.querySelector(sel);
const qa = (sel, root = doc) => [...root.querySelectorAll(sel)];
const sheet = () => [...doc.querySelectorAll('.sheet.open')].pop() || null;
const state = () => core.getState();
async function fresh(route = 'comms') {
  shell.closeAllSheets();
  await sleep(20);
  nav.navigate(route);
  await sleep(30);
}

/* ---------- 1. More panel contents ---------- */
await check('the More panel drops Chat, Skills Matrix and Telegram, and offers Comms', async () => {
  await fresh('home');
  click(q('[data-act="more"]'));
  await sleep(40);
  const s = sheet();
  assert(s, 'All-modules sheet did not open');
  const tiles = qa('[data-act="nav"]', s).map((b) => b.dataset.to);
  assert(!tiles.includes('chat'), 'Chat should not be a module tile');
  assert(!tiles.includes('matrix'), 'Skills Matrix should not be a module tile');
  assert(!tiles.includes('telegram'), 'Telegram should no longer have its own tile');
  assert(tiles.includes('comms'), 'Comms tile missing');
  const commsTile = qa('[data-act="nav"]', s).find((b) => b.dataset.to === 'comms');
  assert(/Comms/.test(text(commsTile)), 'Comms tile label');
});

/* ---------- 2. panel shape ---------- */
await check('Comms renders six gateways, each with a status and a toggle', async () => {
  await fresh('comms');
  eq(channels.CHANNEL_IDS.join(','), 'telegram,whatsapp,discord,slack,sms,browser', 'six channels defined');
  const tiles = qa('[data-act="comms-open"]', view());
  eq(tiles.length, 6, 'six channel tiles');
  const ids = tiles.map((t) => t.dataset.id);
  eq(ids.join(','), 'telegram,whatsapp,discord,slack,sms,browser', 'tile order');
  assert(/Not configured/.test(text(view())), 'unconfigured state is stated');
  assert(/Honest state/.test(text(view())), 'the honest-state banner is present');
  assert(qa('[data-act="comms-toggle"]', view()).length === 6, 'every channel has an enable switch');
  assert(tiles.every((t) => q('svg', t)), 'every tile has an icon');
});

await check('selecting a gateway opens advanced settings for that channel', async () => {
  const expected = {
    telegram: ['Bot token', 'Webhook secret token', 'Default chat id'],
    whatsapp: ['Permanent access token', 'Phone number id', 'Webhook verify token'],
    discord: ['Bot token', 'Application id', 'Interactions public key'],
    slack: ['Bot token', 'Signing secret', 'Default channel'],
    sms: ['Provider base URL', 'Account SID', 'Auth token', 'From number'],
    browser: ['VAPID public key'],
  };
  for (const id of Object.keys(expected)) {
    shell.closeAllSheets();
    await fresh('comms');
    click(q(`[data-act="comms-open"][data-id="${id}"]`, view()));
    await sleep(50);
    const s = sheet();
    assert(s, `${id} sheet did not open`);
    const body = text(s);
    expected[id].forEach((label) => assert(body.includes(label), `${id} sheet is missing “${label}”`));
    ['Connection', 'Routing', 'Command surface', 'Delivery & safety', 'Inbound endpoint'].forEach((section) => {
      assert(body.includes(section), `${id} sheet is missing section “${section}”`);
    });
    assert(q('[data-act="comms-save"]', s), `${id} has no save action`);
    assert(q('[data-act="comms-test"]', s), `${id} has no test action`);
    assert(qa('[data-act="comms-route-agent"]', s).length >= 1, `${id} cannot route agents`);
    assert(body.includes(`/api/v1/comms/${id}/inbound`), `${id} shows its inbound endpoint`);
  }
});

/* ---------- 3. status honesty ---------- */
await check('saving credentials never marks a channel verified', async () => {
  await fresh('comms');
  const out = comms.saveChannelConfig('telegram', { botToken: '123:abc', chatId: '42' });
  assert(out.ok, 'save failed');
  const rec = state().comms.channels.telegram;
  eq(rec.verifiedAt, null, 'verifiedAt stays null after saving');
  eq(channels.channelStatus('telegram', rec), 'configured_unverified', 'status');
  assert(/Still required to send: webhookSecret|Inbound webhooks cannot verify/.test(rec ? '' : '') || channels.missingInboundFields('telegram', rec.config).includes('webhookSecret'), 'inbound secret still flagged');
});

await check('the enable switch refuses an unconfigured channel', async () => {
  const out = comms.toggleChannel('slack', true);
  assert(!out.ok, 'enabling slack without credentials must fail');
  assert(/missing/i.test(out.error), 'explains what is missing');
  eq(state().comms.channels.slack.enabled, false, 'still disabled');
});

/* ---------- 4. live delivery ---------- */
await check('a live test reports the provider’s real answer', async () => {
  providerMode = 'ok';
  const good = await comms.sendTest('telegram');
  assert(good.ok, `expected success, got ${good.error}`);
  assert(/accepted/i.test(good.detail), 'detail says the provider accepted it');
  assert(lastRequest.url.includes('api.telegram.org') && lastRequest.url.includes('sendMessage'), 'hit the real Telegram endpoint');
  assert(JSON.parse(lastRequest.body).chat_id === '42', 'chat id from config');
  eq(state().comms.channels.telegram.verifiedAt !== null, true, 'verified after a successful test');

  providerMode = 'reject';
  const bad = await comms.sendTest('telegram');
  assert(!bad.ok, 'a rejected send must not look successful');
  eq(bad.status, 400, 'provider status preserved');
  assert(/chat not found/i.test(bad.error), 'provider message surfaced');
  eq(state().comms.channels.telegram.lastTest.ok, false, 'failure recorded');
  eq(channels.channelStatus('telegram', state().comms.channels.telegram), 'failed', 'status reflects the failed test');

  providerMode = 'network';
  const offline = await comms.sendTest('telegram');
  assert(!offline.ok && offline.reason === 'network', 'network failure classified');
  assert(/ENOTFOUND/.test(offline.error), 'real network error kept');
  providerMode = 'ok';
});

await check('an unconfigured channel cannot send at all', async () => {
  const out = await comms.sendTest('discord');
  assert(!out.ok, 'must fail');
  eq(out.reason, 'not_configured', 'reason');
  assert(/Missing/.test(out.error), 'names the missing fields');
});

await check('the browser channel delivers into the in-app inbox and verifies', async () => {
  const out = await comms.sendTest('browser', { text: 'Inbox round trip' });
  assert(out.ok && out.local, 'local delivery');
  const inbox = state().comms.inbox;
  assert(inbox.length >= 1 && /Inbox round trip/.test(inbox[0].text), 'message landed in the inbox');
  assert(state().comms.channels.browser.verifiedAt !== null, 'browser verified by real delivery');
  await fresh('comms');
  assert(/Inbox round trip/.test(text(view())), 'inbox visible in the panel');
});

/* ---------- 5. inbound signatures ---------- */
const sign = (algo, key, data) => createHmac(algo, key).update(data).digest('hex');

await check('Telegram inbound needs the secret token header', async () => {
  comms.saveChannelConfig('telegram', { webhookSecret: 's3cret' });
  comms.toggleChannel('telegram', true);
  const body = JSON.stringify({ message: { text: '/status', from: { username: 'maya' }, chat: { id: 42 } } });
  const bad = await comms.handleInbound('telegram', { headers: { 'x-telegram-bot-api-secret-token': 'wrong' }, rawBody: body });
  eq(bad.status, 401, 'bad secret rejected');
  const good = await comms.handleInbound('telegram', { headers: { 'x-telegram-bot-api-secret-token': 's3cret' }, rawBody: body });
  eq(good.status, 200, 'good secret accepted');
  assert(/approvals pending|agents active/i.test(good.reply), `command ran (${good.reply})`);
});

await check('Slack inbound is rejected outside the replay window and on a bad digest', async () => {
  comms.saveChannelConfig('slack', { botToken: 'xoxb-1', signingSecret: 'shh', channel: '#ops' });
  comms.toggleChannel('slack', true);
  const body = 'text=%2Fagents&user=U1&channel=C1';
  const nowTs = Math.floor(Date.now() / 1000);
  const goodSig = `v0=${sign('sha256', 'shh', `v0:${nowTs}:${body}`)}`;
  const good = await comms.handleInbound('slack', { headers: { 'x-slack-signature': goodSig, 'x-slack-request-timestamp': String(nowTs) }, rawBody: body, json: { event: { type: 'message', text: '/agents', user: 'U1', channel: 'C1' } } });
  eq(good.status, 200, 'valid signature accepted');
  const stale = Math.floor(Date.now() / 1000) - 900;
  const staleSig = `v0=${sign('sha256', 'shh', `v0:${stale}:${body}`)}`;
  const replay = await comms.handleInbound('slack', { headers: { 'x-slack-signature': staleSig, 'x-slack-request-timestamp': String(stale) }, rawBody: body });
  eq(replay.status, 401, 'stale timestamp rejected');
  const forged = await comms.handleInbound('slack', { headers: { 'x-slack-signature': 'v0=deadbeef', 'x-slack-request-timestamp': String(nowTs) }, rawBody: body });
  eq(forged.status, 401, 'forged digest rejected');
});

await check('WhatsApp inbound uses the app secret as the sha256 key', async () => {
  comms.saveChannelConfig('whatsapp', { accessToken: 'EAAG-secret', phoneNumberId: '1', verifyToken: 'v', recipient: '+2348000000000' });
  comms.toggleChannel('whatsapp', true);
  const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: '2348000000000', text: { body: '/tasks' } }] } }] }] });
  const signature = `sha256=${sign('sha256', 'EAAG-secret', raw)}`;
  const good = await comms.handleInbound('whatsapp', { headers: { 'x-hub-signature-256': signature }, rawBody: raw });
  eq(good.status, 200, 'valid signature accepted');
  assert(/Board:/.test(good.reply), `board summary replied (${good.reply})`);
  const bad = await comms.handleInbound('whatsapp', { headers: { 'x-hub-signature-256': 'sha256=00' }, rawBody: raw });
  eq(bad.status, 401, 'bad signature rejected');
  const handshake = adapters.ADAPTERS.whatsapp.verifyHandshake({ 'hub.mode': 'subscribe', 'hub.verify_token': 'v' }, { verifyToken: 'v' });
  assert(handshake, 'Meta GET handshake accepted with the right token');
});

await check('SMS inbound verifies the Twilio HMAC-SHA1 signature', async () => {
  comms.saveChannelConfig('sms', { baseUrl: 'https://api.twilio.test', accountSid: 'AC1', authToken: 'tok', from: '+1555', to: '+2348' });
  comms.saveChannelConfig('sms', { webhookUrl: 'https://app.test/api/v1/comms/sms/inbound' });
  comms.toggleChannel('sms', true);
  const params = { From: '+2348000000000', Body: '/status' };
  const data = 'https://app.test/api/v1/comms/sms/inbound' + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const sig = Buffer.from(createHmac('sha1', 'tok').update(data).digest('hex')).toString();
  const good = await comms.handleInbound('sms', { headers: { 'x-twilio-signature': sig }, json: params });
  eq(good.status, 200, 'valid Twilio signature accepted');
  const bad = await comms.handleInbound('sms', { headers: { 'x-twilio-signature': 'nope' }, json: params });
  eq(bad.status, 401, 'bad Twilio signature rejected');
});

await check('a disabled channel rejects inbound before verifying', async () => {
  comms.toggleChannel('discord', false);
  const res = await comms.handleInbound('discord', { headers: {}, json: { type: 2 } });
  eq(res.status, 403, 'disabled channel');
});

await check('gated commands cannot run from a channel', async () => {
  const out = comms.runChannelCommand('/approve ap-2');
  assert(out.ok && out.gated, 'gated, not executed');
  assert(/open SwarmOS/i.test(out.reply), 'tells the user to confirm in-app');
  comms.setCommandAllowed('/status', false);
  const blocked = comms.runChannelCommand('/status');
  assert(!blocked.ok && blocked.reason === 'blocked', 'disabled command is refused');
  comms.setCommandAllowed('/status', true);
  const unknown = comms.runChannelCommand('/deploy everything');
  eq(unknown.reason, 'unknown_command', 'unknown commands refused');
});

/* ---------- 6. routing + Copilot ---------- */
await check('routing attaches agents and only counts enabled, configured channels', async () => {
  const agent = state().agents[0];
  const out = comms.routeAgent('telegram', agent.id, true);
  assert(out.ok, 'routeAgent failed');
  assert(state().comms.channels.telegram.routing.agents.includes(agent.id), 'agent attached');
  const routes = comms.routesFor(agent.id);
  assert(routes.includes('telegram'), `telegram should carry this agent (${routes.join(',')})`);
  assert(!routes.includes('slack') || channels.channelStatus('slack', state().comms.channels.slack) !== 'not_configured', 'slack only when configured');
  comms.routeAgent('telegram', agent.id, false);
  assert(!state().comms.channels.telegram.routing.agents.includes(agent.id), 'agent detached');
});

await check('Copilot drives comms and refuses secrets in chat', async () => {
  const status = comms.commsCommand('comms status');
  assert(status.ok && /Telegram/.test(status.reply), 'status lists channels');

  const creds = comms.commsCommand('connect telegram');
  assert(creds.ok === false && creds.reason === 'needs_credentials', 'credential entry refused in chat');
  assert(/never accept secrets/i.test(creds.reply), 'explains why');

  const mute = comms.commsCommand('mute telegram');
  assert(mute.ok, 'mute works');
  eq(state().comms.channels.telegram.enabled, false, 'channel disabled by mute');
  const wake = comms.commsCommand('wake telegram');
  assert(wake.ok, 'wake works');
  eq(state().comms.channels.telegram.enabled, true, 'channel re-enabled');

  const route = comms.commsCommand(`route ${state().agents[0].name} to telegram`);
  assert(route, 'route intent recognised');
  assert(route.ok, `route intent (${route.reply})`);

  const test = comms.commsCommand('test telegram');
  assert(test.ok === 'async' && typeof test.run === 'function', 'test intent is executable');

  const inbox = comms.commsCommand('inbox');
  assert(inbox.ok, 'inbox intent');

  eq(comms.commsCommand('create agent Nova'), null, 'unrelated text is not hijacked');
});

/* ---------- 7. adapter contract ---------- */
await check('every adapter builds a request, parses inbound and states its signature', async () => {
  const caps = adapters.capabilities();
  eq(Object.keys(caps).length, 6, 'six adapters');
  Object.values(caps).forEach((c, i) => assert(c.outbound && c.inbound, `adapter ${i} incomplete`));
  assert(caps.browser.local && !caps.browser.signature, 'browser is local with no signature');
  Object.entries(caps).filter(([id]) => id !== 'browser').forEach(([id]) => assert(caps[id].signature, `${id} must verify signatures`));

  const configs = {
    telegram: { botToken: '1:a', chatId: '4' },
    whatsapp: { accessToken: 'a', phoneNumberId: 'p', recipient: '+1' },
    discord: { botToken: 'b', channelId: 'c' },
    slack: { botToken: 'x', channel: '#c' },
    sms: { accountSid: 'AC', authToken: 't', from: '+1', to: '+2' },
    browser: {},
  };
  for (const [id, config] of Object.entries(configs)) {
    const built = await adapters.buildRequest(id, config, { text: 'hi' });
    assert(built.ok, `${id} failed to build: ${built.error}`);
    if (id !== 'browser') {
      assert(built.request.url.startsWith('http'), `${id} has no URL`);
      assert(built.request.method, `${id} has no method`);
    }
  }
  assert(/graph\.facebook\.com/.test((await adapters.buildRequest('whatsapp', configs.whatsapp, { text: 'x' })).request.url), 'whatsapp uses the Graph API');
  assert(/discord\.com\/api/.test((await adapters.buildRequest('discord', configs.discord, { text: 'x' })).request.url), 'discord uses the v10 API');
  assert(/Authorization/i.test(Object.keys((await adapters.buildRequest('slack', configs.slack, { text: 'x' })).request.headers).join(',')) || (await adapters.buildRequest('slack', configs.slack, { text: 'x' })).request.headers.authorization, 'slack sends a bearer token');
});

await check('secrets are never echoed back in the panel', async () => {
  await fresh('comms');
  click(q('[data-act="comms-open"][data-id="telegram"]', view()));
  await sleep(50);
  const s = sheet();
  const tokenInput = q('[data-cf="botToken"]', s);
  assert(tokenInput, 'token field rendered');
  assert(/^••••/.test(tokenInput.value), `secret must be masked (got “${tokenInput.value}”)`);
  assert(!text(s).includes('123:abc'), 'raw token is not in the sheet');
});

console.log(results.join('\n'));
if (failures) {
  console.error(`\n${failures} comms test(s) failed`);
  process.exit(1);
}
console.log(`\nCOMMS: ${results.length}/${results.length} PASSED`);
process.exit(0);
