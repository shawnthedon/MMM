/* Team management panel + agent grid — happy-dom, real modules, no network.
 * Run: npm run test:teams:ui
 *
 * What is asserted (and what it protects):
 *   • the panel is a full-height sheet on a phone and docks to the right at 900px wide;
 *   • every required section exists, and the prompt is rendered in full — never clamped;
 *   • a running agent says prompt edits apply from the next message;
 *   • suggestions are editable and only applied when their own button is tapped;
 *   • the position slider shows "n of m" and reorders on release;
 *   • the team menu carries real member counts and a ⋯ menu with view/edit/delete;
 *   • the floating "New agent in <team>" carries the team into the designer as an editable suggestion;
 *   • deleting a team asks first and says the members are unassigned, not deleted;
 *   • the agent grid is 1/2/3 columns, cards carry the required fields, inline editing has an explicit
 *     Save, a failed write leaves the card unchanged, and X-delete lists the real consequences;
 *   • four shortcuts, and Chat is disabled unless the agent is running.
 */
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const css = readFileSync(join(root, 'src/team-panel.css'), 'utf8');
const agentsCss = readFileSync(join(root, 'src/agents.css'), 'utf8');
const panelSrc = readFileSync(join(root, 'src/team-panel.js'), 'utf8');

const results = [];
let failures = 0;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); } catch (error) { failures += 1; results.push(`FAIL ${name}: ${error.message}`); }
}
const assert = (cond, message) => { if (!cond) throw new Error(message); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); };
const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

