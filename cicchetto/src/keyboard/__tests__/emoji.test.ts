import { describe, expect, it } from "vitest";
import { addRecent, RECENTS_CAP, recentCategory } from "../emoji";

describe("emoji recents", () => {
  it("prepends new, dedupes, and caps", () => {
    let r: string[] = [];
    r = addRecent(r, "😀");
    r = addRecent(r, "🎉");
    r = addRecent(r, "😀"); // moves to front, no dup
    expect(r).toEqual(["😀", "🎉"]);
  });

  it("caps at RECENTS_CAP, dropping the oldest", () => {
    let r: string[] = [];
    for (let i = 0; i < RECENTS_CAP + 5; i++) r = addRecent(r, String.fromCodePoint(0x1f600 + i));
    expect(r.length).toBe(RECENTS_CAP);
  });

  it("recentCategory builds a category from a recents array", () => {
    const c = recentCategory(["😀", "🎉"]);
    expect(c.id).toBe("recents");
    expect(c.emojis).toEqual(["😀", "🎉"]);
  });
});
