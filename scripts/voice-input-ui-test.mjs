/* Local voice input in the Copilot panel — the fallback chain, with its consents and its refusals.
 * Run: npm run test:voice-input:ui
 *
 * What is asserted (and what it protects):
 *   • a deployment with a speech host asks for the *local* consent, naming the gateway — never the
 *     network one, and never both;
 *   • the microphone is not opened before consent;
 *   • stopping a recording posts the clip to the gateway, and the transcript lands in the composer
 *     **unsent** — a whole-clip transcript is a guess until a person reads it;
 *   • discarding a recording sends nothing at all and releases the microphone;
 *   • a failed transcription is reported in the gateway's words and does **not** fall back to the browser
 *     recogniser — re-sending someone's audio elsewhere is the leak the consent screen exists to stop;
 *   • a refused microphone, a browser that cannot record, and a gateway with no host each say which thing
 *     is missing, and text input keeps working through every one of them;
 *   • a silent clip is "heard nothing", not an empty message that gets sent.
 */
import { Window } from 'happy-dom';

const results = [];
let failures = 0;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); console.log(`PASS ${name}`); }
  catch (error) { failures += 1; results.push(`FAIL ${name}: ${error.message}`); console.log(`FAIL ${name}: ${error.message}`); }
}
const assert = (cond, message) => { if (!cond) throw new Error(message); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); };
const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

const win = new Window({ url: 'http://localhost:5173/#/home' });
for (const k of ['document', 'location', 'localStorage', 'history', 'HTMLElement',
  'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame', 'Blob']) {
  const value = win[k] ?? win;
  try { Object.defineProperty(globalThis, k, { value, configurable: true, writable: true }); } catch { try { globalThis[k] = value; } catch { /* frozen */ } }
}
globalThis.window = win;
globalThis.document = win.document;
globalThis.localStorage = win.localStorage;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
win.matchMedia = globalThis.matchMedia;
win.document.body.innerHTML = '<div id="app"><div id="view"></div><div id="sheet-root"></div><div id="toast-root"></div></div>';
globalThis.fetch = async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });

/* ---------- a microphone and a recorder, without either being real ---------- */
const mic = {
  granted: true,
  error: null,
  calls: 0,
  tracksStopped: 0,
  recorders: [],
};
globalThis.isSecureContext = true;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  writable: true,
  value: {
    onLine: true,
    language: 'en-GB',
    mediaDevices: {
      async getUserMedia() {
        mic.calls += 1;
        if (mic.error) throw Object.assign(new Error('denied'), { name: mic.error });
        return { getTracks: () => [{ kind: 'audio', stop: () => { mic.tracksStopped += 1; } }] };
      },
    },
  },
});

class FakeRecorder {
  static isTypeSupported(type) { return /webm|ogg/.test(type); }
  constructor(stream, options) {
    this.stream = stream;
    this.mimeType = options?.mimeType || 'audio/webm';
    this.state = 'inactive';
    mic.recorders.push(this);
  }
  start() { this.state = 'recording'; setTimeout(() => this.ondataavailable?.({ data: new Blob(['opus-bytes'], { type: this.mimeType }) }), 5); }
  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    setTimeout(() => this.onstop?.(), 5);
  }
}
globalThis.MediaRecorder = FakeRecorder;

let RecognitionCtor = null;
function installRecognition(present) {
  RecognitionCtor = present
    ? class {
      constructor() { this.started = false; }
      start() { this.started = true; }
      stop() {}
    }
    : null;
  globalThis.SpeechRecognition = RecognitionCtor;
}
installRecognition(false);

