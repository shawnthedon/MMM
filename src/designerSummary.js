/* Neutral one-line mirror of the Agent Designer draft.
 * Exists so synchronous consumers (Copilot knowledge / describeScreen) can describe the designer
 * without importing the whole module or triggering a cycle. designer.js is the only writer. */
let summary = {
  started: false,
  name: '',
  framework: '',
  model: '',
  step: 0,
  definition: 'unchecked',
  activation: 'unchecked',
  canSave: false,
};

export function setDesignerSummary(patch) {
  summary = { ...summary, ...patch };
}

export function getDesignerSummary() {
  return { ...summary };
}
