/* ============ The canonical agent draft ============
 * One shape, one validator, three callers: the Copilot (a model writes a draft from conversation), the
 * Agent Designer (a person edits it visually), and the gateway (it decides what a draft's state is and
 * whether activation may proceed).
 *
 * Why this file exists rather than two validators: the browser and the gateway disagreeing about whether
 * a draft is valid is indistinguishable, from the outside, from a bug — and a draft that the browser
 * calls "ready" while the server calls it "invalid" is exactly the sort of quiet dishonesty this
 * codebase keeps deleting. The rules therefore live in one place, in plain JavaScript with no imports,
 * so both sides can load it: `apps/gateway/src/agentDrafts.js` and `src/copilot/drafts.js`.
 *
 * What is deliberately NOT here: anything that activates. A draft is data. Creating an agent from it is
 * an act, and acts go through an approval gate in app code (`agentDrafts.activate`), never through this
 * module and never through a prompt.
 */

/** The state vocabulary, in the words the UI must use. Nothing outside this list may be shown. */
export const DRAFT_STATES = Object.freeze({
  draft: 'Draft',
  'needs-information': 'Needs information',
  'needs-setup': 'Needs setup',
  invalid: 'Invalid',
  blocked: 'Blocked',
  'ready-for-review': 'Ready for review',
  'awaiting-approval': 'Awaiting approval',
  active: 'Active',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  paused: 'Paused',
  archived: 'Archived',
});

/** States a *draft* can be in. Running/Completed/Failed/Paused are properties of a run, not of a draft
 *  definition — including them here would let the UI imply an agent is doing something. */
export const DRAFT_ONLY_STATES = Object.freeze([
  'draft', 'needs-information', 'needs-setup', 'invalid', 'blocked', 'ready-for-review',
  'awaiting-approval', 'active', 'archived',
]);

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,40}$/;
const ID_RE = /^[a-z0-9][a-z0-9._-]{1,60}$/i;

export const LIMITS = Object.freeze({
  name: 41,
  role: 120,
  description: 400,
  goal: 600,
  instruction: 4000,
  model: 120,
  skills: 12,
  plugins: 8,
  interaction: 6,
  responsibilities: 10,
  knowledge: 10,
});

export const FRAMEWORKS = Object.freeze(['LangGraph', 'CrewAI', 'AutoGen', 'OpenAI Assistants', 'Custom HTTP']);
export const INTERACTIONS = Object.freeze(['text', 'voice', 'files', 'widgets', 'email']);
export const AUTONOMY_RANGE = Object.freeze({ min: 1, max: 5 });

/** The fields a draft carries, with the default the gateway applies when the model omits one. */
export function emptySpec() {
  return {
    v: 1,
    name: '',
    role: '',
    description: '',
    goal: '',
    framework: 'LangGraph',
    model: '',
    fallback: '',
    autonomy: 2,
    preset: 'guided',
    limits: { steps: 12, minutes: 15, costUsd: 2 },
    gates: { enabled: true, expiry: '30d' },
    skills: [],
    plugins: [],
    interaction: ['text'],
    knowledge: [],
    responsibilities: [],
    teamId: null,
  };
}

const str = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const list = (value, max, cap) =>
  [...new Set((Array.isArray(value) ? value : []).map((x) => str(x, max)).filter(Boolean))].slice(0, cap);
const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
};

/**
 * Coerce anything (a model's JSON, a form, a stale row) into the canonical spec.
 * Unknown keys are dropped and reported — a draft field nobody stores must not survive a round trip,
 * because the next reader would assume it was saved.
 */
