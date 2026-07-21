import { describe, expect, it } from "vitest";
import {
  mentionJumpTargetId,
  mentionsBelowViewport,
  type ScrollbackLineGeom,
} from "../lib/mentionScroll";

// Pure geometry core for the #360 mention-aware scroll-to-bottom badge +
// the mention JUMP anchor. No DOM: jsdom reports 0 for every layout read,
// so the decision logic is exercised here against synthetic geometry.

const line = (id: number, top: number, isMention = false): ScrollbackLineGeom => ({
  id,
  top,
  isMention,
});

describe("mentionsBelowViewport", () => {
  it("returns nearest-first ids of mentions fully below the fold", () => {
    const lines = [
      line(1, 0, true), // above fold
      line(2, 100),
      line(3, 500, true), // below fold
      line(4, 700, true), // below fold, farther
    ];
    // viewportBottom = 300 → lines 3 and 4 are below; line 1 is above.
    expect(mentionsBelowViewport(lines, 300)).toEqual([3, 4]);
  });

  it("excludes a mention straddling the fold (partially visible = seen)", () => {
    const lines = [line(1, 290, true)];
    // top 290 < viewportBottom 300 → straddling → excluded.
    expect(mentionsBelowViewport(lines, 300)).toEqual([]);
  });
});

// #360 iOS fix — the JUMP anchors on the message AFTER the target mention
// (msg+1), so the mention lands fully visible ABOVE the anchor instead of
// at the very bottom where the on-screen keyboard clips it.
describe("mentionJumpTargetId", () => {
  it("returns the id of the message immediately AFTER the mention (DOM order)", () => {
    const lines = [line(10, 0), line(11, 100, true), line(12, 200), line(13, 300)];
    // mention is id 11 → anchor on id 12 (the next line) so 11 sits above it.
    expect(mentionJumpTargetId(lines, 11)).toBe(12);
  });

  it("falls back to the mention itself when it is the LAST line (no msg+1)", () => {
    const lines = [line(10, 0), line(11, 100), line(12, 200, true)];
    expect(mentionJumpTargetId(lines, 12)).toBe(12);
  });

  it("falls back to the given id when the mention is not in the list (defensive)", () => {
    const lines = [line(10, 0), line(11, 100)];
    expect(mentionJumpTargetId(lines, 99)).toBe(99);
  });
});
