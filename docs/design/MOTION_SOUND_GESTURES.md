# Motion, sound and gesture system

Status: **shipped** · anime.js **4.5.0** (MIT) · branch `arena/4a49ef2e-mmm` · 2026-10-28.

One rule governs this work: **animation is decoration, never state.** Every animated surface is
fully usable with animations switched off, and no UI can be left half-visible because an
animation did not run.

---

## 1. Files

| File | Responsibility |
| --- | --- |
| `src/motion.js` | the only module that imports anime.js; page transitions, sheet/modal/toast motion, ghost exits, the Copilot holographic stage, press feedback, reduced-motion handling, `initMotion()` |
| `src/sound.js` | synthesised interface sound (no audio files, no network) and the one-time audio unlock |
| `src/gestures.js` | pointer swipe gestures for agent cards + the pure `resolveSwipe()` decision function |
| `src/copilot/panel.js` | immersive full-screen overlay, stage ⇄ advanced, voice capture with consent |
| `src/copilot.css` | the stage: hologram image, rings, scan line, mic dock, advanced surface |
| `src/styles.css` | swipe layers, ghost/reset rules |
| `scripts/motion-test.mjs` | 22 deterministic checks (happy-dom) |
| `scripts/motion-browser-test.mjs` | 12 real-Chromium checks |
| `public/media/hologram.jpg` | the operator-supplied "scan level" image used as the holographic backdrop |

## 2. Where motion is applied

| Surface | Motion | Duration |
| --- | --- | --- |
| App-wide | button press bounce, interface sound on every interactive control | 220 ms |
| Page transitions | routed view fades and rises in; header title slides in when the route changes | 240 ms / 160 ms |
| Sheets / drawers | slide up from the bottom over a fading scrim; exit plays on a decorative ghost | 300 ms |
| Modals | scrim fade + dialog scale/rise; exit on a ghost | 240 ms / 180 ms |
| Toasts | drop in with a small scale, hold 3.4 s, fade out | 240 ms / 160 ms |
| Copilot overlay | full-screen panel, hologram resolves from a blank screen, rings draw outward, scan sweeps, mic springs up | 760 ms total |
| Copilot stage ⇄ advanced | controls stagger in over the dimmed hologram, back to the stage reverses it | 240 ms + 40 ms stagger |
| Copilot close | the live overlay is removed at once; a ghost collapses toward the launcher | 280 ms |
| Agent cards | 1:1 horizontal drag with layered action reveal, spring back when a swipe does not commit | 180 ms |

## 3. Copilot: the immersive overlay

The overlay is now **the screen** at every width — `inset: 0`, `height: 100dvh`, square corners.

1. Tapping the launcher (bottom bar centre, or "Advanced Copilot" in the desktop sidebar) pulses the
   FAB, plays the summon cue and opens the overlay.
2. The overlay starts **blank**: the control surface has `display: none`, the hologram is transparent.
3. The hologram resolves out of the dark (`opacity 0 → 0.92`, `scale 1.12 → 1`), rings draw outward,
   the scan sweeps, and the central microphone springs up under a caption.
4. The **title** reads **Advanced Copilot** and is a button: tapping it swaps the stage for the full
   control surface (modes, context chips, conversation, composer). Tapping again returns to the
   stage. `aria-expanded` mirrors the state.
5. Closing (✕, Escape or the scrim) removes the live overlay immediately, then animates a decorative
   copy out, so a closing panel can never be clicked or read by a screen reader.

**Hologram source.** The stage uses `public/media/hologram.jpg` — the operator-supplied image. It is
a static asset served from the app origin (no invented path, no remote fetch); if it fails to load,
the CSS grid, rings and scan line still render on the dark background, so the stage never depends on
the photograph. There is no 3D hologram engine in this build; the layered CSS + image composite is
what "holographic display" means here, and the docs say so.

### Voice capture — honest about the one thing that leaves the device

The central microphone is **real**, not decorative, and it is wired to the browser's speech
recognition. Every shipping browser implements that recogniser as a **network service**, so:

- it is **off until consent**: the first tap shows a card naming what leaves the device, with
  *Allow voice input* / *Not now*, persisted as `settings.voice.networkRecognitionConsent`;
- it refuses when offline, when the API is missing, and when the microphone permission is denied —
  with the specific reason shown on the stage;
- it can be switched off again in **Settings → Voice & speech**;
- a recognised phrase reveals the advanced surface and sends the message;
- **speaking replies** is a different path (Voice Studio, on-device engine) and never uploads.

## 4. Sound

Synthesised with WebAudio: a short oscillator envelope per cue, plus shaped noise for the swipe.

| Cue | Where |
| --- | --- |
| `tap` | every button, chip, tile, switch and checkbox (delegated at document level) |
| `open` / `close` | sheets, modals, the stage ⇄ advanced swap, the overlay closing |
| `toast` / `ok` / `warn` / `bad` | toasts, by tone |
| `summon` | opening the Copilot |
| `listen` (on/off) | starting/stopping voice capture |
| `swipe` / `arm` | a committed swipe, and the held destructive swipe |

No audio files, no network, nothing to cache. Audio starts suspended and unlocks on the first
pointer/key gesture. Volume is fixed at 0.055 of full scale — feedback, not a soundtrack. The whole
layer is one switch: **Settings → Motion & sound → Interface sounds**
(`settings.soundHaptics`, default on). Calls are guarded, so a browser without WebAudio stays silent
instead of throwing.

## 5. Swipe gestures on agent cards

