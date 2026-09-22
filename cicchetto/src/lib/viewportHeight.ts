// Viewport-height tracker — writes the visible viewport height to
// CSS custom properties (`--vh` and `--viewport-height`) so layout
// containers can use a height that reflects what the user actually
// sees.
//
// Why this exists.
//
// On iOS Safari, opening the on-screen keyboard does NOT change the
// layout viewport (the thing CSS `100vh` resolves against). Even
// `100dvh` ("dynamic viewport height") only tracks the browser's UI
// chrome (the address bar), not the keyboard — by CSS spec, the
// on-screen keyboard is explicitly excluded from viewport units.
// So `height: 100dvh` stays full-screen while the keyboard is open,
// and iOS reacts by scrolling the page up to keep the focused input
// visible — pushing the top bar out of view.
//
// VisualViewport is the W3C-standard API that DOES track the visible
// area. `window.visualViewport.height` shrinks when the keyboard
// opens; it shrinks more when the user pinches in; etc. Listening
// for `resize` events lets us update CSS vars in lockstep.
//
// UX-6 D9 (2026-05-21) — final pass adopting the Telegram Web K
// pattern. After 8 failed CSS+JS iterations on this surface,
// research (4 parallel agents, see docs/DESIGN_NOTES.md UX-6-D)
// converged: read ONLY `vv.height`, never `vv.offsetTop`
// (WebKit bug #297779 — `offsetTop` gets stuck at 24px after
// keyboard dismiss, "appears to be a bug in a system component"
// per Apple). Drop the scroll-pin pattern entirely (WebKit bug
// #226689 — `window.scrollTo(0,0)` during momentum causes the
// 1-3s scroll lock iOS quarantines further scroll for). The
// platform-correct primitive is `html.is-ios { position: fixed }`
// PAIRED with `body { height: calc(var(--vh)*100) }` (atomic —
// neither works alone; see default.css).
//
// CSS vars written:
//   --vh           = (vv.height * 0.01) in px, for Telegram-style
//                    `calc(var(--vh) * 100)` consumers.
//   --viewport-height = vv.height in px, for legacy consumers
//                       (`.shell-mobile { height: var(--viewport-
//                       height, 100dvh) }`). Eventually subsumed by
//                       the `body { height: calc(var(--vh)*100) }`
//                       rule but kept for now to avoid touching
//                       every mobile-overlay surface.
//
// #649/#654 (2026-08-02) — resume triggers. The same no-resize-event
// failure as #285 reopen, sign flipped: the last value written while
// foregrounded with the keyboard up is a SHRUNK height; on returning
// from an app-switch iOS restores the full visible viewport but the
// `resize` that would correct the vars either never fires or fires
// before the height settles. The vars stay at the keyboard-open value
// and `body { height: calc(var(--vh)*100) }` keeps the shell at half
// screen with no keyboard in sight.
//
// The fix is MORE TRIGGERS INTO THE ONE WRITER, never a second writer:
// `visibilitychange` (→ visible), `pageshow` (iOS bfcache/PWA resume)
// and window `focus` each re-run the EXISTING settle schedule below.
// No new settle mechanism, no wrapper, no per-symptom patch that also
// touches the vars — a second writer is exactly the conflicting-consumer
// failure this surface has already produced three bug reports from.
// `lib/documentVisibility.ts` owns a sibling visibility+focus signal for
// Solid consumers; it deliberately does NOT write CSS vars, and this
// module deliberately does not consume it — two consumers of one signal
// is fine, two writers of one var is the conflict.
//
// issue 2159 (2026-09-14) — window `resize`, the fourth trigger, and the same
// failure once more with a third sign. An iPadOS Split View divider drag
// resizes the pane while the app stays FOREGROUNDED and FOCUSED throughout, so
// none of the three #649 triggers fires; and the one event that does reach
// this module, `visualViewport` `resize`, WAS handled one-shot, which latches
// the pre-settle height whenever WebKit settles the pane after announcing it.
// (Past tense since issue 1791 — that handler now runs the settle schedule
// too. 2159 diagnosed the shape here and cured it on the window trigger; see
// the issue-1791 paragraph below.)
// Measured on the reporter's iPad (iPadOS 26.7, iPad Pro 11, installed PWA,
// narrow pane): the probe reads the pane at 417x685 with `100dvh` = 685px and
// all four safe-area insets at 0px, in the very configuration whose
// screenshots show the shell at ~393px. The input is correct whenever it is
// read, so nothing is reading it — a trigger gap, not a bad reading.
//
// Measured in this repo rather than argued from the report: FOUR production
// modules already pair `window.addEventListener("resize", …)` with
// `window.visualViewport?.addEventListener("resize", …)` — `ScrollbackPane`
// (#360), `RailActions` (#588), `AdminDebugTab` and `DiagFloat` (#1791). This
// module was the only one listening to the visual viewport alone. `DiagFloat`
// is the sharp end of that: it exists to sample the geometry at the instants
// THIS writer settles at, and it can observe a window resize the writer it
// instruments is deaf to.
//
// Still one writer, one settle mechanism: the new trigger is a fourth caller
// of the existing `writeAndSettle`. It costs three extra live re-reads per
// event on paths that already fire one (a keyboard open under
// `interactive-widget=resizes-content` resizes the layout viewport too), which
// is the same redundancy the three resume triggers already accept — each
// re-read reads the LIVE height, so a redundant one writes the current correct
// value and never a stale clobber.
//
// NOT fixed here, and NOT the same cause: in the installed PWA the same probe
// reads `visualViewport.height` = 676 against `documentElement.clientHeight` =
// 685, and `100dvh` follows the DOCUMENT — so `--vh`, written from
// `vv.height`, is born 9px short of its own `var(--viewport-height, 100dvh)`
// fallback even when the tracker runs. A stale height is a value from an
// earlier TIME and a later re-read cures it; those 9px are a value from a
// different SOURCE at the same instant, and no schedule closes a constant
// offset. They are also 9px of a ~292px deficit (685 pane against a ~393px
// shell), so they cannot account for the report either.
//
// issue 1791 (2026-09-21) — the trigger 2159 NAMED and did not move. The
// paragraph above diagnosed the one-shot latching shape on the `visualViewport`
// resize handler and then cured the WINDOW resize trigger, so the shape stayed
// on the one event that announces a keyboard geometry change. It is now a fifth
// caller of the same `writeAndSettle`.
//
// The geometry that motivated it, from an iOS 27 installed-PWA field report:
// returning from an app switch brings the keyboard AND the iOS form-accessory
// bar back up, and the bar is drawn OVER the bottom channel-tab row. That row
// is `.bottom-bar`, the last in-flow child of `.shell-mobile`, whose height is
// `var(--viewport-height)` — so the tab row's bottom edge IS this var, and a
// var one accessory bar too tall puts the row under the bar while the buffer
// above it still looks right. A cure checked against buffer position alone
// reads green through it.
//
// What that report CANNOT establish, and what this change therefore does not
// claim: whether the var is stale (a value from an earlier TIME — this cures
// it) or whether `visualViewport.height` never subtracts the accessory bar at
// all (a value from a different SOURCE — no schedule closes a constant offset,
// exactly as the 9px note below says). Both produce the identical geometry in
// one frame. The device reading that separates them is `--vh * 100` against
// `vvH` on one `DiagFloat` line: different ⇒ stale, equal while the bar covers
// the row ⇒ the API. Unmeasured — this class does not reproduce off-device
// (#654), and Playwright's iPhone emulation does not reproduce iOS physics.
//
// Mock surface for vitest: `installViewportHeightTracker` accepts an
// optional viewport argument so unit tests can pass a fake
// `VisualViewport`-shaped object with a controllable height +
// addEventListener, plus optional window/document seams so the resume
// triggers can be fired without touching the real globals (the module
// has no uninstall path — a real listener outlives its test).