export function normaliseSpec(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const dropped = Object.keys(raw).filter((k) => !(k in emptySpec()));
  const spec = emptySpec();

  spec.name = str(raw.name, LIMITS.name);
  spec.role = str(raw.role, LIMITS.role);
  spec.description = str(raw.description, LIMITS.description);
  spec.goal = str(raw.goal, LIMITS.goal);
  if (FRAMEWORKS.includes(str(raw.framework, 40))) spec.framework = str(raw.framework, 40);
  spec.model = str(raw.model, LIMITS.model);
  spec.fallback = str(raw.fallback, LIMITS.model);
  spec.autonomy = clampInt(raw.autonomy, AUTONOMY_RANGE.min, AUTONOMY_RANGE.max, 2);
  spec.preset = ['guided', 'autonomous', 'review-first', 'assist'].includes(str(raw.preset, 24)) ? str(raw.preset, 24) : 'guided';
  spec.skills = list(raw.skills, 80, LIMITS.skills);
  spec.plugins = list(raw.plugins, 80, LIMITS.plugins);
  spec.interaction = list(raw.interaction, 20, LIMITS.interaction);
  if (!spec.interaction.length) spec.interaction = ['text'];
  spec.knowledge = list(raw.knowledge, 200, LIMITS.knowledge);
  spec.responsibilities = list(raw.responsibilities, 160, LIMITS.responsibilities);
  spec.teamId = typeof raw.teamId === 'string' && ID_RE.test(raw.teamId) ? raw.teamId : null;
  const limits = raw.limits && typeof raw.limits === 'object' ? raw.limits : {};
  spec.limits = {
    steps: clampInt(limits.steps, 1, 60, 12),
    minutes: clampInt(limits.minutes, 1, 240, 15),
    costUsd: Math.min(Math.max(Number(limits.costUsd) || 2, 0), 50),
  };
  const gates = raw.gates && typeof raw.gates === 'object' ? raw.gates : raw.gates === false ? { enabled: false } : {};
  spec.gates = {
    enabled: gates.enabled !== false,
    expiry: ['7d', '30d', '90d', 'never'].includes(str(gates.expiry, 10)) ? str(gates.expiry, 10) : '30d',
  };
  return { spec, dropped };
}

/**
 * Validate a canonical spec. Returns findings the UI can render verbatim and a state derived from them.
 *
 * `ctx` is everything the validator is not allowed to assume:
 *   agents      — existing agent names, for the duplicate check
 *   providers   — the gateway's provider catalogue (id, name, status, defaultModel)
 *   skills      — the catalogue of skills that exist
 *   plugins     — the catalogue of connectors, with `installed`
 *   runtimes    — the framework adapters this build actually implements (always empty; that is the point)
 */
