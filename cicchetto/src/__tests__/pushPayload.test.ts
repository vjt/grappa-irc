import { describe, expect, it } from "vitest";
import presencePayloads from "../lib/presencePushPayloads.json";
import { narrowPushPayload, parsePushTargetUrl, pushNotificationOptions } from "../lib/pushPayload";
import { NOTIFICATION_BADGE, NOTIFICATION_ICON } from "../lib/pwaIcons";

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

  // PWA icon badge (door #1, 2026-06-21) — optional `badge` field.
  it("carries a valid non-negative badge", () => {
    expect(narrowPushPayload({ ...valid, badge: 5 })?.badge).toBe(5);
  });

  it("keeps badge 0 (the clear sentinel)", () => {
    expect(narrowPushPayload({ ...valid, badge: 0 })?.badge).toBe(0);
  });

  it("floors a fractional badge", () => {
    expect(narrowPushPayload({ ...valid, badge: 3.9 })?.badge).toBe(3);
  });

  it("omits badge when absent (older server)", () => {
    expect(narrowPushPayload(valid)).not.toHaveProperty("badge");
  });

  it("drops a malformed badge but keeps the rest of the payload", () => {
    expect(narrowPushPayload({ ...valid, badge: "nope" })).toEqual(valid);
    expect(narrowPushPayload({ ...valid, badge: -2 })).toEqual(valid);
    expect(narrowPushPayload({ ...valid, badge: Number.NaN })).toEqual(valid);
  });
});

describe("pushNotificationOptions", () => {
  const payload = {
    title: "vjt",
    body: "ping in #sbiffo",
    tag: "azzurra:#sbiffo",
    url: "/?network=azzurra&channel=%23sbiffo",
  };
  const opts = pushNotificationOptions(payload);

  it("carries the payload's body, tag and deep-link url through", () => {
    expect(opts.body).toBe(payload.body);
    expect(opts.tag).toBe(payload.tag);
    expect(opts.data).toEqual({ url: payload.url });
  });

  // #1906 — `icon` and `badge` are two DIFFERENT assets. The full-colour
  // icon aliased into `badge` rendered as a solid white square on Android
  // (alpha-only mask over a fully opaque PNG); a test that only pinned each
  // field's value passed on that defect. The distinctness is the assertion.
  it("uses the full-colour icon for `icon` and the alpha silhouette for `badge`", () => {
    expect(opts.icon).toBe(NOTIFICATION_ICON);
    expect(opts.badge).toBe(NOTIFICATION_BADGE);
    expect(opts.badge).not.toBe(opts.icon);
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

  // issue 2515 — `Push.Payload.build_e2e/2` marks an encrypted message's
  // deep link `e2e=1`: the window it opens is the encrypted query, not the
  // plaintext one with the same nick.
  it("parses an encrypted query target (e2e=1 → encrypted kind)", () => {
    expect(parsePushTargetUrl("/?network=azzurra&channel=Alice&e2e=1")).toEqual({
      networkSlug: "azzurra",
      channelName: "Alice",
      kind: "encrypted",
    });
  });

  it("keeps a channel a channel under e2e=1: there is no encrypted channel", () => {
    expect(parsePushTargetUrl("/?network=azzurra&channel=%23sniffo&e2e=1")).toEqual({
      networkSlug: "azzurra",
      channelName: "#sniffo",
      kind: "channel",
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

// #378 — /notify presence push, cross-language drift gate.
//
// The payload contract between `Grappa.Push.Payload` and this module is
// hand-synced: there is no codegen gate over it the way `scripts/check.sh`
// has one for `wireTypes.ts`. A payload literal COPIED into this file would
// not be a tripwire — change `build_presence/3` and the copy does not move.
//
// So both ports read ONE fixture: the ExUnit
// `Grappa.Push.PresencePayloadParityTest` asserts the server EMITS these
// exact bytes, and the cases below assert the SW ACCEPTS them and resolves
// the deep link. Change either side and the fixture has to move, which
// drags the other side's assertion with it. Same technique as
// `shouldNotifyTruthTable.json`.
describe("presence push payloads — shared-fixture parity with build_presence/3", () => {
  type PresenceCase = {
    name: string;
    nick: string;
    presence: "online" | "offline";
    network_slug: string;
    payload: { title: string; body: string; tag: string; url: string };
    target: { networkSlug: string; channelName: string; kind: "channel" | "query" };
  };

  const cases = presencePayloads as PresenceCase[];

  it("the shared fixture is non-empty (guards an accidental empty array)", () => {
    expect(cases.length).toBeGreaterThanOrEqual(4);
  });

  it.each(cases)("$name — the SW narrower accepts it verbatim", (c) => {
    expect(narrowPushPayload(c.payload)).toEqual(c.payload);
  });

  it.each(cases)("$name — no badge is stamped on a presence transition", (c) => {
    // A presence transition creates no unread message, so the server omits
    // `badge` and the SW must leave the home-screen icon untouched.
    expect(narrowPushPayload(c.payload)).not.toHaveProperty("badge");
  });

  it.each(cases)("$name — notificationclick lands on the watched nick's query", (c) => {
    expect(parsePushTargetUrl(c.payload.url)).toEqual(c.target);
  });
});
