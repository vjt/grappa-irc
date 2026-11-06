// issue 2453 — a record keyed by a string a peer or the user chose. The names
// of Object.prototype members are valid such strings (`constructor` and
// `__proto__` in lower case, `toString` where a key keeps its case); "bob"
// runs first in every case as the control.
import { describe, expect, it } from "vitest";
import {
  atKey,
  type ByKey,
  deleteKey,
  keyEntries,
  keysOf,
  keyValues,
  noKeys,
  setKey,
  withKey,
  withoutKey,
} from "../lib/byKey";
import { noNicks } from "../lib/e2e/byNick";

const KEYS = ["bob", "constructor", "__proto__", "toString"];

describe("a record keyed by a chosen string", () => {
  it.each(KEYS)("has no entry for %s until one is set, and keeps it once set", (key) => {
    const rec = noKeys<string[]>();

    expect(atKey(rec, key)).toBeUndefined();
    setKey(rec, key, ["queued"]);

    expect(atKey(rec, key)).toEqual(["queued"]);
    expect(keyEntries(rec)).toEqual([[key, ["queued"]]]);
    expect(keyValues(rec)).toEqual([["queued"]]);

    deleteKey(rec, key);

    expect(atKey(rec, key)).toBeUndefined();
    expect(keyEntries(rec)).toEqual([]);
  });

  it.each(KEYS)("has no entry for %s beside another one", (key) => {
    const rec = keysOf({ carol: 1 });

    expect(atKey(rec, key)).toBeUndefined();
  });

  it("reads an absent record as one with no entry", () => {
    expect(atKey(undefined, "constructor")).toBeUndefined();
  });

  it("does not fold: a key is its exact spelling", () => {
    const rec = keysOf({ Bob: 1 });

    expect(atKey(rec, "Bob")).toBe(1);
    expect(atKey(rec, "bob")).toBeUndefined();
  });

  it.each(KEYS)("sets %s on a copy and leaves the record it copied as it was", (key) => {
    const before = keysOf({ carol: 1 });

    const after = withKey(before, key, 2);

    expect(atKey(after, key)).toBe(2);
    expect(atKey(after, "carol")).toBe(1);
    expect(atKey(before, key)).toBeUndefined();
    expect(keyEntries(before)).toEqual([["carol", 1]]);
  });

  it("sets a key on a copy of an absent record", () => {
    expect(keyEntries(withKey(undefined, "__proto__", 1))).toEqual([["__proto__", 1]]);
  });

  it.each(KEYS)("drops %s from a copy and leaves the record it copied as it was", (key) => {
    const before = withKey(keysOf({ carol: 1 }), key, 2);

    const after = withoutKey(before, key);

    expect(keyEntries(after)).toEqual([["carol", 1]]);
    expect(atKey(before, key)).toBe(2);
  });

  // Every copy keeps the entries it copies, the two prototype names among them.
  it.each(KEYS)("keeps %s through every later copy", (key) => {
    const rec = withKey(withKey(noKeys<number>(), key, 1), "carol", 2);

    expect(atKey(withKey(rec, "dave", 3), key)).toBe(1);
    expect(atKey(withoutKey(rec, "carol"), key)).toBe(1);
  });

  it("is made of the own entries of a parsed record, both prototype names included", () => {
    const rec = keysOf<string>(JSON.parse('{"constructor":"c","__proto__":"p","bob":"b"}'));

    expect(keyEntries(rec)).toEqual([
      ["constructor", "c"],
      ["__proto__", "p"],
      ["bob", "b"],
    ]);
  });

  it("survives a JSON round trip for every key", () => {
    let rec = noKeys<string>();
    for (const key of KEYS) rec = withKey(rec, key, `${key}-value`);

    const opened = JSON.parse(JSON.stringify(rec)) as ByKey<string>;

    for (const key of KEYS) expect(atKey(opened, key)).toBe(`${key}-value`);
  });

  it("takes no index and does not widen to a Record", () => {
    const rec = noKeys<number>();
    // @ts-expect-error — no index signature: read through atKey.
    const indexed = rec.bob;
    // @ts-expect-error — an interface, so it does not convert to a Record.
    const widened: Record<string, number> = rec;
    // @ts-expect-error — a ByNick is not a ByKey: its keys are folded first.
    const unfolded = atKey(noNicks<number>(), "Bob");

    expect(indexed).toBeUndefined();
    expect(widened).toBe(rec);
    expect(unfolded).toBeUndefined();
  });
});
