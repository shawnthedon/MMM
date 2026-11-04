/* File management — the integration test.
 * Run: npm run test:files
 *
 * The Files screen has claimed "248 MB used" since the prototype. This suite is the proof that the thing
 * behind the new panel is a real file service: it boots a real gateway against a real temporary directory
 * and asks it to create, upload, list, stream, range, move, copy and trash actual files — then checks that
 * a path cannot leave its root, that an Observer cannot write, and that a refusal leaves the disk alone.
 *
 * No mock stands in for the filesystem. Where a browser would be the client, this suite *is* the client:
 * fetch with a Range header is exactly what the panel sends when a download is resumed.
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.MMM_TEST_PORT_FILES || 8907);
const DATA_DIR = `/tmp/mmm-files-db-${process.pid}`;
const FILES_ROOT = `/tmp/mmm-files-root-${process.pid}`;
rmSync(DATA_DIR, { recursive: true, force: true });
rmSync(FILES_ROOT, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(FILES_ROOT, { recursive: true });
process.env.DATA_DIR = DATA_DIR;
process.env.MMM_FILES_ROOT = FILES_ROOT;
process.env.MMM_QUIET = '1';
process.env.MMM_SECRET = 'test-secret-material-that-is-long-enough-1234';
process.env.MMM_BOOTSTRAP_EMAIL = 'owner@files.local';
process.env.MMM_BOOTSTRAP_PASSWORD = 'OwnerPassw0rd!2026';
process.env.MMM_BROWSER_DISABLE = '1';
process.env.MMM_COMMS_DISABLE = '1';

let passed = 0;
let failures = 0;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    results.push(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    results.push(`FAIL ${name}\n     ${error.message}`);
  }
}
const assert = (value, message) => {
  if (!value) throw new Error(message || 'assertion failed');
};
const eq = (actual, expected, message) => {
  if (actual !== expected) throw new Error(`${message || 'value'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

const { createGateway } = await import('../apps/gateway/server.js');
const authMod = await import('../apps/gateway/src/auth.js');
const caps = await import('../apps/gateway/src/capabilities.js');
const dbMod = await import('../apps/gateway/src/db.js');

const BASE = `http://127.0.0.1:${PORT}`;
const gateway = createGateway();
await new Promise((resolve) => gateway.server.listen(PORT, '127.0.0.1', resolve));

function client() {
  const jar = {};
  const api = {
    csrf: null,
    async request(p, { method = 'GET', body, headers: extra = {} } = {}) {
      const headers = { ...extra };
      const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookies) headers.cookie = cookies;
      if (method !== 'GET' && api.csrf) headers[authMod.CSRF_HEADER] = api.csrf;
      if (body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
      const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) });
      for (const raw of res.headers.getSetCookie?.() || []) {
        const [pair] = raw.split(';');
        const i = pair.indexOf('=');
        jar[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const text = buf.toString('utf8');
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      return { status: res.status, body: parsed, text, bytes: buf, headers: res.headers };
    },
    async login(email, password) {
      const out = await api.request('/api/v1/auth/login', { method: 'POST', body: { email, password } });
      if (out.status !== 200) throw new Error(`login ${email}: ${out.text}`);
      api.csrf = out.body.csrfToken || (await api.request('/api/v1/auth/session')).body.csrfToken;
    },
  };
  return api;
}

const owner = client();
await owner.login('owner@files.local', 'OwnerPassw0rd!2026');

async function makePrincipal(name, role) {
  const email = `${name}@files.local`;
  const res = await owner.request('/api/v1/principals', {
    method: 'POST',
    body: { name, email, role, password: 'AnotherPassw0rd!2026', type: 'human' },
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`create ${name}: ${res.status} ${res.text}`);
  const c = client();
  await c.login(email, 'AnotherPassw0rd!2026');
  return c;
}
const operator = await makePrincipal('operator', 'Operator');
const observer = await makePrincipal('observer', 'Observer');

const cfg = (await owner.request('/api/v1/files')).body;
const ART = cfg.locations.find((l) => l.kind === 'artifacts').id;
const DL = cfg.locations.find((l) => l.kind === 'downloads').id;

const upload = (who, location, rel, content, type = 'text/plain') =>
  who.request(`/api/v1/files/upload?location=${encodeURIComponent(location)}&path=${encodeURIComponent(rel)}`, {
    method: 'POST',
    headers: { 'content-type': type },
    body: Buffer.from(content),
  });

const downloadUrl = (location, rel) => `/api/v1/files/download?location=${encodeURIComponent(location)}&path=${encodeURIComponent(rel)}`;

/* =========================================================================================
 * 1. the roots
 * =======================================================================================*/

