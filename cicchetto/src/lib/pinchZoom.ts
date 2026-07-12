// Pure pinch/pan geometry for the media-viewer image (#213). DOM-free so it
// unit-tests without touch physics — gemello di `swipe.ts`. The gesture itself
// (element-level touch listeners, {passive:false}) lives in the ZoomableImage
// component; this module owns only the math.
//
// WHY a hand-rolled pinch instead of native browser pinch: iOS-1
// (2026-05-17, `<meta viewport ... maximum-scale=1, user-scalable=no>`)
// deliberately kills the browser's native pinch-zoom app-wide so cic feels
// like an app, not a website. That lock is a viewport-level property with no
// per-element opt-out, so the ONLY way to zoom the modal image is to synthesize
// the gesture ourselves and apply a CSS `transform` to the <img> alone. Because
// the transform is scoped to the image element (not the page), the zoom/pan is
// confined to the viewer by construction — no page-zoom, no body-scroll bleed
// (the component ALSO preventDefaults the non-passive touchmove as belt-and-
// braces; see DESIGN_NOTES 2026-07-12).
//
// A `Transform` is the CSS state applied to the <img>: `translate(tx px, ty px)
// scale(scale)` under a CENTER transform-origin. `Size` is the container the
// image is confined to (the viewer body). Translate is always clamped so a
// zoomed image can never be dragged entirely out of the viewport: at a given
// scale the image overflows the container by `(scale - 1) * axis`, half of
// which is pannable each side.

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Transform = { scale: number; tx: number; ty: number };

// Fit-to-viewer (unzoomed) baseline.
export const IDENTITY: Transform = { scale: 1, tx: 0, ty: 0 };

// Zoom bounds. MIN_SCALE = fit (can't zoom out past the object-fit:contain
// baseline); MAX_SCALE caps the hand-rolled zoom so a frantic pinch can't blow
// the image up unboundedly. DOUBLE_TAP_SCALE is the toggle target.
export const MIN_SCALE = 1;
export const MAX_SCALE = 4;
export const DOUBLE_TAP_SCALE = 2;

export const distance = (a: Point, b: Point): number => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
};

export const midpoint = (a: Point, b: Point): Point => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const clampScale = (scale: number): number => clamp(scale, MIN_SCALE, MAX_SCALE);

// Half the overflow at the given scale over `axis` px — the pannable distance
// each side of center. Zero (never negative) at or below fit, so an unzoomed
// image cannot pan.
export const maxTranslate = (scale: number, axis: number): number =>
  Math.max(0, ((scale - 1) * axis) / 2);

// Clamp a transform to the legal zoom range AND confine its pan to the current
// scale's bound (both axes). Scale is clamped FIRST so the pan bound reflects
// the final scale — pinching back down shrinks the bound and re-clamps a pan
// that was legal at the larger scale.
export const clampTransform = (t: Transform, viewport: Size): Transform => {
  const scale = clampScale(t.scale);
  const maxX = maxTranslate(scale, viewport.width);
  const maxY = maxTranslate(scale, viewport.height);
  return { scale, tx: clamp(t.tx, -maxX, maxX), ty: clamp(t.ty, -maxY, maxY) };
};

// Pinch: scale the START transform by the ratio of current/start finger
// distance, then re-confine. A zero start distance (degenerate touch) is a
// no-op guard against divide-by-zero.
export const applyPinch = (
  start: Transform,
  startDistance: number,
  currentDistance: number,
  viewport: Size,
): Transform => {
  if (startDistance <= 0) return start;
  const scale = start.scale * (currentDistance / startDistance);
  return clampTransform({ scale, tx: start.tx, ty: start.ty }, viewport);
};

// Pan: add the drag delta to the START translate, then re-confine. The clamp
// makes an unzoomed image (bound 0) unpannable for free.
export const applyPan = (start: Transform, delta: Point, viewport: Size): Transform =>
  clampTransform({ scale: start.scale, tx: start.tx + delta.x, ty: start.ty + delta.y }, viewport);

// Double-tap toggle: fit → DOUBLE_TAP_SCALE (centered), any zoom → back to fit.
export const toggleZoom = (t: Transform): Transform =>
  t.scale > MIN_SCALE ? IDENTITY : { scale: DOUBLE_TAP_SCALE, tx: 0, ty: 0 };
