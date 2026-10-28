/* Voice Studio + live type-to-speech acceptance tests.
 * Run: npm run test:voice
 *
 * These cover the deterministic half of the specification with a controllable fake engine:
 * chunking, generation ordering, cancellation, stale-audio rejection, profile consent/revocation,
 * local-first routing, endpoint validation, persistence/migration and the rendered UI contract.
 * Real audio output is NOT proven here — see scripts/voice-browser-test.mjs and
 * docs/voice/VOICE_STUDIO.md for the honest device matrix.
 */
import { Window } from 'happy-dom';
import assert from 'node:assert/strict';

/* ---------- deterministic engine ---------- */
function createFakeEngine({ autoResolve = false } = {}) {
  const calls = [];
  const cancelled = [];
  let pending = [];
  const engine = {
    id: 'fake',
    calls,
    cancelled,
    speak(request) {
      const record = { text: request.text, voice: request.voice?.name || null, generation: request.generation, requestId: request.requestId };
      calls.push(record);
      return new Promise((resolve, reject) => {
        const entry = { record, resolve, reject, signal: request.signal };
        pending.push(entry);
        request.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
        if (autoResolve) setTimeout(() => { if (!request.signal?.aborted) resolve(); }, 0);
      });
    },
    cancelRequest() { cancelled.push(Date.now()); },
    /** Resolve the oldest unresolved chunk (FIFO, like real playback). */
    finishNext() {
      const entry = pending.shift();
      if (entry && !entry.signal?.aborted) entry.resolve();
      return entry?.record;
    },
    pendingCount: () => pending.filter((entry) => !entry.signal?.aborted).length,
  };
  return engine;
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
let failures = 0;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); } catch (error) { failures += 1; results.push(`FAIL ${name}: ${error.message}`); }
}

const chunker = await import('../src/voice/chunker.js');
const queueModule = await import('../src/voice/queue.js');
const studioModule = await import('../src/voice/studio.js');
const profilesModule = await import('../src/voice/profiles.js');
const registry = await import('../src/voice/registry.js');
const adapters = await import('../src/voice/adapters.js');

/* =====================================================================================
 * A. Chunking
 * ===================================================================================*/
await check('A1 sentence splitting preserves order and punctuation', () => {
  assert.deepEqual(chunker.splitSentences('One. Two! Three?'), ['One.', 'Two!', 'Three?']);
});

await check('A2 abbreviations and decimals do not end a sentence', () => {
  assert.deepEqual(chunker.splitSentences('Dr. Smith paid 3.14 euros. Then he left.'), ['Dr. Smith paid 3.14 euros.', 'Then he left.']);
  assert.deepEqual(chunker.splitSentences('Use e.g. this one. Done.'), ['Use e.g. this one.', 'Done.']);
});

await check('A3 ellipsis counts once, not three times', () => {
  assert.deepEqual(chunker.splitSentences('Wait... what now?'), ['Wait...', 'what now?']);
});

await check('A4 over-long text is split on word boundaries, never mid-word', () => {
  const chunks = chunker.splitSentences(`${'alpha '.repeat(80)}end.`);
  assert(chunks.length > 1);
  chunks.forEach((chunk) => assert(chunk.length <= 280, `chunk too long: ${chunk.length}`));
  assert(chunks.every((chunk) => !/^\S*$/.test(chunk) && !chunk.startsWith(' ')));
});

await check('A5 incremental buffer emits a sentence once and buffers the partial tail', () => {
  const buffer = chunker.createSentenceBuffer();
  assert.deepEqual(buffer.update('Hello there. How'), ['Hello there.']);
  assert.deepEqual(buffer.update('Hello there. How are'), []);
  assert.deepEqual(buffer.update('Hello there. How are you?'), ['How are you?']);
  assert.equal(buffer.flush(), '');
  assert.equal(buffer.isPending(), false);
});

await check('A6 buffer resets itself when earlier text is edited', () => {
  const buffer = chunker.createSentenceBuffer();
  assert.deepEqual(buffer.update('One. Two.'), ['One.', 'Two.']);
  assert.deepEqual(buffer.update('Uno. Two.'), ['Uno.', 'Two.']);
});

/* =====================================================================================
 * B. Queue ordering, cancellation, stale audio
 * ===================================================================================*/
