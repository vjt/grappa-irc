import { render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrollbackMessage } from "../lib/api";

// C5.0 — JOIN-self auto-focus-switch: mock selection so we can assert
// setSelectedChannel is called when own nick's JOIN event shows up.
const mockSetSelectedChannel = vi.fn();
vi.mock("../lib/selection", () => ({
  setSelectedChannel: (ch: unknown) => mockSetSelectedChannel(ch),
  selectedChannel: () => null,
}));

// Mock the store boundary, not the REST/WS plumbing — ScrollbackPane is
// a pure projection of `scrollbackByChannel` + `networks.user` (for the
// mention matcher). The store itself is exercised in scrollback.test.ts.
//
// The scrollback signal is a REAL Solid signal (S51) — earlier shape
// used a plain `vi.fn()` getter, which meant tests could only seed the
// value BEFORE render. The auto-scroll-on-new-message UX
// (`createEffect(on(() => messages()?.length, …))` inside
// ScrollbackPane) needs the accessor to be reactive so updates
// mid-render flow through Solid's dependency tracker. A plain-fn mock
// pinned only "what does the initial render look like," not the
// reactive contract — a refactor that broke reactivity would have
// stayed green.

const [scrollback, setScrollback] = createSignal<Record<string, ScrollbackMessage[]>>({});
const [userNick, setUserNick] = createSignal<string | null>(null);

vi.mock("../lib/scrollback", () => ({
  scrollbackByChannel: () => scrollback(),
}));

vi.mock("../lib/networks", () => ({
  user: () => {
    const n = userNick();
    return n === null ? null : { kind: "user", id: "u1", name: n, inserted_at: "x" };
  },
  // Per-network IRC nick must mirror userNick() so ownNickForNetwork
  // resolves to the test's expected value (avoiding the cic H3
  // server-contract-violation branch that would null + log).
  // Bucket F H4: Network is now a discriminated union; the user
  // branch requires `kind: "user"` + connection_state fields.
  networks: () => {
    const n = userNick();
    return [
      {
        kind: "user",
        id: 42,
        slug: "freenode",
        nick: n ?? "alice",
        connection_state: "connected",
        connection_state_reason: null,
        connection_state_changed_at: null,
        inserted_at: "",
        updated_at: "",
      },
    ];
  },
}));

// C7.6: queryWindows + socket mocked so UserContextMenu import doesn't crash.
const mockOpenQueryWindowState = vi.fn();
vi.mock("../lib/queryWindows", () => ({
  openQueryWindowState: (...args: unknown[]) => mockOpenQueryWindowState(...args),
  queryWindowsByNetwork: () => ({}),
  closeQueryWindowState: vi.fn(),
  setQueryWindowsByNetwork: vi.fn(),
  canonicalQueryNick: (_networkId: number, nick: string) => nick,
}));

vi.mock("../lib/socket", () => ({
  joinChannel: vi.fn(),
  pushChannelOp: vi.fn(),
  pushChannelDeop: vi.fn(),
  pushChannelVoice: vi.fn(),
  pushChannelDevoice: vi.fn(),
  pushChannelKick: vi.fn(),
  pushChannelBan: vi.fn(),
  pushWhois: vi.fn(),
}));

vi.mock("../lib/channelKey", () => ({
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
}));

// C3.2: mock membersByChannel for JOIN-self banner tests
const mockMembersByChannel = vi.fn(() => ({}));
vi.mock("../lib/members", () => ({
  membersByChannel: () => mockMembersByChannel(),
}));

// C3.1/C3.2: mock channelTopic for topic display in banner
const mockTopicByChannel = vi.fn(() => ({}));
const mockCreatedByChannel = vi.fn<() => Record<string, string>>(() => ({}));
vi.mock("../lib/channelTopic", () => ({
  topicByChannel: () => mockTopicByChannel(),
  createdByChannel: () => mockCreatedByChannel(),
}));

// CP29 R-4: mock readCursor with a SIGNAL-BACKED stand-in mirroring the
// production module's reactive contract — `last_read_message_id` (int)
// instead of the pre-flip server_time epoch ms. Reactivity matters
// because ScrollbackPane's `rows` createMemo reads the cursor and must
// re-run when a `read_cursor_set` WS event lands; without reactivity
// the marker pins with a stale count (the bug C7.3 surfaced and the
// new server-side-cursor model preserves at the cic boundary).
//
// `applyReadCursorSet` mirrors the prod API: forward-only signal write
// keyed on `(slug, channel)`. `seedReadCursor` is the test verb that
// stages a cursor BEFORE render — same shape as the prod `applyMeEnvelope`
// + `applyJoinReply` cold-load path.
const cacheKey = (networkSlug: string, channel: string) => `${networkSlug} ${channel}`;
const [readCursorStore, setReadCursorStore] = createSignal<Record<string, number>>({});
const seedReadCursor = (networkSlug: string, channel: string, messageId: number) => {
  setReadCursorStore((prev) => ({ ...prev, [cacheKey(networkSlug, channel)]: messageId }));
};
vi.mock("../lib/readCursor", () => ({
  getReadCursor: (networkSlug: string, channel: string): number | null => {
    const v = readCursorStore()[cacheKey(networkSlug, channel)];
    return v === undefined ? null : v;
  },
  applyReadCursorSet: (networkSlug: string, channel: string, lastReadMessageId: number): void => {
    setReadCursorStore((prev) => {
      const k = cacheKey(networkSlug, channel);
      const existing = prev[k];
      if (existing !== undefined && existing >= lastReadMessageId) return prev;
      return { ...prev, [k]: lastReadMessageId };
    });
  },
  applyMeEnvelope: vi.fn(),
  applyJoinReply: vi.fn(),
  setReadCursor: vi.fn().mockResolvedValue(undefined),
  clearReadCursors: vi.fn(() => setReadCursorStore({})),
}));

// No-silent-drops bucket 2: mock api.postJoin + auth.token so the
// INVITE [Join] CTA's handler doesn't hit the live REST/auth modules.
// `mockPostJoin` returns a resolved promise so the chained
// setSelectedChannel still runs.
const mockPostJoin = vi.fn().mockResolvedValue(undefined);
vi.mock("../lib/api", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    postJoin: (...args: unknown[]) => mockPostJoin(...args),
  };
});
vi.mock("../lib/auth", () => ({
  token: () => "test-token",
}));

import ScrollbackPane, { resetShownBannersForTest } from "../ScrollbackPane";

const fixture: ScrollbackMessage[] = [
  {
    id: 1,
    network: "freenode",
    channel: "#grappa",
    server_time: 1_700_000_000_000,
    kind: "privmsg",
    sender: "alice",
    body: "hello",
    meta: {},
  },
  {
    id: 2,
    network: "freenode",
    channel: "#grappa",
    server_time: 1_700_000_001_000,
    kind: "action",
    sender: "bob",
    body: "waves",
    meta: {},
  },
  {
    id: 3,
    network: "freenode",
    channel: "#grappa",
    server_time: 1_700_000_002_000,
    kind: "notice",
    sender: "ChanServ",
    body: "topic locked",
    meta: {},
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  setScrollback({});
  setUserNick(null);
  mockMembersByChannel.mockReturnValue({});
  mockTopicByChannel.mockReturnValue({});
  mockCreatedByChannel.mockReturnValue({});
  // Reset the join-banner shown-set between tests (test seam, see ScrollbackPane.tsx).
  resetShownBannersForTest();
  mockSetSelectedChannel.mockClear();
});

