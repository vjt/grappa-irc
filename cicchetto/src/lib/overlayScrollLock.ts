// Refcounted overlay scroll-lock — locks iOS scroll/rubber-band while
// ANY mobile overlay is open (members drawer, settings drawer, archive
// modal, image-upload privacy modal, admin pane on mobile).
//
// Why this exists (UX-6 bucket A, v1→v6, 2026-05-20).
//
// vjt 2026-05-20 iPhone PWA dogfood: keyboard-up + open overlay + drag
// from inside overlay → entire viewport visually shifts during the
// drag and snaps back on release. iOS Safari PWA rubber-band on a
// touch whose hit-test element has no scrollable ancestor in the drag
// direction. UIKit's UIScrollView claims the gesture at touchstart;
// CSS `touch-action` / `overscroll-behavior` alone are insufficient
// to stop UIKit. v1/v2/v3 (CSS-only) all failed.
//
// v4 introduced body-scroll-lock-upgrade — which closed the leak but
// also killed the natural iOS bounce when scrolling-to-edge of a
// registered scroller (the lib preventDefaults at the scroll edge
// to stop the page rubber-banding through the scroller). v5 tried
// `allowTouchMove: target.contains(el)` to bypass the edge check —
// brought the leak back because that's exactly what stops it.
//
// v6 is a custom handler that replaces body-scroll-lock entirely.
// Rule: non-passive touchmove listener at document level; on each
// touchmove walk the gesture target's ancestor chain. If ANY
// ancestor (up to body) is scrollable in either axis, let iOS handle
// the gesture natively (including the bounce at scroller edges).
// If no scrollable ancestor exists, `preventDefault()` — that stops
// UIKit from claiming the gesture as a page pan and there's no
// scroll surface for iOS to escalate to.
//
// `overscroll-behavior: contain` on the overlay scroller keeps the
// iOS bounce chain inside the scroller (no propagation to <body>).
// All overlay scrollers already have this contract per UX-5 BO + v2.
//
// Refcount semantics: multiple overlays can overlap during
// transitions (archive opens before members closes). Each surface
// pushes/pops; the document-level touchmove listener attaches when
// the first overlay opens and detaches when the last closes.
//
// `html.overlay-open` class remains as a CSS sentinel + the v3 CSS
// lock chain (`html.overlay-open body/#root/#root>div { touch-action:
// none }`) stays as defense-in-depth.
//
// Test surface: pure module state + DOM side-effects. `__resetForTest()`
// clears refcount + class + detaches the listener so vitest order
// doesn't leak state across tests.

import { createEffect, onCleanup } from "solid-js";

const CLASS_NAME = "overlay-open";

let count = 0;
let listenerAttached = false;

function root(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.documentElement;
}

function applyClass(): void {
  const el = root();
  if (el === null) return;
  if (count > 0) {
    el.classList.add(CLASS_NAME);
  } else {
    el.classList.remove(CLASS_NAME);
  }
}

/**
 * touchmove handler — preventDefault unless the gesture target has a
 * scrollable ancestor. Walks up from the target; for each ancestor
 * checks (a) is it scrollable in either axis (overflow: auto/scroll
 * AND scrollHeight > clientHeight OR scrollWidth > clientWidth)? If
 * yes at any level → let the gesture through (iOS native scroll +
 * bounce). If we reach <body> without finding a scrollable ancestor
 * → preventDefault → UIKit can't claim the gesture.
 *
 * Exported only for vitest assertions.
 */
export function handleTouchmove(e: TouchEvent): void {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  let cur: HTMLElement | null = target;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    const cs = getComputedStyle(cur);
    const canScrollY =
      (cs.overflowY === "auto" || cs.overflowY === "scroll") && cur.scrollHeight > cur.clientHeight;
    const canScrollX =
      (cs.overflowX === "auto" || cs.overflowX === "scroll") && cur.scrollWidth > cur.clientWidth;
    if (canScrollY || canScrollX) return;
    cur = cur.parentElement;
  }
  if (e.cancelable) e.preventDefault();
}