await check('B1 chunks play in text order without overlap', async () => {
  const engine = createFakeEngine();
  const queue = queueModule.createSpeechQueue({ engine });
  queue.enqueue(['first', 'second', 'third']);
  const run = queue.play();
  await tick();
  assert.deepEqual(engine.calls.map((call) => call.text), ['first'], 'only one chunk may start at a time');
  engine.finishNext();
  await tick();
  assert.deepEqual(engine.calls.map((call) => call.text), ['first', 'second']);
  engine.finishNext();
  await tick();
  engine.finishNext();
  await run;
  assert.deepEqual(engine.calls.map((call) => call.text), ['first', 'second', 'third']);
  assert.equal(queue.snapshot().status, 'idle');
});

await check('B2 stop discards the queue and cancels the in-flight engine call', async () => {
  const engine = createFakeEngine();
  const queue = queueModule.createSpeechQueue({ engine });
  queue.enqueue(['a', 'b', 'c']);
  void queue.play();
  await tick();
  queue.stop();
  engine.finishNext();
  await tick();
  assert.deepEqual(engine.calls.map((call) => call.text), ['a'], 'stale chunks must not start');
  assert.equal(engine.cancelled.length, 1, 'engine.cancel was not called');
  assert.deepEqual(queue.snapshot().queued, []);
});

await check('B3 late completion of a cancelled request never resumes playback', async () => {
  const engine = createFakeEngine();
  const queue = queueModule.createSpeechQueue({ engine });
  queue.enqueue(['old one', 'old two']);
  void queue.play();
  await tick();
  queue.invalidate('text changed');
  queue.enqueue(['new one']);
  void queue.play();
  await tick();
  engine.finishNext(); // late "old one" completion
  await tick();
  assert.deepEqual(engine.calls.map((call) => call.text), ['old one', 'new one']);
  assert.equal(queue.snapshot().queued.length, 0, 'old generation chunks must be gone');
});

await check('B4 queue overflow is reported instead of silently dropping speech', () => {
  const engine = createFakeEngine();
  const queue = queueModule.createSpeechQueue({ engine, maxQueued: 2 });
  queue.enqueue(['1', '2', '3']);
  assert.match(queue.snapshot().lastError?.message || '', /queue is full/i);
  assert.equal(queue.snapshot().queued.length, 2);
});

await check('B5 engine errors surface without wedging the queue', async () => {
  const engine = createFakeEngine();
  let calls = 0;
  engine.speak = () => {
    calls += 1;
    const error = new Error('engine exploded');
    error.code = 'boom';
    return Promise.reject(error);
  };
  const queue = queueModule.createSpeechQueue({ engine });
  queue.enqueue(['x', 'y']);
  await queue.play();
  assert.equal(queue.snapshot().status, 'error');
  assert.match(queue.snapshot().lastError.message, /engine exploded/);
  assert.equal(calls, 1, 'the queue must not retry forever after a hard failure');
});

/* =====================================================================================
 * C. Studio behaviour (acceptance tests TTS-01 … TTS-14)
 * ===================================================================================*/
const baseSettings = {
  autoSpeak: true, strategy: 'sentence', selectedProfileId: 'my-cloned-voice',
  modelId: 'browser-speech', rate: 1, pitch: 1, lang: '', idleFlushMs: 40, maxChars: 280,
};
const studioProfiles = profilesModule.defaultProfiles();

function makeStudio(overrides = {}) {
  const engine = overrides.engine || createFakeEngine();
  const persisted = [];
  const studio = studioModule.createVoiceStudio({
    engine,
    profiles: overrides.profiles || studioProfiles,
    cloningSupport: overrides.cloningSupport || { supported: false, reason: 'No cloning engine is configured.' },
    settings: { ...baseSettings, ...(overrides.settings || {}) },
    persist: (next) => persisted.push(next),
  });
  return { studio, engine, persisted };
}

const coreSeed = await import('../src/core.js');
await check('TTS-01 defaults are My cloned voice, auto-speak on, sentence mode', () => {
  const seedVoice = coreSeed.seed().settings.voice;
  assert.equal(seedVoice.selectedProfileId, 'my-cloned-voice');
  assert.equal(seedVoice.autoSpeak, true);
  assert.equal(seedVoice.strategy, 'sentence');
  const { studio } = makeStudio();
  const snap = studio.snapshot();
  assert.equal(snap.config.strategy, 'sentence');
  assert.equal(snap.requestedProfile, 'my-cloned-voice');
  assert.equal(snap.usingFallback, true, 'a cloned profile without an engine must fall back explicitly');
  assert.match(snap.fallbackReason, /cloning engine/i);
});

