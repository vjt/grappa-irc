// issue 2500 — where the media viewer's frame starts.
//
// vjt, on an installed iPhone PWA: a very tall picture, the same shape as the
// screen, opened with its top edge under the bar at the top of the window,
// where it could not be tapped. The viewer centred itself in the WHOLE
// viewport, and under `black-translucent` the viewport begins behind the status
// bar, above the shell's safe-area padding and above the bar the shell puts
// below it. His ruling: the picture stops at the BOTTOM EDGE of the pane's top
// bar — the one carrying the channel name — and may run on past the bottom of
// the screen.
//
// So the viewer is handed the top of the space it may use, and the stylesheet
// (`.media-viewer-modal`) lays it out in the part of the screen below that line
// instead of in all of it.
//
// MEASURED, never a constant, which the issue asks for in so many words. The
// bar's bottom edge already folds in everything stacked above it: the safe-area
// inset `.shell` is padded by, the iOS 27 band (issue 2190) on top of that, and
// a topic long enough to wrap. A constant would have to restate all three, and
// JS cannot read `env()` back out of the custom property anyway (the #913
// note). `getBoundingClientRect` measures from the same layout-viewport origin
// a `position: fixed` box is placed from, so the two need no conversion.

/** The custom property the viewer's frame top is published under. */
export const FRAME_TOP_VAR = "--media-viewer-top";

// The band at the top of each pane the viewer can be opened from: the channel
// bar and the admin console's (`PaneTopBar`), the mentions window's header and
// the encrypted query's. Three hosts, three classes — the two headers predate
// the shared band and never adopted it. The ruling names the channel bar; the
// other two are the same band on another window, and a picture under the
// mentions header's ✕ is the same defect. A new pane with a band of its own
// joins this list, or its viewer opens at the pane's top, under that band.
const PANE_TOP_BAR = ":is(.topic-bar, .mentions-header, .e2e-header)";

/**
 * The y, in CSS px from the top of the layout viewport, below which the media
 * viewer may lay itself out: the bottom edge of the pane's top bar, or the
 * pane's own top where the window has no bar. 0 with no shell mounted.
 *
 * A window without a band — a query, the server window — still starts below
 * the shell's own padding, where iOS takes the touches, so its frame starts at
 * the pane's top. On a desktop browser that is 0, and the viewer lays out
 * exactly as it did before.
 */
export const viewerFrameTop = (): number => {
  const pane = document.querySelector(".shell-main");
  if (pane === null) return 0;
  const paneTop = pane.getBoundingClientRect().top;
  const bar = pane.querySelector(PANE_TOP_BAR);
  // `max` because the admin console scrolls WITH its bar inside it: once the
  // bar has scrolled away its bottom edge sits above the pane, and the frame
  // must not follow it up there.
  return bar === null ? paneTop : Math.max(paneTop, bar.getBoundingClientRect().bottom);
};

/**
 * Publishes `viewerFrameTop()` on `el` now, and again whenever the pane or its
 * bar changes size, until the returned disposer runs. Call it once the viewer
 * is MOUNTED, never from a ref (see MediaViewerDialog's `onMount`).
 *
 * Again on a resize because the line moves while the viewer is open — a topic
 * arriving that wraps the bar onto a second line, or a rotation that changes
 * the safe-area padding without crossing the mobile breakpoint, which resizes
 * the pane's content box and not the bar. A rotation that DOES cross it swaps
 * the whole shell and remounts the viewer, which measures afresh. The bar is
 * observed as it was at open; if the reader switches window under the viewer
 * the frame keeps the old window's line, a bar's height off at worst.
 */
export const bindViewerFrame = (el: HTMLElement): (() => void) => {
  const paint = (): void => {
    el.style.setProperty(FRAME_TOP_VAR, `${viewerFrameTop()}px`);
  };
  paint();
  // jsdom ships no ResizeObserver (the #285 / ZoomableImage precedent).
  if (typeof ResizeObserver === "undefined") return () => {};
  const observer = new ResizeObserver(paint);
  const pane = document.querySelector(".shell-main");
  if (pane !== null) {
    observer.observe(pane);
    const bar = pane.querySelector(PANE_TOP_BAR);
    if (bar !== null) observer.observe(bar);
  }
  return () => {
    observer.disconnect();
  };
};
