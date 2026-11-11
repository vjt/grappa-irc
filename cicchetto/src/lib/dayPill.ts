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
// ## Why the separators' boxes, and only theirs
//
// #2304 kept rect reads off the scroll path altogether: reading the rows near
// the top on every `scroll` event forces a layout per event. Since #2311 (below)
// the pane does read rects while scrolling, and bounds it two ways. The pass is
// coalesced to one per FRAME, however many scroll events land in it. And only
// the day SEPARATORS are read, because the day can only change where one of
// them sits: one box per distinct day among the loaded rows, never one per
// message. That second bound is not a small constant — in a quiet channel
// scrolled far back every loaded row can be a different day, and the scroll-up
// prepend applies no ring cap — but no smaller set can answer.
//
// #2311 is why the reading comes from the boxes and not from the
// `IntersectionObserver` entry that used to cache it. An entry reports a
// TRANSITION, and a wheel, a trackpad swipe or any jump larger than the band
// takes a separator from above to below in one frame with the intersection
// ratio never leaving zero: nothing is delivered, the cached "above" outlives
// the separator's stay on screen, and the pill keeps naming a day that has
// already scrolled away. The observer still exists in the pane, as a trigger
// for the changes that are not scrolls; it is no longer the answer.
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

/** A separator's last known place, keyed by its day in the caller's map. */
export type DaySeparatorSighting = {
  /** The separator's own instant — the `server_time` its label was rendered from. */
  readonly dayAt: number;
  readonly place: DaySeparatorPlace;
};

/**
 * Classify one separator from its own box. Total: every input answers.
 *
 * From the BOX and not from an `IntersectionObserverEntry`, which reports a
 * TRANSITION: a wheel, a trackpad swipe or any jump that moves the pane by
 * more than the band in one frame takes a separator from above to below with
 * the intersection ratio never leaving zero. No entry is delivered, and a
 * place cached from the last one keeps saying "above" for a separator that has
 * left the screen — the pill then names a day that is no longer at the top
 * (#2311). Reading the rects costs one box per separator per pass; the header
 * says what bounds that.
 *
 * `paneTop` is the pane's own top edge in the same viewport coordinates;
 * `bandPx` the strip at the top of the pane the pill occupies. The pane's top
 * edge itself is VISIBLE, never "scrolled past": a separator flush with it is
 * fully on screen, so its date is in flow and the pill must not claim it.
 */
export function placeOfRect(
  rect: { readonly top: number; readonly height: number },
  paneTop: number,
  bandPx: number,
): DaySeparatorPlace {
  const top = rect.top - paneTop;
  if (top < bandPx && top + rect.height > 0) return "band";
  return top < 0 ? "above" : "below";
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