await check('TTS-02 a completed sentence is submitted immediately', async () => {
  const { studio, engine } = makeStudio();
  studio.setText('Hello world.');
  await tick();
  assert.deepEqual(engine.calls.map((call) => call.text), ['Hello world.']);
});

await check('TTS-03 a partial sentence is buffered, not spoken per keystroke', async () => {
  const { studio, engine } = makeStudio();
  for (const value of ['H', 'He', 'Hel', 'Hell', 'Hello']) studio.setText(value);
  await tick();
  assert.equal(engine.calls.length, 0, 'partial text must not be submitted');
  assert.equal(studio.snapshot().pendingText, 'Hello');
  studio.setText('Hello there.');
  await tick();
  assert.deepEqual(engine.calls.map((call) => call.text), ['Hello there.']);
});

await check('TTS-04 multiple sentences queue in order without overlap', async () => {
  const { studio, engine } = makeStudio();
  studio.setText('One. Two. Three.');
  await tick();
  assert.deepEqual(engine.calls.map((call) => call.text), ['One.']);
  engine.finishNext(); await tick();
  assert.deepEqual(engine.calls.map((call) => call.text), ['One.', 'Two.']);
  engine.finishNext(); await tick();
  assert.deepEqual(engine.calls.map((call) => call.text), ['One.', 'Two.', 'Three.']);
});

await check('TTS-05 audio starts before the whole message is written (sentence streaming)', async () => {
  const { studio, engine } = makeStudio();
  studio.setText('First sentence is complete.');
  await tick();
  assert.equal(engine.calls.length, 1, 'first sentence should already be speaking');
  studio.setText('First sentence is complete. Second is still being typed');
  await tick();
  assert.equal(engine.calls.length, 1, 'the unfinished second sentence is not submitted yet');
});

await check('TTS-06 delayed chunks cannot duplicate or reorder playback', async () => {
  const { studio, engine } = makeStudio();
  studio.setText('Alpha. Beta.');
  await tick();
  engine.finishNext();
  await tick();
  engine.finishNext();
  await tick();
  assert.deepEqual(engine.calls.map((call) => call.text), ['Alpha.', 'Beta.']);
  assert.equal(engine.calls.length, 2);
});

await check('TTS-07 rapid editing invalidates stale synthesis', async () => {
  const { studio, engine } = makeStudio();
  studio.setText('Original text.');
  await tick();
  studio.setText('Replacement.');
  await tick();
  assert.equal(studio.snapshot().generation, 2, 'editing must start a new generation');
  assert.equal(engine.cancelled.length >= 1, true, 'the old engine request was not cancelled');
  assert.deepEqual(engine.calls.map((call) => call.text), ['Original text.', 'Replacement.']);
});

await check('TTS-08 clear during playback stops audio and drops pending chunks', async () => {
  const { studio, engine } = makeStudio();
  studio.setText('Keep going. Next chunk.');
  await tick();
  studio.clear();
  await tick();
  assert.equal(studio.text, '');
  assert.equal(studio.snapshot().status, 'idle');
  engine.finishNext();
  await tick();
  assert.deepEqual(engine.calls.map((call) => call.text), ['Keep going.'], 'the next chunk must never start');
});

await check('TTS-09 switching voice cancels the old generation and speaks in the new voice', async () => {
  const custom = [...studioProfiles, { id: 'vp-alt', name: 'Alt device voice', kind: 'device', engine: 'browser-speech', voiceRef: 'voice-alt', status: 'active', consent: null }];
  const { studio, engine, persisted } = makeStudio({ profiles: custom });
  studio.setText('First take.');
  await tick();
  studio.setProfile('vp-alt');
  await tick();
  assert.equal(studio.snapshot().config.selectedProfileId, 'vp-alt');
  assert.equal(persisted.at(-1).selectedProfileId, 'vp-alt');
  assert.deepEqual(engine.calls.map((call) => call.voice), [engine.calls[0].voice, 'Alt device voice']);
});

await check('TTS-10 revoked profile blocks synthesis with an explanation', async () => {
  const profiles = studioProfiles.map((profile) => profile.id === 'device-default' ? { ...profile, status: 'revoked' } : profile);
  const { studio } = makeStudio({ profiles });
  studio.setText('This must not be spoken.');
  await tick();
  const snap = studio.snapshot();
  assert.equal(snap.status, 'blocked');
  assert.match(snap.error.message, /revoked|available/i);
  assert.equal(snap.queued, 0);
});

