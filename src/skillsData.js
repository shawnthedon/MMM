/* ============ Skill catalogue (marketplace + typed relationships) ============
 * Single source of truth for the Skills Hub and the Skills Matrix. Every field here is a
 * declaration, not a promise: `status`, `unavailable` and `compat` describe what the repository can
 * actually do. No skill in this catalogue is *executed* anywhere — there is no skills runtime.
 *
 * A skill record mirrors the interoperable contract in the MMMV2 skills spec §6.1:
 *   id, name, version, description, category, author/source, license, compatibility,
 *   inputs/outputs, prerequisites (requires), permissions, tools, validation status, changelog.
 * Permission/tool declarations are *requests*; importing or activating a skill never grants them.
 */

/** Relationship types with explicit semantics (spec §6.2). `cycle` = a cycle is invalid. */
export const REL_TYPES = {
  depends_on: { label: 'Depends on', hint: 'A requires B before it can run.', cycle: true, dash: '0', weight: 2, marker: true, color: 'var(--brand)' },
  complements: { label: 'Complements', hint: 'A and B improve each other; neither requires the other.', cycle: false, dash: '5 4', weight: 1.6, marker: false, color: 'var(--success)' },
  inherits_from: { label: 'Inherits from', hint: 'A references approved behaviour from B.', cycle: true, dash: '2 3', weight: 1.8, marker: true, color: 'var(--accent-2)' },
  composes_with: { label: 'Composes with', hint: 'A and B combine into a larger procedure.', cycle: true, dash: '8 3', weight: 1.8, marker: false, color: 'var(--accent-secondary)' },
  triggers: { label: 'Triggers', hint: 'A may suggest/start B under a stated condition.', cycle: true, dash: '1 4', weight: 1.5, marker: true, color: 'var(--warning)' },
  conflicts_with: { label: 'Conflicts with', hint: 'The combination is invalid and must be resolved.', cycle: false, dash: '4 4', weight: 2, marker: false, color: 'var(--danger)' },
  supersedes: { label: 'Supersedes', hint: 'The newer skill replaces the older for a defined purpose.', cycle: true, dash: '10 4', weight: 1.8, marker: true, color: 'var(--text-2)' },
  related_to: { label: 'Related to', hint: 'Informational only — no execution implication.', cycle: false, dash: '2 5', weight: 1, marker: false, color: 'var(--border)' },
};

export const REL_TYPE_IDS = Object.keys(REL_TYPES);

/** The marketplace catalogue. 24 skills: 6 original fixtures + 18 catalogue entries. */
/* `installed` marks the skills already in this workspace. The rest of the catalogue is browse-only
 * until someone adds it — installing a catalogue entry copies a manifest, it does not run anything. */
