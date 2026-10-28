import { Wllama } from '@wllama/wllama/esm/index.js';
import wasmUrl from '@wllama/wllama/esm/wasm/wllama.wasm?url';
import { createLocalRuntime } from './localRuntime.js';

const quietLogger = { debug() {}, log() {}, warn() {}, error() {} };
const runtime = createLocalRuntime({
  wasmUrl,
  createEngine: (url) => new Wllama({ default: url }, { suppressNativeLog: true, logger: quietLogger }),
});
const $ = (id) => document.getElementById(id);
const status = (message) => { $('status').textContent = message; };
let working = false;
let generating = false;
function controls() {
  const state = runtime.status();
  for (const id of ['import', 'delete']) $(id).disabled = working || state.loaded || state.cleanupPending;
  $('prepare').disabled = working || state.hasPreparedRuntime || state.cleanupPending;
  $('load').disabled = working || state.loaded || state.cleanupPending || !state.hasPreparedRuntime;
  $('unload').disabled = working || (!state.hasPreparedRuntime && !state.cleanupPending);
  $('generate').disabled = working || !state.loaded;
  $('stop').disabled = !generating;
  $('model-file').disabled = working || state.loaded || state.cleanupPending;
}
async function action(label, fn) {
  if (working) return;
  working = true; controls(); status(label);
  try { await fn(); }
  catch (err) { status(label === 'Generating locally…' && err?.name === 'AbortError' ? 'Generation stopped. Any partial output is shown above.' : `Not completed: ${err.message || String(err)}`); }
  finally { working = false; generating = false; controls(); }
}
async function showModel() {
  try { const info = await runtime.modelInfo(); $('model-info').textContent = `Stored in this browser: ${(info.size / 1048576).toFixed(2)} MiB. ${info.validation}.`; }
  catch (err) { $('model-info').textContent = err.message; }
}
$('import').addEventListener('click', () => action('Importing into private storage…', async () => {
  await runtime.importModel($('model-file').files[0]); $('model-file').value = ''; await showModel(); status('Model imported. Header checked only; compatibility is not verified.');
}));
$('delete').addEventListener('click', () => action('Deleting stored model…', async () => {
  if (!confirm('Delete the model stored by this spike?')) { status('Deletion cancelled.'); return; }
  await runtime.deleteModel(); await showModel(); status('Stored spike model deleted.');
}));
$('prepare').addEventListener('click', () => action('Preparing same-origin WASM…', async () => {
  await runtime.prepare(); status('Runtime asset prepared. Disconnect the device network before loading for an offline test.');
}));
$('load').addEventListener('click', () => action('Loading the model locally…', async () => {
  const out = await runtime.load(); $('metrics').textContent = `Model load: ${(out.loadMs / 1000).toFixed(2)} seconds. Model file: ${(out.size / 1048576).toFixed(2)} MiB. Peak memory not measured.`;
  status('Model loaded locally. This does not establish model quality or mobile suitability.');
}));
$('generate').addEventListener('click', () => action('Generating locally…', async () => {
  $('output').textContent = ''; $('metrics').textContent = 'No completed generation measurements yet.'; generating = true; controls();
  const out = await runtime.generate($('prompt').value, (text) => { $('output').textContent += text; });
  const rate = out.tokensPerSecond == null ? 'Token count and throughput not reported by runtime.' : `${out.tokens} tokens; ${out.tokensPerSecond.toFixed(2)} tokens/sec (including prompt processing).`;
  $('metrics').textContent = `Generation elapsed: ${(out.elapsedMs / 1000).toFixed(2)} seconds. ${rate} Peak memory not measured.`;
  status('Local generation completed.');
}));
$('stop').addEventListener('click', () => { if (runtime.stop()) status('Stop requested…'); });
$('unload').addEventListener('click', () => action('Unloading runtime…', async () => {
  await runtime.unload(); status('Runtime unloaded. Prepare it again to load another model.');
}));
controls(); showModel();
// Exposed only on this experimental page for reproducible integration tests.
window.localSpike = runtime;
