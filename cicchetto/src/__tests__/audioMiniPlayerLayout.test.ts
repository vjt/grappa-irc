import { describe, expect, it } from "vitest";
import { nestedRuleBodies } from "./helpers/themeCss";

// #1698 — the docked bar's layout contract, read off the STYLESHEET.
//
// WHY A CSS-TEXT GUARD AND NOT A DOM ASSERTION. #1697's finding, one bar over:
// `.rail-radio-picker-close` wore a shared button class and then re-declared
// its own size 2rem below it, and the DOM assertion stayed GREEN — jsdom
// applies no stylesheet and computes no layout, so only a guard on the CSS text
// can see a cascade override at all. That is the mechanism here too, and the
// stake is the same one: this row is the WHOLE player on a phone, and a text
// span that can grow without bound pushes ✕ past the right edge, where it
// cannot be tapped.
//
// #1698 adds a SECOND growable text span to a row that had one. That is exactly
// the edit the rule below exists to survive, so it is pinned rather than
// assumed.
//
// And the budget it is spent against SHRANK while this was in flight: #1697
// landed a fourth fixed-width control (the hide chevron) into the same row, so
// the two spans now share what is left after 4 × 2.5rem rather than 3 × 2.5rem.
// Both slices are individually defensible and neither measured the sum — which
// is why the ⚠️ below is not boilerplate on this branch.
//
// ⚠️ What this does NOT establish, stated because a green here is easy to
// over-read: it says the declarations are present, not that the bar fits on any
// particular device. Real widths are device territory.

/** The single body of a rule, asserting there is exactly one — a selector with
    two blocks is the #1697 shape (a later one silently overriding an earlier),
    and a guard that read only the first would be blind to it. */
const soleRuleBody = (selector: string): string => {
  const bodies = nestedRuleBodies(selector);
  expect(bodies.length, `${selector} is declared in ${bodies.length} blocks`).toBe(1);
  return bodies[0] ?? "";
};

describe("the docked player's text spans can shrink, and its controls cannot", () => {
  // #1744 adds a THIRD growable span, and it is the one that arrives while the
  // operator is already unhappy: it takes the track's slot on a failed source,
  // so it inherits the same contract rather than being a new shape beside it.
  it.each([".audio-mini-player-label", ".audio-mini-player-track", ".audio-mini-player-error"])(
    "%s ellipsises instead of widening the row",
    (selector) => {
      const body = soleRuleBody(selector);
      // `min-width: 0` is the load-bearing one: without it a flex item's
      // automatic minimum size is its CONTENT, so `overflow: hidden` never
      // engages and the span widens the row instead of clipping.
      expect(body).toMatch(/min-width:\s*0/);
      expect(body).toMatch(/overflow:\s*hidden/);
      expect(body).toMatch(/text-overflow:\s*ellipsis/);
      expect(body).toMatch(/white-space:\s*nowrap/);
      // Shrink factor non-zero. `flex: <grow> 1 auto` — a `0` in the second
      // slot would let the span refuse to give ground, which is the failure
      // the three properties above are meant to prevent.
      expect(body).toMatch(/flex:\s*\d+\s+1\s+auto/);
    },
  );

  it("keeps the transport controls unshrinkable, so ✕ never leaves the screen", () => {
    // Grouped in one rule with the toggle, the hide chevron and share (the
    // download anchor until issue 2501); asserted through the group rather
    // than per-selector, because that IS the shape and splitting it would let
    // one member drift out silently.
    //
    // The list is spelled out in full, and the exactness is the point: this
    // pin was first written against a THREE-member group and #1697 landed a
    // fourth (`.audio-mini-player-hide`) into it while this branch was in
    // flight. `nestedRuleBodies` matches the selector list verbatim, so the
    // stale spelling threw `CSS rule not found` instead of quietly measuring
    // a rule that no longer existed — which is the whole reason this guard
    // reads the group and not one member of it.
    const body = soleRuleBody(
      ".audio-mini-player-toggle,\n.audio-mini-player-hide,\n.audio-mini-player-close,\n.audio-mini-player-share",
    );
    expect(body).toMatch(/flex:\s*none/);
  });

  it("gives the track more of the free space than the station name", () => {
    // Ordering, not decoration: the station is short and mostly known (it is
    // also on the rail), the track is long and is the fact the row exists to
    // carry. Both still shrink, so neither can starve the other to zero.
    const grow = (selector: string): number => {
      const match = soleRuleBody(selector).match(/flex:\s*(\d+)\s+1\s+auto/);
      const captured = match?.[1];
      if (captured === undefined) throw new Error(`${selector} declares no flex grow factor`);
      return Number(captured);
    };
    expect(grow(".audio-mini-player-track")).toBeGreaterThan(grow(".audio-mini-player-label"));
    // …and the label still grows, so a station with no track yet does not
    // leave a gap trailing the ✕.
    expect(grow(".audio-mini-player-label")).toBeGreaterThan(0);
  });
});
