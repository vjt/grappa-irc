// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { LONG_PRESS_MS } from "../lib/keepKeyboard";
import {
  bindMessageGestures,
  HOLD_MOVE_TOLERANCE_PX,
  HOLD_MS_VAR,
  HOLDING_CLASS,
  SWIPE_MAX_SLIDE_PX,
  SWIPING_CLASS,
} from "../lib/messageGestures";
import { fireTouch } from "./helpers/touchEvents";

// #1067 — the scrollback's ONE touch-gesture owner: a left→right swipe on a
// message row fills the compose box with a quote, a stationary hold opens the
// message menu. Both read the SAME touchstart→move→end stream, which is why
// they live in one binder: two independent binders would each keep their own
// "did it move" state and could fire together on one gesture.
//
// jsdom proves the DECISION path and the hard constraints (a vertical drag is
// never claimed; the left edge is left to #1041's sidebar; an inline control
// never arms). It does NOT prove the feel — synthetic events drive no pixel
// scroll and jsdom is not iOS. That part is vjt's on-device dogfood.

const W = 390; // viewport width fed to the binder (jsdom has no layout)
const CENTER_X = 200; // outside both 20px edge zones

let pane: HTMLDivElement;
let row: HTMLDivElement;
let body: HTMLSpanElement;
let link: HTMLAnchorElement;
// #1156 — a second row in the SAME pane that the call site refuses a reply
// for (in production: a join/part/quit, which has nothing to quote). The
// binder never learns why — it asks, per row.
let refusedRow: HTMLDivElement;
let refusedBody: HTMLSpanElement;
let onReply: Mock<(row: HTMLElement) => void>;
let onLongPress: Mock<(row: HTMLElement, at: { x: number; y: number }) => void>;
let dispose: () => void;

function makeRow(): { line: HTMLDivElement; text: HTMLSpanElement } {
  const line = document.createElement("div");
  line.className = "scrollback-line";
  const text = document.createElement("span");
  text.className = "scrollback-body";
  line.appendChild(text);
  return { line, text };
}

beforeEach(() => {
  vi.useFakeTimers();
  pane = document.createElement("div");
  pane.className = "scrollback";
  const content = makeRow();
  row = content.line;
  body = content.text;
  link = document.createElement("a");
  link.className = "scrollback-link";
  row.appendChild(link);
  const refused = makeRow();
  refusedRow = refused.line;
  refusedBody = refused.text;
  pane.append(row, refusedRow);
  document.body.appendChild(pane);
  onReply = vi.fn<(row: HTMLElement) => void>();
  onLongPress = vi.fn<(row: HTMLElement, at: { x: number; y: number }) => void>();
  dispose = bindMessageGestures(pane, {
    viewportWidth: () => W,
    // The call site's answer, stubbed as an identity check rather than a kind
    // list: the binder is DOM-only, so a kind classifier in here (even in the
    // test) would be modelling the wrong contract.
    canReply: (r) => r === row,
    onReply,
    onLongPress,
  });
});

afterEach(() => {
  dispose();
  document.body.innerHTML = "";
  vi.restoreAllMocks(); // the live-selection test spies on window.getSelection
  vi.useRealTimers();
});

// A left→right drag across `dx` px, starting at CENTER_X on `target`.
function swipeRight(target: HTMLElement, dx: number): { moves: Event[]; end: Event } {
  fireTouch(target, "touchstart", { clientX: CENTER_X, clientY: 300 });
  const moves = [
    fireTouch(target, "touchmove", { clientX: CENTER_X + dx / 3, clientY: 303 }),
    fireTouch(target, "touchmove", { clientX: CENTER_X + (dx * 2) / 3, clientY: 305 }),
  ];
  const end = fireTouch(target, "touchend", { clientX: CENTER_X + dx, clientY: 306 });
  return { moves, end };
}

