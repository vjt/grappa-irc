// Refcounted overlay scroll-lock — locks iOS scroll/rubber-band while
// ANY mobile overlay is open (members drawer, settings drawer, archive
// modal, image-upload privacy modal, admin pane on mobile).
//
// Why this exists (UX-6 bucket A, v1→v4, 2026-05-20).
//
// vjt 2026-05-20 iPhone PWA dogfood: keyboard-up + open overlay + drag
// from inside overlay → entire viewport visually shifts during the
// drag and snaps back on release. iOS Safari PWA rubber-band on a
// touch whose hit-test element has no scrollable ancestor in the drag
// direction. UIKit's UIScrollView claims the gesture at touchstart;
// CSS `touch-action` / `overscroll-behavior` are irrelevant once
// UIKit owns it. v1 (CSS `html.overlay-open { touch-action: none }`),
// v2 (descendant pan-y carve-out), v3 (lock body + #root + Solid
// wrapper chain) all failed for this exact reason. v4 is the only
// mechanism that works: non-passive touchmove preventDefault, scoped
// to genuinely-scrollable descendants only.
//
// Implementation via body-scroll-lock-upgrade (~3KB, no transitive
// deps, maintained fork of body-scroll-lock). Library handles the
// document-level touchmove listener + the target-ancestor walk that
// distinguishes "drag a scrollable list" (allow) from "drag a
// non-scrollable region" (preventDefault).
//
// Refcount semantics: multiple overlays can overlap during
// transitions (archive opens before members closes). Each surface
// passes the SCROLLABLE element inside its overlay (the actual
// container with overflow: auto). The lib tracks which elements are
// "allowed to scroll" — touchmove on those propagates; everywhere
// else is preventDefaulted.
//
// `html.overlay-open` class remains as a CSS sentinel (CSS UI hook
// for any future selector that needs to know "an overlay is up" — it
// is no longer load-bearing for the rubber-band fix but is harmless
// + cheap, and the e2e suite asserts it).
//
// Test surface: pure module-singleton refcount + DOM class side-
// effect + lib delegation. `__resetForTest()` clears refcount + class
// + calls clearAllBodyScrollLocks() so vitest order doesn't leak
// state across tests.

import {
  clearAllBodyScrollLocks,
  disableBodyScroll,
  enableBodyScroll,
} from "body-scroll-lock-upgrade";

const CLASS_NAME = "overlay-open";

let count = 0;

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
 * Push an overlay onto the lock stack. Pair with `popOverlay(target)`
 * using the SAME element. `target` is the scrollable container inside
 * the overlay (the element with `overflow: auto`) — the lib allows
 * touchmove to scroll it natively and prevents touchmove everywhere
 * else.
 *
 * `allowTouchMove` lets touches INSIDE the target through unmodified,
 * including the native iOS rubber-band bounce at scroll edges. The
 * lib's default behavior preventDefaults at the scrollable's top/
 * bottom edge to stop the page rubber-banding; with our v3 CSS lock
 * chain (`html.overlay-open` cascade in default.css ~:170) the page
 * already can't rubber-band, so the edge-detection is overkill AND
 * kills the operator-expected inner bounce. vjt 2026-05-20 noted
 * "scrolling to bottom doesn't bounce anymore" — this `allowTouchMove`
 * restores the natural bounce inside the overlay.
 *
 * Idempotent for null `target` (no element available yet) — refcount
 * still bumps, CSS class still applies, but no lib lock is attached
 * (vitest jsdom path).
 */
export function pushOverlay(target: HTMLElement | null): void {
  count += 1;
  applyClass();
  if (target !== null) {
    disableBodyScroll(target, {
      allowTouchMove: (el) => target.contains(el as Node),
    });
  }
}

/**
 * Pop an overlay off the lock stack. Pair `target` with the same
 * element passed to `pushOverlay`. Pops below zero are clamped (no
 * negative refcount). Releasing a non-pushed element is a lib no-op.
 */
export function popOverlay(target: HTMLElement | null): void {
  count = Math.max(0, count - 1);
  applyClass();
  if (target !== null) enableBodyScroll(target);
}

/** Current refcount — exposed for vitest assertions. */
export function overlayCount(): number {
  return count;
}

/** Test reset — clears refcount, DOM class, and all lib locks. */
export function __resetForTest(): void {
  count = 0;
  const el = root();
  if (el !== null) el.classList.remove(CLASS_NAME);
  clearAllBodyScrollLocks();
}
