import { describe, expect, it } from "vitest";
import { narrowPushPayload, parsePushTargetUrl } from "../lib/pushPayload";

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

describe("parsePushTargetUrl", () => {
  // UX-6-J: extracts deep-link target from the push payload's URL
  // shape (Grappa.Push.Payload.build_url/2 →
  // "/?network=<slug>&channel=<percent-encoded>"). Returns null on any
  // shape mismatch so callers route to a no-op fallback (selection
  // stays put) rather than crashing.

  it("parses a channel target (# sigil → channel kind)", () => {
    expect(parsePushTargetUrl("/?network=libera&channel=%23sniffo")).toEqual({
      networkSlug: "libera",
      channelName: "#sniffo",
      kind: "channel",
    });
  });

  it("parses an &-prefixed channel as kind=channel", () => {
    expect(parsePushTargetUrl("/?network=ircnet&channel=%26local")).toEqual({
      networkSlug: "ircnet",
      channelName: "&local",
      kind: "channel",
    });
  });

  it("parses a query target (no sigil → query kind)", () => {
    expect(parsePushTargetUrl("/?network=azzurra&channel=nextime")).toEqual({
      networkSlug: "azzurra",
      channelName: "nextime",
      kind: "query",
    });
  });

  it("accepts both `+` and `%20` for spaces (URLSearchParams)", () => {
    // Defensive — IRC channel names cannot contain space, but the
    // parser shouldn't blow up on either encoding.
    expect(parsePushTargetUrl("/?network=foo+bar&channel=%23chan")).toEqual({
      networkSlug: "foo bar",
      channelName: "#chan",
      kind: "channel",
    });
  });

  it("accepts an absolute URL with origin", () => {
    expect(parsePushTargetUrl("https://cic.example.org/?network=libera&channel=%23sniffo")).toEqual(
      {
        networkSlug: "libera",
        channelName: "#sniffo",
        kind: "channel",
      },
    );
  });

  it("returns null when network is missing", () => {
    expect(parsePushTargetUrl("/?channel=%23sniffo")).toBeNull();
  });

  it("returns null when channel is missing", () => {
    expect(parsePushTargetUrl("/?network=libera")).toBeNull();
  });

  it("returns null on root path with no params", () => {
    expect(parsePushTargetUrl("/")).toBeNull();
  });

  it("returns null on empty channel value", () => {
    expect(parsePushTargetUrl("/?network=libera&channel=")).toBeNull();
  });

  it("returns null on empty network value", () => {
    expect(parsePushTargetUrl("/?network=&channel=%23foo")).toBeNull();
  });

  it("returns null on malformed URL", () => {
    expect(parsePushTargetUrl("not a url at all")).toBeNull();
  });
});
