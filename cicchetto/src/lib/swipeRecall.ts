import { isDiagEnabled } from "../DiagFloat";
import { diagPush } from "./diagLog";
import { claimAxis, type DragAxis, gestureAction, type Point, type ScrollBoundary } from "./swipe";

// #178/#203/#123 — swipe recall over a one-row prompt, in ONE place. The
// composer owned the only copy until issue 2429 gave the services console the
// same gesture; the review of that PR caught the copy-paste (CLAUDE.md:
// "Implement once … never copy-paste with tweaks") and this module is the
// answer. Behaviour is the composer's, unchanged, diagnostics included.
//
// TOUCH (not pointer) events: only touchmove.preventDefault reliably
// suppresses iOS's native scroll + drag-to-select. Bound on the element
// itself, NOT through JSX onTouch*: Solid delegates touch events to a single
// PASSIVE listener on `document`, where preventDefault silently no-ops, and
// touchmove must be non-passive to suppress iOS's native scroll at the
// handoff.
//
// #123 nested-scroll boundary handoff — the textarea is an INNER scroll
// surface; the swipe is the OUTER gesture. The inner scroll owns the vertical
// drag WHILE it still has room in that direction; the instant it hits its edge
// it CEDES the rest of this same touch to the gesture. That is why the
// boundary is read LIVE on every touchmove, not snapshotted at touchstart: a
// frozen snapshot only ever handed off from an already-at-edge start, so a
// mid-scrolled draft ate the drag and the gesture only fired on a SECOND touch
// (the "double-swipe" bug). `claimAxis` owns the direction→edge mapping; the
// flick test is deferred to touchend over the WHOLE gesture (`gestureAction`),
// where displacement + elapsed are reliable.
export type SwipeRecallOptions = {
  /** swipe UP — older history, unconditional (parity with ArrowUp; #203). */
  onPrev: () => void;
  /** swipe DOWN — newer history; `canNext` says whether it may act (#178). */
  onNext: () => void;
  /** A down-flick's job is walking back toward a parked draft: gate it. */
  canNext: () => boolean;
  /**
   * swipe RIGHT — the Tab affordance (nick/channel completion). REQUIRED: both
   * current surfaces complete, the composer its draft and the console its
   * prompt, so an optional field only ever hid a surface that forgot to say. A
   * future surface with nothing to complete says so with a no-op.
   */
  onTab: (el: HTMLTextAreaElement) => void;
};

