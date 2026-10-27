/* ============ Copilot facade ============
 * Keeps the historic import surface (`src/copilot.js`) stable for other screens while the
 * implementation lives in focused modules:
 *   copilot/knowledge.js    versioned, source-linked knowledge pack + retrieval
 *   copilot/memory.js       working / episodic / preference memory with redaction
 *   copilot/runtime.js      gateway probe + demo-vs-live labelling
 *   copilot/capabilities.js what this build can and cannot actually do
 *   copilot/orchestrator.js deterministic intent handling + proposals + evidence
 *   copilot/panel.js        FAB target, floating panel, cards, holographic empty state
 */
export {
  openCopilot,
  closeCopilot,
  toggleCopilot,
  isCopilotOpen,
  copilotState,
  resetCopilotSession,
  copilotSay,
  send as copilotSend,
  setMode as setCopilotMode,
} from './copilot/panel.js';

export {
  MODES,
  SUGGESTIONS,
  handle as handleCopilot,
  runProposal,
  cancelProposal,
  resolveMode,
  modeMeta,
  runDiagnostics,
  inspectDataset,
  capabilityCard,
} from './copilot/orchestrator.js';

export { searchKnowledge, getEntry, knowledgeStats, describeScreen, KNOWLEDGE, PACK } from './copilot/knowledge.js';
export { loadMemory, memorySummary, listEpisodes, pushEpisode, clearMemory, exportMemory, redact } from './copilot/memory.js';
export { getRuntime, probeGateway, runtimeLabel } from './copilot/runtime.js';
export { capabilityList, getCapability, STATUS_LABEL } from './copilot/capabilities.js';
