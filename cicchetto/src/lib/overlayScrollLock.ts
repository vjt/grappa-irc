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
// pushes/pops; the `overlay-open` class lands when the first overlay
// opens and goes when the last closes.
//
// issue 2465 — the document-level listener is NOT on that refcount any
// more. `Shell` installs it for its whole life (`installShellTouchGuard`):
// with nothing open, a vertical swipe on a one-line compose draft (a
// `pan-y` scroller with nothing to scroll) went to UIKit, and with the
// keyboard up that panned the whole shell. The rule the handler applies
// is unchanged; WHEN it applies is what moved.
//
// `html.overlay-open` class remains as a CSS sentinel + the v3 CSS
// lock chain (`html.overlay-open body/#root/#root>div { touch-action:
// none }`) stays as defense-in-depth.
//
// #1772 — TWO CONCERNS, TWO COUNTERS. Until this issue a single refcount
// carried both "arm the iOS touch lock" and "freeze the scrollback
// snapshot", and the two are not the same question. A surface that sits
// IN or OVER the flow (the inline whois/whowas/lusers cards, the
// long-press context menu) wants the shell immobile and the pane behind
// LIVE; only a surface that COVERS the pane wants the freeze. Welded to
// one number, those surfaces had to choose, chose no-freeze via
// `createOverlayEscape` (#1199), and thereby also gave up the touch lock
// — so on an iPhone a drag with a whois card or a context menu open
// panned the whole app shell.
//
//   coveringCount  — surfaces that COVER the pane. Read by
//                    `overlayCount()`, which `ScrollbackPane` derives
//                    `isOverlayFrozen()` from and which `globalPaste` /
//                    `Shell`'s swipe guard read as "something is
//                    covering the shell". Its population is unchanged by
//                    #1772, so every one of those consumers is too.
//   shellLocks     — surfaces that want the shell immobile WITHOUT
//                    covering the pane. Touch lock only.
//
// The class keys off the SUM: the touch lock is one global thing, and
// either population arming it is enough. (Until issue 2465 the document
// listener keyed off the same sum; it is the Shell's now, see above.)
//
// Safe to arm the class for a NON-covering surface, measured rather than
// assumed: on mobile the shell already carries `.shell-mobile {
// touch-action: none }` permanently (default.css, UX-3 UNDEC R3), so the
// v3 chain adds nothing there and every inner scroller already carries
// its own `pan-y` carve-out. The one surface that ESCAPES that blanket
// is the context menu — it portals to `<body>`, outside `.shell-mobile`
// — which is why it gains a `pan-y` carve-out of its own in this issue,
// exactly like `.rail-actions-menu` (#913) did.
//
// Test surface: pure module state + DOM side-effects. `__resetForTest()`
// clears both counters + class + the guard so vitest order doesn't leak
// state across tests.

import { createEffect, createSignal, onCleanup } from "solid-js";
import { isTextEntry } from "./keepKeyboard";

const CLASS_NAME = "overlay-open";

// #219-general — the refcount is backed by a Solid signal so `overlayCount()`
// is a TRACKED source. ScrollbackPane derives its "a covering overlay is open"
// freeze predicate from it (see the overlay-scroll snapshot effect there); a
// plain-`let` read would let that memo go stale when an overlay opens/closes
// and the pane would never freeze/thaw. The signal is module-scope (not owned
// by any component) — same lifetime as the old `let count`; the getter reads
// it, the mutators set it. The class side-effect still keys off the same
// numeric value.
const [count, setCount] = createSignal(0);

// #1772 — the non-covering half of the touch lock. A plain `let`, NOT a signal,
// and deliberately so: nothing DERIVES from it. The covering count above is a
// signal because `ScrollbackPane` reads it inside a memo (a stale read there
// means a pane that never freezes); this one has exactly one consumer, the DOM
// class, an imperative side-effect applied at the push/pop edges below. A
// signal would advertise a reactive contract that no reader wants and that no
// test could hold anyone to.
let shellLocks = 0;

// issue 2465 — installs of the shell touch guard. A count rather than a flag
// only so a second Shell (a remount racing its predecessor's cleanup) cannot
// detach the guard from under the first.
let guardHolders = 0;

/** Holders of the `overlay-open` class, from BOTH populations. */
function touchLockHolders(): number {
  return count() + shellLocks;
}

// #232 — ordered ESC-close stack. Parallel to the two counters above but a
// THIRD population: it carries the close verb, and only overlays that pass an
// `onEscape` to createOverlayLock register here (lock-only overlays — the
// members/settings drawers, admin pane — push the covering refcount but NOT
// this stack). Cannot be derived from either count (onEscape ⊆ pushed), so
// it's a separate structure, but its lifecycle is bolted to the SAME push/pop
// edges inside createOverlayLock / createOverlayEscape so they never drift.
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
  if (touchLockHolders() > 0) {
    el.classList.add(CLASS_NAME);
  } else {
    el.classList.remove(CLASS_NAME);
  }
}