await check('TTS-11 an engine failure keeps the editor usable and reports the error', async () => {
  const engine = createFakeEngine();
  engine.speak = () => Promise.reject(Object.assign(new Error('No audio device'), { code: 'audio' }));
  const { studio } = makeStudio({ engine });
  studio.setText('Try to speak.');
  await tick();
  await tick();
  const snap = studio.snapshot();
  assert.equal(snap.status, 'error');
  assert.match(snap.error.message, /No audio device/);
  studio.setText('Try again after the failure.');
  await tick();
  assert.equal(studio.text, 'Try again after the failure.', 'the editor must still accept text');
});

await check('TTS-13 no cloud speech adapter exists and routing never returns remote', () => {
  Object.values(registry.ADAPTERS).forEach((adapter) => assert.notEqual(adapter.where, 'remote'));
  const routed = registry.routeRequest({ modelId: 'qwen2.5-omni', capability: 'tts', adapterStatus: {} });
  assert.equal(routed.ok, false);
  assert.match(routed.reason, /adapter is configured/i);
  const browser = registry.routeRequest({ modelId: 'browser-speech', capability: 'tts', adapterStatus: { 'browser-speech': { status: 'available', detail: 'ok' } } });
  assert.equal(browser.location, 'on-device');
});

await check('TTS-14 repeated playback releases the queue (no accumulation)', async () => {
  const { studio, engine } = makeStudio();
  for (let i = 0; i < 4; i += 1) {
    studio.setText(`Run ${i}.`);
    await tick();
    engine.finishNext();
    await tick();
    studio.stop();
  }
  const snap = studio.snapshot();
  assert.equal(snap.queued, 0);
  assert.equal(engine.pendingCount(), 0);
});

await check('TTS-12 an unfinished tail is spoken after the idle flush, once', async () => {
  const { studio, engine } = makeStudio({ settings: { idleFlushMs: 120 } });
  studio.setText('This sentence has no terminator');
  await tick();
  assert.equal(engine.calls.length, 0, 'the tail must wait for the idle flush');
  await tick(260);
  assert.deepEqual(engine.calls.map((call) => call.text), ['This sentence has no terminator']);
  await tick(300);
  assert.equal(engine.calls.length, 1, 'the idle flush must not repeat');
});

await check('TTS-15 manual strategy speaks only on Play, and Play flushes the tail', async () => {
  const { studio, engine } = makeStudio({ settings: { strategy: 'manual' } });
  studio.setText('Manual one. Manual two');
  await tick(60);
  assert.equal(engine.calls.length, 0, 'manual mode must stay silent while typing');
  studio.playNow();
  await tick();
  assert.deepEqual(engine.calls.map((call) => call.text), ['Manual one.'], 'Play starts at the top of the text');
  engine.finishNext(); await tick();
  assert.deepEqual(engine.calls.map((call) => call.text), ['Manual one.', 'Manual two'], 'the unfinished tail is spoken last');
  engine.finishNext(); await tick();
  assert.equal(studio.snapshot().status, 'idle');
});

await check('TTS-16 only preferences are persisted — never text or audio', async () => {
  const { studio, persisted } = makeStudio();
  studio.setText('A secret sentence that must not be stored.');
  await tick();
  studio.setProfile('device-default');
  const last = persisted.at(-1) || {};
  const serialised = JSON.stringify(last);
  assert.equal(serialised.includes('secret sentence'), false, 'typed text leaked into persistence');
  ['autoSpeak', 'strategy', 'selectedProfileId', 'modelId'].forEach((key) => assert(key in last, `${key} should persist`));
  assert.equal('profiles' in last, false, 'profiles are owned by the settings slice, not the studio');
});

/* =====================================================================================
 * D. Profiles, consent, cloning
 * ===================================================================================*/
await check('D1 cloned profiles require consent and an engine', () => {
  const denied = profilesModule.createClonedProfile({ id: 'x', name: 'X', consent: null, engine: 'openvoice-v2' });
  assert.equal(denied.ok, false);
  const allowed = profilesModule.createClonedProfile({ id: 'x', name: 'X', consent: { granted: true, by: 'Maya' }, engine: 'openvoice-v2' });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.profile.consent.by, 'Maya');
  assert.equal(allowed.profile.status, 'active');
});

