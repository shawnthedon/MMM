/* ============ Agent Designer ============
 * The guided agent-creation module (spec: "Agent Creation Module — Design Specification v1.0").
 *
 * What this module really does:
 *   • goal → proposed configuration (locally, deterministic, no model call), visual component map,
 *     inspector, compatibility + availability validation, summary rail, and a real agent *definition*
 *     written to the gateway (or the demo store) with status `idle`.
 *
 * What it deliberately does NOT do:
 *   • start, run or "activate" an agent. There is no runtime adapter, no provider client, no memory
 *     backend, no tool executor and no scheduler in this repository. Every such dependency is
 *     reported as Blocked / Needs setup / Unavailable with the reason, and the activation action
 *     explains the blockers instead of pretending to work.
 *
 * States follow the spec §8.2: ready · setup · warning · blocked · unavailable · unchecked.
 * Compatibility and live availability are shown separately (§8.2): a model can be compatible with a
 * draft while no credentials exist.
 */
import { getState, setState, esc, icon, uid, now, logEvent } from './core.js';
import { openSheet, toast, confirmModal, on, closeAllSheets } from './shell.js';
import { isApiMode, gatewayUrl } from './api.js';
import { can, isAuthenticated, getAuth } from './auth.js';
import { isLive, createAgent } from './datastore.js';
import { views } from './views1.js';
import './designer.css';
import { setDesignerSummary } from './designerSummary.js';

const DRAFT_KEY = 'mmm.agentDraft.v1';

/* =========================================================================================
 * Catalogues — everything here is read from the app's own data, never invented.
 * =======================================================================================*/
export const RUNTIMES = [
  { id: 'LangGraph', label: 'LangGraph', streaming: 'unknown', note: 'Graph runtime for stateful agents.' },
  { id: 'CrewAI', label: 'CrewAI', streaming: 'unknown', note: 'Role-based multi-agent crews.' },
  { id: 'OpenAI Swarm', label: 'OpenAI Swarm', streaming: 'unknown', note: 'Lightweight hand-off orchestration.' },
  { id: 'Swarmzero', label: 'Swarmzero', streaming: 'unknown', note: 'Agent/swarm SDK with tool plugins.' },
  { id: 'AutoPentest', label: 'AutoPentest', streaming: 'unknown', note: 'Security-testing agent loop.' },
  { id: 'A.I.M.A', label: 'A.I.M.A', streaming: 'unknown', note: 'Modular agent runtime.' },
  { id: 'Project Nautilus', label: 'Project Nautilus', streaming: 'unknown', note: 'Research-agent scaffold.' },
];

/** Model options come from the providers already in the app's catalogue. */
export function modelOptions() {
  const providers = getState().providers || [];
  const out = [];
  providers.forEach((p) => {
    (p.models || []).forEach((m) => {
      out.push({
        id: `${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/${String(m).toLowerCase().replace(/[^a-z0-9.]+/g, '-')}`,
        provider: p.name,
        model: m,
        providerStatus: p.status === 'on' ? 'on' : 'off',
        auth: p.auth,
      });
    });
  });
  if (!out.length) out.push({ id: 'anthropic/claude-sonnet-4', provider: 'Anthropic', model: 'Claude Sonnet 4', providerStatus: 'on', auth: 'API key' });
  return out;
}

export const GOAL_TEMPLATES = [
  {
    id: 'research',
    label: 'Deep research',
    icon: 'search',
    goal: 'Research a question across several sources and produce a cited briefing with a source list.',
    role: 'Research agent',
    framework: 'LangGraph',
    preset: 'guided',
    skills: ['firecrawl.deep-research', 'core.citations'],
    plugins: ['pl-fc'],
    assumptions: ['Multi-source research needs web retrieval (Firecrawl).', 'Citations are formatted by core.citations.', 'No schedule: it runs when asked.'],
  },
  {
    id: 'ops',
    label: 'Ops monitor',
    icon: 'chart',
    goal: 'Watch deployment logs and open an incident summary when something looks wrong.',
    role: 'Site reliability agent',
    framework: 'CrewAI',
    preset: 'bounded',
    skills: ['sre.triage'],
    plugins: ['pl-vl'],
    assumptions: ['Reads Vercel logs only.', 'Summaries are written; no deployments are triggered.', 'Monitoring is a proposed capability — no watcher exists yet.'],
  },
  {
    id: 'coding',
    label: 'Coding helper',
    icon: 'terminal',
    goal: 'Implement small changes with tests and open a pull request for review.',
    role: 'Implementation agent',
    framework: 'CrewAI',
    preset: 'guided',
    skills: ['dev.tdd-loop'],
    plugins: ['pl-gh'],
    assumptions: ['Needs GitHub repo + pull-request scopes.', 'Every write is gated behind an approval.', 'No code execution sandbox exists.'],
  },
  {
    id: 'content',
    label: 'Content repurposing',
    icon: 'doc',
    goal: 'Turn a long document into a thread and a newsletter draft in the house style.',
    role: 'Content agent',
    framework: 'LangGraph',
    preset: 'respond',
    skills: ['content.repurpose', 'core.citations'],
    plugins: [],
    assumptions: ['content.repurpose is still a pending skill proposal.', 'Airtable writes are not included.'],
  },
  {
    id: 'assistant',
    label: 'Personal assistant',
    icon: 'chat',
    goal: 'Answer questions about my saved files and keep track of what I asked before.',
    role: 'Assistant',
    framework: 'LangGraph',
    preset: 'guided',
    skills: ['core.citations'],
    plugins: [],
    assumptions: ['Knowledge is limited to files already in this workspace.', 'Persistent memory has no backend yet, so it will be flagged.'],
  },
  {
    id: 'intake',
    label: 'Intake forms',
    icon: 'board',
    goal: 'Collect structured requests through a short form and summarise them into tasks.',
    role: 'Intake agent',
    framework: 'OpenAI Swarm',
    preset: 'respond',
    skills: [],
    plugins: [],
    interaction: ['text', 'forms'],
    assumptions: ['Structured forms are a client-side flow, not a connector.', 'Task creation needs a gateway session to persist.'],
  },
];

/* =========================================================================================
 * Component map
 * =======================================================================================*/
export const NODES = [
  { id: 'runtime', label: 'Runtime & framework', icon: 'cpu', required: true, purpose: 'Which framework executes the agent.', needs: [] },
  { id: 'model', label: 'AI brain', icon: 'model', required: true, purpose: 'Provider, model and the fallback route.', needs: ['runtime'] },
  { id: 'behaviour', label: 'Behaviour & autonomy', icon: 'robot', required: true, purpose: 'How much it does on its own, and its limits.', needs: ['runtime', 'model'] },
  { id: 'memory', label: 'Memory', icon: 'skill', required: false, purpose: 'What it remembers, and for how long.', needs: ['model'] },
  { id: 'interaction', label: 'Interaction', icon: 'chat', required: false, purpose: 'How people reach it, and through which channels.', needs: ['model'] },
  { id: 'tools', label: 'Tools & connectors', icon: 'plug', required: false, purpose: 'What it may call, and under which scopes.', needs: ['runtime', 'behaviour'] },
  { id: 'knowledge', label: 'Knowledge', icon: 'doc', required: false, purpose: 'Source material it may retrieve from.', needs: ['model'] },
  { id: 'permissions', label: 'Permissions & gates', icon: 'shield', required: true, purpose: 'Scopes it holds, and which actions need approval.', needs: ['tools'] },
  { id: 'storage', label: 'Storage & artifacts', icon: 'folder', required: false, purpose: 'Where outputs are written and how long they stay.', needs: ['runtime'] },
];

export const STATE_LABEL = {
  ready: 'Ready',
  setup: 'Needs setup',
  warning: 'Warning',
  blocked: 'Blocked',
  unavailable: 'Unavailable',
  unchecked: 'Not checked',
};
const stateClass = (s) => (s === 'ready' ? 'ok' : s === 'setup' || s === 'warning' ? 'warn' : s === 'blocked' || s === 'unavailable' ? 'bad' : '');
const stateChip = (s) => `<span class="chip tiny ${stateClass(s)}">${STATE_LABEL[s] || esc(s)}</span>`;

/* Interactions that cannot work in this build, blocked at selection time (spec §7.5). */
export const BLOCKED_INTERACTIONS = {
  'voice-in': 'No microphone capture, speech-to-text service or audio pipeline in this repository.',
  'voice-out': 'No speech synthesis service is wired.',
  'image-in': 'No vision-capable model client exists, and no model here declares image support.',
  'image-out': 'No image-generation client is wired.',
  'channel-external': 'Telegram is a UI simulation; no bot transport exists.',
};

export const PRESETS = [
  { id: 'respond', label: 'Respond only', detail: 'Acts only when you ask.', autonomy: 1 },
  { id: 'guided', label: 'Guided', detail: 'Plans and proposes; you approve configured actions.', autonomy: 2 },
  { id: 'bounded', label: 'Bounded autonomy', detail: 'May run explicitly permitted low-risk actions within limits.', autonomy: 3 },
  { id: 'scheduled', label: 'Scheduled / proactive', detail: 'Starts work on a schedule or event.', autonomy: 4, blocked: 'No scheduler or trigger service exists, so nothing could start it.' },
];