/**
 * A drag the platform itself consumes, so cancelling it would break the very
 * thing the user is doing:
 *
 *   * a range input's thumb — WebKit moves it from its default touch handling,
 *     which a `preventDefault` skips;
 *   * a LIVE selection, in a text entry or in the document — the drag may be on
 *     a selection handle (#1205: Android handles that would not move once a
 *     touchmove was cancelled). A collapsed caret is not a selection.
 *
 * The price, accepted: while a selection is live, a drag that nothing scrolls
 * goes back to the platform, so the shell can pan for that long.
 */
function consumesDragNatively(target: Element): boolean {
  if (target instanceof HTMLInputElement && target.type === "range") return true;
  if (isTextEntry(target) && target.selectionStart !== target.selectionEnd) return true;
  const selection = document.getSelection();
  return selection !== null && !selection.isCollapsed;
}

/**
 * Can `el` scroll a drag itself? It needs a scrolling overflow AND content past
 * its box on that axis. A text entry scrolls its own overflow whatever its
 * computed `overflow` reads (issue 2465: the compose textarea declares none),
 * so it is judged on the overflow alone.
 */
function scrollsNatively(el: Element): boolean {
  const cs = getComputedStyle(el);
  const intrinsic = isTextEntry(el);
  const scrollsY = intrinsic || cs.overflowY === "auto" || cs.overflowY === "scroll";
  const scrollsX = intrinsic || cs.overflowX === "auto" || cs.overflowX === "scroll";
  return (
    (scrollsY && el.scrollHeight > el.clientHeight) || (scrollsX && el.scrollWidth > el.clientWidth)
  );
}

/**
 * touchmove handler — preventDefault unless something under the finger
 * consumes the drag natively: a native drag control or a live selection
 * (`consumesDragNatively`), or the target or any ancestor below <body> that can
 * scroll it (`scrollsNatively`), in which case iOS keeps its native scroll and
 * bounce. Nothing to consume it → preventDefault → UIKit cannot claim the
 * gesture as a pan of the page.
 *
 * Exported only for vitest assertions.
 */
export function handleTouchmove(e: TouchEvent): void {
  const target = e.target;
  if (!(target instanceof Element)) return;
  if (consumesDragNatively(target)) return;
  let cur: Element | null = target;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    if (scrollsNatively(cur)) return;
    cur = cur.parentElement;
  }
  if (e.cancelable) e.preventDefault();
}

/**
 * issue 2465 — install the touch guard for as long as the caller lives; returns
 * the disposer. `Shell` is the caller, for its whole life: the shell is
 * furniture with or without an overlay open.
 *
 * Until this issue the guard attached only while an overlay held the lock, and
 * the shell was furniture only because `.shell-mobile { touch-action: none }`
 * forbids the pan. That CSS stops at every scroller that re-allows an axis —
 * the compose textarea is `pan-y` so a long draft can scroll — and a scroller
 * whose content FITS consumes nothing, so the drag it re-allowed went to UIKit:
 * with the keyboard up, a vertical swipe on a one-line draft panned the whole
 * shell. That is the same class as #1772 and as the v1-v3 overlay failures —
 * an axis permitted where nothing can scroll it — and this guard is the one
 * place that knows, live, whether anything can.
 *
 * Login, share and pair render outside `Shell`, so their document scroll never
 * meets it. Every overlay mounts under `Shell`, so none lost the guard when the
 * counters stopped attaching it; they drive the `overlay-open` class alone now.
 */
export function installShellTouchGuard(): () => void {
  guardHolders += 1;
  if (guardHolders === 1 && typeof document !== "undefined") {
    document.addEventListener("touchmove", handleTouchmove, { passive: false });
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    guardHolders = Math.max(0, guardHolders - 1);
    if (guardHolders === 0) detachGuard();
  };
}

function detachGuard(): void {
  if (typeof document === "undefined") return;
  document.removeEventListener("touchmove", handleTouchmove);
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
}

/**
 * Pop an overlay off the lock stack. Pops below zero are clamped.
 * Drops the `overlay-open` class when the last holder — of EITHER
 * population — goes.
 */
export function popOverlay(_target: HTMLElement | null): void {
  setCount(Math.max(0, count() - 1));
  applyClass();
}

/**
 * #1772 — take the iOS touch lock WITHOUT joining the covering-overlay count:
 * "the shell must not move while I am open", said by a surface that does not
 * cover the scrollback pane. Pair with `popShellLock()`.
 *
 * Same global effect as `pushOverlay` (the `overlay-open` class) and a
 * DIFFERENT population:
 * `overlayCount()` does not move, so the pane behind keeps scrolling, keeps
 * following the tail, and never freezes its snapshot.
 *
 * Not a parameter on `pushOverlay`: the two verbs have different pop
 * obligations, and a `push(el, {freeze:false})` / `pop(el, {freeze:true})`
 * mismatch would corrupt both counters at once with nothing to catch it.
 * Distinct verbs make that mistake unspellable.
 */
