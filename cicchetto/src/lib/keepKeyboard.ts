// UX-3 NON / BIS-DEC / preserve-keyboard global — keep the iOS
// on-screen keyboard up across taps on anything that isn't a
// different input.
//
// Per-button `onPointerDown` wiring is fragile: every new tappable
// surface (BottomBar tab, scroll-to-bottom arrow, archive row,
// future buttons) has to remember to call the preserve helper. One
// missed wiring re-introduces the bug (vjt 2026-05-18: archive list
// row dismissed the keyboard).
//
// Instead, install ONE document-level capture listener at boot. When
// the compose `<input>` (or any input/textarea) currently has focus
// and a `pointerdown` lands on an element that is NOT a different
// input/textarea, preventDefault on the pointerdown cancels the
// implicit focus shift. The click still fires (different event), the
// tapped element's onClick still runs, but iOS doesn't dismiss the
// keyboard because focus never moved.
//
// Capture phase so we run BEFORE any element's own pointerdown
// handler (relevant if a handler stops propagation).
//
// Target-guard: only fires when target is NOT itself an input/textarea
// (a tap on a different text field MUST allow the focus transfer so
// the user can actually type in the new field).
//
// No-op on desktop browsers — there's no on-screen keyboard to
// preserve and pointerdown still behaves correctly.
//
// Idempotent at the call site (main.tsx calls once).

function isTextEntry(el: Element | null): boolean {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

function handlePointerDown(e: PointerEvent): void {
  if (!isTextEntry(document.activeElement)) return;
  if (isTextEntry(e.target as Element | null)) return;
  e.preventDefault();
}

export function installKeyboardPreserve(
  target: Document | undefined = typeof document !== "undefined" ? document : undefined,
): void {
  if (!target) return;
  target.addEventListener("pointerdown", handlePointerDown, { capture: true });
}
