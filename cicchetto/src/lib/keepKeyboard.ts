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

import { isDiagEnabled } from "../DiagFloat";
import { diagPush } from "./diagLog";
import { isIos } from "./platform";

// The selectable-TEXT surfaces where a mousedown's preventDefault is
// DURATION-GATED (see LONG_PRESS_MS / handleMouseDown) instead of always
// firing: preventDefault cancels the focus shift AND the
// text-selection-drag start, so on copyable text we only fire it for a
// long-press (keep the keyboard so the selection survives) and skip it
// for a tap (let the keyboard dismiss). This list MUST stay in sync with
// default.css's `html.is-ios .scrollback, .topic-modal-text`
// `user-select: text` re-enable — a new copyable surface must be added to
// BOTH sites or the two policies drift (same shape as the nick-fold
// SQL/fragment invariant). See docs/DESIGN_NOTES.md 2026-06-11
// (Dispatch-1) + 2026-07-03 (#79 v1) + 2026-07-04 (#79 long-press rework).
const SELECTABLE_TEXT_SURFACES = ".scrollback, .topic-modal-text";
// Controls that live INSIDE a selectable surface whose KEYBOARD policy is
// "always preserve on tap" — the exclude wins in isSelectableSurface, so
// they fall through to the always-fire preventDefault path (keyboard kept
// on tap AND long-press, never a tap-to-close).
//
// This is the KEYBOARD/focus policy, which is INDEPENDENT of the CSS
// text-selection policy (default.css's `html.is-ios` `user-select`
// re-exclude) — do NOT assume this list mirrors the CSS one:
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
const SELECTABLE_TEXT_EXCLUDE = ".scrollback-invite-join, .scrollback-link";

// #79 (2026-07-04) — long-press threshold, shared by BOTH the mousedown
// tap-vs-hold split and the #366 touchend select-all. For a TAP, iOS
// dispatches a mousedown on finger RELEASE, so `mousedown - touchstart` is
// the held duration: below the threshold is a TAP (let the keyboard
// dismiss — vjt-confirmed tap-to-close, KEEP). At/above WOULD be a
// long-press — but note (2026-07-21, #366): on a real long-press iOS
// synthesizes NO mousedown at all (only taps do), so the long-press
// select-all is detected on `touchend` instead (see handleTouchEnd); the
// mousedown long-press arm survives only as a cross-platform net. 500ms
// matches iOS's own long-press convention. Feel accepted by vjt
// 2026-07-04; device-judged post-ship.
export const LONG_PRESS_MS = 500;

