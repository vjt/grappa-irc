import { describe, expect, it } from "vitest";
import { nickEquals, normalizeNick, rfc1459Fold } from "../lib/nickEquals";

// #364 cross-surface S13 — ONE client nick fold, pinned to the server.
// `rfc1459Fold` is the single client-side fold and must stay byte-for-byte
// with `Grappa.IRC.Identifier.canonical_nick/1`. This enumerated table is
// the drift gate: a server-side fold change (or an accidental Unicode
// regression) makes it go RED loudly, exactly like `nick_fold_sql/1`'s
// migration pin does server-side.
describe("rfc1459Fold — single client fold, mirror of server canonical_nick/1", () => {
  it("folds A-Z to a-z", () => {
    expect(rfc1459Fold("ABCDEFGHIJKLMNOPQRSTUVWXYZ")).toBe("abcdefghijklmnopqrstuvwxyz");
  });

  it("folds the four rfc1459 national chars [ ] \\ ~ -> { } | ^", () => {
    expect(rfc1459Fold("[")).toBe("{");
    expect(rfc1459Fold("]")).toBe("}");
    expect(rfc1459Fold("\\")).toBe("|");
    expect(rfc1459Fold("~")).toBe("^");
  });

  it("leaves already-folded targets, digits and punctuation untouched", () => {
    expect(rfc1459Fold("{}|^")).toBe("{}|^");
    expect(rfc1459Fold("0-9_a")).toBe("0-9_a");
  });

  it("is ASCII-byte-level: does NOT Unicode-fold non-ASCII", () => {
    expect(rfc1459Fold("CAFÉ")).toBe("cafÉ");
    expect(rfc1459Fold("İ")).toBe("İ");
  });

  it("is idempotent", () => {
    const once = rfc1459Fold("Foo[Bar]~Baz\\");
    expect(rfc1459Fold(once)).toBe(once);
  });
});

describe("normalizeNick", () => {
  it("lower-cases ASCII", () => {
    expect(normalizeNick("Alice")).toBe("alice");
    expect(normalizeNick("VJT-Grappa")).toBe("vjt-grappa");
  });

  // #364 E/S13 — normalizeNick is layered on rfc1459Fold, so it folds the
  // bracket range too (mirrors the server); previously ASCII-downcase-only.
  it("folds the rfc1459 bracket range", () => {
    expect(normalizeNick("Foo[1]")).toBe("foo{1}");
    expect(normalizeNick("A\\B~C")).toBe("a|b^c");
  });

  it("is idempotent", () => {
    const once = normalizeNick("Alice");
    expect(normalizeNick(once)).toBe(once);
  });
});

describe("nickEquals", () => {
  it("returns true for casing variants", () => {
    expect(nickEquals("Alice", "alice")).toBe(true);
    expect(nickEquals("alice", "ALICE")).toBe(true);
    expect(nickEquals("VjT-Grappa", "vjt-grappa")).toBe(true);
  });

  it("returns true for identical nicks", () => {
    expect(nickEquals("alice", "alice")).toBe(true);
  });

  // #364 E/S13 — case AND rfc1459 bracket differences collapse to one
  // identity, matching the server's canonical_nick/1.
  it("treats case- and bracket-differing nicks as one", () => {
    expect(nickEquals("Ni[k", "ni{k")).toBe(true);
    expect(nickEquals("Foo[1]", "FOO{1}")).toBe(true);
    expect(nickEquals("a\\b~c", "A|B^C")).toBe(true);
  });

  it("returns false for distinct nicks", () => {
    expect(nickEquals("alice", "bob")).toBe(false);
    expect(nickEquals("vjt", "vjt-grappa")).toBe(false);
  });

  it("returns false when either side is null/undefined", () => {
    expect(nickEquals(null, "alice")).toBe(false);
    expect(nickEquals("alice", null)).toBe(false);
    expect(nickEquals(null, null)).toBe(false);
    expect(nickEquals(undefined, "alice")).toBe(false);
    expect(nickEquals("alice", undefined)).toBe(false);
  });
});