describe("bindMessageGestures — swipe left→right = reply", () => {
  it("fires onReply with the message row for a right swipe past the floor", () => {
    swipeRight(body, 90);
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onReply.mock.calls[0]?.[0]).toBe(row);
  });

  it("claims the gesture (preventDefault) only once horizontal intent is proven", () => {
    const { moves } = swipeRight(body, 90);
    expect(moves.every((m) => m.defaultPrevented)).toBe(true);
  });

  it("slides the row with the finger, capped, and snaps it back on release", () => {
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 300 });
    fireTouch(body, "touchmove", { clientX: CENTER_X + 40, clientY: 302 });
    expect(row.style.transform).toBe("translateX(40px)");
    expect(row.classList.contains(SWIPING_CLASS)).toBe(true);
    // Past the cap the row stops following — the finger keeps going.
    fireTouch(body, "touchmove", { clientX: CENTER_X + SWIPE_MAX_SLIDE_PX + 60, clientY: 302 });
    expect(row.style.transform).toBe(`translateX(${SWIPE_MAX_SLIDE_PX}px)`);
    fireTouch(body, "touchend", { clientX: CENTER_X + SWIPE_MAX_SLIDE_PX + 60, clientY: 302 });
    // Snap back: the inline transform is dropped so the CSS transition runs.
    expect(row.style.transform).toBe("");
    expect(row.classList.contains(SWIPING_CLASS)).toBe(false);
  });

  it("snaps the row back on touchcancel without replying", () => {
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 300 });
    fireTouch(body, "touchmove", { clientX: CENTER_X + 90, clientY: 302 });
    fireTouch(body, "touchcancel", { clientX: CENTER_X + 90, clientY: 302 });
    expect(row.style.transform).toBe("");
    expect(onReply).not.toHaveBeenCalled();
  });

  it("does NOT reply on a right drag that stays under the 40px floor", () => {
    swipeRight(body, 24);
    expect(onReply).not.toHaveBeenCalled();
  });

  // The hard constraint, inherited from #308: a vertical drag is never claimed,
  // so native scroll through the scrollback is byte-for-byte untouched.
  it("NEVER claims a vertical drag (scrollback scroll survives)", () => {
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 200 });
    const m1 = fireTouch(body, "touchmove", { clientX: CENTER_X + 3, clientY: 300 });
    const m2 = fireTouch(body, "touchmove", { clientX: CENTER_X + 6, clientY: 420 });
    fireTouch(body, "touchend", { clientX: CENTER_X + 6, clientY: 480 });
    expect(m1.defaultPrevented).toBe(false);
    expect(m2.defaultPrevented).toBe(false);
    expect(onReply).not.toHaveBeenCalled();
    expect(row.style.transform).toBe("");
  });

  // dx→sx is explicitly NOT decided (#1067: "vabe vediamo come viene"). We must
  // not eat the gesture: no claim, no slide, no callback.
  it("leaves a right→left drag entirely alone (that direction is unspecified)", () => {
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 300 });
    const m = fireTouch(body, "touchmove", { clientX: CENTER_X - 90, clientY: 302 });
    fireTouch(body, "touchend", { clientX: CENTER_X - 120, clientY: 303 });
    expect(m.defaultPrevented).toBe(false);
    expect(row.style.transform).toBe("");
    expect(onReply).not.toHaveBeenCalled();
  });

  // #1041 owns the left edge: a right swipe there opens the channel sidebar.
  // Zone separation is what keeps the two gestures from both firing.
  it("never arms in the left edge zone (#1041's sidebar swipe wins)", () => {
    fireTouch(body, "touchstart", { clientX: 5, clientY: 300 });
    const m = fireTouch(body, "touchmove", { clientX: 100, clientY: 303 });
    fireTouch(body, "touchend", { clientX: 190, clientY: 305 });
    expect(m.defaultPrevented).toBe(false);
    expect(onReply).not.toHaveBeenCalled();
  });

  it("never arms on an inline control inside the row (link keeps its own gesture)", () => {
    swipeRight(link, 90);
    expect(onReply).not.toHaveBeenCalled();
    expect(row.style.transform).toBe("");
  });

  // Once Select… has handed back a native selection the operator drags its
  // endpoints — horizontally, across message text. Hijacking that into a reply
  // would make the escape hatch unusable.
  it("never arms while a live selection is being adjusted", () => {
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      toString: () => "some selected text",
    } as unknown as Selection);
    swipeRight(body, 90);
    expect(onReply).not.toHaveBeenCalled();
    vi.advanceTimersByTime(LONG_PRESS_MS + 100);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("never arms outside a message row", () => {
    const stray = document.createElement("div");
    pane.appendChild(stray);
    swipeRight(stray, 90);
    expect(onReply).not.toHaveBeenCalled();
  });

  it("ignores a multi-touch gesture (a pinch is not a swipe)", () => {
    fireTouch(
      body,
      "touchstart",
      { clientX: CENTER_X, clientY: 300 },
      { clientX: CENTER_X + 50, clientY: 300 },
    );
    const m = fireTouch(
      body,
      "touchmove",
      { clientX: CENTER_X + 90, clientY: 302 },
      { clientX: CENTER_X + 140, clientY: 302 },
    );
    fireTouch(body, "touchend", { clientX: CENTER_X + 90, clientY: 302 });
    expect(m.defaultPrevented).toBe(false);
    expect(onReply).not.toHaveBeenCalled();
  });
});

