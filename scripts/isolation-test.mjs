// HTTP-level checks for the dev and built-preview servers and Vercel configuration.
// This does not replace a real browser/production crossOriginIsolated check.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build, createServer, preview } from 'vite';

const expected = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
};

async function checkResponses(base, paths) {
  for (const path of paths) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
    for (const [header, value] of Object.entries(expected)) {
      assert.equal(response.headers.get(header), value, `${path}: ${header}`);
    }
  }
}

const dev = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
try {
  await dev.listen();
  const port = dev.httpServer.address().port;
  await checkResponses(`http://127.0.0.1:${port}`, ['/', '/index.html', '/sw.js', '/manifest.webmanifest', '/src/main.js']);
  console.log('PASS Vite dev serves the app and resources with isolation headers');
} finally {
  await dev.close();
}

await build({ logLevel: 'silent' });
const production = await preview({ preview: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
try {
  const port = production.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  const html = await (await fetch(`${base}/`)).text();
  const script = html.match(/src="\.\/(assets\/[^\"]+\.js)"/);
  assert.ok(script, 'built entry script was not found');
  await checkResponses(base, ['/', '/index.html', '/sw.js', '/manifest.webmanifest', `/${script[1]}`]);
  console.log('PASS Vite preview serves the built shell and resources with isolation headers');
} finally {
  await new Promise((resolve, reject) => production.httpServer.close((err) => err ? reject(err) : resolve()));
}

const vercel = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
const globalRule = vercel.headers.find((rule) => rule.source === '/(.*)');
assert.ok(globalRule, 'Vercel global header rule missing');
const headers = Object.fromEntries(globalRule.headers.map(({ key, value }) => [key.toLowerCase(), value]));
for (const [header, value] of Object.entries(expected)) assert.equal(headers[header], value, `Vercel ${header}`);
assert.ok(vercel.headers.some(({ source }) => source === '/sw.js'), 'service worker cache rule preserved');
assert.ok(vercel.headers.some(({ source }) => source === '/assets/(.*)'), 'asset cache rule preserved');
console.log('PASS Vercel configuration contains the isolation headers and existing cache rules');
console.log('HTTP/config checks passed; browser and deployed-host checks are separate.');