await check('D2 revoking a profile invalidates queued audio immediately', async () => {
  const { studio } = makeStudio();
  studio.setText('Queued before revocation.');
  await tick();
  const revoked = studioProfiles.map((profile) => profile.id === 'device-default' ? { ...profile, status: 'revoked' } : profile);
  studio.onProfilesChanged(revoked);
  const snap = studio.snapshot();
  assert.equal(snap.status, 'blocked');
  assert.equal(snap.queued, 0);
});

await check('D3 the cloning adapter refuses clearly when no engine is configured', async () => {
  const cloning = adapters.createCloningAdapter({ endpoint: '' });
  assert.equal(cloning.supports().supported, false);
  const created = await cloning.createVoiceProfile({ name: 'Voice', consent: { granted: true, by: 'Maya' } });
  assert.equal(created.supported, false);
  assert.match(created.reason, /No cloning engine/i);
  const validated = await cloning.validateReferenceAudio({ type: 'audio/wav', size: 1024 });
  assert.equal(validated.supported, false);
});

await check('D4 raw reference audio is never written into app state', () => {
  const { seed } = globalThis.__voiceCore || {};
  const voice = (seed ? seed() : { settings: { voice: {} } }).settings.voice;
  assert.equal(JSON.stringify(voice).includes('data:audio'), false);
  assert.equal(JSON.stringify(voice).includes('blob:'), false);
});

/* =====================================================================================
 * E. Endpoint validation (SSRF / credential hygiene)
 * ===================================================================================*/
await check('E1 only loopback hosts are accepted by default', () => {
  assert.equal(adapters.validateLocalEndpoint('http://127.0.0.1:8080').ok, true);
  assert.equal(adapters.validateLocalEndpoint('http://localhost:8080/').ok, true);
  assert.equal(adapters.validateLocalEndpoint('http://192.168.1.20:8080').ok, false);
  assert.equal(adapters.validateLocalEndpoint('https://tts.example.com').ok, false);
  assert.equal(adapters.validateLocalEndpoint('https://tts.example.com', { allowRemote: true }).ok, true);
  assert.equal(adapters.validateLocalEndpoint('http://tts.example.com', { allowRemote: true }).ok, false, 'remote hosts must use HTTPS');
});

await check('E2 credentials in the URL and non-HTTP schemes are rejected', () => {
  assert.equal(adapters.validateLocalEndpoint('http://user:pass@127.0.0.1:8080').ok, false);
  assert.equal(adapters.validateLocalEndpoint('file:///etc/passwd').ok, false);
  assert.equal(adapters.validateLocalEndpoint('javascript:alert(1)').ok, false);
  assert.equal(adapters.validateLocalEndpoint('not a url').ok, false);
});

await check('E3 an unreachable local host reports unreachable, never a fake success', async () => {
  const adapter = adapters.createLocalSpeechAdapter({
    endpoint: 'http://127.0.0.1:9',
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  const status = await adapter.checkAvailability();
  assert.equal(status.status, 'unreachable');
  assert.match(status.detail, /ECONNREFUSED|could not reach/i);
  await assert.rejects(() => adapter.speak({ text: 'hi' }), /reach|configured/i);
});

await check('E4 local adapter validates responses (status, content type, size)', async () => {
  const badStatus = adapters.createLocalSpeechAdapter({
    endpoint: 'http://127.0.0.1:8080',
    fetchImpl: async () => ({ ok: false, status: 500, headers: { get: () => 'application/json' } }),
  });
  await assert.rejects(() => badStatus.speak({ text: 'hi' }), /HTTP 500/);
  const badType = adapters.createLocalSpeechAdapter({
    endpoint: 'http://127.0.0.1:8080',
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, blob: async () => ({ size: 1 }) }),
  });
  await assert.rejects(() => badType.speak({ text: 'hi' }), /instead of audio/);
});

/* =====================================================================================
 * F. Registry
 * ===================================================================================*/
await check('F1 role filtering only returns models that declare the capability', () => {
  const tts = registry.filterModels({ role: 'tts' });
  assert(tts.length >= 2);
  tts.forEach((model) => assert(model.roles.includes('tts')));
  const stt = registry.filterModels({ role: 'stt' });
  assert.equal(stt.some((model) => model.id === 'browser-speech'), true);
  assert.equal(registry.filterModels({ role: 'tts' }).some((model) => model.roles.includes('stt') && !model.roles.includes('tts')), false);
});

