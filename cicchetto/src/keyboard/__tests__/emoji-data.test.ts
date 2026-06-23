import { describe, expect, it } from "vitest";
import { EMOJI_CATEGORIES } from "../emoji-data";

describe("emoji-data (generated)", () => {
  it("has the 8 iOS categories in order", () => {
    expect(EMOJI_CATEGORIES.map((c) => c.id)).toEqual([
      "smileys",
      "animals",
      "food",
      "activity",
      "travel",
      "objects",
      "symbols",
      "flags",
    ]);
  });

  it("each category is non-empty", () => {
    for (const c of EMOJI_CATEGORIES) expect(c.emojis.length).toBeGreaterThan(0);
  });

  it("ships the full set (>1000 emojis total)", () => {
    const total = EMOJI_CATEGORIES.reduce((n, c) => n + c.emojis.length, 0);
    expect(total).toBeGreaterThan(1000);
  });

  it("smileys contains a grinning face", () => {
    expect(EMOJI_CATEGORIES[0]?.emojis).toContain("😀");
  });
});
