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
// Mock surface for vitest: `installViewportHeightTracker` accepts an
// optional viewport argument so unit tests can pass a fake
// `VisualViewport`-shaped object with a controllable height +
// addEventListener.

export interface VisualViewportLike {
  height: number;
  addEventListener(event: "resize", handler: () => void): void;
}

const HEIGHT_VAR = "--viewport-height";
const VH_VAR = "--vh";

function writeViewport(vp: VisualViewportLike): void {
  const style = document.documentElement.style;
  style.setProperty(HEIGHT_VAR, `${vp.height}px`);
  style.setProperty(VH_VAR, `${(vp.height * 0.01).toFixed(2)}px`);
}

/**
 * Boot-time entry. Writes `--vh` (Telegram pattern) AND
 * `--viewport-height` (legacy pattern) from `window.visualViewport`,
 * then re-writes on every resize event.
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
): void {
  if (!vp) return;
  writeViewport(vp);
  vp.addEventListener("resize", () => writeViewport(vp));
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
      if (target.scrollX !== 0 || target.scrollY !== 0) {
        target.scrollTo(0, 0);
      }
    },
    { passive: true },
  );
}