await check('the gateway enrols three real roots, and they exist on disk', async () => {
  eq(cfg.locations.length, 3, 'three locations');
  for (const loc of cfg.locations) {
    assert(existsSync(loc.rootPath), `${loc.label} exists on disk`);
    assert(path.isAbsolute(loc.rootPath), `${loc.label} root is absolute`);
    assert(loc.rootPath.startsWith(FILES_ROOT), `${loc.label} root is inside MMM_FILES_ROOT`);
    assert(loc.granted === true, `${loc.label} is enrolled`);
  }
  eq(cfg.locations.map((l) => l.kind).join(','), 'downloads,artifacts,web', 'the purposes are stated in order');
});

await check('an empty root lists empty, and says which directory it listed', async () => {
  const out = await owner.request(`/api/v1/files/list?location=${ART}`);
  eq(out.status, 200, 'list');
  eq(out.body.entries.length, 0, 'nothing in a new artifacts root');
  eq(out.body.path, '', 'the root path is empty, not undefined');
  eq(out.body.parent, null, 'the root has no parent');
});

/* =========================================================================================
 * 2. creating, uploading, and the size the disk reports
 * =======================================================================================*/

await check('mkdir creates a real directory, and refuses to overwrite', async () => {
  const made = await operator.request('/api/v1/files/dir', { method: 'POST', body: { locationId: ART, path: 'notes' } });
  eq(made.status, 201, 'create notes/');
  eq(made.body.entry.type, 'dir', 'it is a directory');
  assert(existsSync(path.join(FILES_ROOT, 'artifacts', 'notes')), 'the directory is on disk');
  const again = await operator.request('/api/v1/files/dir', { method: 'POST', body: { locationId: ART, path: 'notes' } });
  eq(again.status, 409, 'a second create is a conflict, not a silent success');
});

await check('an upload writes the bytes, and the answer is the size the filesystem reports', async () => {
  const content = '# Today\n\nA real file, with real bytes.\n';
  const up = await operator.request(`/api/v1/files/upload?location=${ART}&path=${encodeURIComponent('notes/today.md')}`, {
    method: 'POST',
    headers: { 'content-type': 'text/markdown' },
    body: Buffer.from(content),
  });
  eq(up.status, 201, `upload: ${up.text}`);
  eq(up.body.bytes, Buffer.byteLength(content), 'the reported size matches the content');
  eq(up.body.confirmedBy, 'stat', 'and it came from stat, not from the request');
  eq(readFileSync(path.join(FILES_ROOT, 'artifacts', 'notes', 'today.md'), 'utf8'), content, 'the file on disk is byte-identical');
  assert(!existsSync(path.join(FILES_ROOT, 'artifacts', 'notes', 'today.md.part')), 'no temporary file was left behind');
});

await check('listing a directory shows what is there, with sizes and types', async () => {
  const out = await operator.request(`/api/v1/files/list?location=${ART}&path=notes`);
  eq(out.status, 200, 'list notes/');
  eq(out.body.entries.length, 1, 'one entry');
  const [entry] = out.body.entries;
  eq(entry.name, 'today.md', 'name');
  eq(entry.type, 'file', 'type');
  eq(entry.extension, 'md', 'extension');
  eq(entry.size, Buffer.byteLength('# Today\n\nA real file, with real bytes.\n'), 'size');
  eq(out.body.parent, '', 'the parent is the root');
});

/* =========================================================================================
 * 3. streaming with a range — what makes pause and resume real
 * =======================================================================================*/

await check('a download streams the whole file and advertises byte ranges', async () => {
  const out = await owner.request(downloadUrl(ART, 'notes/today.md'));
  eq(out.status, 200, 'download');
  eq(out.text, '# Today\n\nA real file, with real bytes.\n', 'the bytes are the file');
  eq(out.headers.get('accept-ranges'), 'bytes', 'Accept-Ranges: bytes');
  eq(out.headers.get('content-length'), String(Buffer.byteLength(out.text)), 'Content-Length matches');
  assert(/attachment; filename="today.md"/.test(out.headers.get('content-disposition') || ''), 'it is an attachment');
});

