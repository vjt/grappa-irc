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

import { createEffect, createSignal, onCleanup } from "solid-js";

const CLASS_NAME = "overlay-open";

// #219-general — the refcount is backed by a Solid signal so `overlayCount()`
// is a TRACKED source. ScrollbackPane derives its "a covering overlay is open"
// freeze predicate from it (see the overlay-scroll snapshot effect there); a
// plain-`let` read would let that memo go stale when an overlay opens/closes
// and the pane would never freeze/thaw. The signal is module-scope (not owned
// by any component) — same lifetime as the old `let count`; the getter reads
// it, the mutators set it. iOS touch-lock semantics are unchanged (the class +
// listener side-effects still key off the same numeric value).
const [count, setCount] = createSignal(0);
let listenerAttached = false;

// #232 — ordered ESC-close stack. Parallel to the scroll-lock refcount but
// a DIFFERENT population: it carries the close verb, and only overlays that
// pass an `onEscape` to createOverlayLock register here (scroll-lock-only
// overlays — the members/settings drawers, admin pane — push the refcount
// but NOT this stack). Cannot be derived from the refcount (onEscape ⊆
// pushed), so it's a separate structure, but its lifecycle is bolted to the
// SAME push/pop edges inside createOverlayLock so the two never drift.
//
// `runTopmostOverlayEscape()` invokes the LAST-registered overlay's onEscape
// (topmost-first) — the single ESC authority `keybindings.ts` calls before
// its drawer fallback, so there is exactly ONE global keydown listener app-
// wide (the keybindings window listener), never a second one. A plain array,
// not a Solid signal: it's read synchronously inside a keydown handler, and
// nothing derives reactively from it. Entries key on an opaque per-lock
// `token` so a pop removes the RIGHT entry regardless of stack position (an
// overlay lower in the stack can close first when its store nulls out).
type EscapeEntry = { token: object; onEscape: () => void };
const escapeStack: EscapeEntry[] = [];

function registerEscape(token: object, onEscape: () => void): void {
  // Defensive: drop any stale entry for this token before pushing on top, so
  // a same-token re-register (close+reopen racing microtasks) can't duplicate.
  unregisterEscape(token);
  escapeStack.push({ token, onEscape });
}

function unregisterEscape(token: object): void {
  const i = escapeStack.findIndex((e) => e.token === token);
  if (i !== -1) escapeStack.splice(i, 1);
}

function root(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.documentElement;
}

function applyClass(): void {
  const el = root();
  if (el === null) return;
  if (count() > 0) {
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
  setCount(count() + 1);
  applyClass();
  attachListener();
}

/**
 * Pop an overlay off the lock stack. Pops below zero are clamped.
 * Detaches the touchmove listener when the refcount drops to zero.
 */
export function popOverlay(_target: HTMLElement | null): void {
  setCount(Math.max(0, count() - 1));
  applyClass();
  if (count() === 0) detachListener();
}

/**
 * Current refcount — a TRACKED Solid source. Reading it inside a memo /
 * effect subscribes to overlay open/close transitions (#219-general).
 * Also exposed for vitest assertions.
 */
export function overlayCount(): number {
  return count();
}

/** Whether the document-level touchmove listener is currently attached. */
export function isListenerAttached(): boolean {
  return listenerAttached;
}

/**
 * #232 — close the TOPMOST open overlay (last-registered onEscape) and return
 * true; return false when no ESC-closable overlay is open. `keybindings.ts`
 * calls this from its single global keydown listener BEFORE falling back to
 * `closeDrawer`, giving correct topmost-first precedence: ESC closes the
 * frontmost modal, a second ESC closes the drawer underneath it. The onEscape
 * callback flips the overlay's own open signal, which drives createOverlayLock
 * to pop this entry via the normal close lifecycle — so we invoke, never pop
 * here.
 */
export function runTopmostOverlayEscape(): boolean {
  const top = escapeStack[escapeStack.length - 1];
  if (top === undefined) return false;
  top.onEscape();
  return true;
}

/** Current ESC-close stack depth. Exposed for vitest assertions. */
export function overlayEscapeDepth(): number {
  return escapeStack.length;
}

/** Test reset — clears refcount, DOM class, detaches listener, empties the ESC stack. */
export function __resetForTest(): void {
  setCount(0);
  const el = root();
  if (el !== null) el.classList.remove(CLASS_NAME);
  detachListener();
  escapeStack.length = 0;
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
 *
 * #232 — optional `onEscape`: when supplied, the overlay ALSO joins the
 * ordered ESC-close stack for its open lifetime, so `runTopmostOverlayEscape`
 * (called by keybindings on Esc) closes the frontmost modal regardless of
 * where focus sits — the fix for the old element-scoped `onKeyDown` handlers
 * that never fired when focus stayed in the compose box. onEscape MUST call
 * the same close verb the modal's × / backdrop use (cic never originates
 * state; the keyboard is just another door to the existing close). Omit it
 * for scroll-lock-only overlays (drawers, admin pane) — they stay out of the
 * ESC stack and close via the keybindings drawer fallback. Registration is
 * bolted to the SAME deferred push / release edges as the refcount, so the
 * two structures share one leak-safe lifecycle and never drift.
 */
export function createOverlayLock(
  isOpen: () => boolean,
  selector: string,
  onEscape?: () => void,
): void {
  // wasOpen = desired state (tracks the signal edge); pushed = actual
  // lock state (whether OUR push reached the refcount). Tracked
  // separately so the deferred push can neither fire after a same-task
  // close (wasOpen false → skip) nor double-fire after a same-task
  // close+reopen queued two microtasks (pushed true → skip).
  const escapeToken = {};
  let wasOpen = false;
  let pushed = false;
  let lockedEl: HTMLElement | null = null;
  const release = (): void => {
    if (pushed) {
      popOverlay(lockedEl);
      if (onEscape) unregisterEscape(escapeToken);
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
        if (onEscape) registerEscape(escapeToken, onEscape);
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
