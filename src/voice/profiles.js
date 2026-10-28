/* ============ Voice profiles ============
 * Profiles are metadata plus a pointer to a voice the *engine* owns (a platform voice id, or a
 * cloned profile id on a local host). Raw reference audio is never written to localStorage.
 *
 * Consent is a first-class field: a cloned profile cannot be created or used without one, and
 * revoking or deleting it invalidates queued speech.
 */

export const PROFILE_STATUS = {
  active: 'active',
  needsEngine: 'needs-engine',
  needsConsent: 'needs-consent',
  revoked: 'revoked',
};

export const CAP_PROFILES = 12;

export function defaultProfiles() {
  return [
    {
      id: 'device-default',
      name: 'Device voice',
      kind: 'device',
      engine: 'browser-speech',
      voiceRef: '',
      consent: null,
      status: PROFILE_STATUS.active,
      createdAt: null,
      note: 'Uses whichever voice the operating system selects.',
    },
    {
      id: 'my-cloned-voice',
      name: 'My cloned voice',
      kind: 'cloned',
      engine: '',
      voiceRef: '',
      consent: null,
      status: PROFILE_STATUS.needsEngine,
      createdAt: null,
      note: 'Requires a configured local cloning engine and a recorded consent decision.',
    },
  ];
}

/** Profiles are validated on load; unknown shapes are discarded rather than trusted. */
export function sanitiseProfiles(list) {
  if (!Array.isArray(list)) return defaultProfiles();
  const clean = list.filter((profile) => profile && typeof profile.id === 'string' && typeof profile.name === 'string').slice(0, CAP_PROFILES);
  if (!clean.length) return defaultProfiles();
  return clean.map((profile) => ({
    id: profile.id,
    name: String(profile.name).slice(0, 60),
    kind: ['device', 'cloned', 'builtin'].includes(profile.kind) ? profile.kind : 'device',
    engine: String(profile.engine || ''),
    voiceRef: String(profile.voiceRef || ''),
    consent: profile.consent && profile.consent.granted
      ? { granted: true, by: String(profile.consent.by || ''), at: String(profile.consent.at || ''), scope: String(profile.consent.scope || 'local-synthesis') }
      : null,
    status: Object.values(PROFILE_STATUS).includes(profile.status) ? profile.status : PROFILE_STATUS.active,
    createdAt: profile.createdAt || null,
    note: String(profile.note || ''),
  }));
}

export function findProfile(profiles, id) {
  return sanitiseProfiles(profiles).find((profile) => profile.id === id) || null;
}

/**
 * Decide which profile can actually be used right now.
 * Returns the usable profile plus an explicit reason when the requested one cannot be used, so the
 * UI can explain the substitution instead of silently speaking in a different voice.
 */
export function resolveActiveProfile({ profiles, requestedId, adapters = {} } = {}) {
  const list = sanitiseProfiles(profiles);
  const requested = list.find((profile) => profile.id === requestedId) || null;
  const device = list.find((profile) => profile.kind === 'device' && profile.status === PROFILE_STATUS.active) || null;
  if (!requested) {
    return device
      ? { profile: device, fallback: true, reason: 'The saved voice profile no longer exists; using the device voice.' }
      : { profile: null, fallback: false, reason: 'No voice profile is available.' };
  }
  if (requested.status === PROFILE_STATUS.revoked) {
    return { profile: null, fallback: false, reason: `“${requested.name}” has been revoked. Re-enable it with a new consent decision or choose another voice.` };
  }
  const noFallback = device ? '' : ' No fallback device voice is available.';
  if (requested.kind === 'cloned') {
    if (requested.status === PROFILE_STATUS.needsEngine || !adapters.cloning?.supported) {
      const reason = `${reasonForCloneUnavailable(adapters)}${noFallback}`;
      return device && requested.id !== device.id
        ? { profile: device, fallback: true, requested, reason }
        : { profile: null, fallback: false, requested, reason };
    }
    if (!requested.consent?.granted) {
      return { profile: null, fallback: false, requested, reason: `“${requested.name}” has no recorded consent, so it cannot be used.` };
    }
  }
  if (requested.kind === 'device' && requested.status !== PROFILE_STATUS.active) {
    return { profile: null, fallback: false, requested, reason: `“${requested.name}” is ${requested.status}.` };
  }
  return { profile: requested, fallback: false, reason: '' };
}

function reasonForCloneUnavailable(adapters = {}) {
  return adapters.cloning?.supported
    ? 'The cloned voice engine is configured but the profile has not been trained on it yet.'
    : 'No local cloning engine is configured, so cloned-voice profiles cannot synthesise. Text-to-speech uses the device voice instead.';
}

/** Build a profile from a consent decision. Audio is not stored; only the descriptor is. */
export function createClonedProfile({ id, name, consent, engine, voiceRef }) {
  if (!consent?.granted || !consent.by) return { ok: false, reason: 'Explicit consent (with the consenting principal) is required.' };
  if (!engine) return { ok: false, reason: 'A cloning engine id is required.' };
  return {
    ok: true,
    profile: {
      id,
      name: String(name).trim().slice(0, 60),
      kind: 'cloned',
      engine,
      voiceRef: String(voiceRef || id),
      consent: { granted: true, by: consent.by, at: consent.at || new Date().toISOString(), scope: consent.scope || 'local-synthesis' },
      status: PROFILE_STATUS.active,
      createdAt: new Date().toISOString(),
      note: 'Created locally. Reference audio is not stored in this browser.',
    },
  };
}
