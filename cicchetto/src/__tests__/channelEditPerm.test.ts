import { beforeEach, describe, expect, it, vi } from "vitest";

// #74 — `ownHoldsChannelEditorSigil` is the single editor-sigil derivation
// shared by ModeModal (channel-mode edit gate) and TopicBar (+t topic-lock
// gate): does the operator's own nick hold an editing sigil (op/halfop or a
// higher PREFIX rank) in a channel? Pure projection of server-owned state
// (membersByChannel + ISUPPORT PREFIX). It degrades CLOSED — false when own
// membership isn't in state — with the ircd's 482 as the authority safety
// net. Mirrors ModeModal.test's store mocks.

let mockMembers: Record<string, Array<{ nick: string; modes: string[] }>> = {};

vi.mock("../lib/members", () => ({
  membersByChannel: () => mockMembers,
}));

vi.mock("../lib/networks", () => {
  const networks = vi.fn(() => [
    { id: 1, slug: "bahamut", nick: "vjt-grappa", inserted_at: "x", updated_at: "y" },
  ]);
  const user = vi.fn(() => ({
    kind: "user",
    id: "u1",
    name: "vjt",
    is_admin: false,
    inserted_at: "x",
  }));
  const networkBySlug = (slug: string) => networks()?.find((n) => n.slug === slug);
  return { networks, user, networkBySlug };
});

// ownNickForNetwork resolves the per-network IRC nick — return the seeded
// network nick so the sigil gate looks it up in members.
vi.mock("../lib/api", () => ({
  ownNickForNetwork: (net: { nick: string }) => net.nick,
}));

import { ownHoldsChannelEditorSigil } from "../lib/channelEditPerm";
import { channelKey } from "../lib/channelKey";
import { DEFAULT_ISUPPORT, seedIsupport } from "../lib/isupport";

// Real channel key (branded ChannelKey) so both the members mock and the
// lookup use the identical key — no `as` cast that could mask a real drift.
const KEY = channelKey("bahamut", "#bofh");

describe("ownHoldsChannelEditorSigil", () => {
  beforeEach(() => {
    mockMembers = {};
    seedIsupport(1, DEFAULT_ISUPPORT);
  });

  it("returns true when own nick is an op (@)", () => {
    mockMembers[KEY] = [{ nick: "vjt-grappa", modes: ["@"] }];
    expect(ownHoldsChannelEditorSigil("bahamut", KEY, 1)).toBe(true);
  });

  it("returns true when own nick is a halfop (%)", () => {
    mockMembers[KEY] = [{ nick: "vjt-grappa", modes: ["%"] }];
    expect(ownHoldsChannelEditorSigil("bahamut", KEY, 1)).toBe(true);
  });

  it("returns false when own nick is voice-only (+)", () => {
    mockMembers[KEY] = [{ nick: "vjt-grappa", modes: ["+"] }];
    expect(ownHoldsChannelEditorSigil("bahamut", KEY, 1)).toBe(false);
  });

  it("returns false when own nick has no sigil (plain member)", () => {
    mockMembers[KEY] = [{ nick: "vjt-grappa", modes: [] }];
    expect(ownHoldsChannelEditorSigil("bahamut", KEY, 1)).toBe(false);
  });

  it("degrades closed when own membership is not in state", () => {
    mockMembers[KEY] = [{ nick: "someone-else", modes: ["@"] }];
    expect(ownHoldsChannelEditorSigil("bahamut", KEY, 1)).toBe(false);
  });

  it("degrades closed when there are no members cached at all", () => {
    expect(ownHoldsChannelEditorSigil("bahamut", KEY, 1)).toBe(false);
  });
});
