# Kanban board: zoom, dependency wires, confirmed moves, Copilot control

Shipped in the same round as this document. The board is the first screen where a drag, a drawer chip
and a Copilot sentence can all change the same data, so the whole surface is built around **one write
seam**.

```
src/kanban.js      ← all board logic + the command parser (no DOM, no rendering)
src/views1.js      ← views.tasks (toolbar, columns, cards, drawer) + enableKanbanDrag + drawWires
src/kanban.css     ← toolbar, zoomed track, wire layer, cards (mobile first)
scripts/kanban-test.mjs   ← npm run test:kanban (26 checks)
```

## 1. One seam

| function | what it does | confirmation |
| --- | --- | --- |
| `moveTask(id, column)` | moves a card (the only path in the UI) | **yes**, always |
| `commitMove(id, column)` | the writer; gateway `PATCH` or demo `setState` + one event | no (internal) |
| `assignTask(id, agentOrName)` | assign / unassign, name or id | no |
| `setPriority(id, p)` | `low` / `med` / `high` (aliases accepted) | no |
| `renameTask(id, title)` | retitle, ≤ 120 chars | no |
| `linkDeps(id, blockerId)` | add a dependency, rejects cycles | no |
| `unlinkDeps(id, blockerId)` | remove a dependency | no |
| `deleteTask(id)` | remove a card | **yes**, two-step, danger styling |
| `setZoom`, `zoomBy`, `fitZoom` | zoom 70–150 % in 10 % steps | — |
| `toggleWires`, `wiresEnabled` | show/hide the wire layer | — |
| `setFilter`, `clearFilter`, `visibleTasks` | agent / priority filter | — |
| `boardStats`, `dependencyEdges`, `wirePaths` | pure read helpers (used by tests + Copilot) | — |

`views1.js` contains no column assignment other than the local *Run with agent* shortcut, which starts
a run instead of moving a card (it already refuses on a gateway). The test asserts that.

### Gateway vs demo

* Gateway (`isLive('tasks')`): `moveTask` → `updateTask` → `PATCH /api/v1/tasks/:id` with
  `column_name` (RBAC `task:write`). The server row wins; a refusal is reported as
  `Gateway refused: …` and the card stays where it was.
* Demo: `setState` + exactly one `logEvent('task', …)`.
* **Dependencies are local-only.** The gateway has no `tasks.deps` column, so `linkDeps` returns
  `{ ok: false }` in gateway mode rather than writing state that the server never saw. The same is
  true for `deleteTask` (no delete endpoint). Both are stated in the reply/toast.

## 2. Zoom

`−  100%  +  Fit`, steps of 10 %, clamped **70–150 %**, persisted as `state.board.zoom` (survives a
re-render and a reload; the workspace store is written to `localStorage` by `core.commit`).

The value is applied as `--kb-zoom` on `.kb-track`, which the stylesheet feeds to the CSS `zoom`
property. Why not `transform: scale()`:

* a transform does not grow the scrollable area, so the far columns become unreachable — the
  `overflow-x` parent still thinks the track is its original width;
* `zoom` scales every card, chip, avatar and font together (a transform would leave hit-target
  text unscaled while the boxes grow);
* both keep `getBoundingClientRect()` and `elementFromPoint()` truthful, which is what the drag and
  the wire layer rely on. Drops therefore land in the column under the pointer at 70 %, 100 % and
  150 % without dividing pointer deltas by anything.

Scroll position is preserved across zoom changes (`kbScroll()` restores `scrollLeft`).

## 3. Dependency wires

* Data: every task already carries `deps: [blockerId, …]`.
* Render: `<svg class="kb-wires">` positioned over the board (outside the scroller, so it never
  affects scroll width), `pointer-events: none`, one `<path>` per edge plus a per-state arrow marker.
* Geometry (`wirePaths`): leaves the blocker's **right** edge, arrives at the dependent's **left**
  edge, cubic Bézier with a control offset of `max(32px, 45 % of the horizontal gap)`.
* Recomputed on render, `ResizeObserver` (board + track), window resize, horizontal scroll, zoom and
  every drag move.
* Edges whose endpoint is not rendered (filtered out, collapsed, scrolled away) are **skipped and
  counted** — no guessed line is ever drawn. `layer.dataset.drawn` and the stats line report the
  number actually drawn.
* Edges whose blocker is in **Done** get `.dim` (dashed, muted): the dependency is satisfied.
* Auto-enable: `wires: null` means "on below 900 px, off on wider screens". The **Wires** chip shows
  the edge count, toggles explicitly and sets `aria-pressed`.

## 4. Confirmation on every move

`moveTask` awaits `confirmModal()` (which now resolves `'confirm' | 'cancel'`) before touching state:

> Move **"Collect eval prompts"** from **Backlog** to **Done**? — *Cancel* / **Move card**

* Cancel, scrim tap or Escape → `{ cancelled: true }`, no state change, no event, the card snaps back
  (it was never moved in the DOM).
* Confirm → one `commitMove` → one event.
* The same function serves drag-and-drop, the drawer's column chips and the Copilot, so no code path
  can move a card without the prompt.

## 5. Copilot intents

All routed through `kanbanCommand(raw)` in `src/kanban.js`, which returns `null` for text that is not
about the board so the rest of the router keeps working.

| intent | example |
| --- | --- |
| move | `move Ship the report to review` (asks first) |
| assign / unassign | `assign Ship the report to Nova` · `unassign Archive old runs` |
| priority | `set priority high on Score runs` |
| rename | `rename Score runs to Score the runs` |
| link / unlink | `link Archive old runs depends on Collect eval prompts` |
| delete | `delete card Archive old runs` (two-step) |
| create | `create task Write the changelog` (demo store only) |
| zoom | `zoom the board to 120%` · `zoom in` / `zoom out` |
| wires | `show wires` · `hide the wires` |
| filter | `filter board by agent Nova` · `filter board by priority high` · `clear filter` |
| summary | `board status` |

Card lookup is exact id → exact title → unique substring → unique token overlap. Ambiguity and
unknown columns are **errors**, never a guess. `describeScreen('tasks')` reports column counts,
dependency links, blocked cards, zoom and wire state.

## 6. Limits (stated, not hidden)

* No gateway persistence for dependencies, ordering within a column or board preferences; they live
  in the browser store and are labelled as local.
* No card reordering inside a column, no multi-select, no keyboard move yet (cards are focusable and
  open the drawer; the drawer chips are the keyboard path).
* Wires are drawn between rendered cards only; a filtered board draws a subset (by design).
* `zoom` is a modern CSS property (Chrome/Edge/Safari 16.4+/Firefox 126+). On older engines the board
  still works at 100 % — nothing else depends on it.

## 7. Evidence

`npm run test:kanban` — 26 checks: stylesheet contract (track zoom, inert wire layer, 44 px targets),
zoom clamps/steps/persistence/re-render, wire geometry (start/end coordinates, dim, skipped edges),
rendered path count against a fixture layout, wires auto-on/off and toggle, cancel vs confirm for
drop and drawer, single write seam, all Copilot intents including refusals and the delete two-step,
gateway refusal honesty, and `describeScreen('tasks')`.

A drop at 70 %/150 % landing in the right column is covered structurally (no pointer-delta maths, no
per-column transform) plus a real-browser check in the preview build; there is no headless layout
engine in this repository, so pixel positions are asserted through `wirePaths` with fixture rects.
