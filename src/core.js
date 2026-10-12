/* ============ SwarmOS core: state, seed, utils, icons ============ */

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const uid = (p = 'id') => `${p}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
export const now = () => Date.now();
export const fmtTime = (ts) => {
  const d = new Date(ts);
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
export const fmtMoney = (n) => `$${Number(n).toFixed(n >= 100 ? 0 : 2)}`;
export const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

/* ---------- icons (inline SVG) ---------- */
const P = (d) => `<path d="${d}"/>`;
const svg = (body, o = {}) =>
  `<svg width="${o.s || 22}" height="${o.s || 22}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${o.w || 1.9}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const icons = {
  home: svg(P('M3 10.5 12 3l9 7.5M5 9.5V21h5v-6h4v6h5V9.5')),
  robot: svg(P('M12 3v3M8 6h8a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3zM2 12h3M19 12h3M9 12h.01M15 12h.01M9.5 15.5c1.5 1 3.5 1 5 0')),
  board: svg(P('M4 4h5v12H4zM10 4h5v7h-5zM16 4h4v16h-4zM4 18h5')),
  chat: svg(P('M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5zM8 12h.01M12 12h.01M16 12h.01')),
  grid: svg(P('M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z')),
  bell: svg(P('M18 16v-5a6 6 0 1 0-12 0v5l-2 3h16zM10 21a2.5 2.5 0 0 0 4 0')),
  plus: svg(P('M12 5v14M5 12h14')),
  play: svg(P('M7 4.5v15l13-7.5z')),
  pause: svg(P('M8 5v14M16 5v14')),
  stop: svg(P('M6 6h12v12H6z')),
  x: svg(P('M6 6l12 12M18 6L6 18')),
  left: svg(P('M15 5l-7 7 7 7')),
  right: svg(P('M9 5l7 7-7 7')),
  check: svg(P('M4 12.5 9.5 18 20 6.5')),
  shield: svg(P('M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4.5')),
  spark: svg(P('M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.9 2.4 2.4.9-2.4.9L19 22l-.9-2.4-2.4-.9 2.4-.9z')),
  plug: svg(P('M9 3v6M15 3v6M6 9h12v3a6 6 0 0 1-12 0zM12 18v3')),
  chart: svg(P('M4 20V4M4 20h16M8 16V10M12 16V6M16 16v-4')),
  gear: svg(P('M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19 12c0-.5-.05-1-.13-1.46l2-1.5-2-3.46-2.3.94a7 7 0 0 0-2.53-1.46L13.6 2.5h-3.2l-.44 2.56a7 7 0 0 0-2.53 1.46l-2.3-.94-2 3.46 2 1.5A7 7 0 0 0 5 12c0 .5.05 1 .13 1.46l-2 1.5 2 3.46 2.3-.94a7 7 0 0 0 2.53 1.46l.44 2.56h3.2l.44-2.56a7 7 0 0 0 2.53-1.46l2.3.94 2-3.46-2-1.5c.08-.46.13-.96.13-1.46z')),
  folder: svg(P('M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z')),
  terminal: svg(P('M4 5h16v14H4zM7 9l3 3-3 3M12.5 15H17')),
  send: svg(P('M4 12l16-8-6 8 6 8z')),
  mic: svg(P('M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM6 11a6 6 0 0 0 12 0M12 17v4')),
  search: svg(P('M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3')),
  trash: svg(P('M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13')),
  copy: svg(P('M8 8h12v12H8zM4 16V4h12')),
  download: svg(P('M12 3v12M7 11l5 5 5-5M4 21h16')),
  link: svg(P('M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7L12.5 18.5')),
  cpu: svg(P('M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2M6 6h12v12H6zM10 10h4v4h-4z')),
  skill: svg(P('M13 3L5 13h5l-1 8 8-10h-5zM19 3l.9 2.1L22 6l-2.1.9L19 9l-.9-2.1L16 6l2.1-.9z')),
  team: svg(P('M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20a6 6 0 0 1 12 0M16 4.5a3 3 0 0 1 0 5.8M17 14.2A6 6 0 0 1 21 20')),
  file: svg(P('M6 2h8l5 5v15H6zM14 2v6h5')),
  swarm: svg(P('M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM5 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM19 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM12 22a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM11 8.5 6.5 11.5M13 8.5l4.5 3M6.5 13.5 11 17.5M17.5 13.5 13 17.5')),
  model: svg(P('M12 2l9 5v10l-9 5-9-5V7zM12 22V12M3 7l9 5 9-5')),
  undo: svg(P('M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12h-3')),
  doc: svg(P('M7 3h7l4 4v14H7zM14 3v5h4M9.5 12h5M9.5 16h5')),
};

