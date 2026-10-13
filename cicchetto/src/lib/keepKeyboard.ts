// UX-3 preserve-keyboard global — keep the iOS on-screen keyboard up
// across taps on anything that isn't a different input.
//
// Per-button `onPointerDown` wiring is fragile: every new tappable
// surface (BottomBar tab, scroll-to-bottom arrow, archive row,
// future buttons) has to remember to call the preserve helper. One
// missed wiring re-introduces the bug.
//
// Instead, install ONE document-level capture listener at boot. When
// the compose `<input>` (or any input/textarea) currently has focus
// and a `mousedown` lands on an element that is NOT a different
// input/textarea, preventDefault on the mousedown cancels the
// implicit focus shift. The click still fires (different event), the
// tapped element's onClick still runs, but iOS doesn't dismiss the
// keyboard because focus never moved.
//
// CRITICAL: this hooks `mousedown`, NOT `pointerdown`. iOS Safari
// dispatches BOTH events; `pointerdown` is also the gesture-start
// signal for scroll/pan, so `preventDefault` on `pointerdown` blocks
// scroll inside touched scroll containers (vjt 2026-05-18: archive
// modal list couldn't be scrolled after TER-DEC pointerdown variant
// shipped). `mousedown` is the legacy focus-shift carrier and does
// NOT participate in iOS's scroll-gesture dispatch — preventing it
// suppresses focus only, leaving scroll/pan untouched.
//
// Capture phase so we run BEFORE any element's own mousedown handler
// (relevant if a handler stops propagation).
//
// Target-guard: only fires when target is NOT itself an input/textarea
// (a tap on a different text field MUST allow the focus transfer so
// the user can actually type in the new field).
//
// iOS-only, gated in the handler via isIos(). mousedown's default
// action is not just the focus shift — it is ALSO the start of a
// text-selection drag, so preventDefault kills text selection wherever
// it fires. With the compose box autofocused (the normal cic state)
// that made scrollback text unselectable on desktop. Full arc +
// known limitations (iPad-with-trackpad, Android unvalidated):
// docs/DESIGN_NOTES.md 2026-06-11.
//
// The gate sits in the handler, not at install time, for test
// isolation: the document-level capture listener has no uninstall
// path, so an install-time gate would leak an ungated listener from
// an iOS-UA test into every later desktop-UA test. Per-event cost is
// one regex on a ~Hz event — immaterial.
//
// SCOPE, since #1067: this module owns the KEYBOARD only. #366 had also hung a
// touchend-driven "select the whole message row" affordance off the same
// long-press; that is gone — a long-press on a message row now opens the
// message menu (Copy / Reply / Select…), and the swipe-to-reply lives beside
// it, both in `lib/messageGestures` bound at element level on the scrollback.
// Two owners for one gesture stream is how #366's select-all ended up fighting
// the affordance that replaced it.

import { isDiagEnabled } from "../DiagFloat";
import { diagPush } from "./diagLog";
import { isIos } from "./platform";

