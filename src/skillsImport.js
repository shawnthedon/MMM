/* ============ Skill import / export (MMMV2 skills spec §7) ============
 * Accepts the formats skills are actually authored and shared in, validates every one of them, and
 * treats everything it reads as untrusted input:
 *
 *   SKILL.md            YAML frontmatter + markdown body (Agent Skills convention)
 *   skill.json          single manifest object
 *   *.json              array or { "skills": [...] } registry index
 *   skill.yaml / .yml   single manifest in YAML
 *   *.zip / *.skill     bundle: one or more SKILL.md / skill.json files (+ resources)
 *   swarmos package     { schema: 'swarmos.skill.package.v1', skills: [...], relations: [...] }
 *
 * Workflow (spec §7.2): select → validate schema → quarantine → scan → resolve dependencies →
 * review permissions → preview → install/reject → audit. Nothing here fetches a URL, executes
 * skill body text, or grants a tool/permission: imports land as `pending` skills that a human must
 * approve, exactly like agent-synthesized skills.
 */
import { getState, setState, logEvent, uid, now } from './core.js';
import { REL_TYPES } from './skillsData.js';

export const PACKAGE_SCHEMA = 'swarmos.skill.package.v1';
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_PACKAGE_BYTES = 4 * 1024 * 1024;

export const ACCEPTED_EXTENSIONS = ['.md', '.markdown', '.json', '.yaml', '.yml', '.zip', '.skill'];
export const ACCEPT_ATTR = ACCEPTED_EXTENSIONS.join(',');

export const FORMATS = [
  { id: 'skill-md', label: 'SKILL.md', detail: 'YAML frontmatter (name, description, allowed-tools) + markdown body' },
  { id: 'skill-json', label: 'skill.json', detail: 'Single manifest: name, description, version, inputs/outputs, permissions' },
  { id: 'registry-json', label: 'Registry JSON', detail: 'Array of manifests or {"skills": [...], "relations": [...]}' },
  { id: 'skill-yaml', label: 'skill.yaml', detail: 'Single manifest in YAML (nested metadata supported)' },
  { id: 'swarmos-package', label: 'SwarmOS package', detail: 'Portable package with typed relationships (round-trips our export)' },
  { id: 'zip-bundle', label: '.zip / .skill', detail: 'Bundle of one or more skills, stored or deflated entries' },
];

/* =========================================================================================
 * Minimal YAML (the subset manifests use): scalars, inline lists, block lists, one nested map.
 * =======================================================================================*/
const stripQuotes = (v) => String(v).trim().replace(/^['"]|['"]$/g, '');

function parseScalar(raw) {
  const v = String(raw).trim();
  if (!v) return '';
  if (/^\[.*\]$/.test(v)) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((x) => stripQuotes(x)).filter(Boolean);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === '|' || v === '>') return '';
  return stripQuotes(v);
}

export function parseYamlDoc(text) {
  const out = {};
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  let currentKey = null;
  let nested = null;
  let blockIndent = -1;
  const isComment = (line) => !line.trim() || /^\s*#/.test(line);
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    if (isComment(rawLine)) continue;
    const indent = rawLine.match(/^\s*/)[0].length;
    const line = rawLine.trim();
    if (blockIndent >= 0) {
      if (indent > blockIndent) {
        const holder = nested && currentKey ? nested : out;
        const prev = holder[currentKey];
        holder[currentKey] = `${prev || ''}${prev ? '\n' : ''}${line}`.trim();
        continue;
      }
      blockIndent = -1;
    }
    if (/^-\s+/.test(line) || line === '-') {
      const value = parseScalar(line.replace(/^-\s*/, ''));
      const holder = nested && currentKey ? nested : out;
      const list = Array.isArray(holder[currentKey]) ? holder[currentKey] : [];
      list.push(value);
      holder[currentKey] = list;
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, key, rest] = m;
    if (!rest) {
      currentKey = key;
      nested = null;
      let j = i + 1;
      while (j < lines.length && isComment(lines[j])) j += 1;
      const nextTrim = (lines[j] || '').trim();
      if (/^-\s/.test(nextTrim)) {
        out[key] = [];
      } else if (nextTrim && lines[j].match(/^\s*/)[0].length > indent) {
        nested = {};
        out[key] = nested;
      } else {
        out[key] = '';
      }
      continue;
    }
    if (rest === '|' || rest === '>') {
      blockIndent = indent;
      currentKey = key;
      if (nested) nested[key] = '';
      else out[key] = '';
      continue;
    }
    const value = parseScalar(rest);
    if (nested) nested[key] = value;
    else out[key] = value;
    currentKey = key;
  }
  return out;
}

