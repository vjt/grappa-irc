import { describe, expect, test } from "vitest";
import { mentionsBelowViewport, type ScrollbackLineGeom } from "./mentionScroll";

// #360 — pure geometry core for the mention-aware scroll-to-bottom badge.
// jsdom is blind to real layout (offsetTop/clientHeight are 0), so the
// DOM-reading is done in ScrollbackPane and the DECISION is isolated here
// as a pure fn over pre-measured geometry. The e2e pins the DOM→scroll
// wiring in a real browser; these tests pin the below-the-fold predicate.

const line = (id: number, top: number, isMention: boolean): ScrollbackLineGeom => ({
  id,
  top,
  isMention,
});

describe("mentionsBelowViewport", () => {
  test("returns nearest-first ids of mention lines entirely below the fold", () => {
    const lines = [
      line(1, 0, true), // above the fold — already seen
      line(2, 100, false),
      line(3, 300, true), // below the fold
      line(4, 500, false),
      line(5, 700, true), // below the fold
    ];
    // viewport bottom at 200px: lines with top >= 200 are below the fold.
    expect(mentionsBelowViewport(lines, 200)).toEqual([3, 5]);
  });

  test("preserves DOM order so element[0] is the nearest jump target", () => {
    const lines = [line(9, 400, true), line(7, 800, true), line(8, 1200, true)];
    // Input order == chronological order; nearest-below is the smallest top,
    // which is the first element. The consumer jumps to below[0].
    expect(mentionsBelowViewport(lines, 100)).toEqual([9, 7, 8]);
  });

  test("excludes non-mention lines below the fold", () => {
    const lines = [line(1, 300, false), line(2, 500, false)];
    expect(mentionsBelowViewport(lines, 100)).toEqual([]);
  });

  test("excludes partially-visible mentions whose top is above the fold", () => {
    // A mention straddling the fold (top above viewportBottom) is treated as
    // seen — not counted, not a jump target.
    const lines = [line(1, 150, true)];
    expect(mentionsBelowViewport(lines, 200)).toEqual([]);
  });

  test("counts a mention whose top sits exactly at the viewport bottom", () => {
    // top === viewportBottom ⇒ the line begins exactly at the fold, so it is
    // entirely below and unseen.
    const lines = [line(1, 200, true)];
    expect(mentionsBelowViewport(lines, 200)).toEqual([1]);
  });

  test("returns empty when every mention is above the fold", () => {
    const lines = [line(1, 0, true), line(2, 50, true), line(3, 120, false)];
    expect(mentionsBelowViewport(lines, 300)).toEqual([]);
  });
});
