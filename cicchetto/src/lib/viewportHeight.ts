// Viewport-height tracker — writes the visible viewport height to a
// CSS custom property (`--viewport-height`) so layout containers
// (`.shell.shell-mobile`) can use a height that reflects what the
// user actually sees.
//
// Why this exists.
//
// On iOS Safari, opening the on-screen keyboard does NOT change the
// layout viewport (the thing CSS `100vh` resolves against). Even
// `100dvh` ("dynamic viewport height") only tracks the browser's UI
// chrome (the address bar), not the keyboard. So `height: 100dvh`
// stays full-screen while the keyboard is open, and iOS reacts by
// scrolling the page up to keep the focused input visible — pushing
// the top bar out of view (vjt's 2026-05-17 keyboard-hides-top-bar
// report).
//
// VisualViewport is the W3C-standard API that DOES track the visible
// area. `window.visualViewport.height` shrinks when the keyboard
// opens; it shrinks more when the user pinches in; etc. Listening
// for `resize` events lets us update a CSS var in lockstep, and
// `.shell.shell-mobile { height: var(--viewport-height, 100dvh) }`
// becomes the actual visible-area-tracking layout.
//
// The dvh fallback handles the brief window between page boot and
// the first `resize` event (the CSS var is unset on the very first
// frame). Default = 100dvh, then we update as soon as we know better.
//
// Desktop browsers fire `visualViewport.resize` only on real viewport
// changes (window resize, devtools open/close) — no keyboard impact.
// Setting the CSS var on desktop is harmless: `.shell` (desktop
// grid) uses `100vh` and ignores the var entirely.
//
// UX-6 bucket D v2 (2026-05-21) — `installScrollPin` removed. It
// was a UX-3 OCT workaround for iOS auto-scrolling the page when
// compose was focused under the keyboard (the page was at full
// height with compose at the bottom; iOS lifted the page up to keep
// the input visible). With D1's `:has(:focus)` collapsing the
// safe-area inset AND D2's `min-height: 0` letting `.scrollback`
// shrink with the shell, the shell itself shrinks to
// visualViewport.height (894 → 570 on iPhone 15 keyboard-up) and
// iOS no longer needs to auto-scroll. The pin then became hostile:
// every touch fired a scroll event, the pin yanked window.scrollY
// back to 0, the user's drag gesture got cancelled, and the last
// message ended up rendered below the focused textarea (vjt
// 2026-05-21 iPhone PWA report). Diagnostic confirmed the layout
// chain was correct (shellmobile 570, scrollback 354) — only the
// scroll pin needed to go.
//
// Mock surface for vitest: `installViewportHeightTracker` accepts an
// optional viewport argument so unit tests can pass a fake
// `VisualViewport`-shaped object with a controllable height +
// addEventListener.

export interface VisualViewportLike {
  height: number;
  addEventListener(event: "resize", handler: () => void): void;
}

const CSS_VAR = "--viewport-height";

/** Writes `height` (in px) to the `--viewport-height` CSS var on <html>. */
function writeViewportHeight(height: number): void {
  document.documentElement.style.setProperty(CSS_VAR, `${height}px`);
}

/**
 * Boot-time entry. Reads the current visualViewport height, writes
 * it to the CSS var, and subscribes to subsequent resize events.
 *
 * Idempotent — calling twice attaches two listeners (no internal
 * guard since main.tsx only invokes once). If a future need arises
 * to re-arm after teardown, return a `dispose` function from here.
 *
 * Returns void on browsers that don't expose `window.visualViewport`
 * (every modern browser does, but the typedef is optional). The CSS
 * var stays unset; the `var(..., 100dvh)` fallback in default.css
 * takes over.
 */
export function installViewportHeightTracker(
  vp: VisualViewportLike | undefined = typeof window !== "undefined"
    ? (window.visualViewport ?? undefined)
    : undefined,
): void {
  if (!vp) return;
  writeViewportHeight(vp.height);
  vp.addEventListener("resize", () => {
    writeViewportHeight(vp.height);
  });
}