export const SKILLS = [
  // ---------- original six (ids/names are referenced by agents, designer templates and tests) ----------
  {
    id: 'sk-1', name: 'firecrawl.deep-research', version: '1.2.0', origin: 'marketplace', status: 'active', installed: true,
    category: 'Research', author: 'OpenClaw community', license: 'MIT', compat: ['LangGraph', 'CrewAI', 'OpenAI Swarm'],
    perms: ['network.egress', 'artifacts.write'], tools: ['firecrawl.scrape', 'firecrawl.map'], success: 0.93, invokes: 412,
    desc: 'Multi-source research with citation capture.', inputs: ['question'], outputs: ['brief.md', 'sources.json'],
    updated: '2026-10-14', changelog: ['1.2.0 — cite per claim, dedupe sources', '1.1.0 — map before scrape'],
  },
  {
    id: 'sk-2', name: 'dev.tdd-loop', version: '2.0.1', origin: 'marketplace', status: 'active', installed: true,
    category: 'Development', author: 'OpenClaw community', license: 'Apache-2.0', compat: ['CrewAI', 'LangGraph'],
    perms: ['fs.write', 'process.exec'], tools: ['github.pr.create'], success: 0.9, invokes: 260,
    desc: 'Red-green-refactor loop with PR drafts.', inputs: ['issue'], outputs: ['patch', 'test-report'],
    updated: '2026-10-02', changelog: ['2.0.1 — stop on flaky test', '2.0.0 — new runner contract'],
  },
  {
    id: 'sk-3', name: 'sre.triage', version: '1.5.0', origin: 'user', status: 'active', installed: true,
    category: 'Operations', author: 'workspace', license: 'internal', compat: ['CrewAI'],
    perms: ['vercel.logs'], tools: ['vercel.logs', 'webhook.alert'], success: 0.96, invokes: 801,
    desc: 'Incident triage with severity scoring.', inputs: ['alert'], outputs: ['triage.md'],
    updated: '2026-09-21', changelog: ['1.5.0 — severity rubric v3'],
  },
  {
    id: 'sk-4', name: 'content.repurpose', version: '0.9.0', origin: 'agent', status: 'pending',
    category: 'Content', author: 'Content-Weaver (agent)', license: 'unreviewed', compat: [],
    perms: ['airtable.records'], tools: ['airtable.records'], success: 0.87, invokes: 42,
    desc: 'Turn longform into threads + newsletter. Synthesized by Content-Weaver.', inputs: ['longform.md'], outputs: ['thread.md', 'newsletter.md'],
    updated: '2026-10-21', changelog: ['0.9.0 — first synthesized draft'],
  },
  {
    id: 'sk-5', name: 'data.forecast-lite', version: '0.3.1', origin: 'agent', status: 'pending',
    category: 'Data', author: 'Analyst-Prime (agent)', license: 'unreviewed', compat: [],
    perms: ['supabase.db.query'], tools: ['supabase.db.query'], success: 0.81, invokes: 17,
    desc: 'Cheap seasonal forecast fallback. Synthesized by Analyst-Prime.', inputs: ['series.csv'], outputs: ['forecast.csv'],
    updated: '2026-10-19', changelog: ['0.3.1 — clamp negative demand'],
  },
  {
    id: 'sk-6', name: 'core.citations', version: '1.0.2', origin: 'marketplace', status: 'active', installed: true,
    category: 'Governance', author: 'MMM HQ core', license: 'MIT', compat: ['LangGraph', 'CrewAI', 'OpenAI Swarm', 'Swarmzero'],
    perms: [], tools: [], success: 0.99, invokes: 1204,
    desc: 'Citation formatting & dedupe.', inputs: ['claims'], outputs: ['sources.json'],
    updated: '2026-08-30', changelog: ['1.0.2 — stable ordering'],
  },

  // ---------- catalogue additions ----------
  {
    id: 'sk-7', name: 'dev.code-review', version: '1.4.2', origin: 'marketplace', status: 'active',
    category: 'Development', author: 'OpenClaw community', license: 'MIT', compat: ['CrewAI', 'LangGraph'],
    perms: ['repo.read'], tools: ['github.repos', 'code.search'], success: 0.94, invokes: 655,
    desc: 'Structured diff review: risks first, then nits.', inputs: ['diff'], outputs: ['review.md'],
    updated: '2026-10-11', changelog: ['1.4.2 — flag missing tests'],
  },
  {
    id: 'sk-8', name: 'sre.postmortem', version: '1.1.0', origin: 'marketplace', status: 'active',
    category: 'Operations', author: 'workspace', license: 'internal', compat: ['CrewAI', 'LangGraph'],
    perms: ['artifacts.write'], tools: [], success: 0.92, invokes: 118,
    desc: 'Blameless postmortem from a triage timeline.', inputs: ['triage.md', 'logs'], outputs: ['postmortem.md'],
    updated: '2026-09-28', changelog: ['1.1.0 — require evidence per cause'],
  },
  {
    id: 'sk-9', name: 'content.longform', version: '2.2.0', origin: 'marketplace', status: 'active',
    category: 'Content', author: 'OpenClaw community', license: 'CC-BY-4.0', compat: ['LangGraph'],
    perms: ['artifacts.write'], tools: [], success: 0.89, invokes: 233,
    desc: 'Outline → draft → fact-check checklist for long posts.', inputs: ['brief'], outputs: ['draft.md'],
    updated: '2026-10-05', changelog: ['2.2.0 — fact-check checklist'],
  },
  {
    id: 'sk-10', name: 'web.summarize', version: '1.0.0', origin: 'marketplace', status: 'active',
    category: 'Web', author: 'OpenClaw community', license: 'MIT', compat: ['LangGraph', 'CrewAI', 'OpenAI Swarm'],
    perms: ['network.egress'], tools: ['firecrawl.scrape'], success: 0.91, invokes: 389,
    desc: 'Summarise one page with a source line per claim.', inputs: ['url'], outputs: ['summary.md'],
    updated: '2026-09-12', changelog: ['1.0.0 — first stable'],
  },
  {
    id: 'sk-11', name: 'web.scrape-structured', version: '1.3.0', origin: 'marketplace', status: 'active',
    category: 'Web', author: 'OpenClaw community', license: 'MIT', compat: ['LangGraph'],
    perms: ['network.egress'], tools: ['firecrawl.extract'], success: 0.88, invokes: 204,
    desc: 'Extract typed records from a page using a schema.', inputs: ['url', 'schema.json'], outputs: ['records.json'],
    updated: '2026-10-08', changelog: ['1.3.0 — refuse pages without consent'],
  },
  {
    id: 'sk-12', name: 'data.csv-normalise', version: '1.2.1', origin: 'marketplace', status: 'active',
    category: 'Data', author: 'OpenClaw community', license: 'MIT', compat: ['LangGraph', 'CrewAI'],
    perms: ['artifacts.write'], tools: [], success: 0.97, invokes: 512,
    desc: 'Column typing, unit coercion and null policy for CSVs.', inputs: ['*.csv'], outputs: ['normalised.csv'],
    updated: '2026-07-19', changelog: ['1.2.1 — locale decimals'],
  },
  {
    id: 'sk-13', name: 'data.sql-query', version: '1.0.4', origin: 'marketplace', status: 'active',
    category: 'Data', author: 'workspace', license: 'internal', compat: ['CrewAI'],
    perms: ['db.query'], tools: ['supabase.db.query'], success: 0.85, invokes: 176,
    desc: 'Read-only query drafting against an approved schema.', inputs: ['question'], outputs: ['sql', 'result.csv'],
    updated: '2026-08-22', changelog: ['1.0.4 — reject DDL statements'],
  },
  {
    id: 'sk-14', name: 'gov.approval-request', version: '1.1.0', origin: 'marketplace', status: 'active',
    category: 'Governance', author: 'MMM HQ core', license: 'MIT', compat: ['LangGraph', 'CrewAI', 'OpenAI Swarm'],
    perms: ['approval.request'], tools: [], success: 0.98, invokes: 640,
    desc: 'Raise a scoped approval gate with evidence and rollback notes.', inputs: ['action', 'evidence'], outputs: ['gate'],
    updated: '2026-10-16', changelog: ['1.1.0 — require rollback text'],
  },
  {
    id: 'sk-15', name: 'gov.secret-redaction', version: '2.0.0', origin: 'marketplace', status: 'active',
    category: 'Governance', author: 'MMM HQ core', license: 'MIT', compat: ['LangGraph', 'CrewAI', 'OpenAI Swarm', 'Swarmzero'],
    perms: [], tools: [], success: 0.99, invokes: 1520,
    desc: 'Strip keys, tokens and PII from logs before they are stored.', inputs: ['text'], outputs: ['redacted'],
    updated: '2026-10-20', changelog: ['2.0.0 — pattern set v2, no silent drop'],
  },
  {
    id: 'sk-16', name: 'comm.incident-update', version: '0.8.2', origin: 'marketplace', status: 'active',
    category: 'Communication', author: 'workspace', license: 'internal', compat: ['CrewAI'],
    perms: ['send.message'], tools: ['webhook.alert'], success: 0.9, invokes: 96,
    desc: 'Draft a status update from a triage summary.', inputs: ['triage.md'], outputs: ['update.md'],
    updated: '2026-09-30', changelog: ['0.8.2 — audience field'],
  },
  {
    id: 'sk-17', name: 'comm.telegram-digest', version: '0.4.0', origin: 'marketplace', status: 'active',
    category: 'Communication', author: 'OpenClaw community', license: 'MIT', compat: [],
    perms: ['send.message'], tools: [], success: 0.7, invokes: 12,
    desc: 'Daily digest formatted for a Telegram channel.',
    inputs: ['events.json'], outputs: ['digest.md'],
    updated: '2026-10-01', changelog: ['0.4.0 — markdown-only output'],
    unavailable: 'Requires an outbound Telegram transport. This build has a Telegram UI simulation only — no bot client.',
  },
  {
    id: 'sk-18', name: 'dev.migration-review', version: '1.0.0', origin: 'marketplace', status: 'active',
    category: 'Development', author: 'OpenClaw community', license: 'Apache-2.0', compat: ['CrewAI'],
    perms: ['repo.read'], tools: ['github.repos'], success: 0.9, invokes: 61,
    desc: 'Review a SQL migration for locking and reversibility.', inputs: ['*.sql'], outputs: ['review.md'],
    updated: '2026-10-09', changelog: ['1.0.0 — first stable'],
  },
  {
    id: 'sk-19', name: 'ops.budget-guard', version: '1.2.0', origin: 'marketplace', status: 'active',
    category: 'Operations', author: 'MMM HQ core', license: 'MIT', compat: ['LangGraph', 'CrewAI'],
    perms: [], tools: [], success: 0.95, invokes: 388,
    desc: 'Estimate spend before a run and stop at the cap.',
    inputs: ['plan'], outputs: ['verdict'],
    updated: '2026-10-18', changelog: ['1.2.0 — estimate before dispatch'],
    advisory: 'Limits are recorded on definitions; the gateway has no budget fields, so the cap is not enforced server-side.',
  },
  {
    id: 'sk-20', name: 'research.competitor-scan', version: '1.0.1', origin: 'marketplace', status: 'active',
    category: 'Research', author: 'OpenClaw community', license: 'MIT', compat: ['LangGraph'],
    perms: ['network.egress'], tools: ['firecrawl.search'], success: 0.86, invokes: 143,
    desc: 'Compare N vendors on a fixed rubric, one row each.', inputs: ['vendors[]', 'rubric'], outputs: ['matrix.csv'],
    updated: '2026-10-12', changelog: ['1.0.1 — rubric required'],
  },
  {
    id: 'sk-21', name: 'content.seo-brief', version: '0.6.0', origin: 'marketplace', status: 'active',
    category: 'Content', author: 'OpenClaw community', license: 'CC-BY-4.0', compat: ['LangGraph'],
    perms: [], tools: [], success: 0.84, invokes: 77,
    desc: 'Search-intent brief with headings and entity list.', inputs: ['keyword'], outputs: ['brief.md'],
    updated: '2026-09-25', changelog: ['0.6.0 — entity list'],
  },
  {
    id: 'sk-22', name: 'agent.handoff-a2a', version: '0.2.0', origin: 'marketplace', status: 'active',
    category: 'Interoperability', author: 'MMM HQ core', license: 'MIT', compat: [],
    perms: ['agent.comm'], tools: [], success: 0.6, invokes: 4,
    desc: 'Describe a task hand-off envelope between two agents.',
    inputs: ['task'], outputs: ['envelope'],
    updated: '2026-10-22', changelog: ['0.2.0 — correlation id required'],
    unavailable: 'No A2A adapter, peer registry or transport is installed, so no hand-off can be sent.',
  },
  {
    id: 'sk-23', name: 'mcp.tool-discovery', version: '0.3.0', origin: 'marketplace', status: 'active',
    category: 'Interoperability', author: 'MMM HQ core', license: 'MIT', compat: [],
    perms: [], tools: [], success: 0.5, invokes: 3,
    desc: 'List tools advertised by registered MCP servers.',
    inputs: [], outputs: ['tools.json'],
    updated: '2026-10-22', changelog: ['0.3.0 — read-only listing'],
    unavailable: 'The plugin screen lists MCP servers, but no MCP client or transport exists, so discovery cannot run.',
  },
  {
    id: 'sk-24', name: 'eval.regression-suite', version: '1.0.3', origin: 'marketplace', status: 'active',
    category: 'Quality', author: 'MMM HQ core', license: 'MIT', compat: ['LangGraph', 'CrewAI', 'OpenAI Swarm'],
    perms: ['artifacts.write'], tools: [], success: 0.97, invokes: 320,
    desc: 'Replay a fixed eval set and diff the outcome.', inputs: ['evals.yaml'], outputs: ['report.md'],
    updated: '2026-10-17', changelog: ['1.0.3 — fail on missing baseline'],
  },
];

