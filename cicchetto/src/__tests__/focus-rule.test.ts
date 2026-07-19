import { beforeEach, describe, expect, it, vi } from "vitest";

// C4.2 — Cluster-wide focus-only-on-user-action invariant.
//
// Focus (selectedChannel) must NOT change in response to incoming
// network traffic: PRIVMSG, JOIN, PART, QUIT, or channels_changed
// (autojoin). Only explicit user actions (click, keybinding, /msg,
// /query, /q) may switch focus.
//
// These tests run subscribe.ts end-to-end with mocked boundaries so
// the real WS event handler is exercised. Any accidental call to
// setSelectedChannel inside subscribe.ts (or any reactive side-effect
// triggered by an incoming event) would break these assertions.

const mockJoinPush = { receive: vi.fn() };
mockJoinPush.receive.mockReturnValue(mockJoinPush);

const mockChannel = {
  join: vi.fn(() => mockJoinPush),
  on: vi.fn(),
  leave: vi.fn(),
};

vi.mock("../lib/api", () => ({
  listNetworks: vi.fn(),
  listChannels: vi.fn(),
  listMessages: vi.fn(),
  sendMessage: vi.fn(),
  me: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  setOn401Handler: vi.fn(),
  // 2026-06-01 (unread-badges-from-cursor cluster, bucket B2):
  // selection.ts now imports isContentKind from api.ts for the badge
  // memo derivation. Any test importing selection (directly or
  // transitively) needs the classifier in its api mock.
  isContentKind: (k: string) => k === "privmsg" || k === "notice" || k === "action",
  isPresenceKind: (k: string) => !(k === "privmsg" || k === "notice" || k === "action"),
  displayNick: (me: { kind: "user" | "visitor"; name?: string; nick?: string }) =>
    me.kind === "user" ? (me.name ?? "") : (me.nick ?? ""),
  // Mirror of production `ownNickForNetwork` — see subscribe.test.ts
  // moduledoc + cic H3. #211 phase 7 — subject-agnostic; mirror production.
  ownNickForNetwork: (
    net: { slug: string; nick?: string },
    me: { kind: "user" | "visitor" } | null | undefined,
  ) => {
    if (me == null) return null;
    return net.nick ?? null;
  },
  // HIGH-24 (no-silent-drops B6.9a 2026-05-14): tagNetwork now reads
  // the discriminator off `raw.kind` instead of taking a subjectKind
  // arg. The mock mirrors the production single-arg signature; legacy
  // fixtures that omit `kind` default to "user" to match the most
  // common test path.
  tagNetwork: (
    raw: {
      kind?: "user" | "visitor";
      id: number;
      slug: string;
      nick?: string;
      connection_state?: string;
    } & Record<string, unknown>,
  ) => {
    const kind = raw.kind ?? "user";
    if (kind === "visitor") {
      return {
        kind: "visitor",
        id: raw.id,
        slug: raw.slug,
        inserted_at: raw.inserted_at,
        updated_at: raw.updated_at,
      };
    }
    if (raw.nick === undefined || raw.nick === "") return null;
    return {
      kind: "user",
      ...raw,
      connection_state: raw.connection_state ?? "connected",
      connection_state_reason: raw.connection_state_reason ?? null,
      connection_state_changed_at: raw.connection_state_changed_at ?? null,
    };
  },
}));

vi.mock("../lib/socket", () => ({
  joinChannel: vi.fn(() => mockChannel),
}));

vi.mock("../lib/members", () => ({
  applyPresenceEvent: vi.fn(),
  membersByChannel: vi.fn(() => ({})),
  seedFromTest: vi.fn(),
}));

vi.mock("../lib/mentions", () => ({
  mentionCounts: () => ({}),
  setServerMention: vi.fn(),
}));