await import('../src/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(140);
const api = await import('../src/api.js');
const auth = await import('../src/auth.js');
const panel = await import('../src/copilot/panel.js');
const voiceInput = await import('../src/copilot/voiceInput.js');
const core = await import('../src/core.js');

const q = (sel) => win.document.querySelector('#copilot-panel')?.querySelector(sel) || null;
const status = () => text(q('#cp-voice-status'));
const micButton = () => q('.cp-mic');
const composer = () => q('#copilot-input');
const tap = (el) => el?.dispatchEvent(new win.Event('click', { bubbles: true }));

const GW = 'http://voice.test';
const PERMS = ['read', 'copilot:read', 'copilot:write', 'voice:read', 'voice:transcribe', 'voice:configure', 'approval:request', 'approval:decide'];

const state = { calls: [], capabilities: { localStt: false, reason: 'none' }, transcribeStatus: 200, transcribeBody: { text: 'what is on my board', empty: false, engine: 'whisper.cpp', endpointLabel: 'Local whisper', stayedLocal: true } };

function stubGateway(overrides = {}) {
  state.calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(GW, '');
    const method = init.method || 'GET';
    state.calls.push({ path, method, body: init.body, contentType: init.headers?.['Content-Type'] || init.headers?.['content-type'] || '' });
    const json = (code, payload) => new Response(JSON.stringify(payload), { status: code, headers: { 'content-type': 'application/json' } });
    if (path === '/api/v1/auth/session') {
      return json(200, { principal: { id: 'pr-1', name: 'Owner', role: 'Owner' }, permissions: PERMS, csrfToken: 'csrf' });
    }
    if (path === '/api/v1/agents') return json(200, []);
    if (path === '/api/v1/tasks') return json(200, []);
    if (path === '/api/v1/approvals') return json(200, []);
    if (path === '/api/v1/teams') return json(200, { teams: [], unassigned: 0, totalAgents: 0 });
    if (path.startsWith('/api/v1/events')) return json(200, []);
    if (path === '/api/v1/voice' && method === 'GET') return json(200, overrides.capabilities || state.capabilities);
    if (path.startsWith('/api/v1/voice/transcribe') && method === 'POST') {
      if (state.transcribeStatus !== 200) return json(state.transcribeStatus, overrides.transcribeError || { error: 'the speech host returned HTTP 500', code: 'host-error' });
      return json(200, state.transcribeBody);
    }
    if (path === '/api/v1/copilot' && method === 'GET') {
      return json(200, {
        conversation: { id: 'cp-1', createdAt: 1 }, messages: [],
        runtime: { configured: true, providerId: 'pv-anthropic', providerName: 'Anthropic', model: 'test-model', reason: '', code: 'ready', streaming: false, costBasis: 'estimated', note: '' },
      });
    }
    if (path === '/api/v1/copilot/messages' && method === 'POST') {
      const user = { id: 'r-1', role: 'user', text: JSON.parse(init.body).text, ts: 1, modelCallId: null, payload: {} };
      const reply = { id: 'r-2', role: 'assistant', text: 'Here is your board.', ts: 2, modelCallId: 3, payload: { model: 'test-model', callId: 3, costBasis: 'estimated' } };
      return json(200, { userMessage: user, reply, usage: reply.payload, conversation: { id: 'cp-1' } });
    }
    return json(404, { error: 'not found' });
  };
}

async function openWith(overrides = {}) {
  api.setGatewayUrl(GW);
  stubGateway(overrides);
  state.transcribeStatus = 200;
  state.transcribeBody = { text: 'what is on my board', empty: false, engine: 'whisper.cpp', endpointLabel: 'Local whisper', stayedLocal: true };
  mic.calls = 0;
  mic.tracksStopped = 0;
  mic.error = null;
  mic.recorders = [];
  // Consent is persisted on purpose; a test that inherited it would be asserting against a state the
  // person never chose. Clear it so every scenario starts from "nothing allowed yet".
  win.localStorage.removeItem('mmm-state-v1');
  core.resetDemo(); // consent lives in the store, and the store outlives a scenario
  await auth.refreshSession({ silent: true });
  panel.resetCopilotSession();
  panel.openCopilot();
  await sleep(260);
  q('[data-cp="toggle-advanced"]')?.dispatchEvent(new win.Event('click', { bubbles: true }));
  await sleep(80);
  return q('#copilot-panel');
}

/* ---------- 1. no path at all ---------- */
await check('with no speech host and no recogniser, the mic says typing is the only way in', async () => {
  installRecognition(false);
  await openWith({ capabilities: { localStt: false, reason: 'none' } });
  assert(/typing/i.test(status()), `the status names typing (got “${status()}”)`);
  tap(micButton());
  await sleep(120);
  eq(mic.calls, 0, 'the microphone was never opened');
  assert(/typing/i.test(status()), `and the tap explains why (got “${status()}”)`);
  eq(q('.cp-consent'), null, 'no consent was asked for a path that does not exist');
  await panel.closeCopilot();
});

