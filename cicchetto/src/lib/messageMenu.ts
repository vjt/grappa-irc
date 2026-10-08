import { createSignal } from "solid-js";
import type { ScrollbackMessage } from "./api";
import { copyText } from "./clipboard";
import { isTextEntry } from "./keepKeyboard";
import type { BanMenuTarget } from "./opsMenu";
import type { Point } from "./swipe";
import { createToastQueue } from "./toasts";

// #1067 — the long-press message menu: what it is open OVER, and the two verbs
// that are only meaningful on a rendered row (Copy, Select…). Reply is NOT
// here — it is `lib/replyQuote`, shared verbatim with the swipe, because the
// menu item and the gesture must not be able to drift into two behaviours.
//
// The menu replaces #366's programmatic whole-row select-all, which was the
// long-press affordance and produced both reported symptoms: it only ran with
// the keyboard up, and the range it installed had no draggable endpoints.

export type MessageMenuTarget = {
  msg: ScrollbackMessage;
  // The rendered row. Copy reads its text (what the operator SEES, timestamp
  // and sender included — the same span #366 grabbed) and Select… installs the
  // range over it. The gesture already resolved it; re-finding it by id here
  // would be a second lookup that can disagree with the first.
  row: HTMLElement;
  networkSlug: string;
  channelName: string;
  at: Point;
  // issue 2346 — the person a join/part/quit row is about, with the host off
  // its prefix, so the menu can offer Ban nick / Ban host / Kickban on the
  // row itself; null on every other row. Resolved by the opener, which knows
  // the window's own modes — this store knows rows.
  ban: BanMenuTarget | null;
};

const [messageMenu, setMessageMenu] = createSignal<MessageMenuTarget | null>(null);

export { messageMenu };

export function openMessageMenu(target: MessageMenuTarget): void {
  setMessageMenu(target);
}

export function closeMessageMenu(): void {
  setMessageMenu(null);
}

// A clipboard failure must be visible (#1067 acceptance). It rides the app's
// ONE toast surface rather than `copyText`'s throw: the stakes here are not the
// show-once-secret stakes that helper was written for, and the way out it names
// — "select the text and copy it by hand" — is literally the next item in the
// same menu. Failure only; a successful copy is silent, the menu closing is the
// feedback.
const copyFailures = createToastQueue<{ message: string }>();
export const copyToasts = copyFailures.toasts;
export const dismissCopyToast = copyFailures.dismiss;

// Never rejects: the failure IS the toast, so callers can `void` this without
// leaving an unhandled rejection behind.
export async function copyMessageRow(row: HTMLElement): Promise<void> {
  try {
    await copyText(row.textContent ?? "");
  } catch (err) {
    copyFailures.queue({ message: err instanceof Error ? err.message : String(err) });
  }
}

// Lifts the touch blanket `-webkit-touch-callout: none` for the duration of one
// selection (default.css pairs this class with the re-enable, inside
// `@media (pointer: coarse)` since #1869 — it was `html.is-ios` before, which
// is why Android had no callout suppression to lift). Scoping it in TIME rather
// than in space is what keeps the two long-presses from colliding: with the
// callout permanently back on the scrollback, every hold would race the
// platform's own selection UI against this menu.
export const SELECTING_CLASS = "is-selecting";

// The detach for the `selectionchange` watcher `selectMessageText` installs.
// Module scope for two reasons: the latch is ONE class on ONE <html>, so a
// second watcher for it is a leak by construction; and the disarm below has to
// be reachable from outside the closure that armed it.
let detachSelectionWatch: (() => void) | null = null;

// issue 1857 — the latch's SECOND exit, and the one the gesture doors take.
//
// The `selectionchange` disarm inside `selectMessageText` is queued as a task,
// so on the touch that ends a selection it lands AFTER touch-down — and
// touch-down is when WebKit reads `-webkit-touch-callout` to decide whether to
// run its own long-press selection UI. The reported symptom is both menus at
// once: iOS's callout bar over the stale range and ours over the row just
// pressed. A latch that can only be released asynchronously cannot be released
// in time, so the doors release it themselves, synchronously, at the top of
// the gesture.
//
// It does NOT touch the selection. Every caller reaches it only past its own
// `selection.isCollapsed` stand-down, so there is no range left to drop, and a
// `removeAllRanges()` there could only land on a caret — including one the
// compose field owns, which is precisely the blur/focus/selection interaction
// #1106 and #79 paid for. Idempotent: with nothing armed it is a no-op.
export function disarmMessageSelection(): void {
  detachSelectionWatch?.();
  detachSelectionWatch = null;
  document.documentElement.classList.remove(SELECTING_CLASS);
}