// Deliberately `height`-only: reading `vv.offsetTop` to infer keyboard
// geometry is WebKit bug #297779 (sticks at 24px after keyboard dismiss),
// and leaving it off the type makes that mistake a compile error rather
// than a regression waiting for a device to catch it.
export interface VisualViewportLike {
  height: number;
  addEventListener(event: "resize", handler: () => void): void;
}

// `resize` rides the same window seam as the two resume events but is NOT a
// resume trigger: it fires while the app never leaves the foreground (issue
// 2159). The name stays `ResumeWindowLike` because `resumeResync.ts` and
// `staleResume.ts` each declare a sibling interface under it — renaming one of
// three would cost more in inconsistency than the widened union costs in
// precision.
export interface ResumeWindowLike {
  addEventListener(event: "pageshow" | "focus" | "resize", handler: () => void): void;
}

export interface ResumeDocumentLike {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(event: "visibilitychange", handler: () => void): void;
}

const HEIGHT_VAR = "--viewport-height";
const VH_VAR = "--vh";

// #285 reopen — boot settle re-read schedule. On a cold iOS-PWA
// kill+relaunch the boot `vv.height` read is a pre-settle INFLATED value
// (full screen, before safe-area / chrome insets settle), and the corrective
// settle fires NO `resize` event — so the one-shot boot write is never
// re-read and the scroll container bakes to the inflated height forever
// (the reported dead-scroll). Re-reading `vv.height` on a short post-boot
// timer schedule, event-independently, lets the settled (smaller) height
// overwrite the inflated boot value even when no resize ever fires. Each
// re-read reads the LIVE `vv.height`, so overlapping a genuine keyboard-open
// resize just writes the current correct value (never a stale clobber).
// Brackets a fast, medium, and slow settle.
//
// Exported since #1791 for the INSTRUMENT, not for a second writer. `DiagFloat`
// samples the live geometry on a resume, and it must sample at the instants
// this writer settles at: sampling on a schedule of its own would make the
// panel and the vars disagree about when "settled" is, and a reader correlating
// the two would get a false story. Anything that writes either var still goes
// through `writeViewport` and nowhere else.
export const SETTLE_REREAD_DELAYS_MS = [100, 400, 900];