// The selectable-TEXT surfaces where a mousedown's preventDefault is
// DURATION-GATED (see LONG_PRESS_MS / handleMouseDown) instead of always
// firing: preventDefault cancels the focus shift AND the
// text-selection-drag start, so on copyable text we only fire it for a
// long-press (keep the keyboard so the selection survives) and skip it
// for a tap (let the keyboard dismiss). This list MUST agree with
// default.css's selectable-text policy — which #1869 made TWO-TIER, and
// the tier is what decides where a new surface goes:
//
//   * STANDING re-enable — `user-select: text` inside
//     `@media (pointer: coarse)`: STANDING_SELECTABLE_SURFACES below.
//     Surfaces with no platform long-press selection worth suppressing.
//   * LATCH-scoped — `user-select: none` standing, lifted only while
//     `html.is-selecting` is up: `.scrollback` and the two #250 tokens
//     inside it. On Blink a STANDING `text` here IS the platform's own
//     long-press selection, and `-webkit-touch-callout: none` (WebKit
//     only) cannot suppress it — that is the two-menu frame #1869
//     reports.
//
// So a new copyable surface goes in the standing re-enable UNLESS a
// long-press on it can raise the platform's selection UI, in which case
// it follows `.scrollback` into the latch. See docs/DESIGN_NOTES.md
// 2026-06-11 (Dispatch-1) + 2026-07-03 (#79 v1) + 2026-07-04 (#79
// long-press rework) + 2026-08-30 (#1869).
//
// issue 2394 — the standing tier is a SHAPE, not a per-surface list. It used
// to name `.topic-modal-text` alone, so every modal and lookup card that came
// after it (WHOIS, /who, /names, banlist, …) inherited the blanket kill and
// could not be copied off a phone. Now:
//   * `.modal-backdrop` — the scrim every viewport modal is built on, so a NEW
//     modal is copyable by default without anybody remembering this file;
//   * `.selectable-text` (SELECTABLE_TEXT_CLASS) — the opt-in for a copyable
//     surface that is not such a modal: the lookup cards, the topic text.
// Their controls (STANDING_SURFACE_CONTROLS) are carved back out in BOTH
// places: a long-press on a ✕ must not raise a selection magnifier, and a tap
// on it keeps the keyboard as it always did. CSS cannot import a constant, so
// `touchSelectionPolicy.test.ts` asserts the sheet says exactly this — both
// directions, so a re-enable added to the sheet alone fails too.
export const SELECTABLE_TEXT_CLASS = "selectable-text";
export const STANDING_SELECTABLE_SURFACES = [
  ".modal-backdrop",
  `.${SELECTABLE_TEXT_CLASS}`,
] as const;
// `svg` is the links map: a pan surface (`touch-action: none`) whose node
// labels are <text>, where a long-press must pan and not select.
export const STANDING_SURFACE_CONTROLS = ["button", "svg"] as const;
const SELECTABLE_TEXT_SURFACES = [".scrollback", ...STANDING_SELECTABLE_SURFACES].join(", ");
const STANDING_CONTROL_EXCLUDE = STANDING_SELECTABLE_SURFACES.flatMap((surface) =>
  STANDING_SURFACE_CONTROLS.map((control) => `${surface} ${control}`),
).join(", ");
// Controls that live INSIDE a selectable surface whose KEYBOARD policy is
// "always preserve on tap" — the exclude wins in isSelectableSurface, so
// they fall through to the always-fire preventDefault path (keyboard kept
// on tap AND long-press, never a tap-to-close).
//
// This is the KEYBOARD/focus policy, which is INDEPENDENT of the CSS
// text-selection policy (default.css's `@media (pointer: coarse)`
// `user-select` re-exclude) — do NOT assume this list mirrors the CSS one:
//   * `.scrollback-invite-join` (the [Join] CTA) is a non-copyable
//     control, so it is in BOTH: keyboard-preserve here AND
//     `user-select: none` in CSS.
//   * `.scrollback-link` (a linkified URL, #350) is a COPYABLE control —
//     tap should keep the keyboard (it's a tap-to-navigate control, the
//     mousedown preventDefault leaves the click's `target=_blank`
//     navigation untouched), but its URL text must stay copyable, so it
//     is deliberately NOT in the CSS re-exclude. Forcing `user-select:
//     none` on an inline link would drop its URL from a drag-selection
//     that SPANS it (a spanning selection starts on adjacent text, so the
//     link's own mousedown preventDefault never sees it) — exactly the
//     regression `.nick-clickable` fixed in #250 by keeping a
//     clickable-but-copyable inline element `user-select: text`. Keyboard
//     policy ≠ selection policy for content that is also a control.
// `.scrollback-link` also covers media links (`.scrollback-media-link` is
// applied alongside it, MircText.tsx). See DESIGN_NOTES 2026-07-20 (#350).
//   * `.nick-clickable` (the sender nick rendered inline as an open-query
//     control, #354) is the SAME class as `.scrollback-link`: a COPYABLE
//     inline control. A tap should keep the keyboard (it opens a query; the
//     mousedown preventDefault leaves the click's open-query onClick
//     untouched), but its nick text must stay copyable, so — like the link —
//     it is deliberately NOT in the CSS `user-select` re-exclude (forcing
//     `user-select: none` is the exact `.nick-clickable` regression #250
//     fixed). Before #354 it fell onto the duration-gated selectable path
//     (inside `.scrollback`, not excluded), so a TAP dropped the keyboard and
//     a LONG-PRESS select-all'd the row — both wrong for a control. Same
//     class of bug as #350. See DESIGN_NOTES 2026-07-26 (#354).
//   * `.channel-clickable` (#648 — a `#channel` in scrollback rendered inline
//     as a click-to-join control, MircText.renderChannel) is the SAME class of
//     inline control as `.nick-clickable`: a tap opens the join-confirm (keep
//     the keyboard), its text stays copyable (NOT in the CSS `user-select`
//     re-exclude, so a spanning drag-selection still grabs it), and a
//     long-press must not select-all the row.
// Exported since #1067: `lib/messageGestures` arms the swipe-to-reply and the
// long-press menu on the SAME rows, and must skip the SAME controls — sharing
// the constant is what keeps the two policies from drifting apart.
export const SELECTABLE_TEXT_EXCLUDE =
  ".scrollback-invite-join, .scrollback-link, .nick-clickable, .channel-clickable";

// #79 (2026-07-04) — long-press threshold. For a TAP, iOS dispatches a
// mousedown on finger RELEASE, so `mousedown - touchstart` is the held
// duration: below the threshold is a TAP (let the keyboard dismiss —
// vjt-confirmed tap-to-close, KEEP), at/above it is a hold (keep the
// keyboard). 500ms matches iOS's own long-press convention. Feel accepted by
// vjt 2026-07-04; device-judged post-ship.
//
// Also THE hold threshold for #1067's long-press message menu — imported by
// `lib/messageGestures` rather than redeclared, so one press cannot be a hold
// for one handler and a tap for the other.
export const LONG_PRESS_MS = 500;

