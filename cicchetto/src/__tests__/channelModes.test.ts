import { describe, expect, it } from "vitest";

// #216 — static channel-mode description table + the `availableModes`
// derivation that folds a network's ISUPPORT capability set into a
// display list for the /mode modal.

import { availableModes, editorSigils, modeDescription } from "../lib/channelModes";
import { DEFAULT_ISUPPORT, type IsupportEntry } from "../lib/isupport";

describe("channelModes description table", () => {
  it("modeDescription returns label + desc for a known flag mode", () => {
    const d = modeDescription("s");
    expect(d.label).toBe("secret");
    expect(d.desc).toMatch(/hidden/i);
  });

  it("modeDescription returns label + desc for a param mode", () => {
    expect(modeDescription("k").label).toMatch(/key/i);
    expect(modeDescription("l").label).toMatch(/limit/i);
  });

  it("modeDescription falls back to a generic label for an unknown letter", () => {
    const d = modeDescription("Z");
    expect(d.label).toContain("Z");
    // no crash, non-empty desc
    expect(typeof d.desc).toBe("string");
  });
});

describe("availableModes", () => {
  it("lists the channel modes advertised by ISUPPORT with param arity", () => {
    const modes = availableModes(DEFAULT_ISUPPORT);
    const find = (letter: string) => modes.find((m) => m.letter === letter);

    // A flag mode (type D) — no param.
    const s = find("s");
    expect(s).toBeDefined();
    expect(s?.takesParam).toBe(false);
    expect(s?.label).toBe("secret");

    // A param mode (type C) — takes a param on set.
    const l = find("l");
    expect(l).toBeDefined();
    expect(l?.takesParam).toBe(true);

    // A key mode (type B) — takes a param.
    const k = find("k");
    expect(k).toBeDefined();
    expect(k?.takesParam).toBe(true);
  });

  it("EXCLUDES membership (PREFIX) modes — those are per-user, not channel toggles", () => {
    const modes = availableModes(DEFAULT_ISUPPORT);
    const letters = modes.map((m) => m.letter);
    expect(letters).not.toContain("o");
    expect(letters).not.toContain("v");
    expect(letters).not.toContain("h");
  });

  it("EXCLUDES list modes (type A: ban/except/invex) — not simple toggles", () => {
    // b/e/I are list modes managed via /ban, /banlist etc. — not a
    // boolean toggle the modal should render as a button.
    const modes = availableModes(DEFAULT_ISUPPORT);
    const letters = modes.map((m) => m.letter);
    expect(letters).not.toContain("b");
    expect(letters).not.toContain("e");
    expect(letters).not.toContain("I");
  });

  it("surfaces an advertised-but-unknown letter with a generic label (no crash)", () => {
    const isupport: IsupportEntry = {
      chanmodes: { a: [], b: [], c: [], d: ["n", "t", "Z"] },
      prefix: {},
    };
    const modes = availableModes(isupport);
    const z = modes.find((m) => m.letter === "Z");
    expect(z).toBeDefined();
    expect(z?.takesParam).toBe(false);
  });
});

describe("editorSigils", () => {
  it("bahamut default → op + halfop edit (not voice)", () => {
    const e = editorSigils(DEFAULT_ISUPPORT);
    expect(e.has("@")).toBe(true);
    expect(e.has("%")).toBe(true);
    expect(e.has("+")).toBe(false);
  });

  it("founder/admin prefixes rank above op → they edit too", () => {
    // PREFIX=(qaohv)~&@%+ — founder ~, admin &, op @, halfop %, voice +.
    const isupport: IsupportEntry = {
      chanmodes: { a: [], b: [], c: [], d: ["n", "t"] },
      prefix: { q: "~", a: "&", o: "@", h: "%", v: "+" },
    };
    const e = editorSigils(isupport);
    expect(e.has("~")).toBe(true); // founder
    expect(e.has("&")).toBe(true); // admin
    expect(e.has("@")).toBe(true); // op
    expect(e.has("%")).toBe(true); // halfop
    expect(e.has("+")).toBe(false); // voice cannot edit
  });

  it("falls back to op/halfop when no op sigil is advertised", () => {
    const isupport: IsupportEntry = {
      chanmodes: { a: [], b: [], c: [], d: [] },
      prefix: { v: "+" },
    };
    const e = editorSigils(isupport);
    expect(e.has("@")).toBe(true);
    expect(e.has("%")).toBe(true);
  });
});
