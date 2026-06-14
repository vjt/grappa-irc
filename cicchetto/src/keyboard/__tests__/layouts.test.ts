import { describe, expect, it } from "vitest";
import { LAYERS } from "../layouts";

describe("layouts", () => {
  it("letters row 1 is q..p", () => {
    const row1 = LAYERS.letters[0]?.map((k) => k.label);
    expect(row1).toEqual(["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"]);
  });

  it("letters row 2 is a..l", () => {
    expect(LAYERS.letters[1]?.map((k) => k.label)).toEqual([
      "a",
      "s",
      "d",
      "f",
      "g",
      "h",
      "j",
      "k",
      "l",
    ]);
  });

  it("letters row 3 has shift + z..m + backspace", () => {
    const r = LAYERS.letters[2] ?? [];
    expect(r[0]?.role).toBe("shift");
    expect(r.at(-1)?.role).toBe("backspace");
    expect(r.slice(1, -1).map((k) => k.label)).toEqual(["z", "x", "c", "v", "b", "n", "m"]);
  });

  it("numbers row 1 is 1..0 and row 2 matches iOS symbols", () => {
    expect(LAYERS.numbers[0]?.map((k) => k.label)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "0",
    ]);
    expect(LAYERS.numbers[1]?.map((k) => k.label)).toEqual([
      "-",
      "/",
      ":",
      ";",
      "(",
      ")",
      "€",
      "&",
      "@",
      '"',
    ]);
  });

  it("symbols layer row 1+2 match iOS #+= page", () => {
    expect(LAYERS.symbols[0]?.map((k) => k.label)).toEqual([
      "[",
      "]",
      "{",
      "}",
      "#",
      "%",
      "^",
      "*",
      "+",
      "=",
    ]);
    expect(LAYERS.symbols[1]?.map((k) => k.label)).toEqual([
      "_",
      "\\",
      "|",
      "~",
      "<",
      ">",
      "$",
      "£",
      "¥",
      "•",
    ]);
  });

  it("a character key carries its insert text equal to its label", () => {
    const q = LAYERS.letters[0]?.[0];
    expect(q?.role).toBe("char");
    expect(q?.text).toBe("q");
  });
});