function isTextEntry(el: Element | null): boolean {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

// True when a mousedown target sits on copyable text — the surfaces where
// preventDefault is duration-gated (tap dismisses, long-press selects)
// rather than always fired. The exclude wins: the [Join] CTA lives inside
// .scrollback but is a control, so it falls through to the always-fire
// path (keyboard preserved regardless of hold duration).
function isSelectableSurface(el: Element | null): boolean {
  if (el === null) return false;
  if (el.closest(SELECTABLE_TEXT_EXCLUDE) !== null) return false;
  return el.closest(SELECTABLE_TEXT_SURFACES) !== null;
}

// #366 — companion to #79. On a LONG-PRESS with the keyboard up, native
// char-range selection is unreliable on mobile (#79 tracks that native
// failure), so we BYPASS it: programmatically select the ENTIRE message
// row under the press, giving a working "grab this whole message"
// affordance. We select the whole `.scrollback-line` (timestamp + sender +
// body) rather than only `.scrollback-body`, so the rule is uniform across
// every message kind — for a PRIVMSG the sender nick lives OUTSIDE
// `.scrollback-body`, so a body-only select would drop the nick from the
// copy. Scoped to `.scrollback-line`: the `.topic-modal-text` block has no
// per-message structure, so a long-press there returns false and keeps the
// #79 native-selection-preserve path unchanged.
//
// Returns whether a message row was found and selected — lets the caller
// stay a one-liner and keeps the decision unit-testable independently of
// jsdom's no-op Selection (the e2e covers the real-browser selection).
export function selectEntireMessage(target: Element | null): boolean {
  if (target === null) return false;
  // SSR/no-DOM safety, mirroring installKeyboardPreserve — at the top so it
  // also guards the document.createRange() below (a real Element target
  // implies a DOM, so in practice this never trips at the mousedown callsite).
  if (typeof document === "undefined") return false;
  const line = target.closest(".scrollback-line");
  if (line === null) return false;
  const selection = window.getSelection();
  if (selection === null) return false;
  const range = document.createRange();
  range.selectNodeContents(line);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

// Timestamp (performance.now, monotonic) of the most recent touchstart —
// the mousedown handler reads it to classify a selectable-surface press
// as tap vs long-press. 0 until the first touch; the desktop/no-touch
// path never reaches the duration check (gated by isIos() upstream).
let touchStartAt = 0;

// #366 real-iOS path — long-press detection driven by TOUCH events, not the
// synthetic mousedown. The #79/#366 mousedown model assumed iOS dispatches a
// mousedown on finger-RELEASE even for a long-press, but on real iOS Safari
// a long-press that the OS routes into native text-selection/callout
// synthesizes NO mouse events (only TAPS do) — so the mousedown-gated
// select-all fired "absolutely nothing" on device (vjt 2026-07-21). Touch
// events fire regardless of that routing, so select-all rides `touchend`: a
// hold at/after LONG_PRESS_MS that did NOT move (a press, not a scroll)
// selects the whole message row. The mousedown branch stays as-is — it still
// carries the tap keyboard-preserve/close policy AND is a harmless net for
// any platform that DOES emit a long-press mousedown (idempotent with this).
//
// Passive throughout: we only READ timing/coords + set the selection, never
// preventDefault a touch (that would block scroll; and a long-press does not
// shift focus, so the keyboard stays up without intervention — the reflow
// #79 fought never happens because no focus-shifting mousedown is dispatched).
const TOUCH_MOVE_TOLERANCE_PX = 10;
let touchStartTarget: Element | null = null;
let touchStartX = 0;
let touchStartY = 0;
let touchMoved = false;
// Keyboard-up gate (#366 scope) captured at touchstart, BEFORE the native
// long-press can blur the compose to begin selection — reading
// document.activeElement at touchend would already be stale.
let composeFocusedAtStart = false;

function firstTouchPoint(e: Event): { x: number; y: number } | null {
  const te = e as TouchEvent;
  const t = te.touches?.[0] ?? te.changedTouches?.[0];
  return t ? { x: t.clientX, y: t.clientY } : null;
}

function handleTouchStart(e: Event): void {
  touchStartAt = performance.now();
  touchStartTarget = e.target as Element | null;
  touchMoved = false;
  composeFocusedAtStart = isTextEntry(document.activeElement);
  const p = firstTouchPoint(e);
  touchStartX = p?.x ?? 0;
  touchStartY = p?.y ?? 0;
}

function handleTouchMove(e: Event): void {
  if (touchMoved) return;
  const p = firstTouchPoint(e);
  if (p === null) return; // no coords available — can't measure, stay lenient
  if (
    Math.abs(p.x - touchStartX) > TOUCH_MOVE_TOLERANCE_PX ||
    Math.abs(p.y - touchStartY) > TOUCH_MOVE_TOLERANCE_PX
  ) {
    touchMoved = true; // a scroll/pan, not a stationary long-press
  }
}

function handleTouchEnd(): void {
  if (!isIos()) return;
  if (!composeFocusedAtStart) return; // #366 scope: keyboard-up only
  if (touchMoved) return; // scrolled — not a hold
  if (!isSelectableSurface(touchStartTarget)) return;
  const heldMs = performance.now() - touchStartAt;
  if (heldMs < LONG_PRESS_MS) return; // a tap, not a long-press
  // Select the WHOLE message row (bypasses the unreliable native mobile
  // char-range selection). Returns false for a selectable surface with no
  // message row (e.g. .topic-modal-text) — its native-selection path is
  // left untouched.
  const selected = selectEntireMessage(touchStartTarget);
  if (isDiagEnabled()) {
    diagPush(
      `kb: scrollback touchend held=${Math.round(heldMs)}ms → HOLD ${selected ? "select" : "no-row"}`,
    );
  }
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
    // synthesizes NO mousedown (this branch never runs for it), so the
    // #366 select-all lives on touchend (handleTouchEnd); this arm remains
    // only as a cross-platform net. See LONG_PRESS_MS.
    const heldMs = performance.now() - touchStartAt;
    const longPress = heldMs >= LONG_PRESS_MS;
    if (longPress) {
      // #79: keep the keyboard (cancel the focus-shift so its reflow can't
      // tear down the selection). #366: ALSO select the WHOLE message,
      // bypassing the unreliable native partial selection on mobile. A
      // no-op (returns false) for a selectable surface with no message row
      // (e.g. .topic-modal-text), which keeps its native-selection path.
      e.preventDefault();
      const selected = selectEntireMessage(e.target as Element | null);
      // Log honesty: report what actually happened (select vs no message
      // row), not just that it was a long-press.
      if (isDiagEnabled()) {
        diagPush(
          `kb: scrollback md held=${Math.round(heldMs)}ms → HOLD keep+${selected ? "select" : "no-row"}`,
        );
      }
    } else if (isDiagEnabled()) {
      diagPush(`kb: scrollback md held=${Math.round(heldMs)}ms → tap close-kbd`);
    }
    return;
  }
  e.preventDefault();
}

export function installKeyboardPreserve(
  target: Document | undefined = typeof document !== "undefined" ? document : undefined,
): void {
  if (!target) return;
  target.addEventListener("mousedown", handleMouseDown, { capture: true });
  // Passive: we only READ the timestamp/coords + set the selection, never
  // preventDefault a touch — that would block scroll/pan and the native
  // selection gesture (the same reason the header hooks mousedown not
  // pointerdown). touchmove feeds the scroll-vs-hold discrimination;
  // touchend fires the #366 real-iOS select-all (see handleTouchEnd).
  target.addEventListener("touchstart", handleTouchStart, { capture: true, passive: true });
  target.addEventListener("touchmove", handleTouchMove, { capture: true, passive: true });
  target.addEventListener("touchend", handleTouchEnd, { capture: true, passive: true });
}