// Hand the operator a real, adjustable native selection over the row and get
// out of the way. Returns whether a selection could be installed.
//
// NOT device-verified: the callout ⇄ grab-handle link is read from the platform
// contract and from the code, and neither jsdom nor Playwright webkit
// reproduces iOS selection UI. #1067 says as much about its own diagnosis.
export function selectMessageText(row: HTMLElement): boolean {
  const selection = window.getSelection();
  if (selection === null) return false;
  // #1106 — release the compose field FIRST, or on iOS the range goes in
  // while an editable still owns the paint and nothing appears.
  //
  // The tap that chose this item landed on a menu button portalled to <body>:
  // not a text entry, not inside `.scrollback`, not a <select>, so
  // keepKeyboard's final always-fire `preventDefault` cancelled its focus
  // shift and the compose box KEPT focus. With the keyboard down nothing is
  // focused, that mousedown is not prevented, and the selection is reported
  // working — the difference between the two is ours, not WebKit's.
  //
  // Aimed at the editable rather than at whatever holds focus: on the
  // keyboard-down path the focused thing is the menu button itself, and
  // blurring that buys nothing while moving focus on platforms that never had
  // the bug. This does NOT contradict #79 — that duration-gates the long-press
  // on `.scrollback` to keep the keyboard through the GESTURE; this is the
  // explicit command the gesture leads to, where the operator has asked for a
  // selection and the keyboard is what is in its way.
  const focused = document.activeElement;
  if (isTextEntry(focused)) focused.blur();
  // One latch, one watcher (issue 1857). A second Select… while the first
  // selection is still live used to stack another listener on the document —
  // only the one that FIRED ever detached itself, so a session that selected
  // repeatedly accumulated them.
  //
  // The latch goes up BEFORE the range goes in, and the order is deliberate:
  // since #1869 the latch is what makes `.scrollback` `user-select: text` on a
  // coarse pointer, so raising it first is the only ordering under which the
  // row is selectable at the instant the range is installed. Raised after, the
  // range is installed while the row still computes `user-select: none`.
  //
  // WHAT BLINK DOES IS NOW MEASURED, and it is not a truncated range. With the
  // two orderings swapped by hand and the e2e `Select…` test rerun on a coarse
  // pointer, the selection still serialised WHOLE: `Selection.toString()` walks
  // the layout tree at CALL time, so it reads the `user-select` the row
  // computes then — not the one it computed when `addRange` ran. The control
  // that makes that a measurement rather than a nil result: renaming the class
  // above reds the very same test with an EMPTY selection.
  //
  // So the order stays for the reason it can honestly stay for — it is the one
  // ordering that needs no per-engine argument — and NOT because it repairs a
  // demonstrated defect on Blink. WebKit remains unmeasured: no browser
  // launches on the machine this was written on, and `webkit-iphone-15` cannot
  // host that spec at all (its `tap()` dispatches no click — see the header of
  // issue1869-android-longpress-selection.spec.ts).
  disarmMessageSelection();
  document.documentElement.classList.add(SELECTING_CLASS);
  const range = document.createRange();
  range.selectNodeContents(row);
  selection.removeAllRanges();
  selection.addRange(range);
  // Disarm the moment the operator is done. Without this the callout stays up
  // for the rest of the session and the next hold anywhere in the scrollback
  // pops iOS's own menu over ours. This is the LATE exit — see
  // `disarmMessageSelection` for why the gesture doors cannot wait for it.
  const onSelectionChange = (): void => {
    const live = window.getSelection();
    if (live !== null && live.toString() !== "") return;
    disarmMessageSelection();
  };
  document.addEventListener("selectionchange", onSelectionChange);
  detachSelectionWatch = (): void =>
    document.removeEventListener("selectionchange", onSelectionChange);
  return true;
}
