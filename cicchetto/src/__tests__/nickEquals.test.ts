import { describe, expect, it } from "vitest";
import { nickEquals, normalizeNick } from "../lib/nickEquals";

describe("normalizeNick", () => {
  it("lower-cases ASCII", () => {
    expect(normalizeNick("Alice")).toBe("alice");
    expect(normalizeNick("VJT-Grappa")).toBe("vjt-grappa");
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