const MEMORY_LAYERS = [
  { id: 'conversation', label: 'Conversation / task', detail: 'Keeps context to continue a thread. Stored in this browser.' },
  { id: 'persistent', label: 'Agent memory (facts)', detail: 'Facts retained between runs.', requires: 'a memory backend' },
  { id: 'knowledge', label: 'Searchable knowledge', detail: 'Indexed source material retrieved on demand.', requires: 'an ingestion + index pipeline' },
  { id: 'artifacts', label: 'Files & artifacts', detail: 'Original documents and generated outputs.', requires: 'an artifact write route' },
];

/* =========================================================================================
 * Draft
 * =======================================================================================*/
let draft = null;
let saveTimer = null;
let session = { step: 0, node: 'runtime', savedAt: null, savedLabel: 'draft' };

export function newDraft() {
  return {
    v: 1,
    id: uid('ad'),
    createdAt: now(),
    name: '',
    role: '',
    goal: '',
    template: null,
    assumptions: [],
    framework: 'LangGraph',
    model: 'anthropic/claude-sonnet-4',
    fallback: 'openai/gpt-5',
    preset: 'guided',
    autonomy: 2,
    limits: { steps: 12, minutes: 15, cost: 2 },
    enabled: { memory: true, interaction: true, tools: true, knowledge: false, storage: true },
    memory: { layers: ['conversation'], retention: '180d', scope: 'agent' },
    interaction: ['text'],
    skills: ['core.citations'],
    plugins: [],
    gates: true,
    gateExpiry: '30d',
    knowledge: [],
    storage: 'artifacts',
    storageRetention: '90d',
    validatedAt: null,
  };
}

export function getDraft() {
  ensureDraft();
  return draft;
}

function emit() {
  publishSummary();
}

function ensureDraft() {
  if (draft) return draft;
  try {
    const raw = globalThis.localStorage?.getItem(DRAFT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.v === 1) draft = { ...newDraft(), ...parsed, enabled: { ...newDraft().enabled, ...(parsed.enabled || {}) } };
    }
  } catch {
    /* corrupt draft → start fresh */
  }
  if (!draft) draft = newDraft();
  return draft;
}

function persistDraft() {
  clearTimeout(saveTimer);
  session.savedLabel = 'saving…';
  saveTimer = setTimeout(() => {
    try {
      globalThis.localStorage?.setItem(DRAFT_KEY, JSON.stringify(draft));
      session.savedAt = now();
      session.savedLabel = 'saved';
    } catch {
      session.savedLabel = 'not saved (storage blocked)';
    }
    paintSaveState();
  }, 250);
}

function paintSaveState() {
  const el = document.getElementById('dsn-save-state');
  if (el) el.textContent = session.savedLabel;
}

/** Mutate the draft, persist it and notify subscribers. */
export function patchDraft(patch, { repaint = true } = {}) {
  ensureDraft();
  const next = typeof patch === 'function' ? patch(draft) : patch;
  draft = { ...draft, ...(next || {}) };
  draft.validatedAt = null;
  persistDraft();
  emit();
  if (repaint) repaintDesigner();
  return draft;
}

export function resetDraft() {
  draft = newDraft();
  session = { ...session, step: 0, node: 'runtime', savedAt: null, savedLabel: 'draft' };
  clearTimeout(saveTimer);
  try {
    globalThis.localStorage?.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
  emit();
}

/** Publish a one-line mirror for Copilot / describeScreen (no cycle, no async). */
function publishSummary() {
  if (!draft) return;
  const check = validateDraft(draft);
  setDesignerSummary({
    started: Boolean(draft.goal || draft.name),
    name: draft.name || '',
    framework: draft.framework || '',
    model: draft.model || '',
    step: session.step,
    definition: check.definition.state,
    activation: check.activation.state,
    canSave: check.canSave,
  });
}

function repaintDesigner() {
  const host = document.querySelector('[data-designer]');
  if (!host) return;
  import('./main.js').then((m) => m.rerender()).catch(() => {});
}

/* =========================================================================================
 * Status derivation (compatibility vs availability)
 * =======================================================================================*/
const findModel = (id) => modelOptions().find((m) => m.id === id) || null;

export function derivedScopes(d) {
  const s = getState();
  const scopes = new Map();
  (d.skills || []).forEach((name) => {
    const skill = (s.skills || []).find((x) => x.name === name);
    (skill?.perms || []).forEach((p) => scopes.set(p, `skill ${name}`));
  });
  (d.plugins || []).forEach((id) => {
    const plugin = (s.plugins || []).find((x) => x.id === id);
    (plugin?.scopes || []).forEach((p) => scopes.set(p, `connector ${plugin.name}`));
  });
  return [...scopes.entries()].map(([scope, from]) => ({ scope, from }));
}

const WRITE_SCOPE = /(write|pr\.|deploy|exec|crud|manage|migrate|records|import|update|delete)/i;

export function writeScopes(d) {
  return derivedScopes(d).filter((x) => WRITE_SCOPE.test(x.scope));
}

export function nodeState(d, id) {
  ensureDraft();
  const model = findModel(d.model);
  const fallback = findModel(d.fallback);
  switch (id) {
    case 'runtime': {
      const rt = RUNTIMES.find((r) => r.id === d.framework);
      return {
        compat: d.framework && rt ? 'ready' : 'blocked',
        connection: 'unavailable',
        why: d.framework
          ? `${d.framework} is recorded on the definition, but no adapter for any framework ships in this repository — nothing can execute it.`
          : 'No framework selected.',
        facts: [`Framework: ${d.framework || '—'}`, 'Adapter: not installed', 'Streaming/cancellation: not declared'],
      };
    }
    case 'model': {
      const conn = !model ? 'blocked' : model.providerStatus !== 'on' ? 'unavailable' : 'setup';
      return {
        compat: model ? (fallback && fallback.id === model.id ? 'warning' : 'unchecked') : 'blocked',
        connection: conn,
        why: !model
          ? 'No model selected.'
          : model.providerStatus !== 'on'
            ? `${model.provider} is switched off in the catalogue.`
            : `Compatible on paper, but no ${model.provider} credentials exist in this build (the gateway has no provider route).`,
        facts: [
          `Primary: ${d.model || '—'}`,
          `Fallback: ${d.fallback || 'none'}`,
          'Capability metadata (vision/audio/tools): not declared for any catalogue model',
        ],
      };
    }
    case 'behaviour': {
      const preset = PRESETS.find((p) => p.id === d.preset);
      const cap = getState().settings?.autonomyLevel ?? 2;
      const over = d.autonomy > cap;
      return {
        compat: preset?.blocked ? 'blocked' : over ? 'warning' : 'ready',
        connection: 'setup',
        why: preset?.blocked
          ? preset.blocked
          : over
            ? `Autonomy L${d.autonomy} is above the workspace cap (L${cap}). Instructions alone are not a boundary, and nothing here enforces the cap server-side.`
            : `${preset?.label || d.preset}: limits are recorded on the definition; no runtime enforces them.`,
        facts: [
          `Preset: ${preset?.label || d.preset}`,
          `Autonomy: L${d.autonomy} (behavioural intent — it does not grant code-writing authority)`,
          `Limits: ${d.limits.steps} steps · ${d.limits.minutes} min · $${Number(d.limits.cost).toFixed(2)}`,
          'Self-modification: separate authority — a new agent starts at L1 recommend until an Owner sets its policy on Self-Improvement',
        ],
      };
    }
    case 'memory': {
      const layers = d.memory.layers || [];
      const unmet = MEMORY_LAYERS.filter((l) => layers.includes(l.id) && l.requires);
      return {
        compat: unmet.length ? 'unchecked' : 'ready',
        connection: unmet.length ? 'unavailable' : 'ready',
        why: unmet.length
          ? `${unmet.map((l) => l.label).join(', ')} require ${unmet.map((l) => l.requires).join(' and ')} — none exists in this build.`
          : 'Conversation memory only: threads live in this browser and are not persisted by the gateway.',
        facts: [`Layers: ${layers.join(', ') || 'none'}`, `Scope: ${d.memory.scope}`, `Retention: ${d.memory.retention}`],
      };
    }
    case 'interaction': {
      const blocked = (d.interaction || []).filter((c) => BLOCKED_INTERACTIONS[c]);
      return {
        compat: blocked.length ? 'blocked' : 'ready',
        connection: 'setup',
        why: blocked.length
          ? blocked.map((c) => `${c}: ${BLOCKED_INTERACTIONS[c]}`).join(' ')
          : 'Text replies need a runtime and a model, which are not available — the capability is defined, not live.',
        facts: [`Capabilities: ${(d.interaction || []).join(', ') || 'none'}`, 'Channel: in-app only'],
      };
    }
    case 'tools': {
      const s = getState();
      const missing = (d.plugins || []).filter((id) => !(s.plugins || []).find((p) => p.id === id)?.installed);
      return {
        compat: missing.length ? 'setup' : 'ready',
        connection: 'unavailable',
        why: missing.length
          ? `${missing.length} connector(s) are not installed, so their tools cannot be granted.`
          : 'Tools are recorded on the definition; there is no tool executor or credential store here, so no call can be made.',
        facts: [
          `Skills: ${(d.skills || []).length}`,
          `Connectors: ${(d.plugins || []).length}`,
          `Scopes: ${derivedScopes(d).length}`,
        ],
      };
    }
    case 'knowledge': {
      const files = (d.knowledge || []);
      return {
        compat: files.length ? 'unchecked' : 'ready',
        connection: files.length ? 'setup' : 'ready',
        why: files.length
          ? 'Selected sources are file metadata only: nothing indexes or retrieves them, so the agent cannot cite content it cannot read.'
          : 'No sources selected. Knowledge is optional.',
        facts: [`Sources: ${files.length}`, 'Indexing: none', 'Retrieval: none'],
      };
    }
    case 'permissions': {
      const writes = writeScopes(d);
      return {
        compat: !d.gates && writes.length ? 'blocked' : 'ready',
        connection: isApiMode() && isAuthenticated() ? 'ready' : 'setup',
        why: !d.gates && writes.length
          ? `${writes.length} write/execute scope(s) would be granted with approval gates switched off.`
          : writes.length
            ? `${writes.length} scope(s) need an approval gate. Gates are requested through the gateway's approvals API; no connector enforces them yet.`
            : 'Read-only configuration: no write scopes were derived from the selected skills and connectors.',
        facts: [`Scopes: ${derivedScopes(d).length}`, `Gated: ${d.gates ? 'yes' : 'no'}`, `Expiry: ${d.gateExpiry}`],
      };
    }
    case 'storage': {
      return {
        compat: d.storage === 'none' ? 'ready' : 'ready',
        connection: d.storage === 'none' ? 'ready' : 'setup',
        why: d.storage === 'none'
          ? 'No outputs are written.'
          : 'Artifacts are metadata in this build: the gateway has a files table but no write route.',
        facts: [`Destination: ${d.storage}`, `Retention: ${d.storageRetention}`],
      };
    }
    default:
      return { compat: 'unchecked', connection: 'unchecked', why: 'Unknown component.', facts: [] };
  }
}

export function activeNodes(d) {
  ensureDraft();
  return NODES.filter((n) => n.required || d.enabled?.[n.id]).map((n) => n.id);
}

export function missingDependencies(d, id) {
  const node = NODES.find((n) => n.id === id);
  if (!node) return [];
  return node.needs.filter((dep) => !activeNodes(d).includes(dep));
}

/* =========================================================================================
 * Validation (spec §8)
 * =======================================================================================*/
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,40}$/;

