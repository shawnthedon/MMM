import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { ADAPTERS, deliver } from '../src/commsAdapters.js';

const sms = { accountSid: 'ACexample', authToken: 'test-token', from: '+15551234567', to: '+15557654321', webhookUrl: 'https://app.test/api/v1/comms/sms/inbound' };
let sent = 0;
const provider = async (_url, init) => {
  sent += 1;
  assert.equal(init.redirect, 'error');
  return new Response(JSON.stringify({ sid: 'SMmock' }), { status: 201 });
};
for (const baseUrl of ['http://127.0.0.1:9292', 'http://169.254.169.254', 'https://api.twilio.com.evil.test', 'https://user@api.twilio.com', 'https://api.twilio.com/path']) {
  const result = await deliver('sms', { ...sms, baseUrl }, { text: 'test' }, { fetchImpl: provider });
  assert.equal(result.ok, false, baseUrl);
}
assert.equal(sent, 0, 'unsafe endpoints must not be contacted');
assert.equal((await deliver('sms', sms, { text: 'test' }, { fetchImpl: provider })).ok, true);
assert.equal(sent, 1);

const params = new URLSearchParams({ Body: '/status', From: '+15557654321' });
const data = sms.webhookUrl + 'Body/status' + 'From+15557654321';
const sig = createHmac('sha1', sms.authToken).update(data).digest('base64');
assert.equal(await ADAPTERS.sms.verify({ 'x-twilio-signature': sig }, params.toString(), sms), true);
assert.equal(await ADAPTERS.sms.verify({ 'x-twilio-signature': sig }, params.toString(), { ...sms, webhookUrl: '' }), false);

const raw = '{"test":true}';
const meta = { appSecret: 'app-secret', accessToken: 'access-token' };
const signature = `sha256=${createHmac('sha256', meta.appSecret).update(raw).digest('hex')}`;
assert.equal(await ADAPTERS.whatsapp.verify({ 'x-hub-signature-256': signature }, raw, meta), true);
assert.equal(await ADAPTERS.whatsapp.verify({ 'x-hub-signature-256': signature }, raw, { accessToken: 'access-token' }), false);
assert.equal(ADAPTERS.whatsapp.verifyHandshake({ 'hub.mode': 'subscribe' }, {}), false);

const telegram = { botToken: '123:fake', chatId: '1' };
const malformed = async () => new Response('not json', { status: 200 });
assert.equal((await deliver('telegram', telegram, { text: 'test' }, { fetchImpl: malformed })).ok, false);
const slack = { botToken: 'fake', channel: 'ops' };
assert.equal((await deliver('slack', slack, { text: 'test' }, { fetchImpl: malformed })).ok, false);
assert.equal((await deliver('sms', sms, { text: 'test' }, { fetchImpl: malformed })).ok, false);
assert.equal((await deliver('whatsapp', { accessToken: 't', phoneNumberId: '1', recipient: '+123' }, { text: 'test' }, { fetchImpl: malformed })).ok, false);
const stall = async (_url, init) => ({ status: 200, json: () => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('abort'), { name: 'AbortError' })))) });
assert.equal((await deliver('telegram', telegram, { text: 'test' }, { fetchImpl: stall, timeoutMs: 15 })).reason, 'timeout');
console.log('PROVIDER SAFETY: endpoint restriction, redirects, Twilio/Meta signatures, malformed responses and body timeout passed');