/* =========================================================================================
 * Format detection
 * =======================================================================================*/
export function detectFormat({ filename = '', text = '', isBinary = false } = {}) {
  const lower = String(filename).toLowerCase();
  if (isBinary || /\.(zip|skill)$/.test(lower)) return 'zip-bundle';
  const body = String(text).trim();
  if (/^---\r?\n/.test(body)) return 'skill-md';
  if (/\.(ya?ml)$/.test(lower)) return 'skill-yaml';
  if (/^[[{]/.test(body)) {
    try {
      const parsed = JSON.parse(body);
      if (parsed && parsed.schema === PACKAGE_SCHEMA) return 'swarmos-package';
      if (Array.isArray(parsed)) return 'registry-json';
      if (parsed && Array.isArray(parsed.skills)) return parsed.schema === PACKAGE_SCHEMA ? 'swarmos-package' : 'registry-json';
      return 'skill-json';
    } catch {
      return 'unknown';
    }
  }
  if (/\.md$|\.markdown$/.test(lower)) return 'skill-md';
  if (/\bname\s*:/.test(body) && /\bdescription\s*:/.test(body)) return 'skill-yaml';
  return 'unknown';
}

/* =========================================================================================
 * Manifest normalisation
 * =======================================================================================*/
const NAME_RE = /^[a-z0-9][a-z0-9._-]{1,64}$/i;

function asList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return value.split(',').map(stripQuotes).filter(Boolean);
  return [];
}

export function normaliseSkill(raw = {}, { format = 'skill-json', file = '', body = '' } = {}) {
  const meta = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {};
  const name = String(raw.name || meta.name || '').trim();
  const description = String(raw.description || raw.desc || meta.description || raw.summary || '').trim();
  const tools = asList(raw['allowed-tools'] ?? raw.allowed_tools ?? raw.tools ?? meta.tools);
  const perms = asList(raw.permissions ?? raw.perms ?? meta.permissions);
  const requires = asList(raw.requires ?? raw.dependencies ?? meta.requires);
  return {
    name,
    version: String(raw.version || meta.version || '0.1.0').replace(/^v/i, ''),
    desc: description.split('\n')[0].slice(0, 240) || 'Imported skill (no description provided).',
    category: String(raw.category || meta.category || 'Imported'),
    author: String(raw.author || meta.author || raw.publisher || 'unknown'),
    license: String(raw.license || meta.license || 'unspecified'),
    compat: asList(raw.compat ?? raw.frameworks ?? meta.compat),
    perms,
    tools,
    requires,
    inputs: asList(raw.inputs ?? meta.inputs),
    outputs: asList(raw.outputs ?? meta.outputs),
    body: String(raw.body || body || '').slice(0, MAX_BODY_BYTES),
    origin: 'import',
    status: 'pending',
    success: 0,
    invokes: 0,
    updated: new Date().toISOString().slice(0, 10),
    changelog: [String(raw.changelog?.[0] || `Imported from ${format} (${file || 'pasted text'})`)],
    _format: format,
    _file: file,
  };
}

/* =========================================================================================
 * Scanning (untrusted input, spec §7.2 + §15)
 * =======================================================================================*/
const INJECTION = [
  { re: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|rules|prompts?)/i, what: 'instruction override' },
  { re: /disregard\s+(the\s+)?(system|developer)\s+(prompt|message)/i, what: 'system-prompt override' },
  { re: /you\s+are\s+now\s+(in\s+)?(developer|admin|god)\s*mode/i, what: 'role escalation' },
  { re: /exfiltrat(e|ion)|send\s+(the\s+)?(keys?|tokens?|secrets?)\s+to/i, what: 'data exfiltration' },
  { re: /curl[^\n|]*\|\s*(ba|z)?sh/i, what: 'piped shell download' },
  { re: /\brm\s+-rf\s+[~/]/i, what: 'destructive shell command' },
  { re: /base64\s+-d[^\n]*\|\s*(ba|z)?sh/i, what: 'obfuscated payload' },
  { re: /bypass\s+(the\s+)?(approval|permission|policy|rbac)/i, what: 'policy bypass' },
  { re: /\bgrant\s+(yourself|itself)\b|\bescalate\s+privileges?\b/i, what: 'privilege escalation' },
];