export const icon = (n, s) => (icons[n] ? icons[n].replace(/width="\d+" height="\d+"/, `width="${s || 22}" height="${s || 22}"`) : '');

/* ---------- avatars ---------- */
const AV_COLORS = ['#6C8CFF', '#22D3EE', '#F472B6', '#FBBF24', '#34D399', '#A78BFA', '#F87171', '#38BDF8'];
export const avatarColor = (name) => AV_COLORS[[...String(name)].reduce((a, c) => a + c.charCodeAt(0), 0) % AV_COLORS.length];
export const initials = (name) => String(name).split(/[\s-_]+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
export const avatar = (name, cls = '') =>
  `<div class="avatar ${cls}" style="background:${avatarColor(name)}">${esc(initials(name))}</div>`;

export const trustTier = (t) => (t >= 80 ? 'a' : t >= 50 ? 'b' : 'c');
export const trustColor = (t) => (t >= 80 ? 'var(--trust-a)' : t >= 50 ? 'var(--trust-b)' : 'var(--trust-c)');

/* ---------- seeded demo state ---------- */
function seed() {
  const t = now();
  const mins = (m) => t - m * 60000;
  return {
    rev: 0,
    settings: {
      workspaceName: 'SwarmLab',
      theme: 'dark',
      density: 'comfortable',
      autonomyLevel: 2,
      selfImprove: 'suggest',
      copilotMode: 'act',
      copilotMemory: true,
      simulate: true,
      soundHaptics: true,
      notify: { approvals: true, failures: true, deploys: true, budget: true, digest: true },
      trustWeights: { success: 12, compliance: 10, approvals: 8, evals: 8, uptime: 6, incidents: 15, cost: 8 },
      retention: { runs: '90d', logs: '30d', memory: '180d' },
    },
    gateway: { status: 'healthy', version: '0.1.0-proto', uptimeSince: mins(60 * 24 * 3), storageMb: 248, sqlite: 'WAL' },
    agents: [
      {
        id: 'ag-researcher', name: 'Researcher-01', role: 'Deep research & citation capture', framework: 'LangGraph',
        model: 'anthropic/claude-sonnet-4', fallback: 'deepseek/deepseek-v3', status: 'running', trust: 92,
        autonomy: 3, successRate: 0.94, costToday: 4.28, runs: 214, lastActive: mins(2),
        tools: ['firecrawl.scrape', 'firecrawl.map', 'web.search'], skills: ['firecrawl.deep-research', 'core.citations'],
        prompt: 'You are Researcher-01. Gather multi-source evidence, never fabricate citations, prefer primary sources.',
        memory: { episodic: 1840, semantic: 412, kb: '14.2 MB' },
      },
      {
        id: 'ag-coder', name: 'Coder-07', role: 'Full-stack implementation agent', framework: 'CrewAI',
        model: 'openai/gpt-5', fallback: 'openrouter/auto', status: 'running', trust: 88,
        autonomy: 2, successRate: 0.91, costToday: 6.12, runs: 156, lastActive: mins(5),
        tools: ['github.repos', 'github.pr.create', 'fs.write'], skills: ['dev.tdd-loop', 'dev.code-review'],
        prompt: 'You are Coder-07. Write tests first, small diffs, explain trade-offs briefly.',
        memory: { episodic: 980, semantic: 260, kb: '9.1 MB' },
      },
      {
        id: 'ag-pentester', name: 'RedTeam-Alpha', role: 'AutoPentest security cell lead', framework: 'AutoPentest',
        model: 'anthropic/claude-opus-4', fallback: 'groq/llama-3.3-70b', status: 'paused', trust: 76,
        autonomy: 1, successRate: 0.87, costToday: 2.03, runs: 64, lastActive: mins(95),
        tools: ['net.probe', 'http.fuzz'], skills: ['sec.recon', 'sec.report'],
        prompt: 'You are RedTeam-Alpha. Operate strictly inside the engagement scope. Every exploit step requires approval.',
        memory: { episodic: 420, semantic: 150, kb: '5.4 MB' },
      },
      {
        id: 'ag-sre', name: 'SRE-Bot', role: 'Infra watch & incident response', framework: 'Swarmzero',
        model: 'google/gemini-3-pro', fallback: 'ollama/qwen2.5:32b', status: 'running', trust: 95,
        autonomy: 3, successRate: 0.96, costToday: 1.44, runs: 502, lastActive: mins(1),
        tools: ['vercel.logs', 'vercel.deploy', 'webhook.alert'], skills: ['sre.triage', 'sre.postmortem'],
        prompt: 'You are SRE-Bot. Detect, triage, mitigate. Never touch prod without a gate approval.',
        memory: { episodic: 3200, semantic: 890, kb: '22.8 MB' },
      },
      {
        id: 'ag-content', name: 'Content-Weaver', role: 'Multi-channel content pipeline', framework: 'Project Nautilus',
        model: 'mistral/large-latest', fallback: 'zhipu/glm-4-plus', status: 'idle', trust: 81,
        autonomy: 2, successRate: 0.89, costToday: 0.87, runs: 122, lastActive: mins(30),
        tools: ['airtable.records', 'supabase.db.query'], skills: ['content.longform', 'content.repurpose'],
        prompt: 'You are Content-Weaver. Match brand voice, always include sources, respect editorial gates.',
        memory: { episodic: 760, semantic: 320, kb: '8.7 MB' },
      },
      {
        id: 'ag-analyst', name: 'Analyst-Prime', role: 'Data & cost intelligence', framework: 'A.I.M.A',
        model: 'deepseek/deepseek-v3', fallback: 'together/qwen2.5-72b', status: 'error', trust: 58,
        autonomy: 2, successRate: 0.78, costToday: 3.19, runs: 88, lastActive: mins(40),
        tools: ['supabase.db.query', 'firecrawl.extract'], skills: ['data.etl', 'data.forecast'],
        prompt: 'You are Analyst-Prime. Deliberate over hypotheses, validate data before conclusions.',
        memory: { episodic: 610, semantic: 240, kb: '7.2 MB' },
      },
    ],
    teams: [
      { id: 'tm-research', name: 'Research Squad', topology: 'Hierarchical', members: ['ag-researcher', 'ag-content', 'ag-analyst'], health: 'good' },
      { id: 'tm-ops', name: 'Ops Crew', topology: 'Peer mesh', members: ['ag-sre', 'ag-coder'], health: 'good' },
      { id: 'tm-red', name: 'Red Cell', topology: 'Pipeline', members: ['ag-pentester', 'ag-analyst'], health: 'watch' },
    ],
    swarms: [
      {
        id: 'sw-market', teamId: 'tm-research', name: 'market-intel-swarm', objective: 'Map the EU AI-agent market: top 20 vendors, pricing, positioning.',
        status: 'live', progress: 0.62, budget: { cap: 10, spent: 3.41 }, startedAt: mins(48), channel: 'telegram',
        nodes: [
          { id: 'n1', label: 'planner', agent: 'ag-researcher', status: 'done', spent: 0.42, elapsed: '0:48' },
          { id: 'n2', label: 'research-a', agent: 'ag-researcher', status: 'done', spent: 1.12, elapsed: '3:10' },
          { id: 'n3', label: 'research-b', agent: 'ag-content', status: 'running', spent: 0.98, elapsed: '4:02' },
          { id: 'n4', label: 'analyze', agent: 'ag-analyst', status: 'running', spent: 0.61, elapsed: '2:12' },
          { id: 'n5', label: 'writer', agent: 'ag-content', status: 'queued', spent: 0, elapsed: '—' },
          { id: 'n6', label: 'assembler', agent: 'ag-researcher', status: 'queued', spent: 0, elapsed: '—' },
        ],
      },
    ],
    tasks: [
      { id: 'tk-1', title: 'Draft EU market map structure', column: 'done', assignee: 'ag-content', priority: 'high', deps: [], desc: 'Outline sections: vendors, pricing, positioning.' },
      { id: 'tk-2', title: 'Crawl vendor pricing pages', column: 'doing', assignee: 'ag-researcher', priority: 'high', deps: ['tk-1'], desc: 'Firecrawl map + scrape top-20 pricing.' },
      { id: 'tk-3', title: 'Normalize pricing into Airtable', column: 'doing', assignee: 'ag-analyst', priority: 'med', deps: ['tk-2'], desc: 'Map plans to canonical tiers.' },
      { id: 'tk-4', title: 'Positioning heatmap chart', column: 'review', assignee: 'ag-analyst', priority: 'med', deps: ['tk-3'], desc: 'Feature coverage × price.' },
      { id: 'tk-5', title: 'Security review of new MCP plugin', column: 'todo', assignee: 'ag-pentester', priority: 'high', deps: [], desc: 'Scope: custom HTTP MCP server.' },
      { id: 'tk-6', title: 'Rotate Vercel deploy key', column: 'todo', assignee: 'ag-sre', priority: 'high', deps: [], desc: 'Gate: production env access.' },
      { id: 'tk-7', title: 'Weekly cost digest to Telegram', column: 'doing', assignee: 'ag-sre', priority: 'low', deps: [], desc: 'Automated cron task.' },
      { id: 'tk-8', title: 'Refine Content-Weaver prompt (v12)', column: 'review', assignee: 'ag-content', priority: 'med', deps: [], desc: 'Agent-proposed refinement pending review.' },
      { id: 'tk-9', title: 'Archive Q3 run artifacts', column: 'done', assignee: 'ag-sre', priority: 'low', deps: [], desc: 'Cold storage export.' },
    ],
    skills: [
      { id: 'sk-1', name: 'firecrawl.deep-research', version: '1.2.0', origin: 'marketplace', status: 'active', perms: ['network.egress', 'artifacts.write'], tools: ['firecrawl.scrape', 'firecrawl.map'], success: 0.93, invokes: 412, desc: 'Multi-source research with citation capture.' },
      { id: 'sk-2', name: 'dev.tdd-loop', version: '2.0.1', origin: 'marketplace', status: 'active', perms: ['fs.write', 'process.exec'], tools: ['github.pr.create'], success: 0.9, invokes: 260, desc: 'Red-green-refactor loop with PR drafts.' },
      { id: 'sk-3', name: 'sre.triage', version: '1.5.0', origin: 'user', status: 'active', perms: ['vercel.logs'], tools: ['vercel.logs', 'webhook.alert'], success: 0.96, invokes: 801, desc: 'Incident triage with severity scoring.' },
      { id: 'sk-4', name: 'content.repurpose', version: '0.9.0', origin: 'agent', status: 'pending', perms: ['airtable.records'], tools: ['airtable.records'], success: 0.87, invokes: 42, desc: 'Turn longform into threads + newsletter. Synthesized by Content-Weaver.' },
      { id: 'sk-5', name: 'data.forecast-lite', version: '0.3.1', origin: 'agent', status: 'pending', perms: ['supabase.db.query'], tools: ['supabase.db.query'], success: 0.81, invokes: 17, desc: 'Cheap seasonal forecast fallback. Synthesized by Analyst-Prime.' },
      { id: 'sk-6', name: 'core.citations', version: '1.0.2', origin: 'marketplace', status: 'active', perms: [], tools: [], success: 0.99, invokes: 1204, desc: 'Citation formatting & dedupe.' },
    ],
    plugins: [
      { id: 'pl-gh', name: 'GitHub', category: 'DevOps', installed: true, verified: true, callsToday: 148, scopes: ['repo.read', 'pr.write'], tools: ['repos.read', 'code.search', 'pr.create', 'issues.manage', 'actions.trigger'] },
      { id: 'pl-fc', name: 'Firecrawl', category: 'Web', installed: true, verified: true, callsToday: 326, scopes: ['network.egress'], tools: ['scrape', 'map', 'crawl', 'extract', 'search'] },
      { id: 'pl-sb', name: 'Supabase', category: 'Data', installed: false, verified: true, callsToday: 0, scopes: ['db.query', 'storage'], tools: ['db.query', 'db.migrate', 'auth.admin', 'storage', 'edge.invoke'] },
      { id: 'pl-vl', name: 'Vercel', category: 'DevOps', installed: true, verified: true, callsToday: 61, scopes: ['deploy', 'logs.read'], tools: ['deploy', 'env.manage', 'logs.read', 'domains', 'projects'] },
      { id: 'pl-at', name: 'Airtable', category: 'No-code', installed: false, verified: true, callsToday: 0, scopes: ['records.crud'], tools: ['base.list', 'records.crud', 'schema.update'] },
      { id: 'pl-b44', name: 'Base44', category: 'No-code', installed: false, verified: true, callsToday: 0, scopes: ['data.crud'], tools: ['apps.list', 'data.crud', 'functions.invoke', 'auth'] },
    ],
    providers: [
      { id: 'pv-openai', category: 'Frontier Cloud', name: 'OpenAI', status: 'on', auth: 'API key', models: ['GPT-5', 'o3'], latency: 640, spendMTD: 128.4 },
      { id: 'pv-anthropic', category: 'Frontier Cloud', name: 'Anthropic', status: 'on', auth: 'API key', models: ['Claude Opus 4', 'Claude Sonnet 4'], latency: 520, spendMTD: 214.9 },
      { id: 'pv-google', category: 'Frontier Cloud', name: 'Google', status: 'on', auth: 'API key', models: ['Gemini 3 Pro'], latency: 580, spendMTD: 76.2 },
      { id: 'pv-xai', category: 'Frontier Cloud', name: 'xAI', status: 'off', auth: 'API key', models: ['Grok 3'], latency: 710, spendMTD: 0 },
      { id: 'pv-openrouter', category: 'Mid-Tier Cloud', name: 'OpenRouter', status: 'on', auth: 'API key', models: ['auto', 'many'], latency: 820, spendMTD: 41.7 },
      { id: 'pv-together', category: 'Mid-Tier Cloud', name: 'Together AI', status: 'off', auth: 'API key', models: ['Qwen2.5-72B'], latency: 460, spendMTD: 0 },
      { id: 'pv-mistral', category: 'Mid-Tier Cloud', name: 'Mistral', status: 'on', auth: 'API key', models: ['Large', 'Codestral'], latency: 430, spendMTD: 22.8 },
      { id: 'pv-cohere', category: 'Mid-Tier Cloud', name: 'Cohere', status: 'off', auth: 'API key', models: ['Command R+'], latency: 550, spendMTD: 0 },
      { id: 'pv-ai21', category: 'Mid-Tier Cloud', name: 'AI21', status: 'off', auth: 'API key', models: ['Jamba'], latency: 600, spendMTD: 0 },
      { id: 'pv-zhipu', category: 'Mid-Tier Cloud', name: 'Zhipu GLM', status: 'on', auth: 'API key', models: ['GLM-4 Plus'], latency: 490, spendMTD: 9.3 },
      { id: 'pv-ollama', category: 'Local/Self-Hosted', name: 'Ollama', status: 'on', auth: 'local URL', models: ['qwen2.5:32b', 'llama3.3'], latency: 220, spendMTD: 0 },
      { id: 'pv-lmstudio', category: 'Local/Self-Hosted', name: 'LM Studio', status: 'off', auth: 'local URL', models: ['any GGUF'], latency: 260, spendMTD: 0 },
      { id: 'pv-llamacpp', category: 'Local/Self-Hosted', name: 'llama.cpp', status: 'off', auth: 'local URL', models: ['any GGUF'], latency: 190, spendMTD: 0 },
      { id: 'pv-vllm', category: 'Local/Self-Hosted', name: 'vLLM', status: 'on', auth: 'local URL', models: ['qwen2.5-72b'], latency: 150, spendMTD: 0 },
      { id: 'pv-localai', category: 'Local/Self-Hosted', name: 'LocalAI', status: 'off', auth: 'local URL', models: ['any'], latency: 300, spendMTD: 0 },
      { id: 'pv-tabby', category: 'Local/Self-Hosted', name: 'TabbyAPI', status: 'off', auth: 'local URL', models: ['exl2 models'], latency: 210, spendMTD: 0 },
      { id: 'pv-deepseek', category: 'Specialized', name: 'DeepSeek', status: 'on', auth: 'API key', models: ['DeepSeek-V3', 'R1'], latency: 380, spendMTD: 18.6 },
      { id: 'pv-qwen', category: 'Specialized', name: 'Qwen', status: 'off', auth: 'API key', models: ['Qwen-Max'], latency: 420, spendMTD: 0 },
      { id: 'pv-minimax', category: 'Specialized', name: 'MiniMax', status: 'off', auth: 'API key', models: ['MiniMax-01'], latency: 470, spendMTD: 0 },
      { id: 'pv-moonshot', category: 'Specialized', name: 'Moonshot AI', status: 'off', auth: 'API key', models: ['Kimi K2'], latency: 510, spendMTD: 0 },
      { id: 'pv-perplexity', category: 'Specialized', name: 'Perplexity', status: 'on', auth: 'API key', models: ['Sonar'], latency: 640, spendMTD: 6.9 },
      { id: 'pv-groq', category: 'Specialized', name: 'Groq', status: 'on', auth: 'API key', models: ['Llama-3.3-70B'], latency: 90, spendMTD: 3.2 },
      { id: 'pv-azure', category: 'Enterprise', name: 'Azure OpenAI', status: 'off', auth: 'Entra', models: ['GPT-5'], latency: 560, spendMTD: 0 },
      { id: 'pv-bedrock', category: 'Enterprise', name: 'AWS Bedrock', status: 'off', auth: 'IAM', models: ['Claude', 'Nova'], latency: 590, spendMTD: 0 },
      { id: 'pv-vertex', category: 'Enterprise', name: 'GCP Vertex AI', status: 'off', auth: 'Service acct', models: ['Gemini 3'], latency: 570, spendMTD: 0 },
      { id: 'pv-watsonx', category: 'Enterprise', name: 'IBM watsonx', status: 'off', auth: 'API key', models: ['Granite'], latency: 660, spendMTD: 0 },
    ],
    policies: [
      { id: 'po-1', name: 'default-task-routing', priority: 100, rules: 'WHEN task.type ∈ {research,summarize} → claude-sonnet-4; fallback deepseek-v3; escalate claude-opus-4 IF confidence < 0.6' },
      { id: 'po-2', name: 'cheap-night-shift', priority: 50, rules: 'WHEN hour ∈ [00,07] AND task.cost_class = low → ollama/qwen2.5:32b; cap $0.10/run' },
      { id: 'po-3', name: 'code-escalation', priority: 80, rules: 'WHEN task.type = code → gpt-5; fallback openrouter/auto' },
    ],
    approvals: [
      { id: 'ap-1', action: 'vercel.deploy', target: 'production · web-app', risk: 'medium', principal: 'SRE-Bot', evidence: 'Commit 8f21c: "fix auth redirect loop". Diff +214/−96.', status: 'pending', createdAt: mins(6) },
      { id: 'ap-2', action: 'db.migrate', target: 'supabase · staging', risk: 'high', principal: 'Analyst-Prime', evidence: 'ALTER TABLE runs ADD COLUMN cost_usd numeric.', status: 'pending', createdAt: mins(21) },
    ],
    threads: [
      {
        id: 'th-1', kind: 'direct', title: 'Researcher-01', unread: 2,
        messages: [
          { id: 'm1', from: 'me', text: 'How is the EU vendor crawl going?', ts: mins(14) },
          { id: 'm2', from: 'agent', agent: 'Researcher-01', text: 'Crawling vendor pricing pages now — 13/20 done. Found 4 vendors with usage-based pricing I flagged for Analyst-Prime to normalize.', ts: mins(13) },
          { id: 'm3', from: 'agent', agent: 'Researcher-01', text: 'Also: two sites blocked the crawler (403). Switching to firecrawl.extract with browser rendering for those.', ts: mins(9) },
        ],
      },
      {
        id: 'th-2', kind: 'channel', title: '# market-intel-swarm', unread: 0,
        messages: [
          { id: 'm4', from: 'system', text: 'Swarm deployed · objective: EU AI-agent market map · budget $10', ts: mins(48) },
          { id: 'm5', from: 'agent', agent: 'Content-Weaver', text: 'Structure draft attached. Using 3 buckets: Autonomous agents, Orchestration platforms, Vertical copilots.', ts: mins(44) },
          { id: 'm6', from: 'me', text: 'Looks right. Keep pricing in EUR.', ts: mins(40) },
        ],
      },
      {
        id: 'th-3', kind: 'direct', title: 'SRE-Bot', unread: 1,
        messages: [
          { id: 'm7', from: 'agent', agent: 'SRE-Bot', text: 'Vercel deploy 8f21c is staged and passing checks. Requested production deploy approval (gate: vercel.prod).', ts: mins(6) },
        ],
      },
    ],
    files: [
      { id: 'fl-1', path: 'runs/market-intel/report.md', type: 'md', size: 18422, createdBy: 'Researcher-01', ts: mins(22), content: '# EU AI-agent Market Map\n\n> Draft generated by swarm `market-intel-swarm`.\n\n## 1. Executive summary\n- 20 vendors analyzed...\n## 2. Pricing patterns\n- Seat-based (11), usage-based (6), hybrid (3)...' },
      { id: 'fl-2', path: 'runs/market-intel/vendors.csv', type: 'csv', size: 8211, createdBy: 'Analyst-Prime', ts: mins(18), content: 'vendor,category,pricing_model,starting_price_eur\nAcmeAgents,orchestration,seat,49\nSwarmly,autonomous,usage,0.02/req\n...' },
      { id: 'fl-3', path: 'skills/content.repurpose/skill.md', type: 'md', size: 3120, createdBy: 'Content-Weaver', ts: mins(1500), content: '# content.repurpose\n\nTransform longform into threads + newsletter sections.\n\n## Steps\n1. Extract thesis...\n2. Slice into 6-9 threads...' },
      { id: 'fl-4', path: 'logs/gateway-2026-10-12.log', type: 'log', size: 152880, createdBy: 'system', ts: mins(3), content: '[12:04:01] gateway ok · wal checkpoint\n[12:04:08] mcp call firecrawl.map agent=ag-researcher ok 1.2s\n[12:04:15] approval ap-1 created vercel.deploy' },
      { id: 'fl-5', path: 'configs/routing.yaml', type: 'yaml', size: 1180, createdBy: 'me', ts: mins(1200), content: 'name: default-task-routing\nroute:\n  primary: anthropic/claude-sonnet-4\n  fallbacks: [deepseek/deepseek-v3]\n' },
      { id: 'fl-6', path: 'artifacts/heatmap-positioning.png', type: 'img', size: 240112, createdBy: 'Analyst-Prime', ts: mins(12), content: '(binary image artifact — chart of feature coverage × price)' },
    ],
    events: [
      { id: 'ev-1', ts: mins(1), type: 'mcp', text: 'firecrawl.map called by Researcher-01 · 1.2s · ok' },
      { id: 'ev-2', ts: mins(6), type: 'approval', text: 'Approval requested: vercel.deploy · production (SRE-Bot)' },
      { id: 'ev-3', ts: mins(12), type: 'artifact', text: 'Analyst-Prime wrote artifacts/heatmap-positioning.png' },
      { id: 'ev-4', ts: mins(21), type: 'approval', text: 'Approval requested: db.migrate · staging (Analyst-Prime)' },
      { id: 'ev-5', ts: mins(30), type: 'trust', text: 'Analyst-Prime trust −4 → 58 (cost overrun)' },
      { id: 'ev-6', ts: mins(48), type: 'swarm', text: 'Swarm market-intel-swarm deployed · budget $10' },
    ],
    usage: Array.from({ length: 24 }, (_, i) => ({
      ts: mins((23 - i) * 60), cost: 0.4 + Math.abs(Math.sin(i * 0.7)) * 2.2, tokens: Math.floor(8000 + Math.abs(Math.cos(i * 0.5)) * 30000),
    })),
    telegram: {
      linked: true, botName: '@SwarmOS_ControlBot', allowlist: ['@maya (owner)', '@devon (admin)'],
      topics: { approvals: true, failures: true, deploys: true, budget: true, digest: true },
      messages: [
        { from: 'bot', ts: mins(6), text: '⚠️ Approval needed\nvercel.deploy · production · web-app\nFrom: SRE-Bot · risk: MEDIUM' },
        { from: 'user', ts: mins(5), text: '/status' },
        { from: 'bot', ts: mins(5), text: '✅ Gateway healthy · 4 agents active · 1 swarm live · 2 approvals pending · spend today $17.93' },
      ],
    },
    terminalLines: [
      { kind: 'dim', text: 'SwarmOS shell v0.1.0-proto · type `help` for commands' },
    ],
    pendingQueue: [],
  };
}

/* ---------- store ---------- */
const KEY = 'swarmos-state-v1';
let state = load();
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.agents) return parsed;
    }
  } catch (e) { /* corrupted → reseed */ }
  return seed();
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const s = { ...state, terminalLines: state.terminalLines.slice(-200), events: state.events.slice(0, 80) };
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch (e) { /* storage full or blocked */ }
  }, 250);
}

export function commit(label = '') {
  state.rev += 1;
  persist();
  listeners.forEach((fn) => fn(state, label));
}

export function getState() { return state; }
export function setState(fn, label = '') { fn(state); commit(label); }
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function resetDemo() {
  state = seed();
  commit('reset');
}

export function logEvent(type, text) {
  state.events.unshift({ id: uid('ev'), ts: now(), type, text });
  state.events = state.events.slice(0, 80);
}

export function getAgent(id) { return state.agents.find((a) => a.id === id); }
export function getTeam(id) { return state.teams.find((t) => t.id === id); }
export function pendingApprovals() { return state.approvals.filter((a) => a.status === 'pending'); }
