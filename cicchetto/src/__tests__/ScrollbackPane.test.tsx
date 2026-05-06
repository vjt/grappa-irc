import { render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrollbackMessage } from "../lib/api";
import type { NumericInlineLine } from "../lib/numericInline";

// C5.0 — JOIN-self auto-focus-switch: mock selection so we can assert
// setSelectedChannel is called when own nick's JOIN event shows up.
const mockSetSelectedChannel = vi.fn();
vi.mock("../lib/selection", () => ({
  setSelectedChannel: (ch: unknown) => mockSetSelectedChannel(ch),
  selectedChannel: () => null,
}));

// C5.2 — numericsByWindow: real Solid signal so render tests are reactive.
const [numericsByWindowStore, setNumericsByWindowStore] = createSignal<
  Record<string, NumericInlineLine[]>
>({});
vi.mock("../lib/numericInline", () => ({
  numericsByWindow: () => numericsByWindowStore(),
  appendNumericInline: vi.fn(),
  clearNumericInline: vi.fn(),
  MAX_INLINE_PER_WINDOW: 20,
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
  networks: () => [{ id: 42, slug: "freenode", inserted_at: "", updated_at: "" }],
}));

// C7.6: queryWindows + socket mocked so UserContextMenu import doesn't crash.
const mockOpenQueryWindowState = vi.fn();
vi.mock("../lib/queryWindows", () => ({
  openQueryWindowState: (...args: unknown[]) => mockOpenQueryWindowState(...args),
  queryWindowsByNetwork: () => ({}),
  closeQueryWindowState: vi.fn(),
  setQueryWindowsByNetwork: vi.fn(),
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
vi.mock("../lib/channelTopic", () => ({
  topicByChannel: () => mockTopicByChannel(),
}));

// C7.3: mock readCursor with a SIGNAL-BACKED stand-in that mirrors the
// production module's reactive contract. The real readCursor.ts pulls in
// auth.ts at module load (which reads localStorage during init, before
// beforeEach can stub it) and we want isolation. But the mock MUST be
// reactive — otherwise ScrollbackPane's `rows` createMemo cannot re-run
// when the cursor advances, and the unread-marker stays pinned with a
// stale count (the very bug this test suite must catch).
const KEY_PREFIX = "rc:";
const storageKey = (networkSlug: string, channel: string) =>
  `${KEY_PREFIX}${networkSlug}:${channel}`;
const cacheKey = (networkSlug: string, channel: string) => `${networkSlug} ${channel}`;
const [readCursorStore, setReadCursorStore] = createSignal<Record<string, number>>({});
const seedReadCursor = (networkSlug: string, channel: string, serverTime: number) => {
  localStorage.setItem(storageKey(networkSlug, channel), String(serverTime));
  setReadCursorStore((prev) => ({ ...prev, [cacheKey(networkSlug, channel)]: serverTime }));
};
vi.mock("../lib/readCursor", () => ({
  getReadCursor: (networkSlug: string, channel: string): number | null => {
    const v = readCursorStore()[cacheKey(networkSlug, channel)];
    return v === undefined ? null : v;
  },
  setReadCursor: (networkSlug: string, channel: string, serverTime: number): void => {
    localStorage.setItem(storageKey(networkSlug, channel), String(serverTime));
    setReadCursorStore((prev) => ({ ...prev, [cacheKey(networkSlug, channel)]: serverTime }));
  },
  clearReadCursors: vi.fn(() => setReadCursorStore({})),
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
  // Reset the join-banner shown-set between tests (test seam, see ScrollbackPane.tsx).
  resetShownBannersForTest();
  mockSetSelectedChannel.mockClear();
  setNumericsByWindowStore({});
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

  // C5.2: inline numeric rendering.
  describe("inline numeric lines (C5.2)", () => {
    it("renders numeric inline lines for the current window key", async () => {
      setNumericsByWindowStore({
        "freenode #grappa": [
          { numeric: 482, text: "You're not channel operator", severity: "error" },
          { numeric: 265, text: "Current local users", severity: "ok" },
        ],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const lines = screen.getAllByTestId("numeric-inline-line");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toHaveTextContent("You're not channel operator");
      expect(lines[1]).toHaveTextContent("Current local users");
    });

    it("applies .numeric-error class to error-severity lines", async () => {
      setNumericsByWindowStore({
        "freenode #grappa": [{ numeric: 482, text: "Not an op", severity: "error" }],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const line = screen.getByTestId("numeric-inline-line");
      expect(line.classList.contains("numeric-error")).toBe(true);
    });

    it("does NOT apply .numeric-error class to ok-severity lines", async () => {
      setNumericsByWindowStore({
        "freenode #grappa": [{ numeric: 265, text: "Info", severity: "ok" }],
      });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const line = screen.getByTestId("numeric-inline-line");
      expect(line.classList.contains("numeric-error")).toBe(false);
    });

    it("does not render the numeric-inline-pane when list is empty", () => {
      setNumericsByWindowStore({ "freenode #grappa": [] });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      expect(screen.queryByTestId("numeric-inline-pane")).toBeNull();
    });

    it("scopes lines to the current (slug, channel) window key", () => {
      setNumericsByWindowStore({
        "freenode #grappa": [{ numeric: 482, text: "error in grappa", severity: "error" }],
        "freenode #cicchetto": [{ numeric: 265, text: "info in cicchetto", severity: "ok" }],
      });
      render(() => (
        <ScrollbackPane networkSlug="freenode" channelName="#cicchetto" kind="channel" />
      ));
      const lines = screen.getAllByTestId("numeric-inline-line");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toHaveTextContent("info in cicchetto");
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

    it("renders no unread-marker when cursor equals last message server_time (all read)", () => {
      // cursor at or after all messages → nothing unread
      seedReadCursor("freenode", "#grappa", fixture[fixture.length - 1]?.server_time ?? 0);
      setScrollback({ "freenode #grappa": fixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      expect(screen.queryByTestId("unread-marker")).toBeNull();
    });

    it("renders an unread-marker between read and unread messages when cursor is set mid-list", () => {
      // cursor sits after msg id=1 (server_time 1_700_000_000_000)
      // → msg id=2 and id=3 are unread (server_time > cursor)
      seedReadCursor("freenode", "#grappa", 1_700_000_000_000);
      setScrollback({ "freenode #grappa": fixture });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      const marker = screen.getByTestId("unread-marker");
      expect(marker).toBeInTheDocument();
      // Label must state the unread count (2 unread: msg 2 and msg 3)
      expect(marker).toHaveTextContent("2 unread");
    });

    it("unread-marker appears BEFORE the first unread message in DOM order", () => {
      seedReadCursor("freenode", "#grappa", 1_700_000_000_000);
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
      // cursor sits after msg id=2 → only msg id=3 (server_time=1_700_000_002_000) is unread
      seedReadCursor("freenode", "#grappa", 1_700_000_001_000);
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

    // Bug A repro (vjt step 5–8): the marker must DISAPPEAR when the cursor
    // advances past every visible msg's server_time — even when the
    // advance happens after the scrollback append, mid-mount.
    //
    // Production sequence (subscribe.ts routeMessage):
    //   1. appendToScrollback(key, msg)         — signal write
    //   2. setReadCursor(slug, name, msg.time)  — MUST be a signal write
    // The `rows` createMemo in ScrollbackPane reads BOTH signals. After
    // step 1 it invalidates and re-evaluates with the OLD cursor, injects
    // the marker. After step 2 it MUST invalidate again and re-evaluate
    // with the NEW cursor → marker disappears.
    //
    // Pre-fix: getReadCursor was a synchronous localStorage read (not
    // tracked). Step 2's localStorage write didn't trigger memo
    // invalidation. The marker stayed pinned with "1 unread" pointing at
    // the just-arrived msg — vjt's exact symptom.
    //
    // The mid-test cursor advance MUST go through the mocked setReadCursor
    // API (the same call subscribe.ts makes in production) so a
    // non-reactive readCursor module would surface the bug here.
    it("Bug A: marker disappears after live-cursor advance lands post-mount", async () => {
      const { setReadCursor } = await import("../lib/readCursor");
      const proto = fixture[0];
      if (!proto) throw new Error("fixture[0] missing");
      // Seed: 4 unread msgs from peer, cursor at 0 → marker shows "4 unread".
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

      // Mimic subscribe.ts step 5+: own-msg arrives via WS echo.
      // appendToScrollback fires FIRST (memo re-evaluates with stale cursor),
      // then setReadCursor fires (memo MUST re-evaluate with fresh cursor →
      // marker disappears). Both are signal writes; in production the
      // subscribe.ts handler does both inline back-to-back.
      const ownMsg: ScrollbackMessage = {
        id: 14,
        network: "freenode",
        channel: "#grappa",
        server_time: 200,
        kind: "privmsg",
        sender: "alice",
        body: "live reply",
        meta: {},
      };
      setScrollback({ "freenode #grappa": [...fourUnread, ownMsg] });
      // Use the mocked setReadCursor (the prod API) — a non-reactive
      // implementation would silently fail to re-trigger the memo here.
      setReadCursor("freenode", "#grappa", 200);

      await waitFor(() => {
        // RED pre-fix: marker is still in the DOM, possibly with "1 unread".
        // GREEN post-fix: marker is gone — cursor caught up to the latest msg.
        expect(screen.queryByTestId("unread-marker")).toBeNull();
      });
    });

    // Bug A repro variant (vjt steps 7–8): subsequent send/receive after
    // the marker has already been cleared must NOT resurrect it.
    it("Bug A: marker stays absent after a SECOND post-mount cursor advance", async () => {
      const { setReadCursor } = await import("../lib/readCursor");
      const proto = fixture[0];
      if (!proto) throw new Error("fixture[0] missing");
      const initial: ScrollbackMessage[] = [
        { ...proto, id: 20, server_time: 100, sender: "vjt", body: "old" },
      ];
      seedReadCursor("freenode", "#grappa", 100);
      setScrollback({ "freenode #grappa": initial });
      render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" kind="channel" />);
      // Cursor caught up — no marker.
      expect(screen.queryByTestId("unread-marker")).toBeNull();

      // Send a new own-msg: append + cursor-advance (via mocked setReadCursor).
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
      setReadCursor("freenode", "#grappa", 200);

      await waitFor(() => {
        // RED pre-fix: memo re-runs on append with stale cursor=100, sees
        // ownMsg.server_time(200) > 100 → injects marker with "1 unread"
        // pointing at the just-sent msg. Cursor advance never re-runs the memo.
        // GREEN post-fix: cursor advance invalidates the memo → marker absent.
        expect(screen.queryByTestId("unread-marker")).toBeNull();
      });
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
});
