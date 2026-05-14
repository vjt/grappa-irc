import { describe, expect, it } from "vitest";
import { narrowPushPayload, urlMatches } from "../lib/pushPayload";

// Push notifications cluster B2 (2026-05-14) — pushPayload helpers.
//
// Coverage: payload narrower happy path + every reject branch +
// urlMatches across (a) exact match, (b) different path, (c)
// different query, (d) malformed input. The SW imports these
// functions; the SW itself is browser-runtime-only and gets
// Playwright coverage in B5.

describe("narrowPushPayload", () => {
  const valid = {
    title: "vjt",
    body: "ping in #sbiffo",
    tag: "libera:#sbiffo",
    url: "/?network=libera&channel=%23sbiffo",
  };

  it("accepts a well-shaped payload", () => {
    expect(narrowPushPayload(valid)).toEqual(valid);
  });

  it("ignores additional fields", () => {
    expect(narrowPushPayload({ ...valid, future_field: 42 })).toEqual(valid);
  });

  it("rejects null", () => {
    expect(narrowPushPayload(null)).toBeNull();
  });

  it("rejects non-object input", () => {
    expect(narrowPushPayload(42)).toBeNull();
    expect(narrowPushPayload("string")).toBeNull();
    expect(narrowPushPayload(undefined)).toBeNull();
  });

  it.each(["title", "body", "tag", "url"])("rejects when %s is missing", (key) => {
    const partial = { ...valid };
    delete (partial as Record<string, unknown>)[key];
    expect(narrowPushPayload(partial)).toBeNull();
  });

  it.each(["title", "body", "tag", "url"])("rejects when %s is non-string", (key) => {
    const malformed = { ...valid, [key]: 42 };
    expect(narrowPushPayload(malformed)).toBeNull();
  });
});

describe("urlMatches", () => {
  it("matches identical pathname + search", () => {
    expect(
      urlMatches(
        "https://cic.example.org/?network=libera&channel=%23sbiffo",
        "/?network=libera&channel=%23sbiffo",
      ),
    ).toBe(true);
  });

  it("rejects mismatched pathname", () => {
    expect(urlMatches("https://cic.example.org/login", "/?network=libera&channel=%23sbiffo")).toBe(
      false,
    );
  });

  it("rejects mismatched query", () => {
    expect(
      urlMatches(
        "https://cic.example.org/?network=libera&channel=%23other",
        "/?network=libera&channel=%23sbiffo",
      ),
    ).toBe(false);
  });

  it("ignores fragment differences (only path + search compared)", () => {
    expect(
      urlMatches(
        "https://cic.example.org/?network=libera&channel=%23sbiffo#scrollback-bottom",
        "/?network=libera&channel=%23sbiffo",
      ),
    ).toBe(true);
  });

  it("returns false on malformed client URL", () => {
    expect(urlMatches("not a url", "/?foo=bar")).toBe(false);
  });
});
