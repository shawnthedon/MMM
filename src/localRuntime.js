/* Experimental local GGUF spike. Not a model manager or a production inference API.
 * All storage paths are fixed; no model names, prompts or results are sent to a server.
 * The runtime factory and WASM URL are supplied by the spike entry point.
 */
const DIRECTORY = 'mmm-local-spike';
const FILE = 'model.gguf';
const MAX_BYTES = 512 * 1024 * 1024;

export function createLocalRuntime({ createEngine, wasmUrl, storage = globalThis.navigator?.storage, fetchImpl = globalThis.fetch, clock = () => performance.now(), env = globalThis } = {}) {
  let engine = null;
  let wasmObjectUrl = null;
  let busy = false;
  let abort = null;
  let loaded = false;

  const run = async (fn) => {
    if (busy) throw new Error('Another local operation is in progress.');
    busy = true;
    try { return await fn(); } finally { busy = false; }
  };
  const dir = async (create = false) => {
    if (!storage?.getDirectory) throw new Error('OPFS is unavailable in this browser.');
    return (await storage.getDirectory()).getDirectoryHandle(DIRECTORY, { create });
  };
  const cleanup = async () => {
    loaded = false;
    const old = engine;
    engine = null;
    try { if (old) await old.exit(); }
    finally {
      if (wasmObjectUrl) URL.revokeObjectURL(wasmObjectUrl);
      wasmObjectUrl = null;
    }
  };
  const modelFile = async () => {
    try { return await (await (await dir()).getFileHandle(FILE)).getFile(); }
    catch (error) {
      if (error.name === 'NotFoundError') throw new Error('No model imported. Select a local GGUF first.');
      throw error;
    }
  };

  return {
    status: () => ({ busy, loaded, hasPreparedRuntime: Boolean(wasmObjectUrl) }),
    async importModel(file) {
      return run(async () => {
        if (engine || loaded) throw new Error('Unload the model before replacing it.');
        if (!file || file.size < 24 || file.size > MAX_BYTES) throw new Error('Choose a GGUF file between 24 bytes and 512 MiB for this spike.');
        const header = new DataView(await file.slice(0, 8).arrayBuffer());
        if (header.getUint32(0, true) !== 0x46554747 || ![2, 3].includes(header.getUint32(4, true))) {
          throw new Error('This file does not have a supported GGUF v2/v3 header.');
        }
        if (typeof storage?.estimate === 'function') {
          const estimate = await storage.estimate();
          if (Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage) && estimate.quota - estimate.usage < file.size) {
            throw new Error('Not enough estimated storage for a staged import. Free space and retry.');
          }
        }
        try {
          const handle = await (await dir(true)).getFileHandle(FILE, { create: true });
          // createWritable stages changes until close; pipeTo aborts the write on failure.
          const writable = await handle.createWritable();
          await file.stream().pipeTo(writable);
        } catch (error) {
          if (error.name === 'QuotaExceededError') throw new Error('Storage quota was exceeded. Free space and retry.');
          throw error;
        }
        return { size: file.size, validation: 'header only; runtime must validate the model' };
      });
    },
    async modelInfo() {
      const file = await modelFile();
      return { size: file.size, name: 'model.gguf', validation: 'header only; no checksum or licence verification' };
    },
    async deleteModel() {
      return run(async () => {
        if (engine || loaded) throw new Error('Unload the model before deleting it.');
        try { await (await dir()).removeEntry(FILE); }
        catch (error) { if (error.name !== 'NotFoundError') throw error; }
      });
    },
    async prepare() {
      return run(async () => {
        if (wasmObjectUrl) return;
        if (!env.crossOriginIsolated || typeof env.SharedArrayBuffer !== 'function') throw new Error('Cross-origin isolation and SharedArrayBuffer are required for this runtime build. Open the app in a top-level HTTPS tab.');
        const target = new URL(wasmUrl, env.location.href);
        if (target.origin !== env.location.origin) throw new Error('The runtime asset must be same-origin.');
        const response = await fetchImpl(target.href, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`Runtime asset could not be loaded (HTTP ${response.status}).`);
        wasmObjectUrl = URL.createObjectURL(await response.blob());
      });
    },
    async load() {
      return run(async () => {
        if (loaded || engine) throw new Error('A model is already loaded.');
        if (!wasmObjectUrl) throw new Error('Prepare the local runtime before loading a model.');
        const file = await modelFile();
        const start = clock();
        try {
          engine = createEngine(wasmObjectUrl);
          // Never allow wllama's optional CDN compatibility fallback.
          engine.setCompat(null);
          await engine.loadModel([file], { n_ctx: 256, n_batch: 64, n_threads: 1, n_gpu_layers: 0 });
          loaded = true;
          return { loadMs: clock() - start, size: file.size };
        } catch (error) {
          await cleanup().catch(() => {});
          throw error;
        }
      });
    },
    async generate(prompt, onText = () => {}) {
      return run(async () => {
        if (!loaded || !engine) throw new Error('Load a model first.');
        if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) throw new Error('Enter a prompt of 1–4000 characters.');
        abort = new AbortController();
        const start = clock();
        let text = '', usage = null;
        try {
          const stream = await engine.createCompletion({ prompt, max_tokens: 64, temperature: 0.7, stream: true, abortSignal: abort.signal });
          for await (const chunk of stream) {
            const part = chunk.choices?.[0]?.text || '';
            if (part) { text += part; onText(part); }
            if (chunk.usage) usage = chunk.usage;
          }
          const elapsedMs = clock() - start;
          const tokens = usage?.completion_tokens ?? null;
          return { text, elapsedMs, tokens, tokensPerSecond: tokens != null && elapsedMs > 0 ? tokens / (elapsedMs / 1000) : null };
        } finally { abort = null; }
      });
    },
    stop() { if (!abort) return false; abort.abort(); return true; },
    async unload() { return run(cleanup); },
  };
}
