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

import { isIos } from "./platform";

// Selectable-text policy point — MUST stay in sync with default.css
// (`html.is-ios .scrollback, .topic-modal-text` re-enable, minus the
// `.scrollback-invite-join` control re-exclude). CSS can't export a TS
// constant, so this allowlist is duplicated deliberately, same shape as
// the nick-fold SQL/fragment invariant: a new copyable surface must be
// added to BOTH sites or the two policies drift. Keep it small + named.
// Why the skip exists: preventDefault on a mousedown cancels the focus
// shift AND the text-selection-drag start, so without this guard a
// long-press on scrollback text with the compose box focused could never
// start a selection while the keyboard was open (#79). See
// docs/DESIGN_NOTES.md 2026-06-11 (Dispatch-1) + 2026-07-03 (#79).
const SELECTABLE_TEXT_SURFACES = ".scrollback, .topic-modal-text";
const SELECTABLE_TEXT_EXCLUDE = ".scrollback-invite-join";

function isTextEntry(el: Element | null): boolean {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

// True when a mousedown target sits on copyable text (so preventDefault
// must be skipped to let the selection drag start). The exclude wins:
// the [Join] CTA lives inside .scrollback but is a control.
function isSelectableSurface(el: Element | null): boolean {
  if (el === null) return false;
  if (el.closest(SELECTABLE_TEXT_EXCLUDE) !== null) return false;
  return el.closest(SELECTABLE_TEXT_SURFACES) !== null;
}

function handleMouseDown(e: MouseEvent): void {
  if (!isIos()) return;
  if (!isTextEntry(document.activeElement)) return;
  if (isTextEntry(e.target as Element | null)) return;
  if (isSelectableSurface(e.target as Element | null)) return;
  e.preventDefault();
}

export function installKeyboardPreserve(
  target: Document | undefined = typeof document !== "undefined" ? document : undefined,
): void {
  if (!target) return;
  target.addEventListener("mousedown", handleMouseDown, { capture: true });
}
