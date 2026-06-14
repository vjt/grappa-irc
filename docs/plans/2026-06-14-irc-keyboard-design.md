# IRC-Centric Custom Keyboard — Design Spec

- **Date:** 2026-06-14
- **Status:** Approved (brainstorming) → ready for implementation plan
- **Surface:** `cicchetto` (the PWA). No server-side changes.
- **Author:** vjt + Claude

## 1. Goal

A custom, on-screen, **IRC-first** keyboard for the cicchetto PWA that
replaces the native iOS keyboard when opted in. It must:

- Feel **native** — not clunky. Crisp, fast, modern.
- Mimic the **iOS dark/light** keyboards pixel-closely, following the cic
  theme (`irssi-dark` → dark keyboard, `mirc-light` → light keyboard).
- Add a top **accelerator bar** (Termius-inspired floating pill) with
  IRC-centric keys, killing the native iOS accessory bar.
- Magnify keys on tap; long-press → variation strip with full Latin
  accent coverage; iOS-exact selection gesture.
- Ship an emoji picker (all emojis, no Genmoji, no search in MVP).
- Be a **standalone component built for later extraction** into its own
  repo — zero IRC/cic coupling in the core, one thin host adapter.

## 2. Scope

### MVP

- Phone-portrait, full-width layout.
- Three layers: QWERTY letters, `123` numbers+symbols, `#+=` symbols-2
  (mirror the reference screenshots).
- Shift (one-shot + caps-lock on double-tap), backspace, return, space.
- Tap-to-magnify balloon.
- Long-press variation strip, full vowel + consonant accent tables,
  iOS-exact selection gesture.
- Accelerator bar: `Tab` `/` `#` (left) · `←` `→` `↑` `↓` · `✕ close`
  (right).
- Emoji picker: full Unicode set via system color-emoji font, iOS
  category bar, recents in localStorage. **No** search, **no** Genmoji,
  **no** skin-tone strip.
- Opt-in setting; off = today's native behavior, untouched.
- Mounts only on touch + mobile viewport. Desktop never renders it.

### Out of scope (deferred)

- Landscape / iPad layouts.
- Channel-switch accelerator keys (irssi `alt+a` most-recent-activity
  style) — slot reserved in the bar, not wired.
- Emoji search.
- Skin-tone modifiers (will later reuse the variation engine).
- Multi-locale layouts (long-press accents cover Italian + EU Latin).

## 3. Key decisions (locked)

1. **Arrows:** Up/Down = input history (`recallPrev`/`recallNext`),
   Left/Right = move caret. Four arrows.
2. **Variation commit:** iOS-match. Release while a variation is
   highlighted → that char is sent. Drag below the pressed key first →
   strip closes (cancel) → release sends nothing. "No key sent" applies
   only to the cancelled case.
3. **Native fallback:** Full replace via `inputmode="none"` while
   enabled. The close button only hides/blurs. No globe/escape key — to
   get native back, toggle the setting off.

### Assumptions accepted by vjt

- Phone-portrait only for MVP.
- Emoji MVP ships the full (~1900) set as a generated, lazy-loaded JSON
  dataset (CLDR-derived, no images).
- Pixel target = the reference screenshots, which are **stock iOS**.
  Match them exactly: key greys, rounded outer container, floating
  bottom-left emoji button, row proportions, key-shadow. Exact metrics
  get measured off the PNGs at implementation time; final tuning
  on-device.

## 4. The viewport insight (why this is easier than the last keyboard war)

The cic codebase carries heavy machinery — `--vh` / `--viewport-height`
tracking, `html.is-ios { position: fixed }`, smart-scroll-pin — built
across 8 failed iterations (UX-6 D9) because the **native** keyboard
shrinks the visual viewport and iOS auto-scrolls the focused input into
view.

A custom in-page keyboard is **just a div**. With `inputmode="none"` the
textarea stays focused (real caret, real selection) but the native
keyboard never opens → `visualViewport` never shrinks → iOS never
auto-scrolls. The entire `--vh`/scroll-pin nightmare **does not fire** in
IRC-kb mode.

Consequences:

- We reserve keyboard height ourselves via a single CSS var
  (`--irc-kb-height`); scrollback + composer reflow above it.
- The existing `--vh` machinery stays untouched and dormant for IRC-kb
  mode (it still governs native-keyboard mode when the setting is off).