export function validateDraft(d = getDraft()) {
  const s = getState();
  const findings = [];
  const add = (f) => findings.push(f);

  /* ---- definition: what this app can actually store ---- */
  if (!String(d.goal || '').trim()) {
    add({ id: 'def-goal', scope: 'definition', severity: 'error', component: 'runtime', title: 'No goal', detail: 'Say what the agent is for — the goal drives every proposed component.', fix: { act: 'dsn-step', step: 0, label: 'Set the goal' } });
  }
  if (!NAME_RE.test(String(d.name || '').trim())) {
    add({ id: 'def-name', scope: 'definition', severity: 'error', component: 'runtime', title: 'Name is missing or invalid', detail: 'Use 2–41 characters: letters, digits, space, dot, dash or underscore, starting with a letter or digit.', fix: { act: 'dsn-step', step: 0, label: 'Fix the name' } });
  } else if ((s.agents || []).some((a) => a.name.toLowerCase() === d.name.trim().toLowerCase())) {
    add({ id: 'def-name-dup', scope: 'definition', severity: 'error', component: 'runtime', title: 'Name already exists', detail: `An agent called “${d.name.trim()}” is already in ${isLive('agents') ? 'the gateway' : 'this workspace'}.`, fix: { act: 'dsn-step', step: 0, label: 'Rename' } });
  }
  if (!d.framework) {
    add({ id: 'def-runtime', scope: 'definition', severity: 'error', component: 'runtime', title: 'No runtime selected', detail: 'Choose the framework the definition should record.', fix: { act: 'dsn-select', node: 'runtime', label: 'Choose runtime' } });
  } else {
    add({ id: 'def-runtime-adapter', scope: 'definition', severity: 'warning', component: 'runtime', title: `${d.framework} adapter is not installed`, detail: 'The definition records the framework, but no adapter for any framework is implemented here. Selecting one does not make it available.', fix: { act: 'dsn-select', node: 'runtime', label: 'Review runtime' } });
  }
  const model = findModel(d.model);
  if (!model) {
    add({ id: 'def-model', scope: 'definition', severity: 'error', component: 'model', title: 'No model selected', detail: 'Pick a primary model from the catalogue.', fix: { act: 'dsn-select', node: 'model', label: 'Choose model' } });
  } else {
    if (model.providerStatus !== 'on') {
      add({ id: 'def-model-off', scope: 'definition', severity: 'warning', component: 'model', title: `${model.provider} is switched off`, detail: 'The provider is disabled in the catalogue, so this route cannot be used even once credentials exist.', fix: { act: 'dsn-select', node: 'model', label: 'Change provider' } });
    }
    if (!d.fallback) {
      add({ id: 'def-fallback-missing', scope: 'definition', severity: 'setup', component: 'model', title: 'No fallback route', detail: 'Fallback is required by the spec so a rate limit or outage does not fail the run outright.', fix: { act: 'dsn-select', node: 'model', label: 'Set fallback' } });
    } else if (d.fallback === d.model) {
      add({ id: 'def-fallback-same', scope: 'definition', severity: 'warning', component: 'model', title: 'Fallback equals the primary', detail: 'A fallback identical to the primary adds nothing.', fix: { act: 'dsn-select', node: 'model', label: 'Pick another fallback' } });
    }
    add({ id: 'def-model-meta', scope: 'definition', severity: 'info', component: 'model', title: 'Model capabilities are not declared', detail: 'No catalogue model publishes context limits, tool-calling or modality support, so capability compatibility is “not checked” rather than assumed.' });
  }
  const preset = PRESETS.find((p) => p.id === d.preset);
  if (preset?.blocked) {
    add({ id: 'def-proactive', scope: 'definition', severity: 'error', component: 'behaviour', title: `${preset.label} cannot work here`, detail: preset.blocked, fix: { act: 'dsn-select', node: 'behaviour', label: 'Change preset' } });
  }
  const cap = s.settings?.autonomyLevel ?? 2;
  if (d.autonomy > cap) {
    add({ id: 'def-autonomy', scope: 'definition', severity: 'warning', component: 'behaviour', title: `Autonomy L${d.autonomy} exceeds the workspace cap (L${cap})`, detail: 'The cap is a workspace setting; no server-side policy enforces it, so this is a design warning rather than a hard block.', fix: { act: 'dsn-select', node: 'behaviour', label: 'Lower autonomy' } });
  }
  const blockedInteraction = (d.interaction || []).filter((c) => BLOCKED_INTERACTIONS[c]);
  blockedInteraction.forEach((c) => {
    add({ id: `def-cap-${c}`, scope: 'definition', severity: 'error', component: 'interaction', title: `${c} is blocked`, detail: BLOCKED_INTERACTIONS[c], fix: { act: 'dsn-select', node: 'interaction', label: 'Remove capability' } });
  });
  const uninstalled = (d.plugins || []).filter((id) => !(s.plugins || []).find((p) => p.id === id)?.installed);
  if (uninstalled.length) {
    add({ id: 'def-connector-setup', scope: 'definition', severity: 'setup', component: 'tools', title: 'Connector not installed', detail: `${uninstalled.length} selected connector(s) are not installed, so their scopes cannot be granted.`, fix: { act: 'dsn-select', node: 'tools', label: 'Review connectors' } });
  }
  const writes = writeScopes(d);
  if (!d.gates && writes.length) {
    add({ id: 'def-gates', scope: 'definition', severity: 'error', component: 'permissions', title: 'Write scopes without an approval gate', detail: `${writes.map((w) => w.scope).join(', ')} would be granted ungated. The designer refuses to save that.`, fix: { act: 'dsn-select', node: 'permissions', label: 'Enable gates' } });
  }
  add({ id: 'def-budget', scope: 'definition', severity: 'warning', component: 'behaviour', title: 'Budget limits are advisory', detail: 'Step/time/cost limits are stored on the definition and shown in the UI; the gateway has no budget fields, so nothing stops a run from exceeding them.', fix: { act: 'dsn-select', node: 'behaviour', label: 'Review limits' } });
  if ((d.knowledge || []).length) {
    add({ id: 'def-knowledge', scope: 'definition', severity: 'setup', component: 'knowledge', title: 'Selected sources are not indexed', detail: 'Nothing ingests, chunks or retrieves these files, so the agent could not cite them.', fix: { act: 'dsn-select', node: 'knowledge', label: 'Review sources' } });
  }

  /* ---- activation: what running it would require ---- */
  add({ id: 'act-runtime', scope: 'activation', severity: 'error', component: 'runtime', title: 'No runtime adapter', detail: 'Executing an agent needs a framework adapter, a process to host it and cancellation/streaming support. None exists in this repository, so activation is impossible.', fix: { act: 'dsn-explain-activation', label: 'Why?' } });
  add({ id: 'act-credentials', scope: 'activation', severity: 'setup', component: 'model', title: 'No provider credentials', detail: `The gateway exposes no provider or secret route, and this browser holds no keys. Requests to ${gatewayUrl() || 'no gateway'} cannot be authorised.`, fix: { act: 'dsn-select', node: 'model', label: 'Review model' } });
  if ((d.memory.layers || []).some((l) => l !== 'conversation')) {
    add({ id: 'act-memory', scope: 'activation', severity: 'error', component: 'memory', title: 'No memory backend', detail: 'Persistent agent memory and searchable knowledge need a store and an index. The spec leaves the first memory backend as an open decision; neither exists here.', fix: { act: 'dsn-select', node: 'memory', label: 'Reduce memory' } });
  }
  if ((d.interaction || []).some((c) => c !== 'text' && c !== 'forms')) {
    add({ id: 'act-media', scope: 'activation', severity: 'error', component: 'interaction', title: 'No media services', detail: 'Voice and image capabilities need capture, transcription/synthesis or vision services that are not wired.', fix: { act: 'dsn-select', node: 'interaction', label: 'Review capabilities' } });
  }
  if ((d.skills || []).length || (d.plugins || []).length) {
    add({ id: 'act-tools', scope: 'activation', severity: 'setup', component: 'tools', title: 'No tool execution path', detail: 'Skills and connectors are catalogue metadata: there is no executor, no credential store, and no server route that would perform a call or honour a gate.', fix: { act: 'dsn-select', node: 'tools', label: 'Review tools' } });
  }
  if ((d.knowledge || []).length) {
    add({ id: 'act-knowledge', scope: 'activation', severity: 'setup', component: 'knowledge', title: 'No retrieval path', detail: 'Retrieval would need an embeddings model, a vector store and citations-in-prompt. None is present.', fix: { act: 'dsn-select', node: 'knowledge', label: 'Review sources' } });
  }
  if (d.storage !== 'none') {
    add({ id: 'act-storage', scope: 'activation', severity: 'setup', component: 'storage', title: 'No artifact write route', detail: 'The gateway has a files table but no route to write or read artifacts, so outputs could not be stored.', fix: { act: 'dsn-select', node: 'storage', label: 'Review storage' } });
  }
  if (!isApiMode()) {
    add({ id: 'act-demo', scope: 'activation', severity: 'info', component: 'runtime', title: 'Demo mode', detail: 'The definition will be saved to this browser only. Configure a gateway and sign in to store it server-side.', fix: { act: 'nav', to: 'login', label: 'Open Account' } });
  } else if (!isAuthenticated()) {
    add({ id: 'act-anon', scope: 'activation', severity: 'setup', component: 'runtime', title: 'Not signed in', detail: 'A gateway is configured but there is no session, so the definition cannot be saved server-side.', fix: { act: 'nav', to: 'login', label: 'Sign in' } });
  } else if (!isLive('agents')) {
    add({ id: 'act-noagents', scope: 'activation', severity: 'setup', component: 'runtime', title: 'Gateway is not serving agents', detail: 'The agent list could not be loaded, so saving would create a row the gateway does not have. The designer refuses that.', fix: { act: 'data-refresh', label: 'Retry sync' } });
  } else if (!can('agent:write')) {
    add({ id: 'act-role', scope: 'activation', severity: 'error', component: 'runtime', title: `Role ${getAuth().principal?.role || ''} cannot write agents`, detail: 'The gateway enforces agent:write server-side. Ask an Owner or Admin for a higher role.', fix: { act: 'nav', to: 'login', label: 'Account' } });
  }
  add({ id: 'act-run', scope: 'activation', severity: 'error', component: 'behaviour', title: 'No execution runtime', detail: 'Even with a saved definition there is no process that could start it. “Activate” is therefore unavailable; the designer saves an idle definition instead.' });

  const aggregate = (list) => {
    if (list.some((f) => f.severity === 'error')) return 'blocked';
    if (list.some((f) => f.severity === 'setup')) return 'setup';
    if (list.some((f) => f.severity === 'warning')) return 'warning';
    if (list.length && list.every((f) => f.severity === 'info')) return 'ready';
    return list.length ? 'warning' : 'ready';
  };
  const definition = findings.filter((f) => f.scope === 'definition');
  const activation = findings.filter((f) => f.scope === 'activation');
  return {
    findings,
    definition: { state: aggregate(definition), findings: definition, errors: definition.filter((f) => f.severity === 'error').length },
    activation: { state: aggregate(activation), findings: activation, errors: activation.filter((f) => f.severity === 'error').length },
    canSave: !definition.some((f) => f.severity === 'error'),
    canActivate: false,
  };
}

