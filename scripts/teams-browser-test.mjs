/* Team management panel in a real Chromium — layout, not just markup.
 * Run: npm run test:teams:browser
 * Optional deps: npm install --no-save @sparticuz/chromium puppeteer-core
 *                (and LD_LIBRARY_PATH pointing at the inflated al2023 libs)
 *
 * happy-dom can prove the rules are authored; only a layout engine can prove the panel is a
 * full-height sheet on a phone and a 900px right-hand panel at desktop widths, that nothing overflows
 * at 320px, and that the answers on screen come from the real session state.
 */
import assert from 'node:assert/strict';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';

const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const results = [];
let browser;

try {
  browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    executablePath: process.env.MMM_CHROMIUM_PATH || await chromium.executablePath(),
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;

  const openPanel = async (agentId = 'ag-researcher') => {
    await page.evaluate(async (id) => {
      const panel = await import('/src/team-panel.js');
      panel.openTeamPanel({ agentId: id });
    }, agentId);
    await page.waitForSelector('#tpm-root .tpm-panel');
    await new Promise((r) => setTimeout(r, 220));
  };

  /* ---------- 1. phone: full-height sheet ---------- */
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(`${base}/#/agents`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#view .ag-grid');
  await openPanel();

  const phone = await page.evaluate(() => {
    const panel = document.querySelector('#tpm-root .tpm-panel');
    const rect = panel.getBoundingClientRect();
    const style = getComputedStyle(panel);
    const body = document.querySelector('#tpm-root .tpm-body');
    return {
      width: Math.round(rect.width), height: Math.round(rect.height), top: Math.round(rect.top),
      innerWidth: window.innerWidth, clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth, computedWidth: style.width,
      radius: style.borderTopLeftRadius,
      columns: getComputedStyle(body).gridTemplateColumns.split(' ').length,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      sections: [...document.querySelectorAll('.tpm-section-title, .tpm-section > summary')].map((el) => el.textContent.trim()),
      shortcuts: [...document.querySelectorAll('.tpm-shortcut')].length,
      promptHeight: Math.round(document.querySelector('#tpm-prompt').getBoundingClientRect().height),
      promptScroll: document.querySelector('#tpm-prompt').scrollHeight,
      promptClient: document.querySelector('#tpm-prompt').clientHeight,
      rangeLabel: document.querySelector('#tpm-position-label').textContent.trim(),
    };
  });
  assert.equal(phone.width, 390, `the sheet should fill the phone width, got ${phone.width} (inner ${phone.innerWidth}, client ${phone.clientWidth}, scroll ${phone.scrollWidth}, css ${phone.computedWidth})`);
  assert.equal(phone.height, 844, `the sheet should be full height, got ${phone.height}`);
  assert.equal(phone.top, 0, 'the sheet starts at the top of the screen');
  assert.equal(phone.radius, '0px', 'a full-height sheet has square corners');
  assert.equal(phone.columns, 1, 'the two panes stack on a phone');
  assert.ok(phone.overflowX <= 0, `nothing may overflow horizontally (${phone.overflowX}px)`);
  assert.equal(phone.shortcuts, 4, 'four shortcuts');
  assert.match(phone.rangeLabel, /^\d+ of \d+$/, `the slider label reads “n of m”, got “${phone.rangeLabel}”`);
  assert.ok(phone.promptClient >= phone.promptScroll - 2,
    `the prompt must not be clipped inside its box (client ${phone.promptClient} < scroll ${phone.promptScroll})`);
  for (const label of ['Identity', 'Team assignment', 'Responsibilities', 'Instructions', 'Capabilities', 'Autonomy', 'Status']) {
    assert.ok(phone.sections.some((s) => s.startsWith(label)), `section “${label}” is missing from the rendered panel`);
  }
  results.push('PASS phone: full-height sheet, one column, four shortcuts, prompt unclipped');

  /* ---------- 2. 320px: still usable ---------- */
  await page.setViewport({ width: 320, height: 640, isMobile: true, hasTouch: true });
  await new Promise((r) => setTimeout(r, 200));
  const narrow = await page.evaluate(() => ({
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    panelOverflow: (() => {
      const p = document.querySelector('#tpm-root .tpm-panel');
      return p.scrollWidth - p.clientWidth;
    })(),
    tap: [...document.querySelectorAll('.tpm-shortcut, .tpm-team, .tpm-member-main')]
      .map((el) => Math.round(el.getBoundingClientRect().height)),
  }));
  assert.ok(narrow.overflowX <= 0, `320px must not scroll sideways (${narrow.overflowX}px)`);
  assert.ok(narrow.panelOverflow <= 1, `panel content must not overflow at 320px (${narrow.panelOverflow}px)`);
  assert.ok(narrow.tap.every((h) => h >= 44), `every control needs a 44px target, got ${narrow.tap.join(', ')}`);
  results.push('PASS 320px: no horizontal overflow and every control is a 44px target');

  /* ---------- 3. desktop: docked right, 900px ---------- */
  await page.setViewport({ width: 1280, height: 900, isMobile: true, hasTouch: true });
  await new Promise((r) => setTimeout(r, 250));
  // `isMobile` is kept constant across resizes: toggling it makes Chromium reload the page, and a
  // reload is not what a responsive layout has to survive — the same DOM must reflow.
  const desktop = await page.evaluate(() => {
    const rootEl = document.getElementById('tpm-root');
    if (!rootEl) return { missing: 'no #tpm-root', hash: location.hash };
    const panel = rootEl.querySelector('.tpm-panel');
    if (!panel) return { missing: 'no .tpm-panel', html: rootEl.innerHTML.slice(0, 200) };
    const rect = panel.getBoundingClientRect();
    const body = document.querySelector('#tpm-root .tpm-body');
    const menu = document.querySelector('#tpm-root .tpm-menu');
    const main = document.querySelector('#tpm-root .tpm-main');
    return {
      width: Math.round(rect.width), height: Math.round(rect.height),
      right: Math.round(window.innerWidth - rect.right), left: Math.round(rect.left),
      columns: getComputedStyle(body).gridTemplateColumns,
      menuWidth: Math.round(menu.getBoundingClientRect().width),
      mainWidth: Math.round(main.getBoundingClientRect().width),
      radius: getComputedStyle(panel).borderTopLeftRadius,
    };
  });
  assert.ok(!desktop.missing, `the panel disappeared on resize: ${JSON.stringify(desktop)}`);
  assert.ok(desktop.width >= 900, `the docked panel must be at least 900px wide, got ${desktop.width}`);
  assert.equal(desktop.right, 0, 'the panel is anchored to the right edge');
  assert.ok(desktop.left > 0, 'the scrim area stays visible on the left');
  assert.equal(desktop.height, 900, 'the docked panel is full height');
  assert.equal(desktop.menuWidth, 260, `the team menu is 260px, got ${desktop.menuWidth}`);
  assert.ok(desktop.mainWidth > 500, `the agent pane needs room, got ${desktop.mainWidth}`);
  assert.equal(desktop.radius, '16px', 'the docked panel has a rounded top-left corner');
  results.push(`PASS 1280px: docked right at ${desktop.width}px with a 260px menu and ${desktop.mainWidth}px agent pane`);

  /* ---------- 4. the grid is 1 / 2 / 3 columns ---------- */
  const gridAt = async (width) => {
    await page.setViewport({ width, height: 900, isMobile: true, hasTouch: true });
    await new Promise((r) => setTimeout(r, 220));
    return page.evaluate(() => {
      const grid = getComputedStyle(document.querySelector('#view .ag-grid'));
      return grid.gridTemplateColumns.split(' ').filter(Boolean).length;
    });
  };
  const g1 = await gridAt(390);
  const g2 = await gridAt(720);
  const g3 = await gridAt(1280);
  assert.deepEqual([g1, g2, g3], [1, 2, 3], `the agent grid must be 1/2/3 columns, got ${g1}/${g2}/${g3}`);
  results.push('PASS agent grid: 1 column at 390px, 2 at 720px, 3 at 1280px');

  /* ---------- 5. what is on screen is what the state says ---------- */
  await page.setViewport({ width: 1280, height: 900, isMobile: true, hasTouch: true });
  await new Promise((r) => setTimeout(r, 200));
  const live = await page.evaluate(async () => {
    const core = await import('/src/core.js');
    const agent = core.getAgent('ag-researcher');
    const team = core.teamOf(agent);
    const { position, total } = core.teamPosition(agent);
    return {
      state: { name: agent.name, team: team?.name, position, total, prompt: agent.prompt },
      ui: {
        name: document.querySelector('#tpm-name').value,
        team: document.querySelector('#tpm-team-select option[selected]')?.value,
        teamId: team?.id,
        label: document.querySelector('#tpm-position-label').textContent.trim(),
        prompt: document.querySelector('#tpm-prompt').value,
        panelText: document.querySelector('#tpm-root .tpm-panel').textContent,
      },
    };
  });
  assert.equal(live.ui.name, live.state.name, 'the name on screen is the name in state');
  assert.equal(live.ui.team, live.ui.teamId, 'the selected team is the agent’s team');
  assert.equal(live.ui.label, `${live.state.position} of ${live.state.total}`, 'the slider label matches the state');
  assert.equal(live.ui.prompt, live.state.prompt, 'the whole prompt is on screen');
  assert.ok(live.ui.panelText.includes('Orchestration is not implemented'), 'the orchestration gap is stated on screen');
  assert.ok(live.ui.panelText.includes('applies from the next message'), 'a running agent says when a prompt edit applies');
  results.push('PASS the panel shows the real state (name, team, position, full prompt) and states its limits');

  /* ---------- 6. no page errors along the way ---------- */
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  results.push('PASS no runtime errors while opening, resizing and reading the panel');

  console.log(results.join('\n'));
  console.log(`\nTEAM PANEL (REAL CHROMIUM): ${results.length} passed`);
} catch (error) {
  console.error(results.join('\n'));
  console.error(`\nFAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
}
