// issue 2304 — the floating date pill, decision half.
//
// The pill names the day of the rows at the TOP of the scrollback viewport,
// the way Telegram does. Everything that decides WHICH day, and whether there
// is one to name at all, lives here as three pure functions; `ScrollbackPane`
// owns the observer, the element and the fade. The split is not tidiness: the
// pane's half is geometry, and geometry is unobservable under jsdom (an inert
// `IntersectionObserver`, zero-sized rects, no cascade), so anything left in
// the pane can only be covered in e2e. These three can be covered exactly.
//
// ## Why an IntersectionObserver and not a scroll handler
//
// The obvious implementation reads `getBoundingClientRect()` for the rows near
// the top on every `scroll` event, which is a forced layout per event on the
// one path the pane cannot afford it (#782 / #1041). The observer inverts it:
// the browser reports a crossing when one happens, the entry carries the rects
// it already computed, and a pane nobody is scrolling costs nothing. Only the
// day SEPARATORS are observed — a handful of elements, not a row per message —
// because the day can only change where one of them sits.
//
// ## The band, and why the pill must sometimes say nothing
//
// The observation region is not the top EDGE of the pane but a band of the
// pill's own height at the top of it. A separator inside that band is a
// separator the reader can see, right where the pill would paint: showing the
// pill then prints the date twice, and prints it WRONG — the rows under that
// separator belong to the new day while the pill, which reports the last day
// to scroll past, still names the previous one. So "a separator is in the
// band" is not a cosmetic suppression, it is the honest answer.

/** Where a day separator sits relative to the pane's top band. */
export type DaySeparatorPlace = "above" | "band" | "below";

/**
 * The part of an `IntersectionObserverEntry` this decision needs.
 *
 * Declared structurally rather than taking the DOM type: it is three fields of
 * a large interface, and a test that has to build the other twenty either
 * casts (and stops checking anything) or lies about the shape.
 */
export type TopBandObservation = {
  readonly isIntersecting: boolean;
  readonly boundingClientRect: { readonly top: number };
  readonly rootBounds: { readonly top: number } | null;
};

/** A separator's last known place, keyed by its day in the caller's map. */
export type DaySeparatorSighting = {
  /** The separator's own instant — the `server_time` its label was rendered from. */
  readonly dayAt: number;
  readonly place: DaySeparatorPlace;
};

/**
 * Classify one observation. Total: every input answers with a place.
 *
 * The root is already shrunk to the band by `topBandRootMargin`, so
 * `isIntersecting` IS "inside the band" and no arithmetic is needed for it.
 * The remaining two cases are one comparison against the root's top edge, with
 * the edge itself counting as BELOW — a separator flush with the top is fully
 * visible, so its date is on screen and the pill must not claim it has gone
 * past. `rootBounds` is nullable in the DOM contract (a cross-document root);
 * unreachable here, but the fallback is the one that shows NO pill rather than
 * a wrong one.
 */
export function placeOf(observation: TopBandObservation): DaySeparatorPlace {
  if (observation.isIntersecting) return "band";
  const rootTop = observation.rootBounds?.top;
  if (rootTop === undefined) return "below";
  return observation.boundingClientRect.top < rootTop ? "above" : "below";
}

/**
 * The day the pill should name, or `null` for "show nothing".
 *
 * The latest day above the band wins: separators run oldest-first down the
 * list, so the last one to leave the top of the viewport is the one whose day
 * the visible rows belong to. A separator IN the band vetoes outright, for the
 * reason in the header. No sighting above the band means the leading separator
 * (#422 guarantees one) has not moved past yet, so the date is in flow.
 */
export function pillDayAt(sightings: Iterable<DaySeparatorSighting>): number | null {
  let latest: number | null = null;
  for (const { dayAt, place } of sightings) {
    if (place === "band") return null;
    if (place === "above" && (latest === null || dayAt > latest)) latest = dayAt;
  }
  return latest;
}

/**
 * The `rootMargin` that shrinks a root of `rootHeightPx` to its top `bandPx`.
 *
 * `rootMargin` accepts no `calc()` and percentages are of the root's own box,
 * so "the top N pixels" can only be written as a negative bottom margin in px
 * — which is why the root's height has to be read at all, and why the caller
 * rebuilds the observer when that height changes.
 *
 * Clamped at zero because the sign matters and the failure is silent: a
 * positive bottom margin GROWS the observation region past the pane, every
 * separator in the buffer reports `band`, and the pill never appears with
 * nothing anywhere saying why. A pane shorter than the band degrades to "the
 * whole pane is the band", which shows no pill — the honest outcome when there
 * is no room to put one.
 */
export function topBandRootMargin(rootHeightPx: number, bandPx: number): string {
  const usable = Number.isFinite(rootHeightPx) ? rootHeightPx : 0;
  // Computed already-negative and clamped at the TOP, so the clamp emits a
  // plain `0px` rather than the `-0px` a `-${Math.max(0, …)}` spelling leaves
  // behind. Both parse, but only one is readable in DevTools.
  const bottom = Math.min(0, Math.round(bandPx - usable));
  return `0px 0px ${bottom}px 0px`;
}
