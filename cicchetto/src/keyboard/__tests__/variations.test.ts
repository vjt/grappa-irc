import { describe, expect, it } from "vitest";
import { variantsFor } from "../variations";

describe("variantsFor", () => {
  it("returns the iOS vowel accent set for e (base first)", () => {
    expect(variantsFor("e")).toEqual(["e", "è", "é", "ê", "ë", "ē", "ė", "ę", "ə"]);
  });

  it("returns consonant variants for c", () => {
    expect(variantsFor("c")).toEqual(["c", "ç", "ć", "č"]);
  });

  it("returns punctuation variants", () => {
    expect(variantsFor("?")).toEqual(["?", "¿"]);
    expect(variantsFor("-")).toEqual(["-", "–", "—", "•"]);
  });

  it("returns empty for a key with no variants", () => {
    expect(variantsFor("g")).toEqual([]); // g has no iOS variants on US layout
    expect(variantsFor("1")).toEqual([]);
  });

  it("base char is always first when variants exist", () => {
    for (const base of ["a", "e", "i", "o", "u", "n", "c", "s", "y", "z"]) {
      const v = variantsFor(base);
      expect(v.length).toBeGreaterThan(0);
      expect(v[0]).toBe(base);
    }
  });
});