/** Bind the listeners; returns the unbind. */
export function bindSwipeRecall(el: HTMLTextAreaElement, opts: SwipeRecallOptions): () => void {
  let swipeStart: Point | null = null;
  // Wall-clock at touchstart (ms). Feeds the touchend velocity gate so a slow
  // release is told apart from a fast flick. Browser time is legitimate here —
  // the Date.now / performance.now ban is a workflow-script rule, not cic
  // runtime. Reset every touchstart; read once, at touchend.
  let swipeStartTime = 0;
  let claimedAxis: DragAxis | null = null;
  // issue 2356 — touchmoves received this touch, claimed or not. Diag only:
  // it splits "no touchmove ever arrived" from "moved, but not claimed".
  let moveCount = 0;
  // issue 2356 — touchstart's own event timestamp. Diag only: END prints the
  // touchend's timestamp minus this one, read off the events rather than off
  // the handler clock, so events queued behind other work don't shrink it.
  let swipeStartStamp = 0;
  // On-device gesture diagnostics (#123): captured once per touch at
  // touchstart so the flag is read a single time, not per move. When on,
  // touchstart / claim / touchend push a line into diagLog for DiagFloat to
  // render — the evidence webkit playwright can't produce.
  let diagOn = false;

  const scrollBoundary = (): ScrollBoundary => {
    const maxScroll = el.scrollHeight - el.clientHeight;
    return { atTop: el.scrollTop <= 0, atBottom: el.scrollTop >= maxScroll - 1 };
  };

  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches.length === 1 ? e.touches[0] : undefined;
    swipeStart = t ? { x: t.clientX, y: t.clientY } : null;
    swipeStartTime = performance.now();
    swipeStartStamp = e.timeStamp;
    claimedAxis = null;
    moveCount = 0;
    diagOn = isDiagEnabled();
    if (diagOn && t) {
      // issue 2356 — `cx` is where the finger landed, in px from the left
      // edge of the textarea's text (its content box): negative is the
      // padding or the border, positive is over the typed text or past its
      // end. END's dx/dy are touchend's own point measured from this one.
      const textLeft =
        el.getBoundingClientRect().left +
        el.clientLeft +
        Number.parseFloat(getComputedStyle(el).paddingLeft);
      diagPush(
        `TS cx=${Math.round(t.clientX - textLeft)} y=${Math.round(t.clientY)} st=${el.scrollTop} sh=${el.scrollHeight} ch=${el.clientHeight} sel=${el.selectionStart},${el.selectionEnd}`,
      );
    }
  };

  const onTouchMove = (e: TouchEvent) => {
    moveCount += 1;
    if (swipeStart === null || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (t === undefined) return;
    if (claimedAxis === null) {
      // Read the scroll boundary LIVE every move: the textarea may have
      // native-scrolled to its edge DURING this touch, and the gesture must
      // hand off the instant it does. A vertical drag WITH room returns null →
      // we stay hands-off so pan-y scrolls the draft.
      const boundary = scrollBoundary();
      // #1205 — the DOM half of the selection gate: a non-collapsed selection
      // means this horizontal drag is a handle drag, and claiming it would
      // preventDefault the very thing the user is doing. Live like the
      // boundary, and unreadable counts as collapsed (the pre-#1205 claim).
      const selectionActive = el.selectionStart !== el.selectionEnd;
      claimedAxis = claimAxis(
        swipeStart,
        { x: t.clientX, y: t.clientY },
        boundary,
        selectionActive,
      );
      if (claimedAxis === null) return;
      if (diagOn) {
        diagPush(
          `CLAIM ${claimedAxis} up=${t.clientY - swipeStart.y < 0} atTop=${boundary.atTop} atBot=${boundary.atBottom} st=${el.scrollTop}`,
        );
      }
    }
    // Suppress native scroll + drag-to-select once we own the gesture.
    e.preventDefault();
  };

  const onTouchEnd = (e: TouchEvent) => {
    const start = swipeStart;
    const claimed = claimedAxis;
    swipeStart = null;
    const t = e.changedTouches[0];
    if (start === null || t === undefined) return;
    const end = { x: t.clientX, y: t.clientY };
    // Full-gesture velocity + direction → action (null: never claimed / slow
    // release / no mapped direction). The boundary gate already ran at claim.
    const action =
      claimed === null ? null : gestureAction(start, end, performance.now() - swipeStartTime);
    if (diagOn) {
      // issue 2356 — dx, the move count and the selection are what separate
      // the three ways a horizontal drag goes unclaimed (#1205 selection, no
      // touchmove, under the slop) from each other and from a tap. `ms` is
      // this touchend's timestamp minus touchstart's, which times the
      // touchend against the drag the finger made.
      diagPush(
        `END claimed=${claimed ?? "no"} act=${action ?? "none"} dy=${Math.round(end.y - start.y)} st=${el.scrollTop} dx=${Math.round(end.x - start.x)} moves=${moveCount} ms=${Math.round(e.timeStamp - swipeStartStamp)} sel=${el.selectionStart},${el.selectionEnd}`,
      );
    }
    switch (action) {
      case "recall-prev":
        // #203 — swipe-UP recalls unconditionally (parity with ArrowUp).
        opts.onPrev();
        break;
      case "recall-next":
        // #178 — swipe-DOWN recall stays gated on a non-empty draft.
        if (opts.canNext()) opts.onNext();
        break;
      case "tab-complete":
        opts.onTab(el);
        break;
    }
  };

  // issue 2356 — a touch the platform takes away ends here instead of at
  // touchend, so it fires nothing. For a one-finger touch, a TS with no END
  // already says that no touchend arrived (the ring drops its OLDEST lines,
  // so an END cannot scroll out while its TS is still shown); this line
  // tells a cancel apart from a touch that got neither event.
  const onTouchCancel = (e: TouchEvent) => {
    const start = swipeStart;
    const t = e.changedTouches[0];
    if (!diagOn || start === null || t === undefined) return;
    diagPush(
      `CANCEL claimed=${claimedAxis ?? "no"} dy=${Math.round(t.clientY - start.y)} st=${el.scrollTop} dx=${Math.round(t.clientX - start.x)} moves=${moveCount} sel=${el.selectionStart},${el.selectionEnd}`,
    );
  };

  el.addEventListener("touchstart", onTouchStart, { passive: true });
  el.addEventListener("touchmove", onTouchMove, { passive: false });
  el.addEventListener("touchend", onTouchEnd, { passive: true });
  el.addEventListener("touchcancel", onTouchCancel, { passive: true });
  return () => {
    el.removeEventListener("touchstart", onTouchStart);
    el.removeEventListener("touchmove", onTouchMove);
    el.removeEventListener("touchend", onTouchEnd);
    el.removeEventListener("touchcancel", onTouchCancel);
  };
}