export function validateSpec(specInput, ctx = {}) {
  const { spec } = normaliseSpec(specInput);
  const findings = [];
  const add = (severity, field, title, detail) => findings.push({ id: `draft-${field}-${findings.length}`, field, severity, title, detail });

  const agents = Array.isArray(ctx.agents) ? ctx.agents : [];
  const providers = Array.isArray(ctx.providers) ? ctx.providers : [];
  const skills = Array.isArray(ctx.skills) ? ctx.skills : [];
  const plugins = Array.isArray(ctx.plugins) ? ctx.plugins : [];
  const runtimes = Array.isArray(ctx.runtimes) ? ctx.runtimes : [];

  /* ---- definition: what the gateway can actually store ---- */
  if (!spec.name) add('info', 'name', 'No name yet', 'A name is the first thing the agent list needs. It can be anything you like — 2 to 41 characters.');
  else if (!NAME_RE.test(spec.name)) add('error', 'name', 'Name is not usable', 'Use 2–41 characters: letters, digits, space, dot, dash or underscore, starting with a letter or digit.');
  else if (agents.some((a) => String(a.name || '').toLowerCase() === spec.name.toLowerCase())) {
    add('error', 'name', 'Name already exists', `An agent called “${spec.name}” already exists on this gateway.`);
  }

  if (!spec.goal) add('info', 'goal', 'No goal yet', 'The goal is what the agent is for. Nothing else can be checked without it.');
  if (!spec.role) add('info', 'role', 'No role yet', 'A short role line (“triages inbound tickets”) is what the agent list shows.');

  if (!FRAMEWORKS.includes(spec.framework)) add('error', 'framework', 'Unknown framework', `This build records one of: ${FRAMEWORKS.join(', ')}.`);
  else if (!runtimes.includes(spec.framework)) {
    // Not an error: the definition is perfectly storable. It is the *run* that is impossible, and saying
    // so as a blocked-runtime finding keeps "ready for review" and "unable to run" from collapsing into
    // one another.
    add('blocked', 'framework', 'No runtime adapter', `Nothing in this repository can execute a ${spec.framework} agent. The definition can be stored; it cannot run.`);
  }

  // The catalogue lists display names, not model ids, so it cannot authoritatively reject an id. What it
  // *can* say is whether the provider a model belongs to has a sealed key — or that it cannot tell.
  const brand = spec.model ? spec.model.split('/')[0].toLowerCase().replace(/^pv-/, '') : '';
  const model = spec.model && brand
    ? providers.find((p) => {
      const name = String(p.name || '').toLowerCase();
      const id = String(p.id || '').toLowerCase().replace(/^pv-/, '');
      return name.includes(brand) || id.includes(brand) || brand.includes(id) || (p.defaultModel && String(p.defaultModel).toLowerCase() === spec.model.toLowerCase());
    })
    : null;
  if (!spec.model) add('info', 'model', 'No model chosen', 'Pick a primary model. A draft without one cannot become an agent.');
  else if (model && model.status !== 'configured') add('setup', 'model', `${model.name} has no sealed key`, 'This agent could not call its model: an Owner still has to install a provider key on the Models screen.');
  else if (!model && providers.length) add('warning', 'model', 'This model id is not one the gateway recognises', `“${spec.model}” does not match any provider on this gateway, so nothing can verify it. The agent would record the id as written.`);
  if (spec.model && spec.fallback && spec.fallback === spec.model) add('warning', 'fallback', 'Fallback equals the primary', 'A fallback identical to the primary adds nothing.');
  if (spec.model && !spec.fallback) add('warning', 'fallback', 'No fallback route', 'A rate limit or outage would fail the run outright rather than degrading.');

  const unknownSkills = spec.skills.filter((s) => skills.length && !skills.some((x) => x.id === s));
  if (unknownSkills.length) add('setup', 'skills', 'Unknown skills', `Not in this build's skill catalogue: ${unknownSkills.join(', ')}.`);
  const uninstalled = spec.plugins.filter((p) => !plugins.some((x) => x.id === p && x.installed));
  if (uninstalled.length) add('setup', 'plugins', 'Connector not installed', `These connectors are not installed, so their scopes cannot be granted: ${uninstalled.join(', ')}.`);

  const writey = spec.interaction.some((c) => c !== 'text');
  if (writey && !spec.gates.enabled) add('error', 'gates', 'Write-capable interaction without a gate', 'Anything beyond text can change the world, so an approval gate is required. The gateway refuses to activate a draft that removes it.');
  if (!spec.gates.enabled) add('warning', 'gates', 'Approval gates are off', 'With no gate, an activated agent would act without asking. Activation still requires a human approval — but the agent itself would not.');

  if (spec.autonomy >= 4) add('warning', 'autonomy', `Autonomy L${spec.autonomy}`, 'Higher autonomy widens what the agent may do without asking. Nothing enforces a workspace cap on the gateway.');

  /* ---- activation: honest about what is missing, always ---- */
  add('blocked', 'activation', 'This agent cannot run', 'No runtime adapter, process host or cancellation exists in this build. Activating records the definition as an idle agent — it does not start anything.');

  const errors = findings.filter((f) => f.severity === 'error');
  const setup = findings.filter((f) => f.severity === 'setup');
  const info = findings.filter((f) => f.severity === 'info');
  const blocked = findings.filter((f) => f.severity === 'blocked');

  let state;
  if (errors.length) state = 'invalid';
  else if (info.length) state = 'needs-information';
  else if (setup.length) state = 'needs-setup';
  else state = 'ready-for-review';

  return {
    spec,
    findings,
    state,
    // Submitting is asking a person to look, so `needs-setup` may be submitted: the setup item is part of
    // what the reviewer is being asked to accept. Missing information or a blocking error may not.
    canSubmit: state === 'ready-for-review' || state === 'needs-setup',
    // The definition-level verdict, separate from the run-level one: a draft can be ready to review and
    // still be unable to run, and saying only the first would be the lie.
    canRun: blocked.length === 0,
    summary: { errors: errors.length, setup: setup.length, warnings: findings.filter((f) => f.severity === 'warning').length, info: info.length },
  };
}

/** The row the Agents screen and the designer both speak: what activation would store. */
export function toAgentRecord(spec) {
  const s = normaliseSpec(spec).spec;
  const prompt = [
    `You are ${s.name}.`,
    s.goal,
    `Behaviour preset: ${s.preset} (autonomy L${s.autonomy}).`,
    `Limits: ${s.limits.steps} steps / ${s.limits.minutes} min / $${Number(s.limits.costUsd).toFixed(2)} (advisory).`,
    'Never assume a tool succeeded: report failures exactly as they happened.',
  ].filter(Boolean).join('\n');
  return {
    name: s.name,
    role: s.role,
    description: s.description,
    goal: s.goal,
    framework: s.framework,
    model: s.model,
    fallback: s.fallback,
    autonomy: s.autonomy,
    teamId: s.teamId,
    skills: s.skills,
    tools: s.plugins,
    responsibilities: s.responsibilities,
    approvalGates: { mode: s.gates.enabled ? 'gated' : 'none', expiry: s.gates.expiry, draft: true },
    prompt,
    status: 'idle',
  };
}