vi.mock("../lib/queryWindows", () => ({
  openQueryWindowState: vi.fn(),
  closeQueryWindowState: vi.fn(),
  queryWindowsByNetwork: vi.fn(() => ({})),
  setQueryWindowsByNetwork: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
  mockJoinPush.receive.mockReturnValue(mockJoinPush);
});

const seedStubs = async () => {
  const api = await import("../lib/api");
  vi.mocked(api.listNetworks).mockResolvedValue([
    {
      id: 1,
      slug: "freenode",
      nick: "alice",
      connection_state: "connected",
      connection_state_reason: null,
      connection_state_changed_at: null,
      inserted_at: "x",
      updated_at: "y",
    },
  ]);
  vi.mocked(api.listChannels).mockResolvedValue([
    { name: "#grappa", joined: true, source: "autojoin" },
    { name: "#cicchetto", joined: true, source: "autojoin" },
  ]);
  vi.mocked(api.me).mockResolvedValue({
    kind: "user",
    id: "u1",
    name: "alice",
    is_admin: false,
    inserted_at: "x",
  });
  vi.mocked(api.listMessages).mockResolvedValue([]);
};

const loadStores = async () => {
  const sel = await import("../lib/selection");
  await import("../lib/subscribe");
  return sel;
};

/** Fire the event handler installed for channel at `idx` in join order. */
const fireAtHandlerIndex = (idx: number, payload: unknown) => {
  const eventCalls = mockChannel.on.mock.calls.filter((c) => c[0] === "event");
  const handler = eventCalls[idx]?.[1] as (p: unknown) => void;
  handler(payload);
};

const makeMessage = (channel: string, kind: string, sender: string, id: number): unknown => ({
  kind: "message",
  message: {
    id,
    network: "freenode",
    channel,
    server_time: id,
    kind,
    sender,
    body: "test",
    meta: {},
  },
});

describe("focus-rule — incoming traffic never changes selectedChannel", () => {
  it("incoming PRIVMSG on a channel does not change focus", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedStubs();
    const sel = await loadStores();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });
    // Set focus to channel A.
    sel.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#grappa",
      kind: "channel",
    });
    expect(sel.selectedChannel()?.channelName).toBe("#grappa");

    // Incoming PRIVMSG on channel B.
    fireAtHandlerIndex(1, makeMessage("#cicchetto", "privmsg", "bob", 1));

    // Focus must remain on A.
    expect(sel.selectedChannel()?.channelName).toBe("#grappa");
  });

  it("incoming JOIN event does not change focus", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedStubs();
    const sel = await loadStores();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });
    sel.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#grappa",
      kind: "channel",
    });

    fireAtHandlerIndex(1, makeMessage("#cicchetto", "join", "newcomer", 2));

    expect(sel.selectedChannel()?.channelName).toBe("#grappa");
  });

  it("incoming PART event does not change focus", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedStubs();
    const sel = await loadStores();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });
    sel.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#grappa",
      kind: "channel",
    });

    fireAtHandlerIndex(1, makeMessage("#cicchetto", "part", "leaver", 3));

    expect(sel.selectedChannel()?.channelName).toBe("#grappa");
  });

  it("incoming QUIT event does not change focus", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedStubs();
    const sel = await loadStores();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });
    sel.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#grappa",
      kind: "channel",
    });

    fireAtHandlerIndex(1, makeMessage("#cicchetto", "quit", "quitter", 4));

    expect(sel.selectedChannel()?.channelName).toBe("#grappa");
  });

  it("incoming DM PRIVMSG (auto-open) does not change focus", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    const api = await import("../lib/api");
    vi.mocked(api.listNetworks).mockResolvedValue([
      { id: 1, slug: "freenode", nick: "alice", inserted_at: "x", updated_at: "y" },
    ]);
    // "alice" is own nick — server routes incoming DMs to this channel slot.
    vi.mocked(api.listChannels).mockResolvedValue([
      { name: "#grappa", joined: true, source: "autojoin" },
      { name: "alice", joined: true, source: "autojoin" },
    ]);
    vi.mocked(api.me).mockResolvedValue({
      kind: "user",
      id: "u1",
      name: "alice",
      is_admin: false,
      inserted_at: "x",
    });
    vi.mocked(api.listMessages).mockResolvedValue([]);

    const sel = await loadStores();
    await vi.waitFor(() => {
      // 2 channels (#grappa + alice) + 0 DM-listener (deduped, alice in channels)
      // + 1 $server = 3 handlers.
      expect(mockChannel.on).toHaveBeenCalledTimes(3);
    });
    sel.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#grappa",
      kind: "channel",
    });

    // Incoming DM from "bob" on the own-nick channel.
    fireAtHandlerIndex(1, makeMessage("alice", "privmsg", "bob", 5));

    // Focus must remain on #grappa — auto-open is focus-neutral.
    expect(sel.selectedChannel()?.channelName).toBe("#grappa");
  });
});
