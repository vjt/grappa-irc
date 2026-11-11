import { releasedInside } from "./pointerActivation";

// #925 — ONE pointer-activation contract for a send button. The composer's
// paper plane had the only copy until issue 2429 gave the services console a
// send button; that copy carried the comment "a keyboard activation reports
// detail 0 and must always send, since no pointerup carried it" into a button
// that is NOT inside a `<form>`, where nothing else sends — so Enter/Space on
// the console's button sent nothing. The rule, in one place:
//
//   * activation rides the POINTER, not the click. On real iOS a press the OS
//     routes into a long-press gesture synthesizes no mouse events at all
//     (vjt measured exactly that for #366, 2026-07-21): `:active` lights up,
//     no click ever arrives, the text stays in the field. `pointerup` fires
//     either way.
//   * the synthetic click that follows a normal tap must not send twice — and
//     only a pointer-generated click (`detail > 0`) is that duplicate.
//   * a press that comes up OUTSIDE the button is the platform's
//     cancel-by-sliding-off affordance for an irreversible action.
//   * `mousedown` is cancelled so the tap does not steal focus from the text
//     field and collapse the on-screen keyboard (#59). It lands on `mousedown`
//     — the legacy focus-shift carrier — and never on `pointerdown`, which is
//     also iOS's gesture-start signal (lib/keepKeyboard.ts states the rule).
export type PointerSendOptions = {
  /** May this activation send at all? (empty draft, a send already in flight) */
  canSend: () => boolean;
  /** Do it. */
  send: () => void;
  /**
   * Whether a click with NO pointerup behind it is itself the activation.
   *
   * `true` for a bare `type="button"` on a surface with no form around it: a
   * keyboard Enter/Space reports `detail === 0`, and nothing else would send.
   * `false` for the composer, whose button is `type="submit"` inside a
   * `<form>` whose `onSubmit` does the sending — there the click's DEFAULT
   * ACTION is the send, and calling `send()` here too would send twice.
   */
  activateOnBareClick?: boolean;
};

export type PointerSendHandlers = {
  onMouseDown: (e: MouseEvent) => void;
  onPointerDown: (e: PointerEvent) => void;
  onPointerUp: (e: PointerEvent) => void;
  onClick: (e: MouseEvent) => void;
};

export function createPointerSend(opts: PointerSendOptions): PointerSendHandlers {
  // Plain `let`s: nothing renders off them.
  let pressedPointerId: number | null = null;
  let sentFromPointer = false;
  return {
    onMouseDown: (e) => e.preventDefault(),
    onPointerDown: (e) => {
      pressedPointerId = e.pointerId;
      // Re-arm: the previous press may have sent without ever producing a
      // click to consume the swallow flag.
      sentFromPointer = false;
    },
    onPointerUp: (e) => {
      if (pressedPointerId !== e.pointerId) return;
      pressedPointerId = null;
      // Touch pointers are implicitly captured by the element the press
      // landed on, so a release anywhere still targets this button.
      if (
        !releasedInside((e.currentTarget as Element).getBoundingClientRect(), e.clientX, e.clientY)
      )
        return;
      if (!opts.canSend()) return;
      sentFromPointer = true;
      opts.send();
    },
    onClick: (e) => {
      // The pointer-generated click is the duplicate of the send `pointerup`
      // already carried: swallow it (preventDefault too, in case a form is
      // listening).
      if (sentFromPointer && e.detail > 0) {
        e.preventDefault();
        return;
      }
      if (sentFromPointer) return;
      // No pointerup carried this click. Where the click IS the activation
      // (no form behind it), it must send; where a form's default action
      // sends, it must be left alone.
      if (opts.activateOnBareClick !== true) return;
      if (!opts.canSend()) return;
      opts.send();
    },
  };
}