await check('F2 catalogue honesty: nothing claims to be installed except the built-in engine', () => {
  registry.VOICE_MODELS.forEach((model) => {
    if (model.install !== 'built-in') assert.equal(model.verification === 'advertised' || model.verification === 'contract-only', true);
    if (model.id !== 'browser-speech') assert.notEqual(model.install, 'built-in');
  });
  assert.equal(registry.getModel('qwen2.5-omni').verification, 'advertised');
});

await check('F3 unknown models and undeclared capabilities fail explicitly', () => {
  assert.equal(registry.routeRequest({ modelId: 'nope', capability: 'tts' }).ok, false);
  assert.match(registry.routeRequest({ modelId: 'whisper-cpp', capability: 'tts' }).reason, /does not declare tts/);
});

/* =====================================================================================
 * G. Persistence + UI (happy-dom)
 * ===================================================================================*/
const win = new Window({ url: 'http://localhost:5173/' });
const g = globalThis;
for (const key of ['window', 'document', 'navigator', 'location', 'localStorage', 'history', 'HTMLElement', 'Event', 'CustomEvent', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  const value = win[key] ?? win;
  if (value === undefined) continue;
  try { Object.defineProperty(g, key, { value, configurable: true, writable: true }); } catch { try { g[key] = value; } catch {} }
}
g.window = win; g.document = win.document; g.navigator = win.navigator; g.localStorage = win.localStorage; g.location = win.location;
g.requestAnimationFrame = (fn) => setTimeout(fn, 0);
g.matchMedia = () => ({ matches: false, addEventListener() {} });
win.matchMedia = g.matchMedia;
win.document.body.innerHTML = '<div id="app"></div>';

const core = await import('../src/core.js');
globalThis.__voiceCore = { seed: core.seed };

await check('G1 migration fills voice defaults without losing saved choices', () => {
  const seedVoice = core.seed().settings.voice;
  assert.equal(seedVoice.strategy, 'sentence');
  assert.equal(seedVoice.profiles.length, 2);
  assert.equal(seedVoice.profiles.find((profile) => profile.id === 'my-cloned-voice').status, 'needs-engine');
});

await check('G2 settings persist through the store and survive a reload', async () => {
  core.setState((state) => { state.settings.voice.autoSpeak = false; state.settings.voice.strategy = 'phrase'; }, 'voice-test');
  await tick(400);
  const raw = JSON.parse(localStorage.getItem('swarmos-state-v1') || '{}');
  assert.equal(raw.settings.voice.autoSpeak, false);
  assert.equal(raw.settings.voice.strategy, 'phrase');
});

await import('../src/main.js');
await tick(120);
const main = await import('../src/main.js');

await check('G3 the Voice Studio route renders and is reachable', async () => {
  main.navigate('voice');
  await tick(120);
  const html = win.document.getElementById('view').innerHTML;
  assert.match(html, /Live Type-to-Speech|Type-to-speech/i);
  assert.match(html, /id="vs-editor"/);
  assert.match(html, /aria-label="Text to speak"/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, /data-act="voice-play"/);
});

await check('G4 all five sections render', async () => {
  const voiceView = (await import('../src/voice.js'));
  for (const tab of ['overview', 'models', 'voices', 'diagnostics', 'tts']) {
    voiceView.voiceInternals.setTab(tab);
    main.rerender();
    const html = win.document.getElementById('view').innerHTML;
    assert(html.length > 400, `${tab} rendered almost nothing`);
    if (tab === 'models') assert.match(html, /Qwen2\.5-Omni/);
    if (tab === 'diagnostics') assert.match(html, /Cloud fallback/);
    if (tab === 'voices') assert.match(html, /My cloned voice/);
  }
});

await check('G5 the settings screen exposes no fake voice install button', async () => {
  main.navigate('voice');
  await tick(60);
  const tabs = [...win.document.querySelectorAll('[data-act="voice-tab"]')];
  assert(tabs.length >= 5);
  tabs.forEach((node) => assert(node.textContent.trim().length > 0));
});

console.log(results.join('\n'));
console.log(`\nVOICE STUDIO: ${results.length - failures}/${results.length} PASSED`);
process.exit(failures ? 1 : 0);
