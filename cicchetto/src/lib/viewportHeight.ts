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
// Mock surface for vitest: `installViewportHeightTracker` accepts an
// optional viewport argument so unit tests can pass a fake
// `VisualViewport`-shaped object with a controllable height +
// addEventListener.

export interface VisualViewportLike {
  height: number;
  offsetTop: number;
  addEventListener(event: "resize" | "scroll", handler: () => void): void;
}

const HEIGHT_VAR = "--viewport-height";
const OFFSET_VAR = "--vv-offset-top";

function writeViewport(vp: VisualViewportLike): void {
  const style = document.documentElement.style;
  style.setProperty(HEIGHT_VAR, `${vp.height}px`);
  style.setProperty(OFFSET_VAR, `${vp.offsetTop}px`);
}

/**
 * Boot-time entry. Writes `--viewport-height` AND `--vv-offset-top`
 * from `window.visualViewport`, then re-writes on every resize and
 * scroll event.
 *
 * `--viewport-height` (height tracking) is the original UX-3 PENT
 * fix: `.shell-mobile` reads it so the layout shrinks in lockstep
 * with the iOS on-screen keyboard.
 *
 * `--vv-offset-top` (UX-6 D6, 2026-05-21) cancels iOS PWA's
 * layout-viewport shift on focus. When the keyboard opens, iOS
 * scrolls the LAYOUT viewport up by `vv.offsetTop` so the focused
 * input stays in the VISUAL viewport. Layout-positioned elements
 * (shell-mobile at layout y=0) end up ABOVE the visual viewport;
 * chrome disappears, gap opens between compose and keyboard top.
 * CSS uses the var as `transform: translateY(var(--vv-offset-top))`
 * on `.shell-mobile` to push the shell back DOWN by the same
 * amount — the layout shift is mechanically inverted, shell stays
 * pinned to the visible area.
 *
 * Both vars update on the SAME handler — `vv.scroll` fires when
 * iOS shifts the layout viewport (focus, keyboard open/close,
 * scroll-into-view); `vv.resize` fires when the visual height
 * itself changes (keyboard appears/disappears). Writing both vars
 * on both events keeps them consistent regardless of which fires
 * first.
 *
 * Idempotent — main.tsx invokes once.
 */
export function installViewportHeightTracker(
  vp: VisualViewportLike | undefined = typeof window !== "undefined"
    ? (window.visualViewport ?? undefined)
    : undefined,
): void {
  if (!vp) return;
  const update = () => writeViewport(vp);
  update();
  vp.addEventListener("resize", update);
  vp.addEventListener("scroll", update);
}
