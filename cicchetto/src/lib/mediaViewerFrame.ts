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
// a `position: fixed` box is placed from, so the number goes into `top` as is.
//
// `.topic-bar` is the band itself (`PaneTopBar`), so every pane that wears one
// is covered by one selector: a channel, the mentions window, an encrypted
// query, the admin console. A window without a band — a query, the server
// window — still starts below the shell's own padding, where iOS takes the
// touches, so there the frame starts at the pane's top. On a desktop browser
// that is 0, and the viewer lays out exactly as it did before.

/** The custom property the viewer's frame top is published under. */
export const FRAME_TOP_VAR = "--media-viewer-top";

/**
 * The y, in CSS px from the top of the layout viewport, below which the media
 * viewer may lay itself out: the bottom edge of the pane's top bar, or the
 * pane's own top where the window has no bar. 0 with no shell mounted.
 */
export const viewerFrameTop = (): number => {
  const pane = document.querySelector(".shell-main");
  if (pane === null) return 0;
  const paneTop = pane.getBoundingClientRect().top;
  const bar = pane.querySelector(".topic-bar");
  // `max` because the admin console scrolls WITH its bar inside it: once the
  // bar has scrolled away its bottom edge sits above the pane, and the frame
  // must not follow it up there.
  return bar === null ? paneTop : Math.max(paneTop, bar.getBoundingClientRect().bottom);
};

/**
 * Publishes `viewerFrameTop()` on `el` now, and again whenever the pane or its
 * bar changes size, until the returned disposer runs.
 *
 * Now, synchronously, because the viewer's first frame has to be in the right
 * place: a viewer that opens under the bar and jumps clear of it a frame later
 * is the bug, briefly. Again on a resize because the line moves while the
 * viewer is open — a topic arriving that wraps the bar onto a second line, or a
 * rotation that changes the safe-area padding, which resizes the pane's content
 * box without resizing the bar. The bar is observed as it was at open; if the
 * reader switches window under the viewer the frame keeps the old bar's edge,
 * which is a bar's height off at worst.
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
    const bar = pane.querySelector(".topic-bar");
    if (bar !== null) observer.observe(bar);
  }
  return () => {
    observer.disconnect();
  };
};
