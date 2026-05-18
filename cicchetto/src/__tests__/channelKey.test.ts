import { describe, expect, it } from "vitest";
import { canonicalChannel, channelKey, decodeChannelKey } from "../lib/channelKey";

// Codebase audit cic M4 — channelKey encoder + decoder round-trip.
// Pre-fix, Sidebar + subscribe.ts open-coded the composite-key parsing
// independently. The decoder is the paired inverse — channelKey is
// the encoder, decodeChannelKey is the decoder. Round-trip MUST hold
// for every (slug, name) pair the cic generates.

describe("channelKey + decodeChannelKey round-trip", () => {
  it("encodes (slug, name) into space-separated composite", () => {
    expect(channelKey("freenode", "#italia")).toBe("freenode #italia");
  });

  it("decodes back to (slug, name)", () => {
    const k = channelKey("azzurra", "#grappa");
    expect(decodeChannelKey(k)).toEqual({ slug: "azzurra", name: "#grappa" });
  });

  it("preserves the channel-name segment for $server pseudo-channel", () => {
    const k = channelKey("freenode", "$server");
    expect(decodeChannelKey(k)).toEqual({ slug: "freenode", name: "$server" });
  });

  it("preserves the channel-name segment for query (DM) targets", () => {
    const k = channelKey("azzurra", "alice");
    expect(decodeChannelKey(k)).toEqual({ slug: "azzurra", name: "alice" });
  });

  it("returns null for malformed key (no separator)", () => {
    expect(decodeChannelKey("malformed" as unknown as ReturnType<typeof channelKey>)).toBeNull();
  });

  it("uses first space as separator (channel names cannot contain spaces per RFC 2812)", () => {
    // If a channel name accidentally contains a space (e.g. operator
    // typed `/join "#italia weird"`), `indexOf(" ")` splits at the
    // first space — slug = "freenode", name = "#italia weird". The
    // decoder doesn't try to validate the channel name; it just
    // inverts the encoder's shape. RFC 2812 chanstring excludes
    // 0x20 so production keys never hit this edge.
    const k = "freenode #italia weird" as ReturnType<typeof channelKey>;
    expect(decodeChannelKey(k)).toEqual({ slug: "freenode", name: "#italia weird" });
  });

  // UX-4 bucket A — sigil-aware channel-name canonicalisation. Mirrors
  // `Grappa.IRC.Identifier.canonical_channel/1` on the server so the
  // composite key for `#Chan` and `#chan` collapses to the same row.
  describe("channelKey + canonicalChannel: case-insensitive composite", () => {
    it("collapses sigil-channels to lowercase in the composite key", () => {
      expect(channelKey("freenode", "#CHAN")).toBe("freenode #chan");
      expect(channelKey("freenode", "#Chan")).toBe("freenode #chan");
      expect(channelKey("freenode", "#cHaN")).toBe("freenode #chan");
    });

    it("all four RFC 2812 sigils fold (#, &, !, +)", () => {
      expect(channelKey("net", "#UPPER")).toBe("net #upper");
      expect(channelKey("net", "&LOCAL")).toBe("net &local");
      expect(channelKey("net", "!SAFE")).toBe("net !safe");
      expect(channelKey("net", "+MODELESS")).toBe("net +modeless");
    });

    it("preserves NICK (DM) case — display + CTCP visibility row carry meaning", () => {
      expect(channelKey("net", "CristoBOT")).toBe("net CristoBOT");
      expect(channelKey("net", "Vjt")).toBe("net Vjt");
    });

    it("preserves the $server pseudo-channel sentinel case", () => {
      expect(channelKey("net", "$server")).toBe("net $server");
    });
  });

  describe("canonicalChannel — sigil-aware lowercase", () => {
    it("lowercases sigil-prefixed channel names", () => {
      expect(canonicalChannel("#Chan")).toBe("#chan");
      expect(canonicalChannel("&LocalChan")).toBe("&localchan");
      expect(canonicalChannel("!SAFE")).toBe("!safe");
      expect(canonicalChannel("+Modeless")).toBe("+modeless");
    });

    it("leaves nicks unchanged", () => {
      expect(canonicalChannel("Vjt")).toBe("Vjt");
      expect(canonicalChannel("CristoBOT")).toBe("CristoBOT");
    });

    it("leaves $server unchanged", () => {
      expect(canonicalChannel("$server")).toBe("$server");
    });

    it("is idempotent", () => {
      expect(canonicalChannel(canonicalChannel("#Chan"))).toBe("#chan");
      expect(canonicalChannel(canonicalChannel("alice"))).toBe("alice");
    });

    it("handles the empty string", () => {
      expect(canonicalChannel("")).toBe("");
    });
  });
});