/** Typed relationships between catalogue skills (spec §6.2). Semantics live in REL_TYPES. */
export const RELATIONS = [
  { id: 'rl-1', from: 'firecrawl.deep-research', to: 'web.summarize', type: 'depends_on' },
  { id: 'rl-2', from: 'firecrawl.deep-research', to: 'core.citations', type: 'depends_on' },
  { id: 'rl-3', from: 'firecrawl.deep-research', to: 'research.competitor-scan', type: 'complements' },
  { id: 'rl-4', from: 'research.competitor-scan', to: 'web.scrape-structured', type: 'depends_on' },
  { id: 'rl-5', from: 'firecrawl.deep-research', to: 'gov.secret-redaction', type: 'composes_with' },
  { id: 'rl-6', from: 'dev.tdd-loop', to: 'dev.code-review', type: 'complements' },
  { id: 'rl-7', from: 'dev.tdd-loop', to: 'gov.approval-request', type: 'triggers' },
  { id: 'rl-8', from: 'dev.code-review', to: 'dev.migration-review', type: 'complements' },
  { id: 'rl-9', from: 'dev.migration-review', to: 'core.citations', type: 'related_to' },
  { id: 'rl-10', from: 'sre.triage', to: 'sre.postmortem', type: 'triggers' },
  { id: 'rl-11', from: 'sre.postmortem', to: 'comm.incident-update', type: 'depends_on' },
  { id: 'rl-12', from: 'sre.triage', to: 'comm.incident-update', type: 'complements' },
  { id: 'rl-13', from: 'sre.triage', to: 'ops.budget-guard', type: 'related_to' },
  { id: 'rl-14', from: 'content.repurpose', to: 'content.longform', type: 'depends_on' },
  { id: 'rl-15', from: 'content.longform', to: 'content.seo-brief', type: 'inherits_from' },
  { id: 'rl-16', from: 'content.repurpose', to: 'core.citations', type: 'related_to' },
  { id: 'rl-17', from: 'data.forecast-lite', to: 'data.csv-normalise', type: 'depends_on' },
  { id: 'rl-18', from: 'data.forecast-lite', to: 'data.sql-query', type: 'conflicts_with' },
  { id: 'rl-19', from: 'eval.regression-suite', to: 'dev.tdd-loop', type: 'complements' },
  { id: 'rl-20', from: 'agent.handoff-a2a', to: 'mcp.tool-discovery', type: 'related_to' },
  { id: 'rl-21', from: 'mcp.tool-discovery', to: 'gov.secret-redaction', type: 'depends_on' },
  { id: 'rl-22', from: 'comm.telegram-digest', to: 'comm.incident-update', type: 'supersedes' },
  { id: 'rl-23', from: 'eval.regression-suite', to: 'core.citations', type: 'depends_on' },
  { id: 'rl-24', from: 'ops.budget-guard', to: 'gov.approval-request', type: 'triggers' },
];

/** Clone helper so seeding never hands out references to the module constants. */
/* Anything shipped without an explicit flag is browse-only until someone adds it. */
SKILLS.forEach((k) => { if (k.installed === undefined) k.installed = false; });

export const cloneSkills = () => SKILLS.map((s) => ({ ...s, perms: [...s.perms], tools: [...s.tools], compat: [...(s.compat || [])], changelog: [...(s.changelog || [])], inputs: [...(s.inputs || [])], outputs: [...(s.outputs || [])] }));
export const cloneRelations = () => RELATIONS.map((r) => ({ ...r }));
