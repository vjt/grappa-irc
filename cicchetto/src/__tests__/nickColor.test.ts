import { describe, expect, it } from "vitest";
import type { ChannelMembers } from "../lib/memberTypes";
import {
  NICK_PALETTE_SIZE,
  nickColorIndex,
  nickColorVar,
  senderPrefix,
  snapshotSenderPrefix,
} from "../lib/nickColor";

// UX-5 bucket BC2 — deterministic nick-color hash + scrollback-side
// mode-prefix glyph lookup. Pair feature: per-nick color (replaces
// nick-length-only differentiation) + irssi-style mode prefix in
// scrollback (members pane already has sigil via `memberSigil`).
//
// The helper signature is the load-bearing contract — it MUST be:
//   * deterministic (same input → same index, always; no Date.now / Math.random)
//   * case-insensitive (RFC 2812 §2.2; cic-side `nickEquals` rule)
//   * in-bounds (0 ≤ index < NICK_PALETTE_SIZE)
//
// The CSS palette `--nick-color-0..15` lives in `themes/default.css`
// and is theme-aware via the `:root[data-theme="..."]` selector. This
// module is theme-AGNOSTIC — it produces a `var(--nick-color-N)`
// string; theme blocks own the actual colors.

describe("nickColorIndex", () => {
  it("returns the same index for the same nick across calls", () => {
    const a = nickColorIndex("vjt");
    const b = nickColorIndex("vjt");
    expect(a).toBe(b);
  });

  it("is case-insensitive per RFC 2812 §2.2 (Vjt === vjt === VJT)", () => {
    const lower = nickColorIndex("vjt");
    const mixed = nickColorIndex("Vjt");
    const upper = nickColorIndex("VJT");
    expect(mixed).toBe(lower);
    expect(upper).toBe(lower);
  });

  it("always returns an index in [0, NICK_PALETTE_SIZE)", () => {
    const nicks = ["vjt", "alice", "bob", "carol", "dave", "_", "x", "OperServ", "{user}", "💩"];
    for (const nick of nicks) {
      const idx = nickColorIndex(nick);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(NICK_PALETTE_SIZE);
    }
  });

  it("distributes distinct nicks across multiple palette buckets (sanity, not uniformity)", () => {
    const nicks = [
      "alice",
      "bob",
      "carol",
      "dave",
      "eve",
      "frank",
      "grace",
      "heidi",
      "ivan",
      "judy",
      "kate",
      "leo",
      "mallory",
      "nick",
      "olivia",
      "peggy",
      "quentin",
      "ruth",
      "sasha",
      "trent",
    ];
    const indices = new Set(nicks.map(nickColorIndex));
    // 20 nicks across a 16-palette: pigeonhole forces some collisions,
    // but a working hash should still bucket into at least 6 distinct
    // indices. A pathologically bad hash (e.g. all → 0) would fail.
    expect(indices.size).toBeGreaterThanOrEqual(6);
  });

  it("handles empty string without throwing (defensive — should never happen at the boundary)", () => {
    const idx = nickColorIndex("");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(NICK_PALETTE_SIZE);
  });
});

describe("nickColorVar", () => {
  it("returns the var() string for the palette slot", () => {
    const v = nickColorVar("vjt");
    expect(v).toMatch(/^var\(--nick-color-\d+\)$/);
  });

  it("agrees with nickColorIndex for the embedded index", () => {
    const idx = nickColorIndex("vjt");
    expect(nickColorVar("vjt")).toBe(`var(--nick-color-${idx})`);
  });
});

describe("senderPrefix", () => {
  const m = (entries: Record<string, string[]>): ChannelMembers =>
    Object.entries(entries).map(([nick, modes]) => ({ nick, modes }));

  it("returns @ for an op", () => {
    expect(senderPrefix(m({ alice: ["@"] }), "alice")).toBe("@");
  });

  it("returns % for a halfop", () => {
    expect(senderPrefix(m({ bob: ["%"] }), "bob")).toBe("%");
  });

  it("returns + for a voiced member", () => {
    expect(senderPrefix(m({ carol: ["+"] }), "carol")).toBe("+");
  });

  it("returns empty string for a plain member", () => {
    expect(senderPrefix(m({ dave: [] }), "dave")).toBe("");
  });

  it("returns empty string for a non-member (sender from a different channel)", () => {
    expect(senderPrefix(m({ alice: ["@"] }), "stranger")).toBe("");
  });

  it("returns empty string when members list is undefined (unknown channel)", () => {
    expect(senderPrefix(undefined, "alice")).toBe("");
  });

  it("returns the HIGHEST precedence prefix when a member has multiple modes (@ > % > +)", () => {
    expect(senderPrefix(m({ alice: ["@", "+"] }), "alice")).toBe("@");
    expect(senderPrefix(m({ bob: ["%", "+"] }), "bob")).toBe("%");
    expect(senderPrefix(m({ carol: ["+"] }), "carol")).toBe("+");
  });

  it("is case-insensitive for the nick lookup (Alice/alice match)", () => {
    expect(senderPrefix(m({ Alice: ["@"] }), "alice")).toBe("@");
    expect(senderPrefix(m({ alice: ["@"] }), "Alice")).toBe("@");
  });
});

describe("snapshotSenderPrefix (#25)", () => {
  it("returns the snapshotted glyph from meta.sender_prefix", () => {
    expect(snapshotSenderPrefix({ sender_prefix: "@" })).toBe("@");
    expect(snapshotSenderPrefix({ sender_prefix: "%" })).toBe("%");
    expect(snapshotSenderPrefix({ sender_prefix: "+" })).toBe("+");
  });

  it("returns '' when the key is absent (plain sender / pre-#25 row)", () => {
    expect(snapshotSenderPrefix({})).toBe("");
    expect(snapshotSenderPrefix({ new_nick: "x" })).toBe("");
  });

  it("returns '' for a malformed / non-glyph value (never a live guess)", () => {
    expect(snapshotSenderPrefix({ sender_prefix: "~" })).toBe("");
    expect(snapshotSenderPrefix({ sender_prefix: 1 })).toBe("");
    expect(snapshotSenderPrefix({ sender_prefix: null })).toBe("");
  });
});