// THE single writer of both CSS vars. Every trigger — boot, resize, and
// each #649 resume trigger — reaches the vars through here and nowhere
// else. Adding a second `setProperty` site for either var anywhere in the
// codebase re-opens #79/#209/#649's shared root cause.
function writeViewport(vp: VisualViewportLike): void {
  const style = document.documentElement.style;
  style.setProperty(HEIGHT_VAR, `${vp.height}px`);
  style.setProperty(VH_VAR, `${(vp.height * 0.01).toFixed(2)}px`);
}

// Write now, then re-read on the settle schedule — for the cases where the
// corrective height arrives with NO resize event to announce it: cold boot
// (#285 reopen) and app-switch resume (#649). Each re-read reads the LIVE
// `vp.height`, so a genuine resize landing mid-schedule is never clobbered
// by a stale replay; overlapping schedules from repeated resumes are for the
// same reason harmless (they all converge on the current height).
function writeAndSettle(vp: VisualViewportLike): void {
  writeViewport(vp);
  if (typeof setTimeout !== "function") return;
  for (const ms of SETTLE_REREAD_DELAYS_MS) {
    setTimeout(() => writeViewport(vp), ms);
  }
}

/**
 * Boot-time entry. Writes `--vh` (Telegram pattern) AND
 * `--viewport-height` (legacy pattern) from `window.visualViewport`,
 * then re-writes on every visualViewport resize event, on a short
 * post-boot settle re-read schedule (#285 reopen — the cold-boot settle
 * that fires no resize event), on each resume trigger (#649 — the
 * app-switch return that likewise fires no resize event), and on a
 * window resize (issue 2159 — the Split View pane resize that
 * backgrounds nothing and settles after the event).
 *
 * Idempotent — main.tsx invokes once.
 *
 * Returns void on browsers that don't expose `window.visualViewport`
 * (every modern browser does, but the typedef is optional). The CSS
 * vars stay unset; consumers fall back to their var() defaults.
 */