describe("ScrollbackPane", () => {
  it("renders an empty placeholder when no messages exist for the channel", () => {
    render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
    expect(screen.getByText(/no messages yet/i)).toBeInTheDocument();
  });

  it("re-renders when the scrollback signal updates mid-mount (S51 reactivity pin)", async () => {
    // Pre-S51 the mock was a plain `vi.fn()` returning a value seeded
    // before render; this assertion would have stayed green even if
    // ScrollbackPane stopped tracking the signal reactively. With a
    // real Solid signal the test fails fast on a non-reactive refactor.
    render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
    expect(screen.getByText(/no messages yet/i)).toBeInTheDocument();

    setScrollback({ "freenode #grappa": fixture });

    await waitFor(() => {
      expect(screen.getAllByTestId("scrollback-line")).toHaveLength(3);
    });
  });

  it("renders one line per message with kind-specific shape", () => {
    setScrollback({ "freenode #grappa": fixture });
    render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
    const lines = screen.getAllByTestId("scrollback-line");
    expect(lines).toHaveLength(3);
    expect(lines[0]?.dataset.kind).toBe("privmsg");
    expect(lines[0]).toHaveTextContent("<alice>");
    expect(lines[0]).toHaveTextContent("hello");
    expect(lines[1]?.dataset.kind).toBe("action");
    expect(lines[1]).toHaveTextContent("* bob waves");
    expect(lines[2]?.dataset.kind).toBe("notice");
    expect(lines[2]).toHaveTextContent("-ChanServ-");
    expect(lines[2]).toHaveTextContent("topic locked");
  });

  it("strips the CTCP ACTION envelope at the action render layer", () => {
    // Server-side persists the wire-form body verbatim per the CLAUDE.md
    // CTCP "preserved as-is" rule (round-trip fidelity for ACTION + future
    // CTCP verbs). The renderer's :action branch unwraps the
    // `\x01ACTION ...\x01` envelope so the user sees just the inner text.
    // M10 (e2e) pins the same invariant against a real bahamut peer.
    const ctcpAction: ScrollbackMessage[] = [
      {
        id: 1,
        network: "n",
        channel: "#c",
        server_time: 1,
        kind: "action",
        sender: "bob",
        body: "\x01ACTION waves at the channel\x01",
        meta: {},
      },
    ];
    setScrollback({ "freenode #grappa": ctcpAction });
    render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
    const line = screen.getByTestId("scrollback-line");
    expect(line.dataset.kind).toBe("action");
    expect(line).toHaveTextContent("* bob waves at the channel");
    expect(line.textContent ?? "").not.toContain("\x01");
    expect(line.textContent ?? "").not.toContain("ACTION ");
  });

  it("renders all ten server kinds without falling through to PRIVMSG framing", () => {
    // Server `Grappa.Scrollback.Message.kind()` enum: ten kinds. Phase 5
    // presence-event capture will emit any of them on the wire; the
    // renderer must NOT render presence/op kinds with the `<sender>`
    // PRIVMSG angle-bracket framing. This test pins the contract: each
    // non-message kind renders `* sender <verb>` (irssi-shape) or
    // dash-framed (notice) — never angle-bracketed.
    const allKinds: ScrollbackMessage[] = [
      {
        id: 1,
        network: "n",
        channel: "#c",
        server_time: 1,
        kind: "privmsg",
        sender: "alice",
        body: "hi",
        meta: {},
      },
      {
        id: 2,
        network: "n",
        channel: "#c",
        server_time: 2,
        kind: "notice",
        sender: "ChanServ",
        body: "lock",
        meta: {},
      },
      {
        id: 3,
        network: "n",
        channel: "#c",
        server_time: 3,
        kind: "action",
        sender: "bob",
        body: "waves",
        meta: {},
      },
      {
        id: 4,
        network: "n",
        channel: "#c",
        server_time: 4,
        kind: "join",
        sender: "carol",
        body: null,
        meta: {},
      },
      {
        id: 5,
        network: "n",
        channel: "#c",
        server_time: 5,
        kind: "part",
        sender: "dave",
        body: "bye",
        meta: {},
      },
      {
        id: 6,
        network: "n",
        channel: "#c",
        server_time: 6,
        kind: "quit",
        sender: "eve",
        body: "ping timeout",
        meta: {},
      },
      {
        id: 7,
        network: "n",
        channel: "#c",
        server_time: 7,
        kind: "nick_change",
        sender: "frank",
        body: null,
        meta: { new_nick: "frank2" },
      },
      {
        id: 8,
        network: "n",
        channel: "#c",
        server_time: 8,
        kind: "mode",
        sender: "grace",
        body: null,
        meta: { modes: "+o", args: ["heidi"] },
      },
      {
        id: 9,
        network: "n",
        channel: "#c",
        server_time: 9,
        kind: "topic",
        sender: "ivan",
        body: "new topic",
        meta: {},
      },
      {
        id: 10,
        network: "n",
        channel: "#c",
        server_time: 10,
        kind: "kick",
        sender: "judy",
        body: "spam",
        meta: { target: "mallory" },
      },
    ];
    setScrollback({ "n #c": allKinds });
    render(() => <ScrollbackPane networkSlug="n" channelName="#c" kind="channel" />);
    const lines = screen.getAllByTestId("scrollback-line");
    expect(lines).toHaveLength(10);

    // PRIVMSG: angle-bracket sender
    expect(lines[0]).toHaveTextContent("<alice>");
    // NOTICE: dash-framed sender
    expect(lines[1]).toHaveTextContent("-ChanServ-");
    expect(lines[1]).not.toHaveTextContent("<ChanServ>");
    // ACTION: irssi `* sender body`
    expect(lines[2]).toHaveTextContent("* bob waves");
    expect(lines[2]).not.toHaveTextContent("<bob>");

    // Presence + op kinds: NEVER angle-bracket framing.
    for (let i = 3; i < 10; i++) {
      expect(lines[i]).not.toHaveTextContent(`<${allKinds[i]?.sender}>`);
    }

    expect(lines[3]).toHaveTextContent("carol");
    expect(lines[3]).toHaveTextContent("#c");
    expect(lines[4]).toHaveTextContent("dave");
    expect(lines[5]).toHaveTextContent("eve");
    expect(lines[6]).toHaveTextContent("frank2");
    // Pin args adjacency to the modes flag — a refactor that rendered
    // `sets mode +o on #c heidi` (args at wrong position) would still
    // include both tokens but break readability.
    expect(lines[7]).toHaveTextContent("+o heidi");
    expect(lines[8]).toHaveTextContent("new topic");
    expect(lines[9]).toHaveTextContent("mallory");
  });

  it("scopes scrollback to the (slug, channel) pair via channelKey", () => {
    setScrollback({
      "freenode #grappa": fixture,
      "freenode #cicchetto": [
        {
          id: 99,
          network: "freenode",
          channel: "#cicchetto",
          server_time: 1,
          kind: "privmsg",
          sender: "x",
          body: "different channel",
          meta: {},
        },
      ],
    });
    render(() => <ScrollbackPane networkSlug="freenode" channelName="#cicchetto" kind="channel" />);
    const lines = screen.getAllByTestId("scrollback-line");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent("different channel");
  });

  // P4-1 Q10: ScrollbackPane is now compose-free; ComposeBox owns the
  // textarea + send button. The legacy compose tests moved to
  // ComposeBox.test.tsx.
  it("does NOT render the inline compose form (P4-1 split)", () => {
    setScrollback({ "freenode #grappa": fixture });
    render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.querySelector("form.compose")).toBeNull();
  });

  describe("mention highlight (P4-1)", () => {
    it("adds .scrollback-mention to lines that mention the user's nick", () => {
      setUserNick("vjt");
      setScrollback({
        "freenode #a": [
          {
            id: 1,
            network: "freenode",
            channel: "#a",
            server_time: 100,
            kind: "privmsg",
            sender: "alice",
            body: "hi vjt!",
            meta: {},
          },
        ],
      });
      const { container } = render(() => (
        <ScrollbackPane networkSlug="freenode" channelName="#a" kind="channel" />
      ));
      const line = container.querySelector('[data-kind="privmsg"]');
      expect(line?.classList.contains("scrollback-mention")).toBe(true);
    });

    it("case-insensitive match: uppercase mention still highlights", () => {
      setUserNick("vjt");
      setScrollback({
        "freenode #a": [
          {
            id: 2,
            network: "freenode",
            channel: "#a",
            server_time: 100,
            kind: "privmsg",
            sender: "alice",
            body: "VJT around?",
            meta: {},
          },
        ],
      });
      const { container } = render(() => (
        <ScrollbackPane networkSlug="freenode" channelName="#a" kind="channel" />
      ));
      const line = container.querySelector('[data-kind="privmsg"]');
      expect(line?.classList.contains("scrollback-mention")).toBe(true);
    });

    it("word-boundary: substring match inside another word does NOT highlight", () => {
      setUserNick("vjt");
      setScrollback({
        "freenode #a": [
          {
            id: 3,
            network: "freenode",
            channel: "#a",
            server_time: 100,
            kind: "privmsg",
            sender: "alice",
            body: "vjtfoo bar",
            meta: {},
          },
        ],
      });
      const { container } = render(() => (
        <ScrollbackPane networkSlug="freenode" channelName="#a" kind="channel" />
      ));
      const line = container.querySelector('[data-kind="privmsg"]');
      expect(line?.classList.contains("scrollback-mention")).toBe(false);
    });

    it("no-mention privmsg has no .scrollback-mention class", () => {
      setUserNick("vjt");
      setScrollback({ "freenode #grappa": fixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const lines = screen.getAllByTestId("scrollback-line");
      for (const line of lines) {
        expect(line.classList.contains("scrollback-mention")).toBe(false);
      }
    });

    it("non-privmsg kinds never highlight even if body matches nick", () => {
      setUserNick("vjt");
      setScrollback({
        "freenode #a": [
          {
            id: 4,
            network: "freenode",
            channel: "#a",
            server_time: 100,
            kind: "topic",
            sender: "alice",
            body: "vjt set this",
            meta: {},
          },
        ],
      });
      const { container } = render(() => (
        <ScrollbackPane networkSlug="freenode" channelName="#a" kind="channel" />
      ));
      const line = container.querySelector('[data-kind="topic"]');
      expect(line?.classList.contains("scrollback-mention")).toBe(false);
    });
  });

  describe("JOIN-self banner (C3.2)", () => {
    // Banner renders when own nick has a JOIN event in scrollback for this channel.
    it("renders 'You joined #chan' banner when own nick JOIN event is in scrollback", () => {
      setUserNick("vjt");
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1_700_000_000_000,
            kind: "join",
            sender: "vjt",
            body: null,
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      expect(screen.getByTestId("join-banner")).toBeInTheDocument();
      expect(screen.getByTestId("join-banner")).toHaveTextContent("You joined #grappa");
    });

    it("does NOT render banner when the JOIN sender is NOT own nick", () => {
      setUserNick("vjt");
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1_700_000_000_000,
            kind: "join",
            sender: "alice",
            body: null,
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      expect(screen.queryByTestId("join-banner")).toBeNull();
    });

    it("does NOT render banner when there is no JOIN event in scrollback", () => {
      setUserNick("vjt");
      setScrollback({ "freenode #grappa": fixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      expect(screen.queryByTestId("join-banner")).toBeNull();
    });

    it("does NOT render banner when user is null (not resolved yet)", () => {
      setUserNick(null);
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1_700_000_000_000,
            kind: "join",
            sender: "vjt",
            body: null,
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      expect(screen.queryByTestId("join-banner")).toBeNull();
    });

    it("renders topic line in banner when topic is cached", () => {
      setUserNick("vjt");
      mockTopicByChannel.mockReturnValue({
        "freenode #grappa": { text: "Welcome to grappa IRC", set_by: "vjt", set_at: null },
      });
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1_700_000_000_000,
            kind: "join",
            sender: "vjt",
            body: null,
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const banner = screen.getByTestId("join-banner");
      expect(banner).toHaveTextContent("Welcome to grappa IRC");
    });

    // Cluster `channel-created-notice` 2026-05-13 — 329 RPL_CREATIONTIME
    // surfaces in the JoinBanner as an irssi-style "Channel was created
    // on …" line. Replaces the pre-cluster scrollback noise (Bahamut
    // emitted the timestamp via 333 RPL_TOPICWHOTIME's trailing param,
    // which leaked as a `kind: notice` row with body=unix_ts).
    it("renders 'Channel was created on …' line in banner when 329 cache is seeded", () => {
      setUserNick("vjt");
      mockCreatedByChannel.mockReturnValue({
        "freenode #grappa": "2024-09-22T10:00:00Z",
      });
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1_700_000_000_000,
            kind: "join",
            sender: "vjt",
            body: null,
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const created = screen.getByTestId("join-banner-created");
      expect(created.textContent).toMatch(/^Channel was created on /);
      // Don't assert exact locale render — `Date.toLocaleString()` is
      // env-sensitive. Assert the literal year shows (the parse worked).
      expect(created).toHaveTextContent("2024");
    });

    it("does NOT render 'Channel was created' line when 329 cache is empty", () => {
      setUserNick("vjt");
      mockCreatedByChannel.mockReturnValue({});
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1_700_000_000_000,
            kind: "join",
            sender: "vjt",
            body: null,
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      expect(screen.queryByTestId("join-banner-created")).toBeNull();
    });

    it("renders 'Topic set by … on …' line when 333 set_by + set_at are cached", () => {
      setUserNick("vjt");
      mockTopicByChannel.mockReturnValue({
        "freenode #grappa": {
          text: "Welcome",
          set_by: "ChanServ",
          set_at: "2026-04-01T12:34:56Z",
        },
      });
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1_700_000_000_000,
            kind: "join",
            sender: "vjt",
            body: null,
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const topicSet = screen.getByTestId("join-banner-topic-set");
      expect(topicSet.textContent).toMatch(/^Topic set by ChanServ on /);
      expect(topicSet).toHaveTextContent("2026");
    });

    it("does NOT render 'Topic set by' line when set_by is missing", () => {
      setUserNick("vjt");
      mockTopicByChannel.mockReturnValue({
        "freenode #grappa": { text: "Welcome", set_by: null, set_at: null },
      });
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1_700_000_000_000,
            kind: "join",
            sender: "vjt",
            body: null,
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      expect(screen.queryByTestId("join-banner-topic-set")).toBeNull();
    });
    it("renders names list from members store in banner", () => {
      setUserNick("vjt");
      mockMembersByChannel.mockReturnValue({
        "freenode #grappa": [
          { nick: "vjt", modes: ["@"] },
          { nick: "alice", modes: ["+"] },
          { nick: "bob", modes: [] },
        ],
      });
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1_700_000_000_000,
            kind: "join",
            sender: "vjt",
            body: null,
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const banner = screen.getByTestId("join-banner");
      // @ prefix for ops, + for voiced
      expect(banner).toHaveTextContent("@vjt");
      expect(banner).toHaveTextContent("+alice");
      expect(banner).toHaveTextContent("bob");
    });

    it("renders member count summary in banner", () => {
      setUserNick("vjt");
      mockMembersByChannel.mockReturnValue({
        "freenode #grappa": [
          { nick: "vjt", modes: ["@"] },
          { nick: "alice", modes: [] },
          { nick: "bob", modes: [] },
        ],
      });
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1_700_000_000_000,
            kind: "join",
            sender: "vjt",
            body: null,
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const banner = screen.getByTestId("join-banner");
      // 3 total users, 1 op
      expect(banner).toHaveTextContent("3 users");
      expect(banner).toHaveTextContent("1 op");
    });

    it("renders '(loading members…)' section when member list is empty", () => {
      setUserNick("vjt");
      mockMembersByChannel.mockReturnValue({});
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1_700_000_000_000,
            kind: "join",
            sender: "vjt",
            body: null,
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const banner = screen.getByTestId("join-banner");
      expect(banner).toHaveTextContent("loading members");
    });

    it("does NOT render banner for query window kind (channel-only per spec #7)", () => {
      setUserNick("vjt");
      setScrollback({
        "freenode some-nick": [
          {
            id: 1,
            network: "freenode",
            channel: "some-nick",
            server_time: 1_700_000_000_000,
            kind: "join",
            sender: "vjt",
            body: null,
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="some-nick" kind="query" />);
      expect(screen.queryByTestId("join-banner")).toBeNull();
    });

    it("does NOT render banner for server window kind", () => {
      setUserNick("vjt");
      setScrollback({
        "freenode :server": [
          {
            id: 1,
            network: "freenode",
            channel: ":server",
            server_time: 1_700_000_000_000,
            kind: "join",
            sender: "vjt",
            body: null,
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName=":server" kind="server" />);
      expect(screen.queryByTestId("join-banner")).toBeNull();
    });

    // C5.0 — JOIN-self auto-focus-switch (spec #7):
    // When own nick's JOIN event appears in scrollback, the pane MUST call
    // setSelectedChannel to switch focus to that channel. This is a user
    // action (the user issued /join) so the cluster-wide focus-only-on-
    // user-action rule is not violated — the focus-rule invariant tests
    // assert that OTHER-user joins do NOT shift focus.
    it("calls setSelectedChannel when own nick JOIN event shows up in scrollback (C5.0)", async () => {
      setUserNick("vjt");
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1_700_000_000_000,
            kind: "join",
            sender: "vjt",
            body: null,
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      await waitFor(() => {
        expect(mockSetSelectedChannel).toHaveBeenCalledWith({
          networkSlug: "freenode",
          channelName: "#grappa",
          kind: "channel",
        });
      });
    });

    it("does NOT call setSelectedChannel when the JOIN sender is not own nick", async () => {
      setUserNick("vjt");
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1_700_000_000_000,
            kind: "join",
            sender: "alice",
            body: null,
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      // Give reactive effects time to settle.
      await new Promise((r) => setTimeout(r, 20));
      expect(mockSetSelectedChannel).not.toHaveBeenCalled();
    });
  });

  // C7.1: Day-separator lines.
  describe("day-separator lines (C7.1)", () => {
    it("renders no day-separator when all messages are on the same day", () => {
      const sameDayMsgs: ScrollbackMessage[] = [
        {
          id: 1,
          network: "freenode",
          channel: "#grappa",
          server_time: 1_700_000_000_000,
          kind: "privmsg",
          sender: "alice",
          body: "hello",
          meta: {},
        },
        {
          id: 2,
          network: "freenode",
          channel: "#grappa",
          server_time: 1_700_000_000_001,
          kind: "privmsg",
          sender: "bob",
          body: "world",
          meta: {},
        },
      ];
      setScrollback({ "freenode #grappa": sameDayMsgs });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      expect(screen.queryByTestId("day-separator")).toBeNull();
    });

    it("renders a day-separator between messages on different days", () => {
      const twoDayMsgs: ScrollbackMessage[] = [
        {
          id: 1,
          network: "freenode",
          channel: "#grappa",
          server_time: 1_700_000_000_000,
          kind: "privmsg",
          sender: "alice",
          body: "yesterday",
          meta: {},
        },
        {
          id: 2,
          network: "freenode",
          channel: "#grappa",
          server_time: 1_700_000_000_000 + 86_400_000,
          kind: "privmsg",
          sender: "bob",
          body: "today",
          meta: {},
        },
      ];
      setScrollback({ "freenode #grappa": twoDayMsgs });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const separators = screen.getAllByTestId("day-separator");
      expect(separators).toHaveLength(1);
      expect(screen.getAllByTestId("scrollback-line")).toHaveLength(2);
    });

    it("renders multiple day-separators for messages across 3 days", () => {
      const threeDayMsgs: ScrollbackMessage[] = [
        {
          id: 1,
          network: "freenode",
          channel: "#grappa",
          server_time: 1_700_000_000_000,
          kind: "privmsg",
          sender: "alice",
          body: "day1",
          meta: {},
        },
        {
          id: 2,
          network: "freenode",
          channel: "#grappa",
          server_time: 1_700_000_000_000 + 86_400_000,
          kind: "privmsg",
          sender: "bob",
          body: "day2",
          meta: {},
        },
        {
          id: 3,
          network: "freenode",
          channel: "#grappa",
          server_time: 1_700_000_000_000 + 2 * 86_400_000,
          kind: "privmsg",
          sender: "carol",
          body: "day3",
          meta: {},
        },
      ];
      setScrollback({ "freenode #grappa": threeDayMsgs });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const separators = screen.getAllByTestId("day-separator");
      expect(separators).toHaveLength(2);
    });
  });

  // C7.2: Muted-events rendering.
  describe("muted-event rendering (C7.2)", () => {
    it("applies .scrollback-muted class to JOIN events", () => {
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1_700_000_000_000,
            kind: "join",
            sender: "alice",
            body: null,
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const line = screen.getByTestId("scrollback-line");
      expect(line.classList.contains("scrollback-muted")).toBe(true);
    });

    it("applies .scrollback-muted to PART, QUIT, MODE, NICK, TOPIC, KICK events", () => {
      const mutedKinds: ScrollbackMessage["kind"][] = [
        "part",
        "quit",
        "mode",
        "nick_change",
        "topic",
        "kick",
      ];
      for (const kind of mutedKinds) {
        setScrollback({
          "freenode #grappa": [
            {
              id: 1,
              network: "freenode",
              channel: "#grappa",
              server_time: 1_700_000_000_000,
              kind,
              sender: "alice",
              body: null,
              meta:
                kind === "nick_change"
                  ? { new_nick: "alice2" }
                  : kind === "mode"
                    ? { modes: "+o", args: [] }
                    : kind === "kick"
                      ? { target: "bob" }
                      : {},
            },
          ],
        });
        const { unmount } = render(() => (
          <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
        ));
        const line = screen.getByTestId("scrollback-line");
        expect(line.classList.contains("scrollback-muted")).toBe(true);
        unmount();
        setScrollback({});
      }
    });

    it("does NOT apply .scrollback-muted to PRIVMSG events", () => {
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1_700_000_000_000,
            kind: "privmsg",
            sender: "alice",
            body: "hello",
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const line = screen.getByTestId("scrollback-line");
      expect(line.classList.contains("scrollback-muted")).toBe(false);
    });

    it("does NOT apply .scrollback-muted to NOTICE or ACTION events", () => {
      for (const kind of ["notice", "action"] as const) {
        setScrollback({
          "freenode #grappa": [
            {
              id: 1,
              network: "freenode",
              channel: "#grappa",
              server_time: 1_700_000_000_000,
              kind,
              sender: "alice",
              body: "something",
              meta: {},
            },
          ],
        });
        const { unmount } = render(() => (
          <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />
        ));
        const line = screen.getByTestId("scrollback-line");
        expect(line.classList.contains("scrollback-muted")).toBe(false);
        unmount();
        setScrollback({});
      }
    });
  });

  // C7.4: Scroll-to-bottom floating button.
  describe("scroll-to-bottom button (C7.4)", () => {
    it("does not render scroll-to-bottom button when at bottom (initial state)", () => {
      setScrollback({ "freenode #grappa": fixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      // Initially atBottom = true; button should not be visible.
      expect(screen.queryByTestId("scroll-to-bottom")).toBeNull();
    });
  });

  // C7.6: Clickable nicks in scrollback.
  describe("clickable nicks (C7.6)", () => {
    it("clicking the sender span on a PRIVMSG line opens query window + focuses it", async () => {
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1_700_000_000_000,
            kind: "privmsg",
            sender: "alice",
            body: "hello",
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const sender = document.querySelector(".scrollback-sender");
      expect(sender).not.toBeNull();
      sender?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(mockOpenQueryWindowState).toHaveBeenCalledWith(42, "alice", expect.any(String));
      expect(mockSetSelectedChannel).toHaveBeenCalledWith({
        networkSlug: "freenode",
        channelName: "alice",
        kind: "query",
      });
    });

    it("right-clicking the sender span renders the context-menu", async () => {
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1_700_000_000_000,
            kind: "privmsg",
            sender: "alice",
            body: "hello",
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const sender = document.querySelector(".scrollback-sender");
      expect(sender).not.toBeNull();
      sender?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      await waitFor(() => {
        expect(document.querySelector('[role="menu"]')).not.toBeNull();
      });
    });

    it("sender span has .nick-clickable class on PRIVMSG lines", () => {
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1_700_000_000_000,
            kind: "privmsg",
            sender: "alice",
            body: "hello",
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const sender = document.querySelector(".scrollback-sender");
      expect(sender?.classList.contains("nick-clickable")).toBe(true);
    });
  });

  // C7.3: unread marker rendering.
  describe("unread marker (C7.3)", () => {
    // readCursor is signal-backed (mock mirrors prod). Each test gets a clean slate.
    beforeEach(() => {
      localStorage.clear();
      setReadCursorStore({});
    });

    afterEach(() => {
      localStorage.clear();
      setReadCursorStore({});
    });

    it("renders no unread-marker when no read cursor is set for the window", () => {
      setScrollback({ "freenode #grappa": fixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      expect(screen.queryByTestId("unread-marker")).toBeNull();
    });

    it("renders no unread-marker when cursor equals last message id (all read)", () => {
      // cursor at or after all messages → nothing unread
      seedReadCursor("freenode", "#grappa", fixture[fixture.length - 1]?.id ?? 0);
      setScrollback({ "freenode #grappa": fixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      expect(screen.queryByTestId("unread-marker")).toBeNull();
    });

    it("renders an unread-marker between read and unread messages when cursor is set mid-list", () => {
      // cursor sits at msg id=1 → msg id=2 and id=3 are unread (id > cursor)
      seedReadCursor("freenode", "#grappa", 1);
      setScrollback({ "freenode #grappa": fixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const marker = screen.getByTestId("unread-marker");
      expect(marker).toBeInTheDocument();
      // Label must state the unread count (2 unread: msg 2 and msg 3)
      expect(marker).toHaveTextContent("2 unread");
    });

    it("unread-marker appears BEFORE the first unread message in DOM order", () => {
      seedReadCursor("freenode", "#grappa", 1);
      setScrollback({ "freenode #grappa": fixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const marker = screen.getByTestId("unread-marker");
      const lines = screen.getAllByTestId("scrollback-line");
      // lines[0] = msg id=1 (read), then marker, then lines[1]=msg id=2, lines[2]=msg id=3
      // DOM: marker must come after lines[0] but before lines[1]
      const markerPos = marker.compareDocumentPosition(lines[1] as Node);
      // DOCUMENT_POSITION_FOLLOWING (4) means lines[1] follows marker
      expect(markerPos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const readPos = lines[0]?.compareDocumentPosition(marker);
      // lines[0] should precede marker
      expect(readPos !== undefined && readPos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("renders unread count of 1 when only the last message is unread", () => {
      // cursor sits at msg id=2 → only msg id=3 is unread
      seedReadCursor("freenode", "#grappa", 2);
      setScrollback({ "freenode #grappa": fixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const marker = screen.getByTestId("unread-marker");
      expect(marker).toHaveTextContent("1 unread");
    });

    it("renders unread count of 3 when cursor is before all messages (all unread)", () => {
      // cursor at 0 → all 3 messages are unread
      seedReadCursor("freenode", "#grappa", 0);
      setScrollback({ "freenode #grappa": fixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const marker = screen.getByTestId("unread-marker");
      expect(marker).toHaveTextContent("3 unread");
    });

    // Operator-action echoes (numeric-derived NOTICE rows like a 401
    // ERR_NOSUCHNICK reply to /msg) must NOT be counted in the unread
    // marker — they're feedback to the operator's own action, mirroring
    // the subscribe.ts sidebar-badge gate. Without this exclusion, every
    // /msg-to-ghost roundtrip pins a phantom "1 unread message" marker
    // above the 401 reply in the operator's own query window.
    it("does NOT count numeric-derived notice rows toward the unread marker", () => {
      const ghostFixture: ScrollbackMessage[] = [
        {
          id: 10,
          network: "freenode",
          channel: "ghost",
          server_time: 1_700_000_000_000,
          kind: "privmsg",
          sender: "alice",
          body: "hi",
          meta: {},
        },
        {
          // 401 ERR_NOSUCHNICK reply — server-routed numeric, persisted
          // via Session.Server.handle_numeric_with_routing.
          id: 11,
          network: "freenode",
          channel: "ghost",
          server_time: 1_700_000_001_000,
          kind: "notice",
          sender: "raccooncity.azzurra.chat",
          body: "No such nick/channel",
          meta: { numeric: 401, severity: "error" },
        },
      ];
      // cursor sits at the operator's own PRIVMSG id → only the 401
      // notice has id > cursor. Without the predicate the marker would
      // render "1 unread"; with it, no marker at all.
      seedReadCursor("freenode", "ghost", 10);
      setScrollback({ "freenode ghost": ghostFixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="ghost" kind="query" />);
      expect(screen.queryByTestId("unread-marker")).toBeNull();
    });

    // Symmetry check: a peer-originated NOTICE (no meta.numeric) IS a
    // real unsolicited message and MUST still produce the marker.
    it("DOES count peer notice rows (no meta.numeric) toward the unread marker", () => {
      const peerNoticeFixture: ScrollbackMessage[] = [
        {
          id: 20,
          network: "freenode",
          channel: "NickServ",
          server_time: 1_700_000_000_000,
          kind: "privmsg",
          sender: "alice",
          body: "identify pw",
          meta: {},
        },
        {
          id: 21,
          network: "freenode",
          channel: "NickServ",
          server_time: 1_700_000_001_000,
          kind: "notice",
          sender: "NickServ",
          body: "You are now identified",
          meta: {},
        },
      ];
      seedReadCursor("freenode", "NickServ", 20);
      setScrollback({ "freenode NickServ": peerNoticeFixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="NickServ" kind="query" />);
      const marker = screen.getByTestId("unread-marker");
      expect(marker).toHaveTextContent("1 unread");
    });

    // Bug A repro (vjt step 5–8): the marker must DISAPPEAR when the cursor
    // advances past every visible msg's id — even when the advance happens
    // after the scrollback append, mid-mount.
    //
    // CP29 R-4 production sequence (selection.ts focus-leave OR
    // subscribe.ts read_cursor_set arm from cross-device sync):
    //   1. appendToScrollback(key, msg)              — signal write
    //   2. applyReadCursorSet(slug, name, msg.id)    — MUST be a signal write
    // The `rows` createMemo in ScrollbackPane reads BOTH signals. After
    // step 1 it invalidates and re-evaluates with the OLD cursor, injects
    // the marker. After step 2 it MUST invalidate again and re-evaluate
    // with the NEW cursor → marker disappears.
    //
    // Pre-CP29-R4 the cursor was a synchronous localStorage read (not
    // tracked); the C7.3 mock added reactivity to repro the bug. Post-R4
    // production is intrinsically reactive (signal map) but the test
    // still asserts the contract — a regression to non-reactive shape
    // would re-surface vjt's exact symptom.
    //
    // The mid-test cursor advance MUST go through the mocked
    // `applyReadCursorSet` API (the same wire-event applier prod uses)
    // so a non-reactive readCursor module would surface the bug here.
    it("Bug A: marker disappears after live-cursor advance lands post-mount", async () => {
      const { applyReadCursorSet } = await import("../lib/readCursor");
      const proto = fixture[0];
      if (!proto) throw new Error("fixture[0] missing");
      // Seed: 4 unread msgs from peer, cursor at 0 → marker shows "4 unread".
      // sessionTopId latches to 13 (the highest id present at mount).
      const fourUnread: ScrollbackMessage[] = [
        { ...proto, id: 10, server_time: 100, sender: "vjt", body: "msg1" },
        { ...proto, id: 11, server_time: 101, sender: "vjt", body: "msg2" },
        { ...proto, id: 12, server_time: 102, sender: "vjt", body: "msg3" },
        { ...proto, id: 13, server_time: 103, sender: "vjt", body: "msg4" },
      ];
      seedReadCursor("freenode", "#grappa", 0);
      setScrollback({ "freenode #grappa": fourUnread });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      // Initial render: marker visible with all 4 unread.
      expect(screen.getByTestId("unread-marker")).toHaveTextContent("4 unread");

      // Cursor advance to the latest visible id (mirrors selection.ts on
      // focus-leave: server-side advance + WS broadcast → applyReadCursorSet).
      applyReadCursorSet("freenode", "#grappa", 13);

      await waitFor(() => {
        // RED pre-fix: marker is still in the DOM with "4 unread".
        // GREEN post-fix: marker is gone — cursor caught up to sessionTopId.
        expect(screen.queryByTestId("unread-marker")).toBeNull();
      });
    });

    // Bug A repro variant (vjt steps 7–8): subsequent post-mount arrivals
    // must NOT resurrect the marker (sessionTopId boundary excludes them).
    it("Bug A: marker stays absent for live-arrivals after mount-time cursor was current", async () => {
      const proto = fixture[0];
      if (!proto) throw new Error("fixture[0] missing");
      const initial: ScrollbackMessage[] = [
        { ...proto, id: 20, server_time: 100, sender: "vjt", body: "old" },
      ];
      seedReadCursor("freenode", "#grappa", 20);
      setScrollback({ "freenode #grappa": initial });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      // Cursor caught up — no marker. sessionTopId latches to 20.
      expect(screen.queryByTestId("unread-marker")).toBeNull();

      // A new own-msg arrives via WS append. It has id=21 > sessionTopId=20
      // so the marker stays absent regardless of cursor — it's live-read
      // by the focus-session boundary rule (target-window UX rule).
      const ownMsg: ScrollbackMessage = {
        id: 21,
        network: "freenode",
        channel: "#grappa",
        server_time: 200,
        kind: "privmsg",
        sender: "alice",
        body: "fresh",
        meta: {},
      };
      setScrollback({ "freenode #grappa": [...initial, ownMsg] });

      await waitFor(() => {
        // The append's signal write re-runs the rows memo; sessionTopId=20
        // excludes msg 21 from the unread set → no marker.
        expect(screen.queryByTestId("unread-marker")).toBeNull();
      });
    });

    // CP29 R-6: vjt's "/part → /join shows 'unread messages' for my own
    // join action" bug. Pre-fix the unreadCount filter only excluded
    // `isOperatorActionEcho` (numeric NOTICEs); own JOIN/PART/etc rows
    // landing in `(cursor, sessionTopId]` produced a phantom marker.
    // The new shared `isOwnPresenceEvent` predicate (lib/ownPresenceEvent)
    // is mirrored from subscribe.ts's sidebar badge gate so the in-pane
    // marker derivation and the badge-bump suppression stay aligned.
    it("does NOT count own JOIN row toward the unread marker (vjt /part-/join bug)", () => {
      setUserNick("vjt");
      const ownRejoinFixture: ScrollbackMessage[] = [
        {
          id: 30,
          network: "freenode",
          channel: "#grappa",
          server_time: 1_700_000_000_000,
          kind: "privmsg",
          sender: "alice",
          body: "earlier",
          meta: {},
        },
        // Operator's own JOIN after a /part → /join cycle. Pre-R-6 this
        // bumped the in-pane marker to "1 unread"; post-R-6 the predicate
        // gates it out and no marker renders.
        {
          id: 31,
          network: "freenode",
          channel: "#grappa",
          server_time: 1_700_000_001_000,
          kind: "join",
          sender: "vjt",
          body: null,
          meta: {},
        },
      ];
      seedReadCursor("freenode", "#grappa", 30);
      setScrollback({ "freenode #grappa": ownRejoinFixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      expect(screen.queryByTestId("unread-marker")).toBeNull();
    });

    it("does NOT count own PART row toward the unread marker", () => {
      setUserNick("vjt");
      const ownPartFixture: ScrollbackMessage[] = [
        {
          id: 40,
          network: "freenode",
          channel: "#grappa",
          server_time: 1_700_000_000_000,
          kind: "privmsg",
          sender: "alice",
          body: "earlier",
          meta: {},
        },
        {
          id: 41,
          network: "freenode",
          channel: "#grappa",
          server_time: 1_700_000_001_000,
          kind: "part",
          sender: "vjt",
          body: "leaving",
          meta: {},
        },
      ];
      seedReadCursor("freenode", "#grappa", 40);
      setScrollback({ "freenode #grappa": ownPartFixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      expect(screen.queryByTestId("unread-marker")).toBeNull();
    });

    // Symmetry check: a peer JOIN IS a real event the operator hasn't seen
    // and MUST still produce the marker — guards against over-broad
    // suppression that would silence legitimate channel activity.
    it("DOES count peer JOIN row toward the unread marker", () => {
      setUserNick("vjt");
      const peerJoinFixture: ScrollbackMessage[] = [
        {
          id: 50,
          network: "freenode",
          channel: "#grappa",
          server_time: 1_700_000_000_000,
          kind: "privmsg",
          sender: "alice",
          body: "earlier",
          meta: {},
        },
        {
          id: 51,
          network: "freenode",
          channel: "#grappa",
          server_time: 1_700_000_001_000,
          kind: "join",
          sender: "carol",
          body: null,
          meta: {},
        },
      ];
      seedReadCursor("freenode", "#grappa", 50);
      setScrollback({ "freenode #grappa": peerJoinFixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const marker = screen.getByTestId("unread-marker");
      expect(marker).toHaveTextContent("1 unread");
    });

    // Mixed-row variant: own JOIN sandwiched between a read msg and an
    // unread peer msg. Marker count should be 1 (the peer msg only) and
    // marker should land BEFORE the peer msg, not before the own JOIN.
    it("excludes own presence rows from count + injection position", () => {
      setUserNick("vjt");
      const mixedFixture: ScrollbackMessage[] = [
        {
          id: 60,
          network: "freenode",
          channel: "#grappa",
          server_time: 1_700_000_000_000,
          kind: "privmsg",
          sender: "alice",
          body: "old read msg",
          meta: {},
        },
        // Own JOIN — must NOT be counted, marker must NOT land above it.
        {
          id: 61,
          network: "freenode",
          channel: "#grappa",
          server_time: 1_700_000_001_000,
          kind: "join",
          sender: "vjt",
          body: null,
          meta: {},
        },
        // Peer msg — IS unread, marker lands here.
        {
          id: 62,
          network: "freenode",
          channel: "#grappa",
          server_time: 1_700_000_002_000,
          kind: "privmsg",
          sender: "carol",
          body: "new peer msg",
          meta: {},
        },
      ];
      seedReadCursor("freenode", "#grappa", 60);
      setScrollback({ "freenode #grappa": mixedFixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const marker = screen.getByTestId("unread-marker");
      expect(marker).toHaveTextContent("1 unread");
      // Marker must precede the peer msg's line in DOM order, NOT the
      // own JOIN line. Lines are returned in scrollback order; lines[1]
      // is the own JOIN row, lines[2] is the peer msg.
      const lines = screen.getAllByTestId("scrollback-line");
      expect(lines).toHaveLength(3);
      const peerLine = lines[2] as Node;
      const ownJoinLine = lines[1] as Node;
      // Marker → peer msg: peer follows marker.
      expect(
        marker.compareDocumentPosition(peerLine) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      // Marker after own JOIN: own JOIN precedes marker.
      expect(
        ownJoinLine.compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });
  });

  // C7.7: watchlist highlight rendering (MVP: watchlist = own nick only).
  describe("watchlist highlight rendering (C7.7)", () => {
    it("PRIVMSG mentioning own nick gets .scrollback-highlight class", () => {
      setUserNick("vjt");
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1_700_000_000_000,
            kind: "privmsg",
            sender: "alice",
            body: "hey vjt, look at this",
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const line = screen.getByTestId("scrollback-line");
      expect(line.classList.contains("scrollback-highlight")).toBe(true);
    });

    it("PRIVMSG NOT mentioning own nick does NOT get .scrollback-highlight", () => {
      setUserNick("vjt");
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1_700_000_000_000,
            kind: "privmsg",
            sender: "alice",
            body: "hello world",
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const line = screen.getByTestId("scrollback-line");
      expect(line.classList.contains("scrollback-highlight")).toBe(false);
    });

    it("presence kind (JOIN) does NOT get .scrollback-highlight even if body matches", () => {
      setUserNick("vjt");
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1_700_000_000_000,
            kind: "join",
            sender: "alice",
            body: "vjt",
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const line = screen.getByTestId("scrollback-line");
      expect(line.classList.contains("scrollback-highlight")).toBe(false);
    });
  });

  // CP13 — :notice rows with meta.severity === "error" (server-routed
  // failure-class numerics) get the .scrollback-notice-error class so
  // they render red. Non-error severity (or missing meta) → no class,
  // falls back to plain .scrollback-notice rendering.
  describe("notice severity rendering (CP13)", () => {
    const errorNotice: ScrollbackMessage = {
      id: 1,
      network: "freenode",
      channel: "#grappa",
      server_time: 1,
      kind: "notice",
      sender: "irc.test.org",
      body: "Cannot send to channel",
      meta: { numeric: 404, severity: "error" },
    };

    const okNotice: ScrollbackMessage = {
      id: 2,
      network: "freenode",
      channel: "#grappa",
      server_time: 2,
      kind: "notice",
      sender: "irc.test.org",
      body: "Now away",
      meta: { numeric: 306, severity: "ok" },
    };

    const bareNotice: ScrollbackMessage = {
      id: 3,
      network: "freenode",
      channel: "#grappa",
      server_time: 3,
      kind: "notice",
      sender: "ChanServ",
      body: "lock",
      meta: {},
    };

    it("applies .scrollback-notice-error to :notice with meta.severity=error", () => {
      setScrollback({ "freenode #grappa": [errorNotice] });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const line = screen.getByTestId("scrollback-line");
      expect(line.classList.contains("scrollback-notice-error")).toBe(true);
      expect(line.classList.contains("scrollback-notice")).toBe(true);
    });

    it("does NOT apply .scrollback-notice-error to :notice with meta.severity=ok", () => {
      setScrollback({ "freenode #grappa": [okNotice] });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const line = screen.getByTestId("scrollback-line");
      expect(line.classList.contains("scrollback-notice-error")).toBe(false);
      expect(line.classList.contains("scrollback-notice")).toBe(true);
    });

    it("does NOT apply .scrollback-notice-error to :notice with empty meta", () => {
      setScrollback({ "freenode #grappa": [bareNotice] });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const line = screen.getByTestId("scrollback-line");
      expect(line.classList.contains("scrollback-notice-error")).toBe(false);
      expect(line.classList.contains("scrollback-notice")).toBe(true);
    });
  });

  // No-silent-drops bucket 1 (2026-05-14, B6.1 reshape): structured
  // raw-event render arms keyed off meta.raw_verb. Server's EventRouter
  // catch-all persists unhandled command verbs as :notice rows on
  // $server with FLAT atom-keyed meta {raw_verb, raw_sender,
  // raw_params}; ScrollbackPane's :notice arm detects raw_verb and
  // routes to renderRawEvent. Per-verb arms localize (cic owns
  // human-readable strings); default arm renders a generic verb +
  // params row so the event is never invisible.
  describe("notice raw-event rendering (no-silent-drops bucket 1 + B6.1)", () => {
    const wallopsRow: ScrollbackMessage = {
      id: 100,
      network: "freenode",
      channel: "$server",
      server_time: 100,
      kind: "notice",
      sender: "vjt",
      body: "network broadcast text",
      meta: {
        raw_verb: "WALLOPS",
        raw_sender: "vjt",
        raw_params: ["network broadcast text"],
      },
    };

    const killRow: ScrollbackMessage = {
      id: 101,
      network: "freenode",
      channel: "$server",
      server_time: 101,
      kind: "notice",
      sender: "oper",
      body: "kill reason",
      meta: {
        raw_verb: "KILL",
        raw_sender: "oper",
        raw_params: ["target_nick", "kill reason"],
      },
    };

    const errorRow: ScrollbackMessage = {
      id: 102,
      network: "freenode",
      channel: "$server",
      server_time: 102,
      kind: "notice",
      sender: "*",
      body: "Closing Link: bad TLS",
      meta: {
        raw_verb: "ERROR",
        raw_sender: "*",
        raw_params: ["Closing Link: bad TLS"],
      },
    };

    const chghostRow: ScrollbackMessage = {
      id: 103,
      network: "freenode",
      channel: "$server",
      server_time: 103,
      kind: "notice",
      sender: "alice",
      body: "newhost.example.com",
      meta: {
        raw_verb: "CHGHOST",
        raw_sender: "alice",
        raw_params: ["newuser", "newhost.example.com"],
      },
    };

    const unknownVendorRow: ScrollbackMessage = {
      id: 104,
      network: "freenode",
      channel: "$server",
      server_time: 104,
      kind: "notice",
      sender: "vjt",
      body: "trailing",
      meta: {
        raw_verb: "BANCHAN",
        raw_sender: "vjt",
        raw_params: ["#secret", "trailing"],
      },
    };

    it("WALLOPS renders 'Wallops from <sender>: <text>'", () => {
      setScrollback({ "freenode $server": [wallopsRow] });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="$server" kind="channel" />);
      const line = screen.getByTestId("scrollback-line");
      expect(line.textContent).toContain("Wallops from");
      expect(line.textContent).toContain("vjt");
      expect(line.textContent).toContain("network broadcast text");
    });

    it("KILL renders '<oper> killed <target> (<reason>)'", () => {
      setScrollback({ "freenode $server": [killRow] });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="$server" kind="channel" />);
      const line = screen.getByTestId("scrollback-line");
      expect(line.textContent).toContain("oper");
      expect(line.textContent).toContain("killed");
      expect(line.textContent).toContain("target_nick");
      expect(line.textContent).toContain("kill reason");
    });

    it("ERROR renders 'Server error: <text>'", () => {
      setScrollback({ "freenode $server": [errorRow] });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="$server" kind="channel" />);
      const line = screen.getByTestId("scrollback-line");
      expect(line.textContent).toContain("Server error:");
      expect(line.textContent).toContain("Closing Link: bad TLS");
    });

    it("CHGHOST renders '<sender> changed host to <user>@<host>'", () => {
      setScrollback({ "freenode $server": [chghostRow] });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="$server" kind="channel" />);
      const line = screen.getByTestId("scrollback-line");
      expect(line.textContent).toContain("alice");
      expect(line.textContent).toContain("changed host to");
      expect(line.textContent).toContain("newuser@newhost.example.com");
    });

    it("unknown vendor verb falls through to generic '<sender> VERB params' render", () => {
      setScrollback({ "freenode $server": [unknownVendorRow] });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="$server" kind="channel" />);
      const line = screen.getByTestId("scrollback-line");
      // Generic arm puts verb + params after sender; no localized prefix.
      expect(line.textContent).toContain("vjt");
      expect(line.textContent).toContain("BANCHAN");
      expect(line.textContent).toContain("#secret");
      expect(line.textContent).toContain("trailing");
    });

    // No-silent-drops bucket 2: inbound INVITE rendering with [Join]
    // CTA. Wire shape: `:vjt INVITE grappa :#sbiffo`. params =
    // ["grappa" (own_nick), "#sbiffo" (channel)].
    const inviteRow: ScrollbackMessage = {
      id: 105,
      network: "freenode",
      channel: "$server",
      server_time: 105,
      kind: "notice",
      sender: "vjt",
      body: "#sbiffo",
      meta: {
        raw_verb: "INVITE",
        raw_sender: "vjt",
        raw_params: ["grappa", "#sbiffo"],
      },
    };

    const malformedInviteRow: ScrollbackMessage = {
      id: 106,
      network: "freenode",
      channel: "$server",
      server_time: 106,
      kind: "notice",
      sender: "vjt",
      body: "weird",
      meta: {
        // Missing channel-prefix on params[1] — defensive arm.
        raw_verb: "INVITE",
        raw_sender: "vjt",
        raw_params: ["grappa", "weird"],
      },
    };

    it("INVITE renders '<sender> invited you to <chan> [Join]' button", () => {
      setScrollback({ "freenode $server": [inviteRow] });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="$server" kind="channel" />);
      const line = screen.getByTestId("scrollback-line");
      expect(line.textContent).toContain("vjt");
      expect(line.textContent).toContain("invited you to");
      expect(line.textContent).toContain("#sbiffo");
      const btn = line.querySelector(".scrollback-invite-join") as HTMLButtonElement;
      expect(btn).not.toBeNull();
      expect(btn.textContent).toContain("Join");
    });

    it("INVITE [Join] click invokes postJoin + setSelectedChannel", async () => {
      mockPostJoin.mockClear();
      mockSetSelectedChannel.mockClear();
      setScrollback({ "freenode $server": [inviteRow] });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="$server" kind="channel" />);
      const btn = document.querySelector(".scrollback-invite-join") as HTMLButtonElement;
      btn.click();
      await waitFor(() => {
        expect(mockPostJoin).toHaveBeenCalledWith("test-token", "freenode", "#sbiffo", null);
        expect(mockSetSelectedChannel).toHaveBeenCalledWith({
          networkSlug: "freenode",
          channelName: "#sbiffo",
          kind: "channel",
        });
      });
    });

    it("INVITE with malformed channel param falls through to generic render (no [Join])", () => {
      setScrollback({ "freenode $server": [malformedInviteRow] });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="$server" kind="channel" />);
      const line = screen.getByTestId("scrollback-line");
      // Generic arm: verb + params, no [Join] button.
      expect(line.textContent).toContain("INVITE");
      expect(line.querySelector(".scrollback-invite-join")).toBeNull();
    });
  });

  // No-silent-drops B6.11 (HIGH-7): :server_event typed kind for the
  // EventRouter catch-all. Pre-flip these arrived as `notice +
  // raw_verb`; both flows render via `renderRawEvent`. The
  // `case "server_event"` arm in ScrollbackPane delegates the same
  // way as the legacy `case "notice"` arm so per-verb pretty-render
  // (WALLOPS / KILL / ERROR / CHGHOST / INVITE) works identically.
  // Migration backfills historical rows; new rows arrive with the
  // typed kind.
  describe("server_event raw-event rendering (B6.11 HIGH-7)", () => {
    it("kind=server_event with raw_verb=WALLOPS renders 'Wallops from <sender>: <text>'", () => {
      setScrollback({
        "freenode $server": [
          {
            id: 200,
            network: "freenode",
            channel: "$server",
            server_time: 200,
            kind: "server_event",
            sender: "vjt",
            body: "network broadcast text",
            meta: {
              raw_verb: "WALLOPS",
              raw_sender: "vjt",
              raw_params: ["network broadcast text"],
            },
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="$server" kind="channel" />);
      const line = screen.getByTestId("scrollback-line");
      expect(line.textContent).toContain("Wallops from");
      expect(line.textContent).toContain("vjt");
      expect(line.textContent).toContain("network broadcast text");
    });

    it("kind=server_event with raw_verb=KILL renders kill summary", () => {
      setScrollback({
        "freenode $server": [
          {
            id: 201,
            network: "freenode",
            channel: "$server",
            server_time: 201,
            kind: "server_event",
            sender: "oper",
            body: "kill reason",
            meta: {
              raw_verb: "KILL",
              raw_sender: "oper",
              raw_params: ["target_nick", "kill reason"],
            },
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="$server" kind="channel" />);
      const line = screen.getByTestId("scrollback-line");
      expect(line.textContent).toContain("oper");
      expect(line.textContent).toContain("killed");
      expect(line.textContent).toContain("target_nick");
      expect(line.textContent).toContain("kill reason");
    });

    it("kind=server_event with raw_verb=INVITE renders [Join] CTA", () => {
      setScrollback({
        "freenode $server": [
          {
            id: 202,
            network: "freenode",
            channel: "$server",
            server_time: 202,
            kind: "server_event",
            sender: "vjt",
            body: "#sbiffo",
            meta: {
              raw_verb: "INVITE",
              raw_sender: "vjt",
              raw_params: ["grappa", "#sbiffo"],
            },
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="$server" kind="channel" />);
      const line = screen.getByTestId("scrollback-line");
      expect(line.textContent).toContain("invited you to");
      expect(line.textContent).toContain("#sbiffo");
      const btn = line.querySelector(".scrollback-invite-join") as HTMLButtonElement;
      expect(btn).not.toBeNull();
      expect(btn.textContent).toContain("Join");
    });

    it("kind=server_event without raw_verb falls back to body render (defensive)", () => {
      setScrollback({
        "freenode $server": [
          {
            id: 203,
            network: "freenode",
            channel: "$server",
            server_time: 203,
            kind: "server_event",
            sender: "weirdsender",
            body: "naked body — meta missing raw_verb",
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="$server" kind="channel" />);
      const line = screen.getByTestId("scrollback-line");
      expect(line.textContent).toContain("weirdsender");
      expect(line.textContent).toContain("naked body — meta missing raw_verb");
    });

    it("kind=server_event row gets scrollback-presence + scrollback-muted classes", () => {
      setScrollback({
        "freenode $server": [
          {
            id: 204,
            network: "freenode",
            channel: "$server",
            server_time: 204,
            kind: "server_event",
            sender: "vjt",
            body: "WALLOPS",
            meta: {
              raw_verb: "WALLOPS",
              raw_sender: "vjt",
              raw_params: ["WALLOPS"],
            },
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="$server" kind="channel" />);
      const line = screen.getByTestId("scrollback-line");
      expect(line.className).toContain("scrollback-presence");
      expect(line.className).toContain("scrollback-muted");
    });
  });

  // No-silent-drops bucket 4 (2026-05-14): clickable URLs in scrollback
  // bodies. linkify() splits each mIRC Run's text into text + url
  // segments; renderRun emits <a href target="_blank" rel="noopener
  // noreferrer"> for url segments. mIRC formatting + linkification
  // compose -- a URL inside a bold/colored run inherits the run's
  // formatting via CSS `color: inherit`.
  describe("clickable URLs in scrollback (no-silent-drops bucket 4)", () => {
    it("PRIVMSG with https URL renders <a href target=_blank rel=noopener noreferrer>", () => {
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1,
            kind: "privmsg",
            sender: "alice",
            body: "check https://example.com please",
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const link = document.querySelector(".scrollback-link") as HTMLAnchorElement;
      expect(link).not.toBeNull();
      expect(link.href).toBe("https://example.com/");
      expect(link.target).toBe("_blank");
      expect(link.rel).toBe("noopener noreferrer");
      expect(link.textContent).toBe("https://example.com");
    });

    it("bare-domain www. renders link with https:// prepended", () => {
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1,
            kind: "privmsg",
            sender: "bob",
            body: "visit www.example.com",
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const link = document.querySelector(".scrollback-link") as HTMLAnchorElement;
      expect(link).not.toBeNull();
      expect(link.href).toBe("https://www.example.com/");
      expect(link.textContent).toBe("www.example.com");
    });

    it("plain-text body (no URL) renders no <a> elements", () => {
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1,
            kind: "privmsg",
            sender: "alice",
            body: "no URL here",
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      expect(document.querySelector(".scrollback-link")).toBeNull();
    });

    it("trailing punctuation is excluded from the URL", () => {
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1,
            kind: "privmsg",
            sender: "alice",
            body: "see https://example.com.",
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const link = document.querySelector(".scrollback-link") as HTMLAnchorElement;
      expect(link.textContent).toBe("https://example.com");
      // The trailing "." remains in surrounding text -- assert via the
      // bodyEl's textContent including the "." but not inside the link.
      const bodyEl = document.querySelector(".scrollback-body");
      expect(bodyEl?.textContent).toContain("https://example.com.");
    });
  });

  // CP13 S10 — mIRC formatting: privmsg/notice/action bodies render
  // through parseMircFormat so bold/color/etc. produce per-Run <span>s.
  describe("mIRC body formatting (CP13 S10)", () => {
    it("renders a plain body as a single span (fast path)", () => {
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1,
            kind: "privmsg",
            sender: "alice",
            body: "hello world",
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const bodyEl = document.querySelector(".scrollback-body");
      // One <span> for the single Run.
      expect(bodyEl?.querySelectorAll("span").length).toBe(1);
      expect(bodyEl?.textContent).toBe("hello world");
    });

    it("renders bold-bracketed body as multi-span with .scrollback-mirc-bold", () => {
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1,
            kind: "privmsg",
            sender: "alice",
            body: "a\x02bold\x02c",
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const bodyEl = document.querySelector(".scrollback-body");
      const spans = bodyEl?.querySelectorAll("span");
      expect(spans?.length).toBe(3);
      expect(spans?.[1]?.classList.contains("scrollback-mirc-bold")).toBe(true);
      expect(spans?.[1]?.textContent).toBe("bold");
      expect(spans?.[0]?.classList.contains("scrollback-mirc-bold")).toBe(false);
    });

    it("renders fg color via inline style", () => {
      setScrollback({
        "freenode #grappa": [
          {
            id: 1,
            network: "freenode",
            channel: "#grappa",
            server_time: 1,
            kind: "privmsg",
            sender: "alice",
            body: "\x034red\x03",
            meta: {},
          },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const bodyEl = document.querySelector(".scrollback-body");
      const colored = bodyEl?.querySelector("span") as HTMLElement | null | undefined;
      // mIRC color 4 = red (#ff0000); jsdom parses inline style.
      expect(colored?.style.color).toBe("rgb(255, 0, 0)");
    });
  });
});