| Gesture | Result |
| --- | --- |
| Swipe **left** (≥72 px) | Run the agent (`running`) |
| Swipe **right** (≥72 px) | Stop the agent (`paused`) |
| Swipe **left and hold** (≥96 px, 620 ms) | Arm delete → typed confirmation (`DELETE`) before anything is removed |

Details that matter:

- **Additive, never exclusive.** The card is still a button that opens the agent, and the same three
  actions exist on the agent screen. A visible hint above the lists states the gestures, and
  `Alt + ←` / `Alt + →` / `Alt + Delete` do the same from the keyboard.
- **Authority is unchanged.** Swipes call the same helpers as the buttons, so gateway sessions still
  check `agent:write` and still report the server's answer; a gesture cannot do more than a click.
- **Vertical scrolling wins.** Below 8 px of travel, or when the gesture is more vertical than
  horizontal, the card does nothing and the page scrolls. Once a horizontal drag is recognised the
  card takes over (`touch-action: pan-y`).
- **Deletion always confirms.** Arming only opens the dialog; the typed confirmation and the
  soft-delete-with-restore notice are identical to the button path.
- **Opt-out.** Controls inside a card marked `data-no-swipe` never start a gesture.

## 6. Reduced motion and accessibility

- `prefers-reduced-motion: reduce` is honoured, and **Settings → Motion & sound** adds an explicit
  override (`system` / `always` / `reduced`) for people whose OS setting does not match their
  preference for this app.
- With motion off: every surface is placed in its **end state** synchronously, and inline
  `opacity`/`transform` leftovers are cleared (`resetInline`) so nothing stays half-faded.
- The overlay is `role="dialog" aria-modal="true"`; focus is trapped on `Tab`; `Escape` closes; the
  title reports `aria-expanded`; the mic reports `aria-pressed`; the stage caption is a live region.
- Decorative ghosts are `aria-hidden`, `disabled` and `inert` to the tab order.

## 7. Evidence

`npm run test:motion` (happy-dom, deterministic): **22/22**

- preference plumbing: OS default, forced full, forced reduced, in-app override beats the OS
- anime.js is dynamically imported (a partial DOM shim can never crash the bundle) and loads
- with motion off, sheets/toasts/stage helpers leave the end state in place
- closing a sheet leaves no `.sheet.open` behind; only aria-hidden ghosts may remain, and they self-remove
- sound: no WebAudio ⇒ silent no-ops; with a stub AudioContext every cue creates and starts real nodes;
  the setting silences it
- pure swipe decisions: slop, vertical rejection, commit thresholds, travel clamping, hold-to-arm timing
- gesture wiring: one command per completed swipe, id travels with the command, `data-no-swipe` opt-out
- rendered home/agent cards are swipeable, still open on tap, and carry a visible hint
- swipe commands drive real state (run → `running`, stop → `paused`, arm → confirmation dialog,
  cancel → nothing deleted)
- Copilot: full-screen modal, stage first, "Advanced Copilot" title, hologram image source,
  stage ⇄ advanced via the title, sending reveals the conversation, closing removes the live panel
  and hides the ghost from assistive tech
- voice: refusal without a recogniser, consent card before capture, deny = nothing recorded,
  allow = persisted consent + capture starts
- no component imports anime.js directly; sound has no files/network; `copilot.css` has no hex literals

`npm run test:motion:browser` (real Chromium): **12/12**

- anime.js loads; page transition observed fading in (0 → 1)
- sheet animates (mid-flight matrix ≠ identity) and settles in place; no stale sheet; ghost cleaned up
- interface sound plays through a `running` AudioContext
- Copilot opens **390 × 844 = the full viewport** on the stage, then reveals the loaded hologram
  (768 px asset) and the mic
- title swaps stage ⇄ advanced; composer and controls appear; stage dock steps aside
- close removes the live overlay immediately, one ghost animates out, launcher collapses, ghost removed
- **pointer swipe** runs `ag-researcher` and a second swipe stops it
- 320 px: no page overflow, swipe layers contained, card ≥44 px
- 320 px: the immersive stage fits, mic and "type instead" link stay ≥44 px and inside the viewport
- `prefers-reduced-motion` disables animation and applies the end state immediately
- no page errors

Full suite `npm test` is green, `npm run build` is clean, and the browser suites
(`test:relay:browser`, `test:scroll:browser`, `test:voice:browser`) were updated for the
full-screen overlay and re-passed.

## 7b. Screenshots (real Chromium, 390 × 844)

| Screen | File |
| --- | --- |
| Immersive stage: hologram, rings, central mic, consent/mic caption | `docs/design/copilot-stage-390.png` |
| Advanced surface: modes, answer card with sources, composer | `docs/design/copilot-advanced-390.png` |

The stage screenshot is the blank → hologram resolved state at 390 px; the advanced shot is after
tapping the title and sending "status", showing the deterministic live-state answer with its
`OBSERVED` / `VERIFIED` source labels — no model call is claimed there.

## 8. What is deliberately not claimed

| Not claimed | Why |
| --- | --- |
| A real 3D/volumetric hologram | the stage is a layered CSS + image composite; there is no 3D engine or depth hardware here |
| On-device speech recognition | every shipped browser recogniser is network-backed; the consent card says so |
| Audible sound quality / feel on a device | measurements are headless; loudness and gesture feel need a human on real hardware |
| Haptics | `navigator.vibrate` is used when present for the armed swipe, but support is device-dependent and is not advertised |
| Hologram video or animated asset | the supplied file is a still image; only the still is used |
