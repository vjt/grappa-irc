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
// addEventListener. A second optional argument (`windowHeightFn`) lets
// tests control the layout-viewport reference value used by the
// keyboard-open class toggle (UX-6 bucket D); production reads
// `window.innerHeight` lazily so DPR / orientation changes are honored.

export interface VisualViewportLike {
  height: number;
  addEventListener(event: "resize", handler: () => void): void;
}

const CSS_VAR = "--viewport-height";

// UX-6 bucket D — `<html>` class toggled when visualViewport.height is
// meaningfully smaller than window.innerHeight (i.e. the soft keyboard
// is up). CSS uses it to drop `.shell-mobile`'s
// `padding-bottom: env(safe-area-inset-bottom)` while the keyboard
// overlays the home-indicator region — the inset would otherwise leave
// a ~34px transparent strip between BottomBar and the keyboard's top
// edge on notched iPhones (vjt iPhone-dogfood Bug 5 / D1).
const KEYBOARD_CLASS = "keyboard-open";

// Empirical threshold — keyboard-up vs ordinary chrome shrink. iOS
// Safari address-bar reveal/hide moves visualViewport.height by
// ~80–100px; soft-keyboard delta is ~270–340px on iPhone 13–15. 150px
// sits cleanly between the two; the lib only flips
// `html.keyboard-open` when the delta is firmly in keyboard territory
// so address-bar fidgeting doesn't strobe the class.
const KEYBOARD_OPEN_DELTA_PX = 150;

/** Writes `height` (in px) to the `--viewport-height` CSS var on <html>. */
function writeViewportHeight(height: number): void {
  document.documentElement.style.setProperty(CSS_VAR, `${height}px`);
}

/**
 * Toggles `html.keyboard-open` based on the gap between
 * `visualViewport.height` and the layout-viewport reference height
 * (`window.innerHeight` in production). Above the
 * `KEYBOARD_OPEN_DELTA_PX` threshold → keyboard is up; below → keyboard
 * is dismissed (or never appeared). Idempotent; harmless to call when
 * the class is already in its target state.
 */
function syncKeyboardOpenClass(vvHeight: number, layoutHeight: number): void {
  const keyboardUp = layoutHeight - vvHeight > KEYBOARD_OPEN_DELTA_PX;
  document.documentElement.classList.toggle(KEYBOARD_CLASS, keyboardUp);
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
 *
 * `windowHeightFn` defaults to `() => window.innerHeight` (read every
 * call so orientation flips stay accurate); tests pass a closure they
 * control.
 */
export function installViewportHeightTracker(
  vp: VisualViewportLike | undefined = typeof window !== "undefined"
    ? (window.visualViewport ?? undefined)
    : undefined,
  windowHeightFn: () => number = () => window.innerHeight,
): void {
  if (!vp) return;
  writeViewportHeight(vp.height);
  syncKeyboardOpenClass(vp.height, windowHeightFn());
  vp.addEventListener("resize", () => {
    writeViewportHeight(vp.height);
    syncKeyboardOpenClass(vp.height, windowHeightFn());
  });
}

/**
 * Pins window scroll to (0, 0) whenever something tries to scroll
 * the document. iOS Safari auto-scrolls the page to "center" the
 * focused input on keyboard open, even when the input is already
 * visible — this is a PROGRAMMATIC scroll path (scroll-into-view),
 * distinct from the touch-drag path which is now handled at the
 * layout layer via `#root { height: 100% }` (UX-3 UNDEC — body and
 * root match exactly, no overflow, nothing for iOS to drag).
 *
 * Listening for the `scroll` event + immediately scrolling back to
 * (0, 0) kills the programmatic-scroll symptom at the source. The
 * user sees the page hold still; iOS sees what it asked for and
 * stops escalating.
 *
 * Passive listener — `scroll` doesn't honor preventDefault anyway;
 * scrollTo(0, 0) is the corrective action.
 *
 * Idempotent like `installViewportHeightTracker` — called once from
 * main.tsx.
 */
export function installScrollPin(
  target: Window | undefined = typeof window !== "undefined" ? window : undefined,
): void {
  if (!target) return;
  target.addEventListener(
    "scroll",
    () => {
      if (target.scrollX !== 0 || target.scrollY !== 0) {
        target.scrollTo(0, 0);
      }
    },
    { passive: true },
  );
}
