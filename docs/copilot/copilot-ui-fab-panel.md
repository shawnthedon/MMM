# Copilot UI — FAB, Panel, Holographic Empty State, Cards

| Field | Value |
| --- | --- |
| Parent spec | `Copilot_Master_MMM_V2.md` v1.0 (§2, §3, §2.5, §11) |
| Phase | 1 (landed) |
| Baseline | `66b1bd3` → branch `arena/8f33bbd7-mmm` |
| Files | `src/copilot/panel.js`, `src/copilot.css`, `src/copilot/orchestrator.js`, `src/copilot/knowledge.js`, `src/copilot/memory.js`, `src/copilot/runtime.js`, `src/copilot/capabilities.js`, `src/copilot.js`, `src/shell.js`, `src/main.js`, `src/styles.css` |
| Evidence | `npm run smoke` (28 checks) · `npm run test:copilot` (6 interaction checks) · `npm run build` |
| Status | **PASS for the client-side, demo-runtime scope** — see limitations |

---

## 1. Launcher (§2.1)

- The Copilot button is the **centre slot** of the bottom navigation
  (`Home · Agents · ✦ Copilot · Tasks · More`), not a floating button over content.
  The previous bottom "dock" strip and the separate `+` FAB were removed; quick-create moved
  into the Copilot action tray and the More sheet.
- Accessible name `Open Copilot`, `aria-haspopup="dialog"`, `aria-controls`, and
  `aria-expanded` maintained by the panel on open/close.
- 52 px raised icon inside a ≥44 px slot, safe-area aware via `--safe-b`, distinct
  hover/active/pressed states, `:focus-visible` outline inherited from the design system.

## 2. Panel (§2.2–2.3)

| Requirement | Implementation |
| --- | --- |
| Floating panel anchored to the launcher | Centred above the tab bar on ≥900 px (`min(440px, 100vw-40px)`), near-full-height sheet with margins on narrow screens; both scroll internally. |
| Page context preserved | Panel is mounted outside `#view`; navigation does not unmount it. |
| Draft + mode preserved across close/reopen | `memory.saveWorking()` on every keystroke (debounced 250 ms) and on close; restored on open. Conversation stays in the session. |
| Dismissal | Close button, `Esc`, and — on narrow screens only — the scrim. Draft is already persisted, so dismissal loses nothing. |
| Keyboard | Focus moves into the panel (`tabindex="-1"`) without summoning the mobile keyboard; `Tab`/`Shift+Tab` are trapped and cycle; focus returns to the launcher on close. `Enter` sends, `Shift+Enter` newline. |
| Header | Identity, active mode, live `Demo data · gateway reachable/unreachable` status, details / minimise / close. |
| Context strip | Current screen, pending approval count (opens a live query), gateway probe button, workspace scope. |
| Modes | 7 compact tabs; active mode is always visible; Training/Voice carry a warning flag. |
| Action tray | Explain screen · Diagnose · Status · Approvals · New agent · Quick create. Every chip maps to a real intent. |
| Details drawer | Gateway URL/status/last check, store mode, knowledge pack version + source count, memory usage, mode caveat, re-probe, export memory, clear memory. |
| Composer | Multiline, `maxlength=2000`, send button, Stop while a reply is in flight; voice input and the file picker are intentionally absent rather than faked (no speech engine and no artifact-selection contract for Copilot exist yet). They are listed in §9. |

## 3. Holographic canvas (§2.4)

- `data-blank` on the panel is derived from real state: **no messages and no pending request**.
  A composer alone does not count; timers are not used.
- Blank → animated grid + three blurred gradient blobs (GPU-light, no canvas/WebGL) behind the
  empty-state mark, title, suggestions and provenance line.
- First substantive message flips `data-blank="false"`: the layer fades out with an opacity-only
  transition (no layout shift), its animation is paused, and it never sits behind cards, forms,
  logs or approvals.
- The layer is `aria-hidden="true"` and `pointer-events:none`.
- `prefers-reduced-motion: reduce` removes the fade, the blobs and the panel entry animation.

## 4. Interactive cards (§2.5)

Implemented types, all rendered from escaped strings:

| Card | Behaviour |
| --- | --- |
| Answer | Title + verification badge (`verified` / `observed` / `inferred` / `unknown`) + source list with file paths. |
| Proposal | Risk class, exact values, effects, permissions, rollback limits, 5-minute expiry. `Edit` re-arms review (approval is bound to displayed values); `Cancel` records a cancelled episode. Consequential proposals require **two** confirmations with an explicit warning. |
| Result | Status (`ok` / `failed` / `blocked`), ordered steps with per-step state, verification instruction, simulated-runtime disclosure, sources. |
| Knowledge | Ranked hits with module/type/updated/version, excerpt, verification badge and sources. |
| Diagnostic | Real checks only (connectivity, store, approvals, service worker, `GET /healthz` with a 1.5 s abort) plus a verdict that says what a healthy gateway does *not* prove. |
| Capability | Registry-driven status (`available` / `demo` / `blocked` / `not configured` / `unverified`), why, what is required, and the evidence for the status. No job is created. |
| Activity | Episodic log (intent, outcome, risk, evidence), pending approvals, app event feed, memory usage. |

Legacy support: `copilotSay(text, { title, risk, rows, confirm, run })` from other screens
(terminal, Telegram view) still renders and executes through the same proposal pipeline.

## 5. Modes (§3)

Ask · Operate · Build · Knowledge · Training · Voice · Activity, each with its own landing
state and suggestions. The mode is displayed in the header and message meta. Selection is
never authorisation: governance checks run on the action, not the mode.

Training and Voice do not pretend to work — they return capability cards. Voice answers
"sing" with an explicit unsupported card; Training offers real, limited dataset metadata
checks over File Manager entries and labels everything it cannot verify.

## 6. Grounding and honesty

- Every factual answer carries sources from the knowledge pack
  (`src/copilot/knowledge.js`), which records build version, verification status, update date
  and source file per entry.
- Unknown questions return an explicit "no grounded answer / will not guess" card.
- The header runtime chip is computed from a real `/healthz` probe; the store is labelled demo.
- Proposal results distinguish steps that **could** run from steps that are `blocked`
  (e.g. "Confirm with runtime — no runtime", "Write to hash-chained audit log — server-side").

## 7. Verified behaviour (evidence)

```
npm run smoke   → 28/28 PASS, including:
  copilot launcher is the central bottom-nav action
  copilot panel opens with a blank canvas + holographic layer
  sending a message fades the holographic layer and answers from live state
  consequential action needs two confirmations and records evidence
  creating an agent mutates state and can be verified
  training mode reports the blocker instead of faking a job
  unknown question admits missing evidence
  knowledge search returns sources and verification status
  draft survives closing and reopening the panel
  escape closes the panel and memory redacts secrets
  legacy copilotSay action cards still execute
  gateway probe reports a truthful status
npm run test:copilot → 6/6 PASS, including:
  details drawer, minimise and restore
  every mode answers every suggested prompt without errors
  clearing memory is consequential and requires two steps
  quick create closes the panel and opens the app sheet
  stop cancels an in-flight reply without side effects
  launcher state follows the panel
npm run build   → vite build ok (dist 213 kB js / 33 kB css)
```

The smoke suite also re-renders all 13 existing views after the shell change, so the
navigation restructure did not regress them.

## 8. Not verified / not done

- **Visual review on a physical device was not possible in this environment** (no browser
  binary available in the sandbox). Layout is responsive by construction and covered by DOM
  assertions, but screenshots/recordings required by §14 are still outstanding and must be
  captured by a human or a browser-enabled runner.
- Screen-reader verification (VoiceOver/TalkBack/NVDA) is outstanding; the markup uses dialog
  semantics, labelled controls, `aria-live` for the work area and visible focus, but that is
  not the same as a screen-reader pass.
- Server-side enforcement of approvals, budgets and permissions landed on 2026-10-27
  (`copilot-governance-auth.md`); budget enforcement is still missing.
- No LLM is called; answers are deterministic retrieval + live state.

## 9. Next increments (need decisions first)

1. Gateway auth/RBAC + API client, then route Copilot actions through the runtime (blocker #1
   in `PHASE0_DISCOVERY.md`).
2. Knowledge service: ingestion, revisions, review/approval, rollback (replaces the static pack).
3. Memory service with retention and audit (replaces localStorage for episodes).
4. Training backend contract, then Waveform/audio dataset validation.
5. Voice engine verification (licence + mobile + speech-vs-singing) before any adapter.
6. Composer attachments: needs a file-service selection contract (artifact references with access checks), not just a browser file input.