await check('a Range request answers 206 with exactly that slice', async () => {
  const out = await owner.request(downloadUrl(ART, 'notes/today.md'), { headers: { Range: 'bytes=2-6' } });
  eq(out.status, 206, 'partial content');
  eq(out.text, 'Today', 'the slice is the requested bytes');
  eq(out.headers.get('content-range'), `bytes 2-6/${Buffer.byteLength('# Today\n\nA real file, with real bytes.\n')}`, 'Content-Range names the slice and the total');
});

await check('resuming from the byte a client already has yields the remainder, not the whole file', async () => {
  const full = '# Today\n\nA real file, with real bytes.\n';
  const out = await owner.request(downloadUrl(ART, 'notes/today.md'), { headers: { Range: `bytes=${Buffer.byteLength(full) - 6}-` } });
  eq(out.status, 206, '206 for an open-ended range');
  eq(out.text, full.slice(-6), 'only the tail came back');
});

await check('an impossible range is 416, not a crash or a silent full file', async () => {
  const out = await owner.request(downloadUrl(ART, 'notes/today.md'), { headers: { Range: 'bytes=9999-' } });
  eq(out.status, 416, 'range not satisfiable');
  eq(out.headers.get('content-range'), `bytes */${Buffer.byteLength('# Today\n\nA real file, with real bytes.\n')}`, 'and it says how long the file is');
});

/* =========================================================================================
 * 4. escaping the root
 * =======================================================================================*/