function attachListener(): void {
  if (listenerAttached || typeof document === "undefined") return;
  document.addEventListener("touchmove", handleTouchmove, { passive: false });
  listenerAttached = true;
}

function detachListener(): void {
  if (!listenerAttached || typeof document === "undefined") return;
  document.removeEventListener("touchmove", handleTouchmove);
  listenerAttached = false;
}

/**
 * Push an overlay onto the lock stack. Pair with `popOverlay()`. The
 * `target` parameter is kept for API stability with v4/v5 call sites
 * but is unused in v6 — the touchmove handler walks ancestors
 * dynamically rather than tracking a registered list. Future
 * refactor can drop the parameter.
 */
export function pushOverlay(_target: HTMLElement | null): void {
  count += 1;
  applyClass();
  attachListener();
}

/**
 * Pop an overlay off the lock stack. Pops below zero are clamped.
 * Detaches the touchmove listener when the refcount drops to zero.
 */
export function popOverlay(_target: HTMLElement | null): void {
  count = Math.max(0, count - 1);
  applyClass();
  if (count === 0) detachListener();
}

/** Current refcount — exposed for vitest assertions. */
export function overlayCount(): number {
  return count;
}

/** Whether the document-level touchmove listener is currently attached. */
export function isListenerAttached(): boolean {
  return listenerAttached;
}

/** Test reset — clears refcount, DOM class, and detaches listener. */
export function __resetForTest(): void {
  count = 0;
  const el = root();
  if (el !== null) el.classList.remove(CLASS_NAME);
  detachListener();
}

/**
 * Component-side overlay-lock wiring — review extraction (2026-06-11).
 * ArchiveModal, PrivacyModal and MediaViewerModal each carried a
 * verbatim copy of this edge-triggered push/pop block; the third copy
 * triggered the "implement once, reuse everywhere" extraction. Call
 * from a component body (needs a Solid owner for createEffect /
 * onCleanup):
 *
 *   createOverlayLock(() => myOpenSignal() !== null, ".my-modal");
 *
 * Edge-triggered via the wasOpen closure so re-renders with the same
 * value don't double-push. The push is deferred a microtask (v4: the
 * lock targets the modal element, which mounts inside `<Show>` — let
 * Solid commit the render before querySelector). The microtask
 * RE-CHECKS wasOpen: a same-task open→close (or open→unmount) runs
 * popOverlay (clamped at 0) BEFORE the queued push fires, and an
 * unconditional push would strand the refcount at 1 forever — no
 * later overlay cycle could drain it (popOverlay clamps), leaving the
 * `html.overlay-open` class + the non-passive document touchmove
 * preventDefault attached until full reload (permanent iOS
 * scroll-lock). Latent in the pre-extraction copies; fixed once here.
 */
export function createOverlayLock(isOpen: () => boolean, selector: string): void {
  // wasOpen = desired state (tracks the signal edge); pushed = actual
  // lock state (whether OUR push reached the refcount). Tracked
  // separately so the deferred push can neither fire after a same-task
  // close (wasOpen false → skip) nor double-fire after a same-task
  // close+reopen queued two microtasks (pushed true → skip).
  let wasOpen = false;
  let pushed = false;
  let lockedEl: HTMLElement | null = null;
  const release = (): void => {
    if (pushed) {
      popOverlay(lockedEl);
      pushed = false;
    }
    lockedEl = null;
  };
  createEffect(() => {
    const open = isOpen();
    if (open && !wasOpen) {
      wasOpen = true;
      queueMicrotask(() => {
        if (!wasOpen || pushed) return;
        lockedEl = document.querySelector<HTMLElement>(selector);
        pushOverlay(lockedEl);
        pushed = true;
      });
    } else if (!open && wasOpen) {
      wasOpen = false;
      release();
    }
  });
  onCleanup(() => {
    wasOpen = false;
    release();
  });
}