const SECRET_PATTERNS = [
  { re: /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}/, what: 'payment key' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/, what: 'GitHub token' },
  { re: /\bsk-[A-Za-z0-9_-]{20,}/, what: 'API key' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: 'AWS access key' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'private key' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, what: 'Slack token' },
];

const URL_RE = /https?:\/\/([^\s)"'<>]+)/gi;

export function scanSkill(skill) {
  const findings = [];
  const text = `${skill.body || ''}\n${skill.desc || ''}`;
  const bytes = new TextEncoder().encode(text).length;

  if (!skill.name) findings.push({ code: 'schema', severity: 'error', message: 'No skill name: a manifest must declare `name`.' });
  else if (!NAME_RE.test(skill.name)) findings.push({ code: 'schema', severity: 'error', message: `Invalid skill name “${skill.name}”: use letters, digits, dots, dashes or underscores (2–65 chars).` });
  if (!skill.desc || /imported skill \(no description/i.test(skill.desc)) {
    findings.push({ code: 'schema', severity: 'warning', message: 'No description: agents and reviewers cannot judge what the skill does.' });
  }
  if (bytes > MAX_BODY_BYTES) findings.push({ code: 'size', severity: 'error', message: `Skill body is ${Math.round(bytes / 1024)} KB; the limit is 64 KB.` });

  INJECTION.forEach(({ re, what }) => {
    if (re.test(text)) findings.push({ code: 'injection', severity: 'error', message: `Contains an ${what} pattern. Skill text is untrusted data and must never change platform policy.` });
  });

  SECRET_PATTERNS.forEach(({ re, what }) => {
    if (re.test(text)) findings.push({ code: 'secret', severity: 'error', message: `Looks like it contains a ${what}. Imports never carry credentials — remove it and use a connection reference.` });
  });

  const hosts = new Set();
  let m;
  const urlRe = new RegExp(URL_RE.source, 'gi');
  while ((m = urlRe.exec(text))) hosts.add(m[1].split('/')[0]);
  if (hosts.size) {
    findings.push({ code: 'network', severity: 'warning', message: `References ${hosts.size} external host(s): ${[...hosts].slice(0, 5).join(', ')}. Importing does not fetch them or grant egress.` });
  }
  if (skill.tools.length) {
    findings.push({ code: 'tools', severity: 'info', message: `Declares ${skill.tools.length} tool(s) (${skill.tools.slice(0, 4).join(', ')}). The import grants none of them.` });
  }
  if (skill.perms.length) {
    findings.push({ code: 'permissions', severity: 'info', message: `Requests ${skill.perms.length} permission(s) (${skill.perms.slice(0, 4).join(', ')}). A reviewer must grant them separately.` });
  }
  if (skill.requires.length) {
    findings.push({ code: 'dependencies', severity: 'info', message: `Requires ${skill.requires.length} skill(s): ${skill.requires.join(', ')}.` });
  }
  if (!skill.tools.length && /\b(exec|shell|subprocess|eval)\s*\(/i.test(text)) {
    findings.push({ code: 'undeclared', severity: 'warning', message: 'Body mentions code execution but the manifest declares no tool that could run it.' });
  }
  if (!skill.license || skill.license === 'unspecified') {
    findings.push({ code: 'license', severity: 'warning', message: 'No licence declared: redistribution rights are unknown.' });
  }
  return findings;
}

/* =========================================================================================
 * ZIP reader (stored + deflate; no third-party dependency)
 * =======================================================================================*/
const u16 = (dv, o) => dv.getUint16(o, true);
const u32 = (dv, o) => dv.getUint32(o, true);

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot decompress zip entries (DecompressionStream missing).');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Read a zip archive into { name, text } entries. Path traversal is reported, never followed. */
export async function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 66000; i -= 1) {
    if (u32(view, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid zip archive (no end-of-central-directory record).');
  const count = u16(view, eocd + 10);
  const cdOffset = u32(view, eocd + 16);
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (u32(view, p) !== 0x02014b50) break;
    const method = u16(view, p + 10);
    const compressedSize = u32(view, p + 20);
    const nameLen = u16(view, p + 28);
    const extraLen = u16(view, p + 30);
    const commentLen = u16(view, p + 32);
    const localOffset = u32(view, p + 42);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    const lhNameLen = u16(view, localOffset + 26);
    const lhExtraLen = u16(view, localOffset + 28);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    entries.push({ name, method, raw });
  }
  const out = [];
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    let data = entry.raw;
    if (entry.method === 8) data = await inflateRaw(entry.raw);
    else if (entry.method !== 0) throw new Error(`Unsupported zip compression method ${entry.method} for ${entry.name}.`);
    out.push({ name: entry.name, text: new TextDecoder().decode(data), bytes: data.length });
  }
  return out;
}

/* =========================================================================================
 * Parsing per format
 * =======================================================================================*/
function splitFrontmatter(text) {
  // Strip a UTF-8 BOM and normalise newlines before looking for --- fences.
  const clean = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const m = clean.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { front: null, body: clean };
  return { front: parseYamlDoc(m[1]), body: m[2] };
}

export function parseSkillMarkdown(text, file = 'SKILL.md') {
  const { front, body } = splitFrontmatter(text);
  if (!front) {
    const heading = (body.match(/^#\s+(.+)$/m) || [])[1];
    const derived = heading ? heading.trim() : (file.split('/').pop() || 'Skill').replace(/\.(md|markdown)$/i, '');
    return {
      draft: normaliseSkill({ name: deriveName(derived), description: firstParagraph(body), body }, { format: 'skill-md', file, body }),
      derived: true,
    };
  }
  const draft = normaliseSkill({ ...front, body }, { format: 'skill-md', file, body });
  return { draft, derived: false };
}

const deriveName = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'imported-skill';

const firstParagraph = (body) =>
  String(body || '')
    .split(/\n{2,}/)
    .map((p) => p.replace(/^#+\s*/, '').trim())
    .find((p) => p.length > 0) || '';

function parseJsonPayload(parsed, file) {
  const skills = [];
  const relations = [];
  const add = (raw, format) => skills.push(normaliseSkill(raw, { format, file, body: raw.body || raw.instructions || '' }));
  if (Array.isArray(parsed)) {
    parsed.forEach((raw) => add(raw, 'registry-json'));
    return { skills, relations };
  }
  if (parsed && parsed.schema === PACKAGE_SCHEMA) {
    (parsed.skills || []).forEach((raw) => add(raw, 'swarmos-package'));
    (parsed.relations || []).forEach((r) => relations.push({ ...r }));
    return { skills, relations };
  }
  if (parsed && Array.isArray(parsed.skills)) {
    parsed.skills.forEach((raw) => add(raw, 'registry-json'));
    (parsed.relations || []).forEach((r) => relations.push({ ...r }));
    return { skills, relations };
  }
  add(parsed || {}, 'skill-json');
  return { skills, relations };
}

/* =========================================================================================
 * Dependency + conflict resolution
 * =========================================================================================*/
function resolveOne(skill, { existing, importedNames }) {
  const conflicts = [];
  const missing = [];
  const same = existing.find((s) => s.name === skill.name);
  if (same) {
    if (same.version === skill.version) {
      conflicts.push({ kind: 'duplicate', message: `${skill.name} v${skill.version} is already installed.` });
    } else {
      conflicts.push({ kind: 'version', message: `${skill.name} v${same.version} is installed; this package has v${skill.version}. Installing replaces it explicitly — nothing is overwritten silently.` });
    }
  }
  skill.requires.forEach((dep) => {
    // Only *installed* skills satisfy a dependency; catalogue entries the user has not added do not.
    const known = existing.some((s) => s.name === dep && s.installed !== false) || importedNames.has(dep);
    if (!known) missing.push(dep);
  });
  return { conflicts, missing };
}

/* =========================================================================================
 * Top-level analysis
 * =======================================================================================*/
/**
 * Parse and validate an import without touching state.
 * @param {{text?: string, filename?: string, bytes?: Uint8Array}} input
 */
export async function analyseImport(input = {}) {
  const filename = input.filename || 'pasted-text';
  const state = getState();
  const errors = [];
  const skills = [];
  const relations = [];
  let format = 'unknown';

  try {
    if (input.bytes) {
      if (input.bytes.length > MAX_PACKAGE_BYTES) {
        return { ok: false, format: 'unknown', errors: [{ code: 'size', severity: 'error', message: `Package is ${(input.bytes.length / 1024 / 1024).toFixed(1)} MB; the limit is 4 MB.` }], skills: [], relations: [] };
      }
      format = detectFormat({ filename, isBinary: true });
      if (format !== 'zip-bundle') {
        return { ok: false, format, errors: [{ code: 'format', severity: 'error', message: `Binary uploads must be .zip or .skill bundles. Got “${filename}”.` }], skills: [], relations: [] };
      }
      const entries = await readZip(input.bytes);
      const traversal = entries.filter((e) => /(^|\/)\.\.(\/|$)/.test(e.name) || /^[\\/]/.test(e.name) || e.name.includes('\\'));
      if (traversal.length) {
        return {
          ok: false, format, skills: [], relations: [],
          errors: [{ code: 'path', severity: 'error', message: `Archive contains unsafe paths (${traversal.map((e) => e.name).slice(0, 3).join(', ')}). Nothing was imported.` }],
        };
      }
      const bundles = entries.filter((e) => /(^|\/)(SKILL\.md|skill\.md)$/i.test(e.name));
      const manifests = entries.filter((e) => /(^|\/)skill\.json$/i.test(e.name));
      bundles.forEach((entry) => {
        const parsed = parseSkillMarkdown(entry.text, entry.name);
        skills.push(parsed.draft);
        if (parsed.derived) parsed.draft._derivedName = true;
      });
      manifests.forEach((entry) => {
        try {
          const payload = parseJsonPayload(JSON.parse(entry.text), entry.name);
          skills.push(...payload.skills);
          relations.push(...payload.relations);
        } catch (err) {
          errors.push({ code: 'schema', severity: 'error', message: `${entry.name} is not valid JSON: ${err.message}` });
        }
      });
      if (!skills.length) {
        errors.push({ code: 'empty', severity: 'error', message: 'No SKILL.md or skill.json found in the bundle.' });
      }
    } else {
      const text = String(input.text || '');
      format = detectFormat({ filename, text });
      if (format === 'unknown') {
        const ext = (filename.match(/\.[a-z0-9]+$/i) || [''])[0];
        return {
          ok: false, format, skills: [], relations: [],
          errors: [{
            code: 'format', severity: 'error',
            message: ext
              ? `“${ext}” files are not a skill format. Use ${ACCEPTED_EXTENSIONS.join(', ')} or paste a SKILL.md / manifest.`
              : 'Could not recognise the format. Start a SKILL.md with a --- frontmatter block, or paste a skill manifest as JSON/YAML.',
          }],
        };
      }
      if (format === 'swarmos-package' || format === 'registry-json' || format === 'skill-json') {
        const payload = parseJsonPayload(JSON.parse(text), filename);
        skills.push(...payload.skills);
        relations.push(...payload.relations);
      } else if (format === 'skill-yaml') {
        skills.push(normaliseSkill(parseYamlDoc(text), { format, file: filename, body: text }));
      } else {
        const parsed = parseSkillMarkdown(text, filename);
        skills.push(parsed.draft);
        if (parsed.derived) parsed.draft._derivedName = true;
      }
    }
  } catch (err) {
    return { ok: false, format, skills: [], relations: [], errors: [{ code: 'parse', severity: 'error', message: `Could not read the package: ${err.message}` }] };
  }

  const existing = state.skills || [];
  const importedNames = new Set(skills.map((s) => s.name));
  const reviewed = skills.map((skill) => {
    const findings = scanSkill(skill);
    if (skill._derivedName) {
      findings.push({ code: 'derived-name', severity: 'warning', message: `No name in frontmatter: “${skill.name}” was derived from the heading/filename. Check it before installing.` });
    }
    if (skill.tools.length && !skill.perms.length) {
      findings.push({ code: 'tools-without-perms', severity: 'warning', message: 'Declares tools but no permissions — the reviewer cannot tell what access it expects.' });
    }
    const { conflicts, missing } = resolveOne(skill, { existing, importedNames });
    conflicts.forEach((c) => findings.push({ code: c.kind, severity: c.kind === 'duplicate' ? 'error' : 'warning', message: c.message }));
    missing.forEach((dep) => findings.push({ code: 'missing-dependency', severity: 'warning', message: `Depends on “${dep}”, which is not installed and not in this package.` }));
    const blocking = findings.filter((f) => f.severity === 'error');
    const status = blocking.length ? 'blocked' : conflicts.length ? 'conflict' : missing.length ? 'needs-deps' : 'ready';
    return { skill, findings, conflicts, missing, status };
  });

  const known = new Set([...existing.map((s) => s.name), ...importedNames]);
  const relationIssues = [];
  const acceptedRelations = relations.filter((r) => {
    const from = r.from || r.source;
    const to = r.to || r.target;
    const type = r.type || 'related_to';
    if (!known.has(from) || !known.has(to)) {
      relationIssues.push({ severity: 'warning', message: `Relationship ${from} → ${to} dropped: it references a skill that is not present.` });
      return false;
    }
    if (!REL_TYPES[type]) {
      relationIssues.push({ severity: 'warning', message: `Relationship ${from} → ${to} dropped: unknown type “${type}”.` });
      return false;
    }
    return true;
  }).map((r) => ({
    id: r.id && /^[\w-]{1,64}$/.test(r.id) ? r.id : uid('rl'),
    from: r.from || r.source,
    to: r.to || r.target,
    type: r.type || 'related_to',
    note: r.note || '',
    imported: true,
  }));

  const blocked = reviewed.filter((r) => r.status === 'blocked');
  return {
    ok: errors.length === 0 && reviewed.length > 0,
    format,
    file: filename,
    skills: reviewed,
    relations: acceptedRelations,
    relationIssues,
    errors,
    installable: reviewed.filter((r) => r.status !== 'blocked'),
    blocked: blocked.length,
    findings: reviewed.flatMap((r) => r.findings),
  };
}

/* =========================================================================================
 * Install / reject / audit
 * =========================================================================================*/
/**
 * Install the reviewed items. Imported skills land as `pending` (quarantined) — a human approves
 * them from the Skills Hub, and even then no tool or permission is granted by the import itself.
 */
export function installImport(analysis, { skip = [], by = 'you' } = {}) {
  if (!analysis || !analysis.ok) return { ok: false, error: 'Nothing to install: the analysis failed.' };
  const skipSet = new Set(skip);
  const accepted = (analysis.skills || []).filter((r) => r.status !== 'blocked' && !skipSet.has(r.skill.name));
  if (!accepted.length) return { ok: false, error: 'Every item was skipped or blocked.' };

  const stamp = now();
  const created = [];
  setState((s) => {
    accepted.forEach(({ skill, findings }) => {
      const existing = (s.skills || []).find((x) => x.name === skill.name);
      const record = {
        id: existing?.id || uid('sk'),
        name: skill.name,
        version: skill.version,
        origin: 'import',
        status: 'pending',
        category: skill.category,
        author: skill.author,
        license: skill.license,
        compat: skill.compat,
        perms: skill.perms,
        tools: skill.tools,
        requires: skill.requires,
        inputs: skill.inputs,
        outputs: skill.outputs,
        body: skill.body,
        success: 0,
        invokes: 0,
        updated: new Date().toISOString().slice(0, 10),
        changelog: skill.changelog,
        desc: skill.desc,
        imported: {
          at: stamp,
          by,
          format: analysis.format,
          file: analysis.file,
          findings: findings.map((f) => ({ code: f.code, severity: f.severity, message: f.message })),
          quarantined: true,
        },
      };
      if (existing) Object.assign(existing, record);
      else s.skills.unshift(record);
      created.push(record.name);
    });
    (analysis.relations || []).forEach((rel) => {
      const dup = (s.relations || []).some((x) => x.from === rel.from && x.to === rel.to && x.type === rel.type);
      if (!dup) s.relations = [...(s.relations || []), rel];
    });
    s.skillImports = [
      {
        id: uid('imp'),
        at: stamp,
        format: analysis.format,
        file: analysis.file,
        installed: created,
        skipped: skip,
        relationCount: (analysis.relations || []).length,
        findings: (analysis.findings || []).filter((f) => f.severity !== 'info').length,
      },
      ...(s.skillImports || []),
    ].slice(0, 40);
    logEvent('skill', `Imported ${created.length} skill(s) from ${analysis.format} · quarantined pending review`);
  }, 'skill-import');
  return { ok: true, installed: created };
}

export function rejectImport(analysis, reason = 'rejected by reviewer') {
  setState((s) => {
    s.skillImports = [
      { id: uid('imp'), at: now(), format: analysis?.format || 'unknown', file: analysis?.file || '—', installed: [], skipped: [], rejected: true, reason, findings: (analysis?.findings || []).length },
      ...(s.skillImports || []),
    ].slice(0, 40);
    logEvent('skill', `Import rejected: ${reason}`);
  }, 'skill-import-reject');
  return { ok: true };
}

/* =========================================================================================
 * Export (spec §7.3) — portable package, no secrets, relationships included
 * =======================================================================================*/
export function buildPackage(skillNames, { relations = null, agent = null } = {}) {
  const s = getState();
  const names = new Set(skillNames);
  const skills = (s.skills || [])
    .filter((k) => names.has(k.name))
    .map((k) => ({
      name: k.name,
      version: k.version,
      description: k.desc,
      category: k.category,
      author: k.author,
      license: k.license,
      compat: k.compat || [],
      permissions: k.perms || [],
      tools: k.tools || [],
      requires: k.requires || [],
      inputs: k.inputs || [],
      outputs: k.outputs || [],
      body: k.body || '',
      changelog: k.changelog || [],
    }));
  const edges = (relations || s.relations || [])
    .filter((r) => names.has(r.from) && names.has(r.to))
    .map((r) => ({ from: r.from, to: r.to, type: r.type, note: r.note || '' }));
  const omitted = (s.relations || []).filter((r) => names.has(r.from) !== names.has(r.to));
  return {
    schema: PACKAGE_SCHEMA,
    exportedAt: new Date().toISOString(),
    exporter: 'SwarmOS Skills Hub',
    agent: agent || null,
    skills,
    relations: edges,
    omittedRelations: omitted.length,
    notes: 'Declarations only. No credentials, memory, run logs or granted permissions are included.',
  };
}

export const packageToJson = (pkg) => JSON.stringify(pkg, null, 2);

/** Marker used by tests and the UI to describe where a skill came from. */
export function provenanceLine(skill) {
  if (!skill) return '';
  if (skill.imported) return `imported · ${skill.imported.format} · ${skill.imported.file}`;
  return `${skill.origin || 'unknown'} · v${skill.version}`;
}
