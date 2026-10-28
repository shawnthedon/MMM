import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalRuntime } from '../src/localRuntime.js';

function fakeStorage() {
  let data = null;
  const notFound = () => Object.assign(new Error('not found'), { name: 'NotFoundError' });
  const dir = {
    async getFileHandle(_name, { create = false } = {}) {
      if (!create && !data) throw notFound();
      return {
        async getFile() { if (!data) throw notFound(); return data; },
        async createWritable() {
          const chunks = [];
          return new WritableStream({ write(chunk) { chunks.push(chunk); }, close() { data = new Blob(chunks); } });
        },
      };
    },
    async removeEntry() { if (!data) throw notFound(); data = null; },
  };
  return { async getDirectory() { return { async getDirectoryHandle(_name, { create } = {}) { if (!create && !data) throw notFound(); return dir; } }; } };
}
const valid = () => new Blob([new Uint8Array([71, 71, 85, 70, 3, 0, 0, 0, ...new Array(32).fill(0)])]);
const goodContext = () => ({ success: true, n_vocab: 512, n_ctx: 256, n_embd: 64, n_layer: 5 });
const environment = { crossOriginIsolated: true, SharedArrayBuffer, location: { href: 'https://local.test/local-spike.html', origin: 'https://local.test' } };
function fixture({ failLoad = false } = {}) {
  const calls = [];
  const engine = {
    setCompat(value) { calls.push(['compat', value]); },
    async loadModel(files, options) { calls.push(['load', files[0].size, options]); if (failLoad) throw Error('invalid model'); },
    getLoadedContextInfo: goodContext,
    async exit() { calls.push(['exit']); },
    async createCompletion(options) {
      calls.push(['generate', options.prompt]);
      options.onData({ choices: [{ text: 'hello' }] }); options.onData({ choices: [{ text: ' world' }], usage: { completion_tokens: 2 } });
    },
  };
  let now = 0;
  const runtime = createLocalRuntime({ storage: fakeStorage(), env: environment, wasmUrl: '/assets/runtime.wasm', fetchImpl: async (url) => { calls.push(['fetch', url]); return new Response(new Blob(['wasm']), { status: 200 }); }, createEngine: () => engine, clock: () => { now += 1000; return now; } });
  return { runtime, calls };
}

test('rejects bad headers, missing models and unsupported isolation', async () => {
  const { runtime } = fixture();
  await assert.rejects(runtime.modelInfo(), /No model imported/);
  await assert.rejects(runtime.importModel(new Blob(['bad'])), /between/);
  await assert.rejects(runtime.importModel(new Blob([new Uint8Array(40)])), /GGUF/);
  const noIsolation = createLocalRuntime({ env: { ...environment, crossOriginIsolated: false } });
  await assert.rejects(noIsolation.prepare(), /Cross-origin isolation/);
  const remote = createLocalRuntime({ env: environment, wasmUrl: 'https://other.test/runtime.wasm' });
  await assert.rejects(remote.prepare(), /same-origin/);
});

test('local import, load, streamed completion and unload have honest state and measurements', async () => {
  const { runtime, calls } = fixture();
  await runtime.importModel(valid());
  assert.equal((await runtime.modelInfo()).size, 40);
  await assert.rejects(runtime.load(), /Prepare/);
  await runtime.prepare();
  assert.equal((await runtime.load()).loadMs, 1000);
  assert.equal(runtime.status().loaded, true);
  await assert.rejects(runtime.deleteModel(), /Unload/);
  await assert.rejects(runtime.importModel(valid()), /Unload/);
  await assert.rejects(runtime.generate(''), /prompt/);
  let output = '';
  const result = await runtime.generate('prompt', part => { output += part; });
  assert.equal(output, 'hello world');
  assert.equal(result.tokens, 2);
  assert.equal(result.tokensPerSecond, 2);
  assert.deepEqual(calls.find(([name]) => name === 'compat'), ['compat', null]);
  assert.equal(calls.filter(([name]) => name === 'fetch').length, 1);
  await runtime.unload();
  assert.deepEqual(runtime.status(), { busy: false, loaded: false, cleanupPending: false, hasPreparedRuntime: false });
  await runtime.deleteModel();
  await assert.rejects(runtime.modelInfo(), /No model imported/);
});

test('failed load closes the engine, clears state and never reports a loaded model', async () => {
  const { runtime, calls } = fixture({ failLoad: true });
  await runtime.importModel(valid());
  await runtime.prepare();
  await assert.rejects(runtime.load(), /invalid model/);
  assert.equal(runtime.status().loaded, false);
  assert.equal(runtime.status().hasPreparedRuntime, false);
  assert.equal(calls.filter(([name]) => name === 'exit').length, 1);
});

test('operations cannot race while a model is loading', async () => {
  let finish;
  const blocked = new Promise(resolve => { finish = resolve; });
  const runtime = createLocalRuntime({ storage: fakeStorage(), env: environment, wasmUrl: '/runtime.wasm', fetchImpl: async () => new Response('wasm'), createEngine: () => ({ setCompat() {}, loadModel: () => blocked, getLoadedContextInfo: goodContext, async exit() {} }) });
  await runtime.importModel(valid());
  await runtime.prepare();
  const pending = runtime.load();
  await assert.rejects(runtime.deleteModel(), /operation is in progress/);
  finish(); await pending; await runtime.unload();
});