- Keyboard keys must `preventDefault` on `pointerdown` so they never
  steal focus from the textarea (caret must stay put). Same family as
  the existing `keepKeyboard.ts` mousedown trick.

## 5. Architecture & extraction boundary

### Approach (chosen)

**Standalone SolidJS component, "input device" model.** The keyboard
lives in an isolated directory, imports nothing from cic, and emits
semantic editing events across one typed interface. A thin host adapter
(the only cic-coupled file) applies those events to the textarea and
injects the IRC-specific accessories.

Rejected: Web Component / Shadow DOM (theme-var friction + Solid-in-
custom-element awkwardness); Canvas render (violates "CSS, no images" +
a11y).

### Module layout

```
cicchetto/src/keyboard/        ← zero cic imports; future repo root
├── Keyboard.tsx               root: bar + active layer + overlays
├── types.ts                   the boundary interface (events, props)
├── gesture.ts                 pure-TS pointer state machine (no DOM)
├── variations.ts              long-press accent/variant tables
├── layouts.ts                 QWERTY / 123 / #+= key grids
├── emoji.ts                   category model + recents logic
├── emoji-data.ts              generated dataset (no images)
├── AcceleratorBar.tsx         top floating pill
├── KeyCap.tsx                 a single key + magnify balloon
├── VariationStrip.tsx         long-press popover
├── EmojiPicker.tsx            grid + category bar
├── keyboard.css               scoped .kbd-* classes, consumes CSS vars
└── index.ts                   public export surface

cicchetto/src/KeyboardHost.tsx ← cic adapter (the ONLY coupled file)
```

The core keyboard knows **nothing** about IRC. `Tab` / `/` / `#` are
injected by the host as left-accessory config. Extraction later = copy
`src/keyboard/`, rewrite one adapter.

### Boundary interface (sketch — `types.ts`)

```ts
// Semantic editing intents the keyboard emits. The host decides how to
// apply them to whatever text surface it owns. Named KeyboardIntent (not
// KeyboardEvent) to avoid clashing with the DOM KeyboardEvent global.
export type KeyboardIntent =
  | { kind: "insertText"; text: string }      // a char, emoji, or variant
  | { kind: "deleteBackward" }                  // backspace
  | { kind: "submit" }                          // return
  | { kind: "moveCaret"; dir: "left" | "right" }
  | { kind: "history"; dir: "prev" | "next" }   // up/down
  | { kind: "accessory"; id: string }           // host-defined (e.g. "tab")
  | { kind: "dismiss" };                         // close button

export interface AccessoryButton {
  id: string;            // e.g. "tab" — echoed back via {kind:"accessory"}
  label: string;         // "Tab" | "/" | "#"
  // pure label config — the keyboard renders, the host interprets the id
}

export interface KeyboardProps {
  onIntent: (i: KeyboardIntent) => void;
  leftAccessories: AccessoryButton[];   // host injects IRC keys here
  visible: boolean;                     // drives show/hide animation
  // theme is read from the host's data-theme via CSS vars — not a prop
}
```

