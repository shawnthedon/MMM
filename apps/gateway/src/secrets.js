/* ============ Sealed secrets — the only place key material is read ============
 * Every secret this gateway keeps (comms credentials, provider API keys, and whatever comes next) is
 * sealed with AES-256-GCM before it reaches SQLite. The key material never leaves this module:
 *
 *   MMM_SECRET            — set it in production; anything else is a development convenience.
 *   <DATA_DIR>/.mmm-key   — generated once, mode 0600, when MMM_SECRET is absent.
 *   <DATA_DIR>/.comms-key — legacy location from before this module existed; still honoured so an
 *                           existing deployment does not lose access to its sealed values.
 *
 * Derivation is domain-separated: each *purpose* gets its own AES key derived with HKDF-SHA256 from the
 * same material, so a ciphertext sealed for one purpose cannot be opened by another. Tampering with a
 * ciphertext (or using the wrong key) throws instead of silently returning garbage.
 *
 * What this module deliberately does NOT do: log, print, or return plaintext anywhere but to its caller.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
const KEY_FILE = join(DATA_DIR, '.mmm-key');
const LEGACY_KEY_FILE = join(DATA_DIR, '.comms-key');

let cachedMaterial = null;
let warned = false;

function material() {
  if (cachedMaterial) return cachedMaterial;
  if (process.env.MMM_SECRET && String(process.env.MMM_SECRET).length >= 16) {
    cachedMaterial = { source: 'env', secret: String(process.env.MMM_SECRET) };
    return cachedMaterial;
  }
  for (const file of [KEY_FILE, LEGACY_KEY_FILE]) {
    if (existsSync(file)) {
      cachedMaterial = { source: 'file', secret: readFileSync(file, 'utf8').trim(), path: file };
      return cachedMaterial;
    }
  }
  const generated = randomBytes(32).toString('hex');
  writeFileSync(KEY_FILE, generated, { mode: 0o600 });
  try { chmodSync(KEY_FILE, 0o600); } catch { /* no modes on this filesystem */ }
  cachedMaterial = { source: 'generated', secret: generated, path: KEY_FILE };
  return cachedMaterial;
}

/** Where the key material came from — for diagnostics, never the material itself. */
export const keySource = () => material().source;

/** True when the deployment supplied its own secret; a generated one is a local-development state. */
export const isDeploymentSecret = () => material().source !== 'generated';

/**
 * A 32-byte AES key for one purpose. `info` is the domain separator: changing it makes every value
 * sealed under the old purpose unreadable, which is exactly what you want it to do.
 */
export function purposeKeyFor(info, { salt = 'mmm-secret-salt' } = {}) {
  const out = hkdfSync('sha256', Buffer.from(material().secret, 'utf8'), Buffer.from(salt, 'utf8'), Buffer.from(info, 'utf8'), 32);
  return Buffer.from(out);
}

/**
 * The key comms configuration was sealed with before this module existed used a different salt. Keeping
 * that derivation means a value sealed last year still opens today; new purposes use the default.
 */
export const LEGACY_COMMS_SALT = 'mmm-comms-salt';

const keyCache = new Map();
const keyFor = (info) => {
  if (!keyCache.has(info)) keyCache.set(info, purposeKeyFor(info));
  return keyCache.get(info);
};

/** Seal a JSON-serialisable value. Format: `v1.<iv>.<tag>.<body>`, all base64url. */
export function seal(value, { purpose = 'default', salt = null } = {}) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', salt ? purposeKeyFor(purpose, { salt }) : keyFor(purpose), iv);
  const body = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), 'utf8')), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}

/** Open a sealed value. Returns `null` when it cannot be opened (wrong key, wrong purpose, tampering). */
export function unseal(sealed, { purpose = 'default', salt = null } = {}) {
  const parts = String(sealed || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const [, ivB64, tagB64, bodyB64] = parts;
  try {
    const decipher = createDecipheriv('aes-256-gcm', salt ? purposeKeyFor(purpose, { salt }) : keyFor(purpose), Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    const plain = Buffer.concat([decipher.update(Buffer.from(bodyB64, 'base64url')), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * A stable, non-reversible identifier for a secret. Used to say *which* key is installed without ever
 * showing it: the same key always has the same fingerprint, and the fingerprint cannot be turned back
 * into the key.
 */
export const fingerprint = (secret) => createHash('sha256').update(String(secret), 'utf8').digest('hex').slice(0, 16);

/** A short, human-recognisable tail (`••••abcd`). Short enough to be useless on its own. */
export const hint = (secret) => {
  const text = String(secret || '');
  return text.length >= 8 ? `••••${text.slice(-4)}` : '••••';
};

/**
 * Constant-time compare for values that are already public-ish (fingerprints, tokens). Kept here so no
 * caller invents its own `===` for a secret comparison.
 */
export const sameSecret = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Warn once, at startup, if the deployment is running on generated key material. */
export function warnIfGenerated() {
  if (warned) return;
  warned = true;
  if (keySource() === 'generated' && !process.env.MMM_QUIET) {
    console.warn('[secrets] MMM_SECRET is not set — sealed provider keys are encrypted with a generated local key. Set MMM_SECRET before production use.');
  }
}