test('stop aborts an active generation without fabricating a result', async () => {
  let signalSeen;
  const runtime = createLocalRuntime({
    storage: fakeStorage(), env: environment, wasmUrl: '/runtime.wasm', fetchImpl: async () => new Response('wasm'),
    createEngine: () => ({
      setCompat() {}, async loadModel() {}, getLoadedContextInfo: goodContext, async exit() {},
      async createCompletion({ abortSignal }) {
        signalSeen = abortSignal;
        await new Promise(resolve => abortSignal.addEventListener('abort', resolve, { once: true }));
        throw new DOMException('Cancelled', 'AbortError');
      },
    }),
  });
  await runtime.importModel(valid()); await runtime.prepare(); await runtime.load();
  const pending = runtime.generate('hello');
  // Allow the generator to attach its listener before requesting stop.
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(runtime.stop(), true);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(signalSeen.aborted, true);
  assert.equal(runtime.stop(), false);
  await runtime.unload();
});

test('estimated insufficient storage blocks a staged import', async () => {
  const storage = { ...fakeStorage(), async estimate() { return { quota: 100, usage: 90 }; } };
  const runtime = createLocalRuntime({ storage, env: environment });
  await assert.rejects(runtime.importModel(valid()), /Not enough estimated storage/);
});

test('a runtime asset fetch refuses redirects and rejects a cross-origin final URL', async () => {
  let options;
  const runtime = createLocalRuntime({ env: environment, wasmUrl: '/runtime.wasm', fetchImpl: async (_url, opts) => {
    options = opts;
    return { ok: true, url: 'https://other.test/runtime.wasm' };
  } });
  await assert.rejects(runtime.prepare(), /response must be same-origin/);
  assert.equal(options.redirect, 'error');
  assert.equal(runtime.status().hasPreparedRuntime, false);
});

test('cleanup failure keeps worker blocked for an explicit unload retry', async () => {
  let attempts = 0;
  const runtime = createLocalRuntime({ storage: fakeStorage(), env: environment, wasmUrl: '/runtime.wasm',
    fetchImpl: async () => new Response('wasm'), createEngine: () => ({
      setCompat() {}, async loadModel() {}, getLoadedContextInfo: goodContext, async exit() { if (++attempts === 1) throw Error('worker still running'); },
    }) });
  await runtime.importModel(valid()); await runtime.prepare(); await runtime.load();
  await assert.rejects(runtime.unload(), /worker still running/);
  assert.equal(runtime.status().loaded, false);
  assert.equal(runtime.status().cleanupPending, true);
  assert.equal(runtime.status().hasPreparedRuntime, true);
  await assert.rejects(runtime.importModel(valid()), /Unload/);
  await assert.rejects(runtime.generate('hello'), /Load a model/);
  await runtime.unload();
  assert.equal(runtime.status().cleanupPending, false);
  assert.equal(runtime.status().hasPreparedRuntime, false);
});

test('load and cleanup failures are both surfaced until the worker is released', async () => {
  let attempts = 0;
  const runtime = createLocalRuntime({ storage: fakeStorage(), env: environment, wasmUrl: '/runtime.wasm',
    fetchImpl: async () => new Response('wasm'), createEngine: () => ({
      setCompat() {}, async loadModel() { throw Error('corrupt GGUF'); },
      async exit() { if (++attempts === 1) throw Error('worker exit failed'); },
    }) });
  await runtime.importModel(valid()); await runtime.prepare();
  await assert.rejects(runtime.load(), /corrupt GGUF.*worker exit failed/);
  assert.equal(runtime.status().cleanupPending, true);
  await runtime.unload();
  assert.equal(runtime.status().cleanupPending, false);
});

test('a provider ending normally after stop is still reported as cancelled', async () => {
  let ready;
  const readyPromise = new Promise(resolve => { ready = resolve; });
  const runtime = createLocalRuntime({ storage: fakeStorage(), env: environment, wasmUrl: '/runtime.wasm',
    fetchImpl: async () => new Response('wasm'), createEngine: () => ({
      setCompat() {}, async loadModel() {}, getLoadedContextInfo: goodContext, async exit() {},
      async createCompletion({ abortSignal }) {
        ready();
        await new Promise(resolve => abortSignal.addEventListener('abort', resolve, { once: true }));
        // Simulate a provider that silently ends on abort.
      },
    }) });
  await runtime.importModel(valid()); await runtime.prepare(); await runtime.load();
  const pending = runtime.generate('test');
  await readyPromise;
  assert.equal(runtime.stop(), true);
  assert.equal(runtime.stop(), false);
  await assert.rejects(pending, { name: 'AbortError' });
  await runtime.unload();
});

test('a native load failure or invalid context cannot be reported as loaded', async () => {
  for (const context of [
    { ...goodContext(), success: false },
    { ...goodContext(), n_vocab: 0 },
  ]) {
    let exited = 0;
    const runtime = createLocalRuntime({ storage: fakeStorage(), env: environment, wasmUrl: '/runtime.wasm',
      fetchImpl: async () => new Response('wasm'), createEngine: () => ({
        setCompat() {}, async loadModel() {}, getLoadedContextInfo: () => context,
        async exit() { exited++; },
      }) });
    await runtime.importModel(valid()); await runtime.prepare();
    await assert.rejects(runtime.load(), /runtime rejected the model/);
    assert.equal(runtime.status().loaded, false);
    assert.equal(exited, 1);
  }
});
