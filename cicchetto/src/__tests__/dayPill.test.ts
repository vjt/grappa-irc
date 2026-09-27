import { describe, expect, it } from "vitest";
import {
  type DaySeparatorSighting,
  type TopBandObservation,
  placeOf,
  pillDayAt,
  topBandRootMargin,
} from "../lib/dayPill";

// issue 2304 — the floating date pill's DECISION half, tested where it can be.
//
// The other half is geometry, and jsdom has none: `setupTests.ts` installs an
// INERT IntersectionObserver (it ships no real one, and there is no layout to
// intersect against anyway), so nothing here can prove that the observer fires
// at the right scroll offsets. That is e2e's job. What IS provable, and what
// these functions exist to make provable, is everything downstream of an
// observation: which side of the band a separator was seen on, which day that
// makes the pill's, and the margin string that defines the band in the first
// place. A sign error in any of the three is silent — the pill just shows the
// wrong date, or none.

const obs = (
  isIntersecting: boolean,
  top: number,
  rootTop: number | null,
): TopBandObservation => ({
  isIntersecting,
  boundingClientRect: { top },
  rootBounds: rootTop === null ? null : { top: rootTop },
});

describe("placeOf — which side of the top band a separator was seen on", () => {
  it("calls an intersecting separator BAND, wherever its box starts", () => {
    // The root is already shrunk to the band by `rootMargin`, so intersecting
    // IS "inside the band" — no arithmetic needed, and none wanted: the
    // observer computed it against the real rects.
    expect(placeOf(obs(true, 100, 100))).toBe("band");
    expect(placeOf(obs(true, 80, 100))).toBe("band");
    expect(placeOf(obs(true, 120, 100))).toBe("band");
  });

  it("separates ABOVE from BELOW by the root's own top edge", () => {
    // A non-intersecting separator is entirely on one side. Above means it has
    // scrolled off the top: its day is the day of whatever is now at the top of
    // the viewport, which is exactly what the pill has to say.
    expect(placeOf(obs(false, 40, 100))).toBe("above");
    expect(placeOf(obs(false, 160, 100))).toBe("below");
  });

  it("treats the top edge itself as BELOW — the boundary belongs to the visible side", () => {
    // Equality has to land somewhere and this is the conservative side: a
    // separator whose top is exactly the root's top is fully visible, so the
    // date is already on screen and the pill must not claim it has scrolled
    // past. The intersecting case above would normally catch this first.
    expect(placeOf(obs(false, 100, 100))).toBe("below");
  });

  it("declines to guess when the root box is unavailable", () => {
    // `rootBounds` is null when the root is in another document — not reachable
    // here, but the DOM types say it can be and the alternative is reading
    // `undefined.top`. BELOW is the answer that shows no pill rather than the
    // answer that shows a wrong one.
    expect(placeOf(obs(false, 40, null))).toBe("below");
    expect(placeOf(obs(false, 160, null))).toBe("below");
  });
});

describe("pillDayAt — the day the pill names, or nothing", () => {
  const sighting = (dayAt: number, place: DaySeparatorSighting["place"]): DaySeparatorSighting => ({
    dayAt,
    place,
  });

  it("names the LATEST day that has scrolled above the band", () => {
    // Separators run oldest-first down the list, so the last one to leave the
    // top of the viewport is the newest one above it — and its day is the day
    // of the rows now at the top.
    expect(
      pillDayAt([sighting(100, "above"), sighting(300, "above"), sighting(200, "above")]),
    ).toBe(300);
  });

  it("names nothing while a separator sits in the band — the date is already on screen", () => {
    // The whole of the "do not show the date twice" rule. It is not only about
    // duplication: with the separator at the top edge the rows under it belong
    // to the NEW day while the pill would still be naming the previous one, so
    // a visible pill there is also WRONG, not merely redundant.
    expect(pillDayAt([sighting(100, "above"), sighting(200, "band")])).toBe(null);
  });

  it("lets the band win over any number of days above it", () => {
    expect(
      pillDayAt([sighting(100, "above"), sighting(200, "above"), sighting(300, "band")]),
    ).toBe(null);
    // …and regardless of the order they are iterated in, which for the live
    // Map is insertion order and therefore arbitrary.
    expect(
      pillDayAt([sighting(300, "band"), sighting(100, "above"), sighting(200, "above")]),
    ).toBe(null);
  });

  it("names nothing when every separator is still below the band", () => {
    // The top of the buffer: #422 guarantees a leading separator before the
    // first row, so if none has gone past, the date is on screen in flow.
    expect(pillDayAt([sighting(100, "below"), sighting(200, "below")])).toBe(null);
  });

  it("names nothing on an empty pane", () => {
    expect(pillDayAt([])).toBe(null);
  });

  it("ignores the days still below while picking among those above", () => {
    // The negative control for the max: a later day BELOW the band must not
    // win, or the pill names a date the reader has not reached yet.
    expect(
      pillDayAt([sighting(100, "above"), sighting(900, "below"), sighting(200, "above")]),
    ).toBe(200);
  });
});

describe("topBandRootMargin — the band, expressed the one way rootMargin can", () => {
  it("shrinks the root from the bottom so only the top band is left", () => {
    // `rootMargin` takes no `calc`, so the only way to ask for "the top N px of
    // the root" is a negative bottom margin in px — which means the root's own
    // height has to be read. That read is why this is a function and not a
    // constant string, and why the caller rebuilds the observer on resize.
    expect(topBandRootMargin(600, 40)).toBe("0px 0px -560px 0px");
    expect(topBandRootMargin(1000, 40)).toBe("0px 0px -960px 0px");
  });

  it("never GROWS the root — a pane shorter than the band clamps to the whole pane", () => {
    // 🔴 The sign trap. Without the clamp a 0-height root (the pane before it
    // is laid out, which is when the observer is first built) yields a POSITIVE
    // bottom margin: the observation region grows past the pane and every
    // separator in the buffer reports "band", so the pill silently never shows.
    expect(topBandRootMargin(0, 40)).toBe("0px 0px 0px 0px");
    expect(topBandRootMargin(30, 40)).toBe("0px 0px 0px 0px");
    expect(topBandRootMargin(40, 40)).toBe("0px 0px 0px 0px");
  });

  it("clamps a non-finite height the same way rather than emitting NaN", () => {
    // `clientHeight` cannot be NaN, but the margin string is parsed by the
    // browser and `-NaNpx` is a silent rejection of the whole option — the
    // observer would fall back to the full root with no error anywhere.
    expect(topBandRootMargin(Number.NaN, 40)).toBe("0px 0px 0px 0px");
    expect(topBandRootMargin(Number.POSITIVE_INFINITY, 40)).toBe("0px 0px 0px 0px");
  });

  it("rounds to whole pixels — a fractional margin is not a valid length here", () => {
    expect(topBandRootMargin(600.6, 40)).toBe("0px 0px -561px 0px");
  });
});