/* =========================================================================================
 * Record building + save
 * =======================================================================================*/
export function toAgentRecord(d = getDraft()) {
  const role = (d.role || '').trim() || `Agent for: ${String(d.goal || '').trim().slice(0, 80)}`;
  const preset = PRESETS.find((p) => p.id === d.preset);
  const prompt = [
    `You are ${d.name.trim()}.`,
    String(d.goal || '').trim(),
    `Behaviour preset: ${preset?.label || d.preset} (autonomy L${d.autonomy}).`,
    `Limits: ${d.limits.steps} steps / ${d.limits.minutes} min / $${Number(d.limits.cost).toFixed(2)} (advisory).`,
    'Never assume a tool succeeded: report failures exactly as they happened.',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    name: d.name.trim(),
    role: role.slice(0, 120),
    framework: d.framework,
    model: d.model,
    fallback: d.fallback,
    status: 'idle',
    trust: 50,
    autonomy: d.autonomy,
    successRate: 0,
    costToday: 0,
    runs: 0,
    lastActive: now(),
    tools: (d.plugins || []).flatMap((id) => (getState().plugins || []).find((p) => p.id === id)?.tools || []).slice(0, 24),
    skills: [...(d.skills || [])],
    prompt,
    memory: {
      episodic: 0,
      semantic: 0,
      kb: '0 MB',
      designer: {
        layers: d.memory.layers,
        retention: d.memory.retention,
        scopes: derivedScopes(d).map((x) => x.scope),
        gates: Boolean(d.gates),
      },
    },
  };
}

export async function saveDefinition() {
  ensureDraft();
  const check = validateDraft(draft);
  if (!check.canSave) {
    toast('Definition has blocking errors — open Validate to see them', 'bad');
    return { ok: false, reason: 'invalid', check };
  }
  const record = toAgentRecord(draft);
  try {
    if (isApiMode()) {
      if (!isAuthenticated()) throw new Error('Sign in to save a definition on the gateway.');
      if (!can('agent:write')) throw new Error(`Your role lacks agent:write.`);
      if (!isLive('agents')) throw new Error('The gateway is not serving agents right now, so nothing was saved.');
      const row = await createAgent(record);
      finishSave(row.id);
      /* The gateway creates the agent's self-modification policy at level 1. Saying so here avoids
       * the reader assuming the behaviour preset above also authorises code changes. */
      toast('Saved. Self-modification policy starts at L1 (recommend) — an Owner can raise it on Self-Improvement.', 'ok');
      return { ok: true, id: row.id, mode: 'gateway' };
    }
    const id = uid('ag');
    setState((s) => {
      s.agents.unshift({ ...record, id });
      logEvent('agent', `Agent ${record.name} created in the Agent Designer (demo)`);
    }, 'designer-agent');
    finishSave(id);
    return { ok: true, id, mode: 'demo' };
  } catch (err) {
    toast(`Not saved: ${esc(err.message)}`, 'bad');
    return { ok: false, reason: 'error', error: err.message };
  }
}