/* ---------- 1. layout contract ---------- */
await check('the panel is a full-height sheet on a phone and a 900px right-hand panel above that', () => {
  assert(!/@media[^{]*max-width/.test(css), 'no max-width media queries — the layout widens, it does not shrink');
  const base = css.match(/\.tpm-panel \{[\s\S]*?\}/);
  assert(base, '.tpm-panel base rule missing');
  assert(/inset: 0/.test(base[0]), 'the base panel covers the viewport');
  assert(/height: 100dvh/.test(base[0]), 'the base panel is full height');
  assert(/border-radius: 0/.test(base[0]), 'a full-height sheet has square corners');
  const wide = css.match(/@media \(min-width: 900px\) \{[\s\S]*?\n\}/);
  assert(wide, 'the 900px dock rule is missing');
  assert(/\.tpm-panel \{[\s\S]*?width: 900px/.test(wide[0]), 'the docked panel must be 900px wide');
  assert(/inset: 0 0 0 auto/.test(wide[0]), 'the docked panel sits on the right');
  assert(/grid-template-columns: 260px minmax\(0, 1fr\)/.test(wide[0]), 'menu and agent sit side by side when docked');
  assert(!/#[0-9a-f]{3,8}\b/i.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'no hard-coded colours');
  assert(/min-height: 44px/.test(css), 'touch targets are 44px');
  const prompt = css.match(/\.tpm-prompt \{[\s\S]*?\}/);
  assert(prompt && /max-height: none/.test(prompt[0]), 'the prompt box must not be capped');
  assert(!/-webkit-line-clamp/.test(css), 'nothing in this panel may clamp the instructions');
});

await check('the agent grid is one, two then three columns and nothing overflows', () => {
  const base = agentsCss.match(/\.ag-grid \{[\s\S]*?\}/);
  assert(base && /grid-template-columns: 1fr;/.test(base[0]), 'the grid starts as one column');
  assert(/@media \(min-width: 560px\) \{[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/.test(agentsCss), 'two columns at 560px');
  assert(/@media \(min-width: 900px\) \{[\s\S]*?repeat\(3, minmax\(0, 1fr\)\)/.test(agentsCss), 'three columns at 900px');
  assert(!/@media[^{]*max-width/.test(agentsCss), 'no max-width queries');
  assert(!/#[0-9a-f]{3,8}\b/i.test(agentsCss.replace(/\/\*[\s\S]*?\*\//g, '')), 'no hard-coded colours');
  assert(/min-width: 0/.test(agentsCss), 'grid cells need min-width:0 so long names wrap instead of overflowing');
});

/* ---------- 2. harness ---------- */
const win = new Window({ url: 'http://localhost:5173/#/agents' });
for (const k of ['document', 'navigator', 'location', 'localStorage', 'history', 'HTMLElement',
  'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame', 'Blob']) {
  const value = win[k] ?? win;
  try { Object.defineProperty(globalThis, k, { value, configurable: true, writable: true }); } catch { try { globalThis[k] = value; } catch {} }
}
globalThis.window = win;
globalThis.document = win.document;
globalThis.localStorage = win.localStorage;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
win.matchMedia = globalThis.matchMedia;
win.document.body.innerHTML = '<div id="app"><div id="view"></div><div id="sheet-root"></div><div id="toast-root"></div></div>';
globalThis.fetch = async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });

await import('../src/main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(140);
const nav = await import('../src/main.js');
const core = await import('../src/core.js');
const shell = await import('../src/shell.js');
const teamPanel = await import('../src/team-panel.js');
const designer = await import('../src/designer.js');

const doc = win.document;
const q = (sel, r = doc) => r.querySelector(sel);
const qa = (sel, r = doc) => [...r.querySelectorAll(sel)];
const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
const view = () => doc.getElementById('view');
const panel = () => q('#tpm-root .tpm-panel');
const confirmShell = () => q('.modal-center .box');

async function openPanelFor(agentId = 'ag-researcher') {
  shell.closeAllSheets();
  q('.modal-center')?.remove();
  nav.navigate('agents');
  await sleep(40);
  teamPanel.openTeamPanel({ agentId });
  await sleep(40);
  assert(panel(), 'the panel did not open');
}

/* ---------- 3. the button on the agent page ---------- */
await check('the agent panel carries the team management button', async () => {
  nav.navigate('agents/ag-researcher');
  await sleep(60);
  const button = q('[data-act="team-panel"]', view());
  assert(button, 'no team management button on the agent page');
  assert(/Team management/i.test(text(button)), 'the button must say what it does');
  click(button);
  await sleep(60);
  assert(panel(), 'tapping it must open the panel');
  shell.closeAllSheets();
});

/* ---------- 4. sections ---------- */
await check('the panel shows every required section for the selected agent', async () => {
  await openPanelFor('ag-researcher');
  const body = text(panel());
  for (const label of ['Identity', 'Team assignment', 'Responsibilities', 'Instructions', 'Capabilities', 'Autonomy', 'Status']) {
    assert(body.includes(label), `section “${label}” is missing`);
  }
  eq(qa('#tpm-root .tpm-shortcut').length, 4, 'there must be exactly four shortcuts');
  // identity
  assert(q('#tpm-name').value === 'Researcher-01', 'the name field carries the real name');
  assert(q('#tpm-role').value.length > 0, 'the role field carries the real role');
  assert(q('#tpm-description').value.length > 0, 'the description field carries the real description');
});

await check('the instructions are shown in full and are never truncated', async () => {
  const agent = core.getAgent('ag-researcher');
  const prompt = q('#tpm-prompt');
  assert(prompt, 'prompt field missing');
  eq(prompt.value, agent.prompt, 'the textarea holds the entire prompt, character for character');
  assert(!prompt.hasAttribute('maxlength'), 'the prompt must not be length-capped in the UI');
  eq(q('#tpm-goal').value, agent.goal, 'the goal field holds the stored goal');
  const style = css.match(/\.tpm-prompt \{[\s\S]*?\}/)[0];
  assert(/max-height: none/.test(style) && !/text-overflow/.test(style), 'CSS must not hide part of the prompt');
});

await check('a running agent says prompt edits apply from the next message', async () => {
  const agent = core.getAgent('ag-researcher');
  eq(agent.status, 'running', 'fixture must be running for this check');
  assert(/applies from the next message/i.test(text(panel())), 'the note about the next message is missing while running');
  const stale = core.getAgent('ag-content');
  eq(stale.status, 'idle', 'the comparison agent is idle');
  await openPanelFor('ag-content');
  assert(!/applies from the next message/i.test(text(panel())), 'an idle agent must not claim anything about the next message');
});

/* ---------- 5. team assignment + slider ---------- */
await check('the team assignment shows the team and a position slider reading n of m', async () => {
  await openPanelFor('ag-researcher');
  const select = q('#tpm-team-select');
  assert(select, 'team select missing');
  // happy-dom mis-selects on `selected` attributes, so assert the markup a real browser obeys.
  eq(q('option[selected]', select)?.value, core.getAgent('ag-researcher').teamId, 'the select shows the agent’s real team');
  const range = q('#tpm-position');
  assert(range, 'position slider missing');
  const { position, total } = core.teamPosition(core.getAgent('ag-researcher'));
  eq(Number(range.max), Math.max(1, total), 'the slider is bounded by the real team size');
  eq(Number(range.value), position, 'the slider sits at the real position');
  assert(text(panel()).includes(`${position} of ${total}`), 'the label must read “n of m”');
  assert(range.getAttribute('aria-valuetext') === `${position} of ${total}`, 'the value is announced');
});

await check('releasing the slider reorders the team and writes the new order', async () => {
  await openPanelFor('ag-researcher');
  const range = q('#tpm-position');
  const team = core.teamOf(core.getAgent('ag-researcher'));
  const before = core.teamMembers(team.id).map((m) => m.id);
  const target = Number(range.max);
  range.value = String(target);
  range.dispatchEvent(new win.Event('input', { bubbles: true }));
  assert(text(panel()).includes(`${target} of ${before.length}`), 'the label follows the thumb while dragging');
  range.dispatchEvent(new win.Event('change', { bubbles: true }));
  await sleep(80);
  const after = core.teamMembers(team.id).map((m) => m.id);
  eq(after[target - 1], 'ag-researcher', 'the agent moved to the position shown on the slider');
  eq(after.length, before.length, 'nobody was dropped from the team');
  after.forEach((id, i) => eq(core.getAgent(id).teamPosition, i + 1, 'positions stay dense after the move'));
});

/* ---------- 6. responsibilities & suggestions ---------- */
await check('responsibilities can be added and removed, and every write is explicit', async () => {
  await openPanelFor('ag-coder');
  const agent = core.getAgent('ag-coder');
  const before = [...agent.responsibilities];
  click(q('[data-act="tpm-remove-resp"]', panel()));
  await sleep(60);
  eq(core.getAgent('ag-coder').responsibilities.length, before.length - 1, 'the remove button applies immediately');

  q('#tpm-resp-new').value = 'Name the rollback step';
  click(q('[data-act="tpm-add-resp"]', panel()));
  await sleep(60);
  assert(core.getAgent('ag-coder').responsibilities.includes('Name the rollback step'), 'the added responsibility is stored');
});

await check('a suggestion is editable and only applied when its own button is tapped', async () => {
  await openPanelFor('ag-coder');
  const suggestions = qa('[data-suggest]', panel());
  assert(suggestions.length > 0, 'no suggestions rendered for an agent with a role and skills');
  const input = suggestions[0];
  const key = input.dataset.suggest;
  const before = [...core.getAgent('ag-coder').responsibilities];
  input.value = 'Edited suggestion text';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  await sleep(40);
  eq(core.getAgent('ag-coder').responsibilities.length, before.length, 'typing must not write anything');
  assert(!core.getAgent('ag-coder').responsibilities.includes('Edited suggestion text'), 'typing must not apply the suggestion');

  // A repaint (a poll, a live update) must keep the draft text and still not write it.
  teamPanel.rerenderPanel();
  await sleep(40);
  eq(q(`[data-suggest="${key}"]`, panel()).value, 'Edited suggestion text', 'the draft survives a repaint');
  eq(core.getAgent('ag-coder').responsibilities.length, before.length, 'a repaint must not apply anything either');

  click(q(`[data-act="tpm-apply-suggestion"][data-index="${key.split(':')[1]}"]`, panel()));
  await sleep(60);
  assert(core.getAgent('ag-coder').responsibilities.includes('Edited suggestion text'), 'tapping Add applies the edited text');
});

/* ---------- 7. capabilities, autonomy, status ---------- */
await check('capabilities are grouped into tool families and the autonomy section is honest', async () => {
  await openPanelFor('ag-coder');
  const families = qa('.tpm-cap', panel()).map((el) => text(el));
  assert(families.some((f) => /^github/.test(f)), 'tool families are grouped by prefix');
  assert(text(panel()).includes('dev.tdd-loop'), 'skills are listed');
  assert(/Orchestration is not implemented/i.test(text(panel())), 'the panel must state that orchestration is not implemented');
  assert(/Nothing schedules this agent/i.test(text(panel())), 'and say what that means');
  const gates = qa('[data-gate]', panel());
  eq(gates.length, 3, 'three approval gates are exposed');
});

await check('saving autonomy is an explicit write and never claims enforcement it lacks', async () => {
  await openPanelFor('ag-coder');
  q('#tpm-behaviour').value = '4';
  qa('[data-gate]', panel()).forEach((box) => { if (box.dataset.gate === 'beforeSpend') box.checked = true; });
  click(q('[data-act="tpm-save-autonomy"]', panel()));
  await sleep(60);
  const agent = core.getAgent('ag-coder');
  eq(agent.autonomy, 4, 'the behaviour level is stored');
  eq(agent.approvalGates.beforeSpend, true, 'the gate change is stored');
});

/* ---------- 8. shortcuts ---------- */
await check('the four shortcuts exist and Chat is only enabled for a running agent', async () => {
  await openPanelFor('ag-researcher');
  const shortcuts = qa('#tpm-root .tpm-shortcut');
  const labels = shortcuts.map((s) => text(s));
  assert(labels.some((l) => /Skills/.test(l)), 'Skills shortcut');
  assert(labels.some((l) => /Tools & MCP/.test(l)), 'Tools and MCP shortcut');
  assert(labels.some((l) => /Chat/.test(l)), 'Chat shortcut');
  assert(shortcuts.length === 4, 'exactly four shortcuts');
  const chat = q('[data-act="tpm-shortcut-chat"]', panel());
  eq(chat.hasAttribute('disabled'), false, 'a running agent can open chat');
  assert(/Selects this agent/.test(text(chat)), 'the shortcut says what it does');

  await openPanelFor('ag-content');
  const idleChat = q('[data-act="tpm-shortcut-chat"]', panel());
  eq(idleChat.hasAttribute('disabled'), true, 'an idle agent must not offer chat');
  assert(/Disabled · agent is idle/.test(text(idleChat)), 'and must give the reason');
  assert(/title="Chat needs a running agent/.test(panel().innerHTML), 'the disabled control explains itself');
});

await check('the Skills shortcut filters the Skills Hub to that agent', async () => {
  await openPanelFor('ag-researcher');
  click(q('[data-act="tpm-shortcut-skills"]', panel()));
  await sleep(120);
  eq(doc.getElementById('tpm-root'), null, 'the panel closes');
  assert(/Filtered to/.test(text(view())), 'the Skills screen says it is filtered');
  assert(/Researcher-01/.test(text(view())), 'and names the agent');
  click(q('[data-act="skill-agent-filter-clear"]', view()));
  await sleep(80);
  assert(!/Filtered to/.test(text(view())), 'the filter can be cleared');
});

/* ---------- 9. team menu, ⋯ menu, floating new agent ---------- */
await check('the left menu shows real member counts and a three-dot menu per team', async () => {
  await openPanelFor('ag-researcher');
  const rows = qa('.tpm-team', panel());
  assert(rows.length >= 3, 'every team plus “No team” is listed');
  const team = core.getState().teams[0];
  const row = rows.find((r) => r.textContent.includes(team.name));
  assert(row, 'the team row is missing');
  assert(new RegExp(String(core.teamMembers(team.id).length)).test(text(row)), 'the row shows the real member count');
  click(q(`[data-act="tpm-team-menu"]`, panel()));
  await sleep(40);
  const menu = q('.tpm-menu-pop', panel());
  assert(menu, 'the ⋯ menu did not open');
  const items = qa('[role="menuitem"]', menu).map((i) => text(i));
  assert(items.some((i) => /View team/.test(i)), 'View team');
  assert(items.some((i) => /Edit team/.test(i)), 'Edit team');
  assert(items.some((i) => /Delete team/.test(i)), 'Delete team');
});

await check('editing a team writes the new name only when Save is tapped', async () => {
  await openPanelFor('ag-researcher');
  click(q('[data-act="tpm-team-menu"]', panel()));
  await sleep(30);
  click(q('[data-act="tpm-team-edit"]', panel()));
  await sleep(60);
  assert(q('#tpm-team-name'), 'the edit form did not appear');
  const team = core.getState().teams[0];
  q('#tpm-team-name').value = 'Research Guild';
  await sleep(20);
  eq(core.getState().teams[0].name, team.name, 'typing must not rename anything');
  click(q('[data-act="tpm-save-team"]', panel()));
  await sleep(80);
  eq(core.getState().teams[0].name, 'Research Guild', 'Save writes the name');
});

await check('deleting a team asks first, says members are unassigned, and never deletes an agent', async () => {
  await openPanelFor('ag-researcher');
  const team = core.getState().teams.find((t) => t.id === 'tm-ops');
  const members = core.teamMembers(team.id);
  assert(members.length >= 2, 'the team under test needs members');
  const agentsBefore = core.getState().agents.length;

  click(q('[data-act="tpm-team-menu"]', panel()));
  await sleep(30);
  // Select the Ops Crew row first so the ⋯ menu belongs to it.
  click(qa('.tpm-team', panel()).find((r) => r.textContent.includes(team.name)));
  await sleep(40);
  click(q('[data-act="tpm-team-menu"]', panel()));
  await sleep(30);
  click(q('[data-act="tpm-team-delete"]', panel()));
  await sleep(60);

  const modal = confirmShell();
  assert(modal, 'no confirmation dialog');
  const body = text(modal);
  assert(/unassigned/i.test(body), 'the confirmation must say the members are unassigned');
  assert(/teamId → null/.test(body), 'and show the exact change');
  assert(/not deleted and not moved/i.test(body), 'and say nothing is deleted or moved');
  members.forEach((m) => assert(body.includes(m.name), `the confirmation must name ${m.name}`));

  assert(core.getState().agents.length === agentsBefore, 'nothing is deleted before confirming');
  q('#confirm-text').value = 'DELETE';
  click(q('#confirm-ok'));
  await sleep(120);

  eq(core.getState().agents.length, agentsBefore, 'no agent row was removed');
  members.forEach((m) => {
    const agent = core.getAgent(m.id);
    assert(agent, `${m.name} was deleted`);
    eq(agent.teamId, null, `${m.name} must be unassigned`);
  });
  eq(core.getState().teams.some((t) => t.id === team.id), false, 'the team is gone');
  core.getState().teams.forEach((t) => {
    members.forEach((m) => assert(!core.teamMembers(t.id).some((x) => x.id === m.id), `${m.name} was silently moved to ${t.name}`));
  });
  doc.querySelector('.modal-center')?.remove();
});

/* ---------- 10. the designer suggestion ---------- */
await check('“New agent in <team>” carries the team into the designer as an editable suggestion', async () => {
  await openPanelFor('ag-researcher');
  const team = core.getState().teams.find((t) => t.id === 'tm-red');
  const fab = q('[data-act="tpm-new-agent"]', panel());
  assert(fab, 'the floating new-agent action is missing');
  assert(text(fab).includes(team.name) || fab.textContent.includes(core.getState().teams[0].name), 'it names the team it will use');

  // Click the action for a known team so the assertion can be exact.
  await teamPanel.openTeamPanel({ teamId: team.id, agentId: core.teamMembers(team.id)[0]?.id });
  await sleep(40);
  click(q('[data-act="tpm-new-agent"]', panel()));
  await sleep(160);
  eq(doc.getElementById('tpm-root'), null, 'the panel closes so the designer is usable');
  eq(nav.routeKey(), 'designer', 'the designer opened');
  const draft = designer.getDraft();
  eq(draft.teamId, team.id, 'the team is on the draft');
  eq(draft.teamSuggested, true, 'and it is marked as a suggestion, not a decision');
  const suggestion = q('.dsn-team-note', view());
  assert(suggestion, 'the designer shows the suggestion');
  assert(/Suggested from the team panel/.test(text(suggestion)), 'it says where it came from');
  assert(/nothing is assigned until you save/i.test(text(suggestion)), 'and that nothing is written yet');
  const select = q('[data-dsn="teamId"]', suggestion);
  assert(select, 'the suggestion is editable');
  eq(q('option[selected]', select)?.value, team.id, 'the select shows the suggested team');
  click(q('[data-act="dsn-team-clear"]', suggestion));
  await sleep(60);
  eq(designer.getDraft().teamId, null, 'clearing really clears it');
  assert(!q('.dsn-team-note.is-suggestion', view()), 'the suggestion badge is gone once it is cleared');
});

/* ---------- 11. the grid ---------- */
await check('the agent grid renders a card per agent with the required fields', async () => {
  shell.closeAllSheets();
  nav.navigate('agents');
  await sleep(60);
  const cards = qa('.ag-grid > .ag-cell');
  eq(cards.length, core.getState().agents.length, 'one card per agent');
  const card = cards[0];
  assert(q('.ag-open', card), 'each card opens the agent');
  assert(q('.ag-card .chip', card), 'lifecycle and capability chips');
  assert(q('[data-act="agent-delete-x"]', card), 'each card carries an X delete control');
  assert(/of \d+|No team/.test(text(card)), 'the card shows the team and position');
  assert(q('[data-act="agent-edit"]', card), 'inline editing is reachable from the card');
  cards.forEach((c) => {
    assert(c.hasAttribute('data-swipe-card'), 'each card keeps its swipe wrapper');
    assert(q('[data-side="left"]', c) && q('[data-side="right"]', c), 'run and stop layers survive');
    assert(q('.swipe-surface[data-act="open-agent"]', c), 'the swipe surface still opens the agent');
  });
});

await check('inline editing covers name, role and team with an explicit Save', async () => {
  nav.navigate('agents');
  await sleep(60);
  click(q('[data-act="agent-edit"]', view()));
  await sleep(60);
  const agent = core.getState().agents[0];
  assert(q(`#ag-name-${agent.id}`), 'the name field appears in place');
  assert(q(`#ag-role-${agent.id}`), 'the role field appears in place');
  assert(q(`#ag-team-${agent.id}`), 'the team select appears in place');
  q(`#ag-name-${agent.id}`).value = 'Renamed-01';
  q(`#ag-role-${agent.id}`).value = 'Renamed role';
  await sleep(20);
  eq(core.getAgent(agent.id).name, agent.name, 'typing changes nothing until Save');
  click(q(`[data-act="agent-save"][data-id="${agent.id}"]`, view()));
  await sleep(80);
  eq(core.getAgent(agent.id).name, 'Renamed-01', 'Save writes the name');
  eq(core.getAgent(agent.id).role, 'Renamed role', 'Save writes the role');
  assert(q('[data-act="agent-edit"]', view()), 'the card returns to its normal state');
});

await check('a failed write leaves the card unchanged', async () => {
  nav.navigate('agents');
  await sleep(60);
  const agent = core.getState().agents.find((a) => a.name === 'Renamed-01') || core.getState().agents[0];
  click(q(`[data-act="agent-edit"][data-id="${agent.id}"]`, view()));
  await sleep(60);
  q(`#ag-name-${agent.id}`).value = '';
  click(q(`[data-act="agent-save"][data-id="${agent.id}"]`, view()));
  await sleep(60);
  eq(core.getAgent(agent.id).name, agent.name, 'an empty name is refused and the row is untouched');
  assert(q('#toast-root') && /Nothing was changed/i.test(text(doc.getElementById('toast-root'))), 'the refusal is reported');
  click(q('[data-act="agent-edit-cancel"]', view()));
  await sleep(40);
});

await check('the X delete asks for confirmation and lists the real consequences', async () => {
  nav.navigate('agents');
  await sleep(60);
  const agent = core.getState().agents.find((a) => a.teamId);
  const teamName = core.teamOf(agent).name;
  const before = core.getState().agents.length;
  click(q(`[data-act="agent-delete-x"][data-id="${agent.id}"]`, view()));
  await sleep(60);
  const modal = confirmShell();
  assert(modal, 'X must ask before deleting');
  const body = text(modal);
  assert(/soft delete/i.test(body), 'the consequences say the row is kept');
  assert(body.includes(teamName), 'it names the team the agent leaves');
  assert(/prompt, skills and capabilities are not copied anywhere/i.test(body), 'it says what is not copied');
  eq(core.getState().agents.length, before, 'nothing is deleted until confirmed');
  click(q('#confirm-cancel'));
  await sleep(40);
  eq(core.getState().agents.length, before, 'cancelling keeps the agent');
});

/* ---------- 12. static honesty ---------- */
await check('the module never invents membership or writes on typing', () => {
  assert(!/teams\[[^\]]*\]\.members\.push/.test(panelSrc), 'membership must never be pushed into a team array');
  assert(/agents\.team_id|agent\.teamId/.test(panelSrc), 'membership is read from the agent row');
  assert(/drafts\.set/.test(panelSrc) && /drafts\.delete/.test(panelSrc), 'suggestion drafts are held locally');
  assert(/unassigned/i.test(panelSrc) && /not deleted and not moved/i.test(panelSrc), 'the delete copy states the rule');
  assert(/Orchestration is not implemented/.test(panelSrc), 'the orchestration gap is stated in code, not just on screen');
  assert(/applies from the next message/.test(panelSrc), 'the running-agent note is part of the module');
});

console.log(results.join('\n'));
const passed = results.filter((r) => r.startsWith('PASS')).length;
console.log(`\nTEAM PANEL + AGENT GRID: ${passed} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
