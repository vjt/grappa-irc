// issue 2453 — the E2E state's records keyed by folded nick. A nick is the
// peer's to choose, and two valid ones fold to the name of an Object.prototype
// member: `constructor` and `__proto__`. Read as a plain object, the first
// answers `Object` where no entry is, and assigning the second runs the
// prototype setter instead of storing anything.
import { describe, expect, it } from "vitest";
import {
  atNick,
  type ByNick,
  deleteNick,
  nickEntries,
  nicksFrom,
  nickValues,
  noNicks,
  setNick,
} from "../lib/e2e/byNick";
import { fold } from "../lib/e2e/wire";

const PROTOTYPE_NICKS = ["constructor", "__proto__", "Constructor", "__PROTO__"];

describe("a record keyed by nick", () => {
  it.each(PROTOTYPE_NICKS)(
    "has no entry for %s until one is set, and keeps it once set",
    (nick) => {
      const rec = noNicks<string[]>();

      expect(atNick(rec, nick)).toBeUndefined();
      setNick(rec, nick, ["queued"]);

      expect(atNick(rec, nick)).toEqual(["queued"]);
      expect(Object.getPrototypeOf(rec)).toBe(Object.prototype);
      expect(nickEntries(rec)).toEqual([[fold(nick), ["queued"]]]);
      expect(nickValues(rec)).toEqual([["queued"]]);

      deleteNick(rec, nick);

      expect(atNick(rec, nick)).toBeUndefined();
      expect(nickEntries(rec)).toEqual([]);
    },
  );

  it("folds the nick: its spellings are one entry, and other nicks are others", () => {
    const rec = noNicks<number>();

    setNick(rec, "Bob", 1);
    setNick(rec, "BOB", 2);
    setNick(rec, "carol", 3);

    expect(atNick(rec, "bob")).toBe(2);
    expect(nickEntries(rec)).toEqual([
      ["bob", 2],
      ["carol", 3],
    ]);
  });

  it("is made from entries under their folded nicks, a later spelling standing", () => {
    expect(
      nickEntries(
        nicksFrom([
          ["Bob", 1],
          ["__proto__", 2],
          ["BOB", 3],
        ]),
      ),
    ).toEqual([
      ["bob", 3],
      ["__proto__", 2],
    ]);
  });

  // The sealed records are JSON. `JSON.parse` defines `__proto__` as an own
  // property and `JSON.stringify` writes it back, so the entries survive a
  // seal and an open in the shape records stored before the fix already have.
  it("survives the JSON a sealed record is, both ways, for every nick", () => {
    const rec = noNicks<string>();
    for (const nick of [...PROTOTYPE_NICKS.slice(0, 2), "bob"])
      setNick(rec, nick, `${nick}-master`);

    const opened = JSON.parse(JSON.stringify(rec)) as ByNick<string>;

    expect(atNick(opened, "__proto__")).toBe("__proto__-master");
    expect(atNick(opened, "constructor")).toBe("constructor-master");
    expect(atNick(opened, "bob")).toBe("bob-master");
    expect(Object.getPrototypeOf(opened)).toBe(Object.prototype);
    // Gone again from the opened record, it reads as no entry, not as `Object`.
    deleteNick(opened, "constructor");
    expect(atNick(opened, "constructor")).toBeUndefined();
  });

  // A record sealed before the fix: `constructor` was assigned as an own
  // property (a plain assignment does that), `__proto__` never was.
  it("reads a record stored before the fix as it was stored", () => {
    const stored = JSON.parse('{"constructor":"m1","bob":"m2"}') as ByNick<string>;

    expect(atNick(stored, "constructor")).toBe("m1");
    expect(atNick(stored, "__proto__")).toBeUndefined();
    expect(nickEntries(stored)).toEqual([
      ["constructor", "m1"],
      ["bob", "m2"],
    ]);
  });
});