function finishSave(id) {
  try {
    globalThis.localStorage?.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
  draft = newDraft();
  session = { ...session, step: 0, node: 'runtime', savedLabel: 'draft saved to workspace' };
  emit();
  import('./main.js').then((m) => m.navigate(`agents/${id}`)).catch(() => {});
}

/* =========================================================================================
 * Rendering
 * =======================================================================================*/
const STEPS = ['Goal', 'Components', 'Configure', 'Validate', 'Activate'];

function headerHTML() {
  const check = validateDraft(draft);
  const label = check.definition.state === 'blocked' ? 'Blocking errors' : check.definition.state === 'ready' ? 'Definition valid' : STATE_LABEL[check.definition.state];
  return `
    <div class="page-head row between">
      <div>
        <h1>Agent Designer</h1>
        <div class="sub">${draft.name ? esc(draft.name) : 'Untitled draft'} · <span id="dsn-save-state">${esc(session.savedLabel)}</span></div>
      </div>
      <div class="row" style="gap:6px">
        ${stateChip(check.definition.state)}
        <button class="iconbtn" data-act="dsn-discard" aria-label="Discard draft">${icon('trash', 18)}</button>
      </div>
    </div>
    <nav class="dsn-steps" aria-label="Designer steps">
      ${STEPS.map((label2, i) => `
        <button class="dsn-step ${session.step === i ? 'on' : ''}" data-act="dsn-step" data-step="${i}"
                ${session.step === i ? 'aria-current="step"' : ''} aria-label="Step ${i + 1}: ${label2}">
          <span class="n" aria-hidden="true">${i + 1}</span><span class="t">${label2}</span>
        </button>`).join('')}
    </nav>`;
}

function goalStep() {
  const check = validateDraft(draft);
  return `
    <div class="card">
      <div class="field" style="margin-top:0">
        <label for="dsn-goal">What should your agent do?</label>
        <textarea class="input" id="dsn-goal" data-dsn="goal" rows="3" placeholder="e.g. Read our deployment logs every morning and post a short risk summary.">${esc(draft.goal)}</textarea>
      </div>
      <div class="grid-2">
        <div class="field"><label for="dsn-name">Name</label><input class="input" id="dsn-name" data-dsn="name" value="${esc(draft.name)}" placeholder="e.g. Morning-Risk-Bot" autocomplete="off"></div>
        <div class="field"><label for="dsn-role">Role (optional)</label><input class="input" id="dsn-role" data-dsn="role" value="${esc(draft.role)}" placeholder="What is this agent's job?" autocomplete="off"></div>
      </div>
      ${check.findings.filter((f) => ['def-goal', 'def-name', 'def-name-dup'].includes(f.id)).map((f) => `<div class="dsn-fix tiny">${icon('shield', 13)} ${esc(f.detail)}</div>`).join('')}
    </div>

    <div class="section-title">Start from a template</div>
    <div class="col" style="gap:8px">
      ${GOAL_TEMPLATES.map((t) => `
        <button class="list-card" data-act="dsn-template" data-id="${t.id}" style="width:100%;text-align:left">
          <div class="avatar" style="background:var(--elevated);color:var(--brand)">${icon(t.icon, 18)}</div>
          <div class="grow">
            <div class="strong small">${esc(t.label)}</div>
            <div class="tiny muted">${esc(t.goal)}</div>
          </div>
          ${icon('right', 16)}
        </button>`).join('')}
    </div>

    <button class="btn block primary" style="margin-top:12px" data-act="dsn-propose">${icon('spark', 16)} Propose a configuration from my goal</button>
    <p class="tiny muted" style="margin-top:8px">
      The proposal is a deterministic keyword match on this device — no model is called. Every inferred choice is
      listed as an assumption and stays editable.
    </p>`;
}

function mapHTML() {
  const nodes = activeNodes(draft);
  return `
    <div class="section-title" style="margin-top:0">Composition</div>
    <div class="dsn-map" role="list">
      ${NODES.filter((n) => nodes.includes(n.id)).map((n, i) => {
        const st = nodeState(draft, n.id);
        const gaps = missingDependencies(draft, n.id);
        return `
          <div class="dsn-node ${session.node === n.id ? 'sel' : ''}" role="listitem">
            <button class="dsn-node-main" data-act="dsn-select" data-node="${n.id}" aria-label="Configure ${esc(n.label)}">
              <div class="dsn-ico">${icon(n.icon, 17)}</div>
              <div class="grow">
                <div class="row" style="gap:6px"><span class="strong small">${esc(n.label)}</span>${n.required ? '<span class="chip tiny">required</span>' : ''}</div>
                <div class="tiny muted">${esc(n.purpose)}</div>
                <div class="row wrap" style="gap:4px;margin-top:5px">
                  <span class="chip tiny" title="Compatibility for this draft">compat: ${STATE_LABEL[st.compat]}</span>
                  ${stateChip(st.connection)}
                </div>
                ${gaps.length ? `<div class="tiny" style="color:var(--warning);margin-top:4px">Needs ${gaps.join(', ')}</div>` : ''}
              </div>
              ${icon('right', 15)}
            </button>
            ${!n.required ? `<button class="iconbtn sm" data-act="dsn-remove" data-node="${n.id}" aria-label="Remove ${esc(n.label)}">${icon('x', 15)}</button>` : ''}
          </div>
          ${i < NODES.filter((x) => nodes.includes(x.id)).length - 1 ? '<div class="dsn-edge" aria-hidden="true"></div>' : ''}`;
      }).join('')}
    </div>

    <div class="section-title">Add a component</div>
    <div class="row wrap" style="gap:8px">
      ${NODES.filter((n) => !n.required && !nodes.includes(n.id)).map((n) => `
        <button class="chip" data-act="dsn-add" data-node="${n.id}">${icon(n.icon, 13)} ${esc(n.label)}</button>`).join('') || '<span class="tiny muted">All optional components are in the map.</span>'}
    </div>
    <p class="tiny muted" style="margin-top:8px">
      Lines show real dependencies: a component with a missing dependency is flagged, not silently allowed.
    </p>`;
}

function runtimeInspector() {
  return `
    <div class="field"><label for="dsn-framework">Framework / runtime</label>
      <select class="input" id="dsn-framework" data-dsn="framework">
        ${RUNTIMES.map((r) => `<option value="${esc(r.id)}" ${draft.framework === r.id ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}
      </select>
    </div>
    <div class="dsn-note">${icon('shield', 14)}
      <div>No framework adapter is implemented in this repository. The definition records your choice; the runtime
      itself is reported as <strong>Unavailable</strong> everywhere it matters.</div>
    </div>
    <div class="card" style="margin-top:10px">
      ${RUNTIMES.map((r) => `<div class="kv"><span class="k">${esc(r.label)}</span><span class="row" style="gap:6px"><span class="chip tiny bad">adapter not installed</span></span></div>`).join('')}
    </div>`;
}

function modelInspector() {
  const models = modelOptions();
  const primary = findModel(draft.model);
  return `
    <div class="field"><label for="dsn-model">Primary model</label>
      <select class="input" id="dsn-model" data-dsn="model">
        ${models.map((m) => `<option value="${esc(m.id)}" ${draft.model === m.id ? 'selected' : ''}>${esc(`${m.provider} · ${m.model}${m.providerStatus === 'on' ? '' : ' (provider off)'}`)}</option>`).join('')}
      </select>
    </div>
    <div class="field"><label for="dsn-fallback">Fallback model</label>
      <select class="input" id="dsn-fallback" data-dsn="fallback">
        ${models.map((m) => `<option value="${esc(m.id)}" ${draft.fallback === m.id ? 'selected' : ''}>${esc(`${m.provider} · ${m.model}`)}</option>`).join('')}
      </select>
    </div>
    <div class="dsn-note">${icon('shield', 14)}
      <div>${primary ? `No credentials exist for ${esc(primary.provider)}: there is no provider client and no secret store, in this browser or on the gateway.` : 'Choose a model.'}
      Capability metadata (tools, vision, audio, context window) is not declared for any catalogue model, so compatibility stays <strong>Not checked</strong>.</div>
    </div>`;
}

function behaviourInspector() {
  const cap = getState().settings?.autonomyLevel ?? 2;
  return `
    <div class="field"><label for="dsn-preset">Behaviour preset</label>
      <select class="input" id="dsn-preset" data-dsn="preset">
        ${PRESETS.map((p) => `<option value="${esc(p.id)}" ${draft.preset === p.id ? 'selected' : ''} ${p.blocked ? 'disabled' : ''}>${esc(p.label)}${p.blocked ? ' — unavailable' : ''}</option>`).join('')}
      </select>
    </div>
    ${PRESETS.filter((p) => p.blocked).map((p) => `<div class="dsn-fix tiny">${icon('shield', 13)} ${esc(p.label)}: ${esc(p.blocked)}</div>`).join('')}
    <div class="field"><label for="dsn-autonomy">Autonomy level</label>
      <select class="input" id="dsn-autonomy" data-dsn="autonomy">
        ${[0, 1, 2, 3, 4].map((l) => `<option value="${l}" ${draft.autonomy === l ? 'selected' : ''}>L${l} — ${['ask always', 'respond only', 'guided', 'bounded', 'full auto'][l]}${l > cap ? ' (above workspace cap)' : ''}</option>`).join('')}
      </select>
    </div>
    <div class="grid-3">
      <div class="field"><label for="dsn-steps">Max steps</label><input class="input" id="dsn-steps" type="number" min="1" max="100" data-dsn="limits.steps" value="${draft.limits.steps}"></div>
      <div class="field"><label for="dsn-minutes">Max minutes</label><input class="input" id="dsn-minutes" type="number" min="1" max="240" data-dsn="limits.minutes" value="${draft.limits.minutes}"></div>
      <div class="field"><label for="dsn-cost">Max $ / run</label><input class="input" id="dsn-cost" type="number" min="0" step="0.5" data-dsn="limits.cost" value="${draft.limits.cost}"></div>
    </div>
    <div class="dsn-note">${icon('shield', 14)}<div>Instructions and limits are stored on the definition. Nothing enforces them at run time, so they are shown as advisory.</div></div>`;
}

function memoryInspector() {
  return `
    <div class="col" style="gap:8px">
      ${MEMORY_LAYERS.map((l) => {
        const on = (draft.memory.layers || []).includes(l.id);
        return `
          <label class="dsn-check ${l.requires ? 'limited' : ''}">
            <input type="checkbox" data-dsn="memory.layer" data-value="${l.id}" ${on ? 'checked' : ''}>
            <span class="grow">
              <span class="strong small">${esc(l.label)}</span>
              <span class="tiny muted">${esc(l.detail)}</span>
              ${l.requires ? `<span class="tiny" style="color:var(--warning)">Needs ${esc(l.requires)} — not available here</span>` : ''}
            </span>
          </label>`;
      }).join('')}
    </div>
    <div class="grid-2" style="margin-top:10px">
      <div class="field"><label for="dsn-mem-scope">Scope</label>
        <select class="input" id="dsn-mem-scope" data-dsn="memory.scope">
          ${['turn', 'run', 'agent', 'workspace'].map((x) => `<option value="${x}" ${draft.memory.scope === x ? 'selected' : ''}>${x}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label for="dsn-mem-ret">Retention</label>
        <select class="input" id="dsn-mem-ret" data-dsn="memory.retention">
          ${['7d', '30d', '90d', '180d', 'forever'].map((x) => `<option value="${x}" ${draft.memory.retention === x ? 'selected' : ''}>${x}</option>`).join('')}
        </select>
      </div>
    </div>`;
}

function interactionInspector() {
  const options = [
    { id: 'text', label: 'Text chat', detail: 'Replies in the in-app chat.', ok: true },
    { id: 'forms', label: 'Structured forms', detail: 'A short client-side form flow.', ok: true },
    { id: 'voice-in', label: 'Voice input', detail: 'Microphone capture + transcription.' },
    { id: 'voice-out', label: 'Voice output', detail: 'Speech synthesis.' },
    { id: 'image-in', label: 'Image input', detail: 'Vision model + upload pipeline.' },
    { id: 'image-out', label: 'Image generation', detail: 'Image model client.' },
  ];
  return `
    <div class="col" style="gap:8px">
      ${options.map((o) => {
        const on = (draft.interaction || []).includes(o.id);
        const reason = BLOCKED_INTERACTIONS[o.id];
        return `
          <label class="dsn-check ${reason ? 'limited' : ''}">
            <input type="checkbox" data-dsn="interaction" data-value="${o.id}" ${on ? 'checked' : ''} ${reason ? 'disabled' : ''}>
            <span class="grow">
              <span class="strong small">${esc(o.label)} ${reason ? '<span class="chip tiny bad">blocked</span>' : ''}</span>
              <span class="tiny muted">${esc(o.detail)}</span>
              ${reason ? `<span class="tiny" style="color:var(--warning)">${esc(reason)}</span>` : ''}
            </span>
          </label>`;
      }).join('')}
    </div>
    <div class="dsn-note" style="margin-top:10px">${icon('chat', 14)}<div>Channels: in-app only. The Telegram screen is a simulation — no bot transport exists, so it is not offered.</div></div>`;
}

function toolsInspector() {
  const s = getState();
  return `
    <div class="section-title" style="margin-top:0">Skills</div>
    <div class="col" style="gap:6px">
      ${(s.skills || []).map((sk) => {
        const on = (draft.skills || []).includes(sk.name);
        return `
          <label class="dsn-check">
            <input type="checkbox" data-dsn="skill" data-value="${esc(sk.name)}" ${on ? 'checked' : ''}>
            <span class="grow">
              <span class="strong small">${esc(sk.name)} <span class="chip tiny">${esc(sk.status)}</span></span>
              <span class="tiny muted">${esc(sk.desc)}${sk.perms.length ? ` · scopes: ${esc(sk.perms.join(', '))}` : ''}</span>
            </span>
          </label>`;
      }).join('')}
    </div>
    <div class="section-title">Connectors</div>
    <div class="col" style="gap:6px">
      ${(s.plugins || []).map((p) => {
        const on = (draft.plugins || []).includes(p.id);
        return `
          <label class="dsn-check">
            <input type="checkbox" data-dsn="plugin" data-value="${esc(p.id)}" ${on ? 'checked' : ''}>
            <span class="grow">
              <span class="strong small">${esc(p.name)} <span class="chip tiny ${p.installed ? 'ok' : 'warn'}">${p.installed ? 'installed' : 'not installed'}</span></span>
              <span class="tiny muted">${esc(p.scopes.join(', '))} · ${p.tools.length} tools</span>
            </span>
          </label>`;
      }).join('')}
    </div>
    <div class="dsn-note" style="margin-top:10px">${icon('plug', 14)}<div>No tool executor or credential store exists: these grants are recorded in the definition and in the summary, but no call can be performed.</div></div>`;
}

function knowledgeInspector() {
  const files = getState().files || [];
  return `
    <div class="col" style="gap:6px">
      ${files.map((f) => {
        const on = (draft.knowledge || []).includes(f.id);
        return `
          <label class="dsn-check">
            <input type="checkbox" data-dsn="knowledge" data-value="${esc(f.id)}" ${on ? 'checked' : ''}>
            <span class="grow">
              <span class="strong small">${esc(f.path)}</span>
              <span class="tiny muted">${esc(f.type)} · ${(f.size / 1024).toFixed(0)} KB · ${esc(f.createdBy)} <span class="chip tiny warn">not indexed</span></span>
            </span>
          </label>`;
      }).join('') || '<div class="empty">No files in this workspace.</div>'}
    </div>
    <div class="dsn-note" style="margin-top:10px">${icon('doc', 14)}<div>Selecting a file grants read intent only. Nothing indexes or retrieves it, and file content is treated as untrusted data — never as instructions.</div></div>`;
}

function permissionsInspector() {
  const scopes = derivedScopes(draft);
  return `
    <div class="card">
      <div class="kv"><span class="k">Derived scopes</span><span class="strong">${scopes.length}</span></div>
      ${scopes.map((x) => `<div class="kv"><span class="k">${esc(x.scope)}</span><span class="tiny muted">from ${esc(x.from)}${WRITE_SCOPE.test(x.scope) ? ' · needs a gate' : ' · read'}</span></div>`).join('') || '<div class="tiny muted">No scopes: the selected skills and connectors declare none.</div>'}
    </div>
    <label class="dsn-check" style="margin-top:10px">
      <input type="checkbox" data-dsn="gates" ${draft.gates ? 'checked' : ''}>
      <span class="grow"><span class="strong small">Require an approval gate for write/execute scopes</span>
      <span class="tiny muted">Gates are raised through the gateway approvals API (separation of duties applies).</span></span>
    </label>
    <div class="field" style="margin-top:10px"><label for="dsn-expiry">Gate expiry</label>
      <select class="input" id="dsn-expiry" data-dsn="gateExpiry">
        ${['24h', '7d', '30d', 'never'].map((x) => `<option value="${x}" ${draft.gateExpiry === x ? 'selected' : ''}>${x}</option>`).join('')}
      </select>
    </div>
    <div class="dsn-note">${icon('shield', 14)}<div>An agent cannot grant itself scopes here: the list is derived from the catalogue and the designer refuses to save ungated writes.</div></div>`;
}

function storageInspector() {
  return `
    <div class="field"><label for="dsn-storage">Destination</label>
      <select class="input" id="dsn-storage" data-dsn="storage">
        <option value="artifacts" ${draft.storage === 'artifacts' ? 'selected' : ''}>Workspace artifacts</option>
        <option value="none" ${draft.storage === 'none' ? 'selected' : ''}>Do not store outputs</option>
      </select>
    </div>
    <div class="field"><label for="dsn-storage-ret">Retention</label>
      <select class="input" id="dsn-storage-ret" data-dsn="storageRetention">
        ${['7d', '30d', '90d', '180d'].map((x) => `<option value="${x}" ${draft.storageRetention === x ? 'selected' : ''}>${x}</option>`).join('')}
      </select>
    </div>
    <div class="dsn-note">${icon('folder', 14)}<div>The gateway has a <code>files</code> table but no artifact route, so nothing can be written yet. Fixture files are metadata only.</div></div>`;
}

function inspectorHTML() {
  const node = NODES.find((n) => n.id === session.node) || NODES[0];
  const st = nodeState(draft, node.id);
  const body = {
    runtime: runtimeInspector,
    model: modelInspector,
    behaviour: behaviourInspector,
    memory: memoryInspector,
    interaction: interactionInspector,
    tools: toolsInspector,
    knowledge: knowledgeInspector,
    permissions: permissionsInspector,
    storage: storageInspector,
  }[node.id]();
  return `
    <div class="section-title" style="margin-top:0">${icon(node.icon, 14)} ${esc(node.label)}</div>
    <div class="card">
      <div class="row wrap" style="gap:6px;margin-bottom:8px">
        <span class="chip tiny">compat: ${STATE_LABEL[st.compat]}</span>
        ${stateChip(st.connection)}
      </div>
      <div class="tiny" style="margin-bottom:10px">${esc(st.why)}</div>
      ${body}
      <div class="divider"></div>
      ${(st.facts || []).map((f) => `<div class="tiny muted" style="margin-top:2px">${esc(f)}</div>`).join('')}
    </div>
    <div class="row" style="gap:8px;margin-top:12px">
      <button class="btn grow" data-act="dsn-step" data-step="1">${icon('left', 14)} Composition</button>
      <button class="btn grow primary" data-act="dsn-step" data-step="3">Validate ${icon('right', 14)}</button>
    </div>`;
}

function validateStep() {
  const check = validateDraft(draft);
  const group = (title, result, note) => `
    <div class="section-title row between">${title} ${stateChip(result.state)}</div>
    <div class="card">
      <div class="tiny muted" style="margin-bottom:8px">${note}</div>
      ${result.findings.length ? result.findings.map((f) => `
        <div class="dsn-finding">
          <div class="row between" style="gap:8px">
            <span class="strong small">${esc(f.title)}</span>
            <span class="chip tiny ${f.severity === 'error' ? 'bad' : f.severity === 'setup' || f.severity === 'warning' ? 'warn' : ''}">${esc(f.severity)}</span>
          </div>
          <div class="tiny muted" style="margin-top:3px">${esc(f.detail)}</div>
          ${f.fix ? `<button class="btn sm" style="margin-top:6px" data-act="${esc(f.fix.act)}" ${f.fix.node ? `data-node="${esc(f.fix.node)}"` : ''} ${f.fix.step !== undefined ? `data-step="${f.fix.step}"` : ''} ${f.fix.to ? `data-to="${esc(f.fix.to)}"` : ''}>${esc(f.fix.label || 'Fix')}</button>` : ''}
        </div>`).join('') : '<div class="tiny muted">No findings.</div>'}
    </div>`;
  return `
    <div class="dsn-verdict-wrap">
      <div class="dsn-verdict ${check.canSave ? 'ok' : 'bad'}">
        <div class="strong">${check.canSave ? 'Definition can be saved' : 'Definition has blocking errors'}</div>
        <div class="tiny">${check.definition.errors} blocking · ${check.activation.errors} activation blockers</div>
      </div>
    </div>
    ${group('Definition checks', check.definition, 'What this app can actually store in the agent record.')}
    ${group('Activation checks', check.activation, 'What running the agent would additionally require. These do not prevent saving a definition, and they do prevent activation.')}
    <div class="row" style="gap:8px;margin-top:12px">
      <button class="btn grow" data-act="dsn-step" data-step="1">Back</button>
      <button class="btn grow primary" data-act="dsn-step" data-step="4">Summary ${icon('right', 14)}</button>
    </div>`;
}

function activateStep() {
  const check = validateDraft(draft);
  const scopes = derivedScopes(draft);
  const caps = (draft.interaction || []).map((c) => ({ id: c, blocked: Boolean(BLOCKED_INTERACTIONS[c]) }));
  return `
    <div class="section-title" style="margin-top:0">Summary</div>
    <div class="card">
      <div class="kv"><span class="k">Name</span><span class="strong">${esc(draft.name || '—')}</span></div>
      <div class="kv"><span class="k">Goal</span><span class="strong" style="text-align:right">${esc(String(draft.goal || '—').slice(0, 90))}</span></div>
      <div class="kv"><span class="k">Runtime</span><span class="strong">${esc(draft.framework)}</span></div>
      <div class="kv"><span class="k">Model</span><span class="strong">${esc(draft.model)}</span></div>
      <div class="kv"><span class="k">Fallback</span><span class="strong">${esc(draft.fallback || 'none')}</span></div>
      <div class="kv"><span class="k">Behaviour</span><span class="strong">${esc(PRESETS.find((p) => p.id === draft.preset)?.label || draft.preset)} · L${draft.autonomy}</span></div>
      <div class="kv"><span class="k">Memory</span><span class="strong">${esc((draft.memory.layers || []).join(', ') || 'none')}</span></div>
      <div class="kv"><span class="k">Storage</span><span class="strong">${esc(draft.storage)} · ${esc(draft.storageRetention)}</span></div>
    </div>

    <div class="section-title">Capabilities</div>
    <div class="card">
      <div class="row wrap" style="gap:6px">
        ${caps.map((c) => `<span class="chip tiny ${c.blocked ? 'bad' : 'warn'}">${esc(c.id)}${c.blocked ? ' · blocked' : ' · defined'}</span>`).join('') || '<span class="tiny muted">No interaction capability selected.</span>'}
      </div>
      <div class="tiny muted" style="margin-top:8px">Defined ≠ live. Nothing can answer a message until a runtime and credentials exist.</div>
    </div>

    <div class="section-title">Permissions</div>
    <div class="card">
      ${scopes.map((x) => `<div class="kv"><span class="k">${esc(x.scope)}</span><span class="tiny muted">${esc(x.from)}</span></div>`).join('') || '<div class="tiny muted">None derived.</div>'}
      <div class="kv"><span class="k">Approval gates</span><span class="strong">${draft.gates ? `on · ${esc(draft.gateExpiry)}` : 'off'}</span></div>
      <div class="kv"><span class="k">Budget / limits</span><span class="strong">${draft.limits.steps} steps · ${draft.limits.minutes} min · $${Number(draft.limits.cost).toFixed(2)}</span></div>
    </div>

    <div class="section-title row between">Readiness ${stateChip(check.definition.state)}</div>
    <div class="card">
      <div class="kv"><span class="k">Save definition</span><span class="strong">${check.canSave ? 'possible' : 'blocked'}</span></div>
      <div class="kv"><span class="k">Activate &amp; run</span><span class="strong" style="color:var(--warning)">unavailable</span></div>
      <div class="tiny muted" style="margin-top:8px">
        Saving writes an <strong>idle</strong> definition ${isApiMode() && isLive('agents') ? `to ${esc(gatewayUrl())}` : 'to this browser'}. It does not start anything.
      </div>
    </div>

    <div class="row" style="gap:10px;margin-top:14px">
      <button class="btn grow" data-act="dsn-explain-activation">Why can't it run?</button>
      <button class="btn grow primary" data-act="dsn-save" ${check.canSave ? '' : 'disabled'}>${icon('check', 15)} Save definition</button>
    </div>
    <p class="tiny muted" style="margin-top:8px">Saved agents appear in Agents with status <code>idle</code>, and the change is recorded on the gateway when you are signed in.</p>`;
}

function bodyHTML() {
  switch (session.step) {
    case 0: return goalStep();
    case 1: return mapHTML();
    case 2: return inspectorHTML();
    case 3: return validateStep();
    default: return activateStep();
  }
}

views.designer = {
  title: 'Agent Designer',
  render() {
    ensureDraft();
    return `<div data-designer>${headerHTML()}${bodyHTML()}</div>`;
  },
};

/* =========================================================================================
 * Actions
 * =======================================================================================*/
/** Open the designer, optionally seeded from the New-agent wizard. */
export function openDesigner({ seed, step } = {}) {
  ensureDraft();
  if (seed) {
    const assumptions = [];
    if (seed.name) assumptions.push(`Name taken from the New-agent flow: ${seed.name}.`);
    if (seed.role) assumptions.push(`Role from the New-agent flow: ${seed.role}.`);
    patchDraft(
      {
        name: seed.name || draft.name,
        role: seed.role || draft.role,
        goal: draft.goal || seed.role || '',
        framework: seed.framework || draft.framework,
        model: seed.model || draft.model,
        autonomy: typeof seed.autonomy === 'number' ? seed.autonomy : draft.autonomy,
        skills: seed.skills?.length ? seed.skills : draft.skills,
        assumptions: [...new Set([...(draft.assumptions || []), ...assumptions])],
      },
      { repaint: false }
    );
  }
  session.step = typeof step === 'number' ? step : draft.goal ? 1 : 0;
  session.node = session.node || 'runtime';
  import('./main.js').then((m) => m.navigate('designer')).catch(() => {});
  return draft;
}

function applyTemplate(id) {
  const t = GOAL_TEMPLATES.find((x) => x.id === id);
  if (!t) return;
  const s = getState();
  // Keep only skills/connectors that the catalogue really contains.
  const skills = (t.skills || []).filter((name) => (s.skills || []).some((x) => x.name === name));
  const plugins = (t.plugins || []).filter((pid) => (s.plugins || []).some((x) => x.id === pid));
  const dropped = (t.skills || []).filter((name) => !skills.includes(name)).concat((t.plugins || []).filter((pid) => !plugins.includes(pid)));
  patchDraft(
    {
      template: t.id,
      goal: t.goal,
      role: t.role,
      name: draft.name || suggestName(t),
      framework: t.framework || draft.framework,
      preset: t.preset || draft.preset,
      autonomy: PRESETS.find((p) => p.id === (t.preset || draft.preset))?.autonomy ?? draft.autonomy,
      skills,
      plugins,
      interaction: t.interaction || ['text'],
      enabled: { ...draft.enabled, tools: Boolean(skills.length || plugins.length), interaction: true },
      assumptions: [...t.assumptions, ...(dropped.length ? [`Dropped from the template because they are not in the catalogue: ${dropped.join(', ')}.`] : [])],
    },
    { repaint: false }
  );
  session.step = 1;
  toast(`Template applied · ${t.label}`, 'ok');
  repaintDesigner();
}

function suggestName(t) {
  const base = t.label.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const taken = new Set((getState().agents || []).map((a) => a.name.toLowerCase()));
  let candidate = `${base}-01`;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) candidate = `${base}-${String(n++).padStart(2, '0')}`;
  return candidate;
}

/* Goal → configuration heuristic. Deterministic, local, documented as an assumption. */
const KEYWORDS = [
  { test: /research|source|cite|citation|brief/i, patch: { framework: 'LangGraph', preset: 'guided', skills: ['firecrawl.deep-research', 'core.citations'], plugins: ['pl-fc'] }, why: '“research/sources” → web retrieval (Firecrawl) + citation skill.' },
  { test: /log|monitor|incident|alert|deploy|uptime|sre/i, patch: { framework: 'CrewAI', preset: 'bounded', skills: ['sre.triage'], plugins: ['pl-vl'] }, why: '“monitor/logs” → Vercel log scope + triage skill, bounded autonomy.' },
  { test: /code|pull request|pr|test|refactor|bug/i, patch: { framework: 'CrewAI', preset: 'guided', skills: ['dev.tdd-loop'], plugins: ['pl-gh'] }, why: '“code/PR” → GitHub connector + TDD skill, every write gated.' },
  { test: /content|thread|newsletter|copy|blog/i, patch: { framework: 'LangGraph', preset: 'respond', skills: ['content.repurpose'], plugins: [] }, why: '“content” → repurposing skill, no connectors.' },
  { test: /form|intake|request|ticket/i, patch: { framework: 'OpenAI Swarm', preset: 'respond', skills: [], plugins: [], interaction: ['text', 'forms'] }, why: '“form/intake” → structured form flow.' },
  { test: /file|document|knowledge|remember|notes/i, patch: { framework: 'LangGraph', preset: 'guided', skills: ['core.citations'], plugins: [] }, why: '“files/knowledge” → citation skill; indexing is unavailable.' },
];

export function proposeFromGoal(goal = draft.goal) {
  const text = String(goal || '');
  const matched = KEYWORDS.filter((k) => k.test.test(text));
  const chosen = matched[0];
  const s = getState();
  const patch = {
    goal: text,
    template: null,
    assumptions: [
      'Proposed locally from your wording — no model call was made.',
      ...(chosen ? [chosen.why] : ['No keyword matched, so the conservative defaults were kept: guided behaviour, one skill, no connectors.']),
      'Model and framework are proposals: neither is installed, so both are recorded only.',
    ],
    ...(chosen?.patch || {}),
  };
  if (chosen?.patch?.skills) patch.skills = chosen.patch.skills.filter((n) => (s.skills || []).some((x) => x.name === n));
  if (chosen?.patch?.plugins) patch.plugins = chosen.patch.plugins.filter((pid) => (s.plugins || []).some((x) => x.id === pid));
  if (chosen?.patch?.interaction) patch.interaction = chosen.patch.interaction;
  if (!draft.name) patch.name = suggestName({ label: 'Draft-Agent' });
  if (chosen) patch.autonomy = PRESETS.find((p) => p.id === chosen.patch.preset)?.autonomy ?? draft.autonomy;
  patch.enabled = { ...draft.enabled, tools: Boolean((patch.skills || draft.skills).length || (patch.plugins || draft.plugins).length) };
  patchDraft(patch, { repaint: false });
  session.step = 1;
  repaintDesigner();
  return patch;
}

function explainActivation() {
  const check = validateDraft(draft);
  const act = check.activation.findings;
  openSheet({
    title: 'Why activation is unavailable',
    body: `
      <div class="dsn-note">${icon('shield', 14)}<div>Saving a definition is real. Starting the agent is not possible in this
      build: the repository has no runtime, no provider client, no memory backend and no tool executor. Nothing below is a
      temporary UI glitch.</div></div>
      <div class="card" style="margin-top:10px">
        ${act.map((f) => `
          <div class="dsn-finding">
            <div class="row between"><span class="strong small">${esc(f.title)}</span>
            <span class="chip tiny ${f.severity === 'error' ? 'bad' : f.severity === 'setup' ? 'warn' : ''}">${esc(f.severity)}</span></div>
            <div class="tiny muted" style="margin-top:3px">${esc(f.detail)}</div>
          </div>`).join('')}
      </div>
      <p class="tiny muted" style="margin-top:10px">What would change this: framework adapters, a provider client with a secret
      store, a memory backend, a tool executor and a scheduler. Until then the designer produces idle definitions only.</p>`,
    foot: `<button class="btn grow primary" data-act="dsn-save" ${check.canSave ? '' : 'disabled'}>Save definition instead</button>`,
  });
}

function discardDraft() {
  confirmModal({
    title: 'Discard this draft?',
    body: 'The designer draft in this browser is deleted. Saved agents are not affected.',
    confirmText: 'Discard',
    danger: true,
    onConfirm: () => {
      resetDraft();
      toast('Draft discarded');
      repaintDesigner();
    },
  });
}

/* ---------- action registrations ---------- */
on('open-designer', (el, ds) => openDesigner({ step: ds.step !== undefined ? Number(ds.step) : undefined }));
on('dsn-step', (el, ds) => {
  const step = Number(ds.step);
  if (Number.isInteger(step) && step >= 0 && step < STEPS.length) {
    session.step = step;
    if (step === 3) draft.validatedAt = now();
    publishSummary();
    repaintDesigner();
  }
});
on('dsn-select', (el, ds) => {
  if (!ds.node) return;
  session.node = ds.node;
  session.step = 2;
  repaintDesigner();
});
on('dsn-add', (el, ds) => {
  if (!ds.node) return;
  patchDraft({ enabled: { ...draft.enabled, [ds.node]: true } }, { repaint: false });
  session.node = ds.node;
  session.step = 2;
  repaintDesigner();
});
on('dsn-remove', (el, ds) => {
  if (!ds.node) return;
  patchDraft({ enabled: { ...draft.enabled, [ds.node]: false } }, { repaint: false });
  if (session.node === ds.node) session.node = 'runtime';
  repaintDesigner();
});
on('dsn-template', (el, ds) => applyTemplate(ds.id));
on('dsn-propose', () => {
  const el = document.getElementById('dsn-goal');
  const goal = el?.value ?? draft.goal;
  if (!String(goal).trim()) {
    toast('Describe the goal first', 'bad');
    return;
  }
  proposeFromGoal(goal);
});
on('dsn-save', () => {
  saveDefinition().then((out) => {
    if (!out.ok) return;
    closeAllSheets();
    toast(out.mode === 'gateway' ? 'Definition saved on the gateway · status idle' : 'Definition saved in this browser · status idle', 'ok');
  });
});
on('dsn-explain-activation', () => explainActivation());
on('dsn-discard', () => discardDraft());

/* ---------- field bindings ---------- */
function setPath(obj, path, value) {
  const parts = path.split('.');
  let target = obj;
  parts.slice(0, -1).forEach((p) => {
    target[p] = target[p] && typeof target[p] === 'object' ? target[p] : {};
    target = target[p];
  });
  target[parts[parts.length - 1]] = value;
}

function onFieldInput(event) {
  const t = event.target.closest('[data-dsn]');
  if (!t || t.tagName === 'SELECT') return;
  const key = t.dataset.dsn;
  const next = { ...draft };
  if (key === 'memory.layer' || key === 'interaction' || key === 'skill' || key === 'plugin' || key === 'knowledge') return; // handled on change
  const value = t.type === 'number' ? Number(t.value) : t.value;
  if (key.includes('.')) setPath(next, key, value);
  else next[key] = value;
  draft = { ...next, validatedAt: null };
  persistDraft();
  emit();
}

function onFieldChange(event) {
  const t = event.target.closest('[data-dsn]');
  if (!t) return;
  const key = t.dataset.dsn;
  const value = t.dataset.value;
  const listToggle = (field, item) => {
    const list = new Set(draft[field] || []);
    if (list.has(item)) list.delete(item);
    else list.add(item);
    return [...list];
  };
  if (key === 'memory.layer') {
    const layers = new Set(draft.memory.layers || []);
    if (layers.has(value)) layers.delete(value);
    else layers.add(value);
    patchDraft({ memory: { ...draft.memory, layers: [...layers] } }, { repaint: false });
  } else if (key === 'interaction') {
    if (BLOCKED_INTERACTIONS[value]) {
      toast(`${value} cannot work in this build — nothing changed`, 'bad');
      repaintDesigner();
      return;
    }
    patchDraft({ interaction: listToggle('interaction', value) }, { repaint: false });
  } else if (key === 'skill') {
    patchDraft({ skills: listToggle('skills', value) }, { repaint: false });
  } else if (key === 'plugin') {
    patchDraft({ plugins: listToggle('plugins', value) }, { repaint: false });
  } else if (key === 'knowledge') {
    patchDraft({ knowledge: listToggle('knowledge', value) }, { repaint: false });
  } else if (key === 'gates') {
    patchDraft({ gates: Boolean(t.checked) }, { repaint: false });
  } else if (t.tagName === 'SELECT') {
    const next = { ...draft };
    const val = key === 'autonomy' || key.startsWith('limits.') ? Number(t.value) : t.value;
    if (key.includes('.')) setPath(next, key, val);
    else next[key] = val;
    patchDraft(next, { repaint: false });
  } else if (t.type === 'checkbox') {
    return;
  } else if (t.type === 'number') {
    patchDraft({}, { repaint: false }); // value already captured on input; recompute statuses
  } else {
    patchDraft({}, { repaint: false }); // name/goal/role: refresh header + validation state
  }
  session.savedLabel = 'edited';
  repaintDesigner();
}

if (typeof document !== 'undefined') {
  document.addEventListener('input', onFieldInput);
  document.addEventListener('change', onFieldChange);
}