/**
 * Seed the visual builder from a draft. The builder has its own, larger draft shape; this maps the
 * canonical fields onto it and returns the assumptions it made, so the person editing sees what changed
 * rather than discovering it later.
 */
export function toDesignerSeed(spec) {
  const s = normaliseSpec(spec).spec;
  const assumptions = [];
  if (s.preset !== 'guided') assumptions.push(`Behaviour preset “${s.preset}” came from the Copilot draft.`);
  if (s.autonomy !== 2) assumptions.push(`Autonomy L${s.autonomy} came from the Copilot draft.`);
  if (s.gates.enabled) assumptions.push('Approval gates are on because the draft requires them.');
  return {
    name: s.name,
    role: s.role,
    goal: s.goal,
    framework: s.framework,
    model: s.model,
    autonomy: s.autonomy,
    skills: s.skills,
    assumptions,
  };
}

/** Read the builder's draft back into the canonical shape, for the save-back path. */
export function fromDesignerDraft(d) {
  const src = d && typeof d === 'object' ? d : {};
  return normaliseSpec({
    name: src.name,
    role: src.role,
    description: src.description || '',
    goal: src.goal,
    framework: src.framework,
    model: src.model,
    fallback: src.fallback,
    autonomy: src.autonomy,
    preset: src.preset,
    limits: { steps: src.limits?.steps, minutes: src.limits?.minutes, costUsd: src.limits?.cost },
    gates: { enabled: src.gates !== false, expiry: src.gateExpiry },
    skills: src.skills,
    plugins: src.plugins,
    interaction: src.interaction,
    knowledge: src.knowledge,
    responsibilities: src.responsibilities,
    teamId: src.teamId,
  }).spec;
}

/** The findings shape the designer renders (`{id, scope, severity, component, title, detail, fix}`). */
export function toDesignerFindings(result) {
  return (result?.findings || []).map((f) => ({
    id: f.id,
    scope: 'definition',
    severity: f.severity === 'blocked' ? 'error' : f.severity === 'info' ? 'warning' : f.severity,
    component: f.field,
    title: f.title,
    detail: f.detail,
  }));
}

/**
 * The model is asked for JSON only, and this is the prompt that says so. It is also where the honest
 * limits are stated to the model — as facts about the build, not as suggestions it may ignore.
 */
export function draftInstruction() {
  return [
    'You turn a person’s description of an agent into a draft definition, as JSON and nothing else.',
    'Reply with a single JSON object with exactly these keys:',
    '  name (string, 2–41 chars, letters/digits/space/dot/dash/underscore), role (string, <=120),',
    '  description (string, <=400), goal (string, <=600), framework (one of: ' + FRAMEWORKS.join(' | ') + '),',
    '  model (string), fallback (string), autonomy (integer 1–5), preset (guided|autonomous|review-first|assist),',
    '  limits ({steps, minutes, costUsd}), gates ({enabled, expiry}), skills (string[]), plugins (string[]),',
    '  interaction (subset of text|voice|files|widgets|email), responsibilities (string[]).',
    'Omit or leave empty any key you cannot fill from the description. Never invent a model id or a skill id;',
    'leave them empty instead. Do not include commentary, markdown or code fences — JSON only.',
    'Facts about this build you must not contradict: no runtime adapter exists, so a draft cannot run;',
    'activating a draft stores an idle definition and requires a human approval; nothing you write can',
    'approve, activate or grant permissions.',
  ].join('\n');
}

/**
 * Pull a JSON object out of a model reply. Models wrap JSON in prose and code fences even when told not
 * to; that is treated as recoverable, not as an excuse to guess. Returns `{ok, value, reason}` and never
 * throws — an unparseable reply is a finding for the person, not a crash.
 */
export function parseDraftReply(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, reason: 'the model returned nothing' };
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, reason: 'the reply contained no JSON object' };
  const slice = candidate.slice(start, end + 1);
  let value;
  try { value = JSON.parse(slice); } catch (error) {
    return { ok: false, reason: `the reply was not valid JSON (${error.message.slice(0, 80)})` };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'the reply was not a JSON object' };
  return { ok: true, value };
}