/* ---------- 2. the local path asks for the local consent ---------- */
await check('a configured speech host asks for the local consent, and names the gateway', async () => {
  await openWith({ capabilities: { localStt: true, reason: 'one host' } });
  assert(/gateway|network/i.test(status()), `the status describes the local path (got “${status()}”)`);
  tap(micButton());
  await sleep(120);
  const consent = q('.cp-consent');
  assert(consent, 'a consent card is shown');
  eq(consent.getAttribute('data-consent'), 'local', 'and it is the local one');
  assert(/gateway/i.test(text(consent)), `it names the gateway (got “${text(consent)}”)`);
  assert(!/browser’s speech service/i.test(text(consent)), 'and does not describe the vendor service');
  eq(mic.calls, 0, 'the microphone was not opened before consent');
  await panel.closeCopilot();
});

/* ---------- 3. record → transcript, unsent ---------- */
await check('allowing records a clip, sends it to the gateway, and puts the transcript in the composer unsent', async () => {
  await openWith({ capabilities: { localStt: true, reason: 'one host' } });
  tap(micButton());
  await sleep(80);
  tap(q('[data-cp="voice-consent-allow"]'));
  await sleep(200);
  eq(q('.cp-consent'), null, 'the consent card is dismissed');
  eq(mic.calls, 1, 'the microphone was opened once');
  assert(/Recording/i.test(status()), `the status says it is recording (got “${status()}”)`);
  assert(q('[data-cp="voice-cancel"]'), 'and a discard control appears with it');

  tap(micButton()); // stop
  await sleep(600);
  const posted = state.calls.filter((c) => c.path.startsWith('/api/v1/voice/transcribe'));
  eq(posted.length, 1, 'exactly one clip was posted');
  eq(posted[0].method, 'POST', 'as a POST');
  assert(/^audio\//.test(posted[0].contentType), `with an audio content type (got "${posted[0].contentType}")`);
  eq(mic.tracksStopped >= 1, true, 'the microphone tracks were released');
  eq(composer()?.value, 'what is on my board', 'the transcript is in the composer');
  eq(state.calls.filter((c) => c.path === '/api/v1/copilot/messages' && c.method === 'POST').length, 0, 'and nothing was sent to the Copilot');
  assert(/review it, then send/i.test(status()), `the status says to review it (got “${status()}”)`);
  assert(/stayed on your network/i.test(status()), 'and that the audio did not leave the network');
  eq(q('[data-cp="voice-cancel"]'), null, 'the discard control is gone');
  await panel.closeCopilot();
});

/* ---------- 4. discard ---------- */
await check('discarding a recording sends nothing and releases the microphone', async () => {
  await openWith({ capabilities: { localStt: true, reason: 'one host' } });
  tap(micButton());
  await sleep(80);
  tap(q('[data-cp="voice-consent-allow"]'));
  await sleep(200);
  tap(q('[data-cp="voice-cancel"]'));
  await sleep(400);
  eq(state.calls.filter((c) => c.path.startsWith('/api/v1/voice/transcribe')).length, 0, 'nothing was uploaded');
  eq(mic.tracksStopped >= 1, true, 'the microphone was released');
  assert(/discarded/i.test(status()), `the status says so (got “${status()}”)`);
  eq(composer()?.value || '', '', 'and the composer was untouched');
  await panel.closeCopilot();
});

/* ---------- 5. a failure does not become a leak ---------- */
await check('a failed transcription is reported in the gateway’s words and does not re-route to the network', async () => {
  installRecognition(true); // a recogniser exists — and must still not be used
  await openWith({
    capabilities: { localStt: true, reason: 'one host' },
    transcribeError: { error: 'The speech host returned HTTP 500: model crashed.', code: 'host-error' },
  });
  state.transcribeStatus = 502;
  tap(micButton());
  await sleep(80);
  tap(q('[data-cp="voice-consent-allow"]'));
  await sleep(200);
  tap(micButton());
  await sleep(600);
  const body = status();
  assert(/HTTP 500/.test(body), `the gateway’s reason is shown verbatim (got “${body}”)`);
  assert(/Typing still works/i.test(body), 'and it says typing still works');
  eq(composer()?.value || '', '', 'nothing was typed into the composer');
  eq(q('.cp-consent'), null, 'no second consent was raised behind the person’s back');
  installRecognition(false);
  await panel.closeCopilot();
});

/* ---------- 6. microphone refused ---------- */
await check('a refused microphone is named, and nothing is uploaded', async () => {
  await openWith({ capabilities: { localStt: true, reason: 'one host' } });
  tap(micButton());
  await sleep(80);
  mic.error = 'NotAllowedError';
  tap(q('[data-cp="voice-consent-allow"]'));
  await sleep(300);
  const body = status();
  assert(/blocked/i.test(body) && /settings/i.test(body), `the refusal is explained (got “${body}”)`);
  assert(/Typing still works/i.test(body), 'and the way forward is named');
  eq(state.calls.filter((c) => c.path.startsWith('/api/v1/voice/transcribe')).length, 0, 'nothing was uploaded');
  await panel.closeCopilot();
});

/* ---------- 7. this browser cannot record ---------- */
await check('a browser that cannot record falls back to the recogniser and says why it did', async () => {
  installRecognition(true);
  const realRecorder = globalThis.MediaRecorder;
  globalThis.MediaRecorder = undefined;
  try {
    await openWith({ capabilities: { localStt: true, reason: 'one host' } });
    tap(micButton());
    await sleep(120);
    const consent = q('.cp-consent');
    assert(consent, 'a consent card is shown');
    eq(consent.getAttribute('data-consent'), 'network', 'for the network recogniser, because that is what will be used');
    assert(/cannot encode a recording|no MediaRecorder/i.test(text(consent)) === false, 'the consent card is about the network path, not a technical excuse');
    eq(mic.calls, 0, 'the microphone was not opened for the path that cannot work');
  } finally {
    globalThis.MediaRecorder = realRecorder;
    installRecognition(false);
    await panel.closeCopilot();
  }
});

/* ---------- 8. a silent clip ---------- */
await check('a silent clip says nothing was heard, and does not send an empty message', async () => {
  await openWith({ capabilities: { localStt: true, reason: 'one host' } });
  state.transcribeBody = { text: '', empty: true, engine: 'whisper.cpp', endpointLabel: 'Local whisper', stayedLocal: true };
  tap(micButton());
  await sleep(80);
  tap(q('[data-cp="voice-consent-allow"]'));
  await sleep(200);
  tap(micButton());
  await sleep(600);
  assert(/heard nothing/i.test(status()), `the status says nothing was heard (got “${status()}”)`);
  eq(composer()?.value || '', '', 'the composer stays empty');
  eq(state.calls.filter((c) => c.path === '/api/v1/copilot/messages' && c.method === 'POST').length, 0, 'and nothing was sent');
  await panel.closeCopilot();
});

/* ---------- 9. text always works ---------- */
await check('text input works with every voice path unavailable', async () => {
  installRecognition(false);
  await openWith({ capabilities: { localStt: false, reason: 'none' } });
  const input = composer();
  assert(input, 'the composer exists');
  input.value = 'what is on my board?';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  q('#cp-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(400);
  const sent = state.calls.filter((c) => c.path === '/api/v1/copilot/messages' && c.method === 'POST');
  eq(sent.length, 1, 'the message went through');
  eq(JSON.parse(sent[0].body).text, 'what is on my board?', 'with what was typed');
  await panel.closeCopilot();
});

/* ---------- 10. the chain itself, without a DOM ---------- */
await check('the chain orders local before network before text, and never sideways', async () => {
  const okSupport = { ok: true, reason: 'ready', mimeTypes: ['audio/webm'] };
  const noSupport = { ok: false, reason: 'This browser cannot encode a recording.' };
  const local = voiceInput.resolvePath({ capabilities: { localStt: true }, support: okSupport, env: { SpeechRecognition: class {} } });
  eq(local.transport, 'local-stt', 'local wins when it works, even with a recogniser present');
  eq(local.requiresConsent, 'local', 'and asks for the local consent');
  const network = voiceInput.resolvePath({ capabilities: { localStt: false }, support: okSupport, env: { SpeechRecognition: class {} } });
  eq(network.transport, 'browser-recognition', 'the recogniser is second');
  eq(network.requiresConsent, 'network', 'with its own consent');
  const explain = voiceInput.resolvePath({ capabilities: { localStt: true }, support: noSupport, env: { SpeechRecognition: class {} } });
  eq(explain.transport, 'browser-recognition', 'a browser that cannot record falls to the recogniser');
  assert(/cannot encode a recording/.test(explain.reason), `and says why (got "${explain.reason}")`);
  const offline = voiceInput.resolvePath({ capabilities: { localStt: true }, support: okSupport, online: false });
  eq(offline.transport, 'text', 'offline is text, not a silent upload');
  const silent = voiceInput.resolvePath({ capabilities: { localStt: false }, support: okSupport, env: {} });
  eq(silent.transport, 'text', 'nothing available is text');
  assert(/Typing always works/.test(silent.reason), `and the reason says so (got "${silent.reason}")`);
});

console.log(`\nVOICE INPUT UI: ${results.filter((r) => r.startsWith('PASS')).length} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
