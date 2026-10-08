// issue 2346 — a long-press on a nick opens the nick menu on a touch device.
//
// The nick menu (`UserContextMenu`) had exactly one opener, the nick's own
// `onContextMenu`, so on iOS — which sends no `contextmenu` for a hold — an
// operator on a phone had no way to reach Op / Kick / Ban at all. Android
// already turns a hold into a `contextmenu`, so this binder does on iOS what
// the platform does there: after a stationary hold it dispatches that same
// event on the nick, and the handlers that already answer a right-click open
// the menu. One door, so the nick menu cannot behave differently by opener,
// and nothing new for the scrollback and the members pane to wire up beyond
// binding it.
//
// Separate from `bindMessageGestures` on purpose: that binder excludes the
// inline controls (`SELECTABLE_TEXT_EXCLUDE`, which includes the nick) so a
// press on a nick never opens the MESSAGE menu, and that exclusion is exactly
// the space this one occupies. The two cannot both arm on one touch.
//
// Same mechanics as the message hold, imported rather than restated: the
// threshold (`LONG_PRESS_MS`), the jitter allowance (`HOLD_MOVE_TOLERANCE_PX`),
// element-level listeners (Solid's delegated touch listener is passive, so a
// preventDefault there is silently ignored — #308 landmine 1), and the
// swallowed release after a hold, without which the browser synthesizes a
// click on the nick: that click opens a query window and lands on the menu's
// backdrop, closing it the instant it appeared.
//
// Returns a disposer for `onCleanup` (#308 landmine 3).
import { LONG_PRESS_MS } from "./keepKeyboard";
import { HOLD_MOVE_TOLERANCE_PX } from "./messageGestures";
import type { Point } from "./swipe";

export function bindNickLongPress(el: HTMLElement, nickSelector: string): () => void {
  let start: Point | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let held = false; // the menu was opened by THIS touch

  const cancelHold = (): void => {
    if (holdTimer !== undefined) clearTimeout(holdTimer);
    holdTimer = undefined;
    start = null;
  };

  const onStart = (e: TouchEvent): void => {
    cancelHold();
    held = false;
    // Single finger only: a pinch (#213) is not a press.
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const target = e.target instanceof Element ? e.target : null;
    if (t === undefined || target === null) return;
    const nick = target.closest<HTMLElement>(nickSelector);
    if (nick === null || !el.contains(nick)) return;
    const at = { x: t.clientX, y: t.clientY };
    start = at;
    holdTimer = setTimeout(() => {
      holdTimer = undefined;
      start = null;
      held = true;
      nick.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: at.x,
          clientY: at.y,
        }),
      );
    }, LONG_PRESS_MS);
  };

  const onMove = (e: TouchEvent): void => {
    const t = e.touches[0];
    if (start === null || t === undefined) return;
    if (
      Math.abs(t.clientX - start.x) > HOLD_MOVE_TOLERANCE_PX ||
      Math.abs(t.clientY - start.y) > HOLD_MOVE_TOLERANCE_PX
    ) {
      cancelHold(); // moving — a scroll, no longer a press
    }
  };

  const onEnd = (e: TouchEvent): void => {
    cancelHold();
    if (!held) return;
    held = false;
    if (e.cancelable) e.preventDefault();
  };

  const onCancel = (): void => {
    cancelHold();
    held = false;
  };

  // Android sends its own `contextmenu` for the hold, and the nick's handler
  // has already answered it: stand down rather than open the menu a second
  // time. Our own dispatch cannot trip this — the timer is cleared before it.
  const onNativeContextMenu = (): void => {
    if (holdTimer !== undefined) cancelHold();
  };

  el.addEventListener("touchstart", onStart, { passive: true });
  el.addEventListener("touchmove", onMove, { passive: true });
  el.addEventListener("touchend", onEnd, { passive: false });
  el.addEventListener("touchcancel", onCancel, { passive: true });
  el.addEventListener("contextmenu", onNativeContextMenu, { capture: true });
  return () => {
    cancelHold();
    el.removeEventListener("touchstart", onStart);
    el.removeEventListener("touchmove", onMove);
    el.removeEventListener("touchend", onEnd);
    el.removeEventListener("touchcancel", onCancel);
    el.removeEventListener("contextmenu", onNativeContextMenu, { capture: true });
  };
}
