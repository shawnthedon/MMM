# RELAY design system — implementation notes

Status: **implemented for the shipped PWA shell and Command deck**, with the exceptions listed
under “Deliberate deviations and gaps”. This document records what the code actually does; it is not
a claim that the six-stage mission in `docs/copilot/MISSION_VERIFICATION.md` is complete.

## Tokens

`src/theme.css` is the only stylesheet allowed to contain literal colours. It defines the semantic
RELAY palette and four scoped token sets:

| Mode | Selector | Notes |
| --- | --- | --- |
| Dark (default) | `:root, [data-theme='dark']` | `#0B0F17` base, `#111827` surface, `#3B82F6` accent. |
| Light | `[data-theme='light']` | Full light surface set; status colours darken to keep AA contrast. |
| OLED black | `[data-theme='oled']` | True-black `--bg-base`/`--bg-surface`, inherited typography and states. |
| High contrast | `[data-theme='high-contrast']` | Pure black base, brighter text/status tokens and stronger borders. |

Legacy module variables (`--bg`, `--surface`, `--brand`, `--text-2`, …) are aliases of the RELAY
tokens, so existing modules inherit every mode without component edits. New work should use the
semantic names directly. `tailwind.config.js` maps each semantic token to a utility colour, and
`src/styles.css` includes the `@tailwind utilities` layer; the shell’s component classes remain
hand-authored CSS because the repository does not ship React/shadcn components.

Appearance mode is selected in **Settings → Appearance** and applied by `applyTheme()` in
`src/shell.js` (`data-theme` on `<html>` plus the `theme-color` meta). Unknown values fall back to
dark. `index.html` paints a dark background inline before styles or JavaScript load so no route can
flash white.

## Contrast rules

`--accent-primary` is never a solid fill for text-bearing controls. Primary buttons, active
segments, send buttons and filled badges use `--accent-hover` at rest and `--accent-pressed` on
hover/press; destructive fills use `--state-error-strong`. The accent token is reserved for icons,
dots, rings, borders and accent text on `--bg-base`/`--bg-surface`.

Status chips and banners tint the card surface with **5%** of the status colour, not 10%. The
`npm run test:design` suite computes WCAG ratios from the tokens for every mode:

- body text (`--text-primary`, `--text-muted`) on base, surface and elevated;
- accent and status text on base and surface;
- `--text-on-accent` on accent-hover, accent-pressed and error-strong;
- status text on its own 5% tint.

All checked pairs meet **4.5:1**, not the large-text 3:1 exemption. Status is always paired with a
text label (`running`, `paused`, `demo`, `approved`, …); colour is never the only signal.

## Components and layout

- **Mobile (base styles):** fixed top bar with the workspace mark, identity, Chat, notifications,
  and Settings; scrollable view; persistent five-slot bottom navigation (Home, Agents, Copilot,
  Tasks, More). Secondary modules live in the four-column All modules sheet. Dialogs are
  bottom-anchored sheets; confirmation dialogs are centred.
- **Desktop (`min-width: 1100px`):** persistent 232 px sidebar (workspace, primary modules, Copilot
  launcher, Settings), the top bar becomes a contextual header, the bottom navigation disappears,
  and Copilot becomes a 400 px right-side inspector. The centre canvas expands to 1360 px.
- **Command deck:** new workspace overview using metric cards, fleet telemetry cards, active swarms,
  event stream and quick actions. It follows the mobile-first rule (two columns at 320 px, four
  metrics, three agent cards and split panels only from 640/1024 px) and labels demo versus gateway
  data instead of presenting simulated values as live telemetry.
- **Touch targets:** top-bar actions, `.btn`, `.btn.sm`, segmented controls, tab buttons, sheet
  switches and desktop links are at least 44 px. Switch rows expose `role="switch"`,
  `aria-checked` and Enter/Space activation.
- **Focus and motion:** a 2 px `:focus-visible` ring is global; animation is disabled under
  `prefers-reduced-motion: reduce`.

## Scrolling and scroll continuity

The shell re-renders `#view` whenever state changes — the live simulation tick (every 4.2 s), gateway
syncs, and most actions. Rendering must never move the reader, so `src/main.js` separates navigation
from updates:

- **Navigation resets:** `navigate()`, a route change via the hash, and a new record (`route/id`) all
  start at the top. The router tracks the rendered view key, so a re-render triggered by anything
  else is treated as an update.
- **Updates preserve:** every other render captures the window scroll, `#view.scrollTop`, the kanban
  board (`#kb-viewport.scrollLeft`), each kanban column (`.kanban-cards[data-drop]`) and sheet bodies
  before replacing the DOM, then restores them.
- **Gestures are not interrupted:** while a scroll is in progress (or within 450 ms of the last
  scroll event) a render is deferred, so replacing the DOM cannot kill touch momentum. The deferral
  is capped at 2.5 s so live data never starves.
- Content padding always clears the fixed bottom navigation, so the final element is reachable and
  not hidden behind the tab bar.

## Verification

| Command | Scope |
| --- | --- |
| `npm run test:design` | Token completeness, palette values, WCAG pairs, 5% tints, no stray hex colours, accent-fill rule, Tailwind mapping, 44 px targets, switch semantics, responsive shell. |
| `npm run test:responsive` | Authored-CSS mobile-first rules, viewport zoom, 320 px layout constraints, existing Comms regressions. |
| `npm run test:scroll` | Scroll continuity contract in happy-dom: re-renders and the simulation tick preserve the position, navigation resets, inner scrollers and gesture deferral. |
| `npm test` | Full application, gateway, Comms, session and service-worker suites. |
| `npm run test:scroll:browser` | Optional real Chromium: bottom reachable on every long route (390 px and 320 px), no snap-back across ticks, live updates still render, navigation resets, kanban horizontal position kept, desktop parity. |
| `npm run test:relay:browser` | Optional real Chromium: 320/390/1440 px layout, 44 px header targets, four-column module sheet, four theme modes and persistence, desktop Copilot placement, no page errors. Requires `npm install --no-save @sparticuz/chromium puppeteer-core`. |

## Deliberate deviations and gaps

- The spec’s component library names shadcn/ui, Radix, Lucide React and Framer Motion. This
  repository is a vanilla ES-module PWA with its own inline SVG icon set and CSS transitions. The
  design language, tokens, semantics and responsive behaviour were implemented; those React
  dependencies were not added because there is no React runtime to host them.
- The previous navigation contract from request #7 is preserved: Chat stays in the header, Tasks
  stays in the bottom bar, and the module sheet keeps identical four-column tiles. The desktop
  sidebar exposes the full module list instead of a separate “Grid” route.
- Light, OLED and high-contrast modes are token sets verified in real Chromium for selection and
  persistence. Their contrast is checked by token maths; a full manual visual review of every module
  in every mode, and browser/mobile device testing beyond Chromium, remain outstanding.
- The Command deck’s swarms, spend and events are the existing demo fixtures when no gateway slice
  is live. Agent/task provenance is labelled; this is not production telemetry.
- Custom accent presets, font scale, reduced-motion override and sandboxed custom CSS from the
  broader appearance requirement are **not** implemented.
