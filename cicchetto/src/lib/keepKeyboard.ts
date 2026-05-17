// UX-3 NON / BIS-DEC — keep the iOS on-screen keyboard up across
// taps on buttons that aren't the compose <input>.
//
// The default browser behavior on tap is to move focus to the tapped
// element. On iOS that means: focus leaves the compose <input>,
// keyboard dismisses, layout reflows. Operators rapidly switching
// tabs or scrolling to bottom while typing have to re-tap the input
// every time.
//
// preventDefault on `pointerdown` BEFORE the focus shift suppresses
// the focus transfer entirely. The click still fires (different
// event), the action still runs, but the input keeps its focus and
// the keyboard stays open.
//
// Guarded: only fires when the currently focused element is an
// <input> or <textarea> — non-keyboard contexts (desktop, focus
// already elsewhere) aren't affected.
//
// No-op on desktop browsers — there's no on-screen keyboard to
// preserve and pointerdown still behaves correctly.

export function keepKeyboardOnPointerDown(e: PointerEvent): void {
  if (
    document.activeElement instanceof HTMLInputElement ||
    document.activeElement instanceof HTMLTextAreaElement
  ) {
    e.preventDefault();
  }
}