`/` and `#` are emitted as plain `insertText` by the host's own accessory
config (they're not IRC concepts to the core). `Tab` is an `accessory`
event the host routes to the existing `compose.tabComplete` hop.

## 6. Integration with cic (`KeyboardHost.tsx`)

- Owns the decision to mount (touch + `isMobile()` + opt-in setting).
- Sets `inputmode="none"` on the compose textarea while active; restores
  it (removes the attr) when the setting is off.
- Translates `KeyboardIntent`s onto the **existing** compose paths — one
  code path, every door:
  - `insertText` / `deleteBackward` / `moveCaret` → mutate
    `textarea.value` + `setSelectionRange` at the live caret, then call
    the same `setDraft(key, value)` ComposeBox uses.
  - `submit` → `doSubmit()` (same as Enter today).
  - `history` → `recallPrev` / `recallNext` (same as ArrowUp/Down today).
  - `accessory "tab"` → the `compose.tabComplete` hop Shell already wires.
  - `dismiss` → blur the textarea + slide the keyboard out.
- Provides `leftAccessories = [Tab, /, #]`.

No new state model: the keyboard is just another driver of `compose.ts`.

## 7. Component breakdown

- **Keyboard.tsx** — composition root. Renders `AcceleratorBar`, the
  active layer (letters/123/#+=) or `EmojiPicker`, and the magnify /
  variation overlays. Holds layer + shift state (local, ephemeral).
- **AcceleratorBar.tsx** — the floating pill (Section 11).
- **KeyCap.tsx** — one key; owns its `pointerdown`/`move`/`up` wiring,
  drives the shared gesture engine, renders the magnify balloon.
- **VariationStrip.tsx** — the long-press popover, anchored above the key.
- **EmojiPicker.tsx** — grid + bottom category bar + `ABC` return.
- **MagnifyBalloon** — may fold into KeyCap; the pop-above glyph.

## 8. Layouts (`layouts.ts`) — exact grids from the screenshots

```
QWERTY (letters):
  row1: q w e r t y u i o p
  row2: a s d f g h j k l
  row3: ⇧  z x c v b n m  ⌫
  row4: 123   [emoji]   space   ⏎

123 (numbers + symbols):
  row1: 1 2 3 4 5 6 7 8 9 0
  row2: - / : ; ( ) € & @ "
  row3: #+=  . , ? ! '  ⌫
  row4: ABC   [emoji]   space   ⏎

#+= (symbols 2):
  row1: [ ] { } # % ^ * + =
  row2: _ \ | ~ < > $ £ ¥ •
  row3: 123  . , ? ! '  ⌫
  row4: ABC   [emoji]   space   ⏎
```

Visual notes — the reference screenshots **are stock iOS**; reproduce
them exactly. Letter keys lighter grey than function keys; white glyphs;
rounded key rects with a subtle downward key shadow; rounded outer
container; floating bottom-left emoji button. Exact metrics (radii,
greys, gutters, shadow) measured off the PNGs at implementation time.
**Space shows no locale hint** — the "IT EN" label is dropped (locked,
single layout). `[emoji]` opens the picker; `ABC` returns from a symbol
layer to letters.

## 9. Gesture engine (`gesture.ts`) — the hard part

Pure state machine, fed normalized pointer samples `{x, y, t}`, emits
intents. No DOM, no Solid — unit-testable in isolation. Each `KeyCap`
instantiates/uses it via shared module functions.

### States

`idle → pressed → (tap | magnify | longpress-open) → committed/cancelled`

### Transitions

- **down** on a key → `pressed`; record `(x0, y0, t0)`, key bounds.
  Show **magnify balloon** (glyph pops above the key — ref 3.27.30).
- **up** before long-press threshold (~300ms) and within move slop →
  **tap** → emit `insertText` (shifted glyph if shift active) → hide
  balloon.
- **hold** ≥ threshold and key has variants → **longpress-open**: hide
  balloon, open `VariationStrip` above the key, highlight the default
  variant. Keys with no variants just keep the balloon until up (plain
  insert on up).

### Variation selection (iOS-exact — the locked gesture)

While the strip is open, classify the live pointer by Y band:

- **At the key's Y band OR over the strip** → highlight tracks finger X
  (nearest variant cell).
- **Above the strip's top edge** → strip stays open but **freezes** the
  current highlight; ignores X (so the user can drift upward without
  changing the selection).
- **Below the pressed key's bottom edge** → strip **closes**, gesture
  enters `cancel-armed` (highlight cleared).

On **up**:

- highlight present → emit `insertText` with the highlighted variant.
- `cancel-armed` (strip already closed) → emit nothing.

Tunables (constants in `gesture.ts`, named, no magic numbers):
`LONG_PRESS_MS`, `MOVE_SLOP_PX`, `Y_BAND_PAD_PX`.

## 10. Variation tables (`variations.ts`)

Full Latin accent coverage, mirroring iOS long-press menus. Examples:

- `a → à á â ä æ ã å ā`
- `e → è é ê ë ē ė ę ə` (ref 3.28.34)
- `i → î ï í ī į ì`
- `o → ô ö ò ó œ ø ō õ`
- `u → û ü ù ú ū`
- `c → ç ć č` · `n → ñ ń` · `s → ś š` · `z → ž ź ż` · `y → ÿ`
- `l → ł` · `g → ğ` · etc.

Plus punctuation variants iOS provides (e.g. `- → – — •`, `/ → \`,
`? → ¿`, `! → ¡`, `' → ‘ ’ "`, `" → " " „ « »`). Tables are data, not
code; ordering matches iOS so the default-highlight position feels right.

## 11. Accelerator bar (`AcceleratorBar.tsx`)

**Visual:** Termius-inspired — a floating rounded **pill** sitting above
the keyboard body with a gap (backdrop shows through), subtle top-edge
highlight border, monospace-ish labels + arrow glyphs. Horizontally
scrollable if it overflows. Honors the cic theme.

**Content (left → right):**

- Left accessories (host-injected): `Tab` · `/` · `#`
- Editing/navigation (core-owned): `←` `→` `↑` `↓`
- Right: `✕` close

**Behavior:** `←`/`→` → `moveCaret`; `↑`/`↓` → `history`; `Tab` →
`accessory "tab"`; `/` `#` → `insertText`; `✕` → `dismiss`. Bar is a
slot system so future channel-switch keys drop in without a redesign.

This replaces the native iOS accessory bar entirely.

## 12. Emoji picker (`EmojiPicker.tsx` + `emoji-data.ts`)

- Full Unicode set rendered as **system color-emoji font glyphs** — no
  images, no sprite sheets.
- iOS category bar at the bottom: recents · smileys & people · animals &
  nature · food & drink · activity · travel & places · objects ·
  symbols · flags, plus a backspace and an `ABC` return.
- Tap inserts (`insertText`). Recents persisted in localStorage.
- Dataset generated from Unicode CLDR at build time (a script, checked
  in as `emoji-data.ts`); lazy-loaded so it doesn't bloat first paint.
- **No** search bar, **no** Genmoji, **no** skin-tone strip in MVP.

## 13. Theming (`keyboard.css`)

- The keyboard **consumes** the cic theme: `<html data-theme="…">` is
  already set by `theme.ts`. `keyboard.css` defines a `--kbd-*` palette
  block per theme selector:
  - `--kbd-bg`, `--kbd-key-bg`, `--kbd-key-fn-bg`, `--kbd-key-text`,
    `--kbd-key-shadow`, `--kbd-magnify-bg`, `--kbd-strip-bg`,
    `--kbd-accent` (iOS blue `#0a84ff`), `--kbd-pill-bg`,
    `--kbd-pill-border`.
- Dark mirrors the reference dark shots; light is the iOS light
  equivalent. All classes are `.kbd-`-prefixed (extraction-safe; no
  collision with cic's globals).
- No `prefers-color-scheme` reads inside the keyboard — theme is the
  host's job; the keyboard only reads vars.

## 14. Show/hide animation + height reservation

- Keyboard is `position: fixed; bottom: 0`, full width. Reserves layout
  height via `--irc-kb-height` so scrollback + composer sit above it.
- Show/hide: CSS `transform: translateY(100%) → 0` with an iOS-matching
  ease + duration; guarded by `prefers-reduced-motion` (instant when
  set).
- `visible` prop drives it; no layout thrash (transform/opacity only).

## 15. Settings, opt-in, gating

- New boolean in `userSettings.ts` (e.g. `ircKeyboard`), surfaced as a
  toggle in `SettingsDrawer`. Default **off**.
- `KeyboardHost` mounts only when: opt-in ON **and** touch device
  (pointer-coarse) **and** `isMobile()` viewport. Desktop + physical
  keyboard never render it.
- Off → today's native behavior is byte-for-byte unchanged (`inputmode`
  attr not touched, no keyboard div mounted).

## 16. Testing strategy

- **Pure vitest** for the value-bearing logic: `gesture.ts` (state
  machine transitions + the Y/X selection rules), `variations.ts`
  (tables present + ordered), `layouts.ts`, `emoji.ts` (recents,
  categories).
- Real type gate is `bun run build` (`bun run check`'s biome can mask
  `tsc` — known).
- **Not** e2e for gesture/scroll physics: Playwright webkit ≠ real iOS
  (known). Feel + pixel-perfect get dogfooded on-device.
- Component smoke tests (`@solidjs/testing-library`) for render +
  event-emission wiring of `KeyboardHost`.

## 17. Risks & open questions

- **`inputmode="none"` caret UX:** the textarea caret must stay visible
  and editable with no native KB. Validate on-device early (iOS Safari
  ≥ 12.2 honors it; PWA standalone needs a check).
- **Emoji font coverage / dataset size:** newer emoji may not render on
  older iOS; dataset must be lazy-loaded to protect first paint.
- **Coexistence with `keepKeyboard.ts` / scroll-pin:** confirm they stay
  dormant (no native KB ⇒ no focus-driven scroll) and don't fight the
  fixed keyboard div.

## 18. Deferred / future

Landscape + iPad layouts · channel-switch accelerator keys · emoji
search · skin-tone modifiers (reuse variation engine) · multi-locale
layouts · extraction to a standalone repo.