export function installViewportHeightTracker(
  vp: VisualViewportLike | undefined = typeof window !== "undefined"
    ? (window.visualViewport ?? undefined)
    : undefined,
  win: ResumeWindowLike | undefined = typeof window !== "undefined" ? window : undefined,
  doc: ResumeDocumentLike | undefined = typeof document !== "undefined" ? document : undefined,
): void {
  if (!vp) return;
  writeAndSettle(vp);
  // issue 1791 — `writeAndSettle`, not the one-shot `writeViewport` this used
  // to call. Issue 2159 diagnosed the latching shape ON THIS HANDLER ("the one
  // event that does reach this module, `visualViewport` `resize`, is handled
  // one-shot, which latches the pre-settle height whenever WebKit settles the
  // pane after announcing it") and then cured the WINDOW resize trigger
  // instead, leaving the diagnosed one as it was. Same writer, same schedule,
  // same argument; the redundancy is the one the resume triggers already
  // accept, since every re-read reads the LIVE height.
  vp.addEventListener("resize", () => writeAndSettle(vp));
  // #649 resume triggers. Three of them because no single one covers every
  // return path: an installed iOS PWA coming back from an app-switch reports
  // `visibilitychange`, a bfcache restore reports `pageshow`, and a
  // same-visibility focus return (another app dismissed over the top) reports
  // only `focus`. All three land on the same writer, so overlap costs one
  // redundant re-read of the live height.
  doc?.addEventListener("visibilitychange", () => {
    if (doc.visibilityState !== "visible") return;
    writeAndSettle(vp);
  });
  win?.addEventListener("pageshow", () => writeAndSettle(vp));
  win?.addEventListener("focus", () => writeAndSettle(vp));
  // issue 2159 — the iPadOS Split View trigger. A divider drag resizes the pane
  // without ever backgrounding the app, so none of the three above fires, and
  // `visualViewport` either emits no resize for it or emits one before WebKit
  // has settled the pane. `writeAndSettle`, not the one-shot `writeViewport`
  // the `vp` handler uses: a single read at event time is exactly what latches
  // the pre-settle height here.
  win?.addEventListener("resize", () => writeAndSettle(vp));
}

/**
 * Smart-pinned window scroll. When `window.scroll` fires and we're
 * NOT in (or recently exited) a touch gesture, snap window back to
 * (0, 0). When we ARE touching (or were within `TOUCH_GRACE_MS`),
 * leave it alone — that's user-driven scroll/momentum.
 *
 * UX-6 D10 (2026-05-21) — restored as smart-pin after D9 diag
 * proved iOS PWA 18.7 STILL shifts the visual viewport (window.
 * scrollY=324, vvOT=324) despite html { position: fixed } pinning
 * the layout viewport. No DOM element overflows (html=894/894,
 * body=570/570, root=570/570 per diag), so the scroll is at the
 * WKWebView UIScrollView layer BELOW the document — the only
 * counter-measure is the snap-window-back trick that
 * `installScrollPin` (UX-3 OCT) shipped originally.
 *
 * D7 dropped the pin claiming it caused vjt's 1-3s scroll lock
 * after drag-to-bottom (WebKit bug #226689 — scrollTo during
 * momentum re-triggers scroll, iOS quarantines further scroll
 * for 1-3s as fight-detection). D9 confirmed test 2 passed
 * without pin → causality real.
 *
 * D10 smart-pin: gate the snap on touch-state. iOS's focus-driven
 * shift is PROGRAMMATIC (no touch in flight) → pin fires + snaps.
 * User drag-to-bottom → touch in flight → pin no-ops →
 * no fight with momentum → no 1-3s lock.
 *
 * D10b grace tuning (2026-05-21): initial 500ms grace was too wide
 * — diag proved iOS fires its keyboard-open shift ~110ms after
 * touchend (touchend at 2909ms → vv.resize at 3025ms inside the
 * grace, pin no-ops, vvOT stuck at 324). Shrunk to 50ms which is
 * tight enough to let iOS's post-focus shift through (>110ms) but
 * still catches any same-frame scroll burst that a touchend
 * immediately triggers.
 *
 * Touch state is module-private; the listeners attach at boot in
 * `installSmartScrollPin`. No public read API since no consumer
 * needs it.
 */

const TOUCH_GRACE_MS = 50;

export function installSmartScrollPin(
  target: Window | undefined = typeof window !== "undefined" ? window : undefined,
  doc: Document | undefined = typeof document !== "undefined" ? document : undefined,
): void {
  if (!target || !doc) return;
  let touchActive = false;
  let lastTouchEndAt = -Infinity;
  const snap = (): void => {
    if (target.scrollX !== 0 || target.scrollY !== 0) {
      target.scrollTo(0, 0);
    }
  };
  doc.addEventListener(
    "touchstart",
    () => {
      touchActive = true;
    },
    { passive: true },
  );
  doc.addEventListener(
    "touchend",
    () => {
      touchActive = false;
      lastTouchEndAt = performance.now();
    },
    { passive: true },
  );
  doc.addEventListener(
    "touchcancel",
    () => {
      touchActive = false;
      lastTouchEndAt = performance.now();
    },
    { passive: true },
  );
  target.addEventListener(
    "scroll",
    () => {
      if (touchActive) return;
      if (performance.now() - lastTouchEndAt < TOUCH_GRACE_MS) return;
      snap();
    },
    { passive: true },
  );
}
