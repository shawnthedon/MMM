/* ============ Capability registry ============
 * Single source of truth for "can Copilot actually do this here?". Modes and cards read from
 * it, so the UI cannot advertise a feature the repository does not have.
 * status: available | demo | blocked | unconfigured | unverified
 */
import { getRuntime } from './runtime.js';
import { isApiMode } from '../api.js';
import { getAuth, can } from '../auth.js';
import { knowledgeStats } from './knowledge.js';
import { memorySummary } from './memory.js';
import { getState } from '../core.js';

const CAPS = {
  knowledge: {
    id: 'knowledge',
    label: 'Grounded knowledge',
    status: 'available',
    summary: 'Bundled, versioned, source-linked knowledge pack with keyword retrieval.',
    detail:
      'Read-only snapshot built from this repository. Search returns verification status, version and source references. There is no ingestion, editing, revision or approval pipeline yet.',
    requirements: ['Knowledge editor + revision store (Phase 2)'],
    evidence: () => `${knowledgeStats().total} entries · ${knowledgeStats().sources} source files · pack ${knowledgeStats().version}`,
  },
  memory: {
    id: 'memory',
    label: 'Copilot memory',
    status: 'available',
    summary: 'Working draft, episodic action log and preferences, scoped to this browser.',
    detail:
      'Persisted in localStorage with secret redaction. No semantic memory, no cross-device continuity, no server audit trail.',
    requirements: ['Server memory service with retention + audit (Phase 2)'],
    evidence: () => {
      const m = memorySummary();
      return `${m.episodes}/${m.cap} episodes · draft ${m.hasDraft ? 'saved' : 'empty'} · ${m.storage}`;
    },
  },
  actions: {
    id: 'actions',
    label: 'App actions',
    status: 'demo',
    summary: 'Operates the seeded demo store in this browser — not the gateway.',
    detail:
      'Creates agents, tasks and swarms and resolves approvals against localStorage. Every mutation shows a risk card and is recorded in episodic memory. Nothing is sent to the gateway or enforced by a server.',
    requirements: ['Frontend API client + auth/RBAC (checklist 2.5 / 3.4)', 'Server-side policy enforcement'],
    evidence: () => {
      const rt = getRuntime();
      return `store: ${rt.store.mode} · gateway: ${rt.gateway.status}`;
    },
    // Recomputed on every read so the card always matches the live session.
    dynamic() {
      const rt = getRuntime();
      const auth = getAuth();
      if (!isApiMode()) {
        return {
          status: 'demo',
          summary: 'Operating the seeded demo store in this browser — not the gateway.',
          detail:
            'No gateway is configured, so agent/task/approval actions are written to localStorage. Nothing is enforced, authorised or audited by a server. Configure a gateway and sign in to enable server-side RBAC.',
          requirements: ['Set a gateway URL and sign in (npm run dev:gateway)'],
          evidence: `store: ${rt.store.mode} · no gateway configured`,
        };
      }
      if (auth.status === 'unreachable') {
        return {
          status: 'unconfigured',
          summary: 'Gateway unreachable — actions cannot be authorised right now.',
          detail: 'Requests are refused locally rather than written to the demo store, so you never get an unreviewed change that only exists in one place.',
          requirements: ['Gateway reachable at the configured URL'],
          evidence: auth.error || 'network error',
        };
      }
      if (auth.status !== 'authenticated') {
        return {
          status: 'unconfigured',
          summary: 'Not signed in — the gateway cannot authorise any action.',
          detail: 'Sign in from the Account screen. Without a session every write would be a 401.',
          requirements: ['Sign in with a principal that holds agent:write / task:write'],
          evidence: 'no session',
        };
      }
      const mayWrite = can('agent:write') || can('task:write');
      if (!mayWrite) {
        return {
          status: 'blocked',
          summary: `Signed in as ${auth.principal.name} (${auth.principal.role}) — this role may not write.`,
          detail:
            'The gateway enforces the RBAC matrix server-side, so read-only roles cannot create agents, tasks or approvals. Ask an Owner or Admin to grant a higher role.',
          requirements: ['A role holding agent:write / task:write (Operator or above)'],
          evidence: `${auth.permissions.length} permissions held · role ${auth.principal.role}`,
        };
      }
      const canDecide = can('approval:decide');
      return {
        status: 'available',
        summary: `Server-enforced actions as ${auth.principal.role} (${auth.principal.name}).`,
        detail:
          `Agent and task writes are authorised by gateway RBAC and recorded in the hash-chained audit log. ` +
          (canDecide
            ? 'Approval gates can be decided here, subject to separation of duties.'
            : 'Approval gates can be requested but not decided by this role.') +
          ' Swarm deployment is still local: the gateway has no swarm endpoint yet.',
        requirements: canDecide ? [] : ['Reviewer/Admin/Owner role to decide approval gates'],
        evidence: `gateway ${rt.gateway.url} · ${auth.permissions.length} permissions · audit chain live`,
      };
    },
  },
  training: {
    id: 'training',
    label: 'Model Training Studio',
    status: 'blocked',
    summary: 'No training backend exists, so no job can be created or reported.',
    detail:
      'The repository has no dataset decoder, job queue, worker, checkpoint store, evaluator or model registry. Inference, retrieval, fine-tuning, LoRA and full training are different operations; none are wired. Dataset checks run locally against File Manager metadata and say what they cannot verify.',
    requirements: [
      'Verified training backend + worker adapter',
      'Dataset contract per modality (audio/image/text)',
      'Checkpoint + artifact storage and model registry',
      'Resource limits, isolation and licence/consent checks',
    ],
    evidence: () => 'no worker process, no job table usage, no model registry in repo',
  },
  voice: {
    id: 'voice',
    label: 'Voice Studio',
    status: 'unverified',
    summary: 'Device text-to-speech works; cloning and Qwen2.5-Omni are not available here.',
    detail:
      'Voice Studio speaks through the browser/OS speech engine and reports each voice’s localService flag. There is no model downloader, no cloned-voice engine and no hosted speech provider, so those paths stay blocked with an explicit reason. Speech recognition is not offered because Chromium’s recogniser is network-backed. Singing is unsupported.',
    requirements: [
      'A configured local TTS/cloning host for cloning (none ships)',
      'Pinned Qwen2.5-Omni runtime + licence review before any install',
      'Consent records and reference-audio handling on the host',
    ],
    evidence: () => {
      const voice = getState().settings.voice || {};
      const synth = typeof globalThis !== 'undefined' ? globalThis.speechSynthesis : null;
      const voices = typeof synth?.getVoices === 'function' ? synth.getVoices() : [];
      const local = voices.filter((entry) => entry.localService === true).length;
      return synth
        ? `${voices.length} device voice(s) · ${local} on-device · model ${voice.modelId || 'browser-speech'} · auto-speak ${voice.autoSpeak ? 'on' : 'off'}`
        : 'no speechSynthesis in this environment';
    },
    dynamic() {
      const voice = getState().settings.voice || {};
      const synth = typeof globalThis !== 'undefined' ? globalThis.speechSynthesis : null;
      const voices = typeof synth?.getVoices === 'function' ? synth.getVoices() : [];
      if (!synth) {
        return {
          status: 'blocked',
          summary: 'This environment exposes no speech engine, so nothing can be spoken.',
          detail: 'speechSynthesis is missing (headless browser, unsupported browser or a locked-down webview). Voice Studio still shows the catalogue and its blockers.',
          requirements: ['A browser/OS speech engine, or a configured local TTS host'],
          evidence: 'speechSynthesis unavailable',
        };
      }
      if (!voices.length) {
        return {
          status: 'unconfigured',
          summary: 'The speech engine exists but reports no installed voices yet.',
          detail: 'Voices usually appear after the first interaction or a voiceschanged event. Open Voice Studio and press Play once, then re-measure.',
          requirements: ['At least one system voice'],
          evidence: '0 voices reported',
        };
      }
      const local = voices.filter((entry) => entry.localService === true).length;
      return {
        status: 'available',
        summary: `Text-to-speech works through the device engine (${voices.length} voice${voices.length === 1 ? '' : 's'}${local ? `, ${local} on-device` : ''}).`,
        detail:
          'Playback is real and sentence-level; word-level streaming is not claimed. Voice cloning needs a configured local engine plus consent, and Qwen2.5-Omni is catalogue-only. No cloud speech provider exists, so a failure cannot silently upload audio.',
        requirements: local === voices.length ? [] : ['Some voices may use the network; on-device voices stay local'],
        evidence: `${voices.length} voices · ${local} on-device · model ${voice.modelId || 'browser-speech'}`,
      };
    },
  },
  channels: {
    id: 'channels',
    label: 'Communication gateway',
    status: 'unverified',
    summary: 'Gateway adapters exist; live external providers have not been verified here.',
    detail:
      'Gateway Comms implements encrypted channel settings and outbound requests for Telegram, WhatsApp, Discord, Slack and Twilio, plus signature-gated inbound routes. Mock tests are not live delivery evidence. OpenSMS, sender identity mapping and operation-bound approvals remain missing.',
    requirements: ['Provider credentials and authorised live tests', 'Identity mapping, complete rate limits, delivery receipts and approval governance'],
    evidence: () => 'see apps/gateway/src/comms.js and scripts/comms-gateway-test.mjs',
  },
  opensms: {
    id: 'opensms',
    label: 'OpenSMS (Android SMS)',
    status: 'unconfigured',
    summary: 'Not implemented. Needs a dedicated server-side adapter and a verified device topology.',
    detail:
      'OpenSMS is a separate Apache-2.0 Android app; its Python classes and Android permissions cannot be inherited by browser code. Only a thin adapter over its authenticated HTTP API is sound. An API key must never reach client JavaScript, and HTTPS→plain-HTTP LAN calls are unreliable, so a server-side proxy is a prerequisite. No remote start/stop will be offered: the inspected /control/ route is unauthenticated and does not actually control the server.',
    requirements: [
      'Server-side secret store and proxy (no key in browser JS)',
      'Verified topology (same device / LAN / hosted) and HTTPS story',
      'Recipient preview, approval policy, rate limits, audit',
      'On-device test of missing permissions, stopped server, bad key',
    ],
    evidence: () => 'no base URL configured, no secret reference, no connector code',
  },
  browser: {
    id: 'browser',
    label: 'Browser control',
    status: 'blocked',
    summary: 'No adapter reviewed or enabled; authorised automation only.',
    detail:
      'Two candidate projects must pass licence, activity, security, mobile and testability review before integration behind a feature flag. “Stealth” is never authorisation to defeat anti-bot, auth, paywall or access controls.',
    requirements: ['Candidate review + licence/security assessment', 'Adapter + feature flag + safe-failure tests'],
    evidence: () => 'no browser-control module in repo',
  },
  llm: {
    id: 'llm',
    label: 'LLM answer generation',
    status: 'unverified',
    summary: 'No model is called. Answers are deterministic retrieval + live app state.',
    detail:
      'The model catalogue, routing policies and agent model ids are demo data. There is no provider client, no key handling and no streaming. Copilot must not be described as an LLM in this build.',
    requirements: ['Provider client + key vault', 'Model discovery/health/limits', 'Tool-calling intent router'],
    evidence: () => 'no fetch to a provider anywhere in src/',
  },
};

export function getCapability(id) {
  const cap = CAPS[id];
  if (!cap) return null;
  let evidence = '';
  let dynamic = null;
  try {
    evidence = cap.evidence ? cap.evidence() : '';
    dynamic = cap.dynamic ? cap.dynamic() : null;
  } catch {
    evidence = evidence || '';
    dynamic = null;
  }
  const { dynamic: _dyn, ...base } = cap;
  return { ...base, ...(dynamic || {}), evidence: dynamic?.evidence || evidence };
}

export function capabilityList() {
  return Object.keys(CAPS).map(getCapability);
}

/** Modes whose primary capability is not usable yet. */
export const BLOCKED_MODES = {
  training: 'training',
  voice: 'voice',
};

export const STATUS_LABEL = {
  available: 'available',
  demo: 'demo',
  blocked: 'blocked',
  unconfigured: 'not configured',
  unverified: 'unverified',
};

export const STATUS_TONE = {
  available: 'ok',
  demo: 'info',
  blocked: 'bad',
  unconfigured: 'warn',
  unverified: 'warn',
};