await check('a path cannot leave its root', async () => {
  for (const bad of ['../secrets', 'notes/../../etc/passwd', '/etc/passwd', 'a/../../b']) {
    const out = await owner.request(`/api/v1/files/list?location=${ART}&path=${encodeURIComponent(bad)}`);
    assert(out.status === 400 || out.status === 404, `“${bad}” must be refused (got ${out.status})`);
    assert(!JSON.stringify(out.body).includes('root:'), 'nothing from outside the root is echoed back');
  }
  const up = await owner.request(`/api/v1/files/upload?location=${ART}&path=${encodeURIComponent('../escape.txt')}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: Buffer.from('nope'),
  });
  eq(up.status, 400, 'an upload cannot escape either');
  assert(!existsSync(path.join(FILES_ROOT, 'escape.txt')), 'nothing was written outside the root');
});

await check('a symlink inside the root that points outside it is listed but flagged, never followed', async () => {
  const outside = path.join(FILES_ROOT, '..', `mmm-outside-${process.pid}`);
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, 'secret.txt'), 'not yours');
  try {
    symlinkSync(outside, path.join(FILES_ROOT, 'artifacts', 'escape-link'));
    const listed = await owner.request(`/api/v1/files/list?location=${ART}`);
    const link = listed.body.entries.find((e) => e.name === 'escape-link');
    assert(link, 'the link appears');
    eq(link.type, 'link', 'as a link');
    eq(link.linkTargetOutside, true, 'flagged as pointing outside the root');
    const attempt = await owner.request(`/api/v1/files/list?location=${ART}&path=escape-link`);
    eq(attempt.status, 400, 'and a request through it is refused');
    const up = await owner.request(`/api/v1/files/upload?location=${ART}&path=${encodeURIComponent('escape-link/pwn.txt')}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from('nope'),
    });
    eq(up.status, 400, 'writing through it is refused');
    assert(!existsSync(path.join(outside, 'pwn.txt')), 'nothing landed outside the root');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

/* =========================================================================================
 * 5. move, copy, trash
 * =======================================================================================*/

await check('copy duplicates, and refuses a destination that exists', async () => {
  const out = await owner.request('/api/v1/files/copy', { method: 'POST', body: { locationId: ART, from: 'notes/today.md', to: 'notes/today-copy.md' } });
  eq(out.status, 201, `copy: ${out.text}`);
  assert(existsSync(path.join(FILES_ROOT, 'artifacts', 'notes', 'today-copy.md')), 'the copy is on disk');
  const again = await owner.request('/api/v1/files/copy', { method: 'POST', body: { locationId: ART, from: 'notes/today.md', to: 'notes/today-copy.md' } });
  eq(again.status, 409, 'copy never overwrites');
});

await check('move renames, and refuses to move a directory inside itself', async () => {
  const out = await owner.request('/api/v1/files/move', { method: 'POST', body: { locationId: ART, from: 'notes/today-copy.md', to: 'notes/archive.md' } });
  eq(out.status, 200, 'move');
  assert(existsSync(path.join(FILES_ROOT, 'artifacts', 'notes', 'archive.md')), 'renamed on disk');
  assert(!existsSync(path.join(FILES_ROOT, 'artifacts', 'notes', 'today-copy.md')), 'the old name is gone');
  const bad = await owner.request('/api/v1/files/move', { method: 'POST', body: { locationId: ART, from: 'notes', to: 'notes/nested' } });
  eq(bad.status, 400, 'a directory cannot be moved inside itself');
});

await check('delete moves the entry to the trash, and says it is recoverable', async () => {
  const out = await owner.request(`/api/v1/files/entry?location=${ART}&path=${encodeURIComponent('notes/archive.md')}`, { method: 'DELETE' });
  eq(out.status, 200, `delete: ${out.text}`);
  eq(out.body.recoverable, true, 'the response says it can be undone');
  assert(/^\.trash\//.test(out.body.trashed), 'it names the trash path');
  assert(!existsSync(path.join(FILES_ROOT, 'artifacts', 'notes', 'archive.md')), 'gone from its old name');
  assert(existsSync(path.join(FILES_ROOT, 'artifacts', out.body.trashed)), 'and present in the trash');
});

/* =========================================================================================
 * 6. the download manager's records
 * =======================================================================================*/

await check('a download record starts at zero and advances only as far as the client says', async () => {
  const made = await owner.request('/api/v1/files/downloads', { method: 'POST', body: { locationId: ART, path: 'notes/today.md' } });
  eq(made.status, 201, `create: ${made.text}`);
  eq(made.body.download.bytesTotal, Buffer.byteLength('# Today\n\nA real file, with real bytes.\n'), 'the size came from stat');
  eq(made.body.download.status, 'queued', 'queued');
  const id = made.body.download.id;
  const half = await owner.request(`/api/v1/files/downloads/${id}`, { method: 'PATCH', body: { status: 'paused', bytesDone: 10 } });
  eq(half.status, 200, 'patch');
  eq(half.body.download.status, 'paused', 'paused');
  eq(half.body.download.bytesDone, 10, 'the byte count is recorded');
  const clamped = await owner.request(`/api/v1/files/downloads/${id}`, { method: 'PATCH', body: { bytesDone: 999999 } });
  eq(clamped.body.download.bytesDone, clamped.body.download.bytesTotal, 'progress can never exceed the file');
  const listed = await owner.request('/api/v1/files/downloads');
  eq(listed.body.downloads.length, 1, 'it is listed for its owner');
  const stranger = await operator.request('/api/v1/files/downloads');
  eq(stranger.body.downloads.length, 0, 'and not for anyone else');
});

await check('a download left running is reported interrupted, and can be resumed from its byte count', async () => {
  const made = await owner.request('/api/v1/files/downloads', { method: 'POST', body: { locationId: ART, path: 'notes/today.md' } });
  const id = made.body.download.id;
  await owner.request(`/api/v1/files/downloads/${id}`, { method: 'PATCH', body: { status: 'running', bytesDone: 7 } });
  // Simulate a reload: the reconciler must not report a transfer nobody is holding as running.
  dbMod.db.prepare("UPDATE file_downloads SET status='running' WHERE id=?").run(id);
  const listed = await owner.request('/api/v1/files/downloads');
  const row = listed.body.downloads.find((d) => d.id === id);
  eq(row.status, 'failed', 'a stale running row is not left claiming to be running');
  assert(row.bytesDone === 7, 'the byte count survives, which is what a resume needs');
  assert(/resume/.test(row.error), 'and the sentence says so');
});

/* =========================================================================================
 * 7. permission and the dispatcher
 * =======================================================================================*/

await check('an Observer reads the tree and cannot write to it', async () => {
  const list = await observer.request(`/api/v1/files/list?location=${ART}`);
  eq(list.status, 200, 'reading is allowed');
  const mk = await observer.request('/api/v1/files/dir', { method: 'POST', body: { locationId: ART, path: 'observer-dir' } });
  eq(mk.status, 403, 'writing is refused');
  assert(!existsSync(path.join(FILES_ROOT, 'artifacts', 'observer-dir')), 'and nothing was created');
  const up = await observer.request(`/api/v1/files/upload?location=${ART}&path=observer.txt`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: Buffer.from('x'),
  });
  eq(up.status, 403, 'uploading is refused');
  const mkLoc = await observer.request('/api/v1/files/locations', { method: 'POST', body: { label: 'x', path: '/tmp/x-observer' } });
  eq(mkLoc.status, 403, 'enrolling a root is not an Observer act');
});

await check('only an Owner may enrol a new root, and un-enrolling never deletes the directory', async () => {
  const dir = path.join(FILES_ROOT, 'owner-added');
  const refused = await operator.request('/api/v1/files/locations', { method: 'POST', body: { label: 'Operator root', path: dir } });
  eq(refused.status, 403, 'an Operator cannot broaden the disk the app may reach');
  const made = await owner.request('/api/v1/files/locations', { method: 'POST', body: { label: 'Owner root', path: dir, kind: 'custom', purpose: '' } });
  eq(made.status, 201, `owner enrols: ${made.text}`);
  assert(existsSync(dir), 'the directory was created');
  writeFileSync(path.join(dir, 'keep.txt'), 'still here');
  const dropped = await owner.request(`/api/v1/files/locations/${made.body.location.id}`, { method: 'DELETE' });
  eq(dropped.status, 200, 'un-enrol');
  eq(dropped.body.directoryDeleted, false, 'the answer says the directory was not deleted');
  assert(existsSync(path.join(dir, 'keep.txt')), 'and the file is still there');
});

await check('usage measures the real tree', async () => {
  const out = await owner.request(`/api/v1/files/usage?location=${ART}`);
  eq(out.status, 200, 'usage');
  const mine = out.body.usage[0];
  assert(mine.bytes >= Buffer.byteLength('# Today\n\nA real file, with real bytes.\n'), 'bytes are counted from the disk');
  assert(mine.files >= 1, 'files are counted');
  assert(mine.truncated === false, 'a small tree is not truncated');
});

await check('every write left an audit row', async () => {
  const row = dbMod.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE event LIKE 'files.%'").get();
  assert(row.n >= 6, `expected file audit rows, found ${row.n}`);
  eq(dbMod.verifyAuditChain().ok, true, 'the audit chain still verifies');
});

await check('the dispatcher can run a file operation, and refuses one the contract does not allow', async () => {
  const dispatch = (who, body) => who.request('/api/v1/dispatch', { method: 'POST', body });
  const listed = await dispatch(operator, { operation: 'files.list', params: { location: ART }, confirm: true });
  eq(listed.status, 200, `dispatch files.list: ${listed.text}`);
  eq(listed.body.outcome, 'executed', 'it ran');
  assert(listed.body.data.entries, 'and returned the directory');
  const escape = await dispatch(operator, { operation: 'files.list', params: { location: ART, path: '../..' }, confirm: true });
  eq(escape.body.executed, false, 'a traversal path is refused before the route');
  eq(escape.body.code, 'invalid-params', 'and named as invalid parameters');
  const smuggled = await dispatch(operator, { operation: 'files.mkdir', params: { locationId: ART, path: 'ok', principal: 'owner' }, confirm: true });
  eq(smuggled.body.code, 'invalid-params', 'an undeclared field is refused, not dropped');
  const observerTry = await dispatch(observer, { operation: 'files.mkdir', params: { locationId: ART, path: 'nope' }, confirm: true });
  eq(observerTry.body.code, 'forbidden', 'and a role without file:write is refused by the dispatcher too');
  assert(!existsSync(path.join(FILES_ROOT, 'artifacts', 'nope')), 'nothing was created by either refusal');
});

await check('the registry and the routes agree: no drift, every file operation is dispatchable by an Owner', async () => {
  const cov = await caps.coverage();
  eq(cov.ok, true, `drift: ${JSON.stringify({ missing: cov.missing, undeclared: cov.undeclared, mismatched: cov.mismatched, stale: cov.staleExcuses })}`);
  const files = caps.OPERATIONS.filter((o) => o.module === 'files');
  eq(files.length, 16, 'sixteen file operations');
  const contracts = await import('../apps/gateway/src/operationContracts.js');
  for (const o of files) assert(contracts.resolveContract(o), `${o.id} has a contract`);
  assert(!caps.OPERATIONS.some((o) => o.id === 'files.upload'), 'the old no-service placeholder is gone');
});

console.log(results.join('\n'));
console.log(`\nFILES: ${passed} passed, ${failures} failed`);
gateway.server.close();
process.exit(failures > 0 ? 1 : 0);
