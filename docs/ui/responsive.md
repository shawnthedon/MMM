# Mobile-first UI rules

**Enforced by:** `npm run test:responsive` (17 checks) · **Stylesheets:** `src/styles.css`,
`src/comms.css`, `src/skills.css`, `src/copilot.css`, `src/designer.css`

The app is designed for a 320 px phone first and *widens* from there. This is a rule with a test,
not a preference — a regression fails CI.

## The rules

1. **No desktop-first breakpoints.** `@media (max-width: …)` is banned; the test fails on any
   occurrence. Every query is either `(min-width: Npx)` or `(prefers-reduced-motion: reduce)`.
2. **Base styles are the phone layout.** One column, stacked rows, full-width controls. Wider
   screens *add* layout in `min-width` blocks. Breakpoints in use: 381, 480, 520, 560, 900 px.
3. **Rows stack by default.** `.kv` is a column under 480 px and a labelled row above it; rows whose
   control is a switch (`.kv.inline`, or any `.kv` with a direct `.switch`) stay on one line.
4. **Controls are fluid.** `.input.compact` and `.seg.seg-fit` are `width: 100%` on phones and get
   min/max widths at 480 px. No pixel-fixed control widths above 200 px anywhere.
5. **Nothing may force horizontal page scroll.** Long strings use `overflow-wrap: anywhere`
   (`.break`, cards, banners, headings); tile descriptions clamp to two lines; the tab strip and the
   settings tabs scroll horizontally instead of squeezing labels.
6. **Touch targets ≥ 44 px.** The visual switch stays 48 × 28, but `.switch-hit` (Comms tiles) is
   44 × 44 and the global `.switch::before` expands the hit area by 8 px vertically / 6 px
   horizontally.
7. **No nested interactive elements.** A tile is a container with two sibling controls — a settings
   button and an enable switch — because a switch inside a button fires both actions on touch.
8. **Inputs are 16 px.** Anything smaller makes iOS Safari zoom the page on focus.
9. **Pinch zoom is allowed.** `user-scalable=no` / `maximum-scale=1` are removed from the viewport
   meta (WCAG 1.4.4); `viewport-fit=cover` plus `env(safe-area-inset-*)` handles notches and the
   home indicator.
10. **The Copilot panel is a phone sheet by default.** Near-full-height under 900 px; the floating
    440 px card is the wide-screen override.

## Comms specifics

| Concern | Mobile (base) | Wider (`min-width: 560px`) |
| --- | --- | --- |
| Gateway grid | 1 column, full-width tiles | 2 columns |
| Tile body | icon + stacked name/status/description (2-line clamp) + wrapped capability chips | same, roomier padding |
| Enable switch | 44 × 44 hit area, separate button | same |
| Delivery log | stacked: meta line, then wrapping text | meta left, text right |
| Inbound endpoint | horizontally scrollable, `overflow-wrap: anywhere` | same |
| Channel sheet | single-column fields, 16 px inputs, safe-area footer | 16 px side padding |

## How to check a change

```bash
npm run test:responsive   # CSS rules, viewport meta, tap targets, nesting, fluid controls
npm run smoke             # every route still renders
npm run dev               # then resize to 320 / 375 / 414 / 768 px in device toolbar
```

When adding a component: write the phone layout first, add `min-width` queries only when the
content genuinely needs more room, and give every icon-only or switch control a ≥44 px hit area plus
an accessible name.
