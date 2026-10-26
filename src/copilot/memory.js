/* ============ Copilot layered memory (browser-scoped, redacted) ============
 * Layers implemented here (master spec §5.1):
 *   working      — mode + unsent draft, restored when the panel reopens
 *   episodic     — one record per Copilot action, capped, shown in Activity mode
 *   preferences  — per-browser display defaults
 * Authoritative + semantic knowledge lives in knowledge.js (static, versioned).
 * Operational state is NOT stored here: jobs/checkpoints belong to a runtime, and this repo
 * has none. Nothing is written that looks like a credential.
 */
import { esc, getState } from '../core.js';

const KEY = 'swarmos-copilot-memory-v1';
const EPISODE_CAP = 50;

const EMPTY = () => ({
  version: 1,
  workspace: 'SwarmLab',
  working: { mode: null, draft: '' },
  preferences: { defaultMode: 'ask', verbose: false },
  episodic: [],
  updatedAt: null,
});

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{8,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*\S+/gi,
];

/** Remove credential-looking strings before anything touches storage or a log. */
export function redact(text) {
  let out = String(text ?? '');
  let hit = false;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      hit = true;
      return '[redacted]';
    });
  }
  return { text: out, redacted: hit };
}

function safeParse(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return EMPTY();
    return {
      ...EMPTY(),
      ...parsed,
      working: { ...EMPTY().working, ...(parsed.working || {}) },
      preferences: { ...EMPTY().preferences, ...(parsed.preferences || {}) },
      episodic: Array.isArray(parsed.episodic) ? parsed.episodic.slice(0, EPISODE_CAP) : [],
    };
  } catch {
    return EMPTY();
  }
}

export function loadMemory() {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return raw ? safeParse(raw) : EMPTY();
  } catch {
    return EMPTY();
  }
}

let cache = null;
function current() {
  if (!cache) cache = loadMemory();
  return cache;
}

/** The Settings screen can switch persistence off; honour it instead of silently storing. */
function persistenceEnabled() {
  try {
    return getState().settings.copilotMemory !== false;
  } catch {
    return true;
  }
}

function write(next) {
  cache = { ...next, version: 1, updatedAt: Date.now() };
  if (!persistenceEnabled()) return cache;
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* storage full or blocked — memory stays in-session only */
  }
  return cache;
}

/* ---------- working memory ---------- */
export function saveWorking({ mode, draft }) {
  const mem = current();
  const safe = {};
  if (typeof mode === 'string') safe.mode = mode;
  if (typeof draft === 'string') safe.draft = redact(draft.slice(0, 4000)).text;
  return write({ ...mem, working: { ...mem.working, ...safe } });
}

export function getWorking() {
  return current().working;
}

/* ---------- preferences ---------- */
export function getPreferences() {
  return current().preferences;
}

export function setPreference(name, value) {
  const mem = current();
  return write({ ...mem, preferences: { ...mem.preferences, [name]: value } });
}

/* ---------- episodic memory ---------- */
/**
 * @param {{mode:string,intent:string,summary:string,outcome:'ok'|'failed'|'blocked'|'cancelled'|'info',
 *          evidence?:string[],refs?:{label:string,ref:string}[],risk?:string}} episode
 */
export function pushEpisode(episode) {
  const mem = current();
  const safeText = (v) => redact(v).text;
  const record = {
    id: `ep-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    ts: Date.now(),
    mode: episode.mode || 'ask',
    intent: safeText(episode.intent || '').slice(0, 120),
    summary: safeText(episode.summary || '').slice(0, 400),
    outcome: episode.outcome || 'info',
    risk: episode.risk || 'read-only',
    evidence: (episode.evidence || []).map((e) => safeText(String(e)).slice(0, 200)).slice(0, 8),
    refs: (episode.refs || []).slice(0, 6),
  };
  const episodic = [record, ...mem.episodic].slice(0, EPISODE_CAP);
  write({ ...mem, episodic });
  return record;
}

export function listEpisodes(limit = 20) {
  return current().episodic.slice(0, limit);
}

/* ---------- lifecycle ---------- */
export function clearEpisodes() {
  return write({ ...current(), episodic: [] });
}

export function clearMemory() {
  cache = EMPTY();
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {
    /* ignore */
  }
  return cache;
}

export function exportMemory() {
  return JSON.stringify({ exportedAt: new Date().toISOString(), ...current() }, null, 2);
}

export function memorySummary() {
  const mem = current();
  const counts = mem.episodic.reduce((acc, e) => {
    acc[e.outcome] = (acc[e.outcome] || 0) + 1;
    return acc;
  }, {});
  return {
    episodes: mem.episodic.length,
    counts,
    lastAt: mem.episodic[0]?.ts || null,
    hasDraft: Boolean(mem.working.draft),
    defaultMode: mem.preferences.defaultMode,
    cap: EPISODE_CAP,
    storage: mem.updatedAt && persistenceEnabled() ? 'localStorage' : 'session only',
  };
}

/** Safe rendering of a stored episode summary (never trust stored text as HTML). */
export const episodeText = (text) => esc(redact(text).text);