describe("bindMessageGestures — long press = message menu", () => {
  it("opens the menu for the row after the hold threshold, at the touch point", () => {
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 300 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress.mock.calls[0]?.[0]).toBe(row);
    expect(onLongPress.mock.calls[0]?.[1]).toEqual({ x: CENTER_X, y: 300 });
  });

  // The whole point of the #1067 pivot away from #366: the menu behaves the
  // same whether or not the compose box has focus. No keyboard gate.
  it("opens with the compose box focused too (no keyboard-up gate)", () => {
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.focus();
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 300 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("does not open on a short tap", () => {
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 300 });
    vi.advanceTimersByTime(LONG_PRESS_MS - 50);
    fireTouch(body, "touchend", { clientX: CENTER_X, clientY: 300 });
    vi.advanceTimersByTime(500);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("cancels the hold once the finger moves past the tolerance (a scroll)", () => {
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 300 });
    fireTouch(body, "touchmove", {
      clientX: CENTER_X,
      clientY: 300 + HOLD_MOVE_TOLERANCE_PX + 5,
    });
    vi.advanceTimersByTime(LONG_PRESS_MS + 100);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("survives a jitter under the tolerance", () => {
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 300 });
    fireTouch(body, "touchmove", { clientX: CENTER_X + 2, clientY: 303 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  // Once the menu is up the finger release must not ALSO fire a reply, and it
  // must not synthesize the click that would immediately close the menu on its
  // own backdrop — preventing the touchend is the spec-blessed way to say so.
  it("suppresses the release after a hold: no reply, and the tap is cancelled", () => {
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 300 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    const end = fireTouch(body, "touchend", { clientX: CENTER_X, clientY: 300 });
    expect(onReply).not.toHaveBeenCalled();
    expect(end.defaultPrevented).toBe(true);
  });

  it("does not arm on an inline control inside the row", () => {
    fireTouch(link, "touchstart", { clientX: CENTER_X, clientY: 300 });
    vi.advanceTimersByTime(LONG_PRESS_MS + 100);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("drops the pending hold when the binder is disposed mid-touch", () => {
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 300 });
    dispose();
    vi.advanceTimersByTime(LONG_PRESS_MS + 100);
    expect(onLongPress).not.toHaveBeenCalled();
  });
});

// #1156 — a presence row (join/part/quit) armed the swipe like any other, slid
// 72px, and then delivered nothing: `replyQuote` returns null for it, so the
// compose box stayed empty. A 72px slide IS a promise. The gate is the SWIPE
// alone — the long-press menu still opens, because Copy and Select… are useful
// on a join and Reply is already disabled-but-visible there.
describe("bindMessageGestures — a row the call site refuses (#1156)", () => {
  it("never fires onReply on it, however far the finger travels", () => {
    swipeRight(refusedBody, 200);
    expect(onReply).not.toHaveBeenCalled();
  });

  it("never slides it: no promise is made in the first place", () => {
    fireTouch(refusedBody, "touchstart", { clientX: CENTER_X, clientY: 300 });
    fireTouch(refusedBody, "touchmove", { clientX: CENTER_X + 40, clientY: 302 });
    expect(refusedRow.style.transform).toBe("");
    expect(refusedRow.classList.contains(SWIPING_CLASS)).toBe(false);
  });

  // An unarmed row is not a dead row: with no claim the drag keeps its native
  // drag-to-select, exactly like the unbound right→left direction.
  it("never claims the drag, so native drag-to-select survives on it", () => {
    const { moves } = swipeRight(refusedBody, 200);
    expect(moves.some((m) => m.defaultPrevented)).toBe(false);
  });

  it("still opens the message menu on a long press (Copy / Select… live there)", () => {
    fireTouch(refusedBody, "touchstart", { clientX: CENTER_X, clientY: 300 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress.mock.calls[0]?.[0]).toBe(refusedRow);
  });

  // The hold is cancelled by movement, and that cancellation cannot ride on the
  // swipe's arming state: a scroll that starts on a join row must not leave a
  // timer behind that opens the menu 500ms into the flick.
  it("still cancels the pending hold when the finger scrolls off it", () => {
    fireTouch(refusedBody, "touchstart", { clientX: CENTER_X, clientY: 300 });
    fireTouch(refusedBody, "touchmove", {
      clientX: CENTER_X,
      clientY: 300 + HOLD_MOVE_TOLERANCE_PX + 5,
    });
    vi.advanceTimersByTime(LONG_PRESS_MS + 100);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  // Asked per ROW, not once per pane: the two rows sit in the same container
  // behind the same listener, and the content one is untouched by the gate.
  it("leaves the content row beside it armed", () => {
    swipeRight(refusedBody, 200);
    swipeRight(body, 90);
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onReply.mock.calls[0]?.[0]).toBe(row);
  });
});

// #1413 — the hold used to run its 500ms in total silence: the timer armed on
// touchstart and NOTHING was drawn until the menu was already up, so the press
// read as a dead touch. The sibling gesture has never had that problem — the
// swipe slides the row under the finger, and #1156 refused to arm that slide
// where nothing could be quoted precisely because the slide IS the promise. The
// hold makes the same promise, so it has to show the same kind of evidence.
//
// The class is driven off the SAME state the timer is driven off: one machine,
// so what is painted and what will fire cannot disagree. Every way the timer
// can die — release, drift past the tolerance, cancel, dispose — unpaints it,
// because they all pass through `cancelHold`.
//
// jsdom proves the MECHANICS only. Whether the ramp reads as an acknowledgement
// on a real phone, and whether iOS paints anything of its own during those
// 500ms, is a device call.
describe("bindMessageGestures — the hold announces itself (#1413)", () => {
  it("paints the row from touchstart, while the timer is still running", () => {
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 300 });
    expect(row.classList.contains(HOLDING_CLASS)).toBe(true);
    vi.advanceTimersByTime(LONG_PRESS_MS - 50);
    expect(row.classList.contains(HOLDING_CLASS)).toBe(true);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  // Hands the ramp its duration from the constant rather than letting the
  // stylesheet keep a second copy of 500 — the two would drift the day the
  // threshold moves, and the cue would then finish early or late.
  it("hands the CSS the hold duration, so the ramp cannot drift from the timer", () => {
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 300 });
    expect(row.style.getPropertyValue(HOLD_MS_VAR)).toBe(`${LONG_PRESS_MS}ms`);
  });

  it("unpaints it when the menu opens: the promise has been kept", () => {
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 300 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(row.classList.contains(HOLDING_CLASS)).toBe(false);
    expect(row.style.getPropertyValue(HOLD_MS_VAR)).toBe("");
  });

  it("unpaints it on the release of a short tap", () => {
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 300 });
    vi.advanceTimersByTime(LONG_PRESS_MS - 50);
    fireTouch(body, "touchend", { clientX: CENTER_X, clientY: 300 });
    expect(row.classList.contains(HOLDING_CLASS)).toBe(false);
  });

  // The same escape the timer already honours: past the tolerance this is a
  // scroll or a swipe, and a row still lit under a scrolling finger would be
  // promising a menu that is no longer coming.
  it("unpaints it once the finger drifts past the tolerance", () => {
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 300 });
    fireTouch(body, "touchmove", {
      clientX: CENTER_X,
      clientY: 300 + HOLD_MOVE_TOLERANCE_PX + 5,
    });
    expect(row.classList.contains(HOLDING_CLASS)).toBe(false);
    vi.advanceTimersByTime(LONG_PRESS_MS + 100);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("keeps it through a jitter under the tolerance (a real finger is never still)", () => {
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 300 });
    fireTouch(body, "touchmove", { clientX: CENTER_X + 2, clientY: 303 });
    expect(row.classList.contains(HOLDING_CLASS)).toBe(true);
  });

  it("unpaints it on touchcancel", () => {
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 300 });
    fireTouch(body, "touchcancel", { clientX: CENTER_X, clientY: 300 });
    expect(row.classList.contains(HOLDING_CLASS)).toBe(false);
  });

  it("unpaints it when the binder is disposed mid-touch", () => {
    fireTouch(body, "touchstart", { clientX: CENTER_X, clientY: 300 });
    dispose();
    expect(row.classList.contains(HOLDING_CLASS)).toBe(false);
  });

  // Never paints where the hold never armed: the cue means "a menu is coming",
  // and on an inline control (#350 link, #354 nick) it is not.
  it("never paints a row whose hold never armed", () => {
    fireTouch(link, "touchstart", { clientX: CENTER_X, clientY: 300 });
    expect(row.classList.contains(HOLDING_CLASS)).toBe(false);
    vi.advanceTimersByTime(LONG_PRESS_MS + 100);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  // #1156 gates the SWIPE, not the hold: the menu opens on a join row too, so
  // the cue that announces it has to appear there as well. Reading the paint
  // off the swipe's arming state would have left presence rows silent.
  it("paints a row the call site refuses a reply for (the hold arms there too)", () => {
    fireTouch(refusedBody, "touchstart", { clientX: CENTER_X, clientY: 300 });
    expect(refusedRow.classList.contains(HOLDING_CLASS)).toBe(true);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(refusedRow.classList.contains(HOLDING_CLASS)).toBe(false);
  });
});
