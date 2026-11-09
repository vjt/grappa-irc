import { describe, expect, it } from "vitest";
import {
  type DaySeparatorSighting,
  pillDayAt,
  placeOfRect,
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

// The pane's top edge and the band, in viewport coordinates: a separator's
// box is described the same way, so `top` here is relative to the viewport.
const PANE_TOP = 100;
const BAND = 40;
const box = (top: number, height = 20) => ({ top, height });

describe("placeOfRect — which side of the top band a separator's box is on", () => {
  it("calls BAND a box that overlaps the strip, wherever it starts", () => {
    // Inside the band, flush with the pane's top edge, and straddling it: the
    // date is on screen in all three, so the pill must keep quiet.
    expect(placeOfRect(box(130), PANE_TOP, BAND)).toBe("band");
    expect(placeOfRect(box(100), PANE_TOP, BAND)).toBe("band");
    expect(placeOfRect(box(90), PANE_TOP, BAND)).toBe("band");
  });

  it("separates ABOVE from BELOW by the pane's own top edge", () => {
    // Above means it has scrolled off the top: its day is the day of whatever
    // is now at the top of the viewport, which is exactly what the pill has to
    // say. This is the reading a skipped IntersectionObserver crossing used to
    // lose (#2311): the box still answers, and nothing was ever delivered.
    expect(placeOfRect(box(40), PANE_TOP, BAND)).toBe("above");
    expect(placeOfRect(box(160), PANE_TOP, BAND)).toBe("below");
  });

  it("treats the top edge itself as visible, never as scrolled past", () => {
    // A separator whose top is exactly the pane's top is fully on screen, so
    // its date is in flow and the pill must not claim it has gone.
    expect(placeOfRect(box(100), PANE_TOP, BAND)).not.toBe("above");
  });

  it("keeps a separator whose bottom just left the strip ABOVE", () => {
    // top = -30, height = 20: the whole box is above the pane, so the day has
    // scrolled past even though the box is only 30px up.
    expect(placeOfRect(box(70), PANE_TOP, BAND)).toBe("above");
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
    expect(pillDayAt([sighting(100, "above"), sighting(200, "above"), sighting(300, "band")])).toBe(
      null,
    );
    // …and regardless of the order they are iterated in, which for the live
    // Map is insertion order and therefore arbitrary.
    expect(pillDayAt([sighting(300, "band"), sighting(100, "above"), sighting(200, "above")])).toBe(
      null,
    );
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