// Exported since #1106: `lib/messageMenu`'s Select… has to release a focused
// editable before it installs its range, and "what counts as a text entry" must
// be ONE predicate — a second copy would drift the moment a contenteditable
// composer lands (ComposeBox already contemplates one). Narrowing predicate so
// callers can reach `.blur()` without re-testing the type.
export function isTextEntry(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

// True when a mousedown target sits on copyable text — the surfaces where
// preventDefault is duration-gated (tap dismisses, long-press selects)
// rather than always fired. The exclude wins: the [Join] CTA lives inside
// .scrollback but is a control, so it falls through to the always-fire
// path (keyboard preserved regardless of hold duration). A modal's or a
// card's own controls do the same (issue 2394).
function isSelectableSurface(el: Element | null): boolean {
  if (el === null) return false;
  if (el.closest(SELECTABLE_TEXT_EXCLUDE) !== null) return false;
  if (el.closest(STANDING_CONTROL_EXCLUDE) !== null) return false;
  return el.closest(SELECTABLE_TEXT_SURFACES) !== null;
}

// Timestamp (performance.now, monotonic) of the most recent touchstart —
// the mousedown handler reads it to classify a selectable-surface press
// as tap vs long-press. 0 until the first touch; the desktop/no-touch
// path never reaches the duration check (gated by isIos() upstream).
let touchStartAt = 0;

// The clock stamp the mousedown arm reads to tell a tap from a hold. #366 also
// hung a target/coords/keyboard-state capture off this handler for its
// touchend-driven select-all; #1067 deleted that whole path, so all that
// remains is the timestamp.
function handleTouchStart(): void {
  touchStartAt = performance.now();
}

function handleMouseDown(e: MouseEvent): void {
  if (!isIos()) return;
  if (!isTextEntry(document.activeElement)) return;
  if (isTextEntry(e.target as Element | null)) return;
  if (isSelectableSurface(e.target as Element | null)) {
    // Copyable text: for a TAP, iOS dispatches this mousedown on
    // finger-RELEASE, so the held duration (touchstart → now) tells a tap
    // from a (would-be) long-press. Tap → leave the default (focus shift →
    // keyboard dismisses, vjt-confirmed tap-to-close). The long-press arm
    // preventDefaults the focus-shift — but on real iOS a long-press
    // synthesizes NO mousedown at all (only taps do), so on device this arm
    // effectively only ever sees taps; it survives as a cross-platform net.
    // See LONG_PRESS_MS.
    const heldMs = performance.now() - touchStartAt;
    const longPress = heldMs >= LONG_PRESS_MS;
    if (longPress) {
      // #79: keep the keyboard (cancel the focus-shift so its reflow can't
      // tear down the selection iOS has begun). Nothing else — #366's
      // select-all that used to ride here was removed by #1067.
      e.preventDefault();
      if (isDiagEnabled()) {
        diagPush(`kb: scrollback md held=${Math.round(heldMs)}ms → HOLD keep-kbd`);
      }
    } else if (isDiagEnabled()) {
      diagPush(`kb: scrollback md held=${Math.round(heldMs)}ms → tap close-kbd`);
    }
    return;
  }
  // #508: a native <select>'s picker opens on THIS mousedown (unlike a
  // button, whose action rides the click), so preventDefault here would
  // suppress it — the "control looks dead to a direct tap" bug (only the
  // <label for=…> worked, because a label forwards a synthetic click, never
  // the select's own mousedown). Let it through: the tap dismisses the text
  // keyboard and opens the picker, the correct behaviour for a select. Same
  // shape as the .scrollback-invite-join control carve-out above — a control
  // that must escape the generic-chrome always-fire preventDefault. (The CSS
  // half of this fix re-enables user-select on iOS <select>, default.css
  // #508; both mechanisms suppressed the picker, this is the JS half —
  // reasoned, not device-proven, since Playwright webkit can't invoke the
  // native picker.)
  if (e.target instanceof HTMLSelectElement) return;
  e.preventDefault();
}

export function installKeyboardPreserve(
  target: Document | undefined = typeof document !== "undefined" ? document : undefined,
): void {
  if (!target) return;
  target.addEventListener("mousedown", handleMouseDown, { capture: true });
  // Passive: we only READ the timestamp, never preventDefault a touch — that
  // would block scroll/pan and the native selection gesture (the same reason
  // the header hooks mousedown, not pointerdown). The scrollback's OWN touch
  // gestures (swipe-to-reply, long-press menu) are bound at element level by
  // `lib/messageGestures`, which is where a non-passive touch listener belongs.
  target.addEventListener("touchstart", handleTouchStart, { capture: true, passive: true });
}
