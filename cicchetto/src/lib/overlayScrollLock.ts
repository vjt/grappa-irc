// Refcounted overlay scroll-lock — toggles `html.overlay-open` while
// ANY mobile overlay is open (members drawer, settings drawer, archive
// modal, image-upload privacy modal, admin pane).
//
// Why this exists (UX-6 bucket A, 2026-05-20).
//
// vjt 2026-05-20 iPhone dogfood: opening members drawer or archive
// modal STILL allowed background app chrome to scroll underneath.
// UX-5 BO (`03a08f5`) added `touch-action: pan-y` +
// `overscroll-behavior: contain` to 6 `.shell-mobile` descendants
// (settings, archive, image-upload, home, admin, admin-tab-panel).
// That CSS contract is correct AND already in place on all the
// failing surfaces. The gesture-routing pair only protects the
// PRIMARY scroll path though — the touch-drag inside the overlay.
//
// The leak vjt sees is the OTHER path: iOS Safari's PROGRAMMATIC
// scroll attempts (auto-scroll-to-focused-input, gesture
// escalation after the inner scroller reaches its edge, etc).
// `lib/viewportHeight.ts:installScrollPin` was the original UX-3
// defense — capture `window.scroll` events, snap `scrollTo(0, 0)`
// to kill the symptom. But the snap-yank IS the operator-visible
// flicker on short-content overlays (members list with <5 nicks,
// empty archive, etc): the pan-y carve-out has nothing to consume
// the gesture, iOS escalates, installScrollPin fires, the visible
// effect is "the whole app flickered."
//
// The fix: while ANY overlay is open, treat that as the only
// scroll surface the user can interact with. Tag `<html>` with
// `.overlay-open`; CSS pins the root document to fully-fixed
// (no scrollable surface left for iOS to escalate to). When the
// last overlay closes, the class drops and installScrollPin's
// defensive snap resumes normal duties.
//
// Refcount semantics: multiple overlays may briefly overlap during
// transitions (e.g. archive modal opens before members drawer
// finishes closing). Push on open, pop on close, drop the class
// only when the count hits zero.
//
// Test surface: pure module-singleton state + DOM side-effect.
// `__resetForTest()` re-initializes the count + clears the class
// for vitest. Call sites pass an `isOpen()` accessor and the
// helper handles the `createEffect`-style edge detection.
//
// No SolidJS imports here on purpose: the helper is reactive-agnostic
// (call from createEffect or onMount/onCleanup either way). Keeps
// the test surface a plain numeric refcount with no JSDOM-vs-real-
// DOM reactive-context wrangling.

const CLASS_NAME = "overlay-open";

let count = 0;

function root(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.documentElement;
}

function apply(): void {
  const el = root();
  if (el === null) return;
  if (count > 0) {
    el.classList.add(CLASS_NAME);
  } else {
    el.classList.remove(CLASS_NAME);
  }
}

/** Increment refcount. Idempotent across callers; pair with `popOverlay()`. */
export function pushOverlay(): void {
  count += 1;
  apply();
}

/** Decrement refcount. Pops below zero are clamped to 0 (defensive). */
export function popOverlay(): void {
  count = Math.max(0, count - 1);
  apply();
}

/** Current refcount — exposed for vitest assertions. */
export function overlayCount(): number {
  return count;
}

/** Test reset — clears refcount + DOM class. */
export function __resetForTest(): void {
  count = 0;
  const el = root();
  if (el !== null) el.classList.remove(CLASS_NAME);
}