export function pushShellLock(): void {
  shellLocks += 1;
  applyClass();
}

/** Release a shell lock. Pops below zero are clamped, as with `popOverlay`. */
export function popShellLock(): void {
  shellLocks = Math.max(0, shellLocks - 1);
  applyClass();
}

/**
 * Current COVERING-overlay refcount — a TRACKED Solid source. Reading it
 * inside a memo / effect subscribes to overlay open/close transitions
 * (#219-general). Also exposed for vitest assertions.
 *
 * #1772 — this counts surfaces that COVER the pane, which is narrower than
 * "surfaces holding the touch lock": an in-flow card or the context menu arms
 * the lock and is deliberately absent here, because every consumer of this
 * number is asking the covering question (freeze the snapshot, suppress the
 * global paste, refuse a swipe that would stack a drawer under something).
 */
export function overlayCount(): number {
  return count();
}

/**
 * Current non-covering shell-lock count. Exposed for vitest assertions only —
 * production code has no business asking, since the side-effect this number
 * drives is applied here.
 */
export function shellLockCount(): number {
  return shellLocks;
}

/** Whether the shell touch guard is currently installed. Exposed for vitest. */
export function isListenerAttached(): boolean {
  return guardHolders > 0;
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

/** Test reset — clears BOTH counters, the DOM class, the guard, the ESC stack. */
export function __resetForTest(): void {
  setCount(0);
  shellLocks = 0;
  const el = root();
  if (el !== null) el.classList.remove(CLASS_NAME);
  guardHolders = 0;
  detachGuard();
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
 * `html.overlay-open` class up and `ScrollbackPane` frozen until full
 * reload. Latent in the pre-extraction copies; fixed once here.
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

/**
 * #1199 — the NO-FREEZE variant of `createOverlayLock`: the SAME ordered ESC
 * stack, the same iOS touch lock, the same open/close/unmount edges — WITHOUT
 * the covering-overlay refcount. Call from a component body:
 *
 *   createOverlayEscape(() => myBundle() !== undefined, dismissMyCard);
 *
 * For a surface that is dismissable but covers nothing: the inline scrollback
 * cards (whois / whowas / lusers), which render in the message flow rather than
 * over it, and the long-press context menu, which floats at fixed coordinates
 * over a pane that stays live behind it. Going through `createOverlayLock`
 * would ALSO hold a COVERING refcount for the whole life of the surface, which
 * freezes the scrollback snapshot behind it (`ScrollbackPane`'s
 * `isOverlayFrozen`) — the hazard `RailActions.tsx` records for the permanent
 * rail column. A surface that DOES cover the pane still wants
 * `createOverlayLock`.
 *
 * #1772 — the touch lock is on this side of the split. It used to be welded to
 * the covering refcount, so a card or a menu could have the shell immobile or
 * the pane live but not both, and the surfaces here silently took the second:
 * on an iPhone a drag with a whois card or a context menu open panned the whole
 * app shell. The shell is meant to be furniture. Now `pushShellLock` arms the
 * lock from the non-covering population and `overlayCount()` never moves.
 * (issue 2465: the JS half of that lock, the document `touchmove` guard, has
 * since moved to `Shell` for its whole life; what a surface arms here is the
 * `overlay-open` class.)
 *
 * Membership of the one shared stack is the point, not an implementation
 * detail: it is what makes a modal opened over a card close FIRST. A private
 * `document` keydown listener on the card would close the card instead, and
 * would be the second global ESC listener this stack exists to prevent.
 *
 * No deferred microtask, unlike `createOverlayLock`: that deferral exists only
 * so Solid can commit the render before `querySelector` looks for the lock
 * element, and there is no element to look for here. Leak-safety therefore
 * comes from the shape rather than from a re-check — the `registered` latch
 * makes push and release idempotent and pairs them one-to-one, `onCleanup`
 * releases on unmount-while-open, and `popShellLock` clamps at zero. There is
 * no window in which a queued push can outlive the close that should have
 * cancelled it, which is the failure `createOverlayLock` has to guard against.
 */
export function createOverlayEscape(isOpen: () => boolean, onEscape: () => void): void {
  const escapeToken = {};
  let registered = false;
  const release = (): void => {
    if (!registered) return;
    unregisterEscape(escapeToken);
    popShellLock();
    registered = false;
  };
  createEffect(() => {
    if (!isOpen()) {
      release();
      return;
    }
    if (registered) return;
    registerEscape(escapeToken, onEscape);
    pushShellLock();
    registered = true;
  });
  onCleanup(release);
}
